import { computed, ref, watch, type Ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type {
  DirectorState, DirectorStage, DirectorLogEntry
} from '../../../shared/ipcTypes'

/** 工作流九阶段顺序（与 [directorAgent.ts](../../../../../main/core/directorAgent.ts) STAGE_ORDER 同构，UI 本地副本） */
export const STAGE_ORDER: DirectorStage[] = [
  'analyze', 'casting', 'scenes', 'render',
  'combine', 'subtitle', 'review', 'bgm', 'done'
]

/** 阶段中文标签（"场景与首帧" 与主进程标签略不同，前端 UI 用本副本） */
export const STAGE_LABELS: Record<DirectorStage, string> = {
  analyze: '剧本分析',
  casting: '角色建档',
  scenes: '场景与首帧',
  render: '逐镜渲染 · 审批',
  combine: '拼接成片',
  subtitle: '烧录字幕',
  review: '成片复审',
  bgm: 'BGM 混音',
  done: '完成'
}

export const LEVEL_TEXT = { info: '信息', success: '成功', warn: '警告', error: '错误' } as const

/** 开拍弹窗里的阶段确认点选项 */
export const GATE_OPTIONS = [
  { value: 'analyze', label: '剧本分析（核对角色与分镜）' },
  { value: 'casting', label: '角色建档（核设定妆照）' },
  { value: 'scenes', label: '场景与首帧（核对全部首帧图）' },
  { value: 'render', label: '逐镜渲染与审批' },
  { value: 'combine', label: '拼接成片' },
  { value: 'subtitle', label: '烧录字幕' },
  { value: 'review', label: '成片复审（配乐前最后一关）' }
] as const

/**
 * 导演状态 + 日志合并 + 任务控制 + 阶段切换折叠策略。
 *
 * composable 不绑定 onMounted/onUnmounted，由壳视图统一调度 subscribe / unsubscribeAll。
 * 滚动 DOM 留在子组件（WorkflowPanel），新日志触发"按需滚底"由子组件 watch 实现。
 *
 * @param projectId 路由里的 :id（无项目时为 undefined → 全局控制台）
 */
export function useDirectorState(projectId: Ref<string | undefined>) {
  const state = ref<DirectorState | null>(null)
  const localLogs = ref<DirectorLogEntry[]>([])
  const expandedStages = ref<DirectorStage[]>(['analyze'])

  const running = computed(() => state.value?.running ?? false)
  const paused = computed(() => state.value?.paused ?? false)
  const currentProjectId = computed(() => state.value?.projectId || projectId.value)

  const logsByStage = computed(() => {
    const map = new Map<DirectorStage, DirectorLogEntry[]>()
    for (const e of localLogs.value) {
      const arr = map.get(e.stage) || []
      arr.push(e)
      map.set(e.stage, arr)
    }
    return STAGE_ORDER
      .filter(s => map.has(s))
      .map(stage => ({ stage, entries: map.get(stage)! }))
  })

  function isGate(stage: DirectorStage): boolean {
    return state.value?.gateStages.includes(stage) ?? false
  }
  function groupHasError(g: { entries: DirectorLogEntry[] }): boolean {
    return g.entries.some(e => e.level === 'error')
  }
  function formatTime(ts: number): string {
    const d = new Date(ts)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}`
  }

  // 合并日志（按 id 去重，保持顺序，上限 300 条）
  function mergeLogs(entries: DirectorLogEntry[]): void {
    if (!entries.length) return
    const known = new Set(localLogs.value.map(e => e.id))
    let changed = false
    for (const e of entries) {
      if (!known.has(e.id)) {
        localLogs.value.push(e)
        known.add(e.id)
        changed = true
      }
    }
    if (changed && localLogs.value.length > 300) {
      localLogs.value = localLogs.value.slice(-300)
    }
  }

  // 阶段切换时：自动展开运行中/出错阶段，收起已完成阶段
  let lastRunning = ''
  watch(() => {
    const s = state.value
    if (!s) return ''
    const cur = STAGE_ORDER.find(st => s.stages[st].status === 'running') || ''
    return `${cur}|${s.paused}`
  }, (sig) => {
    const [cur, pausedFlag] = sig.split('|')
    const next = new Set(expandedStages.value)
    if (lastRunning && lastRunning !== cur) {
      const prev = state.value?.stages[lastRunning as DirectorStage]
      if (prev && prev.status !== 'error') next.delete(lastRunning as DirectorStage)
    }
    if (cur) next.add(cur as DirectorStage)
    if (pausedFlag === 'true' && cur === '') {
      const last = logsByStage.value[logsByStage.value.length - 1]
      if (last) next.add(last.stage)
    }
    expandedStages.value = [...next]
    lastRunning = cur
  })

  async function hydrate(id: string): Promise<void> {
    const s = await window.api.director.getState(id)
    if (!s) return
    state.value = s
    mergeLogs(s.logs || [])
    const cur = STAGE_ORDER.find(st => s.stages[st].status === 'running')
    if (cur) expandedStages.value = [cur]
  }

  let unsubProgress: (() => void) | null = null
  let unsubLog: (() => void) | null = null

  function subscribe(): void {
    unsubProgress = window.api.director.onProgress((e) => {
      if (currentProjectId.value && e.projectId !== currentProjectId.value) return
      state.value = e.state
      mergeLogs(e.state.logs || [])
    })
    unsubLog = window.api.director.onLog((e) => {
      if (currentProjectId.value && e.projectId !== currentProjectId.value) return
      mergeLogs([e.entry])
    })
  }

  function unsubscribeAll(): void {
    unsubProgress?.()
    unsubLog?.()
    unsubProgress = null
    unsubLog = null
  }

  async function onPause(): Promise<void> {
    if (!currentProjectId.value) return
    await window.api.director.pause(currentProjectId.value)
    ElMessage.info('已请求暂停，当前阶段结束后自动停下')
  }
  async function onResume(): Promise<void> {
    if (!currentProjectId.value) return
    await window.api.director.resume(currentProjectId.value)
  }
  async function onCancel(): Promise<void> {
    if (!currentProjectId.value) return
    try {
      await ElMessageBox.confirm('确定取消当前任务吗？未完成的渲染结果会保留，但流水线将终止。', '取消任务', {
        type: 'warning',
        confirmButtonText: '取消任务',
        cancelButtonText: '再想想'
      })
    } catch { return }
    await window.api.director.cancel(currentProjectId.value)
    ElMessage.warning('任务取消中')
  }
  async function openFinalFolder(): Promise<void> {
    if (state.value?.finalPath) await window.api.shell.showItem(state.value.finalPath)
  }

  /** 路由项目切换：清空 state 与本地日志，等待 hydrate 重新填充 */
  function resetForRouteSwitch(): void {
    state.value = null
    localLogs.value = []
  }

  return {
    state, localLogs, expandedStages,
    stageOrder: STAGE_ORDER, stageLabels: STAGE_LABELS, levelText: LEVEL_TEXT,
    gateOptions: GATE_OPTIONS,
    running, paused, currentProjectId,
    logsByStage,
    isGate, groupHasError, formatTime,
    mergeLogs, hydrate,
    subscribe, unsubscribeAll,
    onPause, onResume, onCancel, openFinalFolder,
    resetForRouteSwitch
  }
}
