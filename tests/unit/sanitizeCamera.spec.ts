import { describe, it, expect } from 'vitest'
import { sanitizeCameraForFrameImpl } from '../../src/main/core/directorAssetBuilder'

describe('sanitizeCameraForFrameImpl', () => {
  it('剥离第二人/背景人影从句，保留运镜词', () => {
    const out = sanitizeCameraForFrameImpl('slow push-in, Su Wan as blurred figure out of focus at frame edge, shallow depth of field')
    expect(out).not.toMatch(/Su Wan|blurred figure|out of focus/)
    expect(out).toMatch(/slow push-in/)
    expect(out).toMatch(/shallow depth of field/)
  })

  it('不再硬编码旧项目角色名——新角色名不应被误删', () => {
    // 新剧主角叫"林医生"，camera 提到他应保留；camera 提到路人应剥离
    const out = sanitizeCameraForFrameImpl('林医生 medium shot, tracking shot, 背景人影 silhouettes')
    expect(out).toMatch(/林医生/)
    expect(out).toMatch(/tracking shot/)
    expect(out).not.toMatch(/人影|silhouettes/)
  })

  it('通用第二人模式仍生效（路人/另一位/another person）', () => {
    const out = sanitizeCameraForFrameImpl('close-up, another person walking in background, static camera')
    expect(out).not.toMatch(/another person/)
    expect(out).toMatch(/close-up/)
    expect(out).toMatch(/static camera/)
  })

  it('空输入安全', () => {
    expect(sanitizeCameraForFrameImpl('')).toBe('')
    expect(sanitizeCameraForFrameImpl('   ')).toBe('')
  })
})
