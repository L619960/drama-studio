import { IpcChannels, type DirectorStartInput, type DirectorStage } from '../../shared/ipcTypes'
import { normalizeSceneKey } from '../../shared/ipcTypes'
import { stripDialogueDirections } from '../../shared/imagePrompts'
import { reviewedIsValid, clampShotList, renderTargetShots } from '../../shared/pipelineGuards'
import { handleIpc } from './shared'
import type { ProjectStore } from '../core/projectStore'
import type { SettingsStore } from '../core/settingsStore'
import type { DirectorAgent } from '../core/directorAgent'
import type { TaskQueue } from '../core/taskQueue'
import type { LLMService } from '../core/llmService'

export interface RenderIpcCtx {
  projectStore: ProjectStore
  settingsStore: SettingsStore
  directorAgent: DirectorAgent
  taskQueue: TaskQueue
  llmService: LLMService
}

export function registerRenderIpc(ctx: RenderIpcCtx): void {
  // Render：分镜首帧门禁用 shotReviewGate（与成片复审 reviewGate 分开）。
  // 默认不重建已审首帧（审什么渲什么）。forceRebuildFirstFrame 才会重建并作废 reviewed，随后重新过门禁。
  handleIpc(IpcChannels.renderStart, async (_, payload: {
    projectId: string
    shotIds?: string[]
    forceRebuildFirstFrame?: boolean
  }): Promise<{ warnedShots: number[] }> => {
    const { projectId, shotIds, forceRebuildFirstFrame } = payload
    let project = await ctx.projectStore.get(projectId)
    if (!project) throw new Error('项目不存在')
    const settings = await ctx.settingsStore.get()
    const shotGate = settings?.render?.shotReviewGate ?? 'block'

    if (forceRebuildFirstFrame && shotIds && shotIds.length > 0) {
      const i2vIndexes = project.shots
        .filter(s => shotIds.includes(s.id) && s.type === 'i2v')
        .map(s => s.index)
      if (i2vIndexes.length > 0) {
        await ctx.directorAgent.rebuildShotFirstFrames(projectId, i2vIndexes)
        project = await ctx.projectStore.get(projectId)
      }
    }

    const targets = renderTargetShots(project.shots, shotIds)
    // P2-6：i2v 勾选已审必须有首帧路径，否则审核无效（reviewed=true 但 firstFramePath 缺失仍拦）
    const unreviewed = targets.filter(s => s.type === 'i2v' && !reviewedIsValid(s.type, s.reviewed, s.firstFramePath))
    if (shotGate === 'block' && unreviewed.length > 0) {
      const names = unreviewed.slice(0, 5).map(s => `第${s.index}镜`).join('、')
      const more = unreviewed.length > 5 ? ` 等 ${unreviewed.length} 镜` : ''
      const rebuilt = forceRebuildFirstFrame
        ? '首帧已按最新动作重建，旧审核作废。'
        : ''
      throw new Error(`分镜审核未通过：${names}${more} 尚未核对分镜图。${rebuilt}请先在「分镜审核」里逐镜核对并勾选确认，再开始渲染`)
    }
    if (shotGate === 'warn') {
      await ctx.taskQueue.start(projectId, shotIds)
      return { warnedShots: unreviewed.map(s => s.index) }
    }
    await ctx.taskQueue.start(projectId, shotIds)
    return { warnedShots: [] }
  })
  handleIpc(IpcChannels.renderCancel, (_, { projectId, shotId }: { projectId: string; shotId?: string }) =>
    ctx.taskQueue.cancel(projectId, shotId)
  )

  // AI 导演
  handleIpc(IpcChannels.directorStart, (_, input: DirectorStartInput) =>
    ctx.directorAgent.start(input)
  )
  handleIpc(IpcChannels.directorCancel, (_, projectId: string) =>
    ctx.directorAgent.cancel(projectId)
  )
  handleIpc(IpcChannels.directorPause, (_, projectId: string) =>
    ctx.directorAgent.pause(projectId)
  )
  handleIpc(IpcChannels.directorResume, (_, projectId: string) =>
    ctx.directorAgent.resume(projectId)
  )
  // preload 传 { projectId, stage } 单对象（与 renderStart 等一致）；勿拆成两形参否则 stage 恒为 undefined
  handleIpc(IpcChannels.directorResumeFrom, (_, payload: { projectId: string; stage: DirectorStage }) =>
    ctx.directorAgent.resumeFromStage(payload.projectId, payload.stage)
  )
  // 一致性复评：旧项目被误杀标记镜头摘帽（只跑校验不重渲，随后从「拼接成片」续跑）
  handleIpc(IpcChannels.directorRecheckConsistency, (_, payload: { projectId: string }) =>
    ctx.taskQueue.recheckProjectConsistency(payload.projectId)
  )
  handleIpc(IpcChannels.directorGetState, async (_, projectId: string) =>
    ctx.directorAgent.getState(projectId) ?? await ctx.directorAgent.hydrate(projectId)
  )
  // 重拆镜：用当前 project.script 重新分析并替换分镜（保留角色/场景/道具资产），返回新分镜数
  handleIpc(IpcChannels.directorReanalyze, async (_, projectId: string) => {
    const project = await ctx.projectStore.get(projectId)
    if (!project) throw new Error('项目不存在')
    if (!project.script?.trim()) throw new Error('项目没有剧本，请先保存剧本')
    const result = await ctx.llmService.analyze(project.script, project.genre, {
      title: String(project.title ?? '')
    })
    // LOGIC-P1-08：拆镜结果按创建设置 maxShots 上限截断（下限不补镜）
    const _settings = await ctx.settingsStore.get()
    const maxShots = _settings.creation?.storyboard?.maxShots ?? 20
    const clamped = clampShotList(result.shots, maxShots)
    if (clamped.trimmed > 0) {
      result.shots = clamped.shots
    }
    // ① 角色归档：保留资产库已有角色，追加新角色，建立 name→id 映射（供分镜绑定）
    const existingById = new Map(project.characters.map(c => [c.name, c]))
    for (const ac of result.characters) {
      if (!existingById.has(ac.name)) {
        project.characters.push({
          id: `char_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: ac.name,
          description: ac.appearance,
          appearanceLock: ac.lookEn,
          voice: ac.gender === 'male' ? 'zh-CN-YunjianNeural' : 'zh-CN-XiaoxiaoNeural',
          refImagePath: ''
        })
      } else if (ac.lookEn) {
        // 已有角色：无外观锚点直接补；有旧锚点时仅当新 lookEn 明显更详细（词数显著增长）才刷新，
        // 避免旧项目锁死旧版简短提示词，同时保护用户手工精修过的长提示词不被覆盖
        const existing = existingById.get(ac.name)!
        const oldWords = (existing.appearanceLock || '').split(/\s+/).filter(Boolean).length
        const newWords = ac.lookEn.split(/\s+/).filter(Boolean).length
        if (!existing.appearanceLock || (newWords >= 40 && newWords > oldWords * 1.3)) {
          existing.appearanceLock = ac.lookEn
        }
      }
    }
    const charByName = new Map(project.characters.map(c => [c.name, c.id]))
    // ② 道具归档：analyze 提取的关键道具 → 项目道具库（保 id/形态，供定妆图生成）
    if (result.props && result.props.length > 0) {
      const existingPropZh = new Set((project.props || []).map(p => p.zh))
      for (const rp of result.props) {
        if (!existingPropZh.has(rp.zh)) {
          project.props = project.props || []
          project.props.push({
            id: `prop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            zh: rp.zh,
            en: rp.en,
            description: rp.description,
            imagePath: ''
          })
        }
      }
    }
    const propByName = new Map((project.props || []).map(p => [p.zh, p.id]))
    // ③ 场景板自动归档：分析出的每个场景建一块板（key 归一化），已有跳过；供场景图生成与分镜挂接
    if (!project.sceneBoards) project.sceneBoards = []
    const boardByKey = new Set(project.sceneBoards.map(b => b.key))
    const sceneEnByKey = new Map<string, string>()
    for (const s of result.shots) {
      const key = normalizeSceneKey(s.scene)
      if (s.sceneEn && !sceneEnByKey.has(key)) sceneEnByKey.set(key, s.sceneEn)
    }
    const scenePromptByName = new Map((result.scenes || []).map(s => [s.name, s.en]))
    for (const sceneName of [...new Set(result.shots.map(s => s.scene))].filter(Boolean)) {
      const key = normalizeSceneKey(sceneName)
      const scenePrompt = scenePromptByName.get(sceneName) || sceneEnByKey.get(key) || undefined
      if (!boardByKey.has(key)) {
        project.sceneBoards.push({
          id: `scene_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          key,
          name: sceneName,
          description: scenePrompt,
          emptyPlatePath: ''
        })
        boardByKey.add(key)
      } else if (scenePrompt) {
        // 已有场景板：补齐缺失的剧情提示词
        const board = project.sceneBoards.find(b => b.key === key)
        if (board && !board.description) board.description = scenePrompt
      }
    }
    const boardIdByKey = new Map(project.sceneBoards.map(b => [b.key, b.id]))
    // ④ 分镜重建：绑定角色（characterName→characterId）与道具（shot.props），不再写死空数组
    const shots = result.shots.map((s, i) => {
      const ids: string[] = []
      if (s.characterName) {
        const id = charByName.get(s.characterName)
        if (id) ids.push(id)
      }
      for (const cn of s.characters || []) {
        const id = charByName.get(cn)
        if (id && !ids.includes(id)) ids.push(id)
      }
      // 分镜道具：优先 analyze 给的本镜 props，其次按道具名出现在 action 里匹配项目道具库
      let shotProps: string[] | undefined
      if (s.props && s.props.length > 0) {
        shotProps = s.props
      } else {
        const hit = (project.props || [])
          .filter(p => s.action.toLowerCase().includes(p.en.toLowerCase()) || s.action.includes(p.zh))
          .map(p => p.zh)
        if (hit.length > 0) shotProps = hit
      }
      void propByName
      return {
        id: `shot_${Date.now()}_${i}`,
        index: i + 1,
        scene: s.scene,
        action: s.action,
        dialogue: stripDialogueDirections(s.dialogue),
        characterIds: ids,
        type: s.type as 'i2v' | 't2v',
        width: 720,
        height: 480,
        frames: 81,
        seed: Math.floor(Math.random() * 1000000),
        camera: s.camera,
        emotion: s.emotion,
        shotSize: s.shotSize,
        transition: s.transition,
        lighting: s.lighting,
        facing: s.facing,
        continuity: s.continuity,
        sceneEn: s.sceneEn,
        promptEn: s.promptEn,
        negativeEn: s.negativeEn,
        frameSeconds: s.frameSeconds,
        firstFrameEn: s.firstFrameEn,
        midFrameEn: s.midFrameEn,
        lastFrameEn: s.lastFrameEn,
        handoffToNext: s.handoffToNext,
        transitionEn: s.transitionEn,
        sceneBoardId: boardIdByKey.get(normalizeSceneKey(s.scene)),
        props: shotProps,
        status: 'pending' as const
      }
    })
    project.shots = shots
    project.updatedAt = Date.now()
    await ctx.projectStore.save(project)
    return { shots: shots.length, characters: project.characters.length, props: (project.props || []).length }
  })
  handleIpc(IpcChannels.directorLatestState, () => ctx.directorAgent.getLatestState())

  // 场景板：重出全景固定场景（2:1 全景 → 裁方位图 → 拼宫格看板），复用导演流水线同款链路
  handleIpc(IpcChannels.sceneRegeneratePano, async (_, input: { projectId: string; boardId: string }) => {
    await ctx.projectStore.get(input.projectId)
    return ctx.directorAgent.regenerateScenePano(input.projectId, input.boardId)
  })
}
