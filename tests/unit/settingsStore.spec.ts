import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

// electron 不可在主进程外加载：mock 掉 userData 指向临时目录
const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? state.userData : '') }
}))

import { SettingsStore } from '../../src/main/core/settingsStore'

describe('SettingsStore（S-03 归一化回归）', () => {
  let dir: string
  let store: SettingsStore

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-settings-'))
    state.userData = dir
    store = new SettingsStore()
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('无配置文件时返回默认值（autoLearn 默认关闭 S-05）', async () => {
    const s = await store.get()
    expect(s.general.autoSave).toBe(true)
    expect(s.general.autoLearn).toBe(false)
    expect(s.render.shotReviewGate).toBe('block')
    expect(s.render.finalReviewGate).toBe('block')
  })

  it('保存后回读：autoLearn=false 被保留（S-05 开关）', async () => {
    await store.save({ ...(await store.get()), general: { autoSave: true, autoLearn: false } })
    const s = await store.get()
    expect(s.general.autoLearn).toBe(false)
  })

  it('S-03：NaN / 越界数值被钳制，不落盘脏数据', async () => {
    const base = await store.get()
    base.creation.storyboard.minShots = Number.NaN
    base.creation.storyboard.maxShots = 999
    base.render.assetConcurrency = 99
    base.creation.edit.defaultBgmVolume = -50
    await store.save(base)
    const s = await store.get()
    expect(Number.isFinite(s.creation.storyboard.minShots)).toBe(true)
    expect(s.creation.storyboard.maxShots).toBeLessThanOrEqual(30)
    expect(s.render.assetConcurrency).toBeLessThanOrEqual(3)
    expect(s.creation.edit.defaultBgmVolume).toBeGreaterThanOrEqual(0)
  })

  it('S-03：非法枚举回退白名单默认值', async () => {
    const base = await store.get()
    base.render.shotReviewGate = 'evil' as never
    base.render.consistencyMode = 'evil' as never
    base.creation.edit.lipSyncMode = 'evil' as never
    base.creation.edit.reviewGate = 'evil' as never
    base.render.resolutionTier = 'evil' as never
    await store.save(base)
    const s = await store.get()
    expect(s.render.shotReviewGate).toBe('block')
    expect(s.render.consistencyMode).toBe('warn')
    expect(s.creation.edit.lipSyncMode).toBe('auto')
    expect(s.creation.edit.reviewGate).toBe('block')
    expect(s.render.resolutionTier).toBe('auto')
  })

  it('合法枚举值原样保留', async () => {
    const base = await store.get()
    base.render.shotReviewGate = 'warn'
    base.render.consistencyMode = 'rerender'
    base.render.resolutionTier = 'standard'
    await store.save(base)
    const s = await store.get()
    expect(s.render.shotReviewGate).toBe('warn')
    expect(s.render.consistencyMode).toBe('rerender')
    expect(s.render.resolutionTier).toBe('standard')
  })

  it('creation ↔ render 镜像一致（comfyTimeoutSec ↔ timeout）', async () => {
    const base = await store.get()
    base.creation.edit.comfyTimeoutSec = 1234
    await store.save(base)
    const s = await store.get()
    expect(s.render.timeout).toBe(1234)
    expect(s.creation.edit.comfyTimeoutSec).toBe(1234)
  })

  it('Wan 帧数钳到 16n+1', async () => {
    const base = await store.get()
    base.creation.edit.defaultFrames = 100
    await store.save(base)
    const s = await store.get()
    expect((s.creation.edit.defaultFrames - 1) % 16).toBe(0)
  })

  it('fusionFallback：非法值回退 block，allow 保留，缺省归一为 block', async () => {
    // 非法枚举回退默认 block
    const bad = await store.get()
    bad.render.fusionFallback = 'evil' as never
    await store.save(bad)
    let s = await store.get()
    expect(s.render.fusionFallback).toBe('block')

    // 合法 allow 原样保留
    const good = await store.get()
    good.render.fusionFallback = 'allow'
    await store.save(good)
    s = await store.get()
    expect(s.render.fusionFallback).toBe('allow')

    // 缺省字段（旧配置无此字段）经 normalize 补为默认 block
    const legacy = await store.get()
    delete (legacy.render as Record<string, unknown>).fusionFallback
    await store.save(legacy)
    s = await store.get()
    expect(s.render.fusionFallback).toBe('block')
  })
})
