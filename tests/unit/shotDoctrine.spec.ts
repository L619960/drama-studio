import { describe, it, expect } from 'vitest'
import { audioTailSecFor, doctrinePromptBlock, SHOT_DOCTRINE } from '../../src/shared/shotDoctrine'

describe('shotDoctrine · 短剧单镜口径（2026-10-30 补 90% → 100%）', () => {
  describe('SHOT_DOCTRINE 常量', () => {
    it('min/max 为 4~6 秒', () => {
      expect(SHOT_DOCTRINE.minSec).toBe(4)
      expect(SHOT_DOCTRINE.maxSec).toBe(6)
    })
    it('dialogueTail 0.5, buttonTail 1.2, stillTail 0.4', () => {
      expect(SHOT_DOCTRINE.dialogueTailSec).toBe(0.5)
      expect(SHOT_DOCTRINE.buttonTailSec).toBe(1.2)
      expect(SHOT_DOCTRINE.stillTailSec).toBe(0.4)
    })
  })

  describe('audioTailSecFor：对白尾白时长决策', () => {
    it('isLast → buttonTailSec (1.2)', () => {
      expect(audioTailSecFor({ isLast: true })).toBe(1.2)
    })

    it('emotion 含 climax → buttonTailSec (1.2)', () => {
      expect(audioTailSecFor({ emotion: 'climax moment' })).toBe(1.2)
    })

    it('emotion 含 崩溃（中文）→ buttonTailSec (1.2)', () => {
      expect(audioTailSecFor({ emotion: '崩溃痛哭' })).toBe(1.2)
    })

    it('emotion 含 tear → buttonTailSec (1.2)', () => {
      expect(audioTailSecFor({ emotion: 'eyes tear up' })).toBe(1.2)
    })

    it('有 dialogue → dialogueTailSec (0.5)', () => {
      expect(audioTailSecFor({ dialogue: '你好' })).toBe(0.5)
    })

    it('dialogue 只有空白 → stillTailSec (0.4)', () => {
      expect(audioTailSecFor({ dialogue: '   ' })).toBe(0.4)
    })

    it('全空 → stillTailSec (0.4)', () => {
      expect(audioTailSecFor({})).toBe(0.4)
    })

    it('isLast 优先于 emotion 和 dialogue', () => {
      expect(audioTailSecFor({ isLast: true, emotion: '', dialogue: '你好' })).toBe(1.2)
    })

    it('emotion 优先于 dialogue', () => {
      expect(audioTailSecFor({ emotion: 'climax', dialogue: '你好' })).toBe(1.2)
    })
  })

  describe('doctrinePromptBlock：成片口径提示词块', () => {
    it('返回非空多行字符串', () => {
      const v = doctrinePromptBlock()
      expect(v.length).toBeGreaterThan(50)
      expect(v).toMatch(/\n/)
    })

    it('包含关键口径词', () => {
      const v = doctrinePromptBlock()
      expect(v).toContain('成片口径')
      expect(v).toContain('单镜时长')
      expect(v).toContain('4~6')
    })
  })
})
