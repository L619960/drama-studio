/**
 * 队列调度层（从 taskQueue.ts 抽出，纯函数/工厂）：
 * - deriveProjectStatus：项目状态机推导（process 收尾 / cancel / 断点续渲三处复用，口径收敛）
 * - createCancellationWatcher：长耗时 await 期间的取消竞态 watcher
 * - isProjectQueueIdle：项目是否既无在跑也无排队任务
 * 行为与原 TaskQueue 内联实现一字不差。
 */
import type { Project } from '../../shared/ipcTypes'
import { CANCEL_ERROR, type QueuedTask } from './taskQueueShared'

/**
 * 推导项目落盘状态。
 * - cancelled 或零镜头 → 'draft'（被取消项目不算 done/failed）
 * - 有失败镜头 → 'failed'
 * - 全部完成 → 'done'
 * - 其余（含部分完成/进行中）→ 'draft'
 */
export function deriveProjectStatus(
  project: Project,
  opts: { cancelled?: boolean } = {}
): Project['status'] {
  if (opts.cancelled || project.shots.length === 0) return 'draft'
  const anyFailed = project.shots.some(s => s.status === 'failed')
  const allDone = project.shots.length > 0 && project.shots.every(s => s.status === 'done')
  return allDone ? 'done' : anyFailed ? 'failed' : 'draft'
}

/** 该项目没有在跑、也没有排队。用于补上「完成事件早于监听注册」的空窗。 */
export function isProjectQueueIdle(
  queue: QueuedTask[],
  current: QueuedTask | null,
  projectId: string
): boolean {
  if (current?.projectId === projectId) return false
  return !queue.some(t => t.projectId === projectId)
}

/**
 * 取消竞态：在长耗时 await（ComfyUI 渲染）期间被取消时，
 * 该 Promise 以 CANCEL_ERROR reject，使 Promise.race 提前结束。
 */
export function createCancellationWatcher(
  cancelledProjects: Set<string>,
  cancelledShotIds: Set<string>,
  shotKey: (projectId: string, shotId: string) => string,
  projectId: string,
  shotId: string
): { promise: Promise<never>; stop(): void } {
  let timer: NodeJS.Timeout
  const promise = new Promise<never>((_, reject) => {
    timer = setInterval(() => {
      if (cancelledProjects.has(projectId) || cancelledShotIds.has(shotKey(projectId, shotId))) {
        reject(new Error(CANCEL_ERROR))
      }
    }, 150)
  })
  // 立即挂空 catch：watcher 可能在首个 Promise.race 之前就 reject（如上传参考图期间取消），
  // 无 handler 的拒绝会成为 unhandledRejection，Electron 主进程可因此崩溃
  promise.catch(() => undefined)
  return { promise, stop: () => clearInterval(timer) }
}
