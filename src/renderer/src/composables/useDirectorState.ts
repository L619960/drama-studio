import { computed, ref, watch, type Ref } from 'vue'
import { ElMessage } from 'element-plus'
import { confirmDanger, confirmAction } from '../utils/confirm'
import { showUndoToast } from '../utils/undoToast'
import type { DirectorState, DirectorStage, DirectorLogEntry } from '../../../shared/ipcTypes'

/** 工作流九阶段顺序（与 [directorAgent.ts](../../../../../main/core/directorAgent.ts) STAGE_ORDER 同构，UI 本地副本） */
export const STAGE_ORDER: DirectorStage[] = [
  'analyze',
  'casting',
  'scenes',
  'render',
  'combine',
  'subtitle',
  'review',
  'bgm',
  'done',
]

/** 阶段中文标签（与主进程 STAGE_LABELS 对齐） */
export const STAGE_LABELS: Record<DirectorStage, string> = {
  analyze: '剧本分析',
  casting: '角色建档',
  scenes: '场景板与首尾帧',
  render: '逐镜渲染 · 审批',
  combine: '拼接成片',
  subtitle: '烧录字幕',
  review: '成片复审',
  bgm: 'BGM 混音',
  done: '完成',
}

export const LEVEL_TEXT = { info: '信息', success: '成功', warn: '警告', error: '错误' } as const

/** 开拍弹窗里的阶段确认点选项 */
export const GATE_OPTIONS = [
  { value: 'analyze', label: '剧本分析（核对角色与分镜）' },
  { value: 'casting', label: '角色建档（核对面部定妆与三视图）' },
  { value: 'scenes', label: '场景板与首尾帧（核对场景库与每镜首/尾帧）' },
  { value: 'render', label: '逐镜渲染与审批' },
  { value: 'combine', label: '拼接成片' },
  { value: 'subtitle', label: '烧录字幕' },
  { value: 'review', label: '成片复审（配乐前最后一关）' },
] as const

// ===== 纯工具函数（R-13：唯一实现，WorkflowPanel/DirectorChat 直接 import，不再各自复制）=====

/** 按九阶段顺序分组日志（只保留有日志的阶段） */
export function groupLogsByStage(
  entries: DirectorLogEntry[],
): Array<{ stage: DirectorStage; entries: DirectorLogEntry[] }> {
  const map = new Map<DirectorStage, DirectorLogEntry[]>()
  for (const e of entries) {
    const arr = map.get(e.stage) || []
    arr.push(e)
    map.set(e.stage, arr)
  }
  return STAGE_ORDER.filter((s) => map.has(s)).map((stage) => ({ stage, entries: map.get(stage)! }))
}

/** 该阶段是否为确认点（暂停门） */
export function isGateStage(state: DirectorState | null, stage: DirectorStage): boolean {
  return state?.gateStages.includes(stage) ?? false
}

/** 日志组内是否有 error 级条目 */
export function groupHasError(g: { entries: DirectorLogEntry[] }): boolean {
  return g.entries.some((e) => e.level === 'error')
}

/** 日志时间戳 → HH:mm */
export function formatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 阶段日志组耗时（首末条时间差，秒）。不足 1s 或单条返回 0（不展示） */
export function groupDurationSec(entries: DirectorLogEntry[]): number {
  if (entries.length < 2) return 0
  const first = entries[0]
  const last = entries[entries.length - 1]
  if (!first || !last) return 0
  return Math.max(0, Math.round((last.timestamp - first.timestamp) / 1000))
}

/** 秒 → 中文时长（<60s 显示「Ns」，否则「N分M秒」） */
export function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}分${sec % 60}秒`
}

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

  const logsByStage = computed(() => groupLogsByStage(localLogs.value))

  function isGate(stage: DirectorStage): boolean {
    return isGateStage(state.value, stage)
  }

  // 合并日志（按 id 去重，保持顺序，上限 300 条）
  function mergeLogs(entries: DirectorLogEntry[]): void {
    if (!entries.length) return
    const known = new Set(localLogs.value.map((e) => e.id))
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
  watch(
    () => {
      const s = state.value
      if (!s) return ''
      const cur = STAGE_ORDER.find((st) => s.stages[st].status === 'running') || ''
      return `${cur}|${s.paused}`
    },
    (sig) => {
      const [cur = '', pausedFlag] = sig.split('|')
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
    },
  )

  // 装载序号：每次发起 hydrate/hydrateLatest 递增，响应回来时序号已变
  // 说明期间发生了路由切换/新装载，过期结果直接丢弃，防止旧项目状态覆盖新项目
  let hydrateSeq = 0

  async function hydrate(id: string): Promise<void> {
    const seq = ++hydrateSeq
    let s: DirectorState | null
    try {
      s = await window.api.director.getState(id)
    } catch (e) {
      // 被动后台拉取失败不打扰用户（状态面板本身会显示空态），仅留痕
      console.warn('[director] hydrate 失败:', e)
      return
    }
    if (seq !== hydrateSeq) return
    if (!s) return
    state.value = s
    mergeLogs(s.logs || [])
    const cur = STAGE_ORDER.find((st) => s.stages[st].status === 'running')
    if (cur) expandedStages.value = [cur]
  }

  /** 全局控制台（未绑定项目）：展示最近活跃任务（含影子渲染），后续事件自动跟随其 projectId */
  async function hydrateLatest(): Promise<void> {
    const seq = ++hydrateSeq
    let s: DirectorState | null
    try {
      s = await window.api.director.getLatestState()
    } catch (e) {
      console.warn('[director] hydrateLatest 失败:', e)
      return
    }
    if (seq !== hydrateSeq) return
    if (!s) return
    state.value = s
    mergeLogs(s.logs || [])
    const cur = STAGE_ORDER.find((st) => s.stages[st].status === 'running')
    if (cur) expandedStages.value = [cur]
  }

  let unsubProgress: (() => void) | null = null
  let unsubLog: (() => void) | null = null

  function subscribe(): void {
    // 先清旧监听再订阅：组件复用/HMR 时防止重复订阅导致事件双份处理
    unsubscribeAll()
    unsubProgress = window.api.director.onProgress((e) => {
      if (currentProjectId.value && e.projectId !== currentProjectId.value) return
      // 全局控制台跟随最新活跃任务：事件切到另一个项目时整体切换上下文，
      // 只重置日志不重排状态——否则两个项目的时间线会混流
      if (state.value && state.value.projectId !== e.projectId) localLogs.value = []
      state.value = e.state
      mergeLogs(e.state.logs || [])
    })
    unsubLog = window.api.director.onLog((e) => {
      if (currentProjectId.value && e.projectId !== currentProjectId.value) return
      // 日志来自另一个项目（全局控制台/新项目首条事件）：整体切换上下文而非追加，防混流
      if (state.value && state.value.projectId !== e.projectId) {
        void hydrate(e.projectId)
        return
      }
      // 首条日志到达但 state 尚未加载（如直渲影子任务中途切到本面板）：拉一次全量
      if (!state.value) void hydrate(e.projectId)
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
    try {
      await window.api.director.pause(currentProjectId.value)
      ElMessage.info('已请求暂停，当前阶段结束后自动停下')
    } catch (e) {
      ElMessage.error(`暂停失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  async function onResume(): Promise<void> {
    if (!currentProjectId.value) return
    try {
      await window.api.director.resume(currentProjectId.value)
      ElMessage.success('已继续执行')
    } catch (e) {
      ElMessage.error(`继续失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** A 断点续跑：从指定阶段重跑（此前已完成阶段跳过） */
  async function onResumeFrom(stage: DirectorStage): Promise<void> {
    if (!currentProjectId.value) return
    try {
      await window.api.director.resumeFrom(currentProjectId.value, stage)
      localLogs.value = []
      ElMessage.success(`已从「${STAGE_LABELS[stage]}」阶段继续执行`)
      await hydrate(currentProjectId.value)
    } catch (e) {
      ElMessage.error(e instanceof Error ? e.message : String(e))
    }
  }

  /** D 批量重试失败镜头：把当前失败清单重新入队（完成镜头不受影响） */
  async function retryFailedShots(): Promise<void> {
    const pid = currentProjectId.value
    const failed = state.value?.failedShotIds || []
    if (!pid || failed.length === 0) return
    try {
      await window.api.render.start(pid, failed)
      ElMessage.success(`已重新入队 ${failed.length} 个失败镜头`)
    } catch (e) {
      ElMessage.error(`重试失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  /** 停止当前正在执行的任务（仅运行中可触发，含已暂停状态） */
  async function onCancel(): Promise<void> {
    if (!currentProjectId.value) return
    // 仅运行中（含暂停）允许停止；非运行态按钮本身不展示，此处做二次兜底
    if (!state.value?.running) {
      ElMessage.info('当前没有正在执行的任务')
      return
    }
    const okStop = await confirmDanger('确定停止当前任务吗？进行中的渲染会被终止，已产出的素材会保留。', {
      title: '停止任务',
      confirmText: '停止任务',
      cancelText: '再想想',
    })
    if (!okStop) return
    try {
      await window.api.director.cancel(currentProjectId.value)
      ElMessage.success('已发送停止请求，任务将尽快终止')
    } catch (e) {
      ElMessage.error(`停止任务失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 清空已结束的任务状态与日志，让工作台回到待命态（仅非运行时可用） */
  async function onClearTask(): Promise<void> {
    if (!currentProjectId.value) return
    if (state.value?.running) {
      ElMessage.warning('任务执行中，请先停止任务再清空')
      return
    }
    if (!state.value) {
      ElMessage.info('当前没有可清空的任务')
      return
    }
    const okClear = await confirmAction('清空当前任务的执行状态与日志？已产出的素材文件不会删除，仅清空工作台展示。', {
      title: '清空任务',
      confirmText: '清空',
    })
    if (!okClear) return
    // REQ-16：暂存清空前的状态与日志，撤销时恢复本地展示（主进程侧任务态不回头）
    const prevState = state.value
    const prevLogs = localLogs.value
    state.value = null
    localLogs.value = []
    // 同步清空主进程侧任务态（directorClearState 通道）；失败不阻断本地 UI 清空
    await window.api.director.clearState(currentProjectId.value).catch(() => {})
    showUndoToast(
      '任务状态已清空',
      () => {
        if (state.value) return
        state.value = prevState
        localLogs.value = prevLogs
        ElMessage.success('已撤销清空')
      },
      () => {},
    )
  }

  async function openFinalFolder(): Promise<void> {
    if (!state.value?.finalPath) return
    try {
      await window.api.shell.showItem(state.value.finalPath)
    } catch {
      ElMessage.warning('成片文件不存在或已被移动')
    }
  }

  /** 路由项目切换：清空 state 与本地日志，等待 hydrate 重新填充 */
  function resetForRouteSwitch(): void {
    state.value = null
    localLogs.value = []
  }

  return {
    state,
    localLogs,
    expandedStages,
    stageOrder: STAGE_ORDER,
    stageLabels: STAGE_LABELS,
    levelText: LEVEL_TEXT,
    gateOptions: GATE_OPTIONS,
    running,
    paused,
    currentProjectId,
    logsByStage,
    isGate,
    groupHasError,
    formatTime,
    mergeLogs,
    hydrate,
    hydrateLatest,
    subscribe,
    unsubscribeAll,
    onPause,
    onResume,
    onResumeFrom,
    retryFailedShots,
    onCancel,
    onClearTask,
    openFinalFolder,
    resetForRouteSwitch,
  }
}
