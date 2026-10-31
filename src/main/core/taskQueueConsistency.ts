import { createLogger } from './logger'
import { FFmpegService } from './ffmpegService'
import { ProjectStore } from './projectStore'
import {
  ConsistencyService,
  CONSISTENCY_THRESHOLD,
  FACE_CONSISTENCY_THRESHOLD,
  H3_WAN_FALLBACK_THRESHOLD,
} from './consistencyService'
import { shouldFallbackToWan } from '../../shared/pipelineGuards'
import { detectRoleConfusion } from './roleBinding'
import type { Project, ProgressEvent, Shot } from '../../shared/ipcTypes'

const log = createLogger('TaskQueue')

/**
 * 一致性模块所需的运行时依赖：TaskQueue 类自身满足此接口，
 * 拆出去的函数以参数注入方式使用（不改变任何行为）。
 */
export interface ConsistencyRuntime {
  ffmpeg: FFmpegService
  store: ProjectStore
  getConsistencyService(): ConsistencyService
  resolveInBase(p: string): string
  resolveRefImageRel(shot: Shot, project: Project): string
  emitProgress(e: Omit<ProgressEvent, 'type'>): void
}

/**
 * 人物镜末帧 vs 参考首帧一致性校验。
 * warn：低分仅告警；rerender：换 seed 重渲一次（由 caller 提供 reRun）。
 * H3 低一致性兜底：H3 引擎对参考图身份锁定弱（实测温和微笑被放大成夸张大笑，
 * ArcFace 相似度 0.16），若分数极低（< FALLBACK_TO_WAN_SCORE），自动切换 Wan i2v
 * 重渲一次——Wan 用首帧做物理起点图，身份锁定远强于 H3。
 * @returns 可能被更新的 renderSeed（rerender 时）
 */
export async function runConsistencyCheck(
  rt: ConsistencyRuntime,
  opts: {
    projectId: string
    shot: Shot
    refImageRel: string
    segmentAbsPath: string
    consistencyMode: 'off' | 'warn' | 'rerender'
    renderSeed: number
    engine: string
    reRun: (seed: number, forceEngine?: string) => Promise<void>
  },
): Promise<number> {
  const { projectId, shot, refImageRel, segmentAbsPath, consistencyMode, reRun, engine } = opts
  let renderSeed = opts.renderSeed
  if (shot.type !== 'i2v' || consistencyMode === 'off') return renderSeed

  const service = rt.getConsistencyService()
  if (!(await service.available())) return renderSeed

  // D-06（2026-10-22）：R2V 参考驱动镜的比对口径。R2V（ref2va）以参考角色图为驱动，
  // 身份在视频内自洽；用「定妆大头照 vs 特写视频帧」比对会因光照（雪夜月光蓝调 vs 定妆
  // 中性光）、表情（25/50/90% 采样常落在开口说话帧）、景别（topA 0.065 vs topB 0.37）
  // 的系统性差异把 ArcFace 分数压到 0.3 上下，进而被误标 lowConsistency、被拼接剔除
  // （实测《灵气打卡》4 个台词镜 0.23~0.33、《剑出山门》台词镜 0.295 均属此类）。
  // 口径修正：R2V 镜以本镜视频第 0 帧为身份锚（同源同光同人），只度量视频内漂移；
  // 且 R2V 镜不再产生 lowConsistency 标记（参考驱动引擎的漂移风险在帧间，不在与定妆的比对）。
  const isR2vShot = !!shot.audioPath
  let score: number | undefined
  let method: 'face' | 'full' = 'full'
  let compareRefAbs = shot.firstFramePath ? rt.resolveInBase(shot.firstFramePath) : rt.resolveInBase(refImageRel)
  if (isR2vShot) {
    try {
      const anchorRel = `projects/${projectId}/shots/${shot.id}_anchor.png`
      await rt.ffmpeg.extractFrameAt(segmentAbsPath, rt.resolveInBase(anchorRel), 0.06)
      compareRefAbs = rt.resolveInBase(anchorRel)
    } catch {
      // 2026-10-25 修复（专家C P2-3）：抽锚失败不再静默回退定妆图口径——该口径对 R2V
      // 有系统性误压（曾把《灵气打卡》4 个台词镜 0.23~0.33 误标 lowConsistency）。
      // 直接跳过本镜一致性写分（不写入 consistencyScore、不产生 lowConsistency 标记），
      // 后续可经 recheckProjectConsistency 手动重算。
      log.warn(`[${shot.id}] R2V 身份锚抽帧失败，跳过一致性写分（避免定妆图口径误压）；可手动 recheck 重算`)
      return renderSeed
    }
  }
  try {
    rt.emitProgress({
      projectId,
      shotId: shot.id,
      step: 'combine',
      percent: 97,
      message: service.needsDownload ? '首次加载人物一致性模型（约90MB）...' : '人物一致性校验...',
    })
    const dur = await rt.ffmpeg.getDuration(segmentAbsPath)
    // 三帧抽样（25%/50%/90%）取平均，捕捉中间段漂移，而非只看末帧附近
    const frameTimes = [0.25, 0.5, 0.9].map((f) => Math.max(0.1, dur * f))
    const result = await service.compareFrames(compareRefAbs, segmentAbsPath, frameTimes)
    score = result.score
    method = result.method
    shot.consistencyScore = Math.round(score * 1000) / 1000
    log.info(
      `一致性 ${shot.id}：${method === 'face' ? '人脸' : '全图'}相似度 ${score.toFixed(3)}（3帧平均）【${service.lastMethodTrace}】`,
    )
  } catch (e) {
    log.warn(`一致性校验跳过: ${e instanceof Error ? e.message : String(e)}`)
  }

  if (score === undefined) return renderSeed
  const threshold = method === 'face' ? FACE_CONSISTENCY_THRESHOLD : CONSISTENCY_THRESHOLD
  // 通过：清除历史低一致性标记（重渲翻案，拼接不再剔除）
  if (score >= threshold) {
    shot.lowConsistency = undefined
    return renderSeed
  }

  const modeText = method === 'face' ? '人脸' : '全图'
  const warnMsg = `${modeText}相似度 ${score.toFixed(2)} 偏低，可能存在面部/造型漂移`
  // H3 兜底：rerender 模式按阈值触发；warn/off 仅在灾难级低分（<0.15）时强制切一次 Wan，
  // 避免「画面里已经不是这个人」的坏镜直接进成片
  const fallbackWan = shouldFallbackToWan(consistencyMode, engine, score, H3_WAN_FALLBACK_THRESHOLD)

  if (fallbackWan || consistencyMode === 'rerender') {
    renderSeed = Math.floor(Math.random() * 0xffffffff)
    shot.seed = renderSeed
    if (fallbackWan) {
      rt.emitProgress({
        projectId,
        shotId: shot.id,
        step: 'render',
        percent: 20,
        message: `${warnMsg}（H3 身份漂移严重，自动切换 Wan i2v 重渲以锁定人物）...`,
      })
      log.info(`[${shot.id}] H3 一致性 ${score.toFixed(3)} 极低，切换 Wan i2v 重渲`)
      await reRun(renderSeed, 'wan')
    } else {
      rt.emitProgress({
        projectId,
        shotId: shot.id,
        step: 'render',
        percent: 20,
        message: `${warnMsg}，换 seed 自动重渲一次...`,
      })
      await reRun(renderSeed)
    }
    try {
      const dur2 = await rt.ffmpeg.getDuration(segmentAbsPath)
      const result2 = await service.compareFrames(
        compareRefAbs,
        segmentAbsPath,
        [0.25, 0.5, 0.9].map((f) => Math.max(0.1, dur2 * f)),
      )
      shot.consistencyScore = Math.round(result2.score * 1000) / 1000
      if (result2.score < (result2.method === 'face' ? FACE_CONSISTENCY_THRESHOLD : CONSISTENCY_THRESHOLD)) {
        shot.lowConsistency = true
        rt.emitProgress({
          projectId,
          shotId: shot.id,
          step: 'combine',
          percent: 99,
          message: `重渲后${result2.method === 'face' ? '人脸' : '全图'}相似度 ${result2.score.toFixed(2)} 仍偏低，已标记。镜头仍进入成片，可在剪辑台跳过或重渲`,
        })
      } else {
        shot.lowConsistency = undefined
      }
    } catch {
      // 复评失败不阻塞
    }
  } else {
    // R2V 参考驱动镜一般不标 lowConsistency（见 D-06 口径说明），
    // 但灾难级低分（<0.2，画面里已不是参考人物）必须标记，供复审/剪辑台剔除。
    shot.lowConsistency = (method === 'face' && score < 0.4) || score < 0.2 ? true : shot.lowConsistency
    rt.emitProgress({
      projectId,
      shotId: shot.id,
      step: 'combine',
      percent: 99,
      message:
        isR2vShot && score < 0.2
          ? `${warnMsg}（R2V 漂移严重，已标记低一致性；镜头仍进入成片，可在剪辑台跳过或重渲）`
          : isR2vShot
            ? `${warnMsg}（R2V 参考驱动镜，分数仅供参考，不标记）`
            : method === 'face' && score < 0.4
              ? `${warnMsg}（已标记严重漂移，镜头仍进入成片；可在剪辑台跳过或重渲）`
              : `${warnMsg}（仅告警，镜头保留进成片）`,
    })
  }
  return renderSeed
}

/**
 * 手动重跑项目全部 i2v 镜一致性校验（只更新 consistencyScore/lowConsistency，不触发重渲）。
 * 用途：旧项目被旧逻辑误杀标记的镜头摘帽——新逻辑（小脸门控+分方法聚合）复评，
 * 误杀摘帽回成片，真漂移保持标记；随后从「拼接成片」续跑即可。
 * 参考图选取与 runConsistencyCheck 同口径：特写且有本镜首帧用首帧，否则用渲染参考图。
 */
export async function recheckProjectConsistency(
  rt: ConsistencyRuntime,
  projectId: string,
): Promise<{ rechecked: number; cleared: number; stillLow: number; skipped: number }> {
  const project = await rt.store.get(projectId)
  if (!project) throw new Error('项目不存在')
  const service = rt.getConsistencyService()
  if (!(await service.available())) throw new Error('一致性模型不可用（onnx 未安装或模型文件缺失）')
  let rechecked = 0
  let cleared = 0
  let stillLow = 0
  let skipped = 0
  for (const shot of project.shots) {
    if (shot.type !== 'i2v' || shot.status !== 'done' || !shot.segmentPath) {
      skipped++
      continue
    }
    const refImageRel = rt.resolveRefImageRel(shot, project)
    if (!refImageRel) {
      skipped++
      continue
    }
    try {
      rt.emitProgress({
        projectId,
        shotId: shot.id,
        step: 'combine',
        percent: 97,
        message: `第${shot.index}镜 重跑人物一致性校验...`,
      })
      const compareRefAbs0 = shot.firstFramePath ? rt.resolveInBase(shot.firstFramePath) : rt.resolveInBase(refImageRel)
      let compareRefAbs = compareRefAbs0
      const segmentAbs = rt.resolveInBase(shot.segmentPath)
      const isR2vShot = !!shot.audioPath
      if (isR2vShot) {
        // D-06：R2V 参考驱动镜以视频第 0 帧为锚（同 runConsistencyCheck 口径）
        try {
          const anchorRel = `projects/${projectId}/shots/${shot.id}_anchor.png`
          await rt.ffmpeg.extractFrameAt(segmentAbs, rt.resolveInBase(anchorRel), 0.06)
          compareRefAbs = rt.resolveInBase(anchorRel)
        } catch {
          /* 保持原参照 */
        }
      }
      const dur = await rt.ffmpeg.getDuration(segmentAbs)
      const frameTimes = [0.25, 0.5, 0.9].map((f) => Math.max(0.1, dur * f))
      const result = await service.compareFrames(compareRefAbs, segmentAbs, frameTimes)
      const threshold = result.method === 'face' ? FACE_CONSISTENCY_THRESHOLD : CONSISTENCY_THRESHOLD
      shot.consistencyScore = result.score
      rechecked++
      log.info(
        `一致性复评 第${shot.index}镜：${result.method === 'face' ? '人脸' : '全图'} ${result.score.toFixed(3)}（阈值 ${threshold}${isR2vShot ? '，R2V 锚点' : ''}）`,
      )
      // R2V 参考驱动镜不标 lowConsistency（D-06）；i2v 镜按阈值摘帽
      if (result.score >= threshold || isR2vShot) {
        if (shot.lowConsistency) cleared++
        shot.lowConsistency = undefined
      } else {
        shot.lowConsistency = true
        stillLow++
      }
    } catch (e) {
      skipped++
      log.warn(`一致性复评跳过 shot=${shot.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  await rt.store.save(project)
  return { rechecked, cleared, stillLow, skipped }
}

/**
 * 角色混淆相对判别（多角色剧防张冠李戴，2026-10-23 新增）：
 * 对单镜输出视频，与本角色定妆得分 vs 每个其他角色定妆得分交叉比对（同视频帧、同构图口径），
 * 若"更像另一角色"（bestOther > self + 0.05）→ 置 shot.roleConfusion = true 并返回判定详情。
 * 锚图口径同 D-06：R2V 参考驱动镜以视频第 0 帧为锚；i2v 用本镜首帧（无首帧回退渲染参考图）。
 * 仅当项目角色数 > 1 且该镜绑定角色且产物存在时执行。
 * 注意：定妆大头照 vs 视频特写帧的绝对分数会被构图压低（D-06），本判别只用相对差，不设绝对阈值。
 */
export async function computeShotRoleConfusion(
  rt: ConsistencyRuntime,
  projectId: string,
  shot: Shot,
  project: Project,
): Promise<{
  confused: boolean
  withCharacter?: string
  withName?: string
  selfScore?: number
  bestOther?: number
} | null> {
  const declaredId = shot.characterIds[0]
  if (!declaredId) return null
  const declared = project.characters.find((c) => c.id === declaredId)
  if (!declared) return null
  const others = project.characters.filter(
    (c) => c.id !== declaredId && (c.faceImagePath || c.refImagePath || c.bodySheetPath),
  )
  if (others.length === 0) return null
  if (shot.type !== 'i2v' || shot.status !== 'done' || !shot.segmentPath) return null
  const service = rt.getConsistencyService()
  if (!(await service.available())) return null
  const segmentAbs = rt.resolveInBase(shot.segmentPath)
  // 锚：R2V → 视频第 0 帧；i2v → 本镜首帧 > 渲染参考图
  let refAbs = shot.firstFramePath ? rt.resolveInBase(shot.firstFramePath) : null
  const isR2vShot = !!shot.audioPath
  if (isR2vShot) {
    try {
      const anchorRel = `projects/${projectId}/shots/${shot.id}_anchor.png`
      await rt.ffmpeg.extractFrameAt(segmentAbs, rt.resolveInBase(anchorRel), 0.06)
      refAbs = rt.resolveInBase(anchorRel)
    } catch {
      /* 保持原参照 */
    }
  }
  if (!refAbs) {
    try {
      refAbs = rt.resolveInBase(rt.resolveRefImageRel(shot, project))
    } catch {
      return null
    }
  }
  const dur = await rt.ffmpeg.getDuration(segmentAbs).catch(() => 0)
  if (!dur) return null
  const frameTimes = [0.25, 0.5, 0.9].map((f) => Math.max(0.1, dur * f))
  const selfResult =
    typeof shot.consistencyScore === 'number'
      ? { score: shot.consistencyScore }
      : await service.compareFrames(refAbs, segmentAbs, frameTimes).catch(() => ({ score: 0 }))
  const otherScores: Array<{ characterId: string; name: string; score: number }> = []
  for (const other of others) {
    const otherRel = other.faceImagePath || other.refImagePath || other.bodySheetPath!
    try {
      const r = await service.compareFrames(rt.resolveInBase(otherRel), segmentAbs, frameTimes)
      otherScores.push({ characterId: other.id, name: other.name, score: r.score })
    } catch {
      /* 单角色比对失败跳过 */
    }
  }
  const verdict = detectRoleConfusion({
    selfScore: selfResult.score,
    otherScores,
    margin: 0.05,
  })
  if (verdict.confused) {
    shot.roleConfusion = true
    log.warn(
      `角色混淆 ${shot.id}（第${shot.index}镜）：本镜声明角色「${declared.name}」self=${verdict.selfScore?.toFixed(3)}，但输出更像「${verdict.withName}」${verdict.bestOther?.toFixed(3)}（>self+0.05），已标记待重渲`,
    )
  }
  return verdict
}

/**
 * 项目级角色混淆扫描（复评/拼接前调用）：遍历 done i2v 镜，交叉比对各角色定妆，回填 roleConfusion。
 */
export async function recheckProjectRoleConfusion(
  rt: ConsistencyRuntime,
  projectId: string,
): Promise<{ checked: number; confused: number; skipped: number }> {
  const project = await rt.store.get(projectId)
  if (!project) throw new Error('项目不存在')
  const multi = (project.characters || []).length > 1
  let checked = 0
  let confused = 0
  let skipped = 0
  for (const shot of project.shots) {
    if (!multi || shot.type !== 'i2v' || shot.status !== 'done' || !shot.segmentPath) {
      skipped++
      continue
    }
    const verdict = await computeShotRoleConfusion(rt, projectId, shot, project)
    if (!verdict) {
      skipped++
      continue
    }
    checked++
    if (verdict.confused) {
      confused++
      shot.roleConfusion = true
      shot.auditHint = `角色混淆：本镜声明「${project.characters.find((c) => c.id === shot.characterIds[0])?.name}」但画面更像「${verdict.withName}」（${verdict.bestOther?.toFixed(2)} vs self ${verdict.selfScore?.toFixed(2)}），请重渲该镜或修正参考图`
    }
  }
  await rt.store.save(project)
  log.info(`角色混淆扫描 ${projectId}：checked=${checked} confused=${confused} skipped=${skipped}`)
  return { checked, confused, skipped }
}
