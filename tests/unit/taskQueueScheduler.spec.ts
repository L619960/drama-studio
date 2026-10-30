import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  deriveProjectStatus, isProjectQueueIdle,
  createCancellationWatcher, estimateEtaSeconds, buildQueueSnapshot
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

  describe('estimateEtaSeconds：队列剩余预计耗时', () => {
    it('无历史样本（首跑）→ null', () => {
      expect(estimateEtaSeconds([], 3)).toBeNull()
    })

    it('无排队任务 → null', () => {
      expect(estimateEtaSeconds([60_000, 90_000], 0)).toBeNull()
    })

    it('按历史均耗时×剩余镜数估算（秒）', () => {
      // 均耗时 60s，还剩 3 镜 → 180s
      expect(estimateEtaSeconds([30_000, 90_000], 3)).toBe(180)
    })

    it('不足 1 秒也至少给 1 秒，避免 UI 显示 0', () => {
      expect(estimateEtaSeconds([500], 1)).toBe(1)
    })

    it('非法样本（0/NaN）→ null', () => {
      expect(estimateEtaSeconds([0], 2)).toBeNull()
      expect(estimateEtaSeconds([Number.NaN], 2)).toBeNull()
    })
  })

  describe('buildQueueSnapshot：队列快照', () => {
    it('空队列无在跑 → running=null、queued 为空', () => {
      const snap = buildQueueSnapshot([], null, null, [])
      expect(snap).toEqual({ running: null, queued: [], etaSeconds: null })
    })

    it('在跑镜进度与排队镜正确映射', () => {
      const snap = buildQueueSnapshot(
        [{ projectId: 'p1', shotId: 's2' } as any, { projectId: 'p2', shotId: 's9' } as any],
        { projectId: 'p1', shotId: 's1' } as any,
        { step: 'render', percent: 40 },
        [60_000]
      )
      expect(snap.running).toEqual({ projectId: 'p1', shotId: 's1', step: 'render', percent: 40 })
      expect(snap.queued).toEqual([
        { projectId: 'p1', shotId: 's2' },
        { projectId: 'p2', shotId: 's9' }
      ])
      // 均耗时 60s × 2 镜
      expect(snap.etaSeconds).toBe(120)
    })

    it('尚无进度事件 → step 回退 queued、percent=0', () => {
      const snap = buildQueueSnapshot(
        [],
        { projectId: 'p1', shotId: 's1' } as any,
        null,
        []
      )
      expect(snap.running?.step).toBe('queued')
      expect(snap.running?.percent).toBe(0)
      expect(snap.etaSeconds).toBeNull()
    })
  })
})
