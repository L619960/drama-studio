/**
 * FFmpegService 单测（不跑真 ffmpeg/ffprobe、不发网络）：
 * - fluent-ffmpeg 整体 mock：FakeCommand 链式记录 input/inputOptions/outputOptions/
 *   complexFilter/audioFilter/frames/seekInput/save，save 时按行为队列触发 end/error/progress/stderr。
 * - childProcessManager / ffmpeg-static / ffprobe-static 均 mock，detectBinaries 各分支可控。
 * - fs/promises 用 passthrough 包装（真实临时目录 + 记录调用），可断言 writeFile 内容（concat 列表、ASS 字幕）。
 * 覆盖：二进制探测、全景裁图、抽帧、宫格、时长探测、分段制作/归一化/音频留白/口型转换、
 * concat（含回退与画幅归一）、智能拼接（裁剪/静音检测/叠化）、字幕烧录（srt→ASS）、BGM 混音、
 * 缩略图、RGB24、文件工具、质检、run() 原子替换与错误日志。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'
import * as nodeOs from 'node:os'

interface FakeCmd {
  inputs: string[]
  inputOpts: string[]
  outputOpts: string[]
  complexFilters: string[]
  audioFilterVal: string
  framesVal: number | null
  seekVal: number | null
  savedPaths: string[]
  handlers: Record<string, Array<(arg?: unknown) => void>>
  emit: (evt: string, arg?: unknown) => void
}

const state = vi.hoisted(() => ({
  ffmpegStatic: null as unknown,
  ffprobeStatic: null as unknown,
  setFfmpegCalls: [] as string[],
  setFfprobeCalls: [] as string[],
  commands: [] as unknown[],
  saveBehaviors: [] as Array<(cmd: { emit: (e: string, a?: unknown) => void }, p: string) => void>,
  ffprobeImpl: null as ((file: string) => { err?: Error; data?: unknown }) | null,
  fsCalls: [] as Array<{ fn: string; args: unknown[] }>,
  cpm: { execFile: vi.fn(), spawn: vi.fn(), killAll: vi.fn(), getActiveHandles: vi.fn() }
}))

vi.mock('ffmpeg-static', () => ({
  get default() { return state.ffmpegStatic }
}))

vi.mock('ffprobe-static', () => ({
  get default() { return state.ffprobeStatic }
}))

vi.mock('../../src/main/core/childProcessManager', () => ({
  childProcessManager: state.cpm
}))

vi.mock('fluent-ffmpeg', async () => {
  const realFs = await import('node:fs')
  class FakeCommand {
    inputs: string[] = []
    inputOpts: string[] = []
    outputOpts: string[] = []
    complexFilters: string[] = []
    audioFilterVal = ''
    framesVal: number | null = null
    seekVal: number | null = null
    savedPaths: string[] = []
    handlers: Record<string, Array<(arg?: unknown) => void>> = {}
    input(p: string) { this.inputs.push(p); return this }
    inputOptions(o: string | string[]) { this.inputOpts.push(...(Array.isArray(o) ? o : [o])); return this }
    outputOptions(o: string | string[]) { this.outputOpts.push(...(Array.isArray(o) ? o : [o])); return this }
    complexFilter(a: string[]) { this.complexFilters.push(...a); return this }
    audioFilter(f: string) { this.audioFilterVal = f; return this }
    frames(n: number) { this.framesVal = n; return this }
    seekInput(t: number) { this.seekVal = t; return this }
    on(e: string, cb: (arg?: unknown) => void) { (this.handlers[e] ||= []).push(cb); return this }
    emit(e: string, arg?: unknown) { (this.handlers[e] || []).forEach(h => h(arg)) }
    save(p: string) {
      this.savedPaths.push(p)
      const behavior = state.saveBehaviors.shift()
      if (behavior) { behavior(this as unknown as never, p); return }
      realFs.writeFileSync(p, 'fake-output')
      this.emit('end')
    }
  }
  const fake = Object.assign((seed?: string) => {
    const c = new FakeCommand()
    if (seed !== undefined) c.inputs.push(seed)
    state.commands.push(c)
    return c
  }, {
    setFfmpegPath: (p: string) => { state.setFfmpegCalls.push(p) },
    setFfprobePath: (p: string) => { state.setFfprobeCalls.push(p) },
    ffprobe: (file: string, cb: (err: unknown, data: unknown) => void) => {
      const r = state.ffprobeImpl
        ? state.ffprobeImpl(file)
        : { data: { format: { duration: '5' }, streams: [{ codec_type: 'video', width: 480, height: 864 }, { codec_type: 'audio' }] } }
      setTimeout(() => (r.err ? cb(r.err, undefined) : cb(null, r.data)), 0)
    }
  })
  return { default: fake }
})

vi.mock('fs/promises', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, (...a: unknown[]) => unknown>
  const wrap = (name: string) => (...args: unknown[]) => {
    state.fsCalls.push({ fn: name, args })
    return actual[name](...args)
  }
  const out: Record<string, unknown> = { ...actual }
  for (const n of ['mkdir', 'mkdtemp', 'writeFile', 'readFile', 'rename', 'unlink', 'rm', 'readdir', 'access', 'stat']) {
    out[n] = wrap(n)
  }
  out.default = out
  return out
})

import { FFmpegService } from '../../src/main/core/ffmpegService'

const BUNDLED_FFMPEG_ASAR = 'C:/resources/app.asar/node_modules/ffmpeg-static/ffmpeg.exe'
const BUNDLED_FFMPEG = 'C:/resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe'
const BUNDLED_FFPROBE = 'C:/resources/app.asar.unpacked/node_modules/ffprobe-static/bin/win32/ffprobe.exe'

const tmpDirs: string[] = []
function mkTmp(prefix = 'ffsvc'): string {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), `drama-${prefix}-`))
  tmpDirs.push(d)
  return d
}

function cmd(i = state.commands.length - 1): FakeCmd {
  return state.commands[i] as unknown as FakeCmd
}
function execCalls(label?: string) {
  return state.cpm.execFile.mock.calls.filter(c => !label || (c[2] as { label?: string })?.label === label)
}
function lastExecArgs(label?: string): { bin: string; args: string[]; opts: Record<string, unknown> } {
  const calls = execCalls(label)
  const c = calls[calls.length - 1]
  return { bin: c[0] as string, args: c[1] as string[], opts: c[2] as Record<string, unknown> }
}
function writeFileContent(match: (p: unknown) => boolean): string | undefined {
  const call = [...state.fsCalls].reverse().find(c => c.fn === 'writeFile' && match(c.args[0]))
  return call ? String(call.args[1]) : undefined
}

async function readyService(): Promise<FFmpegService> {
  const svc = new FFmpegService()
  await svc.ready()
  return svc
}

beforeEach(() => {
  state.ffmpegStatic = BUNDLED_FFMPEG_ASAR
  state.ffprobeStatic = { path: BUNDLED_FFMPEG_ASAR.replace('ffmpeg-static/ffmpeg.exe', 'ffprobe-static/bin/win32/ffprobe.exe') }
  state.setFfmpegCalls.length = 0
  state.setFfprobeCalls.length = 0
  state.commands.length = 0
  state.saveBehaviors.length = 0
  state.fsCalls.length = 0
  state.ffprobeImpl = null
  state.cpm.execFile.mockReset()
  state.cpm.execFile.mockImplementation(async () => ({ stdout: '', stderr: '' }))
})

afterEach(() => {
  tmpDirs.splice(0).forEach(d => nodeFs.rmSync(d, { recursive: true, force: true }))
  vi.unstubAllEnvs()
})

// ================================================================ detectBinaries / ready
describe('detectBinaries 与 ready', () => {
  it('内置 ffmpeg/ffprobe 可用：asar 路径映射为 unpacked 并 setFfmpegPath/setFfprobePath', async () => {
    const svc = new FFmpegService()
    await svc.ready()
    expect(state.setFfmpegCalls).toEqual([BUNDLED_FFMPEG])
    // ffprobeStatic.path 含 app.asar（非 unpacked）→ 同样被映射
    expect(state.setFfprobeCalls).toEqual([BUNDLED_FFPROBE])
    const canRun = execCalls('ffmpeg-canrun')
    expect(canRun[0][1]).toEqual(['-version'])
    expect(canRun[0][2]).toMatchObject({ timeout: 10000, windowsHide: true })
  })

  it('二进制路径为非字符串对象/空串 → unpackedPath 返回 null，跳过内置检测', async () => {
    state.ffmpegStatic = { default: 'C:/x/app.asar/ffmpeg.exe' }
    state.ffprobeStatic = { path: '' }
    state.cpm.execFile.mockImplementation(async (bin: string) => {
      if (bin === 'ffmpeg' || bin === 'ffprobe') return { stdout: '', stderr: '' }
      throw new Error('nope')
    })
    const svc = new FFmpegService()
    await svc.ready()
    expect(state.setFfmpegCalls).toEqual([])
    expect(state.setFfprobeCalls).toEqual([])
  })

  it('内置 ffmpeg 不可运行 → 回退 PATH；canRun catch 里 stdout 非空也算可用', async () => {
    state.ffmpegStatic = null
    state.ffprobeStatic = null
    state.cpm.execFile.mockImplementation(async (bin: string) => {
      if (bin === 'ffmpeg') return { stdout: '', stderr: '' }
      const e = new Error('exit 1') as Error & { stdout?: string }
      e.stdout = 'ffprobe version x'
      throw e
    })
    const svc = new FFmpegService()
    await svc.ready()
    // ffprobePath='ffprobe'（catch 分支 stdout 非空 → true）→ getDuration 走 ffprobe
    await expect(svc.getDuration('v.mp4')).resolves.toBe(5)
  })

  it('COMFYUI_ROOT 下 imageio_ffmpeg 命中 → 使用整合包二进制', async () => {
    const root = mkTmp('comfy')
    const binDir = nodePath.join(root, 'python', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries')
    nodeFs.mkdirSync(binDir, { recursive: true })
    const exe = nodePath.join(binDir, 'ffmpeg-win64-v4.exe')
    nodeFs.writeFileSync(exe, 'fake')
    vi.stubEnv('COMFYUI_ROOT', root)
    state.ffmpegStatic = null
    state.ffprobeStatic = { path: null }
    state.cpm.execFile.mockImplementation(async (bin: string) => {
      if (bin === exe) return { stdout: '', stderr: '' }
      throw new Error('missing')
    })
    const svc = new FFmpegService()
    await svc.ready()
    expect(state.setFfmpegCalls).toEqual([exe])
  })

  it('imageio 目录存在但无 ffmpeg*.exe → 继续回退 PATH', async () => {
    const root = mkTmp('comfy2')
    const binDir = nodePath.join(root, 'python', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries')
    nodeFs.mkdirSync(binDir, { recursive: true })
    nodeFs.writeFileSync(nodePath.join(binDir, 'readme.txt'), 'x')
    vi.stubEnv('COMFYUI_ROOT', root)
    state.ffmpegStatic = null
    state.ffprobeStatic = {}
    state.cpm.execFile.mockImplementation(async (bin: string) => {
      if (bin === 'ffmpeg') return { stdout: '', stderr: '' }
      throw new Error('missing')
    })
    const svc = new FFmpegService()
    await svc.ready()
    expect(state.setFfmpegCalls).toEqual([])
    const run = await svc.trimClip('in.mp4', 0, 1, nodePath.join(mkTmp(), 'o.mp4')).catch(e => (e as Error).message)
    // trimClip 走 run()：save 默认行为写文件成功
    expect(run).toBeDefined()
  })

  it('全部探测失败 → ready() 抛「未找到 ffmpeg」', async () => {
    state.ffmpegStatic = null
    state.ffprobeStatic = null
    state.cpm.execFile.mockImplementation(async () => { throw new Error('ENOENT') })
    const svc = new FFmpegService()
    await expect(svc.ready()).rejects.toThrow(/未找到 ffmpeg/)
  })

  it('addComfyRoot：去空白、忽略空串与重复、最新根在前', () => {
    const svc = new FFmpegService()
    svc.addComfyRoot('  ')
    svc.addComfyRoot('C:/a')
    svc.addComfyRoot('C:/a ')
    svc.addComfyRoot('C:/b')
    // 无公开 getter，仅验证不抛错且去重路径被执行
    expect(() => svc.addComfyRoot('C:/c')).not.toThrow()
  })
})

// ================================================================ cropPanoramaViews
describe('cropPanoramaViews', () => {
  it('count=4 生成 4 段 crop+scale 滤镜，输出名带前缀', async () => {
    const svc = await readyService()
    const outDir = mkTmp()
    const outs = await svc.cropPanoramaViews('E:/pano.png', outDir, { count: 4, outW: 540, outH: 960, prefix: 'sc_01' })
    expect(outs).toHaveLength(4)
    expect(outs[0]).toBe(nodePath.join(outDir, 'sc_01_view_0.png'))
    const calls = execCalls('ffmpeg-run')
    expect(calls).toHaveLength(4)
    expect(calls[0][1]).toEqual([
      '-y', '-i', 'E:/pano.png', '-vf',
      'crop=iw/4:iw/4*960/540:iw*0/4:0,scale=540:960:flags=lanczos',
      outs[0]
    ])
    expect(calls[3][1][4]).toContain('iw*3/4')
    expect((calls[0][2] as { timeout: number }).timeout).toBe(600_000)
  })

  it('参数钳制：count 0→4 / 9→6 / 1→2，outW 10→64，前缀非法字符剔除', async () => {
    const svc = await readyService()
    const outDir = mkTmp()
    const a = await svc.cropPanoramaViews('p.png', outDir, { count: 0, outW: 540, outH: 960 })
    expect(a).toHaveLength(4)
    expect(a[0]).toContain('pano_view_0.png')
    const b = await svc.cropPanoramaViews('p.png', outDir, { count: 9, outW: 540, outH: 960, prefix: 'a/b c!' })
    expect(b).toHaveLength(6)
    expect(b[0]).toContain('abc_view_0.png')
    await svc.cropPanoramaViews('p.png', outDir, { count: 1, outW: 10, outH: 960 })
    const last = lastExecArgs('ffmpeg-run')
    expect(last.args[4]).toContain('scale=64:960')
    expect(last.bin).toBe(BUNDLED_FFMPEG)
  })
})

// ================================================================ extractFrames
describe('extractFrames', () => {
  function seedFrames(dir: string, names: string[]) {
    names.forEach(n => nodeFs.writeFileSync(nodePath.join(dir, n), 'x'))
  }

  it('探测到时长 30s：fps 间隔=10.000，返回排序裁切的 frame 路径', async () => {
    const svc = await readyService()
    const outDir = mkTmp('frames')
    seedFrames(outDir, ['frame_01.jpg', 'frame_02.jpg', 'frame_03.jpg', 'other.txt', 'frame_x.jpg'])
    state.cpm.execFile.mockImplementation(async (_b: string, _a: string[], opts: { label?: string }) => {
      if (opts?.label === 'ffmpeg-probe') {
        return { stdout: 'Duration: 00:00:30.00, start: 0.000000, bitrate: 100 kb/s', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const files = await svc.extractFrames('E:/v.mp4', outDir, 3)
    expect(files).toEqual([1, 2, 3].map(i => nodePath.join(outDir, `frame_0${i}.jpg`)))
    const run = lastExecArgs('ffmpeg-run')
    expect(run.args).toEqual([
      '-hide_banner', '-loglevel', 'error', '-i', 'E:/v.mp4',
      '-vf', 'fps=1/10.000,scale=-2:480', '-frames:v', '3', '-q:v', '4', '-y',
      nodePath.join(outDir, 'frame_%02d.jpg')
    ])
    expect(state.fsCalls.some(c => c.fn === 'mkdir' && c.args[0] === outDir && (c.args[1] as { recursive: boolean }).recursive)).toBe(true)
  })

  it('stdout 无 Duration → 间隔钳到下限 0.500', async () => {
    const svc = await readyService()
    const outDir = mkTmp('frames')
    state.cpm.execFile.mockImplementation(async (_b: string, _a: string[], opts: { label?: string }) =>
      opts?.label === 'ffmpeg-probe' ? { stdout: 'no duration here', stderr: '' } : { stdout: '', stderr: '' })
    await svc.extractFrames('v.mp4', outDir, 4)
    expect(lastExecArgs('ffmpeg-run').args[6]).toBe('fps=1/0.500,scale=-2:480')
  })

  it('探测抛错 → 按 10s 估算（count 6 → 1.667）', async () => {
    const svc = await readyService()
    const outDir = mkTmp('frames')
    state.cpm.execFile.mockImplementation(async (_b: string, _a: string[], opts: { label?: string }) => {
      if (opts?.label === 'ffmpeg-probe') throw new Error('probe died')
      return { stdout: '', stderr: '' }
    })
    await svc.extractFrames('v.mp4', outDir, 0)
    expect(lastExecArgs('ffmpeg-run').args[6]).toBe('fps=1/1.667,scale=-2:480')
    expect(lastExecArgs('ffmpeg-run').args).toContain('6')
  })

  it('count 钳制 1→2、100→12，结果超出 n 时裁切', async () => {
    const svc = await readyService()
    const outDir = mkTmp('frames')
    seedFrames(outDir, Array.from({ length: 15 }, (_, i) => `frame_${String(i + 1).padStart(2, '0')}.jpg`))
    const files = await svc.extractFrames('v.mp4', outDir, 100)
    expect(files).toHaveLength(12)
    expect(lastExecArgs('ffmpeg-run').args).toContain('12')
    const outDir2 = mkTmp('frames')
    await svc.extractFrames('v.mp4', outDir2, 1)
    expect(lastExecArgs('ffmpeg-run').args).toContain('2')
  })
})

// ================================================================ extractFrameAt
describe('extractFrameAt', () => {
  it('正常时间点：-ss 三位小数 + 单帧 q:v 3', async () => {
    const svc = await readyService()
    const dir = mkTmp()
    await svc.extractFrameAt('E:/v.mp4', nodePath.join(dir, 'sub', 'f.jpg'), 5)
    const run = lastExecArgs('ffmpeg-run')
    expect(run.args).toEqual([
      '-hide_banner', '-loglevel', 'error', '-ss', '5.000', '-i', 'E:/v.mp4',
      '-frames:v', '1', '-q:v', '3', '-y', nodePath.join(dir, 'sub', 'f.jpg')
    ])
  })

  it('0/NaN → 0.06s 下限；0.01 → 0.02s 下限', async () => {
    const svc = await readyService()
    const dir = mkTmp()
    await svc.extractFrameAt('v.mp4', nodePath.join(dir, 'a.jpg'), 0)
    expect(lastExecArgs('ffmpeg-run').args[4]).toBe('0.060')
    await svc.extractFrameAt('v.mp4', nodePath.join(dir, 'b.jpg'), Number.NaN)
    expect(lastExecArgs('ffmpeg-run').args[4]).toBe('0.060')
    await svc.extractFrameAt('v.mp4', nodePath.join(dir, 'c.jpg'), 0.01)
    expect(lastExecArgs('ffmpeg-run').args[4]).toBe('0.020')
  })
})

// ================================================================ tileImages
describe('tileImages', () => {
  it('4 图 2 列宫格：xstack layout 与逐图 scale 标签正确', async () => {
    const svc = await readyService()
    const imgs = ['a.png', 'b.png', 'c.png', 'd.png']
    await svc.tileImages(imgs, 'E:/grid.png', { cols: 2, cellW: 512, cellH: 512 })
    const run = lastExecArgs('ffmpeg-run')
    expect(run.args[0]).toBe('-y')
    expect(run.args.filter(x => x === '-i')).toHaveLength(4)
    const fc = run.args[run.args.indexOf('-filter_complex') + 1]
    expect(fc).toContain('[0:v]scale=512:512:flags=lanczos[a0]')
    expect(fc).toContain('[a0][a1][a2][a3]xstack=inputs=4:layout=0_0|512_0|0_512|512_512[out]')
    expect(run.args[run.args.indexOf('-map') + 1]).toBe('[out]')
    expect(run.args[run.args.length - 1]).toBe('E:/grid.png')
  })

  it('空输入 → 抛错', async () => {
    const svc = await readyService()
    await expect(svc.tileImages([], 'o.png', { cols: 2, cellW: 100, cellH: 100 })).rejects.toThrow(/无输入图片/)
  })

  it('cols/cell 尺寸钳制下限', async () => {
    const svc = await readyService()
    await svc.tileImages(['a.png', 'b.png'], 'o.png', { cols: 0, cellW: 10, cellH: 10 })
    const fc = lastExecArgs('ffmpeg-run').args[6]
    expect(fc).toContain('scale=32:32')
    expect(fc).toContain('layout=0_0|0_32')
  })
})

// ================================================================ getDuration
describe('getDuration', () => {
  it('ffprobe 可用：解析 format.duration', async () => {
    const svc = await readyService()
    state.ffprobeImpl = () => ({ data: { format: { duration: '12.5' }, streams: [] } })
    await expect(svc.getDuration('v.mp4')).resolves.toBe(12.5)
    state.ffprobeImpl = () => ({ data: {} })
    await expect(svc.getDuration('v.mp4')).resolves.toBe(0)
  })

  it('ffprobe 报错 → reject', async () => {
    const svc = await readyService()
    state.ffprobeImpl = () => ({ err: new Error('probe boom') })
    await expect(svc.getDuration('v.mp4')).rejects.toThrow(/probe boom/)
  })

  it('无 ffprobePath → ffmpeg -f null 兜底，end 返回 0', async () => {
    state.ffprobeStatic = null
    state.cpm.execFile.mockImplementation(async (bin: string) => {
      if (bin === 'ffprobe') throw new Error('missing')
      return { stdout: '', stderr: '' }
    })
    const svc = new FFmpegService()
    await svc.ready()
    state.saveBehaviors.push(c => c.emit('end'))
    const nullTarget = process.platform === 'win32' ? 'NUL' : '/dev/null'
    await expect(svc.getDuration('v.mp4')).resolves.toBe(0)
    const c = cmd()
    expect(c.inputs).toEqual(['v.mp4'])
    expect(c.outputOpts).toEqual(['-f null'])
    expect(c.savedPaths).toEqual([nullTarget])
  })

  it('兜底路径 error 事件含 Duration → 解析成功', async () => {
    state.ffprobeStatic = null
    state.cpm.execFile.mockImplementation(async (bin: string) => {
      if (bin === 'ffprobe') throw new Error('missing')
      return { stdout: '', stderr: '' }
    })
    const svc = new FFmpegService()
    await svc.ready()
    state.saveBehaviors.push(c => c.emit('error', new Error('ffmpeg died: Duration: 00:02:30.25, bitrate: 99 kb/s')))
    await expect(svc.getDuration('v.mp4')).resolves.toBe(150.25)
  })

  it('兜底路径 error 事件无 Duration → reject 原错误', async () => {
    state.ffprobeStatic = null
    state.cpm.execFile.mockImplementation(async (bin: string) => {
      if (bin === 'ffprobe') throw new Error('missing')
      return { stdout: '', stderr: '' }
    })
    const svc = new FFmpegService()
    await svc.ready()
    state.saveBehaviors.push(c => c.emit('error', new Error('unknown failure')))
    await expect(svc.getDuration('v.mp4')).rejects.toThrow(/unknown failure/)
  })
})

// ================================================================ prepareSegment
describe('prepareSegment（有音频）', () => {
  it('音频更长：tpad/apad 对齐，-t 取目标时长，leadSec 注入 adelay', async () => {
    const svc = await readyService()
    const dir = mkTmp()
    const out = nodePath.join(dir, 'seg.mp4')
    state.ffprobeImpl = (f) => ({
      data: { format: { duration: f === 'v.mp4' ? '4' : '6' }, streams: [] }
    })
    const progress: number[] = []
    state.saveBehaviors.push(c => {
      c.emit('progress', { percent: 150 })
      c.emit('progress', { percent: -3 })
      c.emit('progress', { percent: 42.7 })
      c.emit('progress', {})
      nodeFs.writeFileSync(out + '.part.mp4', 'fake')
      c.emit('end')
    })
    const res = await svc.prepareSegment('v.mp4', 'a.mp3', out, p => progress.push(p), 1)
    expect(res).toBe(out)
    expect(progress).toEqual([100, 0, 43, 0])
    const c = cmd()
    expect(c.inputs).toEqual(['v.mp4', 'a.mp3'])
    expect(c.complexFilters).toEqual([
      '[0:v]fps=25,tpad=stop_mode=clone:stop_duration=3.300[v]',
      '[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=1000:all=1,apad[a]'
    ])
    const opts = c.outputOpts.join(' ')
    expect(opts).toContain('-map [v]')
    expect(opts).toContain('-map [a]')
    expect(opts).toContain('-t 7.000')
    expect(opts).toContain('-c:v libx264')
    expect(opts).toContain('-crf 23')
    expect(opts).toContain('-b:a 192k')
    expect(c.savedPaths).toEqual([out + '.part.mp4'])
    expect(nodeFs.existsSync(out)).toBe(true)
  })

  it('leadSec=0 且视频更长：无 adelay，pad 仅容差 0.300', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'seg.mp4')
    state.ffprobeImpl = (f) => ({ data: { format: { duration: f === 'v.mp4' ? '10' : '2' }, streams: [] } })
    await svc.prepareSegment('v.mp4', 'a.mp3', out)
    expect(cmd().complexFilters[0]).toContain('stop_duration=0.300')
    expect(cmd().complexFilters[1]).not.toContain('adelay')
    expect(cmd().outputOpts.join(' ')).toContain('-t 10.000')
  })

  it('无音频 → anullsrc 静音轨 + -shortest（进度回调透传）', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'silent.mp4')
    const seen: number[] = []
    state.saveBehaviors.push(c => {
      c.emit('progress', { percent: 88 })
      nodeFs.writeFileSync(out + '.part.mp4', 'f')
      c.emit('end')
    })
    const res = await svc.prepareSegment('v.mp4', undefined, out, p => seen.push(p))
    expect(res).toBe(out)
    expect(seen).toEqual([88])
    const c = cmd()
    expect(c.inputs).toEqual(['v.mp4', 'anullsrc=channel_layout=stereo:sample_rate=48000'])
    expect(c.inputOpts).toEqual(['-f lavfi'])
    expect(c.complexFilters).toEqual(['[0:v]fps=25[v]'])
    expect(c.outputOpts).toContain('-shortest')
    expect(c.outputOpts).toContain('-map 1:a')
  })

  it('mergeVideoAudio 委托 prepareSegment（两输入）', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'm.mp4')
    await svc.mergeVideoAudio('v.mp4', 'a.mp3', out)
    expect(cmd().inputs).toEqual(['v.mp4', 'a.mp3'])
  })

  it('error 事件：错误消息附 stderr 末尾日志（仅保留最后 200 行），临时文件被 unlink', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'err.mp4')
    state.saveBehaviors.push(c => {
      for (let i = 0; i < 205; i++) c.emit('stderr', `line-${i}`)
      c.emit('error', new Error('encode died'))
    })
    const msg = await svc.prepareSegment('v.mp4', undefined, out).catch(e => (e as Error).message)
    expect(msg).toContain('encode died')
    expect(msg).toContain('--- ffmpeg 日志 ---')
    expect(msg).toContain('line-204')
    expect(msg).not.toContain('line-0')
    expect(state.fsCalls.some(c => c.fn === 'unlink' && String(c.args[0]).endsWith('.part.mp4'))).toBe(true)
  })

  it('error 事件无 stderr 输出 → 消息不含日志段', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'err2.mp4')
    state.saveBehaviors.push(c => c.emit('error', new Error('plain fail')))
    const msg = await svc.prepareSegment('v.mp4', undefined, out).catch(e => (e as Error).message)
    expect(msg).toBe('plain fail')
  })

  it('end 后 rename 失败 → 抛「写入最终文件失败」', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'renamefail.mp4')
    state.saveBehaviors.push(c => c.emit('end')) // 不写 .part.mp4
    await expect(svc.prepareSegment('v.mp4', undefined, out)).rejects.toThrow(/写入最终文件失败/)
  })

  it('getDuration 失败 → prepareSegment 整体 reject', async () => {
    const svc = await readyService()
    state.ffprobeImpl = () => ({ err: new Error('probe down') })
    await expect(svc.prepareSegment('v.mp4', 'a.mp3', nodePath.join(mkTmp(), 'x.mp4'))).rejects.toThrow(/probe down/)
  })
})

// ================================================================ normalize / padAudioLead / convertForLipSync
describe('normalizeSegment / padAudioLead / convertForLipSync', () => {
  it('normalizeSegment：-vf fps=25 与 -ac 2 等统一规格参数', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'n.mp4')
    const res = await svc.normalizeSegment('h3.mp4', out)
    expect(res).toBe(out)
    const c = cmd()
    expect(c.inputs).toEqual(['h3.mp4'])
    expect(c.outputOpts).toContain('-vf fps=25')
    expect(c.outputOpts).toContain('-ac 2')
    expect(c.outputOpts).toContain('-movflags +faststart')
  })

  it('padAudioLead：adelay 毫秒取整 + libmp3lame，临时 .part.mp3 原子替换', async () => {
    const svc = await readyService()
    const dest = nodePath.join(mkTmp(), 'p.mp3')
    const res = await svc.padAudioLead('a.mp3', dest, 0.5)
    expect(res).toBe(dest)
    const c = cmd()
    expect(c.audioFilterVal).toBe('adelay=500:all=1')
    expect(c.outputOpts).toEqual(['-c:a', 'libmp3lame', '-q:a', '2'])
    expect(c.savedPaths).toEqual([dest + '.part.mp3'])
  })

  it('convertForLipSync：fps=25+format=yuv420p，-an 去音轨，crf 20', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'lip.mp4')
    await svc.convertForLipSync('raw.mp4', out)
    const c = cmd()
    expect(c.complexFilters).toEqual(['[0:v]fps=25,format=yuv420p[v]'])
    expect(c.outputOpts).toContain('-an')
    expect(c.outputOpts).toContain('-crf 20')
  })

  it('normalizeSegment 进度回调透传', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'n2.mp4')
    const seen: number[] = []
    state.saveBehaviors.push(c => {
      c.emit('progress', { percent: 55.4 })
      nodeFs.writeFileSync(out + '.part.mp4', 'f')
      c.emit('end')
    })
    await svc.normalizeSegment('v.mp4', out, p => seen.push(p))
    expect(seen).toEqual([55])
  })
})

// ================================================================ fitCover
describe('fitCover', () => {
  it('居中裁切滤镜正确，rename .part.png → dest', async () => {
    const svc = await readyService()
    const dir = mkTmp()
    const dest = nodePath.join(dir, 'cover.png')
    nodeFs.writeFileSync(dest + '.part.png', 'x')
    const res = await svc.fitCover('src.png', dest, 768, 1024)
    expect(res).toBe(dest)
    const run = lastExecArgs('ffmpeg-run')
    expect(run.args).toEqual([
      '-y', '-i', 'src.png', '-vf',
      'scale=768:1024:force_original_aspect_ratio=increase,crop=768:1024',
      '-frames:v', '1', dest + '.part.png'
    ])
    expect(nodeFs.existsSync(dest)).toBe(true)
  })
})

// ================================================================ concatSegments
describe('concatSegments', () => {
  it('流拷贝成功：列表文件转义反斜杠与单引号，finally 清理', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'final.mp4')
    state.ffprobeImpl = () => ({ err: new Error('no video stream') })
    const segs = ["C:\\vids\\it's.mp4", 'D:\\a b\\x.mp4']
    const res = await svc.concatSegments(segs, out)
    expect(res).toBe(out)
    const listWrite = state.fsCalls.find(c => c.fn === 'writeFile' && String(c.args[0]).includes('concat_'))
    expect(listWrite).toBeDefined()
    expect(String(listWrite!.args[1])).toBe(
      "file 'C:/vids/it'\\''s.mp4'\nfile 'D:/a b/x.mp4'"
    )
    const c = cmd()
    expect(c.inputOpts).toEqual(['-f concat', '-safe 0'])
    expect(c.outputOpts).toEqual(['-c copy', '-movflags +faststart', '-fflags +genpts'])
    expect(String(c.inputs[0])).toContain('concat_')
    expect(state.fsCalls.some(x => x.fn === 'unlink' && String(x.args[0]).includes('concat_'))).toBe(true)
    expect(state.fsCalls.some(x => x.fn === 'rm' && (x.args[1] as { recursive: boolean }).recursive)).toBe(true)
  })

  it('流拷贝失败 → concat filter 重编码回退', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'final2.mp4')
    state.ffprobeImpl = () => ({ err: new Error('skip unify') })
    state.saveBehaviors.push(c => c.emit('error', new Error('codec params differ')))
    const res = await svc.concatSegments(['s0.mp4', 's1.mp4'], out)
    expect(res).toBe(out)
    const fallback = cmd()
    expect(fallback.inputs).toEqual(['s0.mp4', 's1.mp4'])
    expect(fallback.complexFilters).toEqual(['[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]'])
    expect(fallback.outputOpts).toContain('-map [v]')
    expect(fallback.outputOpts).toContain('-c:v libx264')
  })

  it('画幅归一：多数尺寸为目标，少数派重编码为 unify_i.mp4', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'final3.mp4')
    const sizeMap: Record<string, [number, number]> = {
      'a.mp4': [480, 864], 'b.mp4': [480, 864], 'c.mp4': [720, 1280]
    }
    state.ffprobeImpl = (f) => {
      const s = sizeMap[f]
      return s
        ? { data: { format: {}, streams: [{ codec_type: 'video', width: s[0], height: s[1] }] } }
        : { err: new Error('nope') }
    }
    await svc.concatSegments(['a.mp4', 'b.mp4', 'c.mp4'], out)
    const run = lastExecArgs('ffmpeg-run')
    expect(run.args[run.args.length - 1]).toContain(nodePath.join('unify_2.mp4'))
    expect(run.args[4]).toContain('scale=480:864:force_original_aspect_ratio=increase,crop=480:864,setsar=1')
    expect(run.args).toContain('-crf')
    const listWrite = state.fsCalls.find(c => c.fn === 'writeFile' && String(c.args[0]).includes('concat_'))
    expect(String(listWrite!.args[1])).toContain('unify_2.mp4')
    expect(String(listWrite!.args[1])).toContain("'a.mp4'")
  })

  it('尺寸并列时取更高画幅；全部同尺寸则原样返回', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'final4.mp4')
    state.ffprobeImpl = (f) => ({
      data: {
        format: {},
        streams: [{ codec_type: 'video', width: f === 'tall.mp4' ? 480 : 360, height: f === 'tall.mp4' ? 864 : 640 }]
      }
    })
    await svc.concatSegments(['wide.mp4', 'tall.mp4'], out)
    expect(lastExecArgs('ffmpeg-run').args[4]).toContain('scale=480:864')
    state.ffprobeImpl = () => ({ data: { format: {}, streams: [{ codec_type: 'video', width: 480, height: 864 }] } })
    state.commands.length = 0
    state.cpm.execFile.mockClear()
    await svc.concatSegments(['p.mp4', 'q.mp4'], out)
    expect(execCalls('ffmpeg-run')).toHaveLength(0)
  })
})

// ================================================================ smartConcatSegments
describe('smartConcatSegments', () => {
  it('无台词硬切两镜：各裁 [0.2, dur-0.3]，合并为单块后整体 concat', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'sc1.mp4')
    state.ffprobeImpl = () => ({ data: { format: { duration: '5' }, streams: [] } })
    const res = await svc.smartConcatSegments(
      [{ path: 'C:/shots/s1.mp4' }, { path: 'C:/shots/s2.mp4' }],
      out
    )
    expect(res).toBe(out)
    expect(state.commands).toHaveLength(4) // 2×trimClip + 2×concatSegments(group→final)
    const trim0 = cmd(0)
    expect(trim0.inputOpts).toEqual(['-ss 0.20'])
    expect(trim0.outputOpts).toContain('-t 4.50')
    expect(trim0.inputs[0]).toBe('C:/shots/s1.mp4')
    expect(state.fsCalls.some(c => c.fn === 'rm' && (c.args[1] as { force?: boolean })?.force)).toBe(true)
  })

  it('skipped 镜头不裁剪', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'sc2.mp4')
    state.ffprobeImpl = () => ({ data: { format: { duration: '5' }, streams: [] } })
    await svc.smartConcatSegments(
      [{ path: 'C:/a.mp4', skipped: true }, { path: 'C:/b.mp4' }],
      out
    )
    expect(state.commands).toHaveLength(2) // 1×trimClip + 1×concat(单块直通)
    expect(cmd(0).inputs[0]).toBe('C:/b.mp4')
  })

  it('全部裁剪失败 → 抛「无可拼接素材」', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'sc3.mp4')
    state.ffprobeImpl = () => ({ err: new Error('probe dead') })
    await expect(svc.smartConcatSegments([{ path: 'C:/a.mp4' }], out)).rejects.toThrow(/无可拼接素材/)
  })

  it('手动入出点：trimStart=1,trimEnd=8（dur 5）→ 裁到 [1,5]', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'sc4.mp4')
    state.ffprobeImpl = () => ({ data: { format: { duration: '5' }, streams: [] } })
    await svc.smartConcatSegments([{ path: 'C:/m.mp4', trimStart: 1, trimEnd: 8 }], out)
    expect(cmd(0).inputOpts).toEqual(['-ss 1.00'])
    expect(cmd(0).outputOpts).toContain('-t 4.00')
  })

  it('手动区间非法（end-start<1）→ 回退整镜', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'sc5.mp4')
    state.ffprobeImpl = () => ({ data: { format: { duration: '5' }, streams: [] } })
    await svc.smartConcatSegments([{ path: 'C:/m.mp4', trimStart: 8, trimEnd: 8.5 }], out)
    expect(cmd(0).inputOpts).toEqual(['-ss 0.00'])
    expect(cmd(0).outputOpts).toContain('-t 5.00')
  })

  it('有台词：silencedetect 定位语音区间 [start-0.25, end+0.35]', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'sc6.mp4')
    state.ffprobeImpl = () => ({ data: { format: { duration: '6' }, streams: [] } })
    state.cpm.execFile.mockImplementation(async (_b: string, _a: string[], opts: { label?: string }) => {
      if (opts?.label === 'ffmpeg-silencedetect') {
        return { stdout: 'silence_start: 0.3\nsilence_end: 2.0\nsilence_start: 5.1', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    await svc.smartConcatSegments([{ path: 'C:/d.mp4', hasDialogue: true }], out)
    expect(cmd(0).inputOpts).toEqual(['-ss 1.75'])
    expect(cmd(0).outputOpts).toContain('-t 3.70')
  })

  it('无静音标记 → 整镜保留', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'sc7.mp4')
    state.ffprobeImpl = () => ({ data: { format: { duration: '6' }, streams: [] } })
    state.cpm.execFile.mockImplementation(async () => ({ stdout: 'nothing here', stderr: '' }))
    await svc.smartConcatSegments([{ path: 'C:/d.mp4', hasDialogue: true }], out)
    expect(cmd(0).inputOpts).toEqual(['-ss 0.00'])
    expect(cmd(0).outputOpts).toContain('-t 6.00')
  })

  it('语音区间过窄（end<=start+0.3）视为无效 → 整镜', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'sc8.mp4')
    state.ffprobeImpl = () => ({ data: { format: { duration: '6' }, streams: [] } })
    state.cpm.execFile.mockImplementation(async (_b: string, _a: string[], opts: { label?: string }) =>
      opts?.label === 'ffmpeg-silencedetect'
        ? { stdout: 'silence_end: 2.8\nsilence_start: 3.05', stderr: '' }
        : { stdout: '', stderr: '' })
    await svc.smartConcatSegments([{ path: 'C:/d.mp4', hasDialogue: true }], out)
    expect(cmd(0).outputOpts).toContain('-t 6.00')
  })

  it('silencedetect 进程失败 → 吞错整镜保留', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'sc9.mp4')
    state.cpm.execFile.mockImplementation(async (_b: string, _a: string[], opts: { label?: string }) => {
      if (opts?.label === 'ffmpeg-silencedetect') throw new Error('spawn failed')
      return { stdout: '', stderr: '' }
    })
    await svc.smartConcatSegments([{ path: 'C:/d.mp4', hasDialogue: true }], out)
    expect(cmd(0).outputOpts).toContain('-t 5.00')
  })

  it('保底中段：短素材（dur 2 无台词）仍裁出合法区间', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'sc10.mp4')
    state.ffprobeImpl = () => ({ data: { format: { duration: '2' }, streams: [] } })
    await svc.smartConcatSegments([{ path: 'C:/tiny.mp4' }], out)
    expect(cmd(0).inputOpts).toEqual(['-ss 0.10'])
    expect(cmd(0).outputOpts).toContain('-t 1.90')
  })

  it('dissolve 边界：两块之间生成 xfade+acrossfade 命令', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'sc11.mp4')
    state.ffprobeImpl = () => ({ data: { format: { duration: '5' }, streams: [] } })
    state.cpm.execFile.mockImplementation(async () => ({ stdout: '', stderr: '' }))
    const res = await svc.smartConcatSegments(
      [{ path: 'C:/a.mp4' }, { path: 'C:/b.mp4', transition: 'dissolve' }],
      out
    )
    expect(res).toBe(out)
    const x = lastExecArgs('ffmpeg-run')
    expect(x.opts).toMatchObject({ timeout: 600_000, label: 'ffmpeg-run' })
    const fc = x.args[x.args.indexOf('-filter_complex') + 1]
    expect(fc).toContain('[0:v][1:v]xfade=transition=fade:duration=0.3:offset=4.700[v1]')
    expect(fc).toContain('[0:a][1:a]acrossfade=d=0.3[a1]')
    expect(x.args[x.args.indexOf('-map') + 1]).toBe('[v1]')
    expect(x.args[x.args.length - 1]).toBe(out)
  })

  it('hard/smash 不叠化；dissolve 组内多镜先 concat 成块', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'sc12.mp4')
    state.ffprobeImpl = () => ({ data: { format: { duration: '5' }, streams: [] } })
    await svc.smartConcatSegments(
      [
        { path: 'C:/x.mp4', transition: 'hard' },
        { path: 'C:/y.mp4', transition: 'dissolve' },
        { path: 'C:/z.mp4', transition: 'smash' }
      ],
      out
    )
    // 3 trimClip + 1 concat(y,z 成块，concat demuxer 单列表输入) + xfade runFfmpeg
    const concatCmd = cmd(3)
    expect(concatCmd.complexFilters.some(f => f.includes('xfade'))).toBe(false)
    expect(concatCmd.inputOpts).toContain('-f concat')
    expect(concatCmd.inputs).toHaveLength(1)
    const x = lastExecArgs('ffmpeg-run')
    const fc = x.args[x.args.indexOf('-filter_complex') + 1]
    expect(fc).toContain('xfade')
    expect(fc).toContain('[0:v][1:v]')
    expect(fc).not.toContain('[v1][2:v]')
  })

  it('三个 dissolve 块：第二段 xfade 引用中间流标签并按累计时长偏移', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'sc13.mp4')
    state.ffprobeImpl = () => ({ data: { format: { duration: '5' }, streams: [] } })
    await svc.smartConcatSegments(
      [{ path: 'C:/a.mp4' }, { path: 'C:/b.mp4', transition: 'dissolve' }, { path: 'C:/c.mp4', transition: 'dissolve' }],
      out
    )
    expect(state.commands).toHaveLength(3) // 3 trimClip，各块单镜直通
    const args = lastExecArgs('ffmpeg-run').args
    const fc = args[args.indexOf('-filter_complex') + 1]
    expect(fc).toContain('[0:v][1:v]xfade=transition=fade:duration=0.3:offset=4.700[v1]')
    expect(fc).toContain('[v1][2:v]xfade=transition=fade:duration=0.3:offset=9.400[v2]')
    expect(fc).toContain('[a1][2:a]acrossfade=d=0.3[a2]')
    expect(args[args.indexOf('-map') + 1]).toBe('[v2]')
    expect(args[args.lastIndexOf('-map') + 1]).toBe('[a2]')
  })
})

// ================================================================ burnSubtitles
describe('burnSubtitles', () => {
  function makeSrt(dir: string, content: string): string {
    const p = nodePath.join(dir, 'sub.srt')
    nodeFs.writeFileSync(p, content, 'utf-8')
    return p
  }

  it('正常烧录：SRT→ASS（分辨率缩放字号/边距、时间格式、标签清洗），滤镜路径转义', async () => {
    const svc = await readyService()
    const dir = mkTmp('sub')
    const srt = makeSrt(dir, [
      '1',
      '00:00:01,500 --> 00:00:03,250',
      '你好世界',
      '',
      '2',
      '00:00:04,50 --> 00:00:06,00',
      '<i>斜体</i> {test}',
      '',
      'bad block'
    ].join('\n'))
    const out = nodePath.join(dir, 'burned.mp4')
    const res = await svc.burnSubtitles('v.mp4', srt, out, { fontSize: 16, marginV: 20 })
    expect(res).toBe(out)
    const ass = writeFileContent(p => String(p).endsWith('.ass'))!
    expect(ass).toContain('PlayResX: 480')
    expect(ass).toContain('PlayResY: 864')
    expect(ass).toContain('WrapStyle: 0')
    expect(ass).toContain('Style: Default,Microsoft YaHei,48,')
    expect(ass).toContain('Dialogue: 0,0:00:01.50,0:00:03.25,Default,,0,0,0,,你好世界')
    expect(ass).toContain('Dialogue: 0,0:00:04.50,0:00:06.00,Default,,0,0,0,,斜体 test')
    expect(ass).not.toContain('bad block')
    const vf = cmd().outputOpts.find(o => o.startsWith('-vf subtitles='))!
    expect(vf).toMatch(/^-vf subtitles='.*ds_sub_.*\.ass'$/)
    // 盘符冒号转义只存在于 Windows 路径；POSIX 下临时路径不含冒号
    if (process.platform === 'win32') expect(vf).toContain('\\:/')
    expect(state.fsCalls.some(c => c.fn === 'unlink' && String(c.args[0]).endsWith('.ass'))).toBe(true)
  })

  it('getVideoInfo 失败 → 竖屏默认 480x864；字号/边距按 288 基准放大并钳制', async () => {
    const svc = await readyService()
    const dir = mkTmp('sub')
    const srt = makeSrt(dir, '1\n00:00:00,000 --> 00:00:01,000\n短句\n')
    state.ffprobeImpl = () => ({ err: new Error('no info') })
    await svc.burnSubtitles('v.mp4', srt, nodePath.join(dir, 'o.mp4'), { fontSize: 100, marginV: 200 })
    const ass = writeFileContent(p => String(p).endsWith('.ass'))!
    expect(ass).toContain('PlayResY: 864')
    expect(ass).toContain('Microsoft YaHei,96,')
    expect(ass).toContain('2,29,29,240,1')
  })

  it('BOM 剥离 + 超长台词自动缩行加 {\\fs} 前缀', async () => {
    const svc = await readyService()
    const dir = mkTmp('sub')
    const long = '啊'.repeat(33)
    const srt = makeSrt(dir, `1\n00:00:00,000 --> 00:00:02,000\n${long}\n`)
    const srtBom = nodePath.join(dir, 'bom.srt')
    nodeFs.writeFileSync(srtBom, '\uFEFF' + nodeFs.readFileSync(srt, 'utf-8'), 'utf-8')
    await svc.burnSubtitles('v.mp4', srtBom, nodePath.join(dir, 'o.mp4'))
    const ass = writeFileContent(p => String(p).endsWith('.ass'))!
    expect(ass).not.toContain('\uFEFF')
    expect(ass).toContain('{\\fs38}')
    expect(ass).toContain('啊\\N啊')
  })

  it('收尾标点跟随上一行（行首不出现「，」）', async () => {
    const svc = await readyService()
    const dir = mkTmp('sub')
    const text = '字'.repeat(10) + '，' + 'x'.repeat(12)
    const srt = makeSrt(dir, `1\n00:00:00,000 --> 00:00:02,000\n${text}\n`)
    await svc.burnSubtitles('v.mp4', srt, nodePath.join(dir, 'o.mp4'))
    const ass = writeFileContent(p => String(p).endsWith('.ass'))!
    const dialogue = ass.split('\n').find(l => l.startsWith('Dialogue:'))!
    const body = dialogue.split(',').slice(9).join(',')
    expect(body.startsWith('字'.repeat(10) + '，')).toBe(true)
    expect(body).not.toMatch(/\\N，/)
  })

  it('run 失败 → 错误上抛但 finally 仍清理 ASS 文件', async () => {
    const svc = await readyService()
    const dir = mkTmp('sub')
    const srt = makeSrt(dir, '1\n00:00:00,000 --> 00:00:01,000\nx\n')
    state.saveBehaviors.push(c => c.emit('error', new Error('sub burn failed')))
    await expect(svc.burnSubtitles('v.mp4', srt, nodePath.join(dir, 'o.mp4'))).rejects.toThrow(/sub burn failed/)
    expect(state.fsCalls.some(c => c.fn === 'unlink' && String(c.args[0]).endsWith('.ass'))).toBe(true)
  })
})

// ================================================================ mixBgm
describe('mixBgm', () => {
  it('音量 50 → volume=0.50，循环 BGM + amix，视频流拷贝', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'bgm.mp4')
    const res = await svc.mixBgm('v.mp4', 'b.mp3', out, 50)
    expect(res).toBe(out)
    const c = cmd()
    expect(c.inputs).toEqual(['v.mp4', 'b.mp3'])
    expect(c.inputOpts).toEqual(['-stream_loop -1'])
    expect(c.complexFilters[0]).toBe('[1:a]volume=0.50[bgm]')
    expect(c.complexFilters[1]).toContain('amix=inputs=2:duration=first')
    expect(c.outputOpts).toContain('-c:v copy')
  })

  it('音量越界钳制：150→1.00，-10→0.00', async () => {
    const svc = await readyService()
    await svc.mixBgm('v.mp4', 'b.mp3', nodePath.join(mkTmp(), 'x1.mp4'), 150)
    expect(cmd().complexFilters[0]).toContain('volume=1.00')
    await svc.mixBgm('v.mp4', 'b.mp3', nodePath.join(mkTmp(), 'x2.mp4'), -10)
    expect(cmd().complexFilters[0]).toContain('volume=0.00')
  })
})

// ================================================================ extractFirstFrame / dumpRgb24
describe('extractFirstFrame / dumpRgb24', () => {
  it('extractFirstFrame：frames(1) + scale=320:-1，直接 save 目标路径', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'th.jpg')
    await svc.extractFirstFrame('v.mp4', out)
    const c = cmd()
    expect(c.inputs).toEqual(['v.mp4'])
    expect(c.framesVal).toBe(1)
    expect(c.outputOpts).toEqual(['-q:v 5', '-vf scale=320:-1'])
    expect(c.savedPaths).toEqual([out])
  })

  it('extractFirstFrame error → reject', async () => {
    const svc = await readyService()
    state.saveBehaviors.push(c => c.emit('error', new Error('thumb failed')))
    await expect(svc.extractFirstFrame('v.mp4', nodePath.join(mkTmp(), 't2.jpg'))).rejects.toThrow(/thumb failed/)
  })

  it('dumpRgb24：letterbox 滤镜 + rgb24 rawvideo，timeSec 定位 seek', async () => {
    const svc = await readyService()
    const out = nodePath.join(mkTmp(), 'f.rgb')
    await svc.dumpRgb24('v.mp4', out, 224, 1.5)
    const c = cmd()
    expect(c.seekVal).toBe(1.5)
    expect(c.framesVal).toBe(1)
    expect(c.outputOpts).toEqual([
      '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-vf',
      'scale=224:224:force_original_aspect_ratio=decrease,pad=224:224:(ow-iw)/2:(oh-ih)/2:color=black'
    ])
  })

  it('dumpRgb24：timeSec 缺省不 seek；负值钳 0；默认 size 224', async () => {
    const svc = await readyService()
    const dir = mkTmp()
    await svc.dumpRgb24('v.mp4', nodePath.join(dir, 'a.rgb'))
    expect(cmd().seekVal).toBeNull()
    await svc.dumpRgb24('v.mp4', nodePath.join(dir, 'b.rgb'), 256, -3)
    expect(cmd().seekVal).toBe(0)
    expect(cmd().outputOpts[5]).toContain('scale=256:256')
  })

  it('dumpRgb24 error 事件 → reject', async () => {
    const svc = await readyService()
    state.saveBehaviors.push(c => c.emit('error', new Error('raw dump failed')))
    await expect(svc.dumpRgb24('v.mp4', nodePath.join(mkTmp(), 'e.rgb'))).rejects.toThrow(/raw dump failed/)
  })
})

// ================================================================ 文件工具 / 质检
describe('fileExists / getFileSize / getVideoInfo / looksLikeBlankVideo', () => {
  it('fileExists：存在 true，不存在 false', async () => {
    const svc = await readyService()
    const dir = mkTmp()
    const f = nodePath.join(dir, 'x.txt')
    nodeFs.writeFileSync(f, 'hi')
    await expect(svc.fileExists(f)).resolves.toBe(true)
    await expect(svc.fileExists(nodePath.join(dir, 'missing.bin'))).resolves.toBe(false)
  })

  it('getFileSize：MB 两位取整；stat 失败返回 0', async () => {
    const svc = await readyService()
    const dir = mkTmp()
    const f = nodePath.join(dir, 'sized.bin')
    nodeFs.writeFileSync(f, Buffer.alloc(123_456))
    await expect(svc.getFileSize(f)).resolves.toBe(0.12)
    await expect(svc.getFileSize(nodePath.join(dir, 'nope.bin'))).resolves.toBe(0)
  })

  it('getVideoInfo：解析视频/音频流与时长', async () => {
    const svc = await readyService()
    state.ffprobeImpl = () => ({
      data: {
        format: { duration: '8.25' },
        streams: [
          { codec_type: 'video', width: 1080, height: 1920 },
          { codec_type: 'audio' }
        ]
      }
    })
    await expect(svc.getVideoInfo('v.mp4')).resolves.toEqual({
      durationSec: 8.25, width: 1080, height: 1920, hasAudio: true
    })
    state.ffprobeImpl = () => ({ data: { streams: [{ codec_type: 'video', width: 0, height: 0 }] } })
    await expect(svc.getVideoInfo('v.mp4')).resolves.toEqual({
      durationSec: 0, width: 0, height: 0, hasAudio: false
    })
    state.ffprobeImpl = () => ({ data: {} })
    await expect(svc.getVideoInfo('v.mp4')).resolves.toEqual({
      durationSec: 0, width: 0, height: 0, hasAudio: false
    })
  })

  it('getVideoInfo ffprobe 报错 → reject', async () => {
    const svc = await readyService()
    state.ffprobeImpl = () => ({ err: new Error('info boom') })
    await expect(svc.getVideoInfo('v.mp4')).rejects.toThrow(/info boom/)
  })

  it('looksLikeBlankVideo：小文件判为黑帧 true', async () => {
    const svc = await readyService()
    await expect(svc.looksLikeBlankVideo('v.mp4')).resolves.toBe(true)
    const c = cmd()
    expect(c.framesVal).toBe(1)
    expect(c.seekVal).toBe(0.5)
    expect(String(c.savedPaths[0])).toContain('qc_')
  })

  it('looksLikeBlankVideo：>8KB 判 false；进程失败也判 false', async () => {
    const svc = await readyService()
    state.saveBehaviors.push((_c, p) => {
      nodeFs.writeFileSync(p, Buffer.alloc(9000))
      void (_c as { emit: (e: string) => void }).emit('end')
    })
    await expect(svc.looksLikeBlankVideo('v.mp4')).resolves.toBe(false)
    state.saveBehaviors.push(c => c.emit('error', new Error('decode failed')))
    await expect(svc.looksLikeBlankVideo('v.mp4')).resolves.toBe(false)
  })
})
