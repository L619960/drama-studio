import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { ImageGenerateCancelled } from './imageService'
import type {
  DirectorStage, DirectorStartInput,
  AnalyzeResult, Character, Shot, Project
} from '../../shared/ipcTypes'
import { resolveCreation } from '../../shared/creationSettings'
import { reviewFailureStops, shotsInCut, trimmedDurationSec } from '../../shared/pipelineGuards'
import {
  DirectorStageRuntime,
  buildCharacters, buildPropAssets, buildShots, lockPromptsAndWorkflow
} from './directorStageAssets'
import { STAGE_LABELS, stageIndexOf } from './directorStageMeta'
import { selfHealStage, withTransientRetry } from './directorStageHealing'
import {
  concatDoneShots, renderShotsWithAudit, approveShots
} from './directorStageAudit'
/**
 * 【2026-10-25 标注：死代码——流水线阶段化重构未完成，live 仍走 directorAgent.ts 的
 * runPipeline 私有副本；本文件 runPipeline 全 src 0 引用（grep from './directorStageRender' = 0）。
 * directorAgent.ts:817 以 `lockPromptsAndWorkflow(this as unknown as DirectorStageRuntime, ...)`
 * 硬转绕过类型借用本模块的 buildCharacters/buildShots 等函数。
 * 本轮已把本模块独有且 live 缺失的关键门禁移植回 live（角色混淆硬判→approveShots；
 * 剔镜口径→"只打标保留"），故本文件不再被消费属预期。勿在此新增逻辑，改动应落在
 * directorAgent.ts（live 权威路径）。历史保留：pauseUntilShotsReviewed、repairSilentDialogue
 * 等仍只在死代码里，如需启用需完整重构切换（届时再删本文件）。】
 *
 * 流水线主体。from 之前的阶段（断点续跑）直接跳过：
 * - analyze 复用持久化的 state.analysis，casting/scenes 不再重复执行
 * - render 之后续跑时跳过审批（上次已过审），拼接/字幕产物按阶段状态选用
 */
export async function runPipeline(
  rt: DirectorStageRuntime,
  projectId: string,
  input: DirectorStartInput,
  from: DirectorStage = 'analyze'
): Promise<void> {
  const state = rt.states.get(projectId)
  if (!state) return
  const fromIdx = stageIndexOf(from)
  rt.healBudget.set(projectId, 0)
  state.input = input

  let analysis: AnalyzeResult | null = state.analysis ?? null
  let characterMap: Map<string, Character> | null = null
  let approval: {
    approved: boolean; problems: string[]; retryIds: string[]; durations: Map<string, number>; warnings: string[]
  } | null = null
  let rendered: Project | null = null
  let doneShots: Shot[] = []

  rt.log(projectId, from, 'info',
    from === 'analyze'
      ? `任务开始：《${input.title}》（${input.genre}），共设 ${rt.gates.get(projectId)?.size || 0} 个阶段确认点`
      : `断点续跑：从「${STAGE_LABELS[from]}」阶段继续执行`)

  // 看守机制：任务一开始就自动加载导演技能库并全程生效（强制重读磁盘，编辑 rules.json 后本次任务即生效）
  const skillLoaded = await rt.skills.load(true)
  const checklist = await rt.skills.auditChecklist()
  const methodRules = await rt.skills.methodRules()
  rt.log(projectId, from, 'info',
    skillLoaded
      ? `技能库已生效：director v${skillLoaded.version}（审核 ${checklist.length} 项 / 方法论 ${methodRules.length} 条）`
      : `技能库未加载（${rt.skills.loadErrorHint() || '目录缺失'}），按代码层默认条款执行`)

  // ① 剧本分析（瞬时异常自动退避重试；断点续跑时沿用持久化分析结果）
  if (fromIdx <= stageIndexOf('analyze')) {
    rt.setStage(projectId, 'analyze', 'running', 'AI 阅读剧本，识别角色与分镜...', 10)
    try {
      analysis = await withTransientRetry(
        () => rt.llm.analyze(input.script, input.genre, {
          title: input.title,
          extraRules: methodRules
        }),
        { notify: (msg) => rt.setStage(projectId, 'analyze', 'running', msg, 10), isCancelled: () => rt.isCancelled(projectId) }
      )
      state.analysis = analysis
      const warnings = analysis.warnings || []
      const bindingHard = warnings.filter(w => /无法匹配|未归属/.test(w))
      const softWarn = warnings.filter(w => !bindingHard.includes(w))
      rt.setStage(
        projectId, 'analyze',
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
      const promptFixes = softWarn.filter(w => w.startsWith('提示词核对'))
      const narrative = softWarn.filter(w => !w.startsWith('提示词核对'))
      if (promptFixes.length > 0) {
        rt.log(projectId, 'analyze', 'warn',
          `拆镜提示词已按剧情改写 ${promptFixes.length} 处，未进入出图：${promptFixes.slice(0, 6).join('；')}`)
      }
      if (narrative.length > 0) {
        rt.log(projectId, 'analyze', 'warn', `叙事连续性：${narrative.join('；')}`)
      }
    } catch (e) {
      rt.setStage(projectId, 'analyze', 'error',
        `分析失败: ${e instanceof Error ? e.message : String(e)}`, 0)
      rt.finish(projectId)
      return
    }

    await rt.maybeGate(projectId, 'analyze')
    if (rt.isCancelled(projectId)) { rt.finish(projectId); return }
  }

  // ② 角色建档 + AI 定妆图（断点续跑时跳过，角色沿用上次建档）
  if (fromIdx <= stageIndexOf('casting')) {
    try {
      characterMap = await buildCharacters(rt, projectId, analysis!)
      // 道具资产：分镜阶段提取的关键道具 → 生成道具定妆图（渲染锁形参考，防变样/消失）
      await buildPropAssets(rt, projectId, analysis!)
    } catch (e) {
      if (e instanceof ImageGenerateCancelled || rt.isCancelled(projectId) || /CANCELLED/i.test(String(e))) {
        rt.setStage(projectId, 'casting', 'skipped', '已取消')
        rt.finish(projectId)
        return
      }
      rt.setStage(projectId, 'casting', 'error',
        `角色建档异常: ${e instanceof Error ? e.message : String(e)}`, 0)
      rt.finish(projectId)
      return
    }
    await rt.maybeGate(projectId, 'casting')
    if (rt.isCancelled(projectId)) { rt.finish(projectId); return }
  } else if (fromIdx <= stageIndexOf('scenes')) {
    // 从 scenes 续跑会跳过 casting：必须从项目角色表重建 name→Character，否则 buildShots 空指针
    const projectForCast = await rt.store.get(projectId)
    characterMap = new Map(projectForCast.characters.map(c => [c.name, c]))
  }

  // ③ 分镜建档 + 空镜场景图（断点续跑时跳过，分镜沿用上次建档）
  if (fromIdx <= stageIndexOf('scenes')) {
    try {
      await buildShots(rt, projectId, analysis!, characterMap!)
    } catch (e) {
      if (e instanceof ImageGenerateCancelled || rt.isCancelled(projectId) || /CANCELLED/i.test(String(e))) {
        rt.setStage(projectId, 'scenes', 'skipped', '已取消')
        rt.finish(projectId)
        return
      }
      rt.setStage(projectId, 'scenes', 'error',
        `场景/首尾帧异常: ${e instanceof Error ? e.message : String(e)}`, 0)
      rt.finish(projectId)
      return
    }
    await rt.maybeGate(projectId, 'scenes')
    if (rt.isCancelled(projectId)) { rt.finish(projectId); return }
  }

  if (state.totalShots === 0) {
    rt.setStage(projectId, 'render', 'error', '没有可渲染的分镜', 0)
    rt.finish(projectId)
    return
  }

  // ④ 逐镜渲染（TTS 在队列内完成；遇错继续；断点续跑时只重渲 pending/failed 镜）
  if (fromIdx <= stageIndexOf('render')) {
    const reviewedOk = await rt.pauseUntilShotsReviewed(projectId)
    if (!reviewedOk || rt.isCancelled(projectId)) { rt.finish(projectId); return }
    await lockPromptsAndWorkflow(rt, projectId)
    const renderCfg = (await rt.settings.get()).render
    const perShotAudit = renderCfg.perShotAudit !== false
    // 逐镜审核的每镜实际时长（review 音画匹配用）
    const shotDurations = new Map<string, number>()
    rt.setStage(projectId, 'render', 'running',
      perShotAudit ? `逐镜渲染+即时审核 0/${state.totalShots}...` : `渲染中 0/${state.totalShots}...`, 0)
    if (perShotAudit) {
      // 看守模式：出一镜做技术留痕；软提示不阻断后续剪辑
      await renderShotsWithAudit(rt, projectId, shotDurations)
    } else {
      rt.subscribeRenderProgress(projectId)
      try {
        await rt.queue.start(projectId)
        await rt.queue.waitForFinish(projectId)
      } catch (e) {
        rt.setStage(projectId, 'render', 'error',
          `渲染队列异常: ${e instanceof Error ? e.message : String(e)}`, 0)
      }
      rt.unsubscribeRenderProgress(projectId)
    }

    rendered = await rt.store.get(projectId)
    doneShots = rendered.shots.filter(s => s.status === 'done')
    state.doneShots = doneShots.length
    state.failedShotIds = rendered.shots
      .filter(s => s.status === 'failed')
      .map(s => s.id)

    if (rt.isCancelled(projectId)) {
      rt.setStage(projectId, 'render', 'skipped', '已取消')
      rt.finish(projectId)
      return
    }

    // C 自愈：全部失败 或 部分失败 → 错误样本回流 AI，可恢复则换 seed 重渲失败镜
    if (state.failedShotIds.length > 0) {
      const failedErrors = [...new Set(
        rendered.shots.filter(s => s.status === 'failed').map(s => s.error || '未知原因')
      )]
      const healIds = [...state.failedShotIds]
      const healed = await selfHealStage(rt, projectId, 'render', '逐镜渲染', failedErrors, async () => {
        const fresh = await rt.store.get(projectId)
        for (const s of fresh.shots) {
          if (healIds.includes(s.id)) s.seed = Math.floor(Math.random() * 0xffffffff)
        }
        await rt.store.save(fresh)
        rt.subscribeRenderProgress(projectId)
        try {
          await rt.queue.start(projectId, healIds)
          await rt.queue.waitForFinish(projectId)
        } finally {
          rt.unsubscribeRenderProgress(projectId)
        }
      })
      if (healed) {
        rendered = await rt.store.get(projectId)
        doneShots = rendered.shots.filter(s => s.status === 'done')
        state.doneShots = doneShots.length
        state.failedShotIds = rendered.shots
          .filter(s => s.status === 'failed')
          .map(s => s.id)
      }
    }

    if (doneShots.length === 0) {
      rt.setStage(projectId, 'render', 'error', '全部镜头渲染失败', 0)
      rt.finish(projectId, state.heal
        ? `全部镜头渲染失败：${state.heal.suggestion}`
        : undefined)
      return
    }

    rt.setStage(projectId, 'render', 'done',
      `完成 ${doneShots.length}/${state.totalShots}` +
      (state.failedShotIds.length ? `，${state.failedShotIds.length} 镜失败` : ''), 100)

    // ④+ 逐镜审批：批量路径保留严格关卡；看守路径已逐镜即时审核（预算用尽放行留痕），只做汇总
    if (!perShotAudit) {
      approval = await approveShots(rt, projectId)
      // 一致性低分等警告：放行但留痕，供用户在分镜页手动重渲
      if (approval.warnings.length) {
        for (const w of approval.warnings) rt.log(projectId, 'render', 'warn', w)
      }
      if (!approval.approved) {
        state.failedShotIds = [...new Set([...state.failedShotIds, ...approval.retryIds])]
        rt.setStage(projectId, 'render', 'error',
          `${approval.problems.length} 镜未过审，已停止剪辑：${approval.problems.slice(0, 3).join('；')}` +
            (approval.problems.length > 3 ? '等' : ''),
          Math.round((doneShots.length / Math.max(1, state.totalShots)) * 100))
        rt.finish(projectId, '逐镜审批未通过，未进入剪辑；请在分镜编辑处理后重跑「逐镜渲染」')
        return
      }
    } else {
      approval = {
        approved: true, problems: [], retryIds: [], durations: shotDurations, warnings: []
      }
      // 软审核只留痕，不阻断剪辑。硬失败（仍有 failed 镜）才停在渲染末，等人处理后再从剪辑续跑。
      const hintCount = rendered.shots.filter(s => s.auditHint).length
      const failCount = state.failedShotIds.length
      if (hintCount > 0) {
        rt.log(projectId, 'render', 'warn',
          `${hintCount} 镜有审核提示（已写入分镜，不阻断剪辑）。可稍后在分镜页查看/重渲`)
      }
      if (failCount > 0) {
        rt.log(projectId, 'render', 'warn',
          `${failCount} 镜渲染失败：已暂停不进剪辑，请处理后从「视频剪辑」阶段继续（成功镜会参与拼接）`)
        rt.setStage(projectId, 'render', 'paused',
          `渲染完成，${failCount} 镜失败；整改后从「视频剪辑」继续`, 100)
        rt.finish(projectId,
          `${failCount} 镜渲染失败，已暂停不进剪辑；成功镜保留，整改后从「视频剪辑」阶段继续`)
        return
      }
    }

    await rt.maybeGate(projectId, 'render')
    if (rt.isCancelled(projectId)) { rt.finish(projectId); return }
  }

  // 审批后 / 断点续跑进入剪辑前的统一刷新（重渲镜头状态可能变化）
  rendered = await rt.store.get(projectId)
  doneShots = rendered.shots.filter(s => s.status === 'done' && s.segmentPath)
  state.doneShots = doneShots.length

  // ⑤ 拼接成片（与复审共用 shotsInCut：完成、有分段、未跳过；低一致性只打标）
  let includedIds = shotsInCut(doneShots).map(s => s.id)
  let currentVideo = `projects/${projectId}/final.mp4`
  if (fromIdx > stageIndexOf('combine') && state.stages.subtitle.status === 'done') {
    currentVideo = `projects/${projectId}/final_subtitled.mp4`
  }
  if (fromIdx <= stageIndexOf('combine')) {
    rt.setStage(projectId, 'combine', 'running', '检查台词音频...', 10)
    const repair = await rt.queue.repairSilentDialogue(projectId)
    if (repair.repaired.length) {
      rt.log(projectId, 'combine', 'info',
        `已为第 ${repair.repaired.join('、')} 镜补配音并重做分段`)
    }
    if (repair.blocked.length) {
      const list = repair.blocked.join('、')
      rt.setStage(projectId, 'combine', 'error',
        `第 ${list} 镜有台词但配音失败，已停止拼接（避免无声成片）`, 0)
      rt.finish(projectId,
        `第 ${list} 镜 TTS 补配音失败。请检查网络/音色后从「视频剪辑」续跑，或在分镜页重渲这些镜`)
      return
    }
    rendered = await rt.store.get(projectId)
    doneShots = shotsInCut(rendered.shots)
    includedIds = doneShots.map(s => s.id)
    rt.setStage(projectId, 'combine', 'running', '拼接成功分镜...', 20)
    try {
      await concatDoneShots(rt, projectId, doneShots, currentVideo)
      const lowCons = doneShots.filter(s => s.lowConsistency)
      const detail = []
      if (state.failedShotIds.length) detail.push(`失败镜头 ${state.failedShotIds.length} 未入片`)
      if (lowCons.length) detail.push(`低一致性 ${lowCons.length} 镜已保留在成片中（可在剪辑台跳过或重渲）`)
      rt.setStage(projectId, 'combine', 'done',
        detail.length ? `已拼接 ${doneShots.length} 镜（${detail.join('；')}）` : `已拼接 ${doneShots.length} 镜`, 100)
    } catch (e) {
      const errMsg = `拼接失败: ${e instanceof Error ? e.message : String(e)}`
      // C 自愈：拼接多为 ffmpeg 瞬时故障，诊断后自动重试
      const healed = await selfHealStage(rt, projectId, 'combine', '拼接成片', [errMsg], () =>
        concatDoneShots(rt, projectId, doneShots, currentVideo)
      )
      if (healed) {
        rt.setStage(projectId, 'combine', 'done',
          state.failedShotIds.length
            ? `已拼接 ${doneShots.length} 镜（跳过失败镜头）`
            : `已拼接 ${doneShots.length} 镜`, 100)
      } else {
        rt.setStage(projectId, 'combine', 'error', errMsg, 0)
        rt.finish(projectId, state.heal
          ? `拼接失败：${state.heal.suggestion}`
          : undefined)
        return
      }
    }

    await rt.maybeGate(projectId, 'combine')
    if (rt.isCancelled(projectId)) { rt.finish(projectId); return }
  }

  // ⑥ 烧录字幕（时间轴只含参与拼接的镜头；断点续跑时沿用上次字幕版成片）
  if (fromIdx <= stageIndexOf('subtitle')) {
    rt.setStage(projectId, 'subtitle', 'running', '生成字幕并烧录...', 20)
    try {
      const srtRel = await rt.subtitles.generate(rendered!, includedIds)
      if (!srtRel) {
        rt.setStage(projectId, 'subtitle', 'skipped', '无台词，跳过字幕烧录', 100)
      } else {
        const out = `projects/${projectId}/final_subtitled.mp4`
        const edit = resolveCreation(await rt.settings.get()).edit
        await rt.ffmpeg.burnSubtitles(
          path.join(rt.baseDir, currentVideo),
          path.join(rt.baseDir, srtRel),
          path.join(rt.baseDir, out),
          { fontSize: edit.subtitleFontSize, marginV: edit.subtitleMarginV }
        )
        currentVideo = out
        rt.setStage(projectId, 'subtitle', 'done', '字幕已烧录', 100)
      }
    } catch (e) {
      // 字幕失败不阻断：继续用无字幕成片做 BGM
      rt.setStage(projectId, 'subtitle', 'error',
        `字幕失败（保留无字幕版）: ${e instanceof Error ? e.message : String(e)}`, 0)
    }

    await rt.maybeGate(projectId, 'subtitle')
    if (rt.isCancelled(projectId)) { rt.finish(projectId); return }
  }

  // ⑥+ 成片复审：音画技术校验 + AI 审片（剧情完整性/台词相符），通过才允许配 BGM
  // （断点续跑时跳过：沿用上次复审结论）
  if (fromIdx <= stageIndexOf('review')) {
    doneShots = shotsInCut(doneShots)
    rt.setStage(projectId, 'review', 'running', '复审：音画技术校验...', 15)
    try {
      const issues: string[] = []
      // 断点续跑没有审批产物时，分段探测顺带补齐每镜时长（AI 审片输入用）
      const durations = approval?.durations ?? new Map<string, number>()

      // 技术面：成片必须有音轨、时长合理、与各分段累计一致
      const finalInfo = await rt.ffmpeg.getVideoInfo(path.join(rt.baseDir, currentVideo))
      if (!finalInfo.hasAudio) issues.push('成片缺少音轨')
      if (finalInfo.durationSec < 3) {
        issues.push(`成片时长异常（仅 ${finalInfo.durationSec.toFixed(1)}s）`)
      } else {
        let sumSeg = 0
        const cut = shotsInCut(doneShots)
        for (const s of cut) {
          const full = (await rt.ffmpeg.getVideoInfo(path.join(rt.baseDir, s.segmentPath!))).durationSec
          const d = trimmedDurationSec(full, s.trimStart, s.trimEnd)
          sumSeg += d
          if (!approval) durations.set(s.id, Math.round(d * 10) / 10)
        }
        if (Math.abs(sumSeg - finalInfo.durationSec) > Math.max(2, sumSeg * 0.1)) {
          issues.push(
            `成片时长 ${finalInfo.durationSec.toFixed(1)}s 与分段累计 ${sumSeg.toFixed(1)}s 不符，可能拼接丢段`
          )
        }
      }

      // 剧情面：AI 审片（叙事完整/镜头衔接/台词与剧情相符/音画匹配）——瞬时异常自动重试
      rt.setStage(projectId, 'review', 'running', '复审：AI 审片（剧情完整性 · 台词相符 · 音画匹配）...', 55)
      const review = await withTransientRetry(
        () => rt.llm.reviewStory({
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
        { notify: (msg) => rt.setStage(projectId, 'review', 'running', msg, 55), isCancelled: () => rt.isCancelled(projectId) }
      )
      issues.push(...review.issues)

      // 低一致性镜仍在成片里，只提醒，避免复审把标记误当成缺镜
      const lowConsShots = doneShots.filter(s => s.lowConsistency)
      if (lowConsShots.length > 0) {
        issues.push(
          `第${lowConsShots.map(s => s.index).join('、')}镜一致性偏低，仍保留在成片中；可在剪辑台跳过或重渲`
        )
      }

      // 仅「成片无音轨 / 时长塌缩」视为硬伤；时长微差与剧情意见一律告警放行，避免误杀整条流水线
      const technical = issues.filter(i =>
        /缺少音轨|时长异常（仅/.test(i)
      )
      const narrative = issues.filter(i => !technical.includes(i))
      const gate = (await rt.settings.get()).render.reviewGate || 'block'

      if (issues.length === 0) {
        rt.setStage(projectId, 'review', 'done',
          `复审通过${review.summary ? `：${review.summary}` : ''}`, 100)
      } else if (gate === 'block' && technical.length > 0) {
        state.reviewIssues = issues
        rt.setStage(projectId, 'review', 'error',
          `复审未通过（${technical.length} 项技术硬伤）：${technical.slice(0, 2).join('；')}`,
          0)
        rt.log(projectId, 'review', 'error', `复审阻断：${issues.join('；')}`)
        rt.finish(projectId, '成片复审未通过，已保留当前成片；修复后可从「成片复审」续跑')
        return
      } else {
        state.reviewIssues = issues
        const label = gate === 'off' ? '已记录' : '已放行'
        rt.setStage(projectId, 'review', 'done',
          `复审有 ${issues.length} 项提醒（${label}）：${issues.slice(0, 2).join('；')}` +
            (issues.length > 2 ? '等' : ''),
          100)
        rt.log(projectId, 'review', 'warn',
          `复审提醒（硬伤 ${technical.length} / 其他 ${narrative.length}）：${issues.join('；')}`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const gate = (await rt.settings.get()).render.reviewGate || 'block'
      if (reviewFailureStops(gate)) {
        rt.setStage(projectId, 'review', 'error', `复审失败，已停止配乐：${msg}`, 0)
        rt.log(projectId, 'review', 'error', `复审失败，已停止配乐：${msg}`)
        rt.finish(projectId, `成片复审失败（${msg}），已停止配乐。修复后可从「成片复审」续跑`)
        return
      }
      rt.setStage(projectId, 'review', 'done', `复审已关闭，调用异常已跳过: ${msg}`, 100)
      rt.log(projectId, 'review', 'warn', `复审已关闭，调用异常已跳过: ${msg}`)
    }

    await rt.maybeGate(projectId, 'review')
    if (rt.isCancelled(projectId)) { rt.finish(projectId); return }
  }

  // ⑦ BGM 混音（最后一步：复审通过后才配乐出片）
  if (input.bgmAbsolutePath) {
    // 断点续跑时原 BGM 临时文件可能已被清理：缺失则跳过而非失败
    let bgmAvailable = true
    try { await fs.access(input.bgmAbsolutePath) } catch { bgmAvailable = false }
    if (!bgmAvailable) {
      rt.setStage(projectId, 'bgm', 'skipped', 'BGM 文件已不存在，跳过混音（成片保留当前版本）', 0)
    } else {
      rt.setStage(projectId, 'bgm', 'running', '导入 BGM 并混音...', 20)
      try {
        const ext = path.extname(input.bgmAbsolutePath) || '.mp3'
        const bgmRel = `projects/${projectId}/bgm${ext}`
        await fs.copyFile(
          input.bgmAbsolutePath,
          path.join(rt.baseDir, bgmRel)
        )
        const defaultBgm = resolveCreation(await rt.settings.get()).edit.defaultBgmVolume
        const renderedP = await rt.store.update(projectId, (p) => {
          p.bgmPath = bgmRel
          if (typeof p.bgmVolume !== 'number') p.bgmVolume = defaultBgm
        })
        const finalOut = `projects/${projectId}/final_master.mp4`
        const vol = typeof renderedP.bgmVolume === 'number' ? renderedP.bgmVolume : defaultBgm
        await rt.ffmpeg.mixBgm(
          path.join(rt.baseDir, currentVideo),
          path.join(rt.baseDir, bgmRel),
          path.join(rt.baseDir, finalOut),
          vol
        )
        currentVideo = finalOut
        rt.setStage(projectId, 'bgm', 'done', 'BGM 混音完成', 100)
      } catch (e) {
        rt.setStage(projectId, 'bgm', 'error',
          `BGM 失败: ${e instanceof Error ? e.message : String(e)}`, 0)
      }
    }
  } else {
    rt.setStage(projectId, 'bgm', 'skipped', '未提供 BGM', 0)
  }

  state.finalPath = currentVideo
  const unfinished = (['subtitle', 'bgm'] as const)
    .filter(stage => state.stages[stage].status === 'error')
    .map(stage => STAGE_LABELS[stage])
  rt.finish(projectId, unfinished.length
    ? `${unfinished.join('、')}未完成，当前成片停在失败前的版本`
    : undefined)
}
// ===== 以下为子域模块的兼容再导出（原导出面保持不变）=====
export { selfHealStage, withTransientRetry } from './directorStageHealing'
export {
  concatDoneShots, renderShotsWithAudit, auditSingleShot, approveShots
} from './directorStageAudit'
