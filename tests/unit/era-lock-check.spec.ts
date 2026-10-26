import { describe, it, expect } from 'vitest'
import { stripModernWardrobe, isPeriodGenre } from '../../src/shared/castAppearance'
import { eraLockBlock, castLookForGenre } from '../../src/shared/scenePrompts'

describe('时代锁行为验证（本次修复冒烟）', () => {
  it('古装剧 lookEn 清洗：删除现代服装词', () => {
    // 实测污染样本：黑色作战服+面罩+武士刀（00218 事故源头形态）
    const dirty = 'chinese man, black tactical uniform, black mask, black katana, hood, combat boots, dark alley'
    const out = stripModernWardrobe(dirty)
    expect(out.toLowerCase()).not.toMatch(/\btactical\b|\bmask\b|\bcombat\b|\buniform\b/)
    expect(out.toLowerCase()).toContain('hanfu')
  })
  it('改良制服+街道灯形态被清洗（00219 事故源头形态）', () => {
    const dirty = 'chinese woman, modified traditional uniform, silver bracers, high ponytail, night rainy street with street lamps'
    const out = stripModernWardrobe(dirty)
    expect(out.toLowerCase()).not.toMatch(/\buniform\b/)
    expect(out.toLowerCase()).toContain('hanfu')
  })
  it('纯古装 lookEn 不被误伤', () => {
    const clean = 'chinese man, black hair tied in high topknot, deep blue hanfu robe, silver waist sash, jian sword at hip'
    const out = stripModernWardrobe(clean)
    expect(out).toBe(clean)
  })
  it('eraLockBlock 古风分支含 no modern 负向强锁', () => {
    const block = eraLockBlock('古装')
    expect(block.toLowerCase()).toMatch(/no modern clothing|no street lights|no asphalt|no neon/)
  })
  it('eraLockBlock 现代分支不误锁现代剧', () => {
    const block = eraLockBlock('现代')
    expect(block.toLowerCase()).not.toContain('no modern')
  })
  it('castLookForGenre 按 genre 分支', () => {
    expect(isPeriodGenre('古装武侠')).toBe(true)
    expect(isPeriodGenre('现代都市')).toBe(false)
    expect(castLookForGenre('chinese man, black tactical uniform', '古装')).toContain('hanfu')
    expect(castLookForGenre('chinese man, jeans and hoodie', '现代')).toContain('jeans')
  })
})
