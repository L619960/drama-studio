/**
 * TTSService 单测（不发微软网络、不跑 powershell/ffmpeg/ComfyUI）：
 * - msedge-tts 整体 mock：FakeMsEdgeTTS 记录 setMetadata/toStream/close，toStreamBehavior 可控抛错/返回流。
 * - childProcessManager mock：execFile 行为可控（成功时写假 wav/mp3 文件，失败时 reject）。
 * - fs/promises passthrough mock（真实临时目录 + 调用记录），断言产物路径与内容。
 * - 退避/轮询定时器用 vi.useFakeTimers + advanceTimersByTimeAsync 驱动。
 * 覆盖：generate 包装、synthesize 四级降级链（Edge 成功/空流重试/403 长退避/普通错误短退避/
 * 限流透传 TTSRateLimitedError）、enforceRateLimit 间隔等待、Qwen 克隆层（样本缓存命中/未命中、
 * 取消、超时、非 mp3 产物轮询）、SAPI 层（成功/未产出/坏产物/转换失败）、generateClone 全分支、
 * getCacheKey rate 有无分支、私有 generateLocal（已废弃死代码，经强转补覆盖）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'
import * as nodeOs from 'node:os'
import * as nodeCrypto from 'node:crypto'
import type { ComfyUIClient } from '../../src/main/core/comfyuiClient'
import type { WorkflowLoader } from '../../src/main/core/workflowLoader'

const state = vi.hoisted(() => ({
  ttsInstances: [] as Array<{
    setMetadataCalls: Array<{ voice: string; format: string }>
    toStreamCalls: Array<{ text: string; opts: Record<string, string> }>
    closed: number
  }>,
  toStreamN: 0,
  /** 返回 {audioStream} 或同步抛错；n 为全局第几次 toStream */
  toStreamBehavior: null as
    null | ((text: string, opts: Record<string, string>, n: number) => { audioStream: AsyncIterable<Buffer> }),
  setMetadataBehavior: null as null | ((voice: string, format: string) => void),
  cpmCalls: [] as Array<{ bin: string; args: string[]; opts: unknown }>,
  cpmExecFileBehavior: null as
    null | ((bin: string, args: string[], opts: unknown) => Promise<{ stdout: string; stderr: string }>),
  fsCalls: [] as Array<{ fn: string; args: unknown[] }>,
}))

vi.mock('msedge-tts', () => {
  class FakeMsEdgeTTS {
    setMetadataCalls: Array<{ voice: string; format: string }> = []
    toStreamCalls: Array<{ text: string; opts: Record<string, string> }> = []
    closed = 0
    constructor() {
      state.ttsInstances.push(this as unknown as (typeof state.ttsInstances)[number])
    }
    async setMetadata(voice: string, format: string) {
      this.setMetadataCalls.push({ voice, format })
      if (state.setMetadataBehavior) state.setMetadataBehavior(voice, format)
    }
    toStream(text: string, opts: Record<string, string>) {
      this.toStreamCalls.push({ text, opts })
      state.toStreamN++
      if (state.toStreamBehavior) return state.toStreamBehavior(text, opts, state.toStreamN)
      return {
        audioStream: (async function* () {
          yield Buffer.from('FAKE-AUDIO')
        })(),
      }
    }
    close() {
      this.closed++
    }
  }
  return {
    MsEdgeTTS: FakeMsEdgeTTS,
    OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'audio-24khz-48kbitrate-mono-mp3' },
  }
})

vi.mock('../../src/main/core/childProcessManager', () => ({
  childProcessManager: {
    execFile: (bin: string, args: string[], opts: unknown) => {
      state.cpmCalls.push({ bin, args, opts })
      if (state.cpmExecFileBehavior) return state.cpmExecFileBehavior(bin, args, opts)
      return Promise.resolve({ stdout: '', stderr: '' })
    },
    spawn: vi.fn(),
    killAll: vi.fn(),
    getActiveHandles: vi.fn(),
  },
}))

vi.mock('../../src/main/core/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}))

// fs/promises mock：用 node:fs 的【同步】方法实现，返回同步值。
// 原因：fake timers 的 tickAsync 与真实异步 fs promise 存在事件循环竞态（fs IO 回调
// 错过让出机会时永不 resolve → 测试超时）。同步方法无真实异步 IO，彻底规避该竞态。
vi.mock('fs/promises', async () => {
  const { default: fs } = await import('node:fs')
  const SYNC_MAP: Record<string, string> = {
    mkdir: 'mkdirSync',
    writeFile: 'writeFileSync',
    readFile: 'readFileSync',
    unlink: 'unlinkSync',
    access: 'accessSync',
    stat: 'statSync',
    rename: 'renameSync',
    rm: 'rmSync',
  }
  const wrap =
    (name: string) =>
    (...args: unknown[]) => {
      state.fsCalls.push({ fn: name, args })
      try {
        const syncName = SYNC_MAP[name]
        if (!syncName) throw new Error(`测试夹具缺少 fs 同步方法映射：${name}`)
        const syncFn = (fs as unknown as Record<string, (...a: unknown[]) => unknown>)[syncName]
        if (!syncFn) throw new Error(`测试夹具缺少 fs 同步方法：${syncName}`)
        // 同步执行（无真实异步 IO），再包成 Promise：纯微任务，fake timers 一定能等到
        return Promise.resolve(syncFn(...args))
      } catch (e) {
        return Promise.reject(e)
      }
    }
  const out: Record<string, unknown> = {}
  for (const n of Object.keys(SYNC_MAP)) {
    out[n] = wrap(n)
  }
  out.default = out
  return out
})

import { TTSService, TTSRateLimitedError } from '../../src/main/core/ttsService'

const VOICE = 'zh-CN-XiaoxiaoNeural'
const MP3_HISTORY = { '9': [{ filename: 'clip.mp3', subfolder: 'q', type: 'output' }] }

const expectedSeed = (v: string) => nodeCrypto.createHash('md5').update(v).digest().readUInt32BE(0)

interface StubOpts {
  hasNode?: boolean
  workflows?: string[]
  /** 每次轮询返回一项；耗尽后重复最后一项；null 表示 history 缺失 */
  historyQueue?: Array<Record<string, unknown> | null>
  uploadName?: string
}

function makeStubs(o: StubOpts = {}) {
  const calls = {
    hasNode: [] as string[],
    uploads: [] as string[],
    builds: [] as Array<{ name: string; vars: Record<string, unknown> }>,
    submits: 0,
    historyN: 0,
    downloads: [] as Array<{ f: string; s: string; t: string; abs: string }>,
  }
  const comfyui = {
    hasNode: async (n: string) => {
      calls.hasNode.push(n)
      return o.hasNode ?? true
    },
    uploadAudio: async (p: string) => {
      calls.uploads.push(p)
      return o.uploadName ?? `up_${nodePath.basename(p)}`
    },
    submit: async () => {
      calls.submits++
      return { promptId: 'pid-1' }
    },
    getHistory: async () => {
      const i = Math.min(calls.historyN, (o.historyQueue?.length ?? 1) - 1)
      calls.historyN++
      if (o.historyQueue) return o.historyQueue[i]
      return MP3_HISTORY
    },
    download: async (f: string, s: string, t: string, abs: string) => {
      calls.downloads.push({ f, s, t, abs })
    },
  } as unknown as ComfyUIClient
  const workflow = {
    list: async () => (o.workflows ?? ['tts_clone', 'tts_plain']).map((name) => ({ name })),
    buildGraph: async (name: string, vars: Record<string, unknown>) => {
      calls.builds.push({ name, vars })
      return { __graph: name } as never
    },
  } as unknown as WorkflowLoader
  return { comfyui, workflow, calls }
}

let baseDir = ''
beforeEach(() => {
  baseDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'tts-spec-'))
  state.ttsInstances.length = 0
  state.toStreamN = 0
  state.toStreamBehavior = null
  state.setMetadataBehavior = null
  state.cpmCalls.length = 0
  state.cpmExecFileBehavior = null
  state.fsCalls.length = 0
})

afterEach(() => {
  vi.useRealTimers()
  nodeFs.rmSync(baseDir, { recursive: true, force: true })
})

/**
 * 小步循环推进 fake 时钟：真实异步 fs 已被上方的同步 fs mock 消除，这里仅作双保险，
 * 避免单个 tickAsync 窗口内连续触发多轮 timer + 微任务链的偶发时序问题。
 */
async function fastForward(ms: number): Promise<void> {
  while (ms > 0) {
    const step = Math.min(ms, 1500)
    await vi.advanceTimersByTimeAsync(step)
    ms -= step
  }
}

describe('TTSRateLimitedError', () => {
  it('是 Error 子类且保留消息', () => {
    const e = new TTSRateLimitedError('限流')
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(TTSRateLimitedError)
    expect(e.message).toBe('限流')
  })
})

describe('getCacheKey', () => {
  it('无 rate：md5(text|voice|+0%)，32 位 hex', () => {
    const { comfyui, workflow } = makeStubs()
    const svc = new TTSService(baseDir, comfyui, workflow)
    const key = svc.getCacheKey('台词', VOICE)
    expect(key).toBe(nodeCrypto.createHash('md5').update(`台词|${VOICE}|+0%`).digest('hex'))
    expect(key).toMatch(/^[0-9a-f]{32}$/)
  })

  it('有 rate 改变键；空串 rate 回退 +0% 与不传一致', () => {
    const { comfyui, workflow } = makeStubs()
    const svc = new TTSService(baseDir, comfyui, workflow)
    expect(svc.getCacheKey('台词', VOICE, '+20%')).not.toBe(svc.getCacheKey('台词', VOICE))
    expect(svc.getCacheKey('台词', VOICE, '')).toBe(svc.getCacheKey('台词', VOICE))
  })
})

describe('synthesize 入参校验', () => {
  it('空白文本直接抛错，不创建 MsEdgeTTS', async () => {
    const svc = new TTSService(baseDir)
    await expect(
      svc.synthesize({ text: '   ', voice: VOICE, outputPath: nodePath.join(baseDir, 'a.mp3') }),
    ).rejects.toThrow('TTS text is empty')
    expect(state.ttsInstances).toHaveLength(0)
  })
})

describe('synthesize ① Edge TTS 成功路径', () => {
  it('首次成功：默认 rate/volume +0%，落盘拼接后的 buffer，finally close', async () => {
    const svc = new TTSService(baseDir)
    const out = nodePath.join(baseDir, 'sub', 'line.mp3')
    await svc.synthesize({ text: '你好', voice: VOICE, outputPath: out })
    const inst = state.ttsInstances[0]
    if (!inst) throw new Error('测试夹具缺少 state.ttsInstances[0]')
    expect(inst.setMetadataCalls).toEqual([{ voice: VOICE, format: 'audio-24khz-48kbitrate-mono-mp3' }])
    expect(inst.toStreamCalls[0]?.opts).toEqual({ rate: '+0%', volume: '+0%' })
    expect(inst.closed).toBe(1)
    expect(nodeFs.readFileSync(out).toString()).toBe('FAKE-AUDIO')
  })

  it('显式 rate/volume 透传 toStream；多 chunk 拼接', async () => {
    state.toStreamBehavior = () => ({
      audioStream: (async function* () {
        yield Buffer.from('AB')
        yield Buffer.from('CD')
      })(),
    })
    const svc = new TTSService(baseDir)
    const out = nodePath.join(baseDir, 'line.mp3')
    await svc.synthesize({ text: 'x', voice: VOICE, outputPath: out, rate: '+10%', volume: '-5%' })
    expect(state.ttsInstances[0]?.toStreamCalls[0]?.opts).toEqual({ rate: '+10%', volume: '-5%' })
    expect(nodeFs.readFileSync(out).toString()).toBe('ABCD')
  })

  it('generate 包装：返回相对路径，写入 baseDir 下绝对路径', async () => {
    const svc = new TTSService(baseDir)
    const rel = nodePath.join('voices', 'e1.mp3')
    const got = await svc.generate('台词', VOICE, rel)
    expect(got).toBe(rel)
    const write = state.fsCalls.find((c) => c.fn === 'writeFile')
    expect(write?.args[0]).toBe(nodePath.join(baseDir, rel))
  })
})

describe('synthesize ① 重试退避', () => {
  it('空音频流：抛 no audio，2.5s 短退避后第三次成功', async () => {
    state.toStreamBehavior = (_t, _o, n) => {
      if (n <= 2) return { audioStream: (async function* () {})() }
      return {
        audioStream: (async function* () {
          yield Buffer.from('OK')
        })(),
      }
    }
    vi.useFakeTimers()
    const svc = new TTSService(baseDir)
    const p = svc.synthesize({ text: 'x', voice: VOICE, outputPath: nodePath.join(baseDir, 'a.mp3') })
    await fastForward(5000)
    await expect(p).resolves.toBeUndefined()
    expect(state.toStreamN).toBe(3)
    expect(state.ttsInstances.every((i) => i.closed === 1)).toBe(true)
    expect(nodeFs.readFileSync(nodePath.join(baseDir, 'a.mp3')).toString()).toBe('OK')
  })

  it('403 风控：15s 长退避（2.5s 不足以触发第二次尝试），第二次成功', async () => {
    state.toStreamBehavior = (_t, _o, n) => {
      if (n <= 1) throw new Error('Request failed with status code 403')
      return {
        audioStream: (async function* () {
          yield Buffer.from('OK')
        })(),
      }
    }
    vi.useFakeTimers()
    const svc = new TTSService(baseDir)
    const p = svc.synthesize({ text: 'x', voice: VOICE, outputPath: nodePath.join(baseDir, 'a.mp3') })
    await vi.advanceTimersByTimeAsync(2500)
    expect(state.toStreamN).toBe(1)
    await vi.advanceTimersByTimeAsync(12500)
    await expect(p).resolves.toBeUndefined()
    expect(state.toStreamN).toBe(2)
  })

  it('普通错误 2.5s×2 退避共 3 次尝试后转降级链（Qwen 未注入 → SAPI 成功）', async () => {
    state.toStreamBehavior = () => {
      throw new Error('socket hang up')
    }
    const out = nodePath.join(baseDir, 'a.mp3')
    const wav = out.replace(/\.mp3$/i, '.wav')
    state.cpmExecFileBehavior = async (bin) => {
      if (bin === 'powershell') nodeFs.writeFileSync(wav, Buffer.alloc(2000))
      else nodeFs.writeFileSync(out, 'MP3-DATA')
      return { stdout: '', stderr: '' }
    }
    vi.useFakeTimers()
    const svc = new TTSService(baseDir)
    const p = svc.synthesize({ text: 'x', voice: VOICE, outputPath: out })
    await vi.advanceTimersByTimeAsync(5000)
    await expect(p).resolves.toBeUndefined()
    expect(state.toStreamN).toBe(3)
    expect(nodeFs.readFileSync(out).toString()).toBe('MP3-DATA')
    expect(nodeFs.existsSync(wav)).toBe(false)
    const sapi = state.cpmCalls.find((c) => c.bin === 'powershell')
    expect(sapi?.opts).toMatchObject({ timeout: 60_000, label: 'tts-sapi', windowsHide: true })
    const ff = state.cpmCalls.find((c) => c.bin !== 'powershell')
    expect(ff?.args).toEqual(['-y', '-i', wav, '-codec:a', 'libmp3lame', '-q:a', '4', out])
  })

  it('Edge 抛非 Error 字符串：String 分支日志，后续 SAPI 成功', async () => {
    state.toStreamBehavior = () => {
      throw 'oops'
    }
    const out = nodePath.join(baseDir, 'b.mp3')
    const wav = out.replace(/\.mp3$/i, '.wav')
    state.cpmExecFileBehavior = async (bin) => {
      if (bin === 'powershell') nodeFs.writeFileSync(wav, Buffer.alloc(2000))
      else nodeFs.writeFileSync(out, 'M')
      return { stdout: '', stderr: '' }
    }
    vi.useFakeTimers()
    const { comfyui, workflow } = makeStubs({ hasNode: true })
    ;(comfyui as unknown as { hasNode: (n: string) => Promise<boolean> }).hasNode = () => Promise.reject('no-node')
    const svc = new TTSService(baseDir, comfyui, workflow)
    const p = svc.synthesize({ text: 'x', voice: VOICE, outputPath: out })
    await vi.advanceTimersByTimeAsync(5000)
    await expect(p).resolves.toBeUndefined()
    expect(state.toStreamN).toBe(3)
    expect(nodeFs.existsSync(out)).toBe(true)
  })
})

describe('enforceRateLimit', () => {
  it('同一实例 5s 内第二次调用先等待间隔', async () => {
    vi.useFakeTimers()
    const svc = new TTSService(baseDir)
    const opts = { text: 'x', voice: VOICE, outputPath: nodePath.join(baseDir, 'a.mp3') }
    await svc.synthesize(opts)
    expect(state.toStreamN).toBe(1)
    const p = svc.synthesize(opts)
    await vi.advanceTimersByTimeAsync(4999)
    expect(state.toStreamN).toBe(1)
    await vi.advanceTimersByTimeAsync(2)
    await expect(p).resolves.toBeUndefined()
    expect(state.toStreamN).toBe(2)
  })
})

describe('synthesize ② Qwen3 克隆降级层', () => {
  const edgeFails403 = () => {
    state.toStreamBehavior = () => {
      throw new Error('403 Forbidden')
    }
  }

  it('Edge 全挂 → 样本缺失先 SAPI 造参考音 → 克隆轮询产出 mp3 → download 落盘', async () => {
    edgeFails403()
    const sampleWav = nodePath.join(baseDir, 'tts_ref', 'zh-CN-XiaoxiaoNeural.wav')
    state.cpmExecFileBehavior = async (bin) => {
      if (bin === 'powershell') nodeFs.writeFileSync(sampleWav, Buffer.alloc(2000))
      return { stdout: '', stderr: '' }
    }
    vi.useFakeTimers()
    const { comfyui, workflow, calls } = makeStubs()
    const svc = new TTSService(baseDir, comfyui, workflow)
    const out = nodePath.join(baseDir, 'a.mp3')
    const p = svc.synthesize({ text: '台词', voice: VOICE, outputPath: out })
    await fastForward(30000 + 1500)
    await expect(p).resolves.toBeUndefined()
    expect(state.toStreamN).toBe(3)
    expect(calls.uploads).toEqual([sampleWav])
    const build0 = calls.builds[0]
    if (!build0) throw new Error('测试夹具缺少 calls.builds[0]')
    expect(build0.name).toBe('tts_clone')
    expect(build0.vars).toEqual({
      PROMPT: '台词',
      REF_AUDIO: 'up_zh-CN-XiaoxiaoNeural.wav',
      REF_TEXT: '',
      SEED: expectedSeed(VOICE),
      X_VECTOR: true,
    })
    const download0 = calls.downloads[0]
    if (!download0) throw new Error('测试夹具缺少 calls.downloads[0]')
    expect(download0).toEqual({ f: 'clip.mp3', s: 'q', t: 'output', abs: out })
    expect(nodeFs.existsSync(sampleWav)).toBe(true)
  })

  it('参考样本已缓存：不再调 powershell 合成样本', async () => {
    edgeFails403()
    const refDir = nodePath.join(baseDir, 'tts_ref')
    nodeFs.mkdirSync(refDir, { recursive: true })
    nodeFs.writeFileSync(nodePath.join(refDir, 'zh-CN-XiaoxiaoNeural.wav'), Buffer.alloc(2000))
    vi.useFakeTimers()
    const { comfyui, workflow } = makeStubs()
    const svc = new TTSService(baseDir, comfyui, workflow)
    const p = svc.synthesize({ text: 'x', voice: VOICE, outputPath: nodePath.join(baseDir, 'a.mp3') })
    await vi.advanceTimersByTimeAsync(15000)
    await vi.advanceTimersByTimeAsync(15000)
    await vi.advanceTimersByTimeAsync(1500)
    await expect(p).resolves.toBeUndefined()
    expect(state.cpmCalls.filter((c) => c.bin === 'powershell')).toHaveLength(0)
  })

  it('shouldAbort 命中：克隆取消后继续降级 SAPI 成功', async () => {
    state.toStreamBehavior = () => {
      throw new Error('boom')
    }
    const refDir = nodePath.join(baseDir, 'tts_ref')
    nodeFs.mkdirSync(refDir, { recursive: true })
    nodeFs.writeFileSync(nodePath.join(refDir, 'zh-CN-XiaoxiaoNeural.wav'), Buffer.alloc(2000))
    const out = nodePath.join(baseDir, 'a.mp3')
    const wav = out.replace(/\.mp3$/i, '.wav')
    state.cpmExecFileBehavior = async (bin) => {
      if (bin === 'powershell') nodeFs.writeFileSync(wav, Buffer.alloc(2000))
      else nodeFs.writeFileSync(out, 'M')
      return { stdout: '', stderr: '' }
    }
    vi.useFakeTimers()
    const { comfyui, workflow, calls } = makeStubs()
    const svc = new TTSService(baseDir, comfyui, workflow)
    const p = svc.synthesize({ text: 'x', voice: VOICE, outputPath: out, shouldAbort: () => true })
    await vi.advanceTimersByTimeAsync(5000)
    await expect(p).resolves.toBeUndefined()
    expect(calls.submits).toBe(1)
    expect(calls.historyN).toBe(0)
    expect(nodeFs.existsSync(out)).toBe(true)
  })

  it('克隆 600s 超时（history 恒空）→ 降级 SAPI 成功', async () => {
    edgeFails403()
    const refDir = nodePath.join(baseDir, 'tts_ref')
    nodeFs.mkdirSync(refDir, { recursive: true })
    nodeFs.writeFileSync(nodePath.join(refDir, 'zh-CN-XiaoxiaoNeural.wav'), Buffer.alloc(2000))
    const out = nodePath.join(baseDir, 'a.mp3')
    const wav = out.replace(/\.mp3$/i, '.wav')
    state.cpmExecFileBehavior = async (bin) => {
      if (bin === 'powershell') nodeFs.writeFileSync(wav, Buffer.alloc(2000))
      else nodeFs.writeFileSync(out, 'M')
      return { stdout: '', stderr: '' }
    }
    vi.useFakeTimers()
    const { comfyui, workflow, calls } = makeStubs({ historyQueue: [null] })
    const svc = new TTSService(baseDir, comfyui, workflow)
    const p = svc.synthesize({ text: 'x', voice: VOICE, outputPath: out })
    await fastForward(30000 + 601_000)
    await expect(p).resolves.toBeUndefined()
    expect(calls.historyN).toBeGreaterThanOrEqual(400)
    expect(nodeFs.existsSync(out)).toBe(true)
  })

  it('首轮产物非 mp3 被跳过，次轮 mp3 缺 subfolder/type 时补默认值', async () => {
    edgeFails403()
    const refDir = nodePath.join(baseDir, 'tts_ref')
    nodeFs.mkdirSync(refDir, { recursive: true })
    nodeFs.writeFileSync(nodePath.join(refDir, 'zh-CN-XiaoxiaoNeural.wav'), Buffer.alloc(2000))
    vi.useFakeTimers()
    const { comfyui, workflow, calls } = makeStubs({
      historyQueue: [{ '1': [{ filename: 'a.wav' }] }, { '1': [{ filename: 'b.MP3' }] }],
    })
    const svc = new TTSService(baseDir, comfyui, workflow)
    const p = svc.synthesize({ text: 'x', voice: VOICE, outputPath: nodePath.join(baseDir, 'a.mp3') })
    await fastForward(30000 + 3000)
    await expect(p).resolves.toBeUndefined()
    expect(calls.downloads[0]).toEqual({ f: 'b.MP3', s: '', t: 'output', abs: nodePath.join(baseDir, 'a.mp3') })
  })

  it('克隆层缺节点：hasNode false 直接抛错转 SAPI', async () => {
    edgeFails403()
    const out = nodePath.join(baseDir, 'a.mp3')
    const wav = out.replace(/\.mp3$/i, '.wav')
    state.cpmExecFileBehavior = async (bin) => {
      if (bin === 'powershell') nodeFs.writeFileSync(wav, Buffer.alloc(2000))
      else nodeFs.writeFileSync(out, 'M')
      return { stdout: '', stderr: '' }
    }
    vi.useFakeTimers()
    const { comfyui, workflow, calls } = makeStubs({ hasNode: false })
    const svc = new TTSService(baseDir, comfyui, workflow)
    const p = svc.synthesize({ text: 'x', voice: VOICE, outputPath: out })
    await vi.advanceTimersByTimeAsync(30000)
    await expect(p).resolves.toBeUndefined()
    expect(calls.submits).toBe(0)
  })
})

describe('synthesize ④ 全链失败', () => {
  const edgeFails403 = () => {
    state.toStreamBehavior = () => {
      throw new Error('403 rate limited')
    }
  }

  it('Edge 403×3 + Qwen 未注入 + SAPI 进程失败 → TTSRateLimitedError', async () => {
    edgeFails403()
    state.cpmExecFileBehavior = async () => {
      throw new Error('powershell exited 1')
    }
    vi.useFakeTimers()
    const svc = new TTSService(baseDir)
    const p = svc.synthesize({ text: 'x', voice: VOICE, outputPath: nodePath.join(baseDir, 'a.mp3') })
    void p.catch(() => {}) // 同步 fs 下 p 在 advance 期间即 reject，先附 handler 避免 unhandled rejection
    await vi.advanceTimersByTimeAsync(30000)
    await expect(p).rejects.toBeInstanceOf(TTSRateLimitedError)
    await expect(p).rejects.toThrow(/TTS 全部通道失败.*SAPI 合成失败/s)
  })

  it('SAPI 产物缺失（stat null）→ 未产出有效音频', async () => {
    edgeFails403()
    state.cpmExecFileBehavior = async () => ({ stdout: '', stderr: '' })
    vi.useFakeTimers()
    const svc = new TTSService(baseDir)
    const p = svc.synthesize({ text: 'x', voice: VOICE, outputPath: nodePath.join(baseDir, 'a.mp3') })
    void p.catch(() => {})
    await vi.advanceTimersByTimeAsync(30000)
    await expect(p).rejects.toThrow('SAPI 未产出有效音频')
  })

  it('SAPI 产物过小（<1000B）→ 未产出有效音频', async () => {
    edgeFails403()
    const wav = nodePath.join(baseDir, 'a.wav')
    state.cpmExecFileBehavior = async (bin) => {
      if (bin === 'powershell') nodeFs.writeFileSync(wav, Buffer.alloc(10))
      return { stdout: '', stderr: '' }
    }
    vi.useFakeTimers()
    const svc = new TTSService(baseDir)
    const p = svc.synthesize({ text: 'x', voice: VOICE, outputPath: nodePath.join(baseDir, 'a.mp3') })
    void p.catch(() => {})
    await vi.advanceTimersByTimeAsync(30000)
    await expect(p).rejects.toThrow('SAPI 未产出有效音频')
  })

  it('wav→mp3 转换失败：错误信息带前缀并透传', async () => {
    edgeFails403()
    const out = nodePath.join(baseDir, 'a.mp3')
    const wav = out.replace(/\.mp3$/i, '.wav')
    state.cpmExecFileBehavior = async (bin) => {
      if (bin === 'powershell') nodeFs.writeFileSync(wav, Buffer.alloc(2000))
      else throw new Error('ffmpeg exit -1')
      return { stdout: '', stderr: '' }
    }
    vi.useFakeTimers()
    const svc = new TTSService(baseDir)
    const p = svc.synthesize({ text: 'x', voice: VOICE, outputPath: out })
    void p.catch(() => {})
    await vi.advanceTimersByTimeAsync(30000)
    await expect(p).rejects.toThrow(/wav→mp3 转换失败/)
  })
})

describe('generateClone', () => {
  const rel = nodePath.join('clone', 'v1.mp3')

  it('未注入 ComfyUI/工作流 → 抛不可用', async () => {
    const svc = new TTSService(baseDir)
    await expect(svc.generateClone('x', nodePath.join(baseDir, 'ref.wav'), rel)).rejects.toThrow(
      'TTS 克隆不可用：未注入 ComfyUI/工作流服务',
    )
  })

  it('空文本 → TTS text is empty', async () => {
    const { comfyui, workflow } = makeStubs()
    const svc = new TTSService(baseDir, comfyui, workflow)
    await expect(svc.generateClone('  ', 'ref.wav', rel)).rejects.toThrow('TTS text is empty')
  })

  it('缺节点 → 无法克隆', async () => {
    const { comfyui, workflow } = makeStubs({ hasNode: false })
    const svc = new TTSService(baseDir, comfyui, workflow)
    await expect(svc.generateClone('x', 'ref.wav', rel)).rejects.toThrow('未安装 FB_Qwen3TTSVoiceClone 节点，无法克隆')
  })

  it('缺 tts_clone 工作流 → 抛错', async () => {
    const { comfyui, workflow } = makeStubs({ workflows: ['tts_plain'] })
    const svc = new TTSService(baseDir, comfyui, workflow)
    await expect(svc.generateClone('x', 'ref.wav', rel)).rejects.toThrow('工作流 tts_clone 不存在，无法克隆')
  })

  it('指定 seed/refText：ICL 模式（X_VECTOR=false），轮询产出后下载到 baseDir 相对路径', async () => {
    vi.useFakeTimers()
    const { comfyui, workflow, calls } = makeStubs()
    const svc = new TTSService(baseDir, comfyui, workflow)
    const refAbs = nodePath.join(baseDir, 'ref.wav')
    const p = svc.generateClone('台词', refAbs, rel, { seed: 7, refText: '参考转录' })
    await vi.advanceTimersByTimeAsync(1500)
    await expect(p).resolves.toBe(rel)
    expect(calls.uploads).toEqual([refAbs])
    const build0 = calls.builds[0]
    if (!build0) throw new Error('测试夹具缺少 calls.builds[0]')
    expect(build0.vars).toEqual({
      PROMPT: '台词',
      REF_AUDIO: 'up_ref.wav',
      REF_TEXT: '参考转录',
      SEED: 7,
      X_VECTOR: false,
    })
    const download0 = calls.downloads[0]
    if (!download0) throw new Error('测试夹具缺少 calls.downloads[0]')
    expect(download0).toEqual({ f: 'clip.mp3', s: 'q', t: 'output', abs: nodePath.join(baseDir, rel) })
  })

  it('不传 opts：随机 seed + x-vector 模式', async () => {
    vi.useFakeTimers()
    const { comfyui, workflow, calls } = makeStubs()
    const svc = new TTSService(baseDir, comfyui, workflow)
    const p = svc.generateClone('台词', 'ref.wav', rel)
    await vi.advanceTimersByTimeAsync(1500)
    await expect(p).resolves.toBe(rel)
    const build = calls.builds[0]
    if (!build) throw new Error('测试夹具缺少 calls.builds[0]')
    const vars = build.vars
    expect(vars.REF_TEXT).toBe('')
    expect(vars.X_VECTOR).toBe(true)
    expect(typeof vars.SEED).toBe('number')
    expect(vars.SEED as number).toBeGreaterThanOrEqual(0)
    expect(vars.SEED as number).toBeLessThanOrEqual(0xffffffff)
  })

  it('shouldAbort → 克隆已取消（提交前轮询即抛）', async () => {
    const { comfyui, workflow, calls } = makeStubs()
    const svc = new TTSService(baseDir, comfyui, workflow)
    await expect(svc.generateClone('x', 'ref.wav', rel, { shouldAbort: () => true })).rejects.toThrow('TTS 克隆已取消')
    expect(calls.submits).toBe(1)
    expect(calls.historyN).toBe(0)
  })

  it('timeoutMs 内无产物 → TTS 克隆超时', async () => {
    vi.useFakeTimers()
    const { comfyui, workflow, calls } = makeStubs({ historyQueue: [null] })
    const svc = new TTSService(baseDir, comfyui, workflow)
    const p = svc.generateClone('x', 'ref.wav', rel, { timeoutMs: 100, seed: 1 })
    void p.catch(() => {})
    await vi.advanceTimersByTimeAsync(1600)
    await expect(p).rejects.toThrow(/TTS 克隆超时/)
    expect(calls.historyN).toBe(1)
  })
})

describe('generateLocal（已废弃私有方法，经强转补覆盖）', () => {
  type LocalFn = (t: string, v: string, o: string) => Promise<void>
  const asLocal = (svc: TTSService) => (svc as unknown as { generateLocal: LocalFn }).generateLocal.bind(svc)

  it('成功链路：tts_plain 构图 + 轮询下载 + 目录兜底 mkdir', async () => {
    vi.useFakeTimers()
    const { comfyui, workflow, calls } = makeStubs()
    const svc = new TTSService(baseDir, comfyui, workflow)
    const outAbs = nodePath.join(baseDir, 'local', 'x.mp3')
    const p = asLocal(svc)('你好', VOICE, outAbs)
    await vi.advanceTimersByTimeAsync(1500)
    await expect(p).resolves.toBeUndefined()
    const build0 = calls.builds[0]
    if (!build0) throw new Error('测试夹具缺少 calls.builds[0]')
    expect(build0.name).toBe('tts_plain')
    expect(build0.vars).toEqual({ PROMPT: '你好', SEED: expectedSeed(VOICE) })
    const download0 = calls.downloads[0]
    if (!download0) throw new Error('测试夹具缺少 calls.downloads[0]')
    expect(download0.abs).toBe(outAbs)
    expect(state.fsCalls.some((c) => c.fn === 'mkdir' && c.args[0] === nodePath.dirname(outAbs))).toBe(true)
  })

  it('未注入服务 → 兜底不可用', async () => {
    const svc = new TTSService(baseDir)
    await expect(asLocal(svc)('x', VOICE, 'o.mp3')).rejects.toThrow('本机 TTS 兜底不可用：未注入 ComfyUI/工作流服务')
  })

  it('空文本 / 缺节点 / 缺工作流分别抛错', async () => {
    const s1 = makeStubs()
    await expect(asLocal(new TTSService(baseDir, s1.comfyui, s1.workflow))('  ', VOICE, 'o.mp3')).rejects.toThrow(
      'TTS text is empty',
    )
    const s2 = makeStubs({ hasNode: false })
    await expect(asLocal(new TTSService(baseDir, s2.comfyui, s2.workflow))('x', VOICE, 'o.mp3')).rejects.toThrow(
      '未安装 FB_Qwen3TTSVoiceClone 节点，无法本地合成',
    )
    const s3 = makeStubs({ workflows: ['tts_clone'] })
    await expect(asLocal(new TTSService(baseDir, s3.comfyui, s3.workflow))('x', VOICE, 'o.mp3')).rejects.toThrow(
      '工作流 tts_plain 不存在，无法本地合成',
    )
  })
})
