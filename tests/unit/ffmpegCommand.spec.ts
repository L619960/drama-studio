/**
 * ffmpegService 命令拼接单测（不跑真 ffmpeg）：
 * fluent-ffmpeg 整体 mock，捕获 trimClip 生成的 input/inputOptions/outputOptions。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

const recorded = vi.hoisted(() => ({
  calls: [] as Array<{ input: string; inputOpts: string[]; outputOpts: string[]; saveTo: string }>
}))

vi.mock('fluent-ffmpeg', () => {
  class FakeCommand {
    private _input = ''
    private _inputOpts: string[] = []
    private _outputOpts: string[] = []
    private handlers: Record<string, Array<() => void>> = {}
    input(p: string) { this._input = p; return this }
    inputOptions(o: string[]) { this._inputOpts = o; return this }
    outputOptions(o: string[]) { this._outputOpts = o; return this }
    on(evt: string, cb: () => void) {
      (this.handlers[evt] ||= []).push(cb)
      return this
    }
    save(p: string) {
      recorded.calls.push({ input: this._input, inputOpts: this._inputOpts, outputOpts: this._outputOpts, saveTo: p })
      // run() 监听 end 后才 resolve；模拟 ffmpeg 进程结束
      setTimeout(() => { (this.handlers['end'] || []).forEach(h => h()) }, 0)
    }
  }
  // default 必须是可调用对象，且挂着 setFfmpegPath/setFfprobePath（detectBinaries 会调）
  const fakeFfmpeg = Object.assign(() => new FakeCommand(), {
    setFfmpegPath: () => undefined,
    setFfprobePath: () => undefined
  })
  return { default: fakeFfmpeg }
})

import { FFmpegService } from '../../src/main/core/ffmpegService'

describe('FFmpegService.trimClip 命令拼接', () => {
  beforeEach(() => {
    recorded.calls.length = 0
  })

  it('trimClip：-ss 入参 / -t 时长 / 编码参数 / faststart 齐全', async () => {
    const svc = new FFmpegService()
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-ffcmd-'))
    const out = path.join(tmpDir, 'clip.mp4')
    // run() 收尾 rename(tmpOut, finalOut)：先伪造 .part.mp4 让重命名成功
    await fs.writeFile(out + '.part.mp4', 'fake')

    await svc.trimClip('in.mp4', 1.5, 3.2, out)

    expect(recorded.calls).toHaveLength(1)
    const call = recorded.calls[0]
    expect(call.input).toBe('in.mp4')
    expect(call.inputOpts.join(' ')).toBe('-ss 1.50')
    const opts = call.outputOpts.join(' ')
    expect(opts).toContain('-t 3.20')
    expect(opts).toContain('-c:v libx264')
    expect(opts).toContain('-crf 20')
    expect(opts).toContain('-pix_fmt yuv420p')
    expect(opts).toContain('-c:a aac')
    expect(opts).toContain('-ar 48000')
    expect(opts).toContain('-movflags +faststart')
  })

  it('trimClip：startSec<0 钳到 0，durationSec<0.1 钳到 0.1', async () => {
    const svc = new FFmpegService()
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-ffcmd-'))
    const out = path.join(tmpDir, 'clip2.mp4')
    await fs.writeFile(out + '.part.mp4', 'fake')
    await svc.trimClip('in.mp4', -5, 0.01, out)
    const call = recorded.calls[0]
    expect(call.inputOpts.join(' ')).toBe('-ss 0.00')
    expect(call.outputOpts.join(' ')).toContain('-t 0.10')
  })
})
