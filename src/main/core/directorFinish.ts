import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Project, Shot } from '../../shared/ipcTypes'
import type { AuditCheckItem } from './skillLibrary'
import { FACE_CONSISTENCY_THRESHOLD } from './consistencyService'
import type { DirectorAgent } from './directorAgent'
import { logImpl, setStageImpl, emitStateImpl, isCancelledImpl } from './directorStateMachine'
import {
  subscribeRenderProgressImpl, unsubscribeRenderProgressImpl, notifyProjectUpdatedImpl
} from './directorProgressBridge'

/**
 * 审核与收尾：流水线 finish、状态淘汰、逐镜即时审核、批量审批。
 */

export function finishImpl(agent: DirectorAgent, projectId: string, doneMessage?: string): void {
  const state = agent.states.get(projectId)
  if (!state) return
  const wasCancelled = agent.cancelled.has(projectId)
  state.running = false
  state.paused = false
  state.cancelled = wasCancelled
  state.stages.done = {
    status: state.cancelled ? 'skipped' : 'done',
    message: doneMessage
      || (state.finalPath
        ? `成片: ${state.finalPath}`
        : state.cancelled ? '已取消' : '未产出成片'),
    percent: 100
  }
  state.finishedAt = Date.now()
  agent.pauseRequested.delete(projectId)
  agent.waiters.delete(projectId)
  agent.gates.delete(projectId)
  agent.healBudget.delete(projectId)
  unsubscribeRenderProgressImpl(agent, projectId)
  logImpl(agent, projectId, 'done',
    state.cancelled ? 'warn' : (doneMessage ? 'error' : 'success'),
    state.cancelled ? '任务已取消' : (doneMessage || '全部完成，成片已产出'))
  // emitState 内部会按 cancelled 集合重算 state.cancelled：
  // 必须在 emitState 之后才从集合删除，否则取消标志被覆盖回 false（D1 自相矛盾）
  emitStateImpl(agent, projectId)
  agent.cancelled.delete(projectId)
  // lastStageMsg 的 key 形如 `${projectId}:${stage}`，按前缀清理
  for (const key of [...agent.lastStageMsg.keys()]) {
    if (key.startsWith(`${projectId}:`)) agent.lastStageMsg.delete(key)
  }
  evictFinishedStatesImpl(agent)
}

/** 淘汰已完成超过 1 小时的任务状态，防止长跑内存膨胀。 */
export function evictFinishedStatesImpl(agent: DirectorAgent): void {
  const cutoff = Date.now() - 60 * 60 * 1000
  for (const [pid, st] of agent.states) {
    if (!st.running && st.finishedAt && st.finishedAt < cutoff) {
      agent.states.delete(pid)
      agent.logSeq.delete(pid)
    }
  }
}

/**
 * 提示式渲染（非阻塞）：逐镜渲染，渲完一镜立即进下一镜。
 */
export async function renderShotsWithAuditImpl(
  agent: DirectorAgent,
  projectId: string,
  shotDurations: Map<string, number>
): Promise<void> {
  const checklist = await agent.skills.auditChecklist()
  subscribeRenderProgressImpl(agent, projectId)
  try {
    const project = await agent.store.get(projectId)
    const targets = project.shots.filter(s => s.status === 'pending' || s.status === 'failed')
    const total = targets.length
    let doneCount = 0
    let notPassed = 0
    for (const shot of targets) {
      if (isCancelledImpl(agent, projectId)) break
      await agent.queue.start(projectId, [shot.id])
      await agent.queue.waitForFinish(projectId)

      const fresh = await agent.store.get(projectId)
      const cur = fresh.shots.find(s => s.id === shot.id)
      if (!cur || cur.status !== 'done') continue // 渲染失败，交给 C 自愈

      try {
        const audit = await auditSingleShotImpl(agent, projectId, cur, fresh, checklist, true)
        if (audit.durationSec >= 0) shotDurations.set(cur.id, audit.durationSec)
        cur.auditHint = audit.passed
          ? undefined
          : `${audit.reason}${audit.fixHint ? '；建议：' + audit.fixHint : ''}`
        if (!audit.passed) notPassed++
        await agent.store.save(fresh)
        notifyProjectUpdatedImpl(agent, projectId)
        logImpl(agent, projectId, 'render', audit.passed ? 'info' : 'warn',
          audit.passed
            ? `第${cur.index}镜「${cur.scene}」渲染完成`
            : `第${cur.index}镜「${cur.scene}」渲染完成但有提示：${audit.reason}（可在分镜页编辑重渲）`)
      } catch (e) {
        logImpl(agent, projectId, 'render', 'warn',
          `第${cur.index}镜审核留痕失败：${e instanceof Error ? e.message : String(e)}`)
      }
      doneCount++
      setStageImpl(agent, projectId, 'render', 'running',
        `渲染 ${doneCount}/${total}...`, Math.round((doneCount / Math.max(1, total)) * 100))
    }
    if (notPassed > 0) {
      logImpl(agent, projectId, 'render', 'warn', `本轮共 ${notPassed} 镜次未过审（含整改后放行），已在分镜页留痕`)
    }
  } finally {
    unsubscribeRenderProgressImpl(agent, projectId)
  }
}

/**
 * 单镜即时审核（看守）：技术校验 + 一致性 + LLM 视觉审核。
 */
export async function auditSingleShotImpl(
  agent: DirectorAgent,
  projectId: string,
  shot: Shot,
  project: Project,
  checklist: AuditCheckItem[],
  skipVision = false
): Promise<{
  passed: boolean
  reason: string
  fixHint?: string
  durationSec: number
  vision: boolean
}> {
  const abs = shot.segmentPath
    ? path.join(agent.baseDir, shot.segmentPath)
    : shot.rawVideoPath
      ? path.join(agent.baseDir, shot.rawVideoPath)
      : null
  if (!abs) {
    return { passed: false, reason: '产物文件缺失', fixHint: undefined, durationSec: -1, vision: false }
  }
  try {
    await fs.access(abs)
  } catch {
    return { passed: false, reason: '产物文件不存在', fixHint: undefined, durationSec: -1, vision: false }
  }

  let dur: number
  try {
    dur = await agent.ffmpeg.getDuration(abs)
  } catch {
    return { passed: false, reason: '视频信息读取失败', fixHint: undefined, durationSec: -1, vision: false }
  }
  if (dur < 0.8) {
    return { passed: false, reason: `时长过短（${dur.toFixed(1)}s）`, fixHint: undefined, durationSec: dur, vision: false }
  }
  if (await agent.ffmpeg.looksLikeBlankVideo(abs)) {
    return { passed: false, reason: '画面疑似纯色/黑帧', fixHint: undefined, durationSec: dur, vision: false }
  }

  const consistencyMode = (await agent.settings.get()).render.consistencyMode || 'warn'
  if (
    consistencyMode === 'rerender' &&
    shot.type === 'i2v' &&
    typeof shot.consistencyScore === 'number' &&
    shot.consistencyScore < FACE_CONSISTENCY_THRESHOLD
  ) {
    return {
      passed: false,
      reason: `人物一致性偏低（${shot.consistencyScore.toFixed(2)} < ${FACE_CONSISTENCY_THRESHOLD}）`,
      fixHint: 'keep exact face identity, hairstyle and outfit from the reference image, no facial change',
      durationSec: dur,
      vision: false
    }
  }

  if (skipVision) {
    return { passed: true, reason: '', fixHint: undefined, durationSec: dur, vision: false }
  }
  if (!checklist.length) {
    return { passed: true, reason: '', fixHint: undefined, durationSec: dur, vision: false }
  }
  const char = project.characters.find(c => c.id === shot.characterIds[0])
  const board = (project.sceneBoards || []).find(b => b.id === shot.sceneBoardId)
  const audit = await agent.llm.auditImage({
    imagePath: abs,
    kind: 'video',
    checklist,
    context: {
      index: shot.index,
      scene: board?.name || shot.scene,
      character: char?.name || '空镜',
      action: shot.action || '',
      shotSize: shot.shotSize || 'medium',
      camera: shot.camera || 'static',
      lookEn: char?.appearanceLock || char?.description
    }
  }).catch(() => ({ visionUnavailable: true, passed: true, blockedProblems: [], fixHint: '' }))
  if (audit.visionUnavailable) {
    if (!agent.visionWarned.has(projectId)) {
      agent.visionWarned.add(projectId)
      logImpl(agent, projectId, 'render', 'warn',
        `当前 LLM 模型不支持视觉输入，本镜仅做技术审核（在设置→LLM 配置支持看图的多模态模型后可启用 AI 审图）`)
    }
    return { passed: true, reason: '', fixHint: undefined, durationSec: dur, vision: false }
  }
  if (!audit.passed) {
    return {
      passed: false,
      reason: audit.blockedProblems.join('；') || 'AI 视觉审核未通过',
      fixHint: audit.fixHint,
      durationSec: dur,
      vision: true
    }
  }
  return { passed: true, reason: '', fixHint: audit.fixHint || undefined, durationSec: dur, vision: true }
}

/**
 * 逐镜审批（严格质检关卡）：分段文件/音轨/时长/黑帧/角色混淆检查；
 * 未过审镜头换 seed 重渲一轮。
 */
export async function approveShotsImpl(agent: DirectorAgent, projectId: string): Promise<{
  approved: boolean
  problems: string[]
  retryIds: string[]
  durations: Map<string, number>
  warnings: string[]
}> {
  const inspect = async (): Promise<{
    problems: Map<string, string>
    durations: Map<string, number>
  }> => {
    const problems = new Map<string, string>()
    const durations = new Map<string, number>()
    const project = await agent.store.get(projectId)
    for (const shot of project.shots) {
      if (shot.status !== 'done' || !shot.segmentPath) continue
      const abs = path.join(agent.baseDir, shot.segmentPath)
      if (!(await agent.ffmpeg.fileExists(abs))) {
        problems.set(shot.id, `第${shot.index}镜「${shot.scene}」分段文件缺失`)
        continue
      }
      try {
        const info = await agent.ffmpeg.getVideoInfo(abs)
        const dur = Math.round(info.durationSec * 10) / 10
        durations.set(shot.id, dur)
        if (!info.hasAudio) {
          problems.set(shot.id, `第${shot.index}镜「${shot.scene}」无音轨`)
          continue
        }
        const expectSec = Math.max(1, Math.round((shot.frames - 1) / 16))
        if (dur < 0.8) {
          problems.set(shot.id, `第${shot.index}镜「${shot.scene}」时长过短（${dur.toFixed(1)}s）`)
          continue
        }
        if (Math.abs(dur - expectSec) > 3) {
          logImpl(
            agent, projectId, 'render', 'warn',
            `第${shot.index}镜「${shot.scene}」时长 ${dur.toFixed(1)}s（设定 ${expectSec}s），已放行`
          )
        }
      } catch {
        problems.set(shot.id, `第${shot.index}镜「${shot.scene}」视频信息读取失败`)
        continue
      }
      if (await agent.ffmpeg.looksLikeBlankVideo(abs)) {
        problems.set(shot.id, `第${shot.index}镜「${shot.scene}」画面疑似纯色/黑帧`)
        continue
      }
      if (shot.roleConfusion) {
        problems.set(shot.id, `第${shot.index}镜「${shot.scene}」角色混淆（脸部更像另一角色定妆），已拦下不混入成片`)
        continue
      }
    }
    return { problems, durations }
  }

  const consistencyMode = (await agent.settings.get()).render.consistencyMode || 'warn'
  const warnings = new Set<string>()
  const inspectWithConsistency = async () => {
    const base = await inspect()
    if (consistencyMode !== 'rerender') return base
    const project = await agent.store.get(projectId)
    for (const shot of project.shots) {
      if (base.problems.has(shot.id)) continue
      if (
        shot.type === 'i2v' &&
        typeof shot.consistencyScore === 'number' &&
        shot.consistencyScore < FACE_CONSISTENCY_THRESHOLD
      ) {
        warnings.add(
          `第${shot.index}镜「${shot.scene}」人物一致性偏低（${shot.consistencyScore.toFixed(2)} < ${FACE_CONSISTENCY_THRESHOLD}），已放行，可在分镜页手动重渲该镜`
        )
      }
    }
    return base
  }

  let { problems, durations } = await inspectWithConsistency()
  if (problems.size === 0) {
    return { approved: true, problems: [], retryIds: [], durations, warnings: [...warnings] }
  }

  const retryIds = [...problems.keys()]
  setStageImpl(agent, projectId, 'render', 'running',
    `${retryIds.length} 镜未过审（${[...problems.values()][0]}...），换种子重渲中...`, 92)
  const project = await agent.store.get(projectId)
  for (const shot of project.shots) {
    if (retryIds.includes(shot.id)) {
      shot.seed = Math.floor(Math.random() * 0xffffffff)
    }
  }
  await agent.store.save(project)
  subscribeRenderProgressImpl(agent, projectId)
  try {
    await agent.queue.start(projectId, retryIds)
    await agent.queue.waitForFinish(projectId)
  } catch {
    // 结果由复检判定
  } finally {
    unsubscribeRenderProgressImpl(agent, projectId)
  }

  const recheck = await inspectWithConsistency()
  problems = recheck.problems
  durations = recheck.durations
  return {
    approved: problems.size === 0,
    problems: [...problems.values()],
    retryIds,
    durations,
    warnings: [...warnings]
  }
}
