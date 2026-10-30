import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  ONBOARDED_KEY,
  SAMPLE_PROJECT,
  isOnboarded,
  markOnboarded,
  isComfyOffline
} from '../../src/renderer/src/utils/onboarding'

describe('REQ-06 首跑引导完成标记', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('未写入标记视为首次启动，写入后不再打扰', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
      clear: () => { store.clear() },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size }
    })

    expect(isOnboarded()).toBe(false)
    markOnboarded()
    expect(store.get(ONBOARDED_KEY)).toBe('1')
    expect(isOnboarded()).toBe(true)
  })

  it('无 localStorage 环境不抛错且视为未引导', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(isOnboarded()).toBe(false)
    expect(() => markOnboarded()).not.toThrow()
  })

  it('示例项目预填片名与题材均非空', () => {
    expect(SAMPLE_PROJECT.title.trim().length).toBeGreaterThan(0)
    expect(SAMPLE_PROJECT.genre.trim().length).toBeGreaterThan(0)
  })
})

describe('REQ-06 ComfyUI 离线判定', () => {
  it('自检项的 warn 或 !ok 都视为离线', () => {
    expect(isComfyOffline([{ name: 'ComfyUI', ok: true, warn: true, detail: '离线' }])).toBe(true)
    expect(isComfyOffline([{ name: 'ComfyUI', ok: false, detail: '检查失败' }])).toBe(true)
  })

  it('在线项与缺失项都不算离线', () => {
    expect(isComfyOffline([{ name: 'ComfyUI', ok: true, detail: '在线' }])).toBe(false)
    expect(isComfyOffline([])).toBe(false)
  })
})
