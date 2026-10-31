/**
 * preload 桥接层单测（P2-09）：
 * 不启动 Electron，mock ipcRenderer/contextBridge，覆盖
 * 通道映射、参数快照（响应式 Proxy → 纯对象）、错误前缀剥离、事件订阅/退订、参数拼装。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  invoke: null as unknown as ReturnType<typeof vi.fn>,
  on: null as unknown as ReturnType<typeof vi.fn>,
  removeListener: null as unknown as ReturnType<typeof vi.fn>,
  exposed: null as unknown,
}))

vi.mock('electron', () => {
  state.invoke = vi.fn()
  state.on = vi.fn()
  state.removeListener = vi.fn()
  return {
    ipcRenderer: { invoke: state.invoke, on: state.on, removeListener: state.removeListener },
    contextBridge: {
      exposeInMainWorld: (_key: string, api: unknown) => {
        state.exposed = api
      },
    },
  }
})

import { IpcChannels } from '../../src/shared/ipcTypes'
import type { IpcApi } from '../../src/shared/ipcTypes'
import '../../src/preload/index'

const api = (): IpcApi => state.exposed as IpcApi

type AnyFn = (...args: unknown[]) => unknown
const exposed = (): Record<string, Record<string, AnyFn>> =>
  state.exposed as unknown as Record<string, Record<string, AnyFn>>

/** 取暴露给渲染进程的桥接方法；取不到说明 preload 注册缺失，直接失败 */
const ipcFn = (group: string, name: string): AnyFn => {
  const fn = exposed()[group]?.[name]
  if (!fn) throw new Error(`测试夹具缺少 exposed().${group}.${name}`)
  return fn
}

beforeEach(() => {
  state.invoke.mockReset().mockResolvedValue(undefined)
  state.on.mockReset()
  state.removeListener.mockReset()
})

describe('preload 通道映射', () => {
  it('settings.save 透传通道与参数，返回主进程结果（revision）', async () => {
    state.invoke.mockResolvedValueOnce(7)
    const settings = { revision: 6, llm: { apiKey: 'k' } }
    await expect(api().settings.save(settings as never)).resolves.toBe(7)
    expect(state.invoke).toHaveBeenCalledWith(IpcChannels.settingsSave, settings)
  })

  it('参数经 snapshot 深拷贝：调用方后续改动不影响已发出的参数', async () => {
    const input = { projectId: 'p1', nested: { a: 1 } }
    await ipcFn('memory', 'create')(input)
    const passed = state.invoke.mock.calls[0]?.[1] as typeof input
    expect(passed).toEqual(input)
    expect(passed).not.toBe(input)
    expect(passed.nested).not.toBe(input.nested)
  })

  it('image.generate：字符串工作流名归一为 { workflowName }', async () => {
    await ipcFn('image', 'generate')('p', 'out.png', 'wf_a')
    expect(state.invoke).toHaveBeenCalledWith(IpcChannels.imageGenerate, {
      prompt: 'p',
      relativeOutput: 'out.png',
      workflowName: 'wf_a',
    })
  })

  it('image.generate：对象选项原样展开', async () => {
    await ipcFn('image', 'generate')('p', 'out.png', { width: 768, seed: 42 })
    expect(state.invoke).toHaveBeenCalledWith(IpcChannels.imageGenerate, {
      prompt: 'p',
      relativeOutput: 'out.png',
      width: 768,
      seed: 42,
    })
  })

  it('render.start 组装请求对象', async () => {
    await ipcFn('render', 'start')('p1', ['s1'], true)
    expect(state.invoke).toHaveBeenCalledWith(IpcChannels.renderStart, {
      projectId: 'p1',
      shotIds: ['s1'],
      forceRebuildFirstFrame: true,
    })
  })

  it('IPC 错误剥掉 Electron 前缀，只留业务文案', async () => {
    state.invoke.mockRejectedValueOnce(
      new Error("Error invoking remote method 'settings:save': Error: 设置已在别处更新"),
    )
    await expect(api().settings.save({} as never)).rejects.toThrow('设置已在别处更新')
  })
})

describe('preload 事件订阅', () => {
  it('onProgress 注册监听并把 payload 交给回调，退订走 removeListener', () => {
    const cb = vi.fn()
    const off = api().onProgress(cb)
    expect(state.on).toHaveBeenCalledWith(IpcChannels.progress, expect.any(Function))
    const listener = state.on.mock.calls[0]?.[1] as (e: unknown, p: unknown) => void
    listener({}, { projectId: 'p1', percent: 42 })
    expect(cb).toHaveBeenCalledWith({ projectId: 'p1', percent: 42 })
    off()
    expect(state.removeListener).toHaveBeenCalledWith(IpcChannels.progress, listener)
  })

  it('director.onLog 透传日志事件', () => {
    const cb = vi.fn()
    api().director.onLog(cb)
    const listener = state.on.mock.calls[0]?.[1] as (e: unknown, p: unknown) => void
    listener({}, { level: 'warn', message: 'x' })
    expect(cb).toHaveBeenCalledWith({ level: 'warn', message: 'x' })
  })

  it('comfyui.onStatusChanged 把状态归一为布尔', () => {
    const cb = vi.fn()
    api().comfyui.onStatusChanged(cb)
    const listener = state.on.mock.calls[0]?.[1] as (e: unknown, p: unknown) => void
    listener({}, 'connected')
    expect(cb).toHaveBeenCalledWith(true)
  })
})
