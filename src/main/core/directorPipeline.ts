import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {
  DirectorStartInput, AnalyzeResult, Character, Shot, Project, DirectorStage
} from '../../shared/ipcTypes'
import { ImageGenerateCancelled } from './imageService'
import { clampShotList, shouldPauseAfterAudit } from '../../shared/pipelineGuards'
import { lockPromptsAndWorkflow, type DirectorStageRuntime } from './directorStageAssets'
import { resolveCreation } from '../../shared/creationSettings'
import { isTransientError } from './errorClassify'
import type { DirectorAgent } from './directorAgent'
import { STAGE_LABELS, stageIndexOf, HEAL_MAX } from './directorConstants'
import { logImpl, setStageImpl, isCancelledImpl, maybeGateImpl, pauseUntilShotsReviewedImpl } from './directorStateMachine'
import { finishImpl } from './directorFinish'
import { subscribeRenderProgressImpl, unsubscribeRenderProgressImpl } from './directorProgressBridge'

/**
 * 导演循环编排：runPipeline 九阶段顺序串联 + C 自愈 + 瞬时重试 + 拼接。
 */

/**
 * C 错误回流自愈：阶段失败时把错误样本交回 LLM 诊断，
 * 判定值得重试且预算未耗尽时自动重跑一次。
 */
export async function selfHealStageImpl(
  agent: DirectorAgent,
  projectId: string,
  stage: DirectorStage,
  stageLabel: string,
  errors: string[],
  retry: () => Promise<void>
): Promise<boolean> {
  const used = agent.healBudget.get(projectId) ?? 0
  if (used >= HEAL_MAX) return false
  const state = agent.states.get(projectId)
  if (!state) return false

  setStageImpl(agent, projectId, stage, 'running', 'AI 正在诊断失败原因...', 0)
  let diag: { canAutoFix: boolean; diagnosis: string; suggestion: string }
  try {
    diag = await agent.llm.diagnoseFailure({
      stageLabel,
      errors: errors.slice(0, 5),
      context: `项目共 ${state.totalShots} 镜，此前成功 ${state.doneShots} 镜`
    })
  } catch {
    return false
  }

  if (!diag.canAutoFix) {
    state.heal = { stage, diagnosis: diag.diagnosis, suggestion: diag.suggestion }
    logImpl(agent, projectId, stage, 'warn',
      `AI 诊断：${diag.diagnosis}。建议：${diag.suggestion}（需人工处理后重试）`)
    return false
  }

  agent.healBudget.set(projectId, used + 1)
  state.heal = { stage, diagnosis: diag.diagnosis, suggestion: '已自动重试（若再次失败请按建议人工处理）' }
  logImpl(agent, projectId, stage, 'warn',
    `AI 自诊断：${diag.diagnosis}——判定可自动恢复，正在自动重试「${stageLabel}」（${used + 1}/${HEAL_MAX}）`)
  try {
    await retry()
    return true
  } catch (e) {
    logImpl(agent, projectId, stage, 'error', `自动重试仍未成功: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

/**
 * B 瞬时故障重试包装：网络抖动/服务过载/超时类错误自动退避重试，
 * 永久性错误立即原样抛出。
 */
export async function withTransientRetryImpl<T>(
  agent: DirectorAgent,
  fn: () => Promise<T>,
  opts: { retries?: number; notify?: (msg: string) => void; isCancelled?: () => boolean } = {}
): Promise<T> {
  const retries = opts.retries ?? 2
  let lastErr: unknown
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (i === retries || !isTransientError(e)) throw e
      const delay = 3000 * (i + 1)
      opts.notify?.(`遇到瞬时异常（${(e as Error).message.slice(0, 80)}），${delay / 1000}s 后自动重试（${i + 1}/${retries}）...`)
      const deadline = Date.now() + delay
      while (Date.now() < deadline) {
        // eslint-disable-next-line preserve-caught-error -- CANCELLED 是重试等待期间的取消控制信号，非对捕获错误的包装
        if (opts.isCancelled?.()) throw new Error('CANCELLED')
        await new Promise(r => setTimeout(r, 200))
      }
    }
  }
  throw lastErr
}

/** 拼接全部 done 镜分段到指定输出（combine 主路径与自愈重试共用） */
export async function concatDoneShotsImpl(
  agent: DirectorAgent,
  projectId: string,
  doneShots: Shot[],
  outputRel: string
): Promise<void> {
  const usable = doneShots
  if (usable.length === 0) {
    throw new Error('没有已完成可拼接的镜头；请在分镜页手动重渲后重试')
  }
  await agent.ffmpeg.smartConcatSegments(
    usable.map(s => ({
      path: path.join(agent.baseDir, s.segmentPath!),
      scene: s.scene,
      hasDialogue: Boolean(s.dialogue && s.dialogue.trim()),
      transition: s.transition,
      trimStart: s.trimStart,
      trimEnd: s.trimEnd,
      skipped: s.skipped
    })),
    path.join(agent.baseDir, outputRel)
  )
}

/**
 * 流水线主体。from 之前的阶段（断点续跑）直接跳过。
 */
export async function runPipelineImpl(
  agent: DirectorAgent,
  projectId: string,
  input: DirectorStartInput,
  from: DirectorStage = 'analyze'
): Promise<void> {
  const state = agent.states.get(projectId)
  if (!state) return
  const fromIdx = stageIndexOf(from)

  agent.healBudget.set(projectId, 0)
  state.input = input

  let analysis: AnalyzeResult | null = state.analysis ?? null
  let characterMap: Map<string, Character> | null = null
  let approval: {
    approved: boolean; problems: string[]; retryIds: string[]; durations: Map<string, number>; warnings: string[]
  } | null = null
  let rendered: Project | null = null
  let doneShots: Shot[] = []

  logImpl(agent, projectId, from, 'info',
    from === 'analyze'
      ? `任务开始：《${input.title}》（${input.genre}），共设 ${agent.gates.get(projectId)?.size || 0} 个阶段确认点`
      : `断点续跑：从「${STAGE_LABELS[from]}」阶段继续执行`)

  // 看守机制：任务一开始就自动加载导演技能库并全程生效
  const skillLoaded = await agent.skills.load(true)
  const checklist = await agent.skills.auditChecklist()
  const methodRules = await agent.skills.methodRules()
  logImpl(agent, projectId, from, 'info',
    skillLoaded
      ? `技能库已生效：director v${skillLoaded.version}（审核 ${checklist.length} 项 / 方法论 ${methodRules.length} 条）`
      : `技能库未加载（${agent.skills.loadErrorHint() || '目录缺失'}），按代码层默认条款执行`)

  // ① 剧本分析
  if (fromIdx <= stageIndexOf('analyze')) {
    setStageImpl(agent, projectId, 'analyze', 'running', 'AI 阅读剧本，识别角色与分镜...', 10)
    try {
      // P1-2：分析是长耗时 LLM 调用（最长 20 分钟），用户取消时立即中断 HTTP 请求，
      // 而不是等模型跑完再丢弃结果、白耗 token
      const ac = new AbortController()
      const cancelWatch = setInterval(() => {
        if (isCancelledImpl(agent, projectId)) ac.abort()
      }, 500)
      try {
        analysis = await withTransientRetryImpl(
          agent,
          () => agent.llm.analyze(input.script, input.genre, {
            title: input.title,
            extraRules: methodRules,
            signal: ac.signal
          }),
          { notify: (msg) => setStageImpl(agent, projectId, 'analyze', 'running', msg, 10), isCancelled: () => isCancelledImpl(agent, projectId) }
        )
      } finally {
        clearInterval(cancelWatch)
      }
      state.analysis = analysis
      const maxShots = (await agent.settings.get()).creation?.storyboard?.maxShots ?? 20
      const clamped = clampShotList(analysis.shots, maxShots)
      if (clamped.trimmed > 0) {
        analysis.shots = clamped.shots
        logImpl(agent, projectId, 'analyze', 'warn',
          `分镜数 ${analysis.shots.length + clamped.trimmed} 超过上限 ${maxShots}，已截断保留前 ${analysis.shots.length} 镜`)
      }
      const warnings = analysis.warnings || []
      const bindingHard = warnings.filter(w => /无法匹配|未归属/.test(w))
      const softWarn = warnings.filter(w => !bindingHard.includes(w))
      setStageImpl(
        agent, projectId, 'analyze',
        bindingHard.length > 0 ? 'error' : 'done',
        `角色：${analysis.characters.map(c => c.name).join('、')}；${analysis.shots.length} 个分镜` +
          (bindingHard.length > 0
            ? `；${bindingHard.length} 处归属异常：${bindingHard.join('；')}`
            : '') +
          (softWarn.length > 0
            ? `；叙事提醒 ${softWarn.length}：${softWarn.slice(0, 2).join('；')}${softWarn.length > 2 ? '等' : ''}`
            : ''),
        100
      )
      if (softWarn.length > 0) {
        logImpl(agent, projectId, 'analyze', 'warn', `叙事连续性：${softWarn.join('；')}`)
      }
    } catch (e) {
      setStageImpl(agent, projectId, 'analyze', 'error',
        `分析失败: ${e instanceof Error ? e.message : String(e)}`, 0)
      finishImpl(agent, projectId)
      return
    }

    await maybeGateImpl(agent, projectId, 'analyze')
    if (isCancelledImpl(agent, projectId)) { finishImpl(agent, projectId); return }
  }

  // ② 角色建档 + AI 定妆图
  if (fromIdx <= stageIndexOf('casting')) {
    try {
      characterMap = await agent.buildCharacters(projectId, analysis!)
      await agent.buildPropAssets(projectId, analysis!)
    } catch (e) {
      if (e instanceof ImageGenerateCancelled || isCancelledImpl(agent, projectId) || /CANCELLED/i.test(String(e))) {
        setStageImpl(agent, projectId, 'casting', 'skipped', '已取消')
        finishImpl(agent, projectId)
        return
      }
      setStageImpl(agent, projectId, 'casting', 'error',
        `角色建档异常: ${e instanceof Error ? e.message : String(e)}`, 0)
      finishImpl(agent, projectId)
      return
    }
    await maybeGateImpl(agent, projectId, 'casting')
    if (isCancelledImpl(agent, projectId)) { finishImpl(agent, projectId); return }
  } else if (fromIdx <= stageIndexOf('scenes')) {
    const projectForCast = await agent.store.get(projectId)
    characterMap = new Map(projectForCast.characters.map(c => [c.name, c]))
  }

  // ③ 分镜建档 + 空镜场景图
  if (fromIdx <= stageIndexOf('scenes')) {
    try {
      await agent.buildShots(projectId, analysis!, characterMap!)
    } catch (e) {
      if (e instanceof ImageGenerateCancelled || isCancelledImpl(agent, projectId) || /CANCELLED/i.test(String(e))) {
        setStageImpl(agent, projectId, 'scenes', 'skipped', '已取消')
        finishImpl(agent, projectId)
        return
      }
      setStageImpl(agent, projectId, 'scenes', 'error',
        `场景/首尾帧异常: ${e instanceof Error ? e.message : String(e)}`, 0)
      finishImpl(agent, projectId)
      return
    }
    await maybeGateImpl(agent, projectId, 'scenes')
    if (isCancelledImpl(agent, projectId)) { finishImpl(agent, projectId); return }
  }

  if (state.totalShots === 0) {
    setStageImpl(agent, projectId, 'render', 'error', '没有可渲染的分镜', 0)
    finishImpl(agent, projectId)
    return
  }

  // ④ 逐镜渲染
  if (fromIdx <= stageIndexOf('render')) {
    if (!(await pauseUntilShotsReviewedImpl(agent, projectId))) {
      finishImpl(agent, projectId)
      return
    }
    await lockPromptsAndWorkflow(agent as unknown as DirectorStageRuntime, projectId)
    const renderCfg = (await agent.settings.get()).render
    const perShotAudit = renderCfg.perShotAudit !== false
    const shotDurations = new Map<string, number>()
    setStageImpl(agent, projectId, 'render', 'running',
      perShotAudit ? `逐镜渲染+即时审核 0/${state.totalShots}...` : `渲染中 0/${state.totalShots}...`, 0)
    if (perShotAudit) {
      await agent.renderShotsWithAudit(projectId, shotDurations)
    } else {
      subscribeRenderProgressImpl(agent, projectId)
      try {
        await agent.queue.start(projectId)
        await agent.queue.waitForFinish(projectId)
      } catch (e) {
        setStageImpl(agent, projectId, 'render', 'error',
          `渲染队列异常: ${e instanceof Error ? e.message : String(e)}`, 0)
      }
      unsubscribeRenderProgressImpl(agent, projectId)
    }

    rendered = await agent.store.get(projectId)
    doneShots = rendered.shots.filter(s => s.status === 'done')
    state.doneShots = doneShots.length
    state.failedShotIds = rendered.shots
      .filter(s => s.status === 'failed')
      .map(s => s.id)

    if (isCancelledImpl(agent, projectId)) {
      setStageImpl(agent, projectId, 'render', 'skipped', '已取消')
      finishImpl(agent, projectId)
      return
    }

    // C 自愈
    if (state.failedShotIds.length > 0) {
      const failedErrors = [...new Set(
        rendered.shots.filter(s => s.status === 'failed').map(s => s.error || '未知原因')
      )]
      const healIds = [...state.failedShotIds]
      const healed = await selfHealStageImpl(agent, projectId, 'render', '逐镜渲染', failedErrors, async () => {
        const fresh = await agent.store.get(projectId)
        for (const s of fresh.shots) {
          if (healIds.includes(s.id)) s.seed = Math.floor(Math.random() * 0xffffffff)
        }
        await agent.store.save(fresh)
        subscribeRenderProgressImpl(agent, projectId)
        try {
          await agent.queue.start(projectId, healIds)
          await agent.queue.waitForFinish(projectId)
        } finally {
          unsubscribeRenderProgressImpl(agent, projectId)
        }
      })
      if (healed) {
        rendered = await agent.store.get(projectId)
        doneShots = rendered.shots.filter(s => s.status === 'done')
        state.doneShots = doneShots.length
        state.failedShotIds = rendered.shots
          .filter(s => s.status === 'failed')
          .map(s => s.id)
      }
    }

    if (doneShots.length === 0) {
      setStageImpl(agent, projectId, 'render', 'error', '全部镜头渲染失败', 0)
      finishImpl(agent, projectId, state.heal
        ? `全部镜头渲染失败：${state.heal.suggestion}`
        : undefined)
      return
    }

    setStageImpl(agent, projectId, 'render', 'done',
      `完成 ${doneShots.length}/${state.totalShots}` +
      (state.failedShotIds.length ? `，${state.failedShotIds.length} 镜失败` : ''), 100)

    if (!perShotAudit) {
      approval = await agent.approveShots(projectId)
      if (approval.warnings.length) {
        for (const w of approval.warnings) logImpl(agent, projectId, 'render', 'warn', w)
      }
      if (!approval.approved) {
        state.failedShotIds = [...new Set([...state.failedShotIds, ...approval.retryIds])]
        setStageImpl(agent, projectId, 'render', 'error',
          `${approval.problems.length} 镜未过审，已停止剪辑：${approval.problems.slice(0, 3).join('；')}` +
            (approval.problems.length > 3 ? '等' : ''),
          Math.round((doneShots.length / Math.max(1, state.totalShots)) * 100))
        finishImpl(agent, projectId, '逐镜审批未通过，未进入剪辑；请在分镜编辑处理后重跑「逐镜渲染」')
        return
      }
    } else {
      approval = {
        approved: true, problems: [], retryIds: [], durations: shotDurations, warnings: []
      }
      const hintCount = rendered.shots.filter(s => s.auditHint).length
      const failCount = state.failedShotIds.length
      if (hintCount > 0) {
        logImpl(agent, projectId, 'render', 'warn',
          `软提示 ${hintCount} 镜（审核未过但不阻断），已放行进入剪辑；可在分镜页逐镜整改后手动重渲`)
      }
      if (shouldPauseAfterAudit(hintCount, failCount)) {
        logImpl(agent, projectId, 'render', 'warn',
          `${failCount} 镜渲染失败：已暂停不进剪辑，请在分镜页逐镜查看/编辑/重渲后，从「视频剪辑」阶段手动继续`)
        setStageImpl(agent, projectId, 'render', 'paused',
          `渲染完成，${failCount} 镜渲染失败；整改后在导演控制台从「视频剪辑」阶段继续`, 100)
        finishImpl(agent, projectId,
          `${failCount} 镜渲染失败，已暂停不进剪辑；整改后重新运行并选择从「视频剪辑」阶段开始`)
        return
      }
    }

    await maybeGateImpl(agent, projectId, 'render')
    if (isCancelledImpl(agent, projectId)) { finishImpl(agent, projectId); return }
  }

  // 审批后 / 断点续跑进入剪辑前的统一刷新
  rendered = await agent.store.get(projectId)
  doneShots = rendered.shots.filter(s => s.status === 'done' && s.segmentPath)
  state.doneShots = doneShots.length

  // ⑤ 拼接成片
  const includedIds = doneShots.map(s => s.id)
  let currentVideo = `projects/${projectId}/final.mp4`
  if (fromIdx > stageIndexOf('combine') && state.stages.subtitle.status === 'done') {
    currentVideo = `projects/${projectId}/final_subtitled.mp4`
  }
  if (fromIdx <= stageIndexOf('combine')) {
    setStageImpl(agent, projectId, 'combine', 'running', '拼接成功分镜...', 20)
    try {
      try {
        const repaired = await agent.queue.repairSilentDialogue(projectId)
        if (repaired.repaired.length > 0) {
          logImpl(agent, projectId, 'combine', 'success',
            `静音台词镜已补配音修复：第 ${repaired.repaired.join('、')} 镜`)
          rendered = await agent.store.get(projectId)
          doneShots = rendered.shots.filter(s => s.status === 'done' && s.segmentPath)
          state.doneShots = doneShots.length
        }
      } catch (e) {
        logImpl(agent, projectId, 'combine', 'warn',
          `静音台词镜修复失败（按现状拼接）: ${e instanceof Error ? e.message : String(e)}`)
      }
      await concatDoneShotsImpl(agent, projectId, doneShots, currentVideo)
      const lowCons = doneShots.filter(s => s.lowConsistency)
      const detail = []
      if (state.failedShotIds.length) detail.push(`跳过失败镜头 ${state.failedShotIds.length}`)
      if (lowCons.length) detail.push(`低一致性 ${lowCons.length} 镜已保留在成片中（可在剪辑台跳过或重渲）`)
      setStageImpl(agent, projectId, 'combine', 'done',
        detail.length ? `已拼接 ${doneShots.length} 镜（${detail.join('；')}）` : `已拼接 ${doneShots.length} 镜`, 100)
    } catch (e) {
      const errMsg = `拼接失败: ${e instanceof Error ? e.message : String(e)}`
      const healed = await selfHealStageImpl(agent, projectId, 'combine', '拼接成片', [errMsg], () =>
        concatDoneShotsImpl(agent, projectId, doneShots, currentVideo)
      )
      if (healed) {
        setStageImpl(agent, projectId, 'combine', 'done',
          state.failedShotIds.length
            ? `已拼接 ${doneShots.length} 镜（跳过失败镜头）`
            : `已拼接 ${doneShots.length} 镜`, 100)
      } else {
        setStageImpl(agent, projectId, 'combine', 'error', errMsg, 0)
        finishImpl(agent, projectId, state.heal
          ? `拼接失败：${state.heal.suggestion}`
          : undefined)
        return
      }
    }

    await maybeGateImpl(agent, projectId, 'combine')
    if (isCancelledImpl(agent, projectId)) { finishImpl(agent, projectId); return }
  }

  // ⑥ 烧录字幕
  if (fromIdx <= stageIndexOf('subtitle')) {
    setStageImpl(agent, projectId, 'subtitle', 'running', '生成字幕并烧录...', 20)
    try {
      const srtRel = await agent.subtitles.generate(rendered!, includedIds)
      if (!srtRel) {
        setStageImpl(agent, projectId, 'subtitle', 'skipped', '无台词，跳过字幕烧录', 100)
      } else {
        const out = `projects/${projectId}/final_subtitled.mp4`
        const edit = resolveCreation(await agent.settings.get()).edit
        await agent.ffmpeg.burnSubtitles(
          path.join(agent.baseDir, currentVideo),
          path.join(agent.baseDir, srtRel),
          path.join(agent.baseDir, out),
          { fontSize: edit.subtitleFontSize, marginV: edit.subtitleMarginV }
        )
        currentVideo = out
        setStageImpl(agent, projectId, 'subtitle', 'done', '字幕已烧录', 100)
      }
    } catch (e) {
      setStageImpl(agent, projectId, 'subtitle', 'error',
        `字幕失败（保留无字幕版）: ${e instanceof Error ? e.message : String(e)}`, 0)
    }

    await maybeGateImpl(agent, projectId, 'subtitle')
    if (isCancelledImpl(agent, projectId)) { finishImpl(agent, projectId); return }
  }

  // ⑥+ 成片复审
  if (fromIdx <= stageIndexOf('review')) {
    setStageImpl(agent, projectId, 'review', 'running', '复审：音画技术校验...', 15)
    try {
      const issues: string[] = []
      const durations = approval?.durations ?? new Map<string, number>()

      const finalInfo = await agent.ffmpeg.getVideoInfo(path.join(agent.baseDir, currentVideo))
      if (!finalInfo.hasAudio) issues.push('成片缺少音轨')
      if (finalInfo.durationSec < 3) {
        issues.push(`成片时长异常（仅 ${finalInfo.durationSec.toFixed(1)}s）`)
      } else {
        let sumSeg = 0
        for (const s of doneShots) {
          const d = (await agent.ffmpeg.getVideoInfo(path.join(agent.baseDir, s.segmentPath!))).durationSec
          sumSeg += d
          if (!approval) durations.set(s.id, Math.round(d * 10) / 10)
        }
        if (Math.abs(sumSeg - finalInfo.durationSec) > Math.max(2, sumSeg * 0.1)) {
          issues.push(
            `成片时长 ${finalInfo.durationSec.toFixed(1)}s 与分段累计 ${sumSeg.toFixed(1)}s 不符，可能拼接丢段`
          )
        }
      }

      setStageImpl(agent, projectId, 'review', 'running', '复审：AI 审片（剧情完整性 · 台词相符 · 音画匹配）...', 55)
      const review = await withTransientRetryImpl(
        agent,
        () => agent.llm.reviewStory({
          title: input.title,
          logline: analysis?.logline || '',
          genre: input.genre,
          scriptHint: input.script,
          shots: doneShots.map(s => ({
            index: s.index,
            scene: s.scene,
            character: s.characterIds.length
              ? (rendered!.characters.find(c => c.id === s.characterIds[0])?.name || '')
              : '',
            dialogue: s.dialogue,
            durationSec: durations.get(s.id) || 0,
            action: s.action,
            type: s.type,
            shotSize: s.shotSize
          }))
        }),
        { notify: (msg) => setStageImpl(agent, projectId, 'review', 'running', msg, 55), isCancelled: () => isCancelledImpl(agent, projectId) }
      )
      issues.push(...review.issues)

      const lowConsShots = doneShots.filter(s => s.lowConsistency)
      if (lowConsShots.length > 0) {
        issues.push(
          `存在 ${lowConsShots.length} 个低一致性镜头（第${lowConsShots.map(s => s.index).join('、')}镜），` +
          `复审硬门禁要求重渲通过后才能入成片`
        )
      }

      const technical = issues.filter(i =>
        /缺少音轨|时长异常（仅/.test(i)
      )
      const narrative = issues.filter(i => !technical.includes(i))
      const gate = (await agent.settings.get()).render.finalReviewGate || 'block'

      if (issues.length === 0) {
        setStageImpl(agent, projectId, 'review', 'done',
          `复审通过${review.summary ? `：${review.summary}` : ''}`, 100)
      } else if (gate === 'block' && (technical.length > 0 || lowConsShots.length > 0)) {
        state.reviewIssues = issues
        const blocked = technical.length ? `技术硬伤 ${technical.length} 项` : `低一致性镜 ${lowConsShots.length} 个`
        setStageImpl(agent, projectId, 'review', 'error',
          `复审未通过（${blocked}）：${issues.slice(0, 2).join('；')}`,
          0)
        logImpl(agent, projectId, 'review', 'error', `复审硬门禁阻断：${issues.join('；')}`)
        finishImpl(agent, projectId, '成片复审未通过（硬门禁阻断），已保留当前成片；修复（重渲低一致性镜/补音轨）后可从「成片复审」续跑')
        return
      } else {
        state.reviewIssues = issues
        const label = gate === 'off' ? '已记录' : '已放行'
        setStageImpl(agent, projectId, 'review', 'done',
          `复审有 ${issues.length} 项提醒（${label}）：${issues.slice(0, 2).join('；')}` +
            (issues.length > 2 ? '等' : ''),
          100)
        logImpl(agent, projectId, 'review', 'warn',
          `复审提醒（硬伤 ${technical.length} / 其他 ${narrative.length}）：${issues.join('；')}`)
      }
    } catch (e) {
      setStageImpl(agent, projectId, 'review', 'done',
        `复审异常已跳过: ${e instanceof Error ? e.message : String(e)}`, 100)
      logImpl(agent, projectId, 'review', 'warn',
        `复审异常已跳过: ${e instanceof Error ? e.message : String(e)}`)
    }

    await maybeGateImpl(agent, projectId, 'review')
    if (isCancelledImpl(agent, projectId)) { finishImpl(agent, projectId); return }
  }

  // ⑦ BGM 混音
  if (input.bgmAbsolutePath) {
    let bgmAvailable = true
    try { await fs.access(input.bgmAbsolutePath) } catch { bgmAvailable = false }
    if (!bgmAvailable) {
      setStageImpl(agent, projectId, 'bgm', 'skipped', 'BGM 文件已不存在，跳过混音（成片保留当前版本）', 0)
    } else {
      setStageImpl(agent, projectId, 'bgm', 'running', '导入 BGM 并混音...', 20)
      try {
        const ext = path.extname(input.bgmAbsolutePath) || '.mp3'
        const bgmRel = `projects/${projectId}/bgm${ext}`
        await fs.copyFile(
          input.bgmAbsolutePath,
          path.join(agent.baseDir, bgmRel)
        )
        const defaultBgm = resolveCreation(await agent.settings.get()).edit.defaultBgmVolume
        const bgmProject = await agent.store.update(projectId, (p) => {
          p.bgmPath = bgmRel
          if (typeof p.bgmVolume !== 'number') p.bgmVolume = defaultBgm
        })
        const finalOut = `projects/${projectId}/final_master.mp4`
        const vol = typeof bgmProject.bgmVolume === 'number' ? bgmProject.bgmVolume : defaultBgm
        await agent.ffmpeg.mixBgm(
          path.join(agent.baseDir, currentVideo),
          path.join(agent.baseDir, bgmRel),
          path.join(agent.baseDir, finalOut),
          vol
        )
        currentVideo = finalOut
        setStageImpl(agent, projectId, 'bgm', 'done', 'BGM 混音完成', 100)
      } catch (e) {
        setStageImpl(agent, projectId, 'bgm', 'error',
          `BGM 失败: ${e instanceof Error ? e.message : String(e)}`, 0)
      }
    }
  } else {
    setStageImpl(agent, projectId, 'bgm', 'skipped', '未提供 BGM', 0)
  }

  state.finalPath = currentVideo
  finishImpl(agent, projectId)
}
