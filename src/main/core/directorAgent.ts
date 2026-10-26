import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { LLMService } from './llmService'
import { ImageService, ImageGenerateCancelled } from './imageService'
import { mapPool } from './asyncPool'
import { TaskQueue } from './taskQueue'
import { FFmpegService } from './ffmpegService'
import { SubtitleService } from './subtitleService'
import { ProjectStore } from './projectStore'
import { SettingsStore } from './settingsStore'
import type {
  DirectorState, DirectorStage, StageState, StageStatus,
  DirectorStartInput, DirectorLogEntry, AnalyzeResult, Character, Shot, Project, SceneBoard
} from '../../shared/ipcTypes'
import { normalizeSceneKey, SHOT_TIMING } from '../../shared/ipcTypes'
import {
  faceCastingPrompt, bodySheetPrompt, scenePlatePrompt, shotFramePrompt, SHOT_SIZE_CUE,
  panoramaScenePrompt, realismNegativeFor, sceneNegativeFor, emptySceneNegativeFor,
  frameCrowdNegativeFor, castingNegativeFor, stripOtherPersonClauses, mergeNegative,
  stripDialogueDirections, castLookForGenre
} from '../../shared/imagePrompts'
import { resolveCreation } from '../../shared/creationSettings'
import { hardenLookEnList } from '../../shared/castAppearance'
import { CandidatePickService } from './candidatePickService'
import { SkillLibrary, type AuditCheckItem } from './skillLibrary'
import { FACE_CONSISTENCY_THRESHOLD } from './consistencyService'
import { isTransientError } from './errorClassify'
import { genreCompatible } from './assetReuse'
import { atomicWriteJson } from './fsUtil'
import { lockPromptsAndWorkflow, type DirectorStageRuntime } from './directorStageAssets'
import {
  shouldPauseAfterAudit, clampShotList, reviewedIsValid, shotsInCut
} from '../../shared/pipelineGuards'

const STAGE_ORDER: DirectorStage[] = [
  'analyze', 'casting', 'scenes', 'render',
  'combine', 'subtitle', 'review', 'bgm', 'done'
]

const STAGE_LABELS: Record<DirectorStage, string> = {
  analyze: '剧本分析',
  casting: '角色建档',
  scenes: '场景板与首尾帧',
  render: '逐镜渲染 · 审批',
  combine: '拼接成片',
  subtitle: '烧录字幕',
  review: '成片复审',
  bgm: 'BGM 混音',
  done: '完成'
}

/** 阶段序号（断点续跑的先后比较用） */
function stageIndexOf(stage: DirectorStage): number {
  return STAGE_ORDER.indexOf(stage)
}

/**
 * 从全景方位图中按镜头机位选一张（青橙Lab「全景固定场景」）。
 * 方位约定（cropPanoramaViews 从左到右裁）：view0=前视(默认)、view1=右90°、view2=后180°、view3=左270°；
 * panoViews 数量不足时取最后一档兜底。
 */
function pickPanoView(camera: string | undefined, views: string[] | undefined): string | undefined {
  if (!views?.length) return undefined
  const cam = (camera || '').toLowerCase()
  let idx = 0
  if (/\b(left)\b|portrait side/.test(cam)) idx = Math.min(views.length - 1, 3)
  else if (/\b(right)\b|profile/.test(cam)) idx = Math.min(views.length - 1, 1)
  else if (/back|behind|rear|over-?shoulder|from behind/.test(cam)) idx = Math.min(views.length - 1, 2)
  return views[idx]
}

// 按性别轮转分配音色
const FEMALE_VOICES = ['zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural']
const MALE_VOICES = ['zh-CN-YunjianNeural', 'zh-CN-YunyeNeural', 'zh-CN-YunjieNeural']

/**
 * AI 导演：剧本 → 成片的全自动编排器。
 * - 状态持久化到内存 + projects/<id>/director-state.json（崩溃/重启可查询）
 * - 遇错继续：单角色/单镜失败不中断流水线，最终在状态中汇总
 */
export class DirectorAgent extends EventEmitter {
  private states = new Map<string, DirectorState>()
  private cancelled = new Set<string>()
  /** 每项目独立的渲染进度监听器（并行项目互不覆盖） */
  private progressUnsubs = new Map<string, () => void>()
  /** 每个任务的阶段门配置：在指定阶段结束后暂停 */
  private gates = new Map<string, Set<DirectorStage>>()
  /** 用户手动请求暂停（任意阶段结束处生效，一次性） */
  private pauseRequested = new Set<string>()
  /** 阶段门等待中的 resolve 回调 */
  private waiters = new Map<string, () => void>()
  /** 日志自增序号（按项目） */
  private logSeq = new Map<string, number>()
  /** 各阶段最后一条 running 消息（重复进度抑制） */
  private lastStageMsg = new Map<string, string>()
  /** 影子渲染任务：非流水线的直渲入队（分镜页/对话 agent）也在工作流监控可见 */
  private shadowRenders = new Set<string>()
  /** 每镜上一次的进度 step（识别"开始渲染/重试渲染"边界，按 项目:镜头 键） */
  private lastStepByShot = new Map<string, string>()
  /** 影子轮已落定镜头去重（M-15）：审批重渲/手动重渲会让同一镜再次触发
   *  done/failed 事件，不去重则 doneShots 会虚增超过 totalShots */
  private shadowSettledShots = new Map<string, Set<string>>()
  /** C 自愈预算：每项目每次流水线运行最多自动重试 HEAL_MAX 次（runPipeline 开头清零） */
  private healBudget = new Map<string, number>()
  private static readonly LOG_LIMIT = 300
  private static readonly HEAL_MAX = 2
  /** 视觉不可用提示去重（每项目一次） */
  private visionWarned = new Set<string>()
  private readonly picker: CandidatePickService

  constructor(
    private baseDir: string,
    private store: ProjectStore,
    private llm: LLMService,
    private image: ImageService,
    private queue: TaskQueue,
    private ffmpeg: FFmpegService,
    private subtitles: SubtitleService,
    private settings: SettingsStore,
    private skills: SkillLibrary
  ) {
    super()
    this.picker = new CandidatePickService(llm)
    // 全局渲染进度桥接：流水线运行的项目由 subscribeRenderProgress 的专用监听写日志；
    // 其余直渲入队（分镜页点渲染、对话 agent 重渲）自动建影子任务同步到执行日志面板
    this.queue.on('progress', (e: { projectId?: string; shotId?: string; step?: string; percent?: number; message?: string }) => {
      this.onExternalProgress(e)
    })
    this.queue.on('queue-finished', (p: { projectId: string }) => this.onExternalQueueFinished(p.projectId))
  }

  /** 直渲入队的影子任务：无流水线 state 时创建轻量 state（仅内存，不持久化，重启无残留） */
  private ensureShadowState(projectId: string): DirectorState {
    let state = this.states.get(projectId)
    if (state) {
      if (state.running) return state
      // 上一轮已收尾（影子或流水线）：重开一轮渲染监控，历史日志保留
      state.running = true
      state.finishedAt = undefined
      state.doneShots = 0
      state.failedShotIds = []
      this.shadowSettledShots.set(projectId, new Set())
      state.stages.render = { status: 'running', message: '渲染队列执行中', percent: 0 }
      this.shadowRenders.add(projectId)
      this.emitProgressEvent(projectId)
      return state
    }
    state = this.freshState(projectId, '渲染队列')
    state.stages.render = { status: 'running', message: '渲染队列执行中', percent: 0 }
    this.states.set(projectId, state)
    this.shadowSettledShots.set(projectId, new Set())
    this.shadowRenders.add(projectId)
    void this.store.get(projectId).then((p) => {
      state!.title = p.title
      // 影子渲染无流水线计数：totalShots/doneShots 从项目实际分镜补齐，
      // 避免概览误显示「镜头 0/0 完成 N 失败」（只统计流水线数字导致口径失真）
      if (state!.totalShots === 0 && p.shots?.length) {
        state!.totalShots = p.shots.length
        state!.doneShots = p.shots.filter((s: { status?: string }) => s.status === 'done').length
        state!.failedShotIds = p.shots.filter((s: { status?: string }) => s.status === 'failed').map((s: { id: string }) => s.id)
      }
      this.emitProgressEvent(projectId)
    }).catch(() => undefined)
    this.emitProgressEvent(projectId)
    return state
  }

  /** 只发事件不落盘（影子任务专用，避免重启后恢复出假运行状态） */
  private emitProgressEvent(projectId: string): void {
    const state = this.states.get(projectId)
    if (!state) return
    this.emit('progress', { type: 'director:progress', projectId, state })
  }

  /** 项目数据已落盘（资产/分镜/渲染产物）→ 通知前端刷新面板（角色页/导演台/分镜页） */
  private notifyProjectUpdated(projectId: string): void {
    this.emit('projectUpdated', { type: 'director:project-updated', projectId })
  }

  /** 非流水线直渲的进度 → 执行日志（关键节点记日志，percent 心跳不记防刷屏） */
  private onExternalProgress(e: { projectId?: string; shotId?: string; step?: string; percent?: number; message?: string }): void {
    const projectId = e.projectId
    const shotId = e.shotId || ''
    if (!projectId || this.progressUnsubs.has(projectId)) return
    const state = this.ensureShadowState(projectId)
    const key = `${projectId}:${shotId}`
    const prev = this.lastStepByShot.get(key)
    this.lastStepByShot.set(key, e.step || '')
    const msg = e.message || ''

    if (e.step === 'render' && prev !== 'render') {
      this.log(projectId, 'render', 'info', `镜头 ${shotId} 开始渲染`)
      state.stages.render.message = '渲染队列执行中'
      this.emitProgressEvent(projectId)
    } else if (msg.includes('显存不足')) {
      this.log(projectId, 'render', 'warn', msg)
    } else if (e.step === 'combine' && e.percent === 99 && msg) {
      this.log(projectId, 'render', 'info', msg) // 一致性校验结论等收尾信息
    }

    if (e.step === 'done') {
      // M-15：同一镜二次完成（审批重渲/手动重渲）不重复计数
      let settled = this.shadowSettledShots.get(projectId)
      if (!settled) {
        settled = new Set()
        this.shadowSettledShots.set(projectId, settled)
      }
      if (!settled.has(shotId)) {
        settled.add(shotId)
        state.doneShots++
      }
      this.log(projectId, 'render', 'success', `镜头 ${shotId} 渲染完成`)
      this.lastStepByShot.delete(key)
      this.emitProgressEvent(projectId)
    } else if (e.step === 'failed') {
      // 同镜重复失败也去重，防止 finish 文案里失败数虚增
      if (!state.failedShotIds.includes(shotId)) state.failedShotIds.push(shotId)
      this.log(projectId, 'render', 'error', `镜头 ${shotId} 渲染失败：${msg || '未知原因'}`)
      this.lastStepByShot.delete(key)
      this.emitProgressEvent(projectId)
    } else if (e.step === 'queued' && msg === '已取消') {
      this.log(projectId, 'render', 'warn', `镜头 ${shotId} 已取消`)
      this.lastStepByShot.delete(key)
    }
  }

  /** 影子渲染队列排空：收尾 render 阶段并停表 */
  private onExternalQueueFinished(projectId: string): void {
    if (!this.shadowRenders.has(projectId)) return
    this.shadowRenders.delete(projectId)
    this.shadowSettledShots.delete(projectId)
    const state = this.states.get(projectId)
    if (!state) return
    const failed = state.failedShotIds.length
    state.stages.render = {
      status: failed > 0 ? 'error' : 'done',
      message: failed > 0 ? `本批渲染完成：成功 ${state.doneShots} · 失败 ${failed}（可在分镜页重渲失败镜头）` : `本批渲染完成：成功 ${state.doneShots} 镜`,
      percent: 100
    }
    state.running = false
    state.finishedAt = Date.now()
    this.log(projectId, 'render', failed > 0 ? 'warn' : 'success',
      failed > 0 ? `渲染队列已排空（成功 ${state.doneShots} · 失败 ${failed}）` : `渲染队列已排空，成功 ${state.doneShots} 镜`)
    this.emitProgressEvent(projectId)
  }

  static get STAGE_LABELS(): Record<DirectorStage, string> {
    return STAGE_LABELS
  }

  /** 启动全流程，返回 projectId */
  async start(input: DirectorStartInput): Promise<string> {
    const project = await this.store.create(input.title, input.genre)
    // 原始剧本回存项目（剧本页可回看/编辑/重拆）
    project.script = input.script
    project.updatedAt = Date.now()
    await this.store.save(project)
    const state = this.freshState(project.id, input.title)
    const gateList = (input.gateStages || []).filter(g => g !== 'done')
    state.gateStages = gateList
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
    // M-x：取消后立即把 running 落盘，避免 director-state.json 残留 running=true
    // 导致重启后 UI/按钮误判"导演仍在跑"（isRendering 黏死同源问题）
    const state = this.states.get(projectId)
    if (state) {
      state.running = false
      this.emitState(projectId)
      await this.persist(projectId).catch(() => {})
    }
  }

  /** 请求暂停：已在确认点则无操作；否则在当前阶段结束后停下 */
  async pause(projectId: string): Promise<void> {
    const state = this.states.get(projectId)
    if (!state || !state.running || state.paused) return
    this.pauseRequested.add(projectId)
    this.log(projectId, DirectorAgent.currentStage(state), 'warn',
      '已请求暂停，将在当前阶段结束后停下，不会中断进行中的渲染')
  }

  /** 从确认点继续 */
  async resume(projectId: string): Promise<void> {
    this.pauseRequested.delete(projectId)
    const state = this.states.get(projectId)
    if (state) {
      state.paused = false
      this.emitState(projectId)
    }
    this.waiters.get(projectId)?.()
    this.waiters.delete(projectId)
  }

  /**
   * A 断点续跑：从指定阶段重跑，该阶段及其后全部重新执行，此前已完成阶段跳过。
   * 状态从内存或磁盘（director-state.json）恢复，原始输入与剧本分析结果
   * 随状态持久化，因此应用重启后同样可以从断点继续。
   */
  async resumeFromStage(projectId: string, stage: DirectorStage): Promise<void> {
    let state = this.states.get(projectId)
    if (!state) {
      const hydrated = await this.hydrate(projectId)
      if (hydrated) state = hydrated
    }
    if (!state) throw new Error('未找到该任务的执行状态，无法断点续跑')
    if (state.running) throw new Error('任务正在运行中，无需续跑')
    // S1 竞态防护：cancel 已立即落 running=false，但旧流水线可能尚未走到下一个
    // 取消检查点。此时放行续跑会 delete 取消标志让旧流水线"复活"，形成双流水线
    // 并发改同一 state。取消中的项目拒绝续跑，待旧流水线 finish 后用户重试即可。
    if (this.cancelled.has(projectId)) throw new Error('任务正在取消中，请稍后再试')
    if (stage === 'done') throw new Error('「完成」不是可执行阶段')

    // 前置产物校验：缺什么直接说清楚，不让用户点了按钮才在半路报错
    const input = state.input
    if (!input?.script) {
      throw new Error('缺少原始剧本输入，无法断点续跑（请重新发起任务）')
    }
    if (stageIndexOf(stage) <= stageIndexOf('scenes') && stageIndexOf(stage) > stageIndexOf('analyze')
      && !state.analysis) {
      throw new Error('缺少剧本分析结果，无法从该阶段续跑（可改从「剧本分析」重跑）')
    }
    const project = await this.store.get(projectId)
    // 从 scenes 续跑跳过 casting：角色表为空会让 buildShots 得到空 characterMap，
    // 全部 i2v 分镜无定妆参考且不报错（D4）
    if (stageIndexOf(stage) === stageIndexOf('scenes') && project.characters.length === 0) {
      throw new Error('缺少角色建档数据，无法从「场景图生成」续跑（可改从「角色建档」重跑）')
    }
    // 仅「渲染及之后」需要已有分镜；从 scenes 续跑本身就会重建分镜，允许 shots 为空
    if (stageIndexOf(stage) >= stageIndexOf('render') && project.shots.length === 0) {
      throw new Error('项目中没有分镜数据，无法从渲染及之后阶段续跑')
    }
    if (stage === 'combine' && !project.shots.some(s => s.status === 'done' && s.segmentPath)) {
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
    state.finishedAt = undefined
    state.reviewIssues = undefined
    state.heal = undefined
    state.failedShotIds = []
    state.cancelled = false

    // 阶段门重建：只保留续跑范围内的门（此前阶段不再经过，天然不会触发）
    this.gates.set(projectId, new Set(state.gateStages.filter(g => stageIndexOf(g) >= stageIndexOf(stage))))
    this.cancelled.delete(projectId)
    this.states.set(projectId, state)

    this.log(projectId, stage, 'info',
      `断点续跑：从「${STAGE_LABELS[stage]}」阶段继续，此前已完成阶段自动跳过`)

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

  /**
   * C 错误回流自愈：阶段失败时把错误样本交回 LLM 诊断，
   * 判定值得重试（瞬时/抖动类）且预算未耗尽时自动重跑一次，否则把
   * 诊断与修复建议写入 state.heal 供 UI 展示后暂停。
   * @returns true = 已自动重试且重试动作本身未抛错（最终结果由调用方复查产物）
   */
  private async selfHealStage(
    projectId: string,
    stage: DirectorStage,
    stageLabel: string,
    errors: string[],
    retry: () => Promise<void>
  ): Promise<boolean> {
    const used = this.healBudget.get(projectId) ?? 0
    if (used >= DirectorAgent.HEAL_MAX) return false
    const state = this.states.get(projectId)
    if (!state) return false

    this.setStage(projectId, stage, 'running', 'AI 正在诊断失败原因...', 0)
    let diag: { canAutoFix: boolean; diagnosis: string; suggestion: string }
    try {
      diag = await this.llm.diagnoseFailure({
        stageLabel,
        errors: errors.slice(0, 5),
        context: `项目共 ${state.totalShots} 镜，此前成功 ${state.doneShots} 镜`
      })
    } catch {
      // 诊断服务不可用：降级为不自愈，保持原失败路径
      return false
    }

    if (!diag.canAutoFix) {
      // 预算只在真正执行重试时消耗（D5）：诊断失败/不可自动修复不挤占额度
      state.heal = { stage, diagnosis: diag.diagnosis, suggestion: diag.suggestion }
      this.log(projectId, stage, 'warn',
        `AI 诊断：${diag.diagnosis}。建议：${diag.suggestion}（需人工处理后重试）`)
      return false
    }

    this.healBudget.set(projectId, used + 1)
    state.heal = { stage, diagnosis: diag.diagnosis, suggestion: '已自动重试（若再次失败请按建议人工处理）' }
    this.log(projectId, stage, 'warn',
      `AI 自诊断：${diag.diagnosis}——判定可自动恢复，正在自动重试「${stageLabel}」（${used + 1}/${DirectorAgent.HEAL_MAX}）`)
    try {
      await retry()
      return true
    } catch (e) {
      this.log(projectId, stage, 'error', `自动重试仍未成功: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  }

  /**
   * B 瞬时故障重试包装：网络抖动/服务过载/超时类错误自动退避重试，
   * 永久性错误立即原样抛出。notify 用于把重试过程写进阶段消息。
   * isCancelled 传入后退避等待按 200ms 分片轮询，取消时立即抛 CANCELLED（D6）。
   */
  private async withTransientRetry<T>(
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
          if (opts.isCancelled?.()) throw new Error('CANCELLED')
          await new Promise(r => setTimeout(r, 200))
        }
      }
    }
    throw lastErr
  }

  getState(projectId: string): DirectorState | null {
    return this.states.get(projectId) || null
  }

  /** 最近活跃的任务状态（含影子渲染任务）：全局控制台没有绑定项目，用它展示最近一次工作 */
  getLatestState(): DirectorState | null {
    let latest: DirectorState | null = null
    let latestAt = 0
    for (const state of this.states.values()) {
      const lastLog = state.logs[state.logs.length - 1]
      const at = Math.max(lastLog?.timestamp || 0, state.finishedAt || 0, state.startedAt || 0)
      if (at > latestAt) {
        latestAt = at
        latest = state
      }
    }
    return latest
  }

  /**
   * LOGIC-P1 / directorClearState：清空某项目的全部运行时残留。
   * 前端切换/关闭项目时调用，防止幽灵流水线、渲染进度监听器、gate 等待器跨项目泄漏。
   * 不主动 cancel 正在跑的流水线——调用方（before-quit / 切项目）应先 cancel。
   */
  clearState(projectId: string): void {
    this.states.delete(projectId)
    this.cancelled.delete(projectId)
    this.gates.delete(projectId)
    this.pauseRequested.delete(projectId)
    this.waiters.delete(projectId)
    this.logSeq.delete(projectId)
    this.healBudget.delete(projectId)
    this.shadowSettledShots.delete(projectId)
    this.visionWarned.delete(projectId)
    this.shadowRenders.delete(projectId)
    for (const key of [
      ...this.lastStageMsg.keys(),
      ...this.lastStepByShot.keys()
    ]) {
      if (key.startsWith(`${projectId}:`)) {
        this.lastStageMsg.delete(key)
        this.lastStepByShot.delete(key)
      }
    }
    this.unsubscribeRenderProgress(projectId)
  }

  /**
   * 崩溃/重启恢复：内存无状态且磁盘有 director-state.json 时回填。
   * 恢复回来的 running 状态一律降级为「已中断」展示，防止显示假运行。
   */
  async hydrate(projectId: string): Promise<DirectorState | null> {
    const existing = this.states.get(projectId)
    if (existing) return existing
    try {
      const file = path.join(this.baseDir, 'projects', projectId, 'director-state.json')
      const raw = await fs.readFile(file, 'utf-8')
      const state = JSON.parse(raw) as DirectorState
      let repaired = false
      if (state.running || state.paused) {
        state.running = false
        state.paused = false
        state.finishedAt = Date.now()
        // 残留的 running 阶段转为 error：否则 UI 永久转圈，且「从此重跑」按钮
        // （仅对 done/error 阶段显示）不会出现，断点续跑入口被锁死
        for (const stage of STAGE_ORDER) {
          if (state.stages[stage].status === 'running') {
            state.stages[stage] = {
              status: 'error',
              message: '应用重启导致该阶段中断',
              percent: state.stages[stage].percent
            }
          }
        }
        // 续用日志序号器：从磁盘日志的最大 id 起算，保证唯一
        const maxId = state.logs.reduce((m, l) => Math.max(m, typeof l.id === 'number' ? l.id : 0), 0)
        const seq = Math.max(this.logSeq.get(projectId) || 0, maxId) + 1
        this.logSeq.set(projectId, seq)
        state.logs.push({
          id: seq,
          stage: 'done',
          level: 'warn',
          message: '应用重启，上次任务已中断（渲染产物保留，可从失败阶段重跑续传）',
          timestamp: Date.now()
        })
        repaired = true
      }
      this.states.set(projectId, state)
      // 必须先入内存再落盘：persist 从 this.states 取状态，顺序反了会被静默跳过
      if (repaired) this.persist(projectId).catch(() => undefined)
      return state
    } catch {
      return null
    }
  }

  /** 找到当前正在运行的阶段（用于暂停提示归属） */
  private static currentStage(state: DirectorState): DirectorStage {
    for (const stage of STAGE_ORDER) {
      if (state.stages[stage].status === 'running') return stage
    }
    return 'done'
  }

  private freshState(projectId: string, title: string): DirectorState {
    const stages = {} as Record<DirectorStage, StageState>
    for (const stage of STAGE_ORDER) {
      stages[stage] = { status: 'pending', message: '', percent: 0 }
    }
    return {
      projectId,
      title,
      running: true,
      cancelled: false,
      paused: false,
      gateStages: [],
      stages,
      totalShots: 0,
      doneShots: 0,
      failedShotIds: [],
      startedAt: Date.now(),
      logs: []
    }
  }

  private isCancelled(projectId: string): boolean {
    return this.cancelled.has(projectId)
  }

  private setStage(
    projectId: string,
    stage: DirectorStage,
    status: StageStatus,
    message: string,
    percent?: number
  ): void {
    const state = this.states.get(projectId)
    if (!state) return
    const st = state.stages[stage]
    st.status = status
    if (message !== undefined) st.message = message
    if (percent !== undefined) st.percent = percent
    // 状态变化同步为中文日志（running 的重复进度消息抑制，避免刷屏）
    if (message && status !== 'pending') {
      const key = `${projectId}:${stage}`
      const last = this.lastStageMsg.get(key)
      if (status !== 'running' || last !== message) {
        this.lastStageMsg.set(key, message)
        const level = status === 'done' ? 'success'
          : status === 'error' ? 'error'
          : status === 'skipped' ? 'warn' : 'info'
        this.log(projectId, stage, level, `${STAGE_LABELS[stage]} · ${message}`)
      }
    }
    this.emitState(projectId)
  }

  /** 追加一条中文执行日志并推送给面板 */
  private log(
    projectId: string,
    stage: DirectorStage,
    level: 'info' | 'success' | 'warn' | 'error',
    message: string
  ): void {
    const state = this.states.get(projectId)
    if (!state || !message) return
    const seq = (this.logSeq.get(projectId) || 0) + 1
    this.logSeq.set(projectId, seq)
    const entry: DirectorLogEntry = { id: seq, stage, level, message, timestamp: Date.now() }
    state.logs.push(entry)
    if (state.logs.length > DirectorAgent.LOG_LIMIT) {
      state.logs.splice(0, state.logs.length - DirectorAgent.LOG_LIMIT)
    }
    this.emit('log', { type: 'director:log', projectId, entry })
  }

  /**
   * 阶段间确认点：命中配置门或用户手动暂停时挂起流水线，
   * 等待 resume/cancel 放行。进行中的渲染不受影响（调用点均在阶段边界）。
   */
  private async maybeGate(projectId: string, afterStage: DirectorStage): Promise<void> {
    if (this.isCancelled(projectId)) return
    const hitGate = this.gates.get(projectId)?.has(afterStage) ?? false
    if (!hitGate && !this.pauseRequested.has(projectId)) return
    const state = this.states.get(projectId)
    if (!state) return
    state.paused = true
    this.pauseRequested.delete(projectId)
    this.log(projectId, afterStage, 'warn',
      `「${STAGE_LABELS[afterStage]}」阶段已完成，任务暂停，确认后继续`)
    this.emitState(projectId)
    await new Promise<void>(resolve => this.waiters.set(projectId, resolve))
    if (!this.isCancelled(projectId)) {
      this.log(projectId, afterStage, 'info', '已继续执行下一阶段')
    }
  }

  /**
   * LOGIC-P1-01 分镜首帧门：render.shotReviewGate==='block' 且有未审 i2v 镜时挂起流水线，
   * 等用户逐镜核对后 resume/cancel 放行（与 renderStart IPC 同口径，reviewed=true 但
   * 首帧路径缺失视为未审）。'warn' 只告警放行；'off' 不检查。
   * @returns true 可继续渲染；false 已取消。
   */
  private async pauseUntilShotsReviewed(projectId: string): Promise<boolean> {
    const settings = await this.settings.get()
    const gate = settings.render?.shotReviewGate ?? 'block'
    if (gate === 'off') return true
    const project = await this.store.get(projectId)
    const unreviewed = project.shots
      .filter(s => s.type === 'i2v' && !reviewedIsValid(s.type, s.reviewed, s.firstFramePath))
    if (unreviewed.length === 0) return true
    if (gate === 'warn') {
      this.log(projectId, 'render', 'warn', `${unreviewed.length} 镜未核对分镜图（按设置告警放行）`)
      return true
    }
    const state = this.states.get(projectId)
    if (!state) return false
    state.paused = true
    const names = unreviewed.slice(0, 5).map(s => `第${s.index}镜`).join('、')
    this.log(projectId, 'render', 'warn',
      `分镜审核门：${unreviewed.length} 镜未核对分镜图，已暂停等待审核（可在分镜页逐镜核对/重出首帧后继续）`)
    this.setStage(projectId, 'render', 'paused',
      `等待分镜审核：${names}${unreviewed.length > 5 ? ` 等 ${unreviewed.length} 镜` : ''}未核对分镜图`, 0)
    await new Promise<void>(resolve => this.waiters.set(projectId, resolve))
    return !this.isCancelled(projectId)
  }

  private emitState(projectId: string): void {
    const state = this.states.get(projectId)
    if (!state) return
    state.cancelled = this.cancelled.has(projectId)
    this.emit('progress', { type: 'director:progress', projectId, state })
    this.persist(projectId).catch(() => {})
  }

  private async persist(projectId: string): Promise<void> {
    const state = this.states.get(projectId)
    if (!state) return
    const file = path.join(
      this.baseDir, 'projects', projectId, 'director-state.json'
    )
    await fs.mkdir(path.dirname(file), { recursive: true })
    await atomicWriteJson(file, state)
  }

  // ===== 流水线 =====

  /**
   * 流水线主体。from 之前的阶段（断点续跑）直接跳过：
   * - analyze 复用持久化的 state.analysis，casting/scenes 不再重复执行
   * - render 之后续跑时跳过审批（上次已过审），拼接/字幕产物按阶段状态选用
   */
  private async runPipeline(projectId: string, input: DirectorStartInput, from: DirectorStage = 'analyze'): Promise<void> {
    const state = this.states.get(projectId)
    if (!state) return
    const fromIdx = stageIndexOf(from)
    this.healBudget.set(projectId, 0)
    state.input = input

    let analysis: AnalyzeResult | null = state.analysis ?? null
    let characterMap: Map<string, Character> | null = null
    let approval: {
      approved: boolean; problems: string[]; retryIds: string[]; durations: Map<string, number>; warnings: string[]
    } | null = null
    let rendered: Project | null = null
    let doneShots: Shot[] = []

    this.log(projectId, from, 'info',
      from === 'analyze'
        ? `任务开始：《${input.title}》（${input.genre}），共设 ${this.gates.get(projectId)?.size || 0} 个阶段确认点`
        : `断点续跑：从「${STAGE_LABELS[from]}」阶段继续执行`)

    // 看守机制：任务一开始就自动加载导演技能库并全程生效（强制重读磁盘，编辑 rules.json 后本次任务即生效）
    const skillLoaded = await this.skills.load(true)
    const checklist = await this.skills.auditChecklist()
    const methodRules = await this.skills.methodRules()
    this.log(projectId, from, 'info',
      skillLoaded
        ? `技能库已生效：director v${skillLoaded.version}（审核 ${checklist.length} 项 / 方法论 ${methodRules.length} 条）`
        : `技能库未加载（${this.skills.loadErrorHint() || '目录缺失'}），按代码层默认条款执行`)

    // ① 剧本分析（瞬时异常自动退避重试；断点续跑时沿用持久化分析结果）
    if (fromIdx <= stageIndexOf('analyze')) {
      this.setStage(projectId, 'analyze', 'running', 'AI 阅读剧本，识别角色与分镜...', 10)
      try {
        analysis = await this.withTransientRetry(
          () => this.llm.analyze(input.script, input.genre, {
            title: input.title,
            extraRules: methodRules
          }),
          { notify: (msg) => this.setStage(projectId, 'analyze', 'running', msg, 10), isCancelled: () => this.isCancelled(projectId) }
        )
        state.analysis = analysis
        // LOGIC-P1-08：拆镜结果按创建设置 maxShots 上限截断（下限不凭空补镜）
        const maxShots = (await this.settings.get()).creation?.storyboard?.maxShots ?? 20
        const clamped = clampShotList(analysis.shots, maxShots)
        if (clamped.trimmed > 0) {
          analysis.shots = clamped.shots
          this.log(projectId, 'analyze', 'warn',
            `分镜数 ${analysis.shots.length + clamped.trimmed} 超过上限 ${maxShots}，已截断保留前 ${analysis.shots.length} 镜`)
        }
        const warnings = analysis.warnings || []
        const bindingHard = warnings.filter(w => /无法匹配|未归属/.test(w))
        const softWarn = warnings.filter(w => !bindingHard.includes(w))
        this.setStage(
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
        if (softWarn.length > 0) {
          this.log(projectId, 'analyze', 'warn', `叙事连续性：${softWarn.join('；')}`)
        }
      } catch (e) {
        this.setStage(projectId, 'analyze', 'error',
          `分析失败: ${e instanceof Error ? e.message : String(e)}`, 0)
        this.finish(projectId)
        return
      }

      await this.maybeGate(projectId, 'analyze')
      if (this.isCancelled(projectId)) { this.finish(projectId); return }
    }

    // ② 角色建档 + AI 定妆图（断点续跑时跳过，角色沿用上次建档）
    if (fromIdx <= stageIndexOf('casting')) {
      try {
        characterMap = await this.buildCharacters(projectId, analysis!)
        // 道具资产：分镜阶段提取的关键道具 → 生成道具定妆图（渲染锁形参考，防变样/消失）
        await this.buildPropAssets(projectId, analysis!)
      } catch (e) {
        if (e instanceof ImageGenerateCancelled || this.isCancelled(projectId) || /CANCELLED/i.test(String(e))) {
          this.setStage(projectId, 'casting', 'skipped', '已取消')
          this.finish(projectId)
          return
        }
        this.setStage(projectId, 'casting', 'error',
          `角色建档异常: ${e instanceof Error ? e.message : String(e)}`, 0)
        this.finish(projectId)
        return
      }
      await this.maybeGate(projectId, 'casting')
      if (this.isCancelled(projectId)) { this.finish(projectId); return }
    } else if (fromIdx <= stageIndexOf('scenes')) {
      // 从 scenes 续跑会跳过 casting：必须从项目角色表重建 name→Character，否则 buildShots 空指针
      const projectForCast = await this.store.get(projectId)
      characterMap = new Map(projectForCast.characters.map(c => [c.name, c]))
    }

    // ③ 分镜建档 + 空镜场景图（断点续跑时跳过，分镜沿用上次建档）
    if (fromIdx <= stageIndexOf('scenes')) {
      try {
        await this.buildShots(projectId, analysis!, characterMap!)
      } catch (e) {
        if (e instanceof ImageGenerateCancelled || this.isCancelled(projectId) || /CANCELLED/i.test(String(e))) {
          this.setStage(projectId, 'scenes', 'skipped', '已取消')
          this.finish(projectId)
          return
        }
        this.setStage(projectId, 'scenes', 'error',
          `场景/首尾帧异常: ${e instanceof Error ? e.message : String(e)}`, 0)
        this.finish(projectId)
        return
      }
      await this.maybeGate(projectId, 'scenes')
      if (this.isCancelled(projectId)) { this.finish(projectId); return }
    }

    if (state.totalShots === 0) {
      this.setStage(projectId, 'render', 'error', '没有可渲染的分镜', 0)
      this.finish(projectId)
      return
    }

    // ④ 逐镜渲染（TTS 在队列内完成；遇错继续；断点续跑时只重渲 pending/failed 镜）
    if (fromIdx <= stageIndexOf('render')) {
      // LOGIC-P1-01 分镜首帧门：block 模式下存在未核对分镜图的 i2v 镜时挂起流水线，
      // 等用户逐镜核对/重出首帧后从「逐镜渲染」继续（先审后渲）
      if (!(await this.pauseUntilShotsReviewed(projectId))) {
        this.finish(projectId)
        return
      }
      // 出视频前钉工作流：有台词 → r2v 原生口型；录音/画外音 → i2v（避免成片变成解说贴音）
      await lockPromptsAndWorkflow(this as unknown as DirectorStageRuntime, projectId)
      const renderCfg = (await this.settings.get()).render
      const perShotAudit = renderCfg.perShotAudit !== false
      // 逐镜审核的每镜实际时长（review 音画匹配用）
      const shotDurations = new Map<string, number>()
      this.setStage(projectId, 'render', 'running',
        perShotAudit ? `逐镜渲染+即时审核 0/${state.totalShots}...` : `渲染中 0/${state.totalShots}...`, 0)
      if (perShotAudit) {
        // 看守模式：出一镜审一镜，不过立即整改重渲，过审才进下一镜
        await this.renderShotsWithAudit(projectId, shotDurations)
      } else {
        this.subscribeRenderProgress(projectId)
        try {
          await this.queue.start(projectId)
          await this.queue.waitForFinish(projectId)
        } catch (e) {
          this.setStage(projectId, 'render', 'error',
            `渲染队列异常: ${e instanceof Error ? e.message : String(e)}`, 0)
        }
        this.unsubscribeRenderProgress(projectId)
      }

      rendered = await this.store.get(projectId)
      doneShots = rendered.shots.filter(s => s.status === 'done')
      state.doneShots = doneShots.length
      state.failedShotIds = rendered.shots
        .filter(s => s.status === 'failed')
        .map(s => s.id)

      if (this.isCancelled(projectId)) {
        this.setStage(projectId, 'render', 'skipped', '已取消')
        this.finish(projectId)
        return
      }

      // C 自愈：全部失败 或 部分失败 → 错误样本回流 AI，可恢复则换 seed 重渲失败镜
      if (state.failedShotIds.length > 0) {
        const failedErrors = [...new Set(
          rendered.shots.filter(s => s.status === 'failed').map(s => s.error || '未知原因')
        )]
        const healIds = [...state.failedShotIds]
        const healed = await this.selfHealStage(projectId, 'render', '逐镜渲染', failedErrors, async () => {
          const fresh = await this.store.get(projectId)
          for (const s of fresh.shots) {
            if (healIds.includes(s.id)) s.seed = Math.floor(Math.random() * 0xffffffff)
          }
          await this.store.save(fresh)
          this.subscribeRenderProgress(projectId)
          try {
            await this.queue.start(projectId, healIds)
            await this.queue.waitForFinish(projectId)
          } finally {
            this.unsubscribeRenderProgress(projectId)
          }
        })
        if (healed) {
          rendered = await this.store.get(projectId)
          doneShots = rendered.shots.filter(s => s.status === 'done')
          state.doneShots = doneShots.length
          state.failedShotIds = rendered.shots
            .filter(s => s.status === 'failed')
            .map(s => s.id)
        }
      }

      if (doneShots.length === 0) {
        this.setStage(projectId, 'render', 'error', '全部镜头渲染失败', 0)
        this.finish(projectId, state.heal
          ? `全部镜头渲染失败：${state.heal.suggestion}`
          : undefined)
        return
      }

      this.setStage(projectId, 'render', 'done',
        `完成 ${doneShots.length}/${state.totalShots}` +
        (state.failedShotIds.length ? `，${state.failedShotIds.length} 镜失败` : ''), 100)

      // ④+ 逐镜审批：批量路径保留严格关卡；看守路径已逐镜即时审核（预算用尽放行留痕），只做汇总
      if (!perShotAudit) {
        approval = await this.approveShots(projectId)
        // 一致性低分等警告：放行但留痕，供用户在分镜页手动重渲
        if (approval.warnings.length) {
          for (const w of approval.warnings) this.log(projectId, 'render', 'warn', w)
        }
        if (!approval.approved) {
          state.failedShotIds = [...new Set([...state.failedShotIds, ...approval.retryIds])]
          this.setStage(projectId, 'render', 'error',
            `${approval.problems.length} 镜未过审，已停止剪辑：${approval.problems.slice(0, 3).join('；')}` +
              (approval.problems.length > 3 ? '等' : ''),
            Math.round((doneShots.length / Math.max(1, state.totalShots)) * 100))
          this.finish(projectId, '逐镜审批未通过，未进入剪辑；请在分镜编辑处理后重跑「逐镜渲染」')
          return
        }
      } else {
        approval = {
          approved: true, problems: [], retryIds: [], durations: shotDurations, warnings: []
        }
        // LOGIC-P0-03 提示式审核：软提示（auditHint，技术快审未过但不阻断）只留痕放行，
        // 仅硬失败（渲染失败镜）才暂停等用户整改。
        const hintCount = rendered.shots.filter(s => s.auditHint).length
        const failCount = state.failedShotIds.length
        if (hintCount > 0) {
          this.log(projectId, 'render', 'warn',
            `软提示 ${hintCount} 镜（审核未过但不阻断），已放行进入剪辑；可在分镜页逐镜整改后手动重渲`)
        }
        if (shouldPauseAfterAudit(hintCount, failCount)) {
          this.log(projectId, 'render', 'warn',
            `${failCount} 镜渲染失败：已暂停不进剪辑，请在分镜页逐镜查看/编辑/重渲后，从「视频剪辑」阶段手动继续`)
          this.setStage(projectId, 'render', 'paused',
            `渲染完成，${failCount} 镜渲染失败；整改后在导演控制台从「视频剪辑」阶段继续`, 100)
          this.finish(projectId,
            `${failCount} 镜渲染失败，已暂停不进剪辑；整改后重新运行并选择从「视频剪辑」阶段开始`)
          return
        }
      }

      await this.maybeGate(projectId, 'render')
      if (this.isCancelled(projectId)) { this.finish(projectId); return }
    }

    // 审批后 / 断点续跑进入剪辑前的统一刷新（重渲镜头状态可能变化）
    rendered = await this.store.get(projectId)
    doneShots = rendered.shots.filter(s => s.status === 'done' && s.segmentPath)
    state.doneShots = doneShots.length

    // ⑤ 拼接成片（全部 done 镜，按分镜顺序；断点续跑时沿用上次成片）
    // 2026-10-25 统一口径（对齐 staged 管线）：低一致性镜只打标保留在成片与字幕轴，
    // 不自动剔除（可在剪辑台手动跳过或重渲）——历史剔镜曾误伤台词镜（ArcFace 表情镜被压分）。
    const includedIds = doneShots.map(s => s.id)
    let currentVideo = `projects/${projectId}/final.mp4`
    if (fromIdx > stageIndexOf('combine') && state.stages.subtitle.status === 'done') {
      currentVideo = `projects/${projectId}/final_subtitled.mp4`
    }
    if (fromIdx <= stageIndexOf('combine')) {
      this.setStage(projectId, 'combine', 'running', '拼接成功分镜...', 20)
      try {
        // LOGIC-P0-04：拼接前修复 TTS 失败镜（audioFailed）——用原视频+新配音重做分段，
        // 否则台词镜直接静音进成片（对齐 staged 管线 repairSilentDialogue）
        try {
          const repaired = await this.queue.repairSilentDialogue(projectId)
          if (repaired.repaired.length > 0) {
            this.log(projectId, 'combine', 'success',
              `静音台词镜已补配音修复：第 ${repaired.repaired.join('、')} 镜`)
            rendered = await this.store.get(projectId)
            doneShots = rendered.shots.filter(s => s.status === 'done' && s.segmentPath)
            state.doneShots = doneShots.length
          }
        } catch (e) {
          this.log(projectId, 'combine', 'warn',
            `静音台词镜修复失败（按现状拼接）: ${e instanceof Error ? e.message : String(e)}`)
        }
        await this.concatDoneShots(projectId, doneShots, currentVideo)
        const lowCons = doneShots.filter(s => s.lowConsistency)
        const detail = []
        if (state.failedShotIds.length) detail.push(`跳过失败镜头 ${state.failedShotIds.length}`)
        if (lowCons.length) detail.push(`低一致性 ${lowCons.length} 镜已保留在成片中（可在剪辑台跳过或重渲）`)
        this.setStage(projectId, 'combine', 'done',
          detail.length ? `已拼接 ${doneShots.length} 镜（${detail.join('；')}）` : `已拼接 ${doneShots.length} 镜`, 100)
      } catch (e) {
        const errMsg = `拼接失败: ${e instanceof Error ? e.message : String(e)}`
        // C 自愈：拼接多为 ffmpeg 瞬时故障，诊断后自动重试
        const healed = await this.selfHealStage(projectId, 'combine', '拼接成片', [errMsg], () =>
          this.concatDoneShots(projectId, doneShots, currentVideo)
        )
        if (healed) {
          this.setStage(projectId, 'combine', 'done',
            state.failedShotIds.length
              ? `已拼接 ${doneShots.length} 镜（跳过失败镜头）`
              : `已拼接 ${doneShots.length} 镜`, 100)
        } else {
          this.setStage(projectId, 'combine', 'error', errMsg, 0)
          this.finish(projectId, state.heal
            ? `拼接失败：${state.heal.suggestion}`
            : undefined)
          return
        }
      }

      await this.maybeGate(projectId, 'combine')
      if (this.isCancelled(projectId)) { this.finish(projectId); return }
    }

    // ⑥ 烧录字幕（时间轴只含参与拼接的镜头；断点续跑时沿用上次字幕版成片）
    if (fromIdx <= stageIndexOf('subtitle')) {
      this.setStage(projectId, 'subtitle', 'running', '生成字幕并烧录...', 20)
      try {
        const srtRel = await this.subtitles.generate(rendered!, includedIds)
        if (!srtRel) {
          this.setStage(projectId, 'subtitle', 'skipped', '无台词，跳过字幕烧录', 100)
        } else {
          const out = `projects/${projectId}/final_subtitled.mp4`
          const edit = resolveCreation(await this.settings.get()).edit
          await this.ffmpeg.burnSubtitles(
            path.join(this.baseDir, currentVideo),
            path.join(this.baseDir, srtRel),
            path.join(this.baseDir, out),
            { fontSize: edit.subtitleFontSize, marginV: edit.subtitleMarginV }
          )
          currentVideo = out
          this.setStage(projectId, 'subtitle', 'done', '字幕已烧录', 100)
        }
      } catch (e) {
        // 字幕失败不阻断：继续用无字幕成片做 BGM
        this.setStage(projectId, 'subtitle', 'error',
          `字幕失败（保留无字幕版）: ${e instanceof Error ? e.message : String(e)}`, 0)
      }

      await this.maybeGate(projectId, 'subtitle')
      if (this.isCancelled(projectId)) { this.finish(projectId); return }
    }

    // ⑥+ 成片复审：音画技术校验 + AI 审片（剧情完整性/台词相符），通过才允许配 BGM
    // （断点续跑时跳过：沿用上次复审结论）
    if (fromIdx <= stageIndexOf('review')) {
      this.setStage(projectId, 'review', 'running', '复审：音画技术校验...', 15)
      try {
        const issues: string[] = []
        // 断点续跑没有审批产物时，分段探测顺带补齐每镜时长（AI 审片输入用）
        const durations = approval?.durations ?? new Map<string, number>()

        // 技术面：成片必须有音轨、时长合理、与各分段累计一致
        const finalInfo = await this.ffmpeg.getVideoInfo(path.join(this.baseDir, currentVideo))
        if (!finalInfo.hasAudio) issues.push('成片缺少音轨')
        if (finalInfo.durationSec < 3) {
          issues.push(`成片时长异常（仅 ${finalInfo.durationSec.toFixed(1)}s）`)
        } else {
          let sumSeg = 0
          for (const s of doneShots) {
            const d = (await this.ffmpeg.getVideoInfo(path.join(this.baseDir, s.segmentPath!))).durationSec
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
        this.setStage(projectId, 'review', 'running', '复审：AI 审片（剧情完整性 · 台词相符 · 音画匹配）...', 55)
        const review = await this.withTransientRetry(
          () => this.llm.reviewStory({
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
          { notify: (msg) => this.setStage(projectId, 'review', 'running', msg, 55), isCancelled: () => this.isCancelled(projectId) }
        )
        issues.push(...review.issues)

        // 低一致性镜（重渲后仍漂移）：硬门禁下必须阻断，不得剔镜放行——
        // 「带病前进=烂片」，低一致性镜要么重渲通过、要么停在复审，不允许进成片
        const lowConsShots = doneShots.filter(s => s.lowConsistency)
        if (lowConsShots.length > 0) {
          issues.push(
            `存在 ${lowConsShots.length} 个低一致性镜头（第${lowConsShots.map(s => s.index).join('、')}镜），` +
            `复审硬门禁要求重渲通过后才能入成片`
          )
        }

        // 仅「成片无音轨 / 时长塌缩」视为技术硬伤；时长微差与剧情意见一律告警放行，避免误杀整条流水线
        const technical = issues.filter(i =>
          /缺少音轨|时长异常（仅/.test(i)
        )
        const narrative = issues.filter(i => !technical.includes(i))
        // LOGIC-P0-01：成片复审门读 render.finalReviewGate（与分镜首帧门 shotReviewGate 解耦）
        const gate = (await this.settings.get()).render.finalReviewGate || 'block'

        if (issues.length === 0) {
          this.setStage(projectId, 'review', 'done',
            `复审通过${review.summary ? `：${review.summary}` : ''}`, 100)
        } else if (gate === 'block' && (technical.length > 0 || lowConsShots.length > 0)) {
          // 硬门禁 v2：技术硬伤或低一致性镜存在 → 阻断（不许带病进 BGM/成片）
          state.reviewIssues = issues
          const blocked = technical.length ? `技术硬伤 ${technical.length} 项` : `低一致性镜 ${lowConsShots.length} 个`
          this.setStage(projectId, 'review', 'error',
            `复审未通过（${blocked}）：${issues.slice(0, 2).join('；')}`,
            0)
          this.log(projectId, 'review', 'error', `复审硬门禁阻断：${issues.join('；')}`)
          this.finish(projectId, '成片复审未通过（硬门禁阻断），已保留当前成片；修复（重渲低一致性镜/补音轨）后可从「成片复审」续跑')
          return
        } else {
          state.reviewIssues = issues
          const label = gate === 'off' ? '已记录' : '已放行'
          this.setStage(projectId, 'review', 'done',
            `复审有 ${issues.length} 项提醒（${label}）：${issues.slice(0, 2).join('；')}` +
              (issues.length > 2 ? '等' : ''),
            100)
          this.log(projectId, 'review', 'warn',
            `复审提醒（硬伤 ${technical.length} / 其他 ${narrative.length}）：${issues.join('；')}`)
        }
      } catch (e) {
        this.setStage(projectId, 'review', 'done',
          `复审异常已跳过: ${e instanceof Error ? e.message : String(e)}`, 100)
        this.log(projectId, 'review', 'warn',
          `复审异常已跳过: ${e instanceof Error ? e.message : String(e)}`)
      }

      await this.maybeGate(projectId, 'review')
      if (this.isCancelled(projectId)) { this.finish(projectId); return }
    }

    // ⑦ BGM 混音（最后一步：复审通过后才配乐出片）
    if (input.bgmAbsolutePath) {
      // 断点续跑时原 BGM 临时文件可能已被清理：缺失则跳过而非失败
      let bgmAvailable = true
      try { await fs.access(input.bgmAbsolutePath) } catch { bgmAvailable = false }
      if (!bgmAvailable) {
        this.setStage(projectId, 'bgm', 'skipped', 'BGM 文件已不存在，跳过混音（成片保留当前版本）', 0)
      } else {
        this.setStage(projectId, 'bgm', 'running', '导入 BGM 并混音...', 20)
        try {
          const ext = path.extname(input.bgmAbsolutePath) || '.mp3'
          const bgmRel = `projects/${projectId}/bgm${ext}`
          await fs.copyFile(
            input.bgmAbsolutePath,
            path.join(this.baseDir, bgmRel)
          )
          const defaultBgm = resolveCreation(await this.settings.get()).edit.defaultBgmVolume
          const rendered = await this.store.update(projectId, (p) => {
            p.bgmPath = bgmRel
            if (typeof p.bgmVolume !== 'number') p.bgmVolume = defaultBgm
          })
          const finalOut = `projects/${projectId}/final_master.mp4`
          const vol = typeof rendered.bgmVolume === 'number' ? rendered.bgmVolume : defaultBgm
          await this.ffmpeg.mixBgm(
            path.join(this.baseDir, currentVideo),
            path.join(this.baseDir, bgmRel),
            path.join(this.baseDir, finalOut),
            vol
          )
          currentVideo = finalOut
          this.setStage(projectId, 'bgm', 'done', 'BGM 混音完成', 100)
        } catch (e) {
          this.setStage(projectId, 'bgm', 'error',
            `BGM 失败: ${e instanceof Error ? e.message : String(e)}`, 0)
        }
      }
    } else {
      this.setStage(projectId, 'bgm', 'skipped', '未提供 BGM', 0)
    }

    state.finalPath = currentVideo
    this.finish(projectId)
  }

  /** 拼接全部 done 镜分段到指定输出（combine 主路径与自愈重试共用） */
  private async concatDoneShots(projectId: string, doneShots: Shot[], outputRel: string): Promise<void> {
    // 2026-10-25 统一口径：低一致性镜只打标保留（不自动剔除，防误伤台词镜）；
    // failed / 无分段镜由调用方过滤（doneShots 已限定 done+segmentPath）。
    const usable = doneShots
    if (usable.length === 0) {
      throw new Error('没有已完成可拼接的镜头；请在分镜页手动重渲后重试')
    }
    // 智能拼接：音频驱动裁剪（去片头残影/尾部静默）+ 仅显式 dissolve 边界叠化，其余硬切
    // LOGIC-P1-04：剪辑台手动裁剪区间（trimStart/trimEnd）与跳过标记（skipped）一并传入
    await this.ffmpeg.smartConcatSegments(
      usable.map(s => ({
        path: path.join(this.baseDir, s.segmentPath!),
        scene: s.scene,
        hasDialogue: Boolean(s.dialogue && s.dialogue.trim()),
        transition: s.transition,
        trimStart: s.trimStart,
        trimEnd: s.trimEnd,
        skipped: s.skipped
      })),
      path.join(this.baseDir, outputRel)
    )
  }

  /** 角色建档：面部定妆 + 全身三视图；角色间有限并发，单图失败带重试 */
  private async buildCharacters(
    projectId: string,
    analysis: AnalyzeResult
  ): Promise<Map<string, Character>> {
    const result = new Map<string, Character>()
    let femaleIdx = 0
    let maleIdx = 0
    let doneCount = 0
    const total = analysis.characters.length
    const settingsSnap = await this.settings.get()
    const concurrency = Math.max(1, Math.min(3, settingsSnap.render.assetConcurrency || 2))
    const ch = resolveCreation(settingsSnap).character
    const faceCount = Math.max(1, Math.min(4, ch.candidates || 1))
    const wfOpt = ch.t2iWorkflow ? { workflowName: ch.t2iWorkflow } : {}
    const neg = { negative: castingNegativeFor(ch.realismLock) }
    const abort = (): boolean => this.isCancelled(projectId)

    this.setStage(projectId, 'casting', 'running',
      `并发生成角色资产 0/${total}（并发 ${concurrency}，定妆抽卡×${faceCount}）...`, 5)

    // 时代锁：古风/年代剧注入 genre，定妆图按时代约束生成（杜绝现代服化道混入古装剧）
    const projectForGenre = await this.store.get(projectId)
    const genre = projectForGenre?.genre

    const prepared = analysis.characters.map((ac) => {
      const id = `char_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      const voice = ac.gender === 'male'
        ? MALE_VOICES[maleIdx++ % MALE_VOICES.length]
        : FEMALE_VOICES[femaleIdx++ % FEMALE_VOICES.length]
      const rawLookEn = /chinese|asian/i.test(ac.lookEn) ? ac.lookEn : `chinese, ${ac.lookEn}`
      // 古风/年代剧：建档源头即清洗现代服装词，定妆/首帧/渲染全链路使用同一份时代安全 lookEn
      const lookEn = castLookForGenre(rawLookEn, genre)
      return { ac, id, voice, lookEn }
    })

    // —— 硬门禁 v2：全角色 lookEn 结构化校验（武器单把+中式 / 结构缺项 / 三角色趋同差异化）——
    // LLM 角色设定不谨慎（katana/双持/趋同/缺条款）在此拦截修正，不带病进定妆生成
    const hardened = hardenLookEnList(prepared.map(p => p.lookEn), genre)
    for (const note of hardened.notes) {
      this.log(projectId, 'casting', 'warn', `lookEn 硬门禁：${note}`)
    }
    prepared.forEach((p, i) => { p.lookEn = hardened.looks[i] })

    await mapPool(prepared, concurrency, async ({ ac, id, voice, lookEn }) => {
      if (abort()) throw new ImageGenerateCancelled()
      const character: Character = {
        id,
        name: ac.name,
        refImagePath: '',
        description: ac.appearance,
        voice,
        appearanceLock: lookEn
      }
      const faceRel = `projects/${projectId}/characters/${id}_face.png`
      const bodyRel = `projects/${projectId}/characters/${id}_body.png`
      const genOpts = { shouldAbort: abort }

      try {
        const candRels: Array<{ rel: string; seed: number }> = []
        for (let ci = 0; ci < faceCount; ci++) {
          if (abort()) throw new ImageGenerateCancelled()
          const seed = ch.seedMode === 'fixed'
            ? (ch.seed + ci * 9973) >>> 0
            : Math.floor(Math.random() * 0xffffffff)
          const rel = faceCount === 1
            ? faceRel
            : `projects/${projectId}/characters/${id}_face_c${ci}.png`
          await this.image.generate(
            faceCastingPrompt(lookEn, { realismLock: ch.realismLock, genre }),
            path.join(this.baseDir, rel),
            { width: ch.faceWidth, height: ch.faceHeight, seed, ...wfOpt, ...neg, ...genOpts }
          )
          candRels.push({ rel, seed })
        }
        if (candRels.length === 1) {
          character.faceImagePath = candRels[0].rel
        } else {
          const items = await Promise.all(candRels.map(async (c, i) => {
            const abs = path.join(this.baseDir, c.rel)
            let score = 0.5
            let note = '生成成功'
            try {
              const st = await fs.stat(abs)
              // 文件更大通常细节更足；轻微拉开分差供 LLM 参考
              score = Math.min(0.95, 0.4 + Math.log10(Math.max(1000, st.size)) / 10)
              note = `file=${Math.round(st.size / 1024)}KB`
            } catch { note = 'stat 失败' }
            return { id: `c${i}`, relativePath: c.rel, seed: c.seed, score, note }
          }))
          const picked = await this.picker.pick({
            kind: 'character',
            brief: `角色「${ac.name}」定妆，外观锁定：${lookEn}`,
            candidates: items,
            llmPick: ch.llmPick
          })
          await this.picker.promoteWinner({
            baseDir: this.baseDir,
            winnerRel: picked.winner.relativePath,
            finalRel: faceRel,
            rejectedRels: picked.rejected.map(r => r.relativePath),
            keepRejected: true
          })
          character.faceImagePath = faceRel
          this.log(projectId, 'casting', 'info',
            `「${ac.name}」定妆抽卡 ${candRels.length}→1：${picked.reason}`)
        }
        character.refImagePath = character.faceImagePath || ''
      } catch (e) {
        if (e instanceof ImageGenerateCancelled) throw e
        this.log(projectId, 'casting', 'warn',
          `「${ac.name}」面部定妆失败：${e instanceof Error ? e.message : String(e)}`)
      }

      try {
        const bodySeed = ch.seedMode === 'fixed' ? ch.seed : Math.floor(Math.random() * 0xffffffff)
        await this.image.generate(
          bodySheetPrompt(lookEn, { realismLock: ch.realismLock, genre }),
          path.join(this.baseDir, bodyRel),
          { width: ch.bodyWidth, height: ch.bodyHeight, seed: bodySeed, ...wfOpt, ...neg, ...genOpts }
        )
        character.bodySheetPath = bodyRel
        if (!character.refImagePath) character.refImagePath = bodyRel
      } catch (e) {
        if (e instanceof ImageGenerateCancelled) throw e
        this.log(projectId, 'casting', 'warn',
          `「${ac.name}」三视图失败：${e instanceof Error ? e.message : String(e)}`)
      }

      if (!character.faceImagePath && !character.bodySheetPath) {
        character.description = `${ac.appearance}（定妆资产生成失败）`
      }

      result.set(ac.name, character)
      doneCount++
      this.setStage(projectId, 'casting', 'running',
        `并发生成角色资产 ${doneCount}/${total}...`,
        Math.round((doneCount / Math.max(1, total)) * 100))
    }, { shouldAbort: abort })

    try {
      const project = await this.store.get(projectId)
      project.characters = [...result.values()]
      await this.store.save(project)
      this.notifyProjectUpdated(projectId)
    } catch {
      // 保存失败由后续阶段暴露
    }

    const allFailed = [...result.values()].every(c => !c.faceImagePath && !c.bodySheetPath && !c.refImagePath)
    this.setStage(projectId, 'casting',
      allFailed ? 'error' : 'done',
      allFailed
        ? '全部角色资产生成失败，请检查 ComfyUI'
        : `已建档 ${result.size} 个角色（面部+三视图，并发 ${concurrency}）`,
      allFailed ? 0 : 100)

    return result
  }

  /**
   * 道具资产生成：为分镜阶段提取的关键道具（analysis.props）逐张生成道具定妆图，
   * 存 projects/{pid}/props/xxx.png，回填 imagePath 并保存到项目。
   * 用途：渲染时作为道具参考（配合 props 提示词锁形），防"袋变绳、道具凭空消失"。
   * 失败不阻断流水线（道具图是增强项，渲染靠提示词约束兜底）。
   */
  private async buildPropAssets(projectId: string, analysis: AnalyzeResult): Promise<void> {
    const props = analysis.props || []
    if (props.length === 0) return
    const settingsSnap = await this.settings.get()
    const concurrency = Math.max(1, Math.min(3, settingsSnap.render.assetConcurrency || 2))
    const ch = resolveCreation(settingsSnap).character
    const wfOpt = ch.t2iWorkflow ? { workflowName: ch.t2iWorkflow } : {}
    const neg = { negative: sceneNegativeFor(ch.realismLock) }
    const abort = (): boolean => this.isCancelled(projectId)
    let doneCount = 0

    this.log(projectId, 'casting', 'info',
      `生成道具资产 0/${props.length}（${props.map(p => p.zh).join('、')}）...`)
    await mapPool(props, concurrency, async (prop, i) => {
      if (abort()) throw new ImageGenerateCancelled()
      const propsDir = path.join(this.baseDir, 'projects', projectId, 'props')
      const propAbs = path.join(propsDir, `${prop.id}.png`)
      const lookText = prop.description
        ? `${prop.en}, ${prop.description}`
        : `${prop.en}`
      try {
        await this.image.generate(
          `${lookText}, isolated prop asset for film production, centered on plain light-gray studio background, soft even lighting, subtle drop shadow, sharp focus, high detail, photorealistic, front three-quarter view, no person, no hands`,
          propAbs,
          { width: 768, height: 768, ...wfOpt, ...neg, shouldAbort: abort }
        )
        prop.imagePath = `projects/${projectId}/props/${prop.id}.png`
      } catch (e) {
        if (e instanceof ImageGenerateCancelled || /CANCELLED/i.test(String(e))) throw e
        this.log(projectId, 'casting', 'warn', `道具「${prop.zh}」定妆图生成失败：${e instanceof Error ? e.message : String(e)}`)
      }
      doneCount += 1
      // 进度只写日志不写阶段状态：本函数在 casting 已置 done 之后运行，
      // 打回 running 且无终态复位会让该阶段在 UI 永久转圈（S2）
      this.log(projectId, 'casting', 'info', `并发生成道具资产 ${doneCount}/${props.length}...`)
    }, { shouldAbort: abort })

    try {
      const project = await this.store.get(projectId)
      project.props = props
      await this.store.save(project)
      this.notifyProjectUpdated(projectId)
    } catch {
      // 保存失败由后续阶段暴露
    }
    const okCount = props.filter(p => p.imagePath).length
    if (okCount > 0) {
      this.log(projectId, 'casting', 'info', `道具定妆图 ${okCount}/${props.length} 生成完成（渲染锁形参考）`)
    }
  }

  /**
   * 分镜建档：先出场景板库 → 再挂板生成每镜首帧/尾帧
   * - 同场景键复用一张无人空场景板
   * - t2v：直接用场景板作为 sceneImagePath
   * - i2v：场景板氛围 + 角色锁定外观 → 首帧；中景/远景再出尾帧
   */
  /**
   * 单镜首帧生成（人物镜 i2v）——供 buildShots 建档与「重建首帧」共用：
   * 优先级：单图定妆融合（firered_i2i_edit，定妆图做底，人物 100% 锁定）
   *      → 全景双图融合（firered_i2i_two，场景方位图+定妆图，备选）
   *      → 文生兜底（带人物数量/道具强约束）→ 复制定妆图。
   * 双图融合对横版三视图定妆图参考鲁棒性差（实测镜2/3 角色/性别/服装失控、单人镜变双人），
   * 故仅作备选；单图模式输出竖版（定妆图为竖版头肩），并强制「背景替换、肢体完整」。
   */
  private async generateShotFirstFrame(
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
    // 单人居：首帧画面只允许主体角色，其他角色一律屏蔽为画外对象——
    // continuity/action 常含对戏描述（如 "Su Wan stands across the counter from crouching Lin Chuan"），
    // 名字进 prompt 模型就会画出第二个人，污染单人居画面（实测镜7/8 双人根因）。
    // 双保险：①按项目角色名屏蔽（中文名）；②按典型对戏语法剥离从句（英文名，LLM 输出用英文、项目存中文）
    const maskOtherIn = (t: string): string => {
      const others = allCharacterNames.filter(n => n && n !== d.character?.name)
      let s = t
      if (others.length) {
        const re = new RegExp(others.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
        s = s.replace(re, 'the off-screen partner (NOT visible in frame)')
      }
      // 硬门禁 v2：群像/随从词也会被画成与主体同框的第二人（实测镜1「勒马回望镖队」首帧双人根因）——
      // 队伍/随从/卫队一律改写为「画面外/背景远景剪影」，不进画面主体
      const GROUP_RE = /\b(escort team|the escort team|his escort team|the escort|escorts?|guards?|followers?|entourage|retinue|the team|his team|the party|group of escorts)\b/gi
      s = s.replace(GROUP_RE, 'distant background silhouettes of the convoy (NOT in the foreground, not a second person)')
      return stripOtherPersonClauses(s)
    }
    // 镜内场景描述：优先 continuity（含本镜起点的具体场景/站位），次选 action——
    // 防止场景板底图与镜动作场景错位；对戏角色名已屏蔽为画外对象（单人居）
    const shotSceneDesc = maskOtherIn(d.as.continuity?.trim() || d.as.action?.trim() || '')
    const plateHint = (d.board?.emptyPlatePath
      ? `matching the empty location plate mood of ${env}`
      : env) + (shotSceneDesc ? `；本镜场景：${shotSceneDesc}` : '')
    const firstRel = `projects/${projectId}/shots/${d.id}_first.png`
    const firstAbs = path.join(this.baseDir, firstRel)
    const faceAbs = d.character?.faceImagePath
      ? path.join(this.baseDir, d.character.faceImagePath)
      : ''
    // 供 build*EditPrompt 使用的净化副本：动作/连续性里对戏角色名屏蔽为画外对象，camera 剥离第二人从句
    const dMasked = {
      ...d,
      as: {
        ...d.as,
        action: maskOtherIn(d.as.action?.trim() || ''),
        continuity: maskOtherIn(d.as.continuity?.trim() || ''),
        camera: this.sanitizeCameraForFrame(d.as.camera?.trim() || '')
      }
    }

    let fusionRoot = ''
    if (faceAbs) {
      // 一级：单图定妆融合（定妆图做底，锁脸/发型/服装/肤色最稳）
      try {
        await this.image.generate(
          this.buildCloseupEditPrompt(look, plateHint, dMasked, sizeCue, 'start'),
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
        fusionRoot = e instanceof Error ? e.message : String(e)
        this.log(projectId, 'scenes', 'warn',
          `第${d.index}镜单图定妆融合失败（${fusionRoot}），尝试全景双图融合`)
        // 二级：全景双图融合（场景方位图做底 + 定妆图参考，备选）
        const panoViewRel = pickPanoView(d.as.camera, d.board?.panoViews)
        if (panoViewRel) {
          try {
            await this.image.generate(
              this.buildPanoEditPrompt(look, plateHint, dMasked, sizeCue, 'start'),
              firstAbs,
              {
                workflowName: 'qwen2511_i2i_two',
                referenceImagePaths: [path.join(this.baseDir, panoViewRel), faceAbs],
                strictWorkflow: true,
                shouldAbort: abort
              }
            )
            d.firstFramePath = firstRel
          } catch (e2) {
            if (e2 instanceof ImageGenerateCancelled) throw e2
            fusionRoot = e2 instanceof Error ? e2.message : String(e2)
            this.log(projectId, 'scenes', 'warn',
              `第${d.index}镜全景双图融合失败（${fusionRoot}）`)
          }
        }
      }
    }
    // 融合链路两级均失败（有定妆图但没产出首帧）：硬阻断——
    // block（默认）：throw 让 scenes 阶段 error 阻断流水线，不带病前进
    // （首帧丢定妆身份参考 → i2v 人物漂移）；allow：才落到下方文生兜底。
    if (!d.firstFramePath && faceAbs) {
      const fusionFallback = (await this.settings.get()).render.fusionFallback
      if (fusionFallback !== 'allow') {
        throw new Error(
          `首帧融合失败（第${d.index}镜）：${fusionRoot || '单图/双图融合均未产出首帧'}，已 halt（fusionFallback=block）；修复工作流/模型后 resume`)
      }
    }
    if (!d.firstFramePath) {
      // 三级：文生兜底（带人物数量/道具强约束）；再失败且有人物定妆图 → 复制定妆图
      try {
        // 首帧场景一致性：首帧一律以 action 起点姿态为权威（firstFrameEn 常与 action 场景/动作冲突，
        // 如"店外收伞"vs"店内递剪"——直接用 action 最稳），action 为空时回退 firstFrameEn
        const frameAction = dMasked.as.action?.trim() || dMasked.as.firstFrameEn?.trim() || ''
        await this.image.generate(
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
          {
            width: sc.frameWidth, height: sc.frameHeight, shouldAbort: abort,
            negative: mergeNegative(realismNegativeFor('standard'), frameCrowdNegativeFor(d.characterIds.length || 1))
          }
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
  async rebuildShotFirstFrames(projectId: string, shotIndexes: number[]): Promise<{ ok: boolean; text: string }> {
    const project = await this.store.get(projectId)
    const boardByKey = new Map<string, SceneBoard>()
    for (const b of project.sceneBoards || []) boardByKey.set(b.key, b)
    const sc = resolveCreation(await this.settings.get()).scene
    const abort = (): boolean => this.isCancelled(projectId)
    const targets = project.shots.filter(s => shotIndexes.includes(s.index) && s.type === 'i2v')
    if (!targets.length) return { ok: false, text: `未找到可重建首帧的 i2v 镜头：${shotIndexes.join('、')}` }
    // 该阶段可能耗时数分钟（每镜一次图生）：驱动阶段行进度条 + 日志，不能隐藏跑
    const shadow = this.ensureShadowState(projectId)
    const total = targets.length
    const pushStage = (done: number, msg: string): void => {
      shadow.stages.render = { status: 'running', message: msg, percent: Math.round((done / total) * 100) }
      this.emitProgressEvent(projectId)
    }
    pushStage(0, `重渲前重建首帧 0/${total}…`)
    this.log(projectId, 'render', 'info', `重渲前重建 ${total} 个 i2v 镜头首帧（每镜约 1 分钟）…`)
    let okCount = 0
    const failDetail: string[] = []
    let cursor = 0
    for (const shot of targets) {
      if (abort()) return { ok: false, text: '已取消' }
      cursor++
      pushStage(cursor - 1, `重建首帧 ${cursor - 1}/${total}：镜${shot.index} 生成中…`)
      this.log(projectId, 'render', 'info', `镜${shot.index} 重建首帧中（${cursor}/${total}）…`)
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
        await this.generateShotFirstFrame(projectId, d, sc, abort, project.characters.map(c => c.name))
        if (d.firstFramePath) {
          shot.firstFramePath = d.firstFramePath
          // 分镜图已更换，旧审核结论作废：不清则 reviewGate 门禁被旧标志放行（S5）
          shot.reviewed = undefined
          // 重渲前清掉旧视频产物状态，让 queue.start 重新渲染
          shot.status = 'pending'
          shot.segmentPath = ''
          okCount++
          this.log(projectId, 'render', 'success', `镜${shot.index} 首帧已重建`)
        }
      } catch (e) {
        failDetail.push(`镜${shot.index}: ${e instanceof Error ? e.message : String(e)}`)
        this.log(projectId, 'render', 'warn', `镜${shot.index} 首帧重建失败：${e instanceof Error ? e.message : String(e)}`)
      }
      pushStage(cursor, `重建首帧 ${cursor}/${total}`)
    }
    pushStage(total, `首帧重建完成 ${okCount}/${total}，渲染队列启动中…`)
    this.log(projectId, 'render', okCount === targets.length ? 'success' : 'warn',
      `首帧重建完成 ${okCount}/${targets.length}，开始入队渲染视频`)
    await this.store.save(project)
    this.notifyProjectUpdated(projectId)
    const text = failDetail.length
      ? `重建首帧：成功 ${okCount}/${targets.length}；失败 ${failDetail.join('；')}`
      : `重建首帧完成：${okCount}/${targets.length}（后续可重渲这些镜头）`
    return { ok: failDetail.length === 0, text }
  }

  /**
   * 重出角色定妆资产（face + body 三视图）：复用 casting 的提示词与写实负向，
   * 修复旧定妆图背景/肤质问题。
   * 角色 id / appearanceLock 保持不变，引用不断。重出后需重建首帧并重渲才生效。
   */
  async rerunCasting(projectId: string): Promise<{ ok: boolean; text: string }> {
    const project = await this.store.get(projectId)
    const chars = project.characters
    if (!chars.length) return { ok: false, text: '项目暂无角色，无法重出定妆' }
    const settingsSnap = await this.settings.get()
    const ch = resolveCreation(settingsSnap).character
    const wfOpt = ch.t2iWorkflow ? { workflowName: ch.t2iWorkflow } : {}
    const neg = { negative: castingNegativeFor(ch.realismLock) }
    const abort = (): boolean => this.isCancelled(projectId)
    let okCount = 0
    const failDetail: string[] = []
    const genre = project.genre
    // 硬门禁 v2：重出定妆同样过 lookEn 校验（武器单械中式）
    const hardenedLooks = hardenLookEnList(
      chars.map(c => c.appearanceLock || 'chinese person, natural everyday appearance'),
      genre
    ).looks
    for (const [ci, character] of chars.entries()) {
      const lookEn = hardenedLooks[ci] || character.appearanceLock || 'chinese person, natural everyday appearance'
      const faceRel = `projects/${projectId}/characters/${character.id}_face.png`
      const bodyRel = `projects/${projectId}/characters/${character.id}_body.png`
      try {
        await this.image.generate(
          faceCastingPrompt(lookEn, { realismLock: ch.realismLock, genre }),
          path.join(this.baseDir, faceRel),
          { width: ch.faceWidth, height: ch.faceHeight, seed: Math.floor(Math.random() * 0xffffffff), ...wfOpt, ...neg, shouldAbort: abort }
        )
        character.faceImagePath = faceRel
        character.refImagePath = character.refImagePath || faceRel
      } catch (e) {
        if (e instanceof ImageGenerateCancelled) throw e
        failDetail.push(`「${character.name}」面部：${e instanceof Error ? e.message : String(e)}`)
      }
      try {
        await this.image.generate(
          bodySheetPrompt(lookEn, { realismLock: ch.realismLock, genre }),
          path.join(this.baseDir, bodyRel),
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
    await this.store.save(project)
    this.notifyProjectUpdated(projectId)
    const text = failDetail.length
      ? `重出定妆：完成 ${okCount}/${chars.length}，失败 ${failDetail.join('；')}`
      : `重出定妆完成：${okCount} 位角色（面部+三视图已重出）`
    return { ok: failDetail.length === 0, text }
  }

  /**
   * 手动重出单个场景的全景固定场景（复用流水线同款链路）：
   * 生成 2:1 全景 → 裁 N 张竖版方位图 → 拼宫格看板 → 更新 board 字段并同步同板 t2v 分镜 sceneImagePath。
   * 场景板页「重出全景」按钮调用；非全景项目可用旧路径（SceneBoardView.generatePlate）。
   */
  async regenerateScenePano(projectId: string, boardId: string): Promise<{ ok: boolean; text: string }> {
    try {
      const project = await this.store.get(projectId)
      const board = (project.sceneBoards || []).find(b => b.id === boardId)
      if (!board) return { ok: false, text: '场景板不存在' }
      const sc = resolveCreation(await this.settings.get()).scene
      const panoViewsCount = Math.max(2, Math.min(6, sc.panoViewsCount || 4))
      const scenesDir = path.join(this.baseDir, 'projects', projectId, 'scenes')
      await fs.mkdir(scenesDir, { recursive: true })
      const panoRel = `projects/${projectId}/scenes/${board.id}_pano.png`
      const panoAbs = path.join(this.baseDir, panoRel)
      const seed = Math.floor(Math.random() * 0xffffffff)
      await this.image.generate(
        panoramaScenePrompt(board.description || board.name, undefined, { weatherHint: sc.weatherHint }),
        panoAbs,
        { width: 1536, height: 768, seed, negative: emptySceneNegativeFor('standard', board.description || board.name) }
      )
      const viewsAbs = await this.ffmpeg.cropPanoramaViews(panoAbs, scenesDir, {
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
        await this.ffmpeg.tileImages(viewsAbs, path.join(this.baseDir, gridRel), {
          cols: 2, cellW: 384, cellH: 691
        })
      } catch (e) {
        this.log(projectId, 'scenes', 'warn',
          `场景「${board.name}」宫格看板拼接失败：${e instanceof Error ? e.message : String(e)}`)
      }
      await this.store.update(projectId, (p) => {
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
      this.notifyProjectUpdated(projectId)
      return { ok: true, text: `全景场景「${board.name}」已重出（${viewsRel.length} 方位 + 宫格看板）` }
    } catch (e) {
      return { ok: false, text: `全景重出失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }

  /**
   * T2I 资产复用回退（场景板生成失败兜底）：settings.render.assetFallbackProjectId 指向的
   * 已完成项目有场景板资产时，按场景出场顺序（bi 钳到池末）复制其空场景板到本项目，
   * 保证 R2V 的场景参考与 I2V 的 plateHint 可用。纯文件复制，不触发任何文生图。
   */
  private async tryReuseSceneBoard(
    projectId: string,
    board: SceneBoard,
    bi: number
  ): Promise<string | undefined> {
    let fbId: string | undefined
    try { fbId = (await this.settings.get()).render?.assetFallbackProjectId } catch { return undefined }
    if (!fbId) return undefined
    let fb: Project
    try { fb = await this.store.get(fbId) } catch { return undefined }
    // 题材一致性门禁（2026-10-23 现代剧适配）：跨题材复用场景板（现代剧→古装空镜）直接穿帮，
    // 跳过回退走真实 T2I；资产库项目无 genre 字段也视为不可用（保守不穿帮）。
    try {
      const cur = await this.store.get(projectId)
      if (!genreCompatible(fb.genre, cur.genre)) {
        this.log(projectId, 'scenes', 'warn',
          `场景板 T2I 回退跳过：资产库项目 ${fbId} 题材(${fb.genre || '未知'}) 与本剧题材(${cur.genre || '未知'}) 不一致，禁止跨题材复用场景板`)
        return undefined
      }
    } catch { return undefined }
    const pool = (fb.sceneBoards || []).filter(b => b.emptyPlatePath)
    if (!pool.length) return undefined
    const src = pool[Math.min(Math.max(0, bi), pool.length - 1)]
    const rel = `projects/${projectId}/scenes/${board.id}_plate.png`
    try {
      await fs.mkdir(path.join(this.baseDir, 'projects', projectId, 'scenes'), { recursive: true })
      await fs.copyFile(path.join(this.baseDir, src.emptyPlatePath!), path.join(this.baseDir, rel))
      board.emptyPlatePath = rel
      board.panoViews = [rel]
      return fbId
    } catch {
      return undefined
    }
  }

  /**
   * 场景英文短语兜底：分析结果缺 sceneEn 时用 LLM 补写 30~60 词的英文环境短语，
   * 并回写到同场景所有分镜（Shot.sceneEn），供场景板/全景/首帧/尾帧提示词复用。
   * 中文场景名直接进英文提示词会被模型自由发挥（实测「男厕所」被画成雨夜户外小便所）。
   */
  private async ensureSceneEn(
    projectId: string,
    uniqueScenes: Array<{ key: string; name: string; sceneEn?: string; emotion?: string }>,
    analysis: AnalyzeResult
  ): Promise<void> {
    const missing = uniqueScenes.filter(
      u => (u.sceneEn || '').trim().split(/\s+/).filter(Boolean).length < 8
    )
    if (!missing.length) return
    for (const u of missing) {
      try {
        const peers = analysis.shots.filter(s => normalizeSceneKey(s.scene || 'unnamed') === u.key)
        const actionCtx = peers.slice(0, 3).map(s => s.action || '').filter(Boolean).join(' | ')
        const en = await this.llm.fillPromptField(
          {
            field: 'sceneEn',
            label: '环境短语（英文，驱动场景板/全景 T2I）',
            lang: 'en',
            range: [30, 60],
            role: '本镜场景的英文环境短语：先明确室内/室外（interior 或 exterior）+ 地点物理结构与陈设 + 时代特征 + 光线（时刻/主光方向/色温）+ 材质纹理 + 氛围；只写环境不写人物；室内场景严禁写成街道/户外',
            mustAvoid: ['人物', '把室内写成户外', 'Markdown', '解释性文字']
          },
          { scene: u.name, action: actionCtx, currentText: u.sceneEn || '' }
        )
        u.sceneEn = en
        this.log(projectId, 'scenes', 'info', `场景「${u.name}」英文环境短语已补写`)
      } catch (e) {
        // 补写失败不阻断：退回中文场景名，可在场景板手动重出
        this.log(projectId, 'scenes', 'warn',
          `场景「${u.name}」英文环境短语补写失败（回退中文名）：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    // 回写同场景分镜，后续重跑/重建首帧直接复用，不再重复调用 LLM
    const byKey = new Map(uniqueScenes.filter(u => u.sceneEn).map(u => [u.key, u.sceneEn!]))
    for (const as of analysis.shots) {
      const en = byKey.get(normalizeSceneKey(as.scene || 'unnamed'))
      if (en) as.sceneEn = en
    }
  }

  private async buildShots(
    projectId: string,
    analysis: AnalyzeResult,
    characterMap: Map<string, Character>
  ): Promise<void> {
    const s = await this.settings.get()
    const shots: Shot[] = []
    const total = analysis.shots.length
    let frameFailed = 0
    // D-05（2026-10-22）：首帧 mapPool 回调引用 project.characters，若 project 在回调
    // 之后才声明（原 2065 行），回调先于声明执行 → TDZ "Cannot access 'project' before
    // initialization"，所有镜头首帧生成在进入 generateShotFirstFrame 前即抛错、首帧全空，
    // i2v 武打镜随后渲染失败。提前获取并复用同一绑定，2065 行重取以保留"用最新存档"语义。
    let project = await this.store.get(projectId)

    await fs.mkdir(path.join(this.baseDir, 'projects', projectId, 'scenes'), { recursive: true })

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

    // 场景英文短语兜底（缺 sceneEn 会让英文出图提示词里混入中文 → 场景跑偏）
    await this.ensureSceneEn(projectId, uniqueScenes, analysis)

    const settingsSnap = await this.settings.get()
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
    const abort = (): boolean => this.isCancelled(projectId)
    let platesDone = 0
    this.setStage(projectId, 'scenes', 'running',
      `并发生成${panoOn ? `全景场景板（裁${panoViewsCount}方位）` : '场景板'} 0/${uniqueScenes.length}（并发 ${concurrency}${panoOn ? '' : `，抽卡×${plateCount}`}）...`, 5)

    await mapPool(uniqueScenes, concurrency, async (u, bi) => {
      if (abort()) throw new ImageGenerateCancelled()
      const boardId = `scene_${Date.now()}_${bi}_${Math.random().toString(36).slice(2, 6)}`
      const plateRel = `projects/${projectId}/scenes/${boardId}_plate.png`
      const board: SceneBoard = {
        id: boardId,
        key: u.key,
        name: u.name,
        // 英文环境短语落进场景板：场景板描述为空时全景/空景提示词只剩中文场景名
        // （实测「男厕所」被画成雨夜户外小便所），重出全景/空景必须能复用同一份描述。
        description: u.sceneEn || u.name,
        emptyPlatePath: ''
      }
      try {
        if (panoOn) {
          // —— 全景分支：生成 2:1 全景 → 裁 N 张竖版方位图 ——
          const scenesDir = path.join(this.baseDir, 'projects', projectId, 'scenes')
          const panoRel = `projects/${projectId}/scenes/${boardId}_pano.png`
          const panoAbs = path.join(this.baseDir, panoRel)
          const seed = Math.floor(Math.random() * 0xffffffff)
          await this.image.generate(
            panoramaScenePrompt(u.sceneEn || u.name, u.emotion || undefined, { weatherHint: sc.weatherHint }),
            panoAbs,
            { width: 1536, height: 768, seed, negative: emptySceneNegativeFor('standard', u.sceneEn || u.name), shouldAbort: abort }
          )
          const viewsAbs = await this.ffmpeg.cropPanoramaViews(panoAbs, scenesDir, {
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
            await this.ffmpeg.tileImages(viewsAbs, path.join(this.baseDir, gridRel), {
              cols: 2, cellW: 384, cellH: 691
            })
            board.panoGrid = gridRel
          } catch (e) {
            this.log(projectId, 'scenes', 'warn',
              `场景「${u.name}」宫格看板拼接失败：${e instanceof Error ? e.message : String(e)}`)
          }
          // emptyPlatePath 兼容：旧逻辑/UI 读取它，取前视方位图
          board.emptyPlatePath = board.panoViews[0]
          this.log(projectId, 'scenes', 'info',
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
            await this.image.generate(
              scenePlatePrompt(u.sceneEn || u.name, u.emotion || undefined, plateOpts),
              path.join(this.baseDir, rel),
              { width: sc.plateWidth, height: sc.plateHeight, seed, negative: emptySceneNegativeFor('standard', u.sceneEn || u.name), shouldAbort: abort }
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
                const st = await fs.stat(path.join(this.baseDir, c.rel))
                score = Math.min(0.95, 0.4 + Math.log10(Math.max(1000, st.size)) / 10)
                note += `；file=${Math.round(st.size / 1024)}KB`
              } catch { /* ignore */ }
              return { id: `s${i}`, relativePath: c.rel, seed: c.seed, score, note }
            }))
            const picked = await this.picker.pick({
              kind: 'scene',
              brief: `场景「${u.name}」空场景板，英文：${u.sceneEn || u.name}，情绪：${u.emotion || 'n/a'}，天气：${sc.weatherHint}`,
              candidates: items,
              llmPick: sc.llmPick
            })
            await this.picker.promoteWinner({
              baseDir: this.baseDir,
              winnerRel: picked.winner.relativePath,
              finalRel: plateRel,
              rejectedRels: picked.rejected.map(r => r.relativePath),
              keepRejected: true
            })
            board.emptyPlatePath = plateRel
            this.log(projectId, 'scenes', 'info',
              `场景「${u.name}」抽卡 ${candRels.length}→1：${picked.reason}`)
          }
        }
      } catch (e) {
        if (e instanceof ImageGenerateCancelled) throw e
        this.log(projectId, 'scenes', 'warn',
          `场景板「${u.name}」失败：${e instanceof Error ? e.message : String(e)}`)
        // —— 资产复用回退：T2I 不可用/失败时，从资产库项目按场景出场顺序复制场景板 ——
        const reusedFrom = await this.tryReuseSceneBoard(projectId, board, bi)
        if (reusedFrom) {
          this.log(projectId, 'scenes', 'warn',
            `场景「${u.name}」已从资产库项目 ${reusedFrom} 复用场景板（T2I 回退，第 ${bi + 1} 位）`)
        }
      }
      boardByKey.set(u.key, board)
      platesDone++
      this.setStage(projectId, 'scenes', 'running',
        `并发生成场景板 ${platesDone}/${uniqueScenes.length}...`,
        Math.round(5 + (platesDone / Math.max(1, uniqueScenes.length)) * 25))
    }, { shouldAbort: abort })

    try {
      const project = await this.store.get(projectId)
      project.sceneBoards = [...boardByKey.values()]
      await this.store.save(project)
      this.notifyProjectUpdated(projectId)
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
      if (as.type === 'i2v' && as.characterName) {
        character = characterMap.get(as.characterName)
        if (character) characterIds = [character.id]
      }
      return { id, index: i + 1, as, board, characterIds, character }
    })

    // —— 2a) 首帧 / 空镜参考：有限并发 ——
    let framesDone = 0
    this.setStage(projectId, 'scenes', 'running',
      `并发生成镜头首帧 0/${total}...`, 30)

    await mapPool(drafts, concurrency, async (d) => {
      if (abort()) throw new ImageGenerateCancelled()
      try {
        if (d.as.type === 't2v') {
          if (d.board?.emptyPlatePath) {
            d.sceneImagePath = d.board.emptyPlatePath
          } else {
            const frameRel = `projects/${projectId}/shots/${d.id}_scene.png`
            await this.image.generate(
              scenePlatePrompt(d.as.sceneEn || d.as.scene, d.as.emotion || undefined, plateOpts),
              path.join(this.baseDir, frameRel),
              { width: sc.plateWidth, height: sc.plateHeight, shouldAbort: abort }
            )
            d.sceneImagePath = frameRel
          }
        } else {
          // 人物镜首帧：统一走 generateShotFirstFrame（单图定妆融合优先 → 双图备选 → 文生/复制兜底）
          await this.generateShotFirstFrame(projectId, d, sc, abort, project.characters.map(c => c.name))
        }
      } catch (e) {
        if (e instanceof ImageGenerateCancelled) throw e
        frameFailed++
        this.log(projectId, 'scenes', 'warn',
          `第${d.index}镜首帧失败：${e instanceof Error ? e.message : String(e)}`)
        // 硬门禁：首帧/融合失败禁止带病前进——rethrow 让 buildShots 外层 halt scenes（fusionFallback=block）
        throw e
      }
      framesDone++
      this.setStage(projectId, 'scenes', 'running',
        `并发生成镜头首帧 ${framesDone}/${total}...`,
        Math.round(30 + (framesDone / Math.max(1, total)) * 40))
    }, { shouldAbort: abort })

    // —— 2b) 尾帧串行：按镜序承接同角色连续性 ——
    this.setStage(projectId, 'scenes', 'running', '生成连镜尾帧...', 75)
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
        await this.image.generate(
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
          path.join(this.baseDir, lastRel),
          {
            width: sc.frameWidth, height: sc.frameHeight, shouldAbort: abort,
            negative: mergeNegative(realismNegativeFor('standard'), frameCrowdNegativeFor(d.characterIds.length || 1))
          }
        )
        d.lastFramePath = lastRel
        if (d.character) prevLastByChar.set(d.character.id, lastRel)
      } catch (e) {
        if (e instanceof ImageGenerateCancelled) throw e
        frameFailed++
        this.log(projectId, 'scenes', 'warn',
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
        width: s.render.defaultWidth,
        height: s.render.defaultHeight,
        frames: s.render.defaultFrames,
        seed: Math.floor(Math.random() * 0xffffffff),
        shotSize: d.as.type === 'i2v' ? (d.as.shotSize || 'medium') : undefined,
        camera: d.as.camera || undefined,
        transition: d.as.transition === 'hard' || d.as.transition === 'dissolve' || d.as.transition === 'smash'
          ? d.as.transition
          : undefined,
        emotion: d.as.emotion || undefined,
        lighting: d.as.lighting || undefined,
        facing: d.as.facing || undefined,
        continuity: d.as.continuity || undefined,
        props: d.as.props,
        promptEn: d.as.promptEn,
        negativeEn: d.as.negativeEn,
        sceneEn: d.as.sceneEn,
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

    project = await this.store.get(projectId)
    project.sceneBoards = [...boardByKey.values()]
    project.shots = shots
    await this.store.save(project)

    const state = this.states.get(projectId)!
    state.totalShots = shots.length

    const t2vTotal = shots.filter(x => x.type === 't2v').length
    const t2vFailed = shots.filter(s => s.type === 't2v' && !s.sceneImagePath && !s.sceneBoardId).length
    const boardsOk = [...boardByKey.values()].filter(b => b.emptyPlatePath).length
    const t2vFatal = t2vTotal > 0 && t2vFailed === t2vTotal && boardsOk === 0
    this.setStage(projectId, 'scenes',
      t2vFatal ? 'error' : 'done',
      t2vFatal
        ? `场景板与首尾帧生成失败`
        : frameFailed
          ? `场景板 ${boardsOk}/${boardByKey.size}，分镜 ${shots.length}，${frameFailed} 镜帧失败已回退`
          : `场景板 ${boardsOk} 张，分镜 ${shots.length} 个（含首尾帧）`,
      100)
  }

  /**
   * closeup 首帧图生图编辑指令（FireRed Image Edit）：以定妆图为参考，
   * 只改场景/姿态/表情/构图，要求面部、发型、服装、肤色与参考图完全一致。
   * 图生图模板是"编辑指令"语义（TextEncodeQwenImageEditPlus），
   * 与文生图 prompt（shotFramePrompt）不同，不能混用。
   */
  /**
   * 首帧 prompt 的 camera 净化：剥离镜头描述里的"第二人/背景人影"从句。
   * camera 常含 "Su Wan as blurred figure out of focus at frame edge" 这类对白/配角
   * 位置描述——若原样进首帧图生 prompt，模型会画出第二个人，污染单人居画面。
   * 只保留运镜/景深/视角词（这些对静态首帧构图仍有价值）。
   */
  private sanitizeCameraForFrame(camera: string): string {
    const segs = camera.split(/[,，]/).map(s => s.trim()).filter(Boolean)
    const keep = segs.filter(s => !/(?:Su Wan|Lin Chuan|李强|苏晚|林川|another|other person|second person|background figure|blurred figure|out of focus|路人|人影|另一位|另一人|剪影)/i.test(s))
    return keep.join(', ')
  }

  private buildCloseupEditPrompt(
    lookEn: string,
    sceneHint: string,
    d: { as: { action?: string; emotion?: string; camera?: string; shotSize?: string; firstFrameEn?: string; lastFrameEn?: string; props?: string[] } },
    sizeCue: string,
    phase: 'start' | 'end' = 'start'
  ): string {
    // 分镜级首/尾帧提示词。start 首帧一律以 action 为权威（action 是 LLM 按剧情写的动作起点姿态，
    // firstFrameEn 常与 action 场景/动作冲突——如"店外收伞"vs"店内递剪"——不再优先使用）；
    // end 尾帧用 lastFrameEn（仅大幅转场镜才写）。
    const frameCue = phase === 'start'
      ? (d.as.action?.trim() || d.as.firstFrameEn?.trim())
      : (d.as.lastFrameEn?.trim() || d.as.action?.trim())
    const action = frameCue ? `，${frameCue}` : ''
    const emotion = d.as.emotion?.trim() ? `，${d.as.emotion.trim()}的表情` : ''
    const camera = d.as.camera?.trim() ? `，${this.sanitizeCameraForFrame(d.as.camera)}` : ''
    // 道具强约束：本镜关键道具必须出现在首帧画面（视频模型只会延续首帧里已有的东西——
    // 梳子/剪刀没画进首帧，视频就永远做不了"放梳/递剪"动作）。
    // props 字段缺失时兜底：通用道具句强制动作描述中的手持道具入画，不依赖 LLM 自觉
    const props = (d.as.props?.length ? d.as.props : []).join('、')
    const propLock = props
      ? `。画面中必须清晰出现本镜关键道具：${props}（手持或置于身前，不得缺失）`
      : `。动作描述中出现的手持道具必须清晰入画，置于手中或身前台面上，不得缺失`
    // 禁联想餐具/容器（实测：面馆场景氛围会诱导模型给人物端碗持筷；动作未要求的容器一律禁止）
    const tablewareBan = `。严禁出现与动作描述无关的碗、筷、勺、杯、盘、餐具、食物或任何手持容器，人物双手严格按动作描述摆放，否则双手自然下垂空置、不得持物`
    return `把图1中的人物放入场景「${sceneHint}」：${sizeCue}${action}${emotion}${camera}${propLock}${tablewareBan}。` +
      `人物按${sizeCue}景别完整入画（肢体不得截断、不裁剪），` +
      `人物姿态、视线方向、手持道具状态严格按动作描述执行（不得改为直视镜头，除非动作本就如此），` +
      `保持面部、发型、服装、肤色与图1完全一致；服装严格锁定为图1所示定妆（不得换成围裙、制服、马甲、领带、帽子、外套等任何未在定妆图中的服装）；` +
      `画面中除动作描述与关键道具外，不得出现任何其他物品、工具、容器、器械（严禁凭空添加台面杂物）；` +
      `画面中只能出现主体人物一人，严禁任何其他人物（不得有路人、第二张人脸、背景人影、镜像倒影人影、玻璃窗反射人影）；` +
      `背景完全替换为场景描述（不得保留图1原始背景、不得出现图1背景元素），` +
      `写实电影感，自然光影，背景符合场景氛围。`
  }

  /**
   * 全景双图融合提示词（firered_i2i_two 工作流：image1=场景方位图，image2=角色定妆图）：
   * 人物全部来自图2（锁脸/发型/服装/肤色），场景全部来自图1（锁空间/光线/色调/机位），
   * 二者互不干扰——这是「全景固定场景」的提示词侧落地。
   */
  private buildPanoEditPrompt(
    lookEn: string,
    sceneHint: string,
    d: { as: { action?: string; emotion?: string; camera?: string; shotSize?: string; firstFrameEn?: string; lastFrameEn?: string; props?: string[] } },
    sizeCue: string,
    phase: 'start' | 'end' = 'start'
  ): string {
    // 分镜级首/尾帧提示词。start 首帧一律以 action 为权威（同 buildCloseupEditPrompt）；
    // end 尾帧用 lastFrameEn（仅大幅转场镜才写）。
    const frameCue = phase === 'start'
      ? (d.as.action?.trim() || d.as.firstFrameEn?.trim())
      : (d.as.lastFrameEn?.trim() || d.as.action?.trim())
    const action = frameCue ? `，${frameCue}` : ''
    const emotion = d.as.emotion?.trim() ? `，${d.as.emotion.trim()}的表情` : ''
    const camera = d.as.camera?.trim() ? `，${this.sanitizeCameraForFrame(d.as.camera)}` : ''
    // 道具强约束（同 buildCloseupEditPrompt）：关键道具必须画进首帧，视频才能执行道具动作。
    // props 缺失时用通用句兜底（不列示例道具词，避免诱导模型凭空添加）
    const props = (d.as.props?.length ? d.as.props : []).join('、')
    const propLock = props
      ? `。画面中必须清晰出现本镜关键道具：${props}（手持或置于身前，不得缺失）`
      : `。动作描述中出现的手持道具必须清晰入画，置于手中或身前台面上，不得缺失`
    const tablewareBan = `。严禁出现与动作描述无关的碗、筷、勺、杯、盘、餐具、食物或任何手持容器，人物双手严格按动作描述摆放，否则双手自然下垂空置、不得持物`
    return `把图2中的人物放入图1的场景「${sceneHint}」：${sizeCue}${action}${emotion}${camera}${propLock}${tablewareBan}。` +
      `人物的面部、发型、服装、肤色与图2完全一致；服装严格锁定为图2所示定妆（不得换成围裙、制服、马甲、领带、帽子、外套等任何未在定妆图中的服装）；` +
      `人物姿态、视线方向、手持道具状态严格按动作描述执行（不得改为直视镜头，除非动作本就如此）；` +
      `画面中除动作描述与关键道具外，不得出现任何其他物品、工具、容器、器械（严禁凭空添加台面杂物）；` +
      `画面中只能出现主体人物一人，严禁任何其他人物（不得有路人、第二张人脸、背景人影、镜像倒影人影、玻璃窗反射人影）；` +
      `场景的空间布局、光线、色调、机位角度与图1完全一致（图1是该场景的全景方位图，全剧复用）；` +
      `写实电影感，自然光影，背景严格符合图1场景氛围，不得改成其他地点。`
  }

  // ===== 渲染进度转发 =====
  private subscribeRenderProgress(projectId: string): void {
    this.unsubscribeRenderProgress(projectId)
    // 从磁盘按 shot.status 重算已完成数：heal/审批重渲会重复触发 done 事件，
    // 累计 ++ 会导致 doneShots 虚增（实测 16 镜重渲 4 镜后显示 20）。
    const refreshDone = (): void => {
      void this.store.get(projectId).then(p => {
        const s = this.states.get(projectId)
        if (!s) return
        s.doneShots = p.shots.filter(x => x.status === 'done').length
        this.setStage(projectId, 'render', 'running',
          `渲染中 ${s.doneShots}/${s.totalShots}...`,
          Math.round((s.doneShots / Math.max(1, s.totalShots)) * 100))
      }).catch(() => undefined)
    }
    const listener = (e: { projectId?: string; shotId?: string; step?: string }): void => {
      if (e.projectId !== projectId) return
      const state = this.states.get(projectId)
      if (!state) return
      if (e.step === 'done') {
        this.log(projectId, 'render', 'success', `镜头 ${e.shotId} 渲染完成`)
        refreshDone()
      }
      if (e.step === 'failed') {
        this.log(projectId, 'render', 'error', `镜头 ${e.shotId} 渲染失败，跳过并继续后续镜头`)
        refreshDone()
      }
    }
    this.queue.on('progress', listener)
    this.progressUnsubs.set(projectId, () => this.queue.off('progress', listener))
  }

  private unsubscribeRenderProgress(projectId: string): void {
    this.progressUnsubs.get(projectId)?.()
    this.progressUnsubs.delete(projectId)
  }

  private finish(projectId: string, doneMessage?: string): void {
    const state = this.states.get(projectId)
    if (!state) return
    const wasCancelled = this.cancelled.has(projectId)
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
    this.pauseRequested.delete(projectId)
    this.waiters.delete(projectId)
    this.gates.delete(projectId)
    this.healBudget.delete(projectId)
    this.unsubscribeRenderProgress(projectId)
    this.log(projectId, 'done',
      state.cancelled ? 'warn' : (doneMessage ? 'error' : 'success'),
      state.cancelled ? '任务已取消' : (doneMessage || '全部完成，成片已产出'))
    // emitState 内部会按 cancelled 集合重算 state.cancelled：
    // 必须在 emitState 之后才从集合删除，否则取消标志被覆盖回 false（D1 自相矛盾）
    this.emitState(projectId)
    this.cancelled.delete(projectId)
    // 日志序号器不随 finish 清理：state.logs 已持久化，续跑/影子渲染还要续写，
    // 删除会让新日志 id 从 1 重计与历史冲突（D2）。改由 evictFinishedStates 随 state 一起清理
    // （hydrate 会从磁盘日志 maxId 重建序号器，无冲突）。
    // lastStageMsg 的 key 形如 `${projectId}:${stage}`，按前缀清理
    for (const key of [...this.lastStageMsg.keys()]) {
      if (key.startsWith(`${projectId}:`)) this.lastStageMsg.delete(key)
    }
    this.evictFinishedStates()
  }

  /**
   * 淘汰已完成超过 1 小时的任务状态，防止长跑内存膨胀。
   * 运行中的项目不受影响。
   */
  private evictFinishedStates(): void {
    const cutoff = Date.now() - 60 * 60 * 1000
    for (const [pid, st] of this.states) {
      if (!st.running && st.finishedAt && st.finishedAt < cutoff) {
        this.states.delete(pid)
        // 序号器随 state 一起淘汰（重启 hydrate 会从磁盘日志 maxId 重建）
        this.logSeq.delete(pid)
      }
    }
  }

  /**
   * 提示式渲染（非阻塞）：逐镜渲染，渲完一镜立即进下一镜。
   * - 每镜渲染完成只做秒级技术审核（产物存在/时长≥0.8s/非黑帧/一致性分）+ 留痕 auditHint
   * - LLM 视觉审核延后到用户逐镜查看时；不做阻塞式整改重渲（省时省算力）
   * - 渲染失败镜跳过（交给 runPipeline 的 C 自愈统一处理）
   * - 全部渲染完成后由调用方检查 auditHint/失败镜：有提示则暂停不进剪辑，用户整改后手动继续
   */
  private async renderShotsWithAudit(projectId: string, shotDurations: Map<string, number>): Promise<void> {
    const checklist = await this.skills.auditChecklist()
    this.subscribeRenderProgress(projectId)
    try {
      const project = await this.store.get(projectId)
      const targets = project.shots.filter(s => s.status === 'pending' || s.status === 'failed')
      const total = targets.length
      let doneCount = 0
      let notPassed = 0
      for (const shot of targets) {
        if (this.isCancelled(projectId)) break
        // 提示式：渲完一镜立即进下一镜，不做阻塞式审核/整改重渲（省时省算力）
        await this.queue.start(projectId, [shot.id])
        await this.queue.waitForFinish(projectId)

        const fresh = await this.store.get(projectId)
        const cur = fresh.shots.find(s => s.id === shot.id)
        if (!cur || cur.status !== 'done') continue // 渲染失败，交给 C 自愈

        // 秒级技术审核（文件/时长/黑帧/一致性分）+ 留痕；LLM 视觉审核延后到用户逐镜查看
        try {
          const audit = await this.auditSingleShot(projectId, cur, fresh, checklist, true)
          if (audit.durationSec >= 0) shotDurations.set(cur.id, audit.durationSec)
          cur.auditHint = audit.passed
            ? undefined
            : `${audit.reason}${audit.fixHint ? '；建议：' + audit.fixHint : ''}`
          if (!audit.passed) notPassed++
          await this.store.save(fresh)
          this.notifyProjectUpdated(projectId)
          this.log(projectId, 'render', audit.passed ? 'info' : 'warn',
            audit.passed
              ? `第${cur.index}镜「${cur.scene}」渲染完成`
              : `第${cur.index}镜「${cur.scene}」渲染完成但有提示：${audit.reason}（可在分镜页编辑重渲）`)
        } catch (e) {
          this.log(projectId, 'render', 'warn',
            `第${cur.index}镜审核留痕失败：${e instanceof Error ? e.message : String(e)}`)
        }
        doneCount++
        this.setStage(projectId, 'render', 'running',
          `渲染 ${doneCount}/${total}...`, Math.round((doneCount / Math.max(1, total)) * 100))
      }
      if (notPassed > 0) {
        this.log(projectId, 'render', 'warn', `本轮共 ${notPassed} 镜次未过审（含整改后放行），已在分镜页留痕`)
      }
    } finally {
      this.unsubscribeRenderProgress(projectId)
    }
  }

  /**
   * 单镜即时审核（看守）：
   * 1) 技术：产物存在、时长≥0.8s、非纯色/黑帧
   * 2) 一致性：i2v 且 consistencyMode=rerender 时，低分算未过审
   * 3) LLM 视觉：按技能库审核清单逐条判；模型不支持视觉时降级为仅技术
   */
  private async auditSingleShot(
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
      ? path.join(this.baseDir, shot.segmentPath)
      : shot.rawVideoPath
        ? path.join(this.baseDir, shot.rawVideoPath)
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
    let dur = 0
    try {
      dur = await this.ffmpeg.getDuration(abs)
    } catch {
      return { passed: false, reason: '视频信息读取失败', fixHint: undefined, durationSec: -1, vision: false }
    }
    if (dur < 0.8) {
      return { passed: false, reason: `时长过短（${dur.toFixed(1)}s）`, fixHint: undefined, durationSec: dur, vision: false }
    }
    if (await this.ffmpeg.looksLikeBlankVideo(abs)) {
      return { passed: false, reason: '画面疑似纯色/黑帧', fixHint: undefined, durationSec: dur, vision: false }
    }

    // 一致性：rerender 模式下低分算未过审
    const consistencyMode = (await this.settings.get()).render.consistencyMode || 'warn'
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
    const audit = await this.llm.auditImage({
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
      if (!this.visionWarned.has(projectId)) {
        this.visionWarned.add(projectId)
        this.log(projectId, 'render', 'warn',
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
  private async approveShots(projectId: string): Promise<{
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
      const project = await this.store.get(projectId)
      for (const shot of project.shots) {
        if (shot.status !== 'done' || !shot.segmentPath) continue
        const abs = path.join(this.baseDir, shot.segmentPath)
        if (!(await this.ffmpeg.fileExists(abs))) {
          problems.set(shot.id, `第${shot.index}镜「${shot.scene}」分段文件缺失`)
          continue
        }
        try {
          const info = await this.ffmpeg.getVideoInfo(abs)
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
            this.log(
              projectId, 'render', 'warn',
              `第${shot.index}镜「${shot.scene}」时长 ${dur.toFixed(1)}s（设定 ${expectSec}s），已放行`
            )
          }
        } catch {
          problems.set(shot.id, `第${shot.index}镜「${shot.scene}」视频信息读取失败`)
          continue
        }
        if (await this.ffmpeg.looksLikeBlankVideo(abs)) {
          problems.set(shot.id, `第${shot.index}镜「${shot.scene}」画面疑似纯色/黑帧`)
          continue
        }
        // 2026-10-25 移植（专家B P1）：角色混淆硬判——渲染侧 taskQueueConsistency
        // 交叉比对各角色定妆后回填 shot.roleConfusion；此前该约束只在 directorStage 死代码里，
        // live 审批零消费。角色混淆=结构性穿帮（A 的脸更像 B 的定妆），任何 consistencyMode 都拦，
        // 由换 seed 重渲轮或剪辑台剔除处理（不混入成片）。
        if (shot.roleConfusion) {
          problems.set(shot.id, `第${shot.index}镜「${shot.scene}」角色混淆（脸部更像另一角色定妆），已拦下不混入成片`)
          continue
        }
      }
      return { problems, durations }
    }

    const consistencyMode = (await this.settings.get()).render.consistencyMode || 'warn'
    // 一致性低分只告警不阻断（P0-2）：ArcFace 对"定妆证件照 vs 表情帧"的姿态差会误杀同人，
    // 阻断会让整条流水线死锁（实测重渲救不回 0.2x 分）。结构性硬问题仍严格阻断。
    const warnings = new Set<string>()
    const inspectWithConsistency = async () => {
      const base = await inspect()
      if (consistencyMode !== 'rerender') return base
      const project = await this.store.get(projectId)
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
    this.setStage(projectId, 'render', 'running',
      `${retryIds.length} 镜未过审（${[...problems.values()][0]}...），换种子重渲中...`, 92)
    const project = await this.store.get(projectId)
    for (const shot of project.shots) {
      if (retryIds.includes(shot.id)) {
        shot.seed = Math.floor(Math.random() * 0xffffffff)
      }
    }
    await this.store.save(project)
    // 重渲窗口必须挂流水线进度监听（D3）：否则 progress 事件落入影子通道，
    // onExternalProgress 对已完成的镜头再次 doneShots++ 造成计数虚增
    this.subscribeRenderProgress(projectId)
    try {
      await this.queue.start(projectId, retryIds)
      await this.queue.waitForFinish(projectId)
    } catch {
      // 结果由复检判定
    } finally {
      this.unsubscribeRenderProgress(projectId)
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
}
