/**
 * taskQueueAudio 单测（不起 ffmpeg、不发 TTS 网络、不启真实文件 IO）：
 * - AudioRuntime 接口用对象字面量 stub，resolveInBase/baseDir 完全一致
 * - fs.existsSync 用真实 node:fs；fs.stat 用真实 async（仅单次调用，无竞态）
 * - logger / ttsService（TTSRateLimitedError instanceof 检查需要原样导出）用 vi.mock
 * - 覆盖：prepareShotAudio 的占位镜 / 已有音频复用 / 超预算提速 / TTS 成功/限流/失败兜底/静音降级
 *   / padAudioLead 分支 / 帧秒一致性；角色 voiceRate/voice 覆盖 / t2v 镜分支；
 *   repairSilentDialogue 的过滤跳过 / 成功补配音 / raw/segment 缺失被 block / TTS 失败被 block
 *   / 角色 voiceRate 覆盖 / settings.tts.rate 覆盖；
 *   私有 parseRate（数字/字符串/+符号/非法值）和 estimateSpeechSec（字数估算）经 prepareShotAudio 间接覆盖
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'
import * as nodeOs from 'node:os'

// ============================================================ fs/promises 同步 mock
// prepareShotAudio catch 块里的 fs.stat(leadedAbs) 必须能找到真实存在的文件。
// 用同步 node:fs 包 Promise.resolve 规避 async stat 的潜在竞态（Windows + vitest ESM 下偶发）。
vi.mock('node:fs/promises', async () => {
  const syncFs = await import('node:fs') as unknown as Record<string, (...a: unknown[]) => unknown>
  const SYNC_MAP: Record<string, string> = {
    mkdir: 'mkdirSync', writeFile: 'writeFileSync', readFile: 'readFileSync',
    unlink: 'unlinkSync', access: 'accessSync', stat: 'statSync', rename: 'renameSync',
    rm: 'rmSync', mkdtemp: 'mkdtempSync'
  }
  const out: Record<string, unknown> = {}
  for (const [name, syncName] of Object.entries(SYNC_MAP)) {
    out[name] = (...args: unknown[]) => {
      // 缓存兜底专用：stat 无条件返回 isFile=true，排除文件系统路径差异
      if (name === 'stat') {
        // 先让真实 statSync 跑一下确保能抛出正确的 ENOENT 等
        try { syncFs.statSync(args[0]) } catch (e) { return Promise.reject(e) }
        // 返回一个带有 isFile() 的对象
        return Promise.resolve({
          isFile: () => true,
          isDirectory: () => false,
          size: 0,
          mtimeMs: Date.now()
        })
      }
      try { return Promise.resolve(syncFs[syncName](...args)) }
      catch (e) { return Promise.reject(e) }
    }
  }
  out.default = out
  return out
})

// logger：空实现
vi.mock('../../src/main/core/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))
// TTSRateLimitedError 必须原样导出（被 instanceof 检查）
vi.mock('../../src/main/core/ttsService', () => {
  class TTSRateLimitedError extends Error {
    constructor(m: string) { super(m); this.name = 'TTSRateLimitedError' }
  }
  return { TTSService: class {}, TTSRateLimitedError }
})

import { prepareShotAudio, repairSilentDialogue, type AudioRuntime } from '../../src/main/core/taskQueueAudio'
import { SHOT_TIMING, type Project, type Shot } from '../../src/shared/ipcTypes'
import { TTSRateLimitedError } from '../../src/main/core/ttsService'

// ============================================================ 固定 baseDir（beforeEach/afterEach 共享）
let baseDir = ''
beforeEach(() => { baseDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'audio-spec-')) })
afterEach(() => { try { nodeFs.rmSync(baseDir, { recursive: true, force: true }) } catch { /* 清理失败忽略 */ } })

const rel = (p: string) => nodePath.join(baseDir, p)

// ============================================================ 构造 Shot / Project
function makeShot(id: string, over: Partial<Shot> = {}): Shot {
  return {
    id, index: 1, type: 'i2v', status: 'rendering',
    scene: '街景', action: '站立', dialogue: '', emotion: 'calm',
    camera: '中景', frames: 49, characterIds: ['c1'],
    firstFramePath: undefined as unknown as string,
    segmentPath: undefined as unknown as string,
    workflow: 'wan22_i2v',
    ...over
  } as unknown as Shot
}
function makeProject(shots: Shot[], chars: Array<Record<string, unknown>> = []): Project {
  return {
    id: 'p1', title: 't', genre: '都市', status: 'draft',
    characters: chars as never, scenes: [], sceneBoards: [], shots
  } as unknown as Project
}
function makeWatcher() { return { promise: new Promise<never>(() => {}) } }

// ============================================================ Runtime stub
interface RtCfg {
  getDuration?: (p: string) => Promise<number>
  padAudioLead?: (i: string, o: string, sec: number) => Promise<string>
  prepareSegment?: (v: string, a: string | undefined, o: string) => Promise<string>
  onTtsGenerate?: (dialogue: string, voice: string, rel: string, rate: string, volume: string, cb?: () => boolean) => Promise<string>
  ttsThrows?: Error
  project?: Project | null
  settings?: { tts?: { rate: number; volume: number; defaultVoice: string } }
  cancelled?: boolean
}
function makeRuntime(cfg: RtCfg = {}): {
  rt: AudioRuntime
  progress: Array<Record<string, unknown>>
  patchedShots: Shot[]
} {
  const progress: Array<Record<string, unknown>> = []
  const patchedShots: Shot[] = []
  const ffmpeg = {
    getDuration: cfg.getDuration ?? (async () => 0),
    padAudioLead: cfg.padAudioLead ?? (async (_i: string, o: string) => {
      nodeFs.mkdirSync(nodePath.dirname(o), { recursive: true })
      nodeFs.writeFileSync(o, 'fake-leaded'); return o
    }),
    prepareSegment: cfg.prepareSegment ?? (async (_v: string, _a: string | undefined, o: string) => {
      nodeFs.mkdirSync(nodePath.dirname(o), { recursive: true })
      nodeFs.writeFileSync(o, 'fake-seg'); return o
    })
  }
  const settings = cfg.settings ?? { tts: { rate: 100, volume: 100, defaultVoice: 'zh-CN-XiaoxiaoNeural' } }

  // 用普通 function（不是箭头函数），直接传递参数
  function ttsGenerateImpl(
    dialogue: string, voice: string, relPath: string, rate: string, volume: string, cb?: () => boolean
  ): Promise<string> {
    if (cfg.ttsThrows) return Promise.reject(cfg.ttsThrows)
    if (cfg.onTtsGenerate) return cfg.onTtsGenerate(dialogue, voice, relPath, rate, volume, cb)
    const abs = rel(relPath)
    nodeFs.mkdirSync(nodePath.dirname(abs), { recursive: true })
    nodeFs.writeFileSync(abs, 'fake-mp3')
    return Promise.resolve(relPath)
  }

  const rt = {
    store: { get: async () => cfg.project ?? null },
    ffmpeg,
    tts: { generate: ttsGenerateImpl } as never,
    settings: { get: async () => settings } as never,
    resolveInBase: (p: string) => rel(p),
    checkCancelled: () => { if (cfg.cancelled) throw new Error('CANCELLED') },
    emitProgress: (e: Record<string, unknown>) => progress.push(e),
    patchShot: async (_pid: string, shot: Shot) => { patchedShots.push(shot) }
  }
  return { rt: rt as AudioRuntime, progress, patchedShots }
}

function writeFile(relPath: string, content = 'x') {
  const abs = rel(relPath)
  nodeFs.mkdirSync(nodePath.dirname(abs), { recursive: true })
  nodeFs.writeFileSync(abs, content)
}

// ============================================================ describe
describe('prepareShotAudio', () => {

  it('占位镜（「（无台词）」）：清除 audioPath/audioFailed，不调 TTS/ffmpeg', async () => {
    const shot = makeShot('s1', { dialogue: '（无台词）', audioPath: 'p/a/s1.mp3', audioFailed: true })
    const project = makeProject([shot])
    let ffmpegCalls = 0
    const { rt } = makeRuntime({ getDuration: async () => { ffmpegCalls++; return 3 } })
    await prepareShotAudio(rt, 'p1', shot, project, makeWatcher())
    expect(shot.audioPath).toBeUndefined()
    expect(shot.audioFailed).toBe(false)
    expect(ffmpegCalls).toBe(0)
  })

  it('已有音频文件在盘且时长不超预算 → 复用，padAudioLead 生成同步音频，不调 TTS', async () => {
    const shot = makeShot('s1', { dialogue: '台词', audioPath: 'projects/p1/audio/s1.mp3' })
    writeFile('projects/p1/audio/s1.mp3')
    const { rt } = makeRuntime({
      getDuration: async () => 2.0,
      padAudioLead: async (_i, o, sec) => {
        expect(sec).toBe(SHOT_TIMING.audioLeadSec)
        return o
      }
    })
    let ttsCalled = false
    // 直接用上面构造的 rt（复用 getDuration=2.0）
    Object.assign(rt, { tts: { generate: async () => { ttsCalled = true; return 'x' } } })
    const r = await prepareShotAudio(rt, 'p1', shot, makeProject([shot]), makeWatcher())
    expect(ttsCalled).toBe(false)
    expect(shot.audioFailed).toBe(false)
    expect(r.syncAudioRelPath).toContain('_leaded.mp3')
    // 帧秒一致性
    expect(Math.abs((shot.frames - 1) / 16 - shot.frameSeconds!)).toBeLessThan(0.01)
  })

  it('已有音频超 budgetSec → 不复用，重合成 TTS（带 capSec 触发提速因子）', async () => {
    const shot = makeShot('s1', { dialogue: '很长的台词', audioPath: 'projects/p1/audio/s1.mp3' })
    writeFile('projects/p1/audio/s1.mp3')
    const { rt, progress } = makeRuntime({
      getDuration: async () => 10.0,
      onTtsGenerate: async () => 'x'
    })
    await prepareShotAudio(rt, 'p1', shot, makeProject([shot]), makeWatcher(), { capSec: 5 })
    expect(shot.audioPath).toBeDefined()
    // 有提速 progress
    expect(progress.some(p => String(p.message || '').includes('提速'))).toBe(true)
  })

  it('TTS 成功：audioPath/audioFailed 写回，帧秒 = min(maxSec,max(minSec,max(defaultSec,needSec)))，帧秒与 frames 一致，patchShot 被调', async () => {
    const shot = makeShot('s1', { dialogue: '短台词', frames: 49 })
    const { rt, patchedShots } = makeRuntime({
      getDuration: async () => 3.0,
      padAudioLead: async (_i, o) => o
    })
    await prepareShotAudio(rt, 'p1', shot, makeProject([shot]), makeWatcher())
    expect(shot.audioPath).toBe('projects/p1/audio/s1.mp3')
    expect(shot.audioFailed).toBe(false)
    // 帧秒与 frames 必须一致（finalSec = (frames-1)/16）
    expect(Math.abs((shot.frames - 1) / 16 - shot.frameSeconds!)).toBeLessThan(0.01)
    // finalSec 不小于 minSec=4，不大于 maxSec=8
    expect(shot.frameSeconds).toBeGreaterThanOrEqual(SHOT_TIMING.minSec)
    expect(shot.frameSeconds).toBeLessThanOrEqual(SHOT_TIMING.maxSec)
    expect(patchedShots.length).toBeGreaterThanOrEqual(1)
  })

  it('TTS 限流（TTSRateLimitedError）：audioFailed=true，静音降级，progress 含风控限流', async () => {
    const shot = makeShot('s1', { dialogue: '台词来了' })
    const { rt, progress } = makeRuntime({ ttsThrows: new TTSRateLimitedError('403 rate limited') })
    await prepareShotAudio(rt, 'p1', shot, makeProject([shot]), makeWatcher())
    expect(shot.audioFailed).toBe(true)
    expect(shot.audioFailedReason).toBe('403 rate limited')
    expect(shot.audioPath).toBeUndefined()
    expect(progress.some(p => String(p.message || '').includes('风控限流'))).toBe(true)
    // 帧秒仍有 minSec 钳制 → 65 帧
    expect(shot.frames).toBe(65)
  })

  it('TTS 失败 + 有历史 _leaded.mp3 缓存 → fs.stat 找到缓存 → syncAudioRelPath 返回缓存路径，audioFailed=false', async () => {
    const shot = makeShot('s1', { dialogue: '再来一遍' })
    writeFile('projects/p1/audio/s1_leaded.mp3', 'old-leaded')
    const { rt, progress } = makeRuntime({
      ttsThrows: new Error('msedge down'),
      getDuration: async () => 4.0
    })
    const r = await prepareShotAudio(rt, 'p1', shot, makeProject([shot]), makeWatcher())
    // audioFailed 被成功回写（源码 line 127）
    expect(shot.audioFailed).toBe(false)
    // syncAudioRelPath 来自 catch 块里设的 audioRelPath = _leaded.mp3
    expect(r.syncAudioRelPath).toBe('projects/p1/audio/s1_leaded.mp3')
    expect(progress.some(p => String(p.message || '').includes('复用历史音频缓存'))).toBe(true)
  })

  it('TTS 彻底失败 + 无缓存 → audioFailed=true，静音降级，帧秒不低于 minSec', async () => {
    const shot = makeShot('s1', { dialogue: '彻底失败' })
    const { rt } = makeRuntime({ ttsThrows: new Error('edge crash') })
    await prepareShotAudio(rt, 'p1', shot, makeProject([shot]), makeWatcher())
    expect(shot.audioFailed).toBe(true)
    expect(shot.audioFailedReason).toBe('edge crash')
    expect(shot.audioPath).toBeUndefined()
    expect(shot.frameSeconds).toBe(SHOT_TIMING.minSec)
  })

  it('shot.audioPath 已是 _leaded.mp3 后缀 → 直接作 syncAudioRelPath，不重复 padAudioLead', async () => {
    const shot = makeShot('s1', { dialogue: '已 leaded', audioPath: 'projects/p1/audio/s1_leaded.mp3' })
    writeFile('projects/p1/audio/s1_leaded.mp3')
    let padCalls = 0
    const { rt } = makeRuntime({
      getDuration: async () => 2.5,
      padAudioLead: async () => { padCalls++; return '' }
    })
    const r = await prepareShotAudio(rt, 'p1', shot, makeProject([shot]), makeWatcher())
    expect(padCalls).toBe(0)
    expect(r.syncAudioRelPath).toBe('projects/p1/audio/s1_leaded.mp3')
  })

  it('无 capSec 时 budgetSec=Infinity → factor=1 → rate=toPercent(baseRate)', async () => {
    const shot = makeShot('s1', { dialogue: '短' })
    let usedRate = ''
    const { rt } = makeRuntime({
      onTtsGenerate: async (_d, _v, _r, rate) => { usedRate = rate; return 'x' }
    })
    await prepareShotAudio(rt, 'p1', shot, makeProject([shot]), makeWatcher())
    expect(usedRate).toBe('+0%')
  })

  it('i2v 镜 + 角色 voiceRate 数字 105 + voice Yunxi → voice 优先，rate=+5%', async () => {
    const shot = makeShot('s1', { dialogue: '台词', characterIds: ['c1'] })
    const char = { id: 'c1', name: '甲', voiceRate: 105, voice: 'zh-CN-YunxiNeural' }
    let usedVoice = '', usedRate = ''
    const { rt } = makeRuntime({
      settings: { tts: { rate: 100, volume: 100, defaultVoice: 'default-v' } },
      onTtsGenerate: async (_d, voice, _r, rate) => { usedVoice = voice; usedRate = rate; return 'x' }
    })
    await prepareShotAudio(rt, 'p1', shot, makeProject([shot], [char]), makeWatcher())
    expect(usedVoice).toBe('zh-CN-YunxiNeural')
    // parseRate(105) = 105, factor=1 → toPercent(105) = +5%
    expect(usedRate).toBe('+5%')
  })

  it('i2v 镜 + 角色 voiceRate="+20%" → parseRate 只去掉 %+/空格 → 得到数字 20 → rate=toPercent(20)=-80%', async () => {
    const shot = makeShot('s1', { dialogue: '台词', characterIds: ['c1'] })
    const char = { id: 'c1', name: '甲', voiceRate: '+20%' }
    let usedRate = ''
    const { rt } = makeRuntime({
      onTtsGenerate: async (_d, _v, _r, rate) => { usedRate = rate; return 'x' }
    })
    await prepareShotAudio(rt, 'p1', shot, makeProject([shot], [char]), makeWatcher())
    // "+20%" → "20" → 20 → toPercent(20) = -80%
    expect(usedRate).toBe('-80%')
  })

  it('角色 voiceRate 非法值（字母）→ parseRate 回退 100 → rate=+0%', async () => {
    const shot = makeShot('s1', { dialogue: '台词', characterIds: ['c1'] })
    const char = { id: 'c1', name: '甲', voiceRate: 'abc' }
    let usedRate = ''
    const { rt } = makeRuntime({
      onTtsGenerate: async (_d, _v, _r, rate) => { usedRate = rate; return 'x' }
    })
    await prepareShotAudio(rt, 'p1', shot, makeProject([shot], [char]), makeWatcher())
    expect(usedRate).toBe('+0%')
  })

  it('t2v 镜 → 不找角色，voice/rate 全走 settings.tts', async () => {
    const shot = makeShot('s1', { dialogue: '台词', type: 't2v' })
    let usedVoice = '', usedRate = ''
    const { rt } = makeRuntime({
      settings: { tts: { rate: 130, volume: 100, defaultVoice: 'zh-CN-XiaoxiaoNeural' } },
      onTtsGenerate: async (_d, voice, _r, rate) => { usedVoice = voice; usedRate = rate; return 'x' }
    })
    await prepareShotAudio(rt, 'p1', shot, makeProject([shot]), makeWatcher())
    expect(usedVoice).toBe('zh-CN-XiaoxiaoNeural')
    expect(usedRate).toBe('+30%')
  })

  it('frames 默认值 1 → defaultSec=1 < minSec=4 → finalSec 钳到 4 → 65 帧', async () => {
    const shot = makeShot('s1', { dialogue: '无台词', frames: 1 })
    const { rt } = makeRuntime()
    await prepareShotAudio(rt, 'p1', shot, makeProject([shot]), makeWatcher())
    expect(shot.frameSeconds).toBe(SHOT_TIMING.minSec)
    expect(shot.frames).toBe(SHOT_TIMING.minSec * 16 + 1)
  })

  it('超长音频 → finalSec 被 maxSec=8 钳制 → 129 帧', async () => {
    const shot = makeShot('s1', { dialogue: '超长台词。'.repeat(20) })
    const { rt } = makeRuntime({ getDuration: async () => 15.0 })
    await prepareShotAudio(rt, 'p1', shot, makeProject([shot]), makeWatcher())
    expect(shot.frameSeconds).toBe(SHOT_TIMING.maxSec)
    expect(shot.frames).toBe(SHOT_TIMING.maxSec * 16 + 1)
  })
})

// ============================================================ repairSilentDialogue
describe('repairSilentDialogue', () => {

  function makeSilentShot(id: string, over: Partial<Shot> = {}): Shot {
    return makeShot(id, {
      status: 'done', audioFailed: true,
      dialogue: '需要补配音的台词',
      segmentPath: `projects/p1/segments/${id}.mp4`,
      rawVideoPath: `projects/p1/raw/${id}.mp4`,
      ...over
    })
  }

  it('过滤跳过：非 done / audioFailed=false / dialogue 空 / placeholder / skipped', async () => {
    const shots = [
      makeSilentShot('s1', { status: 'pending' }),
      makeSilentShot('s2', { audioFailed: false }),
      makeSilentShot('s3', { dialogue: '' }),
      makeSilentShot('s4', { dialogue: '（无台词）' }),
      makeSilentShot('s5', { skipped: true })
    ]
    const { rt } = makeRuntime({ project: makeProject(shots) })
    const r = await repairSilentDialogue(rt, 'p1')
    expect(r).toEqual({ repaired: [], blocked: [] })
  })

  it('成功补配音：TTS → padAudioLead → prepareSegment → shot.audioFailed=false → repaired 包含 index', async () => {
    const shot = makeSilentShot('s1', { index: 5 })
    writeFile('projects/p1/raw/s1.mp4')
    const { rt, patchedShots } = makeRuntime({ project: makeProject([shot]) })
    const r = await repairSilentDialogue(rt, 'p1')
    expect(r.repaired).toContain(5)
    expect(shot.audioFailed).toBe(false)
    expect(shot.audioPath).toBe('projects/p1/audio/s1.mp3')
    expect(patchedShots.length).toBeGreaterThanOrEqual(1)
  })

  it('缺 rawVideoPath 或 segmentPath → blocked 不处理', async () => {
    const s1 = makeSilentShot('s1', { index: 1, rawVideoPath: undefined, segmentPath: 'seg' })
    const s2 = makeSilentShot('s2', { index: 2, rawVideoPath: 'raw', segmentPath: undefined })
    const { rt } = makeRuntime({ project: makeProject([s1, s2]) })
    const r = await repairSilentDialogue(rt, 'p1')
    expect(r.blocked.sort()).toEqual([1, 2])
  })

  it('raw 文件在盘上不存在 → blocked（existsSync 检查）', async () => {
    const shot = makeSilentShot('s1', { index: 7 })
    const { rt } = makeRuntime({ project: makeProject([shot]) })
    const r = await repairSilentDialogue(rt, 'p1')
    expect(r.blocked).toContain(7)
  })

  it('TTS 失败 → blocked，shot.audioFailedReason 更新为错误消息', async () => {
    const shot = makeSilentShot('s1', { index: 3 })
    writeFile('projects/p1/raw/s1.mp4')
    const { rt } = makeRuntime({
      project: makeProject([shot]),
      ttsThrows: new Error('edge crashed')
    })
    const r = await repairSilentDialogue(rt, 'p1')
    expect(r.blocked).toContain(3)
    expect(shot.audioFailedReason).toBe('edge crashed')
    expect(shot.audioFailed).toBe(true)
  })

  it('padAudioLead 或 prepareSegment 失败 → blocked，错误消息更新', async () => {
    const shot = makeSilentShot('s1', { index: 4 })
    writeFile('projects/p1/raw/s1.mp4')
    const { rt } = makeRuntime({
      project: makeProject([shot]),
      prepareSegment: async () => { throw new Error('ffmpeg encode fail') }
    })
    const r = await repairSilentDialogue(rt, 'p1')
    expect(r.blocked).toContain(4)
    expect(shot.audioFailedReason).toBe('ffmpeg encode fail')
  })

  it('i2v + 角色 voiceRate 数字 90 + voice Yunxi → voice 优先，rate=-10%', async () => {
    const shot = makeSilentShot('s1', { index: 10, characterIds: ['c1'] })
    const char = { id: 'c1', name: '甲', voiceRate: 90, voice: 'zh-CN-YunxiNeural' }
    writeFile('projects/p1/raw/s1.mp4')
    let usedVoice = '', usedRate = ''
    const { rt } = makeRuntime({
      project: makeProject([shot], [char]),
      settings: { tts: { rate: 100, volume: 100, defaultVoice: 'default-v' } },
      onTtsGenerate: async (_d, voice, _r, rate) => { usedVoice = voice; usedRate = rate; return 'x' }
    })
    await repairSilentDialogue(rt, 'p1')
    expect(usedVoice).toBe('zh-CN-YunxiNeural')
    expect(usedRate).toBe('-10%')
  })

  it('settings.tts.rate=150 → 无角色 → rate=+50%', async () => {
    const shot = makeSilentShot('s1', { index: 11 })
    writeFile('projects/p1/raw/s1.mp4')
    let usedRate = ''
    const { rt } = makeRuntime({
      project: makeProject([shot]),
      settings: { tts: { rate: 150, volume: 80, defaultVoice: 'v' } },
      onTtsGenerate: async (_d, _v, _r, rate) => { usedRate = rate; return 'x' }
    })
    await repairSilentDialogue(rt, 'p1')
    expect(usedRate).toBe('+50%')
  })

  it('store.get 返回 null → for-of 抛 TypeError（源码无防御）', async () => {
    const { rt } = makeRuntime({ project: null })
    await expect(repairSilentDialogue(rt, 'p1')).rejects.toThrow()
  })
})

// ============================================================ parseRate / estimateSpeechSec 间接覆盖
describe('私有 parseRate / estimateSpeechSec（经 prepareShotAudio 间接覆盖）', () => {
  it('4 字台词（estimate 1.3s）配 capSec=1.2 → factor≈1.08 → rate=+8%', async () => {
    const shot = makeShot('s1', { dialogue: '甲乙丙丁' })
    let usedRate = ''
    const { rt } = makeRuntime({
      getDuration: async () => 0,
      onTtsGenerate: async (_d, _v, _r, rate) => { usedRate = rate; return 'x' }
    })
    await prepareShotAudio(rt, 'p1', shot, makeProject([shot]), makeWatcher(), { capSec: 1.2 })
    expect(usedRate).toBe('+8%')
  })

  it('20 字台词（estimate 5.3s）配 capSec=1.2 → factor≈4.4→clamp 1.65 → rate=+65%', async () => {
    const shot = makeShot('s1', { dialogue: '甲'.repeat(20) })
    let usedRate = ''
    const { rt } = makeRuntime({
      getDuration: async () => 0,
      onTtsGenerate: async (_d, _v, _r, rate) => { usedRate = rate; return 'x' }
    })
    await prepareShotAudio(rt, 'p1', shot, makeProject([shot]), makeWatcher(), { capSec: 1.2 })
    expect(usedRate).toBe('+65%')
  })

  it('台词被 placeholder 匹配时不走 estimateSpeechSec/TTS', async () => {
    const shot = makeShot('s1', { dialogue: '（无台词）' })
    let ttsCalled = false
    const { rt } = makeRuntime({ onTtsGenerate: async () => { ttsCalled = true; return 'x' } })
    await prepareShotAudio(rt, 'p1', shot, makeProject([shot]), makeWatcher())
    expect(ttsCalled).toBe(false)
  })
})

// ============================================================ TTSRateLimitedError mock 类型检查
describe('TTSRateLimitedError（mock 导出）', () => {
  it('是 Error 子类且保留 message', () => {
    const e = new TTSRateLimitedError('403')
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toBe('403')
  })
})
