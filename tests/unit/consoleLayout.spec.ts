import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  CONSOLE_MODULE_KEY,
  isConsoleModule,
  readConsoleModule,
  saveConsoleModule
} from '../../src/renderer/src/utils/consoleLayout'

function stubLocalStorage(): Map<string, string> {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size }
  })
  return store
}

describe('REQ-07 控制台中栏模块持久化', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('合法模块写入后可读回', () => {
    const store = stubLocalStorage()
    saveConsoleModule('comfyui')
    expect(store.get(CONSOLE_MODULE_KEY)).toBe('comfyui')
    expect(readConsoleModule()).toBe('comfyui')
  })

  it('无存储或非法值回退 workflow', () => {
    stubLocalStorage()
    expect(readConsoleModule()).toBe('workflow')
    saveConsoleModule('not-a-module')
    expect(readConsoleModule()).toBe('workflow')
  })

  it('无 localStorage 环境不抛错', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(readConsoleModule()).toBe('workflow')
    expect(() => saveConsoleModule('skills')).not.toThrow()
  })

  it('模块白名单判定', () => {
    expect(isConsoleModule('workflow')).toBe(true)
    expect(isConsoleModule('settings')).toBe(false)
    expect(isConsoleModule(null)).toBe(false)
  })
})
