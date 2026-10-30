﻿import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { ImageGenerateCancelled } from './imageService'
import { mapPool } from './asyncPool'
import type {
  AnalyzeResult, Character, Shot, SceneBoard
} from '../../shared/ipcTypes'
import { normalizeSceneKey } from '../../shared/ipcTypes'
import {
  scenePlatePrompt, shotFramePrompt, SHOT_SIZE_CUE,
  panoramaScenePrompt, emptySceneNegativeFor, stripOtherPersonClauses,
  soloizeAction, maskCastNames, alignStoryboardPrompts, stripDialogueDirections
} from '../../shared/imagePrompts'
import { resolveCreation } from '../../shared/creationSettings'
import {
  pickPanoView, buildCloseupEditPrompt, buildPanoEditPrompt, sanitizeCameraForFrame
} from './directorPrompts'
import { castNameVariants } from './roleBinding'
import type { DirectorStageRuntime } from './directorStageAssets'

/**
 * 单镜首帧生成（人物镜 i2v）——供 buildShots 建档与「重建首帧」共用：
 * 优先级：单图定妆融合（firered_i2i_edit，定妆图做底，人物 100% 锁定）
 *      → 全景双图融合（firered_i2i_two，场景方位图+定妆图，备选）
 *      → 文生兜底（带人物数量/道具强约束）→ 复制定妆图。
 * 双图融合对横版三视图定妆图参考鲁棒性差（实测镜2/3 角色/性别/服装失控、单人镜变双人），
 * 故仅作备选；单图模式输出竖版（定妆图为竖版头肩），并强制「背景替换、肢体完整」。
 */
export async function generateShotFirstFrame(
  rt: DirectorStageRuntime,
  projectId: string,
  d: {
    id: string
    index: number
    as: AnalyzeResult['shots'][number]
    board?: SceneBoard
    characterIds: string[]
    character?: Character
    /** 首帧生成产物相对路径（本方法内写回） */
    firstFramePath?: string
  },
  sc: { frameWidth: number; frameHeight: number },
  abort: () => boolean,
  allCharacterNames: string[] = []
): Promise<void> {
  const look = d.character?.appearanceLock || 'chinese person, natural everyday appearance'
  const sizeCue = SHOT_SIZE_CUE[d.as.shotSize || 'medium']
  const env = d.as.sceneEn || d.as.scene
  // 单人居：首帧只允许主体。LLM 动作常写英文名（Su Tang / Lu Hanzhou），只屏蔽中文名会漏网，
  // 成片《鱼塘》镜6 因此画出双分身。中文名 + 拼音变体一并屏蔽，再剥对戏肢体接触。
  const selfVariants = castNameVariants(d.character?.name || '')
  const otherVariants = allCharacterNames
    .filter(n => n && n !== d.character?.name)
    .flatMap(n => castNameVariants(n))
  const maskOtherIn = (t: string): string =>
    soloizeAction(stripOtherPersonClauses(maskCastNames(t, {
      selfNames: selfVariants,
      otherNames: otherVariants
    })))
  // 镜内场景描述：优先 continuity（含本镜起点的具体场景/站位），次选 action——
  // 防止场景板底图与镜动作场景错位；对戏角色名已屏蔽为画外对象（单人居）
  const shotSceneDesc = maskOtherIn(d.as.continuity?.trim() || d.as.action?.trim() || '')
  const plateHint = (d.board?.emptyPlatePath
    ? `matching the empty location plate mood of ${env}`
    : env) + (shotSceneDesc ? `；本镜场景：${shotSceneDesc}` : '')
  const firstRel = `projects/${projectId}/shots/${d.id}_first.png`
  const firstAbs = path.join(rt.baseDir, firstRel)
  const faceAbs = d.character?.faceImagePath
    ? path.join(rt.baseDir, d.character.faceImagePath)
    : ''
  // 供 build*EditPrompt 使用的净化副本：动作/连续性里对戏角色名屏蔽为画外对象，camera 剥离第二人从句
  const dMasked = {
    ...d,
    as: {
      ...d.as,
      action: maskOtherIn(d.as.action?.trim() || ''),
      continuity: maskOtherIn(d.as.continuity?.trim() || ''),
      camera: sanitizeCameraForFrame(d.as.camera?.trim() || '')
    }
  }

  const imageWorkflow = faceAbs ? 'qwen2511_i2i_edit' : 't2i'
  rt.log(projectId, 'scenes', 'info', `第${d.index}镜出图前核对动作提示词，工作流 ${imageWorkflow}`)
  if (faceAbs) {
    // 一级：单图定妆融合（定妆图做底，锁脸/发型/服装/肤色最稳）
    try {
      await rt.image.generate(
        buildCloseupEditPrompt(look, plateHint, dMasked, sizeCue, 'start'),
        firstAbs,
        {
          workflowName: 'qwen2511_i2i_edit',
          referenceImagePath: faceAbs,
          shouldAbort: abort
        }
      )
      d.firstFramePath = firstRel
    } catch (e) {
      if (e instanceof ImageGenerateCancelled) throw e
      rt.log(projectId, 'scenes', 'warn',
        `第${d.index}镜单图定妆融合失败（${e instanceof Error ? e.message : String(e)}），尝试全景双图融合`)
      // 二级：全景双图融合（场景方位图做底 + 定妆图参考，备选）
      const panoViewRel = pickPanoView(d.as.camera, d.board?.panoViews)
      if (panoViewRel) {
        try {
          await rt.image.generate(
            buildPanoEditPrompt(look, plateHint, dMasked, sizeCue, 'start'),
            firstAbs,
            {
              workflowName: 'qwen2511_i2i_two',
              referenceImagePaths: [path.join(rt.baseDir, panoViewRel), faceAbs],
              strictWorkflow: true,
              shouldAbort: abort
            }
          )
          d.firstFramePath = firstRel
        } catch (e2) {
          if (e2 instanceof ImageGenerateCancelled) throw e2
          rt.log(projectId, 'scenes', 'warn',
            `第${d.index}镜全景双图融合失败（${e2 instanceof Error ? e2.message : String(e2)}），回退文生`)
        }
      }
    }
  }
  if (!d.firstFramePath) {
    // 三级：文生兜底（带人物数量/道具强约束）；再失败且有人物定妆图 → 复制定妆图
    try {
      // 首帧场景一致性：首帧一律以 action 起点姿态为权威（firstFrameEn 常与 action 场景/动作冲突，
      // 如"店外收伞"vs"店内递剪"——直接用 action 最稳），action 为空时回退 firstFrameEn
      const frameAction = dMasked.as.action?.trim() || dMasked.as.firstFrameEn?.trim() || ''
      await rt.image.generate(
        shotFramePrompt({
          phase: 'start',
          lookEn: look,
          scene: plateHint,
          action: frameAction,
          shotSizeCue: sizeCue,
          emotion: dMasked.as.emotion || undefined,
          camera: dMasked.as.camera || undefined,
          lighting: dMasked.as.lighting,
          facing: dMasked.as.facing,
          continuity: dMasked.as.continuity,
          characterCount: d.characterIds.length || 1,
          props: d.as.props
        }),
        firstAbs,
        { width: sc.frameWidth, height: sc.frameHeight, shouldAbort: abort, workflowName: 'klein_t2i_clean' }
      )
      d.firstFramePath = firstRel
    } catch (e) {
      if (e instanceof ImageGenerateCancelled) throw e
      if (faceAbs) {
        try {
          await fs.copyFile(faceAbs, firstAbs)
          d.firstFramePath = firstRel
        } catch { /* 三级都失败：留空，渲染时 resolveRefImageRel 回退定妆图 */ }
      }
    }
  }
}

/**
 * 重建指定镜头首帧（i2v 人物镜）：用最新单图锁定逻辑重新生成并覆盖 firstFramePath。
 * 用于 P0 修复后重渲前重建首帧（旧首帧角色/服装锁不住），不触发渲染本身。
 */
export async function rebuildShotFirstFrames(
  rt: DirectorStageRuntime,
  projectId: string,
  shotIndexes: number[]
): Promise<{ ok: boolean; text: string }> {
  const project = await rt.store.get(projectId)
  const boardByKey = new Map<string, SceneBoard>()
  for (const b of project.sceneBoards || []) boardByKey.set(b.key, b)
  const sc = resolveCreation(await rt.settings.get()).scene
  const abort = (): boolean => rt.isCancelled(projectId)
  const targets = project.shots.filter(s => shotIndexes.includes(s.index) && s.type === 'i2v')
  if (!targets.length) return { ok: false, text: `未找到可重建首帧的 i2v 镜头：${shotIndexes.join('、')}` }
  // 该阶段可能耗时数分钟（每镜一次图生）：驱动阶段行进度条 + 日志，不能隐藏跑
  const shadow = rt.ensureShadowState(projectId)
  const total = targets.length
  const pushStage = (done: number, msg: string): void => {
    shadow.stages.render = { status: 'running', message: msg, percent: Math.round((done / total) * 100) }
    rt.emitProgressEvent(projectId)
  }
  pushStage(0, `重渲前重建首帧 0/${total}…`)
  rt.log(projectId, 'render', 'info', `重渲前重建 ${total} 个 i2v 镜头首帧（每镜约 1 分钟）…`)
  let okCount = 0
  const failDetail: string[] = []
  let cursor = 0
  for (const shot of targets) {
    if (abort()) return { ok: false, text: '已取消' }
    cursor++
    pushStage(cursor - 1, `重建首帧 ${cursor - 1}/${total}：镜${shot.index} 生成中…`)
    rt.log(projectId, 'render', 'info', `镜${shot.index} 重建首帧中（${cursor}/${total}）…`)
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
      await generateShotFirstFrame(rt, projectId, d, sc, abort, project.characters.map(c => c.name))
      if (d.firstFramePath) {
        shot.firstFramePath = d.firstFramePath
        // 分镜图已更换，旧审核结论作废：不清则 reviewGate 门禁被旧标志放行（S5）
        shot.reviewed = undefined
        // 重渲前清掉旧视频产物状态，让 queue.start 重新渲染
        shot.status = 'pending'
        shot.segmentPath = ''
        shot.intentReset = true
        okCount++
        rt.log(projectId, 'render', 'success', `镜${shot.index} 首帧已重建`)
      }
    } catch (e) {
      failDetail.push(`镜${shot.index}: ${e instanceof Error ? e.message : String(e)}`)
      rt.log(projectId, 'render', 'warn', `镜${shot.index} 首帧重建失败：${e instanceof Error ? e.message : String(e)}`)
    }
    pushStage(cursor, `重建首帧 ${cursor}/${total}`)
  }
  pushStage(total, `首帧重建完成 ${okCount}/${total}，渲染队列启动中…`)
  rt.log(projectId, 'render', okCount === targets.length ? 'success' : 'warn',
    `首帧重建完成 ${okCount}/${targets.length}，开始入队渲染视频`)
  await rt.store.save(project)
  rt.notifyProjectUpdated(projectId)
  const text = failDetail.length
    ? `重建首帧：成功 ${okCount}/${targets.length}；失败 ${failDetail.join('；')}`
    : `重建首帧完成：${okCount}/${targets.length}（后续可重渲这些镜头）`
  return { ok: failDetail.length === 0, text }
}

/**
 * 手动重出单个场景的全景固定场景（复用流水线同款链路）：
 * 生成 2:1 全景 → 裁 N 张竖版方位图 → 拼宫格看板 → 更新 board 字段并同步同板 t2v 分镜 sceneImagePath。
 * 场景板页「重出全景」按钮调用；非全景项目可用旧路径（SceneBoardView.generatePlate）。
 */
export async function regenerateScenePano(
  rt: DirectorStageRuntime,
  projectId: string,
  boardId: string
): Promise<{ ok: boolean; text: string }> {
  try {
    const project = await rt.store.get(projectId)
    const board = (project.sceneBoards || []).find(b => b.id === boardId)
    if (!board) return { ok: false, text: '场景板不存在' }
    const sc = resolveCreation(await rt.settings.get()).scene
    const panoViewsCount = Math.max(2, Math.min(6, sc.panoViewsCount || 4))
    const scenesDir = path.join(rt.baseDir, 'projects', projectId, 'scenes')
    await fs.mkdir(scenesDir, { recursive: true })
    const panoRel = `projects/${projectId}/scenes/${board.id}_pano.png`
    const panoAbs = path.join(rt.baseDir, panoRel)
    const seed = Math.floor(Math.random() * 0xffffffff)
    await rt.image.generate(
      panoramaScenePrompt(board.description || board.name, undefined, { weatherHint: sc.weatherHint }),
      panoAbs,
      { width: 1536, height: 768, seed, negative: emptySceneNegativeFor('standard', board.description || board.name), workflowName: 'klein_t2i_clean' }
    )
    const viewsAbs = await rt.ffmpeg.cropPanoramaViews(panoAbs, scenesDir, {
      count: panoViewsCount,
      outW: 480,
      outH: 864,
      prefix: board.id
    })
    const viewsRel = viewsAbs.map(v => `projects/${projectId}/scenes/${path.basename(v)}`)
    // 宫格看板失败不阻断（仅方位图仍可用）
    let gridRel: string | undefined
    try {
      gridRel = `projects/${projectId}/scenes/${board.id}_pano_grid.png`
      await rt.ffmpeg.tileImages(viewsAbs, path.join(rt.baseDir, gridRel), {
        cols: 2, cellW: 384, cellH: 691
      })
    } catch (e) {
      rt.log(projectId, 'scenes', 'warn',
        `场景「${board.name}」宫格看板拼接失败：${e instanceof Error ? e.message : String(e)}`)
    }
    await rt.store.update(projectId, (p) => {
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
    rt.notifyProjectUpdated(projectId)
    return { ok: true, text: `全景场景「${board.name}」已重出（${viewsRel.length} 方位 + 宫格看板）` }
  } catch (e) {
    return { ok: false, text: `全景重出失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * 分镜建档：先出场景板库 → 再挂板生成每镜首帧/尾帧
 * - 同场景键复用一张无人空场景板
 * - t2v：直接用场景板作为 sceneImagePath
 * - i2v：场景板氛围 + 角色锁定外观 → 首帧；中景/远景再出尾帧
 */
export async function buildShots(
  rt: DirectorStageRuntime,
  projectId: string,
  analysis: AnalyzeResult,
  characterMap: Map<string, Character>
): Promise<void> {
  const lookOf = (shot: AnalyzeResult['shots'][number]): string =>
    characterMap.get(shot.characterName || '')?.appearanceLock || ''
  const aligned = alignStoryboardPrompts(analysis.shots, lookOf)
  analysis.shots = aligned.shots
  const s = await rt.settings.get()
  const shots: Shot[] = []
  const total = analysis.shots.length
  let frameFailed = 0

  await fs.mkdir(path.join(rt.baseDir, 'projects', projectId, 'scenes'), { recursive: true })

  // —— 1) 场景板库：按场景键去重生成无人空场景 ——
  const boardByKey = new Map<string, SceneBoard>()
  const uniqueScenes: Array<{ key: string; name: string; sceneEn?: string; emotion?: string }> = []
  for (const as of analysis.shots) {
    const key = normalizeSceneKey(as.scene || 'unnamed')
    if (boardByKey.has(key) || uniqueScenes.some(u => u.key === key)) continue
    uniqueScenes.push({
      key,
      name: as.scene || 'unnamed',
      sceneEn: as.sceneEn,
      emotion: as.emotion
    })
  }

  const settingsSnap = await rt.settings.get()
  const concurrency = Math.max(1, Math.min(3, settingsSnap.render.assetConcurrency || 2))
  const sc = resolveCreation(settingsSnap).scene
  const plateCount = Math.max(1, Math.min(4, sc.candidates || 1))
  const plateOpts = {
    weatherHint: sc.weatherHint,
    emptyStrict: sc.emptyStrict
  }
  // 全景固定场景：同一场景所有镜头从同一张 2:1 全景裁出的方位图取景（场景不漂移）
  const panoOn = sc.panorama !== false
  const panoViewsCount = Math.max(2, Math.min(6, sc.panoViewsCount || 4))
  const abort = (): boolean => rt.isCancelled(projectId)
  let platesDone = 0
  rt.setStage(projectId, 'scenes', 'running',
    `并发生成${panoOn ? `全景场景板（裁${panoViewsCount}方位）` : '场景板'} 0/${uniqueScenes.length}（并发 ${concurrency}${panoOn ? '' : `，抽卡×${plateCount}`}）...`, 5)

  await mapPool(uniqueScenes, concurrency, async (u, bi) => {
    if (abort()) throw new ImageGenerateCancelled()
    const boardId = `scene_${Date.now()}_${bi}_${Math.random().toString(36).slice(2, 6)}`
    const plateRel = `projects/${projectId}/scenes/${boardId}_plate.png`
    const board: SceneBoard = {
      id: boardId,
      key: u.key,
      name: u.name,
      // 英文环境短语落进场景板（重出全景/空景时复用，避免只剩中文场景名导致场景跑偏）
      description: u.sceneEn || u.name,
      emptyPlatePath: ''
    }
    try {
      if (panoOn) {
        // —— 全景分支：生成 2:1 全景 → 裁 N 张竖版方位图 ——
        const scenesDir = path.join(rt.baseDir, 'projects', projectId, 'scenes')
        const panoRel = `projects/${projectId}/scenes/${boardId}_pano.png`
        const panoAbs = path.join(rt.baseDir, panoRel)
        const seed = Math.floor(Math.random() * 0xffffffff)
        await rt.image.generate(
          panoramaScenePrompt(u.sceneEn || u.name, u.emotion || undefined, { weatherHint: sc.weatherHint }),
          panoAbs,
          { width: 1536, height: 768, seed, negative: emptySceneNegativeFor('standard', u.sceneEn || u.name), shouldAbort: abort, workflowName: 'klein_t2i_clean' }
        )
        const viewsAbs = await rt.ffmpeg.cropPanoramaViews(panoAbs, scenesDir, {
          count: panoViewsCount,
          outW: 480,
          outH: 864,
          prefix: boardId
        })
        board.panoPath = panoRel
        board.panoViews = viewsAbs.map(v => `projects/${projectId}/scenes/${path.basename(v)}`)
        // 方位图拼宫格看板（导演台可视化：一眼看全场景各方位，检查一致性）
        try {
          const gridRel = `projects/${projectId}/scenes/${boardId}_pano_grid.png`
          await rt.ffmpeg.tileImages(viewsAbs, path.join(rt.baseDir, gridRel), {
            cols: 2, cellW: 384, cellH: 691
          })
          board.panoGrid = gridRel
        } catch (e) {
          rt.log(projectId, 'scenes', 'warn',
            `场景「${u.name}」宫格看板拼接失败：${e instanceof Error ? e.message : String(e)}`)
        }
        // emptyPlatePath 兼容：旧逻辑/UI 读取它，取前视方位图
        board.emptyPlatePath = board.panoViews[0]
        rt.log(projectId, 'scenes', 'info',
          `场景「${u.name}」全景图生成 + 裁 ${board.panoViews.length} 方位（0°起逆时针）`)
      } else {
        // —— 旧版：单张竖版空场景板 + 抽卡 ——
        const candRels: Array<{ rel: string; seed: number }> = []
        for (let ci = 0; ci < plateCount; ci++) {
          if (abort()) throw new ImageGenerateCancelled()
          const seed = Math.floor(Math.random() * 0xffffffff)
          const rel = plateCount === 1
            ? plateRel
            : `projects/${projectId}/scenes/${boardId}_plate_c${ci}.png`
          await rt.image.generate(
            scenePlatePrompt(u.sceneEn || u.name, u.emotion || undefined, plateOpts),
            path.join(rt.baseDir, rel),
            { width: sc.plateWidth, height: sc.plateHeight, seed, negative: emptySceneNegativeFor('standard', u.sceneEn || u.name), shouldAbort: abort, workflowName: 'klein_t2i_clean' }
          )
          candRels.push({ rel, seed })
        }
        if (candRels.length === 1) {
          board.emptyPlatePath = candRels[0].rel
        } else {
          const items = await Promise.all(candRels.map(async (c, i) => {
            let score = 0.5
            let note = sc.emptyStrict ? '期望无人空镜' : '场景板'
            try {
              const st = await fs.stat(path.join(rt.baseDir, c.rel))
              score = Math.min(0.95, 0.4 + Math.log10(Math.max(1000, st.size)) / 10)
              note += `；file=${Math.round(st.size / 1024)}KB`
            } catch { /* ignore */ }
            return { id: `s${i}`, relativePath: c.rel, seed: c.seed, score, note }
          }))
          const picked = await rt.picker.pick({
            kind: 'scene',
            brief: `场景「${u.name}」空场景板，英文：${u.sceneEn || u.name}，情绪：${u.emotion || 'n/a'}，天气：${sc.weatherHint}`,
            candidates: items,
            llmPick: sc.llmPick
          })
          await rt.picker.promoteWinner({
            baseDir: rt.baseDir,
            winnerRel: picked.winner.relativePath,
            finalRel: plateRel,
            rejectedRels: picked.rejected.map(r => r.relativePath),
            keepRejected: true
          })
          board.emptyPlatePath = plateRel
          rt.log(projectId, 'scenes', 'info',
            `场景「${u.name}」抽卡 ${candRels.length}→1：${picked.reason}`)
        }
      }
    } catch (e) {
      if (e instanceof ImageGenerateCancelled) throw e
      rt.log(projectId, 'scenes', 'warn',
        `场景板「${u.name}」失败：${e instanceof Error ? e.message : String(e)}`)
    }
    boardByKey.set(u.key, board)
    platesDone++
    rt.setStage(projectId, 'scenes', 'running',
      `并发生成场景板 ${platesDone}/${uniqueScenes.length}...`,
      Math.round(5 + (platesDone / Math.max(1, uniqueScenes.length)) * 25))
  }, { shouldAbort: abort })

  try {
    const project = await rt.store.get(projectId)
    project.sceneBoards = [...boardByKey.values()]
    await rt.store.save(project)
    rt.notifyProjectUpdated(projectId)
  } catch {
    // 后续写 shots 时一并暴露
  }

  /** 同角色上一镜尾帧：尾帧串行生成时写入，强化 FLF2V 连镜 */
  const prevLastByChar = new Map<string, string>()

  type Draft = {
    id: string
    index: number
    as: AnalyzeResult['shots'][number]
    board?: SceneBoard
    characterIds: string[]
    character?: Character
    sceneImagePath?: string
    firstFramePath?: string
    lastFramePath?: string
  }

  const drafts: Draft[] = analysis.shots.map((as, i) => {
    const id = `shot_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`
    const sceneKey = normalizeSceneKey(as.scene || 'unnamed')
    const board = boardByKey.get(sceneKey)
    let characterIds: string[] = []
    let character: Character | undefined
    if (as.type === 'i2v') {
      const names = (as.characters && as.characters.length ? as.characters : (as.characterName ? [as.characterName] : []))
        .map(n => n.trim()).filter(Boolean).slice(0, 1)
      characterIds = names.map(n => characterMap.get(n)?.id).filter((id): id is string => Boolean(id))
      character = characterIds[0] ? characterMap.get(names[0]) : undefined
    }
    return { id, index: i + 1, as, board, characterIds, character }
  })

  // —— 2a) 首帧 / 空镜参考：有限并发 ——
  let framesDone = 0
  rt.setStage(projectId, 'scenes', 'running',
    `并发生成镜头首帧 0/${total}...`, 30)

  await mapPool(drafts, concurrency, async (d) => {
    if (abort()) throw new ImageGenerateCancelled()
    try {
      if (d.as.type === 't2v') {
        if (d.board?.emptyPlatePath) {
          d.sceneImagePath = d.board.emptyPlatePath
        } else {
          const frameRel = `projects/${projectId}/shots/${d.id}_scene.png`
          await rt.image.generate(
            scenePlatePrompt(d.as.sceneEn || d.as.scene, d.as.emotion || undefined, plateOpts),
            path.join(rt.baseDir, frameRel),
            { width: sc.plateWidth, height: sc.plateHeight, shouldAbort: abort }
          )
          d.sceneImagePath = frameRel
        }
      } else {
        // 人物镜首帧：统一走 generateShotFirstFrame（单图定妆融合优先 → 双图备选 → 文生/复制兜底）
        await generateShotFirstFrame(rt, projectId, d, sc, abort, [...characterMap.keys()])
      }
    } catch (e) {
      if (e instanceof ImageGenerateCancelled) throw e
      frameFailed++
      rt.log(projectId, 'scenes', 'warn',
        `第${d.index}镜首帧失败：${e instanceof Error ? e.message : String(e)}`)
    }
    framesDone++
    rt.setStage(projectId, 'scenes', 'running',
      `并发生成镜头首帧 ${framesDone}/${total}...`,
      Math.round(30 + (framesDone / Math.max(1, total)) * 40))
  }, { shouldAbort: abort })

  // —— 2b) 尾帧串行：按镜序承接同角色连续性 ——
  rt.setStage(projectId, 'scenes', 'running', '生成连镜尾帧...', 75)
  for (const d of drafts) {
    if (abort()) break
    if (d.as.type !== 'i2v') continue
    const isCloseup = (d.as.shotSize || 'medium') === 'closeup'
    if (isCloseup) {
      if (d.character && d.firstFramePath) prevLastByChar.set(d.character.id, d.firstFramePath)
    }
    // 尾帧仅当分镜设计明确给了尾帧提示词（lastFrameEn）时才生成：
    // ① flf2v 首尾帧只在「真正需要跨镜转场」时使用，避免普通微动镜被切到首尾帧后，
    //    模型在首尾帧之间自由插值，产生主体位移/行走/漂移（动作漂移第一重灾区）；
    // ② 无 lastFrameEn 的镜一律纯 i2v（首帧微动），动作由 promptEn + 防漂移强锁约束。
    if (!d.as.lastFrameEn?.trim()) continue
    try {
      const look = d.character?.appearanceLock || 'chinese person, natural everyday appearance'
      const sizeCue = SHOT_SIZE_CUE[d.as.shotSize || 'medium']
      const env = d.as.sceneEn || d.as.scene
      const plateHint = d.board?.emptyPlatePath
        ? `matching the empty location plate mood of ${env}`
        : env
      const continuityCue = d.character && prevLastByChar.has(d.character.id)
        ? 'strict visual continuity from previous shot end pose of the SAME person, identical face wardrobe hair'
        : ''
      const lastRel = `projects/${projectId}/shots/${d.id}_last.png`
      // 分镜级尾帧提示词优先（动作完成态/离开方向）；无则回退模板推断 + 上镜尾帧承接
      const lastCue = d.as.lastFrameEn?.trim() || d.as.action
      await rt.image.generate(
        shotFramePrompt({
          phase: 'end',
          lookEn: look,
          scene: plateHint,
          action: lastCue,
          shotSizeCue: sizeCue,
          emotion: d.as.emotion || undefined,
          continuity: continuityCue || d.as.continuity || undefined,
          camera: d.as.camera || undefined,
          lighting: d.as.lighting,
          facing: d.as.facing,
          characterCount: d.characterIds.length || 1,
          props: d.as.props
        }),
        path.join(rt.baseDir, lastRel),
        { width: sc.frameWidth, height: sc.frameHeight, shouldAbort: abort, workflowName: 'klein_t2i_clean' }
      )
      d.lastFramePath = lastRel
      if (d.character) prevLastByChar.set(d.character.id, lastRel)
    } catch (e) {
      if (e instanceof ImageGenerateCancelled) throw e
      frameFailed++
      rt.log(projectId, 'scenes', 'warn',
        `第${d.index}镜尾帧失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  for (const d of drafts) {
    shots.push({
      id: d.id,
      index: d.index,
      scene: d.as.scene,
      action: d.as.action,
      dialogue: stripDialogueDirections(d.as.dialogue),
      characterIds: d.characterIds,
      type: d.as.type,
      width: sc.frameWidth,
      height: sc.frameHeight,
      frames: s.render.defaultFrames,
      seed: Math.floor(Math.random() * 0xffffffff),
      shotSize: d.as.type === 'i2v' ? (d.as.shotSize || 'medium') : undefined,
      camera: d.as.camera || undefined,
      transition: d.as.transition === 'hard' || d.as.transition === 'dissolve' || d.as.transition === 'smash'
        ? d.as.transition
        : undefined,
      emotion: d.as.emotion || undefined,
      lighting: d.as.lighting,
      facing: d.as.facing,
      continuity: d.as.continuity || undefined,
      props: d.as.props,
      promptEn: d.as.promptEn,
      negativeEn: d.as.negativeEn,
      frameSeconds: d.as.frameSeconds,
      firstFrameEn: d.as.firstFrameEn,
      midFrameEn: d.as.midFrameEn,
      lastFrameEn: d.as.lastFrameEn,
      handoffToNext: d.as.handoffToNext,
      transitionEn: d.as.transitionEn,
      sceneBoardId: d.board?.id,
      sceneImagePath: d.sceneImagePath,
      firstFramePath: d.firstFramePath,
      lastFramePath: d.lastFramePath,
      status: 'pending'
    })
  }

  const project = await rt.store.get(projectId)
  project.sceneBoards = [...boardByKey.values()]
  project.shots = shots
  await rt.store.save(project)

  const state = rt.states.get(projectId)!
  state.totalShots = shots.length

  const t2vTotal = shots.filter(x => x.type === 't2v').length
  const t2vFailed = shots.filter(s => s.type === 't2v' && !s.sceneImagePath && !s.sceneBoardId).length
  const boardsOk = [...boardByKey.values()].filter(b => b.emptyPlatePath).length
  const t2vFatal = t2vTotal > 0 && t2vFailed === t2vTotal && boardsOk === 0
  rt.setStage(projectId, 'scenes',
    t2vFatal ? 'error' : 'done',
    t2vFatal
      ? `场景板与首尾帧生成失败`
      : frameFailed
        ? `场景板 ${boardsOk}/${boardByKey.size}，分镜 ${shots.length}，${frameFailed} 镜帧失败已回退`
        : `场景板 ${boardsOk} 张，分镜 ${shots.length} 个（含首尾帧）`,
    100)
}
