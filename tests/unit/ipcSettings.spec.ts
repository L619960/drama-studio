/**
 * 主进程 IPC 层单测（P2-09）：不启动 Electron。
 * - ipc/shared.ts：路径安全解析、app-file URL、handleIpc 包装（异常日志 + 原样抛出）
 * - ipc/settings.ts：settingsSave 回传 revision、baseUrl 变更触发 ComfyUI 重连
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import * as nodeFs from 'node:fs'
import * as path from 'node:path'

const state = vi.hoisted(() => {
  // vi.hoisted 在 import 之前执行，只能用全局对象，不能引用 node:path/os
  const base = process.env.TEMP || process.env.TMPDIR || '/tmp'
  return {
    dir: `${base}/drama-ipc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    handlers: new Map<string, (...a: unknown[]) => unknown>()
  }
})

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? state.dir : '') },
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => {
      state.handlers.set(channel, fn)
    }
  },
  BrowserWindow: class {}
}))

import { IpcChannels } from '../../src/shared/ipcTypes'
import { DATA_ROOT, handleIpc, resolveInsideRoot, toAppFileUrl, assertScope } from '../../src/main/ipc/shared'
import { registerSettingsIpc } from '../../src/main/ipc/settings'

const call = (channel: string, ...args: unknown[]): unknown => {
  const fn = state.handlers.get(channel)
  if (!fn) throw new Error(`未注册通道 ${channel}`)
  return fn({}, ...args)
}

beforeEach(() => {
  state.handlers.clear()
})

afterAll(() => {
  nodeFs.rmSync(state.dir, { recursive: true, force: true })
})

describe('ipc/shared', () => {
  it('DATA_ROOT 位于 userData/drama-studio', () => {
    expect(DATA_ROOT).toBe(path.join(state.dir, 'drama-studio'))
  })

  it('toAppFileUrl：反斜杠归一、逐段 URL 编码', () => {
    expect(toAppFileUrl('projects/p1/成片 v1.mp4'))
      .toBe('app-file://local/projects/p1/%E6%88%90%E7%89%87%20v1.mp4')
    expect(toAppFileUrl('\\projects\\p1\\a.png')).toBe('app-file://local/projects/p1/a.png')
  })

  it('resolveInsideRoot：根内路径放行，越界/目录穿越拒绝', () => {
    expect(resolveInsideRoot('projects/p1')).toBe(path.join(DATA_ROOT, 'projects', 'p1'))
    expect(() => resolveInsideRoot('../../outside.txt')).toThrow(/数据根目录之外/)
    expect(() => resolveInsideRoot('C:\\Windows\\system32\\x.dll')).toThrow(/数据根目录之外/)
  })

  it('assertScope：只允许字母数字下划线短横线', () => {
    expect(() => assertScope('p1_chat')).not.toThrow()
    expect(() => assertScope('../evil')).toThrow(/非法会话标识/)
  })

  it('handleIpc：注册后回传 event + 参数，异常记日志后原样抛出', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    handleIpc('test:ok', (_e: unknown, n: number) => n * 2)
    await expect(call('test:ok', 21) as Promise<number>).resolves.toBe(42)

    handleIpc('test:boom', () => { throw new Error('业务失败') })
    await expect(call('test:boom') as Promise<unknown>).rejects.toThrow('业务失败')
    const logged = String(errSpy.mock.calls[0]?.[0] ?? '')
    expect(logged).toContain('test:boom')
    expect(logged).toContain('业务失败')
    errSpy.mockRestore()
  })
})

describe('ipc/settings', () => {
  function mkCtx() {
    const save = vi.fn(async () => 3)
    const settings = {
      comfyui: { baseUrl: 'http://127.0.0.1:8188' },
      creation: {
        character: { realismLock: 'strong', faceWidth: 768, faceHeight: 1152, t2iWorkflow: '', seedMode: 'random', seed: 42 },
        scene: { plateWidth: 768, plateHeight: 1152, weatherHint: 'auto', emptyStrict: true },
        edit: { comfyTimeoutSec: 600 }
      }
    }
    const get = vi.fn(async () => settings)
    const setBaseUrl = vi.fn(async () => undefined)
    const generate = vi.fn(async () => undefined)
    registerSettingsIpc({
      settingsStore: { get, save } as never,
      comfyuiClient: { setBaseUrl } as never,
      imageService: { generate } as never
    })
    return { save, get, setBaseUrl, generate, settings }
  }

  it('settingsGet 回读设置', async () => {
    const { get, settings } = mkCtx()
    await expect(call(IpcChannels.settingsGet) as Promise<unknown>).resolves.toEqual(settings)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('settingsSave 返回 revision，并在 baseUrl 变更时重连 ComfyUI', async () => {
    const { save, setBaseUrl } = mkCtx()
    const settings = { comfyui: { baseUrl: 'http://127.0.0.1:8188' }, revision: 2 }
    await expect(call(IpcChannels.settingsSave, settings) as Promise<number>).resolves.toBe(3)
    expect(save).toHaveBeenCalledWith(settings)
    expect(setBaseUrl).toHaveBeenCalledWith('http://127.0.0.1:8188')
  })

  it('settingsSave 无 comfyui.baseUrl 时不触发重连', async () => {
    const { setBaseUrl } = mkCtx()
    await call(IpcChannels.settingsSave, { revision: 2 })
    expect(setBaseUrl).not.toHaveBeenCalled()
  })

  it('settingsPreviewAsset：定妆预览走 image.generate，返回 app-file URL', async () => {
    const { generate } = mkCtx()
    const r = await call(IpcChannels.settingsPreviewAsset, { kind: 'character', promptHint: '红裙少女' }) as {
      relativePath: string; mediaUrl: string
    }
    expect(generate).toHaveBeenCalledTimes(1)
    expect(r.relativePath).toMatch(/^preview\/character_\d+\.png$/)
    expect(r.mediaUrl).toMatch(/^app-file:\/\/local\/preview\/character_\d+\.png$/)
    nodeFs.rmSync(path.join(DATA_ROOT, 'preview'), { recursive: true, force: true })
  })
})
