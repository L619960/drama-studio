import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { AnalyzeResult, Character, SceneBoard } from '../../shared/ipcTypes'
import { normalizeSceneKey } from '../../shared/ipcTypes'
import {
  faceCastingPrompt, bodySheetPrompt, panoramaScenePrompt,
  emptySceneNegativeFor, castingNegativeFor
} from '../../shared/imagePrompts'
import { resolveCreation } from '../../shared/creationSettings'
import { hardenLookEnList } from '../../shared/castAppearance'
import { ImageGenerateCancelled } from './imageService'
import type { DirectorAgent } from './directorAgent'
import { logImpl, isCancelledImpl } from './directorStateMachine'
import {
  ensureShadowStateImpl, emitProgressEventImpl, notifyProjectUpdatedImpl
} from './directorProgressBridge'

/**
 * 手动操作：重建首帧 / 重出定妆 / 重出场景全景。
 * 均为 IPC 直接调用的公开方法，接收 agent 作为上下文。
 */

export async function rebuildShotFirstFramesImpl(
  agent: DirectorAgent,
  projectId: string,
  shotIndexes: number[]
): Promise<{ ok: boolean; text: string }> {
  const project = await agent.store.get(projectId)
  const boardByKey = new Map<string, SceneBoard>()
  for (const b of project.sceneBoards || []) boardByKey.set(b.key, b)
  const sc = resolveCreation(await agent.settings.get()).scene
  const abort = (): boolean => isCancelledImpl(agent, projectId)
  const targets = project.shots.filter(s => shotIndexes.includes(s.index) && s.type === 'i2v')
  if (!targets.length) return { ok: false, text: `未找到可重建首帧的 i2v 镜头：${shotIndexes.join('、')}` }
  const shadow = ensureShadowStateImpl(agent, projectId)
  const total = targets.length
  const pushStage = (done: number, msg: string): void => {
    shadow.stages.render = { status: 'running', message: msg, percent: Math.round((done / total) * 100) }
    emitProgressEventImpl(agent, projectId)
  }
  pushStage(0, `重渲前重建首帧 0/${total}…`)
  logImpl(agent, projectId, 'render', 'info', `重渲前重建 ${total} 个 i2v 镜头首帧（每镜约 1 分钟）…`)
  let okCount = 0
  const failDetail: string[] = []
  let cursor = 0
  for (const shot of targets) {
    if (abort()) return { ok: false, text: '已取消' }
    cursor++
    pushStage(cursor - 1, `重建首帧 ${cursor - 1}/${total}：镜${shot.index} 生成中…`)
    logImpl(agent, projectId, 'render', 'info', `镜${shot.index} 重建首帧中（${cursor}/${total}）…`)
    const as = {
      type: 'i2v' as const,
      characterName: project.characters.find(c => c.id === shot.characterIds[0])?.name || '',
      scene: shot.scene,
      sceneEn: (shot as unknown as { sceneEn?: string }).sceneEn,
      shotSize: shot.shotSize,
      camera: shot.camera,
      emotion: shot.emotion,
      lighting: shot.lighting,
      facing: shot.facing,
      continuity: shot.continuity,
      props: shot.props,
      action: shot.action,
      firstFrameEn: shot.firstFrameEn,
      lastFrameEn: shot.lastFrameEn
    } as AnalyzeResult['shots'][number]
    const d: {
      id: string
      index: number
      as: AnalyzeResult['shots'][number]
      board?: SceneBoard
      characterIds: string[]
      character?: Character
      firstFramePath?: string
    } = {
      id: shot.id,
      index: shot.index,
      as,
      board: shot.sceneBoardId ? boardByKey.get(normalizeSceneKey(shot.scene)) : undefined,
      characterIds: shot.characterIds,
      character: project.characters.find(c => c.id === shot.characterIds[0])
    }
    try {
      await agent.generateShotFirstFrame(projectId, d, sc, abort, project.characters.map(c => c.name))
      if (d.firstFramePath) {
        shot.firstFramePath = d.firstFramePath
        shot.reviewed = undefined
        shot.status = 'pending'
        shot.segmentPath = ''
        okCount++
        logImpl(agent, projectId, 'render', 'success', `镜${shot.index} 首帧已重建`)
      }
    } catch (e) {
      failDetail.push(`镜${shot.index}: ${e instanceof Error ? e.message : String(e)}`)
      logImpl(agent, projectId, 'render', 'warn', `镜${shot.index} 首帧重建失败：${e instanceof Error ? e.message : String(e)}`)
    }
    pushStage(cursor, `重建首帧 ${cursor}/${total}`)
  }
  pushStage(total, `首帧重建完成 ${okCount}/${total}，渲染队列启动中…`)
  logImpl(agent, projectId, 'render', okCount === targets.length ? 'success' : 'warn',
    `首帧重建完成 ${okCount}/${targets.length}，开始入队渲染视频`)
  await agent.store.save(project)
  notifyProjectUpdatedImpl(agent, projectId)
  const text = failDetail.length
    ? `重建首帧：成功 ${okCount}/${targets.length}；失败 ${failDetail.join('；')}`
    : `重建首帧完成：${okCount}/${targets.length}（后续可重渲这些镜头）`
  return { ok: failDetail.length === 0, text }
}

export async function rerunCastingImpl(
  agent: DirectorAgent,
  projectId: string
): Promise<{ ok: boolean; text: string }> {
  const project = await agent.store.get(projectId)
  const chars = project.characters
  if (!chars.length) return { ok: false, text: '项目暂无角色，无法重出定妆' }
  const settingsSnap = await agent.settings.get()
  const ch = resolveCreation(settingsSnap).character
  const wfOpt = ch.t2iWorkflow ? { workflowName: ch.t2iWorkflow } : {}
  const neg = { negative: castingNegativeFor(ch.realismLock) }
  const abort = (): boolean => isCancelledImpl(agent, projectId)
  let okCount = 0
  const failDetail: string[] = []
  const genre = project.genre
  const hardenedLooks = hardenLookEnList(
    chars.map(c => c.appearanceLock || 'chinese person, natural everyday appearance'),
    genre
  ).looks
  for (const [ci, character] of chars.entries()) {
    const lookEn = hardenedLooks[ci] || character.appearanceLock || 'chinese person, natural everyday appearance'
    const faceRel = `projects/${projectId}/characters/${character.id}_face.png`
    const bodyRel = `projects/${projectId}/characters/${character.id}_body.png`
    try {
      await agent.image.generate(
        faceCastingPrompt(lookEn, { realismLock: ch.realismLock, genre }),
        path.join(agent.baseDir, faceRel),
        { width: ch.faceWidth, height: ch.faceHeight, seed: Math.floor(Math.random() * 0xffffffff), ...wfOpt, ...neg, shouldAbort: abort }
      )
      character.faceImagePath = faceRel
      character.refImagePath = character.refImagePath || faceRel
    } catch (e) {
      if (e instanceof ImageGenerateCancelled) throw e
      failDetail.push(`「${character.name}」面部：${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      await agent.image.generate(
        bodySheetPrompt(lookEn, { realismLock: ch.realismLock, genre }),
        path.join(agent.baseDir, bodyRel),
        { width: ch.bodyWidth, height: ch.bodyHeight, seed: Math.floor(Math.random() * 0xffffffff), ...wfOpt, ...neg, shouldAbort: abort }
      )
      character.bodySheetPath = bodyRel
      if (!character.refImagePath) character.refImagePath = bodyRel
    } catch (e) {
      if (e instanceof ImageGenerateCancelled) throw e
      failDetail.push(`「${character.name}」三视图：${e instanceof Error ? e.message : String(e)}`)
    }
    okCount++
  }
  await agent.store.save(project)
  notifyProjectUpdatedImpl(agent, projectId)
  const text = failDetail.length
    ? `重出定妆：完成 ${okCount}/${chars.length}，失败 ${failDetail.join('；')}`
    : `重出定妆完成：${okCount} 位角色（面部+三视图已重出）`
  return { ok: failDetail.length === 0, text }
}

export async function regenerateScenePanoImpl(
  agent: DirectorAgent,
  projectId: string,
  boardId: string
): Promise<{ ok: boolean; text: string }> {
  try {
    const project = await agent.store.get(projectId)
    const board = (project.sceneBoards || []).find(b => b.id === boardId)
    if (!board) return { ok: false, text: '场景板不存在' }
    const sc = resolveCreation(await agent.settings.get()).scene
    const panoViewsCount = Math.max(2, Math.min(6, sc.panoViewsCount || 4))
    const scenesDir = path.join(agent.baseDir, 'projects', projectId, 'scenes')
    await fs.mkdir(scenesDir, { recursive: true })
    const panoRel = `projects/${projectId}/scenes/${board.id}_pano.png`
    const panoAbs = path.join(agent.baseDir, panoRel)
    const seed = Math.floor(Math.random() * 0xffffffff)
    await agent.image.generate(
      panoramaScenePrompt(board.description || board.name, undefined, { weatherHint: sc.weatherHint }),
      panoAbs,
      { width: 1536, height: 768, seed, negative: emptySceneNegativeFor('standard', board.description || board.name), workflowName: 'klein_t2i_clean' }
    )
    const viewsAbs = await agent.ffmpeg.cropPanoramaViews(panoAbs, scenesDir, {
      count: panoViewsCount,
      outW: 480,
      outH: 864,
      prefix: board.id
    })
    const viewsRel = viewsAbs.map(v => `projects/${projectId}/scenes/${path.basename(v)}`)
    let gridRel: string | undefined
    try {
      gridRel = `projects/${projectId}/scenes/${board.id}_pano_grid.png`
      await agent.ffmpeg.tileImages(viewsAbs, path.join(agent.baseDir, gridRel), {
        cols: 2, cellW: 384, cellH: 691
      })
    } catch (e) {
      logImpl(agent, projectId, 'scenes', 'warn',
        `场景「${board.name}」宫格看板拼接失败：${e instanceof Error ? e.message : String(e)}`)
    }
    await agent.store.update(projectId, (p) => {
      const b = (p.sceneBoards || []).find(x => x.id === boardId)
      if (!b) return
      b.panoPath = panoRel
      b.panoViews = viewsRel
      b.panoGrid = gridRel
      b.emptyPlatePath = viewsRel[0]
      for (const s of p.shots || []) {
        if (s.sceneBoardId === boardId && s.type === 't2v') s.sceneImagePath = viewsRel[0]
      }
    })
    notifyProjectUpdatedImpl(agent, projectId)
    return { ok: true, text: `全景场景「${board.name}」已重出（${viewsRel.length} 方位 + 宫格看板）` }
  } catch (e) {
    return { ok: false, text: `全景重出失败：${e instanceof Error ? e.message : String(e)}` }
  }
}
