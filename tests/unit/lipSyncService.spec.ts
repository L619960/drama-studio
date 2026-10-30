import { describe, it, expect, vi } from 'vitest'
import { LipSyncService } from '../../src/main/core/lipSyncService'

/**
 * LatentSync 口型同步单测（lipSyncService 首个 spec）：
 * 节点能力探测、路径反斜杠归一、进度透传、产物下载分支与异常兜底。
 */
function makeSvc(over: Record<string, unknown> = {}) {
  const comfyui = {
    hasNode: vi.fn(async () => true),
    submit: vi.fn(async () => ({ promptId: 'pid-1' })),
    waitForCompletion: vi.fn(async () => ({ videos: [] })),
    findVideoOutput: vi.fn(() => ({ filename: 'out.mp4', subfolder: 's', type: 'output' })),
    downloadFromFullPath: vi.fn(async () => undefined),
    download: vi.fn(async () => undefined),
    ...over
  }
  const workflow = { buildGraph: vi.fn(async () => ({ nodes: [] })) }
  return { svc: new LipSyncService(comfyui as never, workflow as never), comfyui, workflow }
}

describe('LipSyncService', () => {
  it('available 以 LatentSyncNode 节点是否存在为准', async () => {
    const { svc, comfyui } = makeSvc()
    await expect(svc.available()).resolves.toBe(true)
    expect(comfyui.hasNode).toHaveBeenCalledWith('LatentSyncNode')

    comfyui.hasNode.mockResolvedValueOnce(false)
    await expect(svc.available()).resolves.toBe(false)
  })

  it('buildGraph 收到正斜杠绝对路径与固定参数', async () => {
    const { svc, workflow } = makeSvc()
    await svc.sync('E:\\drama\\in.mp4', 'E:\\drama\\audio.mp3', 'E:\\drama\\out.mp4')

    const [name, vars] = workflow.buildGraph.mock.calls[0]
    expect(name).toBe('latentsync')
    expect(vars).toMatchObject({
      VIDEO_PATH: 'E:/drama/in.mp4',
      AUDIO_PATH: 'E:/drama/audio.mp3',
      EXPRESSION: 1.5,
      STEPS: 20
    })
    expect(typeof vars.SEED).toBe('number')
    expect(vars.SEED).toBeGreaterThanOrEqual(0)
    expect(vars.SEED).toBeLessThanOrEqual(0xffffffff)
  })

  it('waitForCompletion 收到进度回调与 40 分钟超时，并透传进度', async () => {
    const { svc, comfyui } = makeSvc()
    comfyui.waitForCompletion.mockImplementationOnce(
      async (_id: string, cb: (p: number) => void) => {
        cb(42)
        return { videos: [] }
      }
    )
    const onProgress = vi.fn()
    await svc.sync('/in.mp4', '/a.mp3', '/out.mp4', onProgress)

    expect(onProgress).toHaveBeenCalledWith(42)
    const [, , timeout] = comfyui.waitForCompletion.mock.calls[0]
    expect(timeout).toBe(40 * 60 * 1000)
  })

  it('产物带 fullpath 时走 downloadFromFullPath', async () => {
    const { svc, comfyui } = makeSvc()
    comfyui.findVideoOutput.mockReturnValueOnce({
      filename: 'o.mp4', fullpath: '/tmp/o.mp4', subfolder: '', type: 'output'
    })
    await svc.sync('/in.mp4', '/a.mp3', '/out.mp4')
    expect(comfyui.downloadFromFullPath).toHaveBeenCalledWith('/tmp/o.mp4', '/out.mp4')
    expect(comfyui.download).not.toHaveBeenCalled()
  })

  it('产物无 fullpath 时走 download(filename/subfolder/type)', async () => {
    const { svc, comfyui } = makeSvc()
    await svc.sync('/in.mp4', '/a.mp3', '/out.mp4')
    expect(comfyui.download).toHaveBeenCalledWith('out.mp4', 's', 'output', '/out.mp4')
    expect(comfyui.downloadFromFullPath).not.toHaveBeenCalled()
  })

  it('没有视频产物时抛错', async () => {
    const { svc, comfyui } = makeSvc()
    comfyui.findVideoOutput.mockReturnValueOnce(null)
    await expect(svc.sync('/in.mp4', '/a.mp3', '/out.mp4')).rejects.toThrow('LatentSync 未输出视频')
    expect(comfyui.download).not.toHaveBeenCalled()
  })

  it('输出路径缺扩展名时抛错', async () => {
    const { svc } = makeSvc()
    await expect(svc.sync('/in.mp4', '/a.mp3', '/out')).rejects.toThrow('口型同步输出路径无扩展名')
  })
})
