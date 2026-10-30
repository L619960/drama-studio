import { describe, it, expect } from 'vitest'
import { characterPrimaryRef, normalizeSceneKey } from '../../src/shared/ipcTypes'
import type { Character } from '../../src/shared/ipcTypes'

const mkChar = (over: Partial<Character> & { id: string; name: string }): Character => ({
  refImagePath: '',
  description: '',
  voice: 'zh-CN-YunyeNeural',
  ...over
})

describe('ipcTypes · 两个纯函数（2026-10-30 补 0% funcs/branches）', () => {
  describe('characterPrimaryRef：角色主参考优先级 face > ref > body', () => {
    it('faceImagePath 优先', () => {
      const c = mkChar({
        id: 'a', name: '甲',
        faceImagePath: 'p/face.png',
        refImagePath: 'p/ref.png',
        bodySheetPath: 'p/body.png'
      })
      expect(characterPrimaryRef(c)).toBe('p/face.png')
    })

    it('无 face → ref', () => {
      const c = mkChar({
        id: 'a', name: '甲',
        refImagePath: 'p/ref.png',
        bodySheetPath: 'p/body.png'
      })
      expect(characterPrimaryRef(c)).toBe('p/ref.png')
    })

    it('只有 bodySheet', () => {
      const c = mkChar({ id: 'a', name: '甲', bodySheetPath: 'p/body.png' })
      expect(characterPrimaryRef(c)).toBe('p/body.png')
    })

    it('全空 → 空串', () => {
      const c = mkChar({ id: 'a', name: '甲' })
      expect(characterPrimaryRef(c)).toBe('')
    })
  })

  describe('normalizeSceneKey：场景名 → 稳定去重键', () => {
    it('trim + lowercase + 折叠空白', () => {
      expect(normalizeSceneKey('  Living   Room  ')).toBe('living room')
    })

    it('多空格折叠成一个', () => {
      expect(normalizeSceneKey('a   b    c')).toBe('a b c')
    })

    it('全空格 → 空串', () => {
      expect(normalizeSceneKey('   ')).toBe('')
    })

    it('标点保留', () => {
      expect(normalizeSceneKey('Scene 12 — Kitchen!')).toBe('scene 12 — kitchen!')
    })
  })
})
