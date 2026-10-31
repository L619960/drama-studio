/**
 * 对话工具·导演任务控制域：开拍/暂停/继续/取消/状态/分镜列表/重渲/试片/预告片/首帧重建。
 * 从 conversationTools.ts 按域拆分外移，行为不变。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ConversationToolsHost, ToolResult } from './conversationTools'
import type { DirectorStage, DirectorState, Shot } from '../../shared/ipcTypes'
import { RESULT_LIMIT } from './conversationConstants'
import { STAGE_ORDER } from './directorConstants'

/**
 * P0-2：任务未停在确认点时，判断「继续」应从哪个阶段续跑。
 * 优先用 hydrate 记录的中断阶段；否则取流水线顺序第一个未完成阶段（跳过已完成/已跳过）。
 * 返回 null 表示所有可执行阶段都已完成。
 */
function resumeFallbackStage(st: DirectorState): DirectorStage | null {
  const recorded = st.interruptedStage
  if (recorded && recorded !== 'done') return recorded
  for (const stage of STAGE_ORDER) {
    if (stage === 'done') break
    const info = st.stages[stage]
    if (info.status !== 'done' && info.status !== 'skipped') return stage
  }
  return null
}

export async function tStart(
  host: ConversationToolsHost,
  pid: string | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const title = String(args.title || '').trim()
  const genre = String(args.genre || '').trim()
  const script = String(args.script || '').trim()
  if (!title || !genre || !script) {
    return { ok: false, text: '缺少片名/题材/剧本，不能开拍' }
  }
  if (pid) {
    const st = host.director.getState(pid)
    if (st?.running) return { ok: false, text: `当前项目《${st.title}》已有任务在执行，请先暂停或取消` }
  }
  const gateStages = Array.isArray(args.gate_stages)
    ? (args.gate_stages as string[]).filter((g) => typeof g === 'string')
    : ['analyze', 'render']
  const newId = await host.director.start({
    title,
    genre,
    script,
    gateStages: gateStages as DirectorStage[],
    existingProjectId: pid,
  })
  host.lastProjectId = newId
  return { ok: true, text: JSON.stringify({ started: true, projectId: newId, title, gateStages }) }
}

export async function tSimple(
  host: ConversationToolsHost,
  pid: string | undefined,
  action: 'pause' | 'resume' | 'cancel',
): Promise<ToolResult> {
  if (!pid) return { ok: false, text: '当前没有打开的项目，无法执行该操作' }
  const st = host.director.getState(pid)
  if (!st) return { ok: false, text: '当前项目没有任务记录' }
  if (action === 'pause') {
    if (!st.running || st.paused) return { ok: false, text: '任务当前不在执行中（可能已暂停或已结束）' }
    await host.director.pause(pid)
  } else if (action === 'resume') {
    if (st.paused) {
      await host.director.resume(pid)
    } else if (st.running) {
      return { ok: false, text: '任务正在运行中，无需继续' }
    } else if (st.cancelled) {
      return { ok: false, text: '任务已被取消；如需重跑，请指明从哪个阶段续跑' }
    } else {
      // P0-2：应用重启/崩溃/阶段失败后没有阶段门确认点（paused=false），
      // 旧逻辑直接回「无需继续」把用户卡死；这里自动断点续跑到中断（或首个未完成）阶段。
      const stage = resumeFallbackStage(st)
      if (!stage) return { ok: false, text: '所有阶段均已完成，无需继续' }
      try {
        await host.director.resumeFromStage(pid, stage)
      } catch (e) {
        return { ok: false, text: `无法继续：${e instanceof Error ? e.message : String(e)}` }
      }
    }
  } else {
    await host.director.cancel(pid)
  }
  const p = await host.projects.get(pid)
  return { ok: true, text: JSON.stringify({ action, accepted: true, projectId: pid, projectTitle: p.title }) }
}

export async function tStatus(host: ConversationToolsHost, pid: string | undefined): Promise<ToolResult> {
  if (!pid) return { ok: false, text: '当前没有打开的项目' }
  const st = host.director.getState(pid)
  if (!st) return { ok: true, text: JSON.stringify({ hasTask: false, projectId: pid }) }
  return {
    ok: true,
    text: JSON.stringify({
      hasTask: true,
      projectId: pid,
      title: st.title,
      running: st.running,
      paused: st.paused,
      cancelled: st.cancelled,
      totalShots: st.totalShots,
      doneShots: st.doneShots,
      failedShotIds: st.failedShotIds,
      reviewIssues: st.reviewIssues || [],
      finalPath: st.finalPath || null,
      stages: Object.fromEntries(
        Object.entries(st.stages).map(([k, v]) => [k, { status: v.status, message: v.message, percent: v.percent }]),
      ),
    }),
  }
}

export async function tListShots(host: ConversationToolsHost, pid: string | undefined): Promise<ToolResult> {
  if (!pid) return { ok: false, text: '当前没有打开的项目' }
  const p = await host.projects.get(pid)
  const shots = p.shots.slice(0, 60).map((s) => ({
    index: s.index,
    type: s.type,
    shotSize: s.shotSize || null,
    character: s.characterIds.length ? p.characters.find((c) => c.id === s.characterIds[0])?.name || '' : '',
    scene: s.scene,
    dialogue: s.dialogue || '',
    status: s.status,
  }))
  return {
    ok: true,
    text: JSON.stringify({
      projectId: pid,
      title: p.title,
      genre: p.genre,
      total: p.shots.length,
      characters: p.characters.map((c) => `${c.name}(${c.voice})`),
      shots,
    }).slice(0, RESULT_LIMIT),
  }
}

export async function tRerender(
  host: ConversationToolsHost,
  pid: string | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (!pid) return { ok: false, text: '当前没有打开的项目' }
  const indexes = Array.isArray(args.shot_indexes) ? (args.shot_indexes as number[]).map(Number) : []
  if (!indexes.length) return { ok: false, text: '未指定镜号' }
  const p = await host.projects.get(pid)
  const ids = p.shots.filter((s) => indexes.includes(s.index)).map((s) => s.id)
  if (!ids.length) return { ok: false, text: `没有找到镜号：${indexes.join('、')}` }
  // 分镜首帧门禁用 shotReviewGate，与成片复审 reviewGate 分开。
  // 默认不重建已审首帧。仅 force_rebuild=true 时重建，并在重建后重新过门禁再入队。
  const settings = await host.settings.get()
  const shotGate = settings?.render?.shotReviewGate ?? 'block'
  const forceRebuild = args.force_rebuild === true
  let project = p
  if (forceRebuild) {
    await host.director.rebuildShotFirstFrames(pid, indexes)
    project = await host.projects.get(pid)
  }
  const targets = project.shots.filter((s) => ids.includes(s.id))
  const unreviewed = targets.filter((s) => s.type === 'i2v' && !s.reviewed)
  if (shotGate === 'block' && unreviewed.length > 0) {
    const names = unreviewed
      .slice(0, 5)
      .map((s) => `第${s.index}镜`)
      .join('、')
    const more = unreviewed.length > 5 ? ` 等 ${unreviewed.length} 镜` : ''
    const rebuilt = forceRebuild ? '首帧已重建，旧审核作废。' : ''
    return {
      ok: false,
      text: `分镜审核未通过：${names}${more} 尚未核对分镜图。${rebuilt}请引导用户先在「分镜审核」里逐镜核对并勾选确认，再重渲`,
    }
  }
  await host.queue.start(pid, ids)
  const warnNote =
    shotGate === 'warn' && unreviewed.length > 0
      ? `；注意：${unreviewed.map((s) => `第${s.index}镜`).join('、')} 尚未核对分镜图（按设置告警放行）`
      : ''
  return {
    ok: true,
    text:
      JSON.stringify({ queued: true, projectId: pid, shotIndexes: indexes, count: ids.length, rebuilt: forceRebuild }) +
      warnNote,
  }
}

// ---------------------------------------------------------------- 试片与预告片
export async function tRenderSample(
  host: ConversationToolsHost,
  pid: string | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (!pid) return { ok: false, text: '当前没有打开的项目' }
  const p = await host.projects.get(pid)
  const hasRendered = p.shots.some((s) => s.segmentPath)
  if (!hasRendered) {
    // 没有已渲染镜头：挑 2-3 个待渲染镜头走 taskQueue 渲染，然后拼接
    let indexes: number[] = []
    if (Array.isArray(args.shot_indexes)) {
      indexes = (args.shot_indexes as number[]).map(Number).filter((i) => i > 0 && i <= p.shots.length)
    }
    if (!indexes.length) {
      // 自动挑选：不同场景 + 至少一个有人物 + 景别有变化
      const candidates = p.shots.filter((s) => s.status === 'pending' || s.status === 'failed').slice(0, 15)
      const scenes = [...new Set(candidates.map((s) => s.scene).filter(Boolean))]
      const picked: Shot[] = []
      for (const sc of scenes) {
        if (picked.length >= 3) break
        const shot = candidates.find((s) => s.scene === sc && s.characterIds?.length)
        if (shot && !picked.includes(shot)) picked.push(shot)
      }
      if (picked.length < 2) {
        for (const s of candidates) {
          if (picked.length >= 2) break
          if (!picked.includes(s)) picked.push(s)
        }
      }
      indexes = picked.map((s) => s.index)
    }
    if (!indexes.length) return { ok: false, text: '没有可渲染的镜头，请确保项目已有分镜' }
    const ids = p.shots.filter((s) => indexes.includes(s.index)).map((s) => s.id)
    await host.queue.start(pid, ids)
    return {
      ok: true,
      text: JSON.stringify({
        queued: true,
        projectId: pid,
        title: p.title,
        shotIndexes: indexes,
        message: `已提交试片 ${indexes.length} 镜渲染，请等待完成后再生成样片`,
      }),
    }
  }
  // 已有渲染成果：直接拼样片（优先用用户指定的）
  let indexes: number[] = []
  if (Array.isArray(args.shot_indexes)) {
    indexes = (args.shot_indexes as number[]).map(Number).filter((i) => i > 0 && i <= p.shots.length)
  }
  let sources = p.shots.filter((s) => s.segmentPath)
  if (indexes.length) {
    sources = sources.filter((s) => indexes.includes(s.index))
  }
  if (!sources.length) return { ok: false, text: '指定的镜头尚未渲染完成' }
  if (sources.length > 4) sources = sources.slice(0, 4)
  const samplePath = path.join(host.baseDir, `projects/${pid}/sample.mp4`)
  await host.ffmpeg.concatSegments(
    sources.map((s) => path.join(host.baseDir, s.segmentPath!)),
    samplePath,
  )
  return {
    ok: true,
    text: JSON.stringify({
      sampleReady: true,
      projectId: pid,
      title: p.title,
      usedShots: sources.map((s) => s.index),
      samplePath,
      message: `试片已生成：${sources.length} 镜拼接，路径 ${samplePath}`,
    }),
  }
}

export async function tMakeTrailer(
  host: ConversationToolsHost,
  pid: string | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (!pid) return { ok: false, text: '当前没有打开的项目' }
  const p = await host.projects.get(pid)
  const rendered = p.shots.filter((s) => s.segmentPath)
  if (!rendered.length) return { ok: false, text: '当前项目还没有已渲染的镜头，无法制作预告片' }

  let indexes: number[] = []
  if (Array.isArray(args.shot_indexes)) {
    indexes = (args.shot_indexes as number[]).map(Number).filter((i) => i > 0 && i <= p.shots.length)
  }
  let sources = rendered
  if (indexes.length) {
    sources = rendered.filter((s) => indexes.includes(s.index))
  }
  if (!sources.length) return { ok: false, text: '指定的镜头尚未渲染完成' }
  if (sources.length > 10) sources = sources.slice(0, 10)

  const clipSec = Math.max(0.5, Math.min(3, Number(args.clip_seconds || 1.5)))
  const withBgm = args.with_bgm !== false
  const clipsDir = path.join(host.baseDir, `projects/${pid}/trailer_clips`)
  const trailerPath = path.join(host.baseDir, `projects/${pid}/trailer.mp4`)

  const clips: string[] = []
  for (const [i, s] of sources.entries()) {
    const full = path.join(host.baseDir, s.segmentPath!)
    const duration = await host.ffmpeg.getDuration(full)
    const start = Math.max(0, (duration - clipSec) / 2) // 取中段高光
    const clip = path.join(clipsDir, `c${i}.mp4`)
    await host.ffmpeg.trimClip(full, start, clipSec, clip)
    clips.push(clip)
  }

  // 拼接高光片段
  await host.ffmpeg.concatSegments(clips, trailerPath)

  // 可选混 BGM
  if (withBgm && p.bgmPath) {
    const bgmFull = path.join(host.baseDir, p.bgmPath)
    const mixed = trailerPath + '.bgm.mp4'
    await host.ffmpeg.mixBgm(trailerPath, bgmFull, mixed, p.bgmVolume ?? 35)
    // rename 直接覆盖原纯视频版；此前"先 unlink 再 rename 且吞错"会在 rename
    // 失败时把成片弄丢（只留下 .bgm.mp4 副产物）（M-7）
    await fs.rename(mixed, trailerPath)
  }

  // 清理临时片段
  for (const c of clips) {
    await fs.unlink(c).catch(() => undefined)
  }

  return {
    ok: true,
    text: JSON.stringify({
      trailerReady: true,
      projectId: pid,
      title: p.title,
      usedShots: sources.map((s) => s.index),
      clipSeconds: clipSec,
      withBgm,
      trailerPath,
      message: `预告片已生成：${sources.length} 段 × ${clipSec}s 快剪，路径 ${trailerPath}`,
    }),
  }
}

// ---------------------------------------------------------------- 首帧重建（executeTool 内联分支外移）

export async function tRebuildFrames(
  host: ConversationToolsHost,
  pid: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const shotIndexes = Array.isArray(args.shot_indexes) ? (args.shot_indexes as number[]).map(Number) : []
  if (!shotIndexes.length) return { ok: false, text: '未指定镜号（shot_indexes）' }
  return await host.director.rebuildShotFirstFrames(pid, shotIndexes)
}
