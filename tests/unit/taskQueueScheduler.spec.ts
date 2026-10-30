import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  deriveProjectStatus, isProjectQueueIdle,
  createCancellationWatcher
} from '../../src/main/core/taskQueueScheduler'
import type { Project, Shot } from '../../src/shared/ipcTypes'
import { CANCEL_ERROR } from '../../src/main/core/taskQueueShared'

function makeShots(statuses: Shot['status'][]): Shot[] {
  return statuses.map((s, i) => ({
    id: `s${i}`, index: i, status: s, characterIds: [], sceneBoardId: '',
    type: 'i2v', characterName: '', camera: '',
    as: { promptEn: '', shotSize: 'medium', emotion: '', camera: '', lighting: '', facing: '', continuity: '', props: '' }
  } as Shot))
}

function makeProject(shots: Shot[], overrides: Partial<Project> = {}): Project {
  return {
    id: 'p', name: 'test', genre: '古装',
    shots, characters: [], sceneBoards: [], createdAt: 0, updatedAt: 0,
    ...overrides
  } as Project
}

describe('taskQueueScheduler', () => {
  describe('deriveProjectStatus', () => {
    it('cancelled → draft', () => {
      expect(deriveProjectStatus(makeProject(makeShots(['done'])), { cancelled: true })).toBe('draft')
    })

    it('零镜头 → draft', () => {
      expect(deriveProjectStatus(makeProject([]))).toBe('draft')
    })

    it('有失败镜头 → failed', () => {
      expect(deriveProjectStatus(makeProject(makeShots(['done', 'failed', 'pending'])))).toBe('failed')
    })

    it('全部完成 → done', () => {
      expect(deriveProjectStatus(makeProject(makeShots(['done', 'done'])))).toBe('done')
    })

    it('部分 pending 无 failed → draft', () => {
      expect(deriveProjectStatus(makeProject(makeShots(['done', 'pending'])))).toBe('draft')
    })
  })

  describe('isProjectQueueIdle', () => {
    it('current 正在跑此项目 → false', () => {
      const res = isProjectQueueIdle(
        [{ projectId: 'p2' } as any],
        { projectId: 'p1' } as any,
        'p1'
      )
      expect(res).toBe(false)
    })

    it('queue 里有待跑任务 → false', () => {
      expect(isProjectQueueIdle(
        [{ projectId: 'p1' } as any],
        null,
        'p1'
      )).toBe(false)
    })

    it('current 和 queue 都不涉及此项目 → true', () => {
      expect(isProjectQueueIdle(
        [{ projectId: 'p2' } as any],
        { projectId: 'p3' } as any,
        'p1'
      )).toBe(true)
    })

    it('空 queue + 无 current → true', () => {
      expect(isProjectQueueIdle([], null, 'p1')).toBe(true)
    })
  })

  describe('createCancellationWatcher', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => { vi.useRealTimers() })

    it('未取消时 watcher 不 reject', async () => {
      const cancelledProjects = new Set<string>()
      const cancelledShots = new Set<string>()
      const w = createCancellationWatcher(
        cancelledProjects, cancelledShots,
        (p, s) => `${p}:${s}`, 'p1', 's1'
      )
      // 推进 1000ms 但没取消 → 不 reject
      vi.advanceTimersByTime(1000)
      w.stop()
      await Promise.resolve()
    })

    it('项目命中 cancelledProjects → reject(CANCEL_ERROR)', async () => {
      const cancelledProjects = new Set(['p1'])
      const cancelledShots = new Set<string>()
      const w = createCancellationWatcher(
        cancelledProjects, cancelledShots,
        (p, s) => `${p}:${s}`, 'p1', 's1'
      )
      vi.advanceTimersByTime(300) // ≥150ms 一次检查
      await expect(w.promise).rejects.toThrow(CANCEL_ERROR)
      w.stop()
    })

    it('shot 命中 cancelledShotIds → reject(CANCEL_ERROR)', async () => {
      const cancelledProjects = new Set<string>()
      const cancelledShots = new Set(['p2:s2'])
      const w = createCancellationWatcher(
        cancelledProjects, cancelledShots,
        (p, s) => `${p}:${s}`, 'p2', 's2'
      )
      vi.advanceTimersByTime(300)
      await expect(w.promise).rejects.toThrow(CANCEL_ERROR)
      w.stop()
    })

    it('stop 后再取消不影响已 reject 的（或定时器被清理）', async () => {
      const cancelledProjects = new Set<string>()
      const cancelledShots = new Set<string>()
      const w = createCancellationWatcher(
        cancelledProjects, cancelledShots,
        (p, s) => `${p}:${s}`, 'p1', 's1'
      )
      w.stop()
      cancelledProjects.add('p1')
      vi.advanceTimersByTime(1000)
      // 定时器已清理，watcher 不会再触发
      await Promise.resolve()
    })
  })
})
