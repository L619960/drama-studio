import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { IpcChannels, type Project, type AssetRegenerateInput } from '../../shared/ipcTypes'
import {
  faceCastingPrompt,
  bodySheetPrompt,
  scenePlatePrompt,
  shotFramePrompt,
  shotSizeCueFor,
  sceneNegativeFor,
  mergeNegative, REALISM_NEGATIVE
} from '../../shared/imagePrompts'
import { resolveCreation } from '../../shared/creationSettings'
import { handleIpc, resolveInsideRoot, DATA_ROOT } from './shared'
import { hasDialogSession, dialogSavedFiles } from './dialogSessions'
import type { ProjectStore } from '../core/projectStore'
import type { SettingsStore } from '../core/settingsStore'
import type { ComfyUIClient } from '../core/comfyuiClient'
import type { ImageService } from '../core/imageService'
import type { CandidatePickService } from '../core/candidatePickService'

export interface AssetIpcCtx {
  projectStore: ProjectStore
  settingsStore: SettingsStore
  comfyuiClient: ComfyUIClient
  imageService: ImageService
  candidatePicker: CandidatePickService
}

/** 工作台产物 → 正式输出相对路径（不存在时按约定生成默认路径） */
function resolveAssetRelPath(project: Project, input: AssetRegenerateInput): string {
  if (input.kind === 'charFace' || input.kind === 'charBody') {
    const char = project.characters.find(c => c.id === input.characterId)
    if (!char) throw new Error('角色不存在')
    return input.kind === 'charFace'
      ? (char.faceImagePath || `projects/${input.projectId}/characters/${char.id}_face.png`)
      : (char.bodySheetPath || `projects/${input.projectId}/characters/${char.id}_body.png`)
  }
  if (input.kind === 'scenePlate') {
    const board = (project.sceneBoards || []).find(b => b.id === input.boardId)
    if (!board) throw new Error('场景板不存在')
    return board.emptyPlatePath || `projects/${input.projectId}/scenes/${board.id}_empty.png`
  }
  const shot = project.shots.find(s => s.id === input.shotId)
  if (!shot) throw new Error('分镜不存在')
  return input.kind === 'firstFrame'
    ? (shot.firstFramePath || `projects/${input.projectId}/frames/${shot.id}_first.png`)
    : (shot.lastFramePath || `projects/${input.projectId}/frames/${shot.id}_last.png`)
}

/** 把产物相对路径写回对应字段 */
function applyAssetPath(project: Project, input: AssetRegenerateInput, rel: string): void {
  if (input.kind === 'charFace') {
    const char = project.characters.find(c => c.id === input.characterId)
    if (char) { char.faceImagePath = rel; char.refImagePath = rel }
  } else if (input.kind === 'charBody') {
    const char = project.characters.find(c => c.id === input.characterId)
    if (char) char.bodySheetPath = rel
  } else if (input.kind === 'scenePlate') {
    const board = (project.sceneBoards || []).find(b => b.id === input.boardId)
    if (board) board.emptyPlatePath = rel
  } else {
    const shot = project.shots.find(s => s.id === input.shotId)
    if (shot) {
      if (input.kind === 'firstFrame') shot.firstFramePath = rel
      else shot.lastFramePath = rel
    }
  }
}

export function registerAssetIpc(ctx: AssetIpcCtx): void {
  // Image Generation（T2I：定妆/三视图/场景板/首尾帧；尺寸可选，默认竖版半身）
  handleIpc(IpcChannels.imageGenerate, async (_, { prompt, relativeOutput, workflowName, width, height, referenceImagePath, referenceImagePaths, strictWorkflow }: {
    prompt: string
    relativeOutput: string
    workflowName?: string
    width?: number
    height?: number
    referenceImagePath?: string
    referenceImagePaths?: string[]
    strictWorkflow?: boolean
  }) => {
    const w = typeof width === 'number' && width >= 256 && width <= 2048 ? Math.round(width) : 768
    const h = typeof height === 'number' && height >= 256 && height <= 2048 ? Math.round(height) : 512
    // S-02/9i：参考图路径逐张校验——必须位于数据根内，或来自文件对话框会话（用户显式选择）。
    // 否则渲染层失陷后可把磁盘任意图片上传 ComfyUI（图床外发）。
    const refList = [referenceImagePath, ...(referenceImagePaths || [])].filter((p): p is string => Boolean(p && typeof p === 'string'))
    for (const ref of refList) {
      let inside = false
      try {
        resolveInsideRoot(ref)
        inside = true
      } catch {
        inside = false
      }
      if (!inside && !hasDialogSession(dialogSavedFiles, ref)) {
        throw new Error('参考图片路径未通过安全校验：必须位于项目数据目录内，或来自文件选择对话框')
      }
    }
    await ctx.imageService.generate(
      prompt,
      resolveInsideRoot(relativeOutput),
      { workflowName, width: w, height: h, referenceImagePath, referenceImagePaths, strictWorkflow }
    )
    return relativeOutput
  })

  handleIpc(IpcChannels.imageCheckpoints, () => ctx.comfyuiClient.getCheckpoints())

  // 工作台产物重生成：按产物类型用指定工作流重新生成（单次生效，不改项目默认工作流）。
  // 覆盖 角色定妆(face/body)、场景板空场景图、分镜首帧/尾帧；输出沿用原字段相对路径以触发预览刷新。
  handleIpc(IpcChannels.assetRegenerate, async (_, input: AssetRegenerateInput) => {
    const project = await ctx.projectStore.get(input.projectId)
    if (!project) throw new Error('项目不存在')
    const settings = await ctx.settingsStore.get()
    const wf = input.workflow?.trim() || undefined
    const userNeg = input.negative?.trim() || ''
    const gen = async (prompt: string, relOut: string, opts: { width?: number; height?: number; referenceImagePath?: string; referenceImagePaths?: string[]; baseNegative?: string } = {}) => {
      // 负向 = 该产物正常管线的基础负向 + 用户在工作台追加的负向（追加合并去重，绝不整体替换）
      const { baseNegative, ...rest } = opts
      const negative = mergeNegative(baseNegative ?? REALISM_NEGATIVE, userNeg)
      // 生成前把旧产物备份为 *.prev，供前端「回滚」一键还原
      const absOut = resolveInsideRoot(relOut)
      let previousRel: string | undefined
      try {
        await fs.stat(absOut) // 存在才备份
        const prevAbs = `${absOut}.prev`
        await fs.cp(absOut, prevAbs)
        previousRel = `${relOut}.prev`
      } catch { /* 不存在或备份失败不阻断生成 */ }
      await ctx.imageService.generate(prompt, absOut, { workflowName: wf, negative, ...rest })
      return { relOut, previousRel }
    }

    let outRel = ''
    let previousRel: string | undefined
    if (input.kind === 'charFace' || input.kind === 'charBody') {
      const char = project.characters.find(c => c.id === input.characterId)
      if (!char) throw new Error('角色不存在')
      const ch = settings.creation.character
      const look = input.prompt.trim() || char.appearanceLock || `chinese person, ${char.description || char.name}, natural everyday appearance`
      outRel = resolveAssetRelPath(project, input)
      const g = await gen(
        input.kind === 'charFace' ? faceCastingPrompt(look, { realismLock: ch.realismLock, genre: project.genre }) : bodySheetPrompt(look, { realismLock: ch.realismLock, genre: project.genre }),
        outRel,
        { width: input.kind === 'charFace' ? ch.faceWidth : ch.bodyWidth, height: input.kind === 'charFace' ? ch.faceHeight : ch.bodyHeight, baseNegative: sceneNegativeFor(ch.realismLock, project.genre) }
      )
      previousRel = g.previousRel
    } else if (input.kind === 'scenePlate') {
      const board = (project.sceneBoards || []).find(b => b.id === input.boardId)
      if (!board) throw new Error('场景板不存在')
      const sc = resolveCreation(settings).scene
      // 用户编辑的是场景核心描述；与正常管线一致地包装 scenePlatePrompt（空场景/天气/时代/材质锁）
      const desc = input.prompt.trim() || board.description || board.name
      const fullPrompt = scenePlatePrompt([desc, board.description && input.prompt.trim() ? board.description : ''].filter(Boolean).join(', '), undefined, {
        weatherHint: sc.weatherHint,
        emptyStrict: sc.emptyStrict,
        genre: project.genre
      })
      outRel = resolveAssetRelPath(project, input)
      const refs = board.panoPath ? [resolveInsideRoot(board.panoPath)] : undefined
      const g = await gen(fullPrompt, outRel, { width: sc.plateWidth, height: sc.plateHeight, referenceImagePaths: refs, baseNegative: sceneNegativeFor('standard') })
      previousRel = g.previousRel
    } else {
      const shot = project.shots.find(s => s.id === input.shotId)
      if (!shot) throw new Error('分镜不存在')
      const sc = resolveCreation(settings).scene
      // 用户编辑的是首/尾帧动作构图 cue；与正常管线一致地包装 shotFramePrompt（身份锚/场景/灯光/景别/人数/道具锁）
      const cue = input.prompt.trim()
        || (input.kind === 'firstFrame' ? shot.firstFrameEn : shot.lastFrameEn)
        || shot.action
        || 'standing'
      const mainChar = (shot.characterIds || [])
        .map(cid => project.characters.find(x => x.id === cid))
        .find(Boolean)
      const lookEn = mainChar?.appearanceLock || mainChar?.description || 'chinese person, natural everyday appearance'
      const board = (project.sceneBoards || []).find(b => b.id === shot.sceneBoardId)
      const env = shot.sceneEn || shot.scene || board?.name || ''
      const sceneCue = board?.emptyPlatePath && env
        ? `matching the empty location plate mood of ${env}`
        : env
      const fullPrompt = shotFramePrompt({
        phase: input.kind === 'firstFrame' ? 'start' : 'end',
        lookEn,
        scene: sceneCue,
        action: cue,
        shotSizeCue: shotSizeCueFor(shot.shotSize),
        emotion: shot.emotion || undefined,
        continuity: shot.continuity || undefined,
        camera: shot.camera || undefined,
        lighting: shot.lighting,
        facing: shot.facing,
        characterCount: shot.characterIds?.length || 1,
        props: shot.props
      })
      outRel = resolveAssetRelPath(project, input)
      const refs: string[] = []
      if (shot.sceneImagePath) refs.push(resolveInsideRoot(shot.sceneImagePath))
      for (const cid of shot.characterIds || []) {
        const c = project.characters.find(x => x.id === cid)
        const ref = c?.faceImagePath || c?.refImagePath
        if (ref) refs.push(resolveInsideRoot(ref))
      }
      const g = await gen(fullPrompt, outRel, { width: sc.frameWidth, height: sc.frameHeight, referenceImagePaths: refs.length ? refs : undefined, baseNegative: sceneNegativeFor('standard', project.genre) })
      previousRel = g.previousRel
    }
    applyAssetPath(project, input, outRel)
    await ctx.projectStore.save(project)
    return { path: outRel, previousPath: previousRel }
  })

  // 工作台产物回滚：把 *.prev 备份复制回正式产物路径，覆盖新生成的图
  handleIpc(IpcChannels.assetRollback, async (_, input: AssetRegenerateInput) => {
    const project = await ctx.projectStore.get(input.projectId)
    if (!project) throw new Error('项目不存在')
    const relOut = resolveAssetRelPath(project, input)
    const absOut = resolveInsideRoot(relOut)
    const prevAbs = `${absOut}.prev`
    try { await fs.stat(prevAbs) } catch { throw new Error('没有可回滚的旧产物') }
    await fs.cp(prevAbs, absOut)
    applyAssetPath(project, input, relOut)
    await ctx.projectStore.save(project)
    return { path: relOut }
  })

  // 角色抽卡定妆：多候选（不同 seed）生成 → 抽卡挑选最优 → 胜出落盘为正式定妆图；
  // 与导演流程 casting 一致。face 抽 candidates 张，body 用胜出 seed 单张。
  // 防重入：同一角色正在生成时拒绝再次提交（连点/双击/并行路径都兜住，避免 ComfyUI 队列堆积重复任务）。
  const castingInFlight = new Set<string>()
  handleIpc(IpcChannels.characterCasting, async (_, input: { projectId: string; characterId: string }) => {
    const key = `${input.projectId}:${input.characterId}`
    if (castingInFlight.has(key)) {
      throw new Error('该角色正在生成中，请等待完成（已拦截重复请求）')
    }
    castingInFlight.add(key)
    const logPath = join(DATA_ROOT, 'tmp', 'character-casting.log')
    const stepLog = async (msg: string): Promise<void> => {
      try {
        await fs.appendFile(logPath, `${new Date().toISOString()} ${msg}\n`, 'utf8')
      } catch { /* ignore */ }
    }
    await stepLog(`start project=${input.projectId} char=${input.characterId}`)
    try {
      const project = await ctx.projectStore.get(input.projectId)
      if (!project) throw new Error('项目不存在')
      const char = project.characters.find(c => c.id === input.characterId)
      if (!char) throw new Error('角色不存在')
      const ch = (await ctx.settingsStore.get()).creation.character
      const look = char.appearanceLock || `chinese person, ${char.description || char.name}, natural everyday appearance`
      const faceCount = Math.max(1, Math.min(3, ch.candidates || 1))
      const wfName = ch.t2iWorkflow || undefined
      const neg = { negative: sceneNegativeFor(ch.realismLock, project.genre) }
      const baseDir = DATA_ROOT
      const faceCandRels: Array<{ rel: string; seed: number }> = []
      await stepLog(`faceCount=${faceCount} seedMode=${ch.seedMode} seed=${ch.seed} wf=${wfName || 'default'}`)
      for (let ci = 0; ci < faceCount; ci++) {
        const seed = ch.seedMode === 'fixed'
          ? (ch.seed + ci * 9973) >>> 0
          : Math.floor(Math.random() * 0xffffffff)
        const rel = faceCount === 1
          ? `projects/${input.projectId}/characters/${char.id}_face.png`
          : `projects/${input.projectId}/characters/${char.id}_face_c${ci}.png`
        await stepLog(`face c${ci} seed=${seed} start`)
        await ctx.imageService.generate(
          faceCastingPrompt(look, { realismLock: ch.realismLock }),
          resolveInsideRoot(rel),
          { width: ch.faceWidth, height: ch.faceHeight, seed, workflowName: wfName, ...neg }
        )
        await stepLog(`face c${ci} done`)
        faceCandRels.push({ rel, seed })
      }
      let faceRel = `projects/${input.projectId}/characters/${char.id}_face.png`
      let pickNote = '单候选'
      if (faceCount > 1) {
        const items = await Promise.all(faceCandRels.map(async (c, i) => {
          const abs = resolveInsideRoot(c.rel)
          let score = 0.5
          let note = '生成成功'
          try {
            const st = await fs.stat(abs)
            score = Math.min(0.95, 0.4 + Math.log10(Math.max(1000, st.size)) / 10)
            note = `file=${Math.round(st.size / 1024)}KB`
          } catch { note = 'stat 失败' }
          return { id: `c${i}`, relativePath: c.rel, seed: c.seed, score, note }
        }))
        await stepLog(`pick candidates=${items.length} llmPick=${ch.llmPick}`)
        const picked = await ctx.candidatePicker.pick({
          kind: 'character',
          brief: `角色「${char.name}」定妆，外观锁定：${look}`,
          candidates: items,
          llmPick: ch.llmPick
        })
        await stepLog(`pick winner=${picked.winner.relativePath} reason=${picked.reason}`)
        await ctx.candidatePicker.promoteWinner({
          baseDir: DATA_ROOT,
          winnerRel: picked.winner.relativePath,
          finalRel: faceRel,
          rejectedRels: picked.rejected.map(r => r.relativePath),
          keepRejected: false
        })
        pickNote = picked.reason
      }
      char.faceImagePath = faceRel
      char.refImagePath = faceRel
      // 后处理：FireRed-Image-Edit 单图编辑，清除面部随机标记（痣/纹身/斑点），保持身份与构图不变
      await stepLog(`cleanup face start`)
      try {
        await ctx.imageService.generate(
          'Remove any small dark mole, tattoo, birthmark, wart, pimple or blemish on the face and forehead. Smooth and clean the facial skin surface completely. Keep the person identity, facial features, hairstyle, clothing, lighting, background and composition exactly the same. Do not change anything else.',
          resolveInsideRoot(faceRel),
          {
            workflowName: 'qwen2511_i2i_edit',
            referenceImagePath: resolveInsideRoot(faceRel),
            strictWorkflow: true,
            seed: 2026
          }
        )
        await stepLog(`cleanup face done`)
      } catch (e) {
        // 编辑失败不阻断：保留原定妆（皮肤质量提示词已挡掉大部分瑕疵）
        await stepLog(`cleanup face skipped: ${e instanceof Error ? e.message : String(e)}`)
      }
      // 三视图：用胜出 seed 单张生成（抽卡成本已用于面部）
      const bodySeed = faceCandRels[0].seed
      const bodyRel = `projects/${input.projectId}/characters/${char.id}_body.png`
      await stepLog(`body seed=${bodySeed} start`)
      await ctx.imageService.generate(
        bodySheetPrompt(look, { realismLock: ch.realismLock, genre: project.genre }),
        resolveInsideRoot(bodyRel),
        { width: ch.bodyWidth, height: ch.bodyHeight, seed: bodySeed, workflowName: wfName, ...neg }
      )
      await stepLog(`body done`)
      char.bodySheetPath = bodyRel
      await ctx.projectStore.save(project)
      await stepLog(`saved ok`)
      return { faceRel, bodyRel, pickNote }
    } catch (e) {
      await stepLog(`ERROR ${e instanceof Error ? e.stack || e.message : String(e)}`)
      throw e
    } finally {
      castingInFlight.delete(key)
    }
  })
}
