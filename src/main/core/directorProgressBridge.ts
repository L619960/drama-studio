import type { DirectorState } from '../../shared/ipcTypes'
import type { DirectorAgent } from './directorAgent'
import { freshStateImpl, logImpl, setStageImpl } from './directorStateMachine'

/**
 * 进度桥：非流水线直渲入队（分镜页点渲染、对话 agent 重渲）的影子任务进度上报，
 * 以及流水线运行期的渲染进度订阅/退订。
 */

/** 只发事件不落盘（影子任务专用，避免重启后恢复出假运行状态） */
export function emitProgressEventImpl(agent: DirectorAgent, projectId: string): void {
  const state = agent.states.get(projectId)
  if (!state) return
  agent.emit('progress', { type: 'director:progress', projectId, state })
}

/** 项目数据已落盘（资产/分镜/渲染产物）→ 通知前端刷新面板 */
export function notifyProjectUpdatedImpl(agent: DirectorAgent, projectId: string): void {
  agent.emit('projectUpdated', { type: 'director:project-updated', projectId })
}

/** 直渲入队的影子任务：无流水线 state 时创建轻量 state（仅内存，不持久化，重启无残留） */
export function ensureShadowStateImpl(agent: DirectorAgent, projectId: string): DirectorState {
  let state = agent.states.get(projectId)
  if (state) {
    if (state.running) return state
    // 上一轮已收尾（影子或流水线）：重开一轮渲染监控，历史日志保留
    state.running = true
    delete state.finishedAt
    state.doneShots = 0
    state.failedShotIds = []
    agent.shadowSettledShots.set(projectId, new Set())
    state.stages.render = { status: 'running', message: '渲染队列执行中', percent: 0 }
    agent.shadowRenders.add(projectId)
    emitProgressEventImpl(agent, projectId)
    return state
  }
  state = freshStateImpl(agent, projectId, '渲染队列')
  state.stages.render = { status: 'running', message: '渲染队列执行中', percent: 0 }
  agent.states.set(projectId, state)
  agent.shadowSettledShots.set(projectId, new Set())
  agent.shadowRenders.add(projectId)
  void agent.store
    .get(projectId)
    .then((p) => {
      state!.title = p.title
      // 影子渲染无流水线计数：totalShots/doneShots 从项目实际分镜补齐，
      // 避免概览误显示「镜头 0/0 完成 N 失败」（只统计流水线数字导致口径失真）
      if (state!.totalShots === 0 && p.shots?.length) {
        state!.totalShots = p.shots.length
        state!.doneShots = p.shots.filter((s: { status?: string }) => s.status === 'done').length
        state!.failedShotIds = p.shots
          .filter((s: { status?: string }) => s.status === 'failed')
          .map((s: { id: string }) => s.id)
      }
      emitProgressEventImpl(agent, projectId)
    })
    .catch(() => undefined)
  emitProgressEventImpl(agent, projectId)
  return state
}

/** 非流水线直渲的进度 → 执行日志（关键节点记日志，percent 心跳不记防刷屏） */
export function onExternalProgressImpl(
  agent: DirectorAgent,
  e: { projectId?: string; shotId?: string; step?: string; percent?: number; message?: string },
): void {
  const projectId = e.projectId
  const shotId = e.shotId || ''
  if (!projectId || agent.progressUnsubs.has(projectId)) return
  const state = ensureShadowStateImpl(agent, projectId)
  const key = `${projectId}:${shotId}`
  const prev = agent.lastStepByShot.get(key)
  agent.lastStepByShot.set(key, e.step || '')
  const msg = e.message || ''

  if (e.step === 'render' && prev !== 'render') {
    logImpl(agent, projectId, 'render', 'info', `镜头 ${shotId} 开始渲染`)
    state.stages.render.message = '渲染队列执行中'
    emitProgressEventImpl(agent, projectId)
  } else if (msg.includes('显存不足')) {
    logImpl(agent, projectId, 'render', 'warn', msg)
  } else if (e.step === 'combine' && e.percent === 99 && msg) {
    logImpl(agent, projectId, 'render', 'info', msg) // 一致性校验结论等收尾信息
  }

  if (e.step === 'done') {
    // M-15：同一镜二次完成（审批重渲/手动重渲）不重复计数
    let settled = agent.shadowSettledShots.get(projectId)
    if (!settled) {
      settled = new Set()
      agent.shadowSettledShots.set(projectId, settled)
    }
    if (!settled.has(shotId)) {
      settled.add(shotId)
      state.doneShots++
    }
    logImpl(agent, projectId, 'render', 'success', `镜头 ${shotId} 渲染完成`)
    agent.lastStepByShot.delete(key)
    emitProgressEventImpl(agent, projectId)
  } else if (e.step === 'failed') {
    // 同镜重复失败也去重，防止 finish 文案里失败数虚增
    if (!state.failedShotIds.includes(shotId)) state.failedShotIds.push(shotId)
    logImpl(agent, projectId, 'render', 'error', `镜头 ${shotId} 渲染失败：${msg || '未知原因'}`)
    agent.lastStepByShot.delete(key)
    emitProgressEventImpl(agent, projectId)
  } else if (e.step === 'queued' && msg === '已取消') {
    logImpl(agent, projectId, 'render', 'warn', `镜头 ${shotId} 已取消`)
    agent.lastStepByShot.delete(key)
  }
}

/** 影子渲染队列排空：收尾 render 阶段并停表 */
export function onExternalQueueFinishedImpl(agent: DirectorAgent, projectId: string): void {
  if (!agent.shadowRenders.has(projectId)) return
  agent.shadowRenders.delete(projectId)
  agent.shadowSettledShots.delete(projectId)
  const state = agent.states.get(projectId)
  if (!state) return
  const failed = state.failedShotIds.length
  state.stages.render = {
    status: failed > 0 ? 'error' : 'done',
    message:
      failed > 0
        ? `本批渲染完成：成功 ${state.doneShots} · 失败 ${failed}（可在分镜页重渲失败镜头）`
        : `本批渲染完成：成功 ${state.doneShots} 镜`,
    percent: 100,
  }
  state.running = false
  state.finishedAt = Date.now()
  logImpl(
    agent,
    projectId,
    'render',
    failed > 0 ? 'warn' : 'success',
    failed > 0
      ? `渲染队列已排空（成功 ${state.doneShots} · 失败 ${failed}）`
      : `渲染队列已排空，成功 ${state.doneShots} 镜`,
  )
  emitProgressEventImpl(agent, projectId)
}

export function subscribeRenderProgressImpl(agent: DirectorAgent, projectId: string): void {
  agent.unsubscribeRenderProgress(projectId)
  // 从磁盘按 shot.status 重算已完成数：heal/审批重渲会重复触发 done 事件，
  // 累计 ++ 会导致 doneShots 虚增（实测 16 镜重渲 4 镜后显示 20）。
  const refreshDone = (): void => {
    void agent.store
      .get(projectId)
      .then((p) => {
        const s = agent.states.get(projectId)
        if (!s) return
        s.doneShots = p.shots.filter((x) => x.status === 'done').length
        setStageImpl(
          agent,
          projectId,
          'render',
          'running',
          `渲染中 ${s.doneShots}/${s.totalShots}...`,
          Math.round((s.doneShots / Math.max(1, s.totalShots)) * 100),
        )
      })
      .catch(() => undefined)
  }
  const listener = (e: { projectId?: string; shotId?: string; step?: string }): void => {
    if (e.projectId !== projectId) return
    const state = agent.states.get(projectId)
    if (!state) return
    if (e.step === 'done') {
      logImpl(agent, projectId, 'render', 'success', `镜头 ${e.shotId} 渲染完成`)
      refreshDone()
    }
    if (e.step === 'failed') {
      logImpl(agent, projectId, 'render', 'error', `镜头 ${e.shotId} 渲染失败，跳过并继续后续镜头`)
      refreshDone()
    }
  }
  agent.queue.on('progress', listener)
  agent.progressUnsubs.set(projectId, () => agent.queue.off('progress', listener))
}

export function unsubscribeRenderProgressImpl(agent: DirectorAgent, projectId: string): void {
  agent.progressUnsubs.get(projectId)?.()
  agent.progressUnsubs.delete(projectId)
}
