import { describe, it, expect } from 'vitest'
import {
  hardenLookWeapons,
  lookEnStructureIssues,
  differentiateLooks,
  hardenLookEnList,
} from '../../src/shared/castAppearance'

describe('lookEn 硬门禁 v2：武器单械中式 + 结构校验 + 三角色趋同', () => {
  it('katana 被替换为中式单械，负向锁 no katana', () => {
    const dirty = 'chinese man, black cloth jacket, topknot, holding a katana'
    const out = hardenLookWeapons(dirty)
    // 违禁持械用法被清除（负向锁词 no katana 允许出现）
    expect(out.toLowerCase()).not.toMatch(
      /holding a katana|wielding a katana|with a katana|katana in (?:hand|his hand)/,
    )
    expect(out.toLowerCase()).toMatch(/exactly one weapon/)
    expect(out.toLowerCase()).toMatch(/no katana/)
    expect(out.toLowerCase()).toMatch(/jian sword/)
  })

  it('双持/双剑被收敛为单械', () => {
    const dirty = 'chinese woman, lavender outfit, twin swords in both hands'
    const out = hardenLookWeapons(dirty)
    expect(out.toLowerCase()).toMatch(/exactly one weapon, one hand empty/)
    expect(out.toLowerCase()).not.toMatch(/twin|two weapons|dual/)
  })

  it('无武器词自动补单械条款', () => {
    const out = hardenLookWeapons('chinese man, square face, blue robe, high ponytail')
    expect(out.toLowerCase()).toMatch(/exactly one weapon, one hand empty/)
  })

  it('已有中式武器词只补 exactly one 不追加新武器', () => {
    const out = hardenLookWeapons('chinese man, deep blue hanfu robe, jian sword at hip')
    expect(out.toLowerCase()).toMatch(/exactly one weapon, one hand empty/)
    expect(out.toLowerCase()).toContain('jian sword at hip')
  })

  it('枪械被清洗', () => {
    const out = hardenLookWeapons('chinese man, modern suit, holding a pistol')
    expect(out.toLowerCase()).not.toMatch(/pistol|gun/)
  })

  it('结构校验：缺发型/服装/面部条款被点名', () => {
    const issues = lookEnStructureIssues('a man, black clothes')
    expect(issues.length).toBeGreaterThanOrEqual(2)
    const full = lookEnStructureIssues('chinese man, black topknot bun, dark hanfu robe, square face, sharp jaw')
    expect(full).toEqual([])
  })

  it('趋同检测：色系+发型+脸型多维相同 → 差异化条款追加', () => {
    const looks = [
      'chinese man, black hair topknot, black hanfu robe, square face, long sword',
      'chinese man, black hair topknot, black hanfu robe, square face, long sword',
    ]
    const { looks: out, notes } = differentiateLooks(looks)
    expect(notes.length).toBeGreaterThanOrEqual(1)
    expect(out[1]?.toLowerCase()).toMatch(/different (?:face|hair|outfit)|distinct/)
  })

  it('差异明显的角色不被误伤', () => {
    const looks = [
      'chinese man, blue ponytail, deep blue robe, square face, long sword',
      'chinese woman, lavender double buns, lavender jacket, round face, short sword',
      'chinese man, black topknot, black coarse cloth outfit, thick beard, pudao',
    ]
    const { looks: out, notes } = differentiateLooks(looks)
    expect(notes).toEqual([])
    expect(out).toEqual(looks)
  })

  it('hardenLookEnList 组合：时代清洗+武器+趋同一次完成', () => {
    const looks = [
      'chinese man, black topknot, black tactical uniform, holding a katana',
      'chinese man, black topknot, black tactical uniform, holding a katana',
    ]
    const { looks: out, notes } = hardenLookEnList(looks, '古装')
    expect(notes.length).toBeGreaterThanOrEqual(1)
    for (const l of out) {
      expect(l.toLowerCase()).not.toMatch(/\bkatana\b|\btactical\b|\buniform\b/)
      expect(l.toLowerCase()).toMatch(/exactly one weapon/)
    }
  })

  it('现代剧不被强加武器条款（医生/白领不应持剑）', () => {
    const looks = ['chinese man in his early 30s, short black hair, white doctor coat, stethoscope around neck']
    const { looks: out } = hardenLookEnList(looks, '现代')
    expect(out[0]?.toLowerCase()).not.toMatch(/weapon|sword|jian|dao|blade/)
    // 原文保留
    expect(out[0]).toContain('white doctor coat')
  })
})
