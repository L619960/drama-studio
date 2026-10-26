import { computed, reactive, type ComputedRef } from 'vue'
import type { ProgressEvent, DirectorProgressEvent } from '../../../shared/ipcTypes'

/**
 * 侧栏「渲染队列」全局活动徽标数据源（模块级单例）。
 *
 * 语义：
 * - rendering：正在跑的镜头数——render.onProgress 活动阶段（tts/upload/render/combine）到达即 +1，
 *   done/failed/取消即 -1。主进程仅在取消时发 step:'queued'（message='已取消'），此处一并移除。
 * - failed：失败镜头数——step:'failed' 到达即计入；该镜重渲成功（done）自动移除；
 *   进入队列页视为「已读」由调用方调用 acknowledge() 清零（未读消息语义）。
 *
 * 事件双源：
 * - window.api.onProgress：逐镜实时事件，驱动 rendering/failed 计数。
 * - window.api.director.onProgress：影子渲染/流水线都会维护导演 state，其 failedShotIds 是
 *   权威失败清单——用于补上渲染进程已挂载期间错过 failed 事件窗口（如 HMR/应用中途挂载）的镜头。
 *
 * 订阅写法照 useDirectorState.subscribe()「先清旧再订阅」：HMR/重复 setup 不叠加监听。
 */

// 模块级响应式表：键为 shotId。用对象而非 Set 以便 Vue 深度追踪。
const renderingShots = reactive<Record<string, true>>({})
const failedShots = reactive<Record<string, true>>({})

let unsubRender: (() => void) | null = null
let unsubDirector: (() => void) | null = null

const ACTIVE_STEPS = new Set(['tts', 'upload', 'render', 'combine'])

function handleRenderProgress(getProjectId: () => string | undefined, e: ProgressEvent): void {
  const pid = getProjectId()
  // 有激活项目时只统计该项目的事件；未选项目时不按项目过滤（徽标此时也不可见）
  if (pid && e.projectId !== pid) return
  if (ACTIVE_STEPS.has(e.step)) {
    renderingShots[e.shotId] = true
    return
  }
  if (e.step === 'done') {
    delete renderingShots[e.shotId]
    delete failedShots[e.shotId] // 重渲成功，失败记录消退
    return
  }
  if (e.step === 'failed') {
    delete renderingShots[e.shotId]
    failedShots[e.shotId] = true
    return
  }
  // step:'queued' 当前仅由「取消入队」发出（message='已取消'）：镜头已退出，从渲染中移除
  if (e.step === 'queued') {
    delete renderingShots[e.shotId]
  }
}

function handleDirectorProgress(getProjectId: () => string | undefined, e: DirectorProgressEvent): void {
  const pid = getProjectId()
  if (pid && e.projectId !== pid) return
  // 权威失败清单补洞：漏收 failed 事件窗口内的失败镜也能被徽标捕获
  for (const sid of e.state.failedShotIds || []) failedShots[sid] = true
}

export function useRenderActivity(getProjectId: () => string | undefined): {
  rendering: ComputedRef<number>
  failed: ComputedRef<number>
  subscribe: () => void
  unsubscribeAll: () => void
  acknowledge: () => void
  reset: () => void
} {
  function subscribe(): void {
    // 先清旧再订阅：HMR/重复调用时防止事件双份处理
    unsubscribeAll()
    unsubRender = window.api.onProgress((e: ProgressEvent) => handleRenderProgress(getProjectId, e))
    unsubDirector = window.api.director.onProgress((e: DirectorProgressEvent) => handleDirectorProgress(getProjectId, e))
  }

  function unsubscribeAll(): void {
    unsubRender?.()
    unsubDirector?.()
    unsubRender = null
    unsubDirector = null
  }

  /** 进入队列页：失败徽标已被用户看到，清零（未读消息已读语义） */
  function acknowledge(): void {
    for (const sid of Object.keys(failedShots)) delete failedShots[sid]
  }

  /** 项目切换：清空旧项目残留计数，避免 A 项目的镜头永远挂在徽标上 */
  function reset(): void {
    for (const sid of Object.keys(renderingShots)) delete renderingShots[sid]
    for (const sid of Object.keys(failedShots)) delete failedShots[sid]
  }

  return {
    rendering: computed(() => Object.keys(renderingShots).length),
    failed: computed(() => Object.keys(failedShots).length),
    subscribe,
    unsubscribeAll,
    acknowledge,
    reset
  }
}
