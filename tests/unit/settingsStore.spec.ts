import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

// electron 不可在主进程外加载：mock 掉 userData 指向临时目录
const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? state.userData : '') },
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

  it('P2-14：save 返回递增 revision，回读与返回值一致', async () => {
    const before = (await store.get()).revision ?? 0
    const rev = await store.save(await store.get())
    expect(rev).toBe(before + 1)
    const s = await store.get()
    expect(s.revision).toBe(rev)
  })

  it('P2-14：拿旧 revision 保存被拒（提示设置已在别处更新）', async () => {
    const base = await store.get()
    const stale = { ...base, revision: (base.revision ?? 0) - 1 }
    await expect(store.save(stale)).rejects.toThrow(/设置已在别处更新/)
  })

  it('SEC-04：渲染层回传空 apiKey（未标记 dirty）时沿用磁盘旧密钥', async () => {
    const first = await store.get()
    first.llm = { ...first.llm, apiKey: 'sk-keep-me-9999', apiKeyDirty: true }
    await store.save(first)
    expect((await store.get()).llm.apiKey).toBe('sk-keep-me-9999')

    // 渲染层视图：apiKey 为空、无 dirty —— 保存不得清空密钥
    const view = await store.get()
    view.llm = { ...view.llm, apiKey: '', apiKeyDirty: false }
    await store.save(view)
    expect((await store.get()).llm.apiKey).toBe('sk-keep-me-9999')
  })

  it('SEC-04：显式 dirty + 空 apiKey 才删除密钥；直接改值（dirty）覆盖旧密钥', async () => {
    const s1 = await store.get()
    s1.llm = { ...s1.llm, apiKey: 'sk-new-0001', apiKeyDirty: true }
    await store.save(s1)
    expect((await store.get()).llm.apiKey).toBe('sk-new-0001')

    const s2 = await store.get()
    s2.llm = { ...s2.llm, apiKey: '', apiKeyDirty: true }
    await store.save(s2)
    expect((await store.get()).llm.apiKey).toBe('')
  })

  it('SEC-04：hasApiKey/apiKeyMasked/apiKeyDirty 属通信字段，不落盘', async () => {
    const s = await store.get()
    s.llm = { ...s.llm, apiKey: 'sk-persist', apiKeyDirty: true, hasApiKey: true, apiKeyMasked: '****rsist' }
    await store.save(s)
    const raw = await fs.readFile(path.join(dir, 'settings.json'), 'utf-8')
    expect(raw).not.toContain('apiKeyDirty')
    expect(raw).not.toContain('hasApiKey')
    expect(raw).not.toContain('apiKeyMasked')
  })
})
