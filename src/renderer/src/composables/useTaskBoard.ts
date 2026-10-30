import { ref, computed, type ComputedRef, type Ref } from 'vue'
import type { QueueSnapshot } from '../../../shared/ipcTypes'

/**
 * 队列/任务看板统一数据源（模块级单例）。
 *
 * REQ-01：主进程 queue:list 提供权威快照（正在渲哪镜 / 还排几镜 / 剩余 ETA），
 * 渲染层不再由各视图各自合并 director:progress 与 project:progress 两套契约。
 * 进度事件只作为「该刷新了」的信号，快照本身始终来自主进程，避免前端对账漂移。
 */

const EMPTY: QueueSnapshot = { running: null, queued: [], etaSeconds: null }

const snapshot = ref<QueueSnapshot>({ ...EMPTY, queued: [] })
let unsubProgress: (() => void) | null = null
let refreshTimer: number | null = null
let refreshing: Promise<void> | null = null

async function refresh(): Promise<void> {
  if (refreshing) return refreshing
  refreshing = window.api.render.list()
    .then(s => { snapshot.value = s })
    .catch(() => { /* 主进程不可用时保持上一次快照 */ })
    .finally(() => { refreshing = null })
  return refreshing
}

/** 进度事件高频：500ms 合并一次快照刷新 */
function scheduleRefresh(): void {
  if (refreshTimer !== null) return
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null
    void refresh()
  }, 500)
}

function unsubscribeAll(): void {
  unsubProgress?.()
  unsubProgress = null
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
}

export function useTaskBoard(): {
  queue: Ref<QueueSnapshot>
  runningShot: ComputedRef<QueueSnapshot['running']>
  queuedCount: ComputedRef<number>
  etaText: ComputedRef<string>
  isActive: ComputedRef<boolean>
  subscribe: () => void
  unsubscribeAll: () => void
  refresh: () => Promise<void>
} {
  function subscribe(): void {
    unsubscribeAll()
    unsubProgress = window.api.onProgress(() => scheduleRefresh())
    void refresh()
  }

  return {
    queue: snapshot,
    runningShot: computed(() => snapshot.value.running),
    queuedCount: computed(() => snapshot.value.queued.length),
    isActive: computed(() => snapshot.value.running !== null || snapshot.value.queued.length > 0),
    /** 无历史样本（首跑）时明确显示「首次渲染，暂无预估」，不展示 NaN/0 */
    etaText: computed(() => {
      const eta = snapshot.value.etaSeconds
      if (snapshot.value.queued.length === 0) return ''
      if (eta == null) return '首次渲染，暂无预估'
      if (eta < 60) return `预计还需约 ${eta} 秒`
      return `预计还需约 ${Math.round(eta / 60)} 分钟`
    }),
    subscribe,
    unsubscribeAll,
    refresh
  }
}
