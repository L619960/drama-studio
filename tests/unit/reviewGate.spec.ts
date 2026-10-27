/**
 * reviewGate 双字段单测（LOGIC-P0-01）：
 * - render.shotReviewGate（分镜首帧门）与 render.finalReviewGate（成片复审门）是独立字段；
 * - 旧镜像已删：creation.edit.reviewGate 不再覆盖 render.reviewGate；
 * - 旧配置无 finalReviewGate 时兼容迁移旧 reviewGate 取值。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drama-settings-gate-'))

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))

import { SettingsStore } from '../../src/main/core/settingsStore'

describe('render.shotReviewGate / finalReviewGate 双字段解耦', () => {
  beforeEach(() => {
    fs.rmSync(path.join(userDataDir, 'settings.json'), { force: true })
  })
  afterEach(() => {
    fs.rmSync(path.join(userDataDir, 'settings.json'), { force: true })
  })

  it('默认值：两门都是 block，互不引用', async () => {
    const store = new SettingsStore()
    const s = await store.get()
    expect(s.render.shotReviewGate).toBe('block')
    expect(s.render.finalReviewGate).toBe('block')
  })

  it('保存后回读：两门独立存储，改一个不影响另一个', async () => {
    const store = new SettingsStore()
    const base = await store.get()
    base.render.shotReviewGate = 'warn'
    base.render.finalReviewGate = 'off'
    await store.save(base)
    const reloaded = await store.get()
    expect(reloaded.render.shotReviewGate).toBe('warn')
    expect(reloaded.render.finalReviewGate).toBe('off')
  })

  it('不再被 creation.edit.reviewGate 镜像覆盖（S-01）', async () => {
    const store = new SettingsStore()
    const s = await store.get()
    // 用户在分镜门/复审门各自设了 warn/off；同时 creation.edit.reviewGate 是 block
    s.render.shotReviewGate = 'warn'
    s.render.reviewGate = 'warn'
    s.render.finalReviewGate = 'off'
    s.creation.edit.reviewGate = 'block'
    await store.save(s)
    const reloaded = await store.get()
    // 关键：normalize 不得把 render.reviewGate/finalReviewGate 改写回 creation.edit.reviewGate='block'
    expect(reloaded.render.reviewGate).toBe('warn')
    expect(reloaded.render.finalReviewGate).toBe('off')
    expect(reloaded.render.shotReviewGate).toBe('warn')
    // creation 侧：edit.reviewGate='block' 是默认值，pickEdit 按既有规则镜像非默认 render.reviewGate='warn'
    expect(reloaded.creation.edit.reviewGate).toBe('warn')
  })

  it('旧配置只有 reviewGate 无 finalReviewGate：兼容迁移旧值', async () => {
    // 手写旧版 settings.json：render 里只有 reviewGate='off'，没有 finalReviewGate
    const old = {
      render: { reviewGate: 'off', shotReviewGate: 'warn' },
      creation: { edit: { reviewGate: 'block' } }
    }
    fs.writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify(old), 'utf-8')
    const store = new SettingsStore()
    const s = await store.get()
    // finalReviewGate 迁移自旧 reviewGate='off'，而不是被 creation.edit.reviewGate 拉回 'block'
    expect(s.render.finalReviewGate).toBe('off')
    expect(s.render.shotReviewGate).toBe('warn')
  })
})
