import { describe, it, expect } from 'vitest'
import { resolveRefImageRel, resolveSceneImageRel } from '../../src/main/core/taskQueueRefs'
import type { Project, Shot, Character, SceneBoard } from '../../src/shared/ipcTypes'

function mkShot(overrides: Partial<Shot> = {}): Shot {
  return {
    id: 's1', index: 0, characterIds: [], sceneBoardId: '',
    type: 'i2v', characterName: '', camera: '',
    as: { promptEn: '', shotSize: 'medium', emotion: '', camera: '', lighting: '', facing: '', continuity: '', props: '' },
    ...overrides
  } as Shot
}

function mkProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p', name: 'test', genre: '古装', shots: [], characters: [], sceneBoards: [],
    createdAt: 0, updatedAt: 0, creation: { edit: { scene: { frameWidth: 720, frameHeight: 1280 } } },
    ...overrides
  } as Project
}

describe('taskQueueRefs', () => {
  describe('resolveRefImageRel', () => {
    it('t2v 有 sceneImagePath → 返回它', () => {
      const shot = mkShot({ type: 't2v', sceneImagePath: 'scenes/x.png' })
      const p = mkProject()
      expect(resolveRefImageRel(shot, p)).toBe('scenes/x.png')
    })

    it('t2v 有 sceneBoard.emptyPlatePath → 返回它', () => {
      const board: SceneBoard = { id: 'b1', emptyPlatePath: 'plates/y.png', scenes: [], width: 720, height: 1280, widthIn: 720, heightIn: 1280 } as any
      const shot = mkShot({ type: 't2v', sceneBoardId: 'b1', sceneImagePath: undefined })
      const p = mkProject({ sceneBoards: [board] })
      expect(resolveRefImageRel(shot, p)).toBe('plates/y.png')
    })

    it('t2v 啥都没 → 抛错', () => {
      const shot = mkShot({ type: 't2v', sceneBoardId: '', sceneImagePath: undefined })
      expect(() => resolveRefImageRel(shot, mkProject())).toThrow('空镜缺少场景参考图')
    })

    it('closeup + 有首帧 → 优先首帧', () => {
      const c: Character = { id: 'c1', faceImagePath: 'face.png', name: '甲', scene: '古代' } as any
      const shot = mkShot({ type: 'i2v', characterIds: ['c1'], shotSize: 'closeup', firstFramePath: 'first.png' })
      const p = mkProject({ characters: [c] })
      expect(resolveRefImageRel(shot, p)).toBe('first.png')
    })

    it('closeup + 无首帧但有定妆 → 回退定妆', () => {
      const c: Character = { id: 'c1', faceImagePath: 'face.png', name: '甲', scene: '古代' } as any
      const shot = mkShot({ type: 'i2v', characterIds: ['c1'], shotSize: 'closeup', firstFramePath: undefined })
      const p = mkProject({ characters: [c] })
      expect(resolveRefImageRel(shot, p)).toBe('face.png')
    })

    it('character 未绑定 → 抛错', () => {
      const shot = mkShot({ type: 'i2v', characterIds: [] })
      expect(() => resolveRefImageRel(shot, mkProject())).toThrow('未绑定角色')
    })

    it('角色无定妆图 → 抛错', () => {
      const c: Character = { id: 'c1', name: '甲', scene: '古代' } as any
      const shot = mkShot({ type: 'i2v', characterIds: ['c1'], firstFramePath: undefined })
      const p = mkProject({ characters: [c] })
      expect(() => resolveRefImageRel(shot, p)).toThrow('缺少定妆图')
    })

    it('有首帧时非 closeup 也直接返回首帧（比 characterPrimaryRef 优先）', () => {
      const c: Character = { id: 'c1', faceImagePath: 'face.png', name: '甲', scene: '古代' } as any
      const shot = mkShot({ type: 'i2v', characterIds: ['c1'], shotSize: 'medium', firstFramePath: 'first.png' })
      const p = mkProject({ characters: [c] })
      expect(resolveRefImageRel(shot, p)).toBe('first.png')
    })
  })

  describe('resolveSceneImageRel', () => {
    it('有 shot.sceneImagePath → 立即返回', () => {
      const shot = mkShot({ sceneImagePath: 'scenes/x.png', scene: 'street' })
      const p = mkProject({ id: 'proj' })
      // 用一个 baseDir（existsSync 不影响分支，因为先 return 了）
      expect(resolveSceneImageRel(shot, p, 'D:/data')).toBe('scenes/x.png')
    })

    it('都没 → null', () => {
      const shot = mkShot({ sceneImagePath: undefined, sceneBoardId: '', scene: 'nowhere' })
      const p = mkProject({ id: 'proj', sceneBoards: [] })
      expect(resolveSceneImageRel(shot, p, 'D:/nonexistent')).toBeNull()
    })
  })
})
