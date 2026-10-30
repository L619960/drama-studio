import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Shot, Project } from '../../shared/ipcTypes'
import type { AuditCheckItem } from './skillLibrary'
import { FACE_CONSISTENCY_THRESHOLD } from './consistencyService'
import { shotsInCut } from '../../shared/pipelineGuards'
import type { DirectorStageRuntime } from './directorStageAssets'
/** 拼接全部过审镜头分段到指定输出（combine 主路径与自愈重试共用） */
export async function concatDoneShots(
  rt: DirectorStageRuntime,
  projectId: string,
  doneShots: Shot[],
  outputRel: string
): Promise<void> {
  const usable = shotsInCut(doneShots)
  if (usable.length === 0) {
    throw new Error('没有可拼接镜头（未完成、已跳过或无分段）；请在成片页取消跳过或重渲后重试')
  }
  await rt.ffmpeg.smartConcatSegments(
    usable.map(s => ({
      path: path.join(rt.baseDir, s.segmentPath!),
      scene: s.scene,
      hasDialogue: Boolean(s.dialogue && s.dialogue.trim()),
      transition: s.transition,
      trimStart: s.trimStart,
      trimEnd: s.trimEnd
    })),
    path.join(rt.baseDir, outputRel)
  )
}

/**
 * 提示式渲染（非阻塞）：逐镜渲染，渲完一镜立即进下一镜。
 * - 每镜渲染完成只做秒级技术审核（产物存在/时长≥0.8s/非黑帧/一致性分）+ 留痕 auditHint
 * - LLM 视觉审核延后到用户逐镜查看时；不做阻塞式整改重渲（省时省算力）
 * - 渲染失败镜跳过（交给 runPipeline 的 C 自愈统一处理）
 * - 全部渲染完成后硬失败才停在剪辑前；软审核提示只留痕
 */
export async function renderShotsWithAudit(
  rt: DirectorStageRuntime,
  projectId: string,
  shotDurations: Map<string, number>
): Promise<void> {
  const checklist = await rt.skills.auditChecklist()
  rt.subscribeRenderProgress(projectId)
  try {
    const project = await rt.store.get(projectId)
    const targets = project.shots.filter(s => s.status === 'pending' || s.status === 'failed')
    const total = targets.length
    let doneCount = 0
    let notPassed = 0
    for (const shot of targets) {
      if (rt.isCancelled(projectId)) break
      // 提示式：渲完一镜立即进下一镜，不做阻塞式审核/整改重渲（省时省算力）
      await rt.queue.start(projectId, [shot.id])
      await rt.queue.waitForFinish(projectId)

      const fresh = await rt.store.get(projectId)
      const cur = fresh.shots.find(s => s.id === shot.id)
      if (!cur || cur.status !== 'done') continue // 渲染失败，交给 C 自愈

      // 秒级技术审核（文件/时长/黑帧/一致性分）+ 留痕；LLM 视觉审核延后到用户逐镜查看
      try {
        const audit = await auditSingleShot(rt, projectId, cur, fresh, checklist, true)
        if (audit.durationSec >= 0) shotDurations.set(cur.id, audit.durationSec)
        cur.auditHint = audit.passed
          ? undefined
          : `${audit.reason}${audit.fixHint ? '；建议：' + audit.fixHint : ''}`
        if (!audit.passed) notPassed++
        await rt.store.save(fresh)
        rt.notifyProjectUpdated(projectId)
        rt.log(projectId, 'render', audit.passed ? 'info' : 'warn',
          audit.passed
            ? `第${cur.index}镜「${cur.scene}」渲染完成`
            : `第${cur.index}镜「${cur.scene}」渲染完成但有提示：${audit.reason}（可在分镜页编辑重渲）`)
      } catch (e) {
        rt.log(projectId, 'render', 'warn',
          `第${cur.index}镜审核留痕失败：${e instanceof Error ? e.message : String(e)}`)
      }
      doneCount++
      rt.setStage(projectId, 'render', 'running',
        `渲染 ${doneCount}/${total}...`, Math.round((doneCount / Math.max(1, total)) * 100))
    }
    if (notPassed > 0) {
      rt.log(projectId, 'render', 'warn', `本轮共 ${notPassed} 镜次未过审（含整改后放行），已在分镜页留痕`)
    }
  } finally {
    rt.unsubscribeRenderProgress(projectId)
  }
}

/**
 * 单镜即时审核（看守）：
 * 1) 技术：产物存在、时长≥0.8s、非纯色/黑帧
 * 2) 一致性：i2v 且 consistencyMode=rerender 时，低分算未过审
 * 3) LLM 视觉：按技能库审核清单逐条判；模型不支持视觉时降级为仅技术
 */
export async function auditSingleShot(
  rt: DirectorStageRuntime,
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
    ? path.join(rt.baseDir, shot.segmentPath)
    : shot.rawVideoPath
      ? path.join(rt.baseDir, shot.rawVideoPath)
      : null
  if (!abs) {
    return { passed: false, reason: '产物文件缺失', fixHint: undefined, durationSec: -1, vision: false }
  }
  try {
    await fs.access(abs)
  } catch {
    return { passed: false, reason: '产物文件不存在', fixHint: undefined, durationSec: -1, vision: false }
  }

  // 技术项
  let dur: number
  try {
    dur = await rt.ffmpeg.getDuration(abs)
  } catch {
    return { passed: false, reason: '视频信息读取失败', fixHint: undefined, durationSec: -1, vision: false }
  }
  if (dur < 0.8) {
    return { passed: false, reason: `时长过短（${dur.toFixed(1)}s）`, fixHint: undefined, durationSec: dur, vision: false }
  }
  if (await rt.ffmpeg.looksLikeBlankVideo(abs)) {
    return { passed: false, reason: '画面疑似纯色/黑帧', fixHint: undefined, durationSec: dur, vision: false }
  }

  if (
    shot.type === 'i2v' &&
    typeof shot.consistencyScore === 'number' &&
    shot.consistencyScore < 0.4
  ) {
    return {
      passed: false,
      reason: `人物严重漂移（${shot.consistencyScore.toFixed(2)}）`,
      fixHint: 'keep the face age, hairstyle and outfit exactly as the reference frame',
      durationSec: dur,
      vision: false
    }
  }

  // 角色混淆相对判别（2026-10-23 多角色剧防张冠李戴）：本镜输出更像另一角色定妆 → 硬失败提示
  // （不再只是 lowConsistency 压分；多角色项目逐镜核对"谁在演"）
  if (
    (project.characters || []).length > 1 &&
    shot.characterIds?.[0] &&
    shot.type === 'i2v'
  ) {
    try {
      const verdict = await rt.queue.checkShotRoleConfusion(projectId, shot, project)
      if (verdict?.confused) {
        const declaredName = project.characters.find(c => c.id === shot.characterIds![0])?.name || shot.characterIds![0]
        return {
          passed: false,
          reason: `角色混淆：本镜应出现「${declaredName}」，画面却更像角色「${verdict.withName}」（${verdict.bestOther?.toFixed(2)} vs 本角色 ${verdict.selfScore?.toFixed(2)}）`,
          fixHint: `re-render this shot strictly following the look of character "${declaredName}": check the first frame / reference image is bound to the right character (unique face/outfit/hair), then re-render; do not reuse another character's reference image`,
          durationSec: dur,
          vision: false
        }
      }
    } catch {
      // 角色混淆判别失败（模型/文件缺失）不阻塞：按原审核继续
    }
  }

  // 一致性：rerender 模式下低分算未过审
  const consistencyMode = (await rt.settings.get()).render.consistencyMode || 'warn'
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

  // LLM 视觉审核（技能库清单驱动）；提示式流程（skipVision）跳过，避免逐镜阻塞等待
  if (skipVision) {
    return { passed: true, reason: '', fixHint: undefined, durationSec: dur, vision: false }
  }
  if (!checklist.length) {
    return { passed: true, reason: '', fixHint: undefined, durationSec: dur, vision: false }
  }
  const char = project.characters.find(c => c.id === shot.characterIds[0])
  const board = (project.sceneBoards || []).find(b => b.id === shot.sceneBoardId)
  const audit = await rt.llm.auditImage({
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
    if (!rt.visionWarned.has(projectId)) {
      rt.visionWarned.add(projectId)
      rt.log(projectId, 'render', 'warn',
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
 * 逐镜审批（严格质检关卡）：
 * - 分段文件存在、含音轨、时长与画面设定匹配（含音频定格容差）、非纯色/黑帧
 * - 未过审镜头换 seed 重渲一轮；仍有未过审 → 阻断剪辑，等待人工处理
 */
export async function approveShots(rt: DirectorStageRuntime, projectId: string): Promise<{
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
    const project = await rt.store.get(projectId)
    for (const shot of project.shots) {
      if (shot.status !== 'done' || !shot.segmentPath) continue
      const abs = path.join(rt.baseDir, shot.segmentPath)
      if (!(await rt.ffmpeg.fileExists(abs))) {
        problems.set(shot.id, `第${shot.index}镜「${shot.scene}」分段文件缺失`)
        continue
      }
      try {
        const info = await rt.ffmpeg.getVideoInfo(abs)
        const dur = Math.round(info.durationSec * 10) / 10
        durations.set(shot.id, dur)
        if (!info.hasAudio) {
          problems.set(shot.id, `第${shot.index}镜「${shot.scene}」无音轨`)
          continue
        }
        // 时长仅作参考，不阻断剪辑：Wan/H3 实长常与设定差 1～2s，硬门会卡死整条流水线
        const expectSec = Math.max(1, Math.round((shot.frames - 1) / 16))
        if (dur < 0.8) {
          problems.set(shot.id, `第${shot.index}镜「${shot.scene}」时长过短（${dur.toFixed(1)}s）`)
          continue
        }
        if (Math.abs(dur - expectSec) > 3) {
          rt.log(
            projectId, 'render', 'warn',
            `第${shot.index}镜「${shot.scene}」时长 ${dur.toFixed(1)}s（设定 ${expectSec}s），已放行`
          )
        }
      } catch {
        problems.set(shot.id, `第${shot.index}镜「${shot.scene}」视频信息读取失败`)
        continue
      }
      if (await rt.ffmpeg.looksLikeBlankVideo(abs)) {
        problems.set(shot.id, `第${shot.index}镜「${shot.scene}」画面疑似纯色/黑帧`)
        continue
      }
      // 角色混淆相对判别（多角色剧）：本镜输出更像另一角色 → 问题项（触发自动重渲一轮）
      if (
        (project.characters || []).length > 1 &&
        shot.characterIds?.[0] &&
        shot.type === 'i2v'
      ) {
        try {
          const verdict = await rt.queue.checkShotRoleConfusion(projectId, shot, project)
          if (verdict?.confused) {
            const declaredName = project.characters.find(c => c.id === shot.characterIds![0])?.name || shot.characterIds![0]
            problems.set(
              shot.id,
              `第${shot.index}镜「${shot.scene}」角色混淆：应出现「${declaredName}」，画面更像「${verdict.withName}」（${verdict.bestOther?.toFixed(2)} vs 本角色 ${verdict.selfScore?.toFixed(2)}）`
            )
          }
        } catch {
          // 判别失败不阻断
        }
      }
    }
    return { problems, durations }
  }

  const consistencyMode = (await rt.settings.get()).render.consistencyMode || 'warn'
  // 一致性低分只告警不阻断（P0-2）：ArcFace 对"定妆证件照 vs 表情帧"的姿态差会误杀同人，
  // 阻断会让整条流水线死锁（实测重渲救不回 0.2x 分）。结构性硬问题仍严格阻断。
  const warnings = new Set<string>()
  const inspectWithConsistency = async () => {
    const base = await inspect()
    if (consistencyMode !== 'rerender') return base
    const project = await rt.store.get(projectId)
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

  // 未过审镜头换 seed 重渲一轮（最多一次自动重试）
  const retryIds = [...problems.keys()]
  rt.setStage(projectId, 'render', 'running',
    `${retryIds.length} 镜未过审（${[...problems.values()][0]}...），换种子重渲中...`, 92)
  const project = await rt.store.get(projectId)
  for (const shot of project.shots) {
    if (retryIds.includes(shot.id)) {
      shot.seed = Math.floor(Math.random() * 0xffffffff)
    }
  }
  await rt.store.save(project)
  // 重渲窗口必须挂流水线进度监听（D3）：否则 progress 事件落入影子通道，
  // onExternalProgress 对已完成的镜头再次 doneShots++ 造成计数虚增
  rt.subscribeRenderProgress(projectId)
  try {
    await rt.queue.start(projectId, retryIds)
    await rt.queue.waitForFinish(projectId)
  } catch {
    // 结果由复检判定
  } finally {
    rt.unsubscribeRenderProgress(projectId)
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
