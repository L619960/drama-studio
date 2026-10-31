import { EventEmitter } from 'node:events'
import { LLMService } from './llmService'
import { ImageService } from './imageService'
import { TaskQueue } from './taskQueue'
import { FFmpegService } from './ffmpegService'
import { SubtitleService } from './subtitleService'
import { ProjectStore } from './projectStore'
import { SettingsStore } from './settingsStore'
import type {
  DirectorState,
  DirectorStage,
  StageStatus,
  DirectorStartInput,
  Shot,
  AnalyzeResult,
  SceneBoard,
  Character,
  Project,
  InterruptedTask,
  DirectorLogEntry,
} from '../../shared/ipcTypes'
import type { AuditCheckItem } from './skillLibrary'
import { CandidatePickService } from './candidatePickService'
import { SkillLibrary } from './skillLibrary'
import { STAGE_ORDER, STAGE_LABELS, stageIndexOf } from './directorConstants'
import { DEFAULT_DIRECTOR_GATES } from '../../shared/pipelineGuards'
import {
  freshStateImpl,
  isCancelledImpl,
  currentStageImpl,
  setStageImpl,
  logImpl,
  emitStateImpl,
  persistImpl,
  maybeGateImpl,
  pauseUntilShotsReviewedImpl,
  getStateImpl,
  getLatestStateImpl,
  listActiveStatesImpl,
  clearStateImpl,
  hydrateImpl,
  recoverAllImpl,
  listInterruptedImpl,
  enableGatesImpl,
} from './directorStateMachine'
import {
  ensureShadowStateImpl,
  emitProgressEventImpl,
  notifyProjectUpdatedImpl,
  onExternalProgressImpl,
  onExternalQueueFinishedImpl,
  subscribeRenderProgressImpl,
  unsubscribeRenderProgressImpl,
} from './directorProgressBridge'
import {
  buildCharactersImpl,
  buildPropAssetsImpl,
  generateShotFirstFrameImpl,
  buildShotsImpl,
  sanitizeCameraForFrameImpl,
  buildCloseupEditPromptImpl,
  buildPanoEditPromptImpl,
} from './directorAssetBuilder'
import { rebuildShotFirstFramesImpl, rerunCastingImpl, regenerateScenePanoImpl } from './directorManualOps'
import {
  finishImpl,
  evictFinishedStatesImpl,
  renderShotsWithAuditImpl,
  auditSingleShotImpl,
  approveShotsImpl,
} from './directorFinish'
import { runPipelineImpl, selfHealStageImpl, withTransientRetryImpl, concatDoneShotsImpl } from './directorPipeline'

/**
 * AI 导演：剧本 → 成片的全自动编排器（facade 壳）。
 * 实际实现按职责拆到 directorStateMachine / directorProgressBridge / directorAssetBuilder /
 * directorManualOps / directorFinish / directorPipeline 六个子模块；本类仅持有状态字段与
 * 对外公开方法，并把内部调用委托给子模块。
 *
 * 状态持久化到内存 + projects/<id>/director-state.json（崩溃/重启可查询）
 * 遇错继续：单角色/单镜失败不中断流水线，最终在状态中汇总
 */
export class DirectorAgent extends EventEmitter {
  states = new Map<string, DirectorState>()
  cancelled = new Set<string>()
  /** 每项目独立的渲染进度监听器（并行项目互不覆盖） */
  progressUnsubs = new Map<string, () => void>()
  /** 每个任务的阶段门配置：在指定阶段结束后暂停 */
  gates = new Map<string, Set<DirectorStage>>()
  /** 用户手动请求暂停（任意阶段结束处生效，一次性） */
  pauseRequested = new Set<string>()
  /** 阶段门等待中的 resolve 回调 */
  waiters = new Map<string, () => void>()
  /** 日志自增序号（按项目） */
  logSeq = new Map<string, number>()
  /** 各阶段最后一条 running 消息（重复进度抑制） */
  lastStageMsg = new Map<string, string>()
  /** 影子渲染任务：非流水线的直渲入队也在工作流监控可见 */
  shadowRenders = new Set<string>()
  /** 每镜上一次的进度 step（识别"开始渲染/重试渲染"边界，按 项目:镜头 键） */
  lastStepByShot = new Map<string, string>()
  /** 影子轮已落定镜头去重 */
  shadowSettledShots = new Map<string, Set<string>>()
  /** C 自愈预算：每项目每次流水线运行最多自动重试次数（runPipeline 开头清零） */
  healBudget = new Map<string, number>()
  /** 视觉不可用提示去重（每项目一次） */
  visionWarned = new Set<string>()
  readonly picker: CandidatePickService

  constructor(
    public baseDir: string,
    public store: ProjectStore,
    public llm: LLMService,
    public image: ImageService,
    public queue: TaskQueue,
    public ffmpeg: FFmpegService,
    public subtitles: SubtitleService,
    public settings: SettingsStore,
    public skills: SkillLibrary,
  ) {
    super()
    this.picker = new CandidatePickService(llm)
    // 全局渲染进度桥接：流水线运行的项目由 subscribeRenderProgress 的专用监听写日志；
    // 其余直渲入队自动建影子任务同步到执行日志面板
    this.queue.on(
      'progress',
      (e: { projectId?: string; shotId?: string; step?: string; percent?: number; message?: string }) => {
        this.onExternalProgress(e)
      },
    )
    this.queue.on('queue-finished', (p: { projectId: string }) => this.onExternalQueueFinished(p.projectId))
  }

  // ===== 委托到子模块的内部方法（保持原 this 调用语义，行为不变） =====
  ensureShadowState(projectId: string) {
    return ensureShadowStateImpl(this, projectId)
  }
  emitProgressEvent(projectId: string) {
    return emitProgressEventImpl(this, projectId)
  }
  notifyProjectUpdated(projectId: string) {
    return notifyProjectUpdatedImpl(this, projectId)
  }
  onExternalProgress(e: { projectId?: string; shotId?: string; step?: string; percent?: number; message?: string }) {
    return onExternalProgressImpl(this, e)
  }
  onExternalQueueFinished(projectId: string) {
    return onExternalQueueFinishedImpl(this, projectId)
  }
  freshState(projectId: string, title: string) {
    return freshStateImpl(this, projectId, title)
  }
  isCancelled(projectId: string) {
    return isCancelledImpl(this, projectId)
  }
  static currentStage(state: DirectorState) {
    return currentStageImpl(state)
  }
  setStage(projectId: string, stage: DirectorStage, status: StageStatus, message: string, percent?: number) {
    return setStageImpl(this, projectId, stage, status, message, percent)
  }
  log(
    projectId: string,
    stage: DirectorStage,
    level: 'info' | 'success' | 'warn' | 'error',
    message: string,
    extra?: { detail?: string; errorKind?: DirectorLogEntry['errorKind'] },
  ) {
    return logImpl(this, projectId, stage, level, message, extra)
  }
  maybeGate(projectId: string, afterStage: DirectorStage) {
    return maybeGateImpl(this, projectId, afterStage)
  }
  pauseUntilShotsReviewed(projectId: string) {
    return pauseUntilShotsReviewedImpl(this, projectId)
  }
  emitState(projectId: string) {
    return emitStateImpl(this, projectId)
  }
  persist(projectId: string) {
    return persistImpl(this, projectId)
  }
  runPipeline(projectId: string, input: DirectorStartInput, from: DirectorStage = 'analyze') {
    return runPipelineImpl(this, projectId, input, from)
  }
  selfHealStage(
    projectId: string,
    stage: DirectorStage,
    stageLabel: string,
    errors: string[],
    retry: () => Promise<void>,
  ) {
    return selfHealStageImpl(this, projectId, stage, stageLabel, errors, retry)
  }
  withTransientRetry<T>(
    fn: () => Promise<T>,
    opts: { retries?: number; notify?: (msg: string) => void; isCancelled?: () => boolean } = {},
  ) {
    return withTransientRetryImpl(this, fn, opts)
  }
  concatDoneShots(projectId: string, doneShots: Shot[], outputRel: string) {
    return concatDoneShotsImpl(this, projectId, doneShots, outputRel)
  }
  buildCharacters(projectId: string, analysis: AnalyzeResult) {
    return buildCharactersImpl(this, projectId, analysis)
  }
  buildPropAssets(projectId: string, analysis: AnalyzeResult) {
    return buildPropAssetsImpl(this, projectId, analysis)
  }
  generateShotFirstFrame(
    projectId: string,
    d: {
      id: string
      index: number
      as: AnalyzeResult['shots'][number]
      board?: SceneBoard | undefined
      characterIds: string[]
      character?: Character | undefined
      firstFramePath?: string | undefined
    },
    sc: { frameWidth: number; frameHeight: number },
    abort: () => boolean,
    allCharacterNames: string[] = [],
  ) {
    return generateShotFirstFrameImpl(this, projectId, d, sc, abort, allCharacterNames)
  }
  buildShots(projectId: string, analysis: AnalyzeResult, characterMap: Map<string, Character>) {
    return buildShotsImpl(this, projectId, analysis, characterMap)
  }
  sanitizeCameraForFrame(camera: string) {
    return sanitizeCameraForFrameImpl(camera)
  }
  buildCloseupEditPrompt(
    sceneHint: string,
    d: {
      as: {
        action?: string | undefined
        emotion?: string | undefined
        camera?: string | undefined
        shotSize?: string | undefined
        firstFrameEn?: string | undefined
        lastFrameEn?: string | undefined
        props?: string[] | undefined
      }
    },
    sizeCue: string,
    phase: 'start' | 'end' = 'start',
  ) {
    return buildCloseupEditPromptImpl(sceneHint, d, sizeCue, phase)
  }
  buildPanoEditPrompt(
    lookEn: string,
    sceneHint: string,
    d: {
      as: {
        action?: string | undefined
        emotion?: string | undefined
        camera?: string | undefined
        shotSize?: string | undefined
        firstFrameEn?: string | undefined
        lastFrameEn?: string | undefined
        props?: string[] | undefined
      }
    },
    sizeCue: string,
    phase: 'start' | 'end' = 'start',
  ) {
    return buildPanoEditPromptImpl(lookEn, sceneHint, d, sizeCue, phase)
  }
  subscribeRenderProgress(projectId: string) {
    return subscribeRenderProgressImpl(this, projectId)
  }
  unsubscribeRenderProgress(projectId: string) {
    return unsubscribeRenderProgressImpl(this, projectId)
  }
  finish(projectId: string, doneMessage?: string) {
    return finishImpl(this, projectId, doneMessage)
  }
  evictFinishedStates() {
    return evictFinishedStatesImpl(this)
  }
  renderShotsWithAudit(projectId: string, shotDurations: Map<string, number>) {
    return renderShotsWithAuditImpl(this, projectId, shotDurations)
  }
  auditSingleShot(projectId: string, shot: Shot, project: Project, checklist: AuditCheckItem[], skipVision = false) {
    return auditSingleShotImpl(this, projectId, shot, project, checklist, skipVision)
  }
  approveShots(projectId: string) {
    return approveShotsImpl(this, projectId)
  }

  static get STAGE_LABELS(): Record<DirectorStage, string> {
    return STAGE_LABELS
  }

  /** 启动全流程，返回 projectId */
  async start(input: DirectorStartInput): Promise<string> {
    // 项目对话里开拍时复用已有项目，避免在当前项目下又新建一个空项目导致上下文错乱
    let project
    if (input.existingProjectId) {
      project = await this.store.get(input.existingProjectId)
      project.title = input.title || project.title
      project.genre = input.genre || project.genre
    } else {
      project = await this.store.create(input.title, input.genre)
    }
    // 原始剧本回存项目（剧本页可回看/编辑/重拆）
    project.script = input.script
    project.updatedAt = Date.now()
    await this.store.save(project)
    const state = this.freshState(project.id, input.title)
    const gateList = (input.gateStages || []).filter((g) => g !== 'done')
    state.gateStages = gateList
    // "一口气跑到底"：无 gateStages 时同时临时关闭分镜审核门禁（仅本项目生命周期）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON.parse 动态字段注入，运行时约定
    ;(state as any).noShotGate = gateList.length === 0
    this.states.set(project.id, state)
    this.gates.set(project.id, new Set(gateList))
    this.persist(project.id).catch(() => {})

    // 异步执行流水线，不阻塞 IPC 返回
    this.runPipeline(project.id, input).catch((e) => {
      const s = this.states.get(project.id)
      if (s && s.running) {
        // 未预期异常：把仍在运行的阶段标记为错误，避免 UI 永久停在转圈态
        const message = `编排异常中断: ${e instanceof Error ? e.message : String(e)}`
        for (const stage of STAGE_ORDER) {
          if (s.stages[stage].status === 'running') {
            s.stages[stage] = { status: 'error', message, percent: s.stages[stage].percent }
          }
        }
        s.running = false
        s.stages.done = { status: 'error', message, percent: 100 }
        s.finishedAt = Date.now()
        this.cancelled.delete(project.id)
        // 与 finish 一致的资源清理，防止监听器/等待器泄漏
        this.pauseRequested.delete(project.id)
        this.waiters.delete(project.id)
        this.gates.delete(project.id)
        this.healBudget.delete(project.id)
        this.unsubscribeRenderProgress(project.id)
        this.emitState(project.id)
      }
    })

    return project.id
  }

  async cancel(projectId: string): Promise<void> {
    this.cancelled.add(projectId)
    this.pauseRequested.delete(projectId)
    // 若正停在确认点，立即放行，由流水线的取消检查收尾
    this.waiters.get(projectId)?.()
    this.waiters.delete(projectId)
    await this.queue.cancel(projectId).catch(() => {})
    // 取消后立即把 running 落盘，避免 director-state.json 残留 running=true
    const state = this.states.get(projectId)
    if (state) {
      state.running = false
      this.emitState(projectId)
      await this.persist(projectId).catch(() => {})
    }
  }

  /** 退出/重启前取消所有仍在运行（或停在确认点）的任务：并行项目可能同时在渲染，不能只收尾最近一个 */
  async cancelAll(): Promise<void> {
    const ids = Array.from(this.states.values())
      .filter((s) => s.running || s.paused)
      .map((s) => s.projectId)
    await Promise.all(ids.map((id) => this.cancel(id).catch(() => undefined)))
  }

  /** 请求暂停：已在确认点则无操作；否则在当前阶段结束后停下 */
  async pause(projectId: string): Promise<void> {
    const state = this.states.get(projectId)
    if (!state || !state.running || state.paused) return
    this.pauseRequested.add(projectId)
    this.log(
      projectId,
      DirectorAgent.currentStage(state),
      'warn',
      '已请求暂停，将在当前阶段结束后停下，不会中断进行中的渲染',
    )
  }

  /** 从确认点继续 */
  async resume(projectId: string): Promise<void> {
    this.pauseRequested.delete(projectId)
    const state = this.states.get(projectId)
    if (state) {
      state.paused = false
      state.pendingGates = []
      this.emitState(projectId)
    }
    this.waiters.get(projectId)?.()
    this.waiters.delete(projectId)
  }

  /**
   * A 断点续跑：从指定阶段重跑，该阶段及其后全部重新执行，此前已完成阶段跳过。
   */
  async resumeFromStage(projectId: string, stage: DirectorStage): Promise<void> {
    let state = this.states.get(projectId)
    if (!state) {
      const hydrated = await this.hydrate(projectId)
      if (hydrated) state = hydrated
    }
    if (!state) throw new Error('未找到该任务的执行状态，无法断点续跑')
    if (state.running) throw new Error('任务正在运行中，无需续跑')
    // S1 竞态防护：取消中的项目拒绝续跑，待旧流水线 finish 后用户重试即可
    if (this.cancelled.has(projectId)) throw new Error('任务正在取消中，请稍后再试')
    if (stage === 'done') throw new Error('「完成」不是可执行阶段')

    // 前置产物校验：缺什么直接说清楚
    const input = state.input
    if (!input?.script) {
      throw new Error('缺少原始剧本输入，无法断点续跑（请重新发起任务）')
    }
    if (
      stageIndexOf(stage) <= stageIndexOf('scenes') &&
      stageIndexOf(stage) > stageIndexOf('analyze') &&
      !state.analysis
    ) {
      throw new Error('缺少剧本分析结果，无法从该阶段续跑（可改从「剧本分析」重跑）')
    }
    const project = await this.store.get(projectId)
    if (stageIndexOf(stage) === stageIndexOf('scenes') && project.characters.length === 0) {
      throw new Error('缺少角色建档数据，无法从「场景图生成」续跑（可改从「角色建档」重跑）')
    }
    if (stageIndexOf(stage) >= stageIndexOf('render') && project.shots.length === 0) {
      throw new Error('项目中没有分镜数据，无法从渲染及之后阶段续跑')
    }
    if (stage === 'combine' && !project.shots.some((s) => s.status === 'done' && s.segmentPath)) {
      throw new Error('没有已渲染完成的镜头分段，无法拼接（请先从「逐镜渲染」重跑）')
    }
    if (stageIndexOf(stage) > stageIndexOf('combine') && state.stages.combine.status !== 'done') {
      throw new Error(`「${STAGE_LABELS[stage]}」依赖拼接产物，请先从「拼接成片」重跑`)
    }

    // 重置续跑范围：目标阶段及其后全部回到 pending，此前阶段保留原状态
    for (const st of STAGE_ORDER) {
      if (stageIndexOf(st) >= stageIndexOf(stage)) {
        state.stages[st] = { status: 'pending', message: '', percent: 0 }
      }
    }
    state.running = true
    state.paused = false
    delete state.finishedAt
    delete state.reviewIssues
    state.pendingGates = []
    delete state.heal
    state.failedShotIds = []
    state.cancelled = false
    // P0-1：续跑后清除「任务中断」标记，UI 的中断提示随之消失
    state.interrupted = false
    delete state.interruptedStage

    // 阶段门重建：只保留续跑范围内的门
    this.gates.set(projectId, new Set(state.gateStages.filter((g) => stageIndexOf(g) >= stageIndexOf(stage))))
    this.cancelled.delete(projectId)
    this.states.set(projectId, state)

    this.log(projectId, stage, 'info', `断点续跑：从「${STAGE_LABELS[stage]}」阶段继续，此前已完成阶段自动跳过`)

    const runInput = input
    this.runPipeline(projectId, runInput, stage).catch((e) => {
      const s = this.states.get(projectId)
      if (s && s.running) {
        const message = `编排异常中断: ${e instanceof Error ? e.message : String(e)}`
        for (const st of STAGE_ORDER) {
          if (s.stages[st].status === 'running') {
            s.stages[st] = { status: 'error', message, percent: s.stages[st].percent }
          }
        }
        s.running = false
        s.stages.done = { status: 'error', message, percent: 100 }
        s.finishedAt = Date.now()
        this.cancelled.delete(projectId)
        this.pauseRequested.delete(projectId)
        this.waiters.delete(projectId)
        this.gates.delete(projectId)
        this.healBudget.delete(projectId)
        this.unsubscribeRenderProgress(projectId)
        this.emitState(projectId)
      }
    })
  }

  getState(projectId: string): DirectorState | null {
    return getStateImpl(this, projectId)
  }

  /** 最近活跃的任务状态（含影子渲染任务） */
  getLatestState(): DirectorState | null {
    return getLatestStateImpl(this)
  }

  /** 全部活跃任务（running/paused）：全局任务面板展示并行任务 */
  listActiveStates(): DirectorState[] {
    return listActiveStatesImpl(this)
  }

  /** 磁盘上未跑完的任务（重启后中断/残留）：项目列表「一键继续」横幅用 */
  async listInterrupted(): Promise<InterruptedTask[]> {
    return listInterruptedImpl(this)
  }

  /** REQ-04：重新启用阶段确认点（「一口气跑到底」中途撤销） */
  enableGates(projectId: string): boolean {
    return enableGatesImpl(this, projectId, DEFAULT_DIRECTOR_GATES)
  }

  /** 清空某项目的全部运行时残留 */
  clearState(projectId: string): void {
    return clearStateImpl(this, projectId)
  }

  /** 崩溃/重启恢复：内存无状态且磁盘有 director-state.json 时回填 */
  async hydrate(projectId: string): Promise<DirectorState | null> {
    return hydrateImpl(this, projectId)
  }

  /**
   * 启动时主动扫描全部项目的 director-state.json，把残留 running=true 的状态降级为 error。
   * 不自动重启流水线；用户可在分镜页用「从此重跑」手动续传。
   */
  async recoverAll(): Promise<number> {
    return recoverAllImpl(this)
  }

  /**
   * 重建指定镜头首帧（i2v 人物镜）：用最新单图锁定逻辑重新生成并覆盖 firstFramePath。
   */
  async rebuildShotFirstFrames(projectId: string, shotIndexes: number[]): Promise<{ ok: boolean; text: string }> {
    return rebuildShotFirstFramesImpl(this, projectId, shotIndexes)
  }

  /** 重出角色定妆资产（face + body 三视图） */
  async rerunCasting(projectId: string): Promise<{ ok: boolean; text: string }> {
    return rerunCastingImpl(this, projectId)
  }

  /** 手动重出单个场景的全景固定场景 */
  async regenerateScenePano(projectId: string, boardId: string): Promise<{ ok: boolean; text: string }> {
    return regenerateScenePanoImpl(this, projectId, boardId)
  }
}
