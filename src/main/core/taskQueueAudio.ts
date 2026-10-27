import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createLogger } from './logger'
import { FFmpegService } from './ffmpegService'
import { TTSService, TTSRateLimitedError } from './ttsService'
import { ProjectStore } from './projectStore'
import { SettingsStore } from './settingsStore'
import { SHOT_TIMING, type Project, type ProgressEvent, type Shot } from '../../shared/ipcTypes'
import { audioTailSecFor } from '../../shared/shotDoctrine'
import { fileExists, toPercent } from './taskQueueShared'
import { isPlaceholderDialogueText } from './subtitleService'

const log = createLogger('TaskQueue')

/**
 * 音频模块所需的运行时依赖：TaskQueue 类自身满足此接口，
 * 拆出去的函数以参数注入方式使用（不改变任何行为）。
 */
export interface AudioRuntime {
  store: ProjectStore
  ffmpeg: FFmpegService
  tts: TTSService
  settings: SettingsStore
  resolveInBase(p: string): string
  checkCancelled(projectId: string, shotId: string): void
  emitProgress(e: Omit<ProgressEvent, 'type'>): void
  patchShot(projectId: string, shot: Shot): Promise<void>
}

/**
 * TTS → 开口留白 → 按语音动态定帧。
 * 返回带 lead 的同步音频路径（口型/合轨同源）与纯语音时长。
 */
export async function prepareShotAudio(
  rt: AudioRuntime,
  projectId: string,
  shot: Shot,
  project: Project,
  watcher: { promise: Promise<never> },
  opts?: { capSec?: number }
): Promise<{ syncAudioRelPath?: string; audioSec?: number }> {
  let audioRelPath: string | undefined
  let audioSec: number | undefined
  const lastIndex = project.shots.reduce((max, s) => Math.max(max, s.index), shot.index)
  const tailSec = audioTailSecFor({ dialogue: shot.dialogue, emotion: shot.emotion, isLast: shot.index === lastIndex })
  // 本档位单镜能装下的纯语音预算：引擎输出（H3 网格/Wan 上限）减去开口留白。
  // 尾音只是静音垫，压不进输出时可自然丢失，不计入预算。
  // 台词超预算时音频必然长于视频 → 出现静音空洞/尾音被截断（实测 mid 档 5.2s 输出、
  // 台词镜音频 6.6~8.1s，成片多处 3s 静音）。因此超预算时提高 TTS 语速把语音压进预算。
  const budgetSec = opts?.capSec
    ? Math.max(1.2, opts.capSec - SHOT_TIMING.audioLeadSec - 0.15)
    : Infinity

  // 占位台词（「（无台词）」等）不是台词：不合成 TTS、不驱动口型，
  // 否则会烧出静音空洞/念出占位符。同时清掉历史遗留的 audioPath，
  // 避免旧项目里已经合成的「（无台词）」语音继续被合轨。
  if (isPlaceholderDialogueText(shot.dialogue)) {
    shot.audioPath = undefined
    shot.audioFailed = false
    shot.audioFailedReason = undefined
  } else {
    // 重渲/断点续跑复用已有音频：文件在盘则跳过 TTS（避免 TTS 重跑失败导致静音降级，
    // 也避免同一台词反复合成浪费资源）；leaded 同步音频同样复用。
    // 例外：已有音频明显超预算 → 仍要重合成（提速），否则复用的长音频会继续截断。
    let reuse = false
    if (shot.audioPath && await fileExists(rt.resolveInBase(shot.audioPath))) {
      audioRelPath = shot.audioPath
      audioSec = await rt.ffmpeg.getDuration(rt.resolveInBase(audioRelPath))
      reuse = audioSec <= budgetSec + 0.05
      if (reuse) {
        // 复用已有音频时同样清除失败标记（重渲恢复链回写）
        shot.audioFailed = false
        shot.audioFailedReason = undefined
      } else {
        log.warn(`[${shot.id}] 已有音频 ${audioSec.toFixed(2)}s 超出本档位预算 ${budgetSec.toFixed(2)}s，按提速重新合成`)
      }
    }
    if (!reuse) {
      rt.checkCancelled(projectId, shot.id)
      rt.emitProgress({ projectId, shotId: shot.id, step: 'tts', percent: 0, message: '生成语音中...' })
      const rel = `projects/${projectId}/audio/${shot.id}.mp3`
      const s = await rt.settings.get()
      const character = shot.type === 't2v'
        ? undefined
        : project.characters.find(c => c.id === shot.characterIds[0])
      const baseRate = character?.voiceRate ? parseRate(character.voiceRate) : parseRate(s.tts.rate)
      const volume = toPercent(s.tts.volume)
      const voice = shot.voice || character?.voice || s.tts.defaultVoice
      // 预算内提速：按「当前/估算语音时长 ÷ 预算」定倍率，上限 1.65（再高明显失真）。
      // 宁可语速偏快，也不要「台词念到一半被切」或长段静音空洞。
      const guessSec = audioSec ?? estimateSpeechSec(shot.dialogue)
      const factor = budgetSec === Infinity ? 1 : Math.min(1.65, Math.max(1, guessSec / budgetSec))
      const rate = factor > 1.02 ? toPercent(baseRate * factor) : toPercent(baseRate)
      if (factor > 1.02) {
        rt.emitProgress({
          projectId, shotId: shot.id, step: 'tts', percent: 0,
          message: `台词较长（约 ${guessSec.toFixed(1)}s），提速 ${Math.round((factor - 1) * 100)}% 以适配单镜时长`
        })
      }
      try {
        audioRelPath = await Promise.race([
          rt.tts.generate(shot.dialogue, voice, rel, rate, volume, () => {
            // 同步探一次取消状态：取消时 checkCancelled 直接抛，轮询循环下一轮即中断
            rt.checkCancelled(projectId, shot.id)
            return false
          }),
          watcher.promise
        ])
        shot.audioPath = audioRelPath
        // 本次 TTS 成功：清除历史失败标记（重渲/降级链恢复后必须回写）
        shot.audioFailed = false
        shot.audioFailedReason = undefined
        audioSec = await rt.ffmpeg.getDuration(rt.resolveInBase(audioRelPath))
      } catch (e) {
        // Edge TTS 风控限流（403）时**不阻塞视频渲染**：本镜按静音出片，
        // 标记 audioFailed，渲染完成后再由导演流水线补配音。其余 TTS 错误同样降级。
        const limited = e instanceof TTSRateLimitedError
        shot.audioFailed = true
        shot.audioFailedReason = e instanceof Error ? e.message : String(e)
        // M-x 兜底：本镜此前成功合成过音频（leaded 缓存在盘）则复用，
        // 避免"重渲/二次渲染时 TTS 再次失败"把台词镜静音降级成无声 i2v（口型/台词丢失）。
        let usedCache = false
        try {
          const leadedAbs = rt.resolveInBase(`projects/${projectId}/audio/${shot.id}_leaded.mp3`)
          if ((await fs.stat(leadedAbs)).isFile()) {
            audioRelPath = `projects/${projectId}/audio/${shot.id}_leaded.mp3`
            shot.audioFailed = false
            shot.audioFailedReason = undefined
            audioSec = await rt.ffmpeg.getDuration(leadedAbs)
            usedCache = true
            rt.emitProgress({
              projectId, shotId: shot.id, step: 'tts', percent: 100,
              message: 'TTS 本次失败，已复用历史音频缓存继续（不降级静音）'
            })
          }
        } catch { /* 无历史缓存 */ }
        if (!usedCache) {
          log.warn(`[${shot.id}] TTS ${limited ? '风控限流' : '失败'}，本镜降级为静音渲染：${e instanceof Error ? e.message : e}`)
          rt.emitProgress({
            projectId, shotId: shot.id, step: 'tts', percent: 0,
            message: limited
              ? 'TTS 风控限流，本镜先静音出片（渲染后补配音）'
              : 'TTS 失败，本镜先静音出片'
          })
        }
      }
    }
  }

  let syncAudioRelPath: string | undefined
  if (audioRelPath) {
    if (audioRelPath.endsWith('_leaded.mp3')) {
      // M-x TTS 失败兜底：复用的是历史 leaded（已含前导静音的同步音频），直接使用，不重复 pad
      syncAudioRelPath = audioRelPath
    } else {
      syncAudioRelPath = `projects/${projectId}/audio/${shot.id}_leaded.mp3`
      await rt.ffmpeg.padAudioLead(
        rt.resolveInBase(audioRelPath),
        rt.resolveInBase(syncAudioRelPath),
        SHOT_TIMING.audioLeadSec
      )
    }
  }

  // Wan2.2 帧数 = 秒*16+1；有台词含 lead+tail，无台词不低于 minSec
  const defaultSec = Math.max(1, Math.round((shot.frames - 1) / 16))
  const needSec = audioSec !== undefined
    ? Math.ceil(audioSec + SHOT_TIMING.audioLeadSec + tailSec)
    : 0
  const finalSec = Math.min(
    SHOT_TIMING.maxSec,
    Math.max(defaultSec, SHOT_TIMING.minSec, needSec)
  )
  shot.frames = finalSec * 16 + 1
  // 同步设计秒数：frameSeconds 是 UI/提示词时间轴的权威时长，frames 规范化后必须回写，
  // 否则出现 frameSeconds=2 而 frames=65(=4s) 的数据不一致（H3 再按 frames 反推会翻倍时长）
  shot.frameSeconds = finalSec
  await rt.patchShot(projectId, shot)

  return { syncAudioRelPath, audioSec }
}

/**
 * 台词镜 TTS 失败后的补配音：不重跑视频。
 * 成功则用 raw 视频与新音频重做分段并清除 audioFailed；
 * 仍失败或缺少 raw 的镜号返回，调用方不得把它们拼进成片。
 */
export async function repairSilentDialogue(
  rt: AudioRuntime,
  projectId: string
): Promise<{ repaired: number[]; blocked: number[] }> {
  const project = await rt.store.get(projectId)
  const repaired: number[] = []
  const blocked: number[] = []
  const s = await rt.settings.get()

  for (const shot of project.shots) {
    if (!shot.dialogue.trim() || isPlaceholderDialogueText(shot.dialogue) || !shot.audioFailed || shot.status !== 'done') continue
    if (shot.skipped) continue
    const rawRel = shot.rawVideoPath
    if (!rawRel || !shot.segmentPath) {
      blocked.push(shot.index)
      continue
    }
    const rawAbs = rt.resolveInBase(rawRel)
    if (!existsSync(rawAbs)) {
      blocked.push(shot.index)
      continue
    }
    const character = shot.type === 't2v'
      ? undefined
      : project.characters.find(c => c.id === shot.characterIds[0])
    const rate = character?.voiceRate ? toPercent(parseRate(character.voiceRate)) : toPercent(s.tts.rate)
    const volume = toPercent(s.tts.volume)
    const voice = shot.voice || character?.voice || s.tts.defaultVoice
    const rel = `projects/${projectId}/audio/${shot.id}.mp3`
    try {
      const audioRel = await rt.tts.generate(shot.dialogue, voice, rel, rate, volume)
      const leadedRel = `projects/${projectId}/audio/${shot.id}_leaded.mp3`
      await rt.ffmpeg.padAudioLead(
        rt.resolveInBase(audioRel),
        rt.resolveInBase(leadedRel),
        SHOT_TIMING.audioLeadSec
      )
      const segmentAbs = rt.resolveInBase(shot.segmentPath)
      await rt.ffmpeg.prepareSegment(rawAbs, rt.resolveInBase(leadedRel), segmentAbs)
      shot.audioPath = audioRel
      shot.audioFailed = false
      shot.audioFailedReason = undefined
      await rt.patchShot(projectId, shot)
      repaired.push(shot.index)
      log.info(`[${shot.id}] 补配音成功，已重做分段`)
    } catch (e) {
      shot.audioFailedReason = e instanceof Error ? e.message : String(e)
      await rt.patchShot(projectId, shot)
      blocked.push(shot.index)
      log.warn(`[${shot.id}] 补配音仍失败：${shot.audioFailedReason}`)
    }
  }
  return { repaired, blocked }
}

/** 语速归一化：角色语速可能存成 "100"/"+10%"/105 等写法，统一成百分数数值。 */
function parseRate(v: string | number | undefined): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[%+\s]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : 100
}

/** 中文语音时长粗估：约 4 字/秒（实测 3.8~4.5 字/秒），加 0.3s 起收尾。 */
function estimateSpeechSec(text: string): number {
  const n = Array.from(text.trim()).length
  return n / 4 + 0.3
}
