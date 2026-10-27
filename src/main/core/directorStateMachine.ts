import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {
  DirectorState, DirectorStage, StageState, StageStatus, DirectorLogEntry
} from '../../shared/ipcTypes'
import { reviewedIsValid } from '../../shared/pipelineGuards'
import { atomicWriteJson } from './fsUtil'
import { STAGE_ORDER, STAGE_LABELS, stageIndexOf, LOG_LIMIT } from './directorConstants'
import type { DirectorAgent } from './directorAgent'

/**
 * 导演状态机：13 个 Map/Set 持有在 DirectorAgent 实例上，
 * 本模块提供状态读写 / 日志 / 持久化 / 阶段门 / 断点续跑恢复等纯状态操作。
 * 每个函数接收 agent 作为上下文（this. → agent.），行为与原类方法一致。
 */

export function freshStateImpl(
  agent: DirectorAgent,
  projectId: string,
  title: string
): DirectorState {
  const stages = {} as Record<DirectorStage, StageState>
  for (const stage of STAGE_ORDER) {
    stages[stage] = { status: 'pending', message: '', percent: 0 }
  }
  return {
    projectId,
    title,
    running: true,
    cancelled: false,
    paused: false,
    gateStages: [],
    stages,
    totalShots: 0,
    doneShots: 0,
    failedShotIds: [],
    startedAt: Date.now(),
    logs: []
  }
}

export function isCancelledImpl(agent: DirectorAgent, projectId: string): boolean {
  return agent.cancelled.has(projectId)
}

/** 找到当前正在运行的阶段（用于暂停提示归属） */
export function currentStageImpl(state: DirectorState): DirectorStage {
  for (const stage of STAGE_ORDER) {
    if (state.stages[stage].status === 'running') return stage
  }
  return 'done'
}

export function setStageImpl(
  agent: DirectorAgent,
  projectId: string,
  stage: DirectorStage,
  status: StageStatus,
  message: string,
  percent?: number
): void {
  const state = agent.states.get(projectId)
  if (!state) return
  const st = state.stages[stage]
  st.status = status
  if (message !== undefined) st.message = message
  if (percent !== undefined) st.percent = percent
  // 状态变化同步为中文日志（running 的重复进度消息抑制，避免刷屏）
  if (message && status !== 'pending') {
    const key = `${projectId}:${stage}`
    const last = agent.lastStageMsg.get(key)
    if (status !== 'running' || last !== message) {
      agent.lastStageMsg.set(key, message)
      const level = status === 'done' ? 'success'
        : status === 'error' ? 'error'
        : status === 'skipped' ? 'warn' : 'info'
      logImpl(agent, projectId, stage, level, `${STAGE_LABELS[stage]} · ${message}`)
    }
  }
  emitStateImpl(agent, projectId)
}

/** 追加一条中文执行日志并推送给面板 */
export function logImpl(
  agent: DirectorAgent,
  projectId: string,
  stage: DirectorStage,
  level: 'info' | 'success' | 'warn' | 'error',
  message: string
): void {
  const state = agent.states.get(projectId)
  if (!state || !message) return
  const seq = (agent.logSeq.get(projectId) || 0) + 1
  agent.logSeq.set(projectId, seq)
  const entry: DirectorLogEntry = { id: seq, stage, level, message, timestamp: Date.now() }
  state.logs.push(entry)
  if (state.logs.length > LOG_LIMIT) {
    state.logs.splice(0, state.logs.length - LOG_LIMIT)
  }
  agent.emit('log', { type: 'director:log', projectId, entry })
}

export function emitStateImpl(agent: DirectorAgent, projectId: string): void {
  const state = agent.states.get(projectId)
  if (!state) return
  state.cancelled = agent.cancelled.has(projectId)
  agent.emit('progress', { type: 'director:progress', projectId, state })
  void persistImpl(agent, projectId)
}

export async function persistImpl(agent: DirectorAgent, projectId: string): Promise<void> {
  const state = agent.states.get(projectId)
  if (!state) return
  const file = path.join(
    agent.baseDir, 'projects', projectId, 'director-state.json'
  )
  await fs.mkdir(path.dirname(file), { recursive: true })
  await atomicWriteJson(file, state)
}

/**
 * 阶段间确认点：命中配置门或用户手动暂停时挂起流水线，
 * 等待 resume/cancel 放行。进行中的渲染不受影响（调用点均在阶段边界）。
 */
export async function maybeGateImpl(
  agent: DirectorAgent,
  projectId: string,
  afterStage: DirectorStage
): Promise<void> {
  if (isCancelledImpl(agent, projectId)) return
  const hitGate = agent.gates.get(projectId)?.has(afterStage) ?? false
  if (!hitGate && !agent.pauseRequested.has(projectId)) return
  const state = agent.states.get(projectId)
  if (!state) return
  state.paused = true
  agent.pauseRequested.delete(projectId)
  logImpl(agent, projectId, afterStage, 'warn',
    `「${STAGE_LABELS[afterStage]}」阶段已完成，任务暂停，确认后继续`)
  emitStateImpl(agent, projectId)
  await new Promise<void>(resolve => agent.waiters.set(projectId, resolve))
  if (!isCancelledImpl(agent, projectId)) {
    logImpl(agent, projectId, afterStage, 'info', '已继续执行下一阶段')
  }
}

/**
 * 分镜首帧门：render.shotReviewGate==='block' 且有未审 i2v 镜时挂起流水线，
 * 等用户逐镜核对后 resume/cancel 放行。'warn' 只告警放行；'off' 不检查。
 * @returns true 可继续渲染；false 已取消。
 */
export async function pauseUntilShotsReviewedImpl(
  agent: DirectorAgent,
  projectId: string
): Promise<boolean> {
  const settings = await agent.settings.get()
  const gate = settings.render?.shotReviewGate ?? 'block'
  if (gate === 'off') return true
  const project = await agent.store.get(projectId)
  const unreviewed = project.shots
    .filter(s => s.type === 'i2v' && !reviewedIsValid(s.type, s.reviewed, s.firstFramePath))
  if (unreviewed.length === 0) return true
  if (gate === 'warn') {
    logImpl(agent, projectId, 'render', 'warn', `${unreviewed.length} 镜未核对分镜图（按设置告警放行）`)
    return true
  }
  const state = agent.states.get(projectId)
  if (!state) return false
  state.paused = true
  const names = unreviewed.slice(0, 5).map(s => `第${s.index}镜`).join('、')
  logImpl(agent, projectId, 'render', 'warn',
    `分镜审核门：${unreviewed.length} 镜未核对分镜图，已暂停等待审核（可在分镜页逐镜核对/重出首帧后继续）`)
  setStageImpl(agent, projectId, 'render', 'paused',
    `等待分镜审核：${names}${unreviewed.length > 5 ? ` 等 ${unreviewed.length} 镜` : ''}未核对分镜图`, 0)
  await new Promise<void>(resolve => agent.waiters.set(projectId, resolve))
  return !isCancelledImpl(agent, projectId)
}

export function getStateImpl(agent: DirectorAgent, projectId: string): DirectorState | null {
  return agent.states.get(projectId) || null
}

/** 最近活跃的任务状态（含影子渲染任务）：全局控制台没有绑定项目，用它展示最近一次工作 */
export function getLatestStateImpl(agent: DirectorAgent): DirectorState | null {
  let latest: DirectorState | null = null
  let latestAt = 0
  for (const state of agent.states.values()) {
    const lastLog = state.logs[state.logs.length - 1]
    const at = Math.max(lastLog?.timestamp || 0, state.finishedAt || 0, state.startedAt || 0)
    if (at > latestAt) {
      latestAt = at
      latest = state
    }
  }
  return latest
}

/**
 * 清空某项目的全部运行时残留。
 * 前端切换/关闭项目时调用，防止幽灵流水线、渲染进度监听器、gate 等待器跨项目泄漏。
 */
export function clearStateImpl(agent: DirectorAgent, projectId: string): void {
  agent.states.delete(projectId)
  agent.cancelled.delete(projectId)
  agent.gates.delete(projectId)
  agent.pauseRequested.delete(projectId)
  agent.waiters.delete(projectId)
  agent.logSeq.delete(projectId)
  agent.healBudget.delete(projectId)
  agent.shadowSettledShots.delete(projectId)
  agent.visionWarned.delete(projectId)
  agent.shadowRenders.delete(projectId)
  for (const key of [
    ...agent.lastStageMsg.keys(),
    ...agent.lastStepByShot.keys()
  ]) {
    if (key.startsWith(`${projectId}:`)) {
      agent.lastStageMsg.delete(key)
      agent.lastStepByShot.delete(key)
    }
  }
  agent.unsubscribeRenderProgress(projectId)
}

/**
 * 崩溃/重启恢复：内存无状态且磁盘有 director-state.json 时回填。
 * 恢复回来的 running 状态一律降级为「已中断」展示，防止显示假运行。
 */
export async function hydrateImpl(
  agent: DirectorAgent,
  projectId: string
): Promise<DirectorState | null> {
  const existing = agent.states.get(projectId)
  if (existing) return existing
  try {
    const file = path.join(agent.baseDir, 'projects', projectId, 'director-state.json')
    const raw = await fs.readFile(file, 'utf-8')
    const state = JSON.parse(raw) as DirectorState
    let repaired = false
    if (state.running || state.paused) {
      state.running = false
      state.paused = false
      state.finishedAt = Date.now()
      // 残留的 running 阶段转为 error：否则 UI 永久转圈，且「从此重跑」按钮
      // （仅对 done/error 阶段显示）不会出现，断点续跑入口被锁死
      for (const stage of STAGE_ORDER) {
        if (state.stages[stage].status === 'running') {
          state.stages[stage] = {
            status: 'error',
            message: '应用重启导致该阶段中断',
            percent: state.stages[stage].percent
          }
        }
      }
      // 续用日志序号器：从磁盘日志的最大 id 起算，保证唯一
      const maxId = state.logs.reduce((m, l) => Math.max(m, typeof l.id === 'number' ? l.id : 0), 0)
      const seq = Math.max(agent.logSeq.get(projectId) || 0, maxId) + 1
      agent.logSeq.set(projectId, seq)
      state.logs.push({
        id: seq,
        stage: 'done',
        level: 'warn',
        message: '应用重启，上次任务已中断（渲染产物保留，可从失败阶段重跑续传）',
        timestamp: Date.now()
      })
      repaired = true
    }
    agent.states.set(projectId, state)
    // 必须先入内存再落盘：persist 从 agent.states 取状态，顺序反了会被静默跳过
    if (repaired) void persistImpl(agent, projectId).catch(() => undefined)
    return state
  } catch {
    return null
  }
}
