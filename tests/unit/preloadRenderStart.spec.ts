import { describe, it, expect, beforeEach, vi } from 'vitest'

// preload 只能在 mock electron 下加载：contextBridge 捕获 api 暴露、ipcRenderer.invoke 记录调用
const mock = vi.hoisted(() => ({
  exposed: null as unknown,
  invoked: [] as Array<{ channel: string; args: unknown[] }>
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_k: string, v: unknown) => { mock.exposed = v }
  },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      mock.invoked.push({ channel, args })
      return Promise.resolve({ warnedShots: [] })
    }
  }
}))

import '../../src/preload/index'
import { IpcChannels } from '../../src/shared/ipcTypes'

describe('preload render.start（IPC 签名缺口回归：forceRebuildFirstFrame 透传）', () => {
  beforeEach(() => {
    mock.invoked = []
  })

  it('两参数调用向后兼容：转发 {projectId, shotIds}，force 为 undefined', async () => {
    const api = mock.exposed as { render: { start: (p: string, s?: string[]) => Promise<unknown> } }
    await api.render.start('p_1', ['shot_1'])
    expect(mock.invoked[0].channel).toBe(IpcChannels.renderStart)
    const payload = mock.invoked[0].args[0] as Record<string, unknown>
    expect(payload.projectId).toBe('p_1')
    expect(payload.shotIds).toEqual(['shot_1'])
    expect(payload.forceRebuildFirstFrame).toBeUndefined()
  })

  it('三参数调用透传 forceRebuildFirstFrame（修复 renderStart 拿 Object 当 projectId 的 bug）', async () => {
    const api = mock.exposed as { render: { start: (p: string, s?: string[], f?: boolean) => Promise<unknown> } }
    await api.render.start('p_1', ['shot_1'], true)
    expect(mock.invoked[0].channel).toBe(IpcChannels.renderStart)
    const payload = mock.invoked[0].args[0] as Record<string, unknown>
    expect(payload.projectId).toBe('p_1')
    expect(payload.shotIds).toEqual(['shot_1'])
    expect(payload.forceRebuildFirstFrame).toBe(true)
  })
})
