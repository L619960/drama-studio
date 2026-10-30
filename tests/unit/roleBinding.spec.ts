import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  castNameVariants,
  validateCharacterAssets,
  extractLookAnchors,
  detectRoleConfusion
} from '../../src/main/core/roleBinding'
import type { Character } from '../../src/shared/ipcTypes'

const mkChar = (over: Partial<Character> & { id: string; name: string }): Character => ({
  refImagePath: '',
  description: '',
  voice: 'zh-CN-YunyeNeural',
  ...over
})

describe('roleBinding · 角色资产绑定与防混淆（2026-10-23 角色混淆根因级修复）', () => {
  describe('validateCharacterAssets：多角色必须各绑唯一定妆图、外观锚点差异化', () => {
    it('两角色共享同一张参考图 → 硬错误 conflicts', () => {
      const a = mkChar({ id: 'a', name: '主角', faceImagePath: 'projects/p/x.png' })
      const b = mkChar({ id: 'b', name: '反派', faceImagePath: 'projects/p/x.png' })
      const { conflicts, similarLooks } = validateCharacterAssets([a, b])
      expect(conflicts.length).toBe(1)
      expect(conflicts[0]).toContain('共享同一张人物参考图')
      expect(similarLooks.length).toBe(0)
    })

    it('共享 bodySheetPath 同样判冲突', () => {
      const a = mkChar({ id: 'a', name: '甲', refImagePath: 'projects/p/body.png', bodySheetPath: 'projects/p/body.png' })
      const b = mkChar({ id: 'b', name: '乙', bodySheetPath: 'projects/p/body.png' })
      const { conflicts } = validateCharacterAssets([a, b])
      expect(conflicts.length).toBe(1)
    })

    it('各角色独立定妆图 → 无冲突', () => {
      const a = mkChar({ id: 'a', name: '主角', faceImagePath: 'projects/p/a_face.png' })
      const b = mkChar({ id: 'b', name: '反派', faceImagePath: 'projects/p/b_face.png' })
      const { conflicts } = validateCharacterAssets([a, b])
      expect(conflicts.length).toBe(0)
    })

    it('外观趋同（同色系+同发型）→ 警告 similarLooks', () => {
      const a = mkChar({
        id: 'a', name: '主角',
        faceImagePath: 'projects/p/a.png',
        appearanceLock: 'young chinese man, dark blue robe, high ponytail, heroic'
      })
      const b = mkChar({
        id: 'b', name: '反派',
        faceImagePath: 'projects/p/b.png',
        appearanceLock: 'chinese man, dark blue robe, high ponytail, calm'
      })
      const { conflicts, similarLooks } = validateCharacterAssets([a, b])
      expect(conflicts.length).toBe(0)
      expect(similarLooks.length).toBe(1)
      expect(similarLooks[0]).toContain('外观趋同')
    })

    it('外观差异化（不同色系/发型）→ 无趋同警告', () => {
      const a = mkChar({
        id: 'a', name: '主角',
        faceImagePath: 'projects/p/a.png',
        appearanceLock: 'young chinese man, pale linen robe, high ponytail, bright eyes'
      })
      const b = mkChar({
        id: 'b', name: '反派',
        faceImagePath: 'projects/p/b.png',
        appearanceLock: 'middle-aged chinese man, dark purple brocade robe, short beard, sinister'
      })
      const { conflicts, similarLooks } = validateCharacterAssets([a, b])
      expect(conflicts.length).toBe(0)
      expect(similarLooks.length).toBe(0)
    })
  })

  describe('extractLookAnchors：外观锚点抽取', () => {
    it('从 appearanceLock + description 提取色系与发型', () => {
      const c = mkChar({
        id: 'c', name: '配角',
        faceImagePath: 'projects/p/c.png',
        appearanceLock: 'old chinese man, ochre cloth robe, white hair bun, kind',
        description: '褐色短褐，束发'
      })
      const { colors, hairs } = extractLookAnchors(c)
      expect(colors.some(x => x.includes('赭褐') || x.includes('浅色'))).toBe(true)
      expect(hairs.some(x => x.includes('束发冠') || x.includes('白发'))).toBe(true)
    })

    it('现代服化锚点（navy 西装 / 短发）可提取（2026-10-23 现代剧适配）', () => {
      const a = mkChar({
        id: 'a', name: '现代主角',
        faceImagePath: 'projects/p/a.png',
        appearanceLock: 'chinese man in his early 30s, short neat black hair, navy suit with white shirt, clean-shaven'
      })
      const b = mkChar({
        id: 'b', name: '现代配角',
        faceImagePath: 'projects/p/b.png',
        appearanceLock: 'chinese woman in her late 20s, long wavy brown hair, olive trench coat, elegant'
      })
      const { colors: ca, hairs: ha } = extractLookAnchors(a)
      const { colors: cb, hairs: hb } = extractLookAnchors(b)
      expect(ca.some(x => x.includes('蓝'))).toBe(true)      // navy → 青色/蓝色
      expect(cb.some(x => x.includes('绿') || x.includes('赭'))).toBe(true) // olive → 绿色
      expect(ha.some(x => x.includes('短发'))).toBe(true)    // short hair → 短发
      expect(hb.some(x => x.includes('卷发') || x.includes('披发'))).toBe(true) // wavy/long
    })

    it('现代两角色色系发型差异化 → 无趋同误报', () => {
      const a = mkChar({
        id: 'a', name: '主角', faceImagePath: 'projects/p/a.png',
        appearanceLock: 'chinese man, navy suit, short hair, confident'
      })
      const b = mkChar({
        id: 'b', name: '配角', faceImagePath: 'projects/p/b.png',
        appearanceLock: 'chinese woman, olive trench coat, long wavy hair, gentle'
      })
      const { similarLooks } = validateCharacterAssets([a, b])
      expect(similarLooks.length).toBe(0)
    })

    it('现代两角色同色系同发型 → 仍判趋同（词典现代词生效）', () => {
      const a = mkChar({
        id: 'a', name: '甲', faceImagePath: 'projects/p/a.png',
        appearanceLock: 'chinese man, black suit, short hair, stern'
      })
      const b = mkChar({
        id: 'b', name: '乙', faceImagePath: 'projects/p/b.png',
        appearanceLock: 'chinese man, black suit, short hair, calm'
      })
      const { similarLooks } = validateCharacterAssets([a, b])
      expect(similarLooks.length).toBe(1)
      expect(similarLooks[0]).toContain('外观趋同')
    })
  })

  describe('detectRoleConfusion：渲染后相对判别（更像他人定妆即混淆）', () => {
    it('other > self + margin → 判混淆并给出更像的角色', () => {
      const v = detectRoleConfusion({
        selfScore: 0.55,
        otherScores: [{ characterId: 'b', name: '反派', score: 0.72 }]
      })
      expect(v.confused).toBe(true)
      expect(v.withName).toBe('反派')
      expect(v.bestOther).toBe(0.72)
    })

    it('self 与 other 接近（差 < margin）→ 不判混淆', () => {
      const v = detectRoleConfusion({
        selfScore: 0.66,
        otherScores: [{ characterId: 'b', name: '反派', score: 0.68 }]
      })
      expect(v.confused).toBe(false)
    })

    it('self > other → 不判混淆', () => {
      const v = detectRoleConfusion({
        selfScore: 0.8,
        otherScores: [{ characterId: 'b', name: '反派', score: 0.5 }]
      })
      expect(v.confused).toBe(false)
    })

    it('多角色取最高分者比较', () => {
      const v = detectRoleConfusion({
        selfScore: 0.5,
        otherScores: [
          { characterId: 'b', name: '反派', score: 0.4 },
          { characterId: 'c', name: '配角', score: 0.78 }
        ]
      })
      expect(v.confused).toBe(true)
      expect(v.withCharacter).toBe('c')
    })

    it('无 otherScores → 不判混淆', () => {
      const v = detectRoleConfusion({ selfScore: 0.5, otherScores: [] })
      expect(v.confused).toBe(false)
    })

    it('自定义 margin', () => {
      const v = detectRoleConfusion({
        selfScore: 0.6,
        otherScores: [{ characterId: 'b', name: '反派', score: 0.64 }],
        margin: 0.1
      })
      expect(v.confused).toBe(false)
    })

    it('otherScores 多角色同分时取先入者（稳定行为）', () => {
      const v = detectRoleConfusion({
        selfScore: 0.5,
        otherScores: [
          { characterId: 'b', name: '反派', score: 0.7 },
          { characterId: 'c', name: '配角', score: 0.7 }
        ]
      })
      expect(v.confused).toBe(true)
      expect(v.withCharacter).toBe('b')
    })
  })

  describe('castNameVariants：中文名 → 拼音空格名/首字母大写名（2026-10-30 补缺口）', () => {
    it('空字符串 → 空数组', () => {
      expect(castNameVariants('')).toEqual([])
    })

    it('纯空格 → 空数组', () => {
      expect(castNameVariants('   ')).toEqual([])
    })

    it('undefined 等价输入（空）→ 空数组', () => {
      // castNameVariants 签名是 (name: string)，但防御性编程 trim 后再判空
      expect(castNameVariants('\t\n')).toEqual([])
    })

    it('正常中文名 → 包含原文 + 拼音空格 + 小写拼音 + 首字母大写 + 无空格拼音', () => {
      const v = castNameVariants('张三')
      expect(v.length).toBeGreaterThanOrEqual(2)
      expect(v).toContain('张三')
    })

    it('英文名 → 原样返回（不依赖拼音结果）', () => {
      const v = castNameVariants('John Smith')
      expect(v).toContain('John Smith')
    })
  })

  describe('validateCharacterAssets 边界：单角色 / 空数组 / 多角色多图共享', () => {
    it('单角色 → 无冲突无趋同', () => {
      const a = mkChar({ id: 'a', name: '主角', faceImagePath: 'p/a.png' })
      const { conflicts, similarLooks } = validateCharacterAssets([a])
      expect(conflicts).toEqual([])
      expect(similarLooks).toEqual([])
    })

    it('空数组 → 全空', () => {
      const { conflicts, similarLooks } = validateCharacterAssets([])
      expect(conflicts).toEqual([])
      expect(similarLooks).toEqual([])
    })

    it('三角色循环共享 → 每个 pair 都检出', () => {
      const a = mkChar({ id: 'a', name: '甲', faceImagePath: 'p/shared.png' })
      const b = mkChar({ id: 'b', name: '乙', refImagePath: 'p/shared.png' })
      const c = mkChar({ id: 'c', name: '丙', bodySheetPath: 'p/shared.png' })
      const { conflicts } = validateCharacterAssets([a, b, c])
      // 3 对 pair (a,b),(a,c),(b,c) 各共享一张图 → 3 条
      expect(conflicts.length).toBe(3)
    })

    it('两角色 appearanceLock 和 description 都空 → 无趋同（锚点为空集交集为空）', () => {
      const a = mkChar({ id: 'a', name: '甲', faceImagePath: 'p/a.png' })
      const b = mkChar({ id: 'b', name: '乙', faceImagePath: 'p/b.png' })
      const { similarLooks } = validateCharacterAssets([a, b])
      expect(similarLooks).toEqual([])
    })
  })

  describe('extractLookAnchors 边界：无 appearanceLock/description', () => {
    it('全空输入 → 两个空数组', () => {
      const c = mkChar({ id: 'x', name: '无名', faceImagePath: 'p/x.png' })
      const { colors, hairs } = extractLookAnchors(c)
      expect(colors).toEqual([])
      expect(hairs).toEqual([])
    })
  })

  describe('detectRoleConfusion 边界：未传 selfScore / 负数 / margin 边界', () => {
    it('未传 selfScore → 默认 0 比较', () => {
      const v = detectRoleConfusion({
        otherScores: [{ characterId: 'b', name: '反派', score: 0.06 }]
      })
      // best(0.06) > 0 + 0.05 → confused
      expect(v.confused).toBe(true)
      expect(v.selfScore).toBe(0)
    })

    it('self 恰好等于 other + margin 边界 → 不判混淆（严格大于）', () => {
      const v = detectRoleConfusion({
        selfScore: 0.6,
        otherScores: [{ characterId: 'b', name: '反派', score: 0.65 }],
        margin: 0.05
      })
      // 0.65 > 0.6 + 0.05 → 0.65 > 0.65 是 false → 不混淆
      expect(v.confused).toBe(false)
    })

    it('self 正好小于 other + margin ε → 判混淆', () => {
      const v = detectRoleConfusion({
        selfScore: 0.6,
        otherScores: [{ characterId: 'b', name: '反派', score: 0.651 }],
        margin: 0.05
      })
      expect(v.confused).toBe(true)
    })

    it('otherScores 只有一项且分数为负 → 不混淆', () => {
      const v = detectRoleConfusion({
        selfScore: 0.5,
        otherScores: [{ characterId: 'b', name: '反派', score: -0.1 }]
      })
      expect(v.confused).toBe(false)
      expect(v.bestOther).toBe(-0.1)
    })
  })
})
