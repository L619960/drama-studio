import { describe, it, expect } from 'vitest'
import {
  lookAllowsElderly,
  identityDriftHits,
  ageLockFor,
  actionContentOverlap,
  castPromptPoisoned,
  safeMotionFromAction
} from '../../src/shared/promptDrift'

describe('promptDrift · 身份漂移/提示词中毒域（2026-10-30 补 branches）', () => {
  describe('lookAllowsElderly：定妆是否允许老年', () => {
    it('old man → true', () => { expect(lookAllowsElderly('old man in his 70s')).toBe(true) })
    it('elderly → true', () => { expect(lookAllowsElderly('elderly chinese woman')).toBe(true) })
    it('60s / 80s → true', () => { expect(lookAllowsElderly('man in his 60s')).toBe(true) })
    it('young woman → false', () => { expect(lookAllowsElderly('young woman in her 20s')).toBe(false) })
    it('空串 → false', () => { expect(lookAllowsElderly('')).toBe(false) })
  })

  describe('identityDriftHits：提示词 vs 定妆 冲突短语', () => {
    it('空 text → 空数组', () => { expect(identityDriftHits('', 'man')).toEqual([]) })

    it('年轻定妆里有 old man → 命中 old man', () => {
      const hits = identityDriftHits('old man with white beard walks', 'young woman, black hair')
      expect(hits).toContain('old man')
      expect(hits).toContain('white beard')
    })

    it('老年定妆里有 old man → 不命中（允许）', () => {
      const hits = identityDriftHits('old man walks', 'old man with white beard')
      expect(hits).not.toContain('old man')
    })

    it('女性定妆 + 提示词里出现 man → 命中 man', () => {
      const hits = identityDriftHits('a man walks in', 'young woman, black hair, red dress')
      expect(hits).toContain('man')
    })

    it('男性定妆 + 提示词里出现 woman → 命中 woman', () => {
      const hits = identityDriftHits('a woman speaks', 'young man, black hair, jeans')
      expect(hits).toContain('woman')
    })

    it('提示词里的服装词不在定妆里 → 命中服装', () => {
      const hits = identityDriftHits('woman wears a coat', 'woman in hanfu robe')
      expect(hits.some(h => h.includes('coat'))).toBe(true)
    })

    it('提示词里的服装词在定妆里 → 不命中', () => {
      const hits = identityDriftHits('woman wears hanfu', 'woman in hanfu robe')
      expect(hits).not.toContain('hanfu')
    })

    it('去重', () => {
      const hits = identityDriftHits('old man old man', 'young woman')
      // 'old man' 重复出现，但最终 unique
      expect(hits.filter(h => h === 'old man').length).toBe(1)
    })
  })

  describe('ageLockFor：年龄锁', () => {
    it('空 lookEn → 空串', () => { expect(ageLockFor('')).toBe('') })
    it('老年 lookEn → 空串（不需要锁）', () => { expect(ageLockFor('old man')).toBe('') })
    it('年轻 lookEn → 返回年龄锁短语', () => {
      expect(ageLockFor('young woman')).toContain('face age matches')
    })
  })

  describe('actionContentOverlap：动作词在 prompt 里的命中率', () => {
    it('action 内容词 < 4 个 → null', () => {
      expect(actionContentOverlap('walk, stand', 'walk stand')).toBeNull()
    })

    it('完全命中 → 1.0', () => {
      const r = actionContentOverlap('woman walks toward street buildings',
        'the woman walks toward the street buildings quickly')
      expect(r).toBe(1)
    })

    it('完全不命中 → 0', () => {
      const r = actionContentOverlap('woman walks toward street buildings',
        'dog runs across the field quickly forest')
      expect(r).toBe(0)
    })

    it('部分命中 → 0~1 之间', () => {
      const r = actionContentOverlap('woman walks toward street buildings',
        'woman stands in the room buildings')
      expect(r).toBeGreaterThan(0)
      expect(r).toBeLessThan(1)
    })
  })

  describe('castPromptPoisoned：中毒检测', () => {
    it('空 prompt → false', () => {
      expect(castPromptPoisoned('walk', '', 'man')).toBe(false)
    })

    it('有身份漂移 → true', () => {
      expect(castPromptPoisoned('walk', 'old man walks', 'young woman')).toBe(true)
    })

    it('action 纯中文（英文不足）→ true', () => {
      expect(castPromptPoisoned('他走向窗前，看着远方', 'woman stands', 'man')).toBe(true)
    })

    it('place 词在 prompt 但未 grounded → true', () => {
      expect(castPromptPoisoned('woman stands in street', 'woman walks in the basement cellar', 'woman')).toBe(true)
    })

    it('action overlap < 0.35 → true（prompts 讲另一个故事）', () => {
      expect(castPromptPoisoned(
        'woman walks toward street buildings',
        'dog runs across the field quickly forest',
        'woman'
      )).toBe(true)
    })
  })

  describe('safeMotionFromAction：安全动作重写', () => {
    it('基础调用 → 含 same person reference image', () => {
      const v = safeMotionFromAction('woman walks toward camera')
      expect(v).toContain('same person from the reference image')
      expect(v).toContain('static camera')
      expect(v).toContain('smooth motion')
    })

    it('有 lookEn → 含 outfit 锁定', () => {
      const v = safeMotionFromAction('woman walks', 'young woman, black hair, red hanfu robe')
      expect(v).toContain('red hanfu robe')
      expect(v).toContain('same person')
    })

    it('空 action → 有 fallback pose', () => {
      const v = safeMotionFromAction('')
      expect(v.length).toBeGreaterThan(20)
    })
  })
})
