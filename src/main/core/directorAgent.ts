import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { LLMService } from './llmService'
import { ImageService } from './imageService'
import { TaskQueue } from './taskQueue'
import { FFmpegService } from './ffmpegService'
import { SubtitleService } from './subtitleService'
import { ProjectStore } from './projectStore'
import { SettingsStore } from './settingsStore'
import type {
  DirectorState, DirectorStage, StageState, StageStatus,
  DirectorStartInput, DirectorLogEntry, AnalyzeResult, Character, Shot
} from '../../shared/ipcTypes'

const STAGE_ORDER: DirectorStage[] = [
  'analyze', 'casting', 'scenes', 'render',
  'combine', 'subtitle', 'review', 'bgm', 'done'
]

const STAGE_LABELS: Record<DirectorStage, string> = {
  analyze: '剧本分析',
  casting: '角色建档',
  scenes: '场景图生成',
  render: '逐镜渲染 · 审批',
  combine: '拼接成片',
  subtitle: '烧录字幕',
  review: '成片复审',
  bgm: 'BGM 混音',
  done: '完成'
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
  private static readonly LOG_LIMIT = 300

  constructor(
    private baseDir: string,
    private store: ProjectStore,
    private llm: LLMService,
    private image: ImageService,
    private queue: TaskQueue,
    private ffmpeg: FFmpegService,
    private subtitles: SubtitleService,
    private settings: SettingsStore
  ) {
    super()
  }

  static get STAGE_LABELS(): Record<DirectorStage, string> {
    return STAGE_LABELS
  }

  /** 启动全流程，返回 projectId */
  async start(input: DirectorStartInput): Promise<string> {
    const project = await this.store.create(input.title, input.genre)
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

  getState(projectId: string): DirectorState | null {
    return this.states.get(projectId) || null
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
      if (state.running || state.paused) {
        state.running = false
        state.paused = false
        // 续用日志序号器：从磁盘日志的最大 id 起算，保证唯一
        const maxId = state.logs.reduce((m, l) => Math.max(m, typeof l.id === 'number' ? l.id : 0), 0)
        const seq = Math.max(this.logSeq.get(projectId) || 0, maxId) + 1
        this.logSeq.set(projectId, seq)
        state.logs.push({
          id: seq,
          stage: 'done',
          level: 'warn',
          message: '应用重启，上次任务已中断（渲染产物保留，可重渲续跑）',
          timestamp: Date.now()
        })
      }
      this.states.set(projectId, state)
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
    await fs.writeFile(file, JSON.stringify(state, null, 2))
  }

  // ===== 流水线 =====

  private async runPipeline(projectId: string, input: DirectorStartInput): Promise<void> {
    let analysis: AnalyzeResult | null = null
    this.log(projectId, 'analyze', 'info',
      `任务开始：《${input.title}》（${input.genre}），共设 ${this.gates.get(projectId)?.size || 0} 个阶段确认点`)

    // ① 剧本分析
    this.setStage(projectId, 'analyze', 'running', 'AI 阅读剧本，识别角色与分镜...', 10)
    try {
      analysis = await this.llm.analyze(input.script, input.genre)
      const warnCount = analysis.warnings?.length || 0
      this.setStage(
        projectId, 'analyze',
        warnCount > 0 ? 'error' : 'done',
        `角色：${analysis.characters.map(c => c.name).join('、')}；${analysis.shots.length} 个分镜` +
          (warnCount > 0
            ? `；${warnCount} 处归属异常：${analysis.warnings!.join('；')}`
            : ''),
        100
      )
    } catch (e) {
      this.setStage(projectId, 'analyze', 'error',
        `分析失败: ${e instanceof Error ? e.message : String(e)}`, 0)
      this.finish(projectId)
      return
    }

    await this.maybeGate(projectId, 'analyze')
    if (this.isCancelled(projectId)) { this.finish(projectId); return }

    // ② 角色建档 + AI 定妆图
    const characterMap = await this.buildCharacters(projectId, analysis)
    await this.maybeGate(projectId, 'casting')
    if (this.isCancelled(projectId)) { this.finish(projectId); return }

    // ③ 分镜建档 + 空镜场景图
    await this.buildShots(projectId, analysis, characterMap)
    await this.maybeGate(projectId, 'scenes')
    if (this.isCancelled(projectId)) { this.finish(projectId); return }

    const state = this.states.get(projectId)!
    if (state.totalShots === 0) {
      this.setStage(projectId, 'render', 'error', '没有可渲染的分镜', 0)
      this.finish(projectId)
      return
    }

    // ④ 逐镜渲染（TTS 在队列内完成；遇错继续）
    this.subscribeRenderProgress(projectId)
    this.setStage(projectId, 'render', 'running',
      `渲染中 0/${state.totalShots}...`, 0)
    try {
      await this.queue.start(projectId)
      await this.queue.waitForFinish(projectId)
    } catch (e) {
      this.setStage(projectId, 'render', 'error',
        `渲染队列异常: ${e instanceof Error ? e.message : String(e)}`, 0)
    }
    this.unsubscribeRenderProgress(projectId)

    let rendered = await this.store.get(projectId)
    let doneShots = rendered.shots.filter(s => s.status === 'done')
    state.doneShots = doneShots.length
    state.failedShotIds = rendered.shots
      .filter(s => s.status === 'failed')
      .map(s => s.id)

    if (this.isCancelled(projectId)) {
      this.setStage(projectId, 'render', 'skipped', '已取消')
      this.finish(projectId)
      return
    }

    if (doneShots.length === 0) {
      this.setStage(projectId, 'render', 'error', '全部镜头渲染失败', 0)
      this.finish(projectId)
      return
    }

    this.setStage(projectId, 'render', 'done',
      `完成 ${doneShots.length}/${state.totalShots}` +
      (state.failedShotIds.length ? `，${state.failedShotIds.length} 镜失败` : ''), 100)

    // ④+ 逐镜审批：技术质检全部通过才允许剪辑（严格关卡）
    const approval = await this.approveShots(projectId)
    if (!approval.approved) {
      state.failedShotIds = [...new Set([...state.failedShotIds, ...approval.retryIds])]
      this.setStage(projectId, 'render', 'error',
        `${approval.problems.length} 镜未过审，已停止剪辑：${approval.problems.slice(0, 3).join('；')}` +
          (approval.problems.length > 3 ? '等' : ''),
        Math.round((doneShots.length / Math.max(1, state.totalShots)) * 100))
      this.finish(projectId, '逐镜审批未通过，未进入剪辑；请在分镜编辑处理后重新发起')
      return
    }

    await this.maybeGate(projectId, 'render')
    if (this.isCancelled(projectId)) { this.finish(projectId); return }

    // 审批后刷新（重渲镜头状态可能变化）
    rendered = await this.store.get(projectId)
    doneShots = rendered.shots.filter(s => s.status === 'done' && s.segmentPath)
    state.doneShots = doneShots.length

    // ⑤ 拼接成片（仅过审镜头，按分镜顺序）
    const includedIds = doneShots.map(s => s.id)
    let currentVideo = `projects/${projectId}/final.mp4`
    this.setStage(projectId, 'combine', 'running', '拼接成功分镜...', 20)
    try {
      await this.ffmpeg.concatSegments(
        includedIds.map(id =>
          path.join(this.baseDir, doneShots.find(s => s.id === id)!.segmentPath!)
        ),
        path.join(this.baseDir, currentVideo)
      )
      this.setStage(projectId, 'combine', 'done',
        state.failedShotIds.length
          ? `已拼接 ${doneShots.length} 镜（跳过失败镜头）`
          : `已拼接 ${doneShots.length} 镜`, 100)
    } catch (e) {
      this.setStage(projectId, 'combine', 'error',
        `拼接失败: ${e instanceof Error ? e.message : String(e)}`, 0)
      this.finish(projectId)
      return
    }

    await this.maybeGate(projectId, 'combine')
    if (this.isCancelled(projectId)) { this.finish(projectId); return }

    // ⑥ 烧录字幕（时间轴只含参与拼接的镜头）
    this.setStage(projectId, 'subtitle', 'running', '生成字幕并烧录...', 20)
    try {
      const srtRel = await this.subtitles.generate(rendered, includedIds)
      const out = `projects/${projectId}/final_subtitled.mp4`
      await this.ffmpeg.burnSubtitles(
        path.join(this.baseDir, currentVideo),
        path.join(this.baseDir, srtRel),
        path.join(this.baseDir, out)
      )
      currentVideo = out
      this.setStage(projectId, 'subtitle', 'done', '字幕已烧录', 100)
    } catch (e) {
      // 字幕失败不阻断：继续用无字幕成片做 BGM
      this.setStage(projectId, 'subtitle', 'error',
        `字幕失败（保留无字幕版）: ${e instanceof Error ? e.message : String(e)}`, 0)
    }

    await this.maybeGate(projectId, 'subtitle')
    if (this.isCancelled(projectId)) { this.finish(projectId); return }

    // ⑥+ 成片复审：音画技术校验 + AI 审片（剧情完整性/台词相符），通过才允许配 BGM
    this.setStage(projectId, 'review', 'running', '复审：音画技术校验...', 15)
    try {
      const issues: string[] = []

      // 技术面：成片必须有音轨、时长合理、与各分段累计一致
      const finalInfo = await this.ffmpeg.getVideoInfo(path.join(this.baseDir, currentVideo))
      if (!finalInfo.hasAudio) issues.push('成片缺少音轨')
      if (finalInfo.durationSec < 3) {
        issues.push(`成片时长异常（仅 ${finalInfo.durationSec.toFixed(1)}s）`)
      } else {
        let sumSeg = 0
        for (const s of doneShots) {
          sumSeg += (await this.ffmpeg.getVideoInfo(path.join(this.baseDir, s.segmentPath!))).durationSec
        }
        if (Math.abs(sumSeg - finalInfo.durationSec) > Math.max(2, sumSeg * 0.1)) {
          issues.push(
            `成片时长 ${finalInfo.durationSec.toFixed(1)}s 与分段累计 ${sumSeg.toFixed(1)}s 不符，可能拼接丢段`
          )
        }
      }

      // 剧情面：AI 审片（叙事完整/镜头衔接/台词与剧情相符/音画匹配）
      this.setStage(projectId, 'review', 'running', '复审：AI 审片（剧情完整性 · 台词相符 · 音画匹配）...', 55)
      const review = await this.llm.reviewStory({
        title: input.title,
        logline: analysis?.logline || '',
        genre: input.genre,
        shots: doneShots.map(s => ({
          index: s.index,
          scene: s.scene,
          character: s.characterIds.length
            ? (rendered.characters.find(c => c.id === s.characterIds[0])?.name || '')
            : '',
          dialogue: s.dialogue,
          durationSec: approval.durations.get(s.id) || 0
        }))
      })
      issues.push(...review.issues)

      if (issues.length === 0) {
        this.setStage(projectId, 'review', 'done',
          `复审通过${review.summary ? `：${review.summary}` : ''}`, 100)
      } else {
        state.reviewIssues = issues
        this.setStage(projectId, 'review', 'error',
          `复审未通过（${issues.length} 项）：${issues.slice(0, 3).join('；')}` +
            (issues.length > 3 ? '等' : '') + '；已停止，不配置 BGM',
          100)
        this.finish(projectId, '复审未通过，未出片；请按复审意见调整后重新发起')
        return
      }
    } catch (e) {
      this.setStage(projectId, 'review', 'error',
        `复审异常: ${e instanceof Error ? e.message : String(e)}`, 0)
      this.finish(projectId, '复审异常，未出片')
      return
    }

    await this.maybeGate(projectId, 'review')
    if (this.isCancelled(projectId)) { this.finish(projectId); return }

    // ⑦ BGM 混音（最后一步：复审通过后才配乐出片）
    if (input.bgmAbsolutePath) {
      this.setStage(projectId, 'bgm', 'running', '导入 BGM 并混音...', 20)
      try {
        const ext = path.extname(input.bgmAbsolutePath) || '.mp3'
        const bgmRel = `projects/${projectId}/bgm${ext}`
        await fs.copyFile(
          input.bgmAbsolutePath,
          path.join(this.baseDir, bgmRel)
        )
        const finalOut = `projects/${projectId}/final_master.mp4`
        await this.ffmpeg.mixBgm(
          path.join(this.baseDir, currentVideo),
          path.join(this.baseDir, bgmRel),
          path.join(this.baseDir, finalOut),
          20
        )
        currentVideo = finalOut
        this.setStage(projectId, 'bgm', 'done', 'BGM 混音完成', 100)
      } catch (e) {
        this.setStage(projectId, 'bgm', 'error',
          `BGM 失败: ${e instanceof Error ? e.message : String(e)}`, 0)
      }
    } else {
      this.setStage(projectId, 'bgm', 'skipped', '未提供 BGM', 0)
    }

    state.finalPath = currentVideo
    this.finish(projectId)
  }

  /** 角色建档：逐个生成定妆图；单角色失败不阻断 */
  private async buildCharacters(
    projectId: string,
    analysis: AnalyzeResult
  ): Promise<Map<string, Character>> {
    const result = new Map<string, Character>()
    let femaleIdx = 0
    let maleIdx = 0
    let index = 0

    this.setStage(projectId, 'casting', 'running',
      `生成角色定妆图 0/${analysis.characters.length}...`, 5)

    for (const ac of analysis.characters) {
      const id = `char_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      const voice = ac.gender === 'male'
        ? MALE_VOICES[maleIdx++ % MALE_VOICES.length]
        : FEMALE_VOICES[femaleIdx++ % FEMALE_VOICES.length]

      const character: Character = {
        id,
        name: ac.name,
        refImagePath: '',
        description: ac.appearance,
        voice
      }

      const portraitRel = `projects/${projectId}/characters/${id}.png`
      this.setStage(projectId, 'casting', 'running',
        `生成「${ac.name}」定妆图 (${index + 1}/${analysis.characters.length})...`,
        Math.round((index / analysis.characters.length) * 100))

      try {
        // 兜底：lookEn 未指定人种时补 chinese，避免文生图默认西方面孔
        const lookEn = /chinese|asian/i.test(ac.lookEn) ? ac.lookEn : `chinese, ${ac.lookEn}`
        // 角色卡锁定短语随角色持久化：首帧图/后续重生成都逐字复用这一份，不再依赖拆镜内存态
        character.appearanceLock = lookEn
        await this.image.generate(
          `cinematic half-body portrait photo, film still, ${lookEn}, upper body, detailed face, soft cinematic lighting, high detail, 8k`,
          path.join(this.baseDir, portraitRel),
          { width: 512, height: 768 }
        )
        character.refImagePath = portraitRel
      } catch (e) {
        // 定妆图失败：保留角色但无图（渲染该角色镜头时会被队列拦截并计入失败汇总）
        character.description = `${ac.appearance}（定妆图生成失败）`
        // 即使定妆图失败也保留锁定短语，首帧图生成仍可用它锚定外观
        const lookEn = /chinese|asian/i.test(ac.lookEn) ? ac.lookEn : `chinese, ${ac.lookEn}`
        character.appearanceLock = lookEn
      }

      result.set(ac.name, character)
      index++
    }

    try {
      const project = await this.store.get(projectId)
      project.characters = [...result.values()]
      await this.store.save(project)
    } catch {
      // 保存失败由后续阶段暴露
    }

    const allFailed = [...result.values()].every(c => !c.refImagePath)
    this.setStage(projectId, 'casting',
      allFailed ? 'error' : 'done',
      allFailed
        ? '全部定妆图生成失败，请检查 ComfyUI'
        : `已建档 ${result.size} 个角色`,
      allFailed ? 0 : 100)

    return result
  }

  /**
   * 分镜建档 + 每镜首帧图：
   * - t2v：纯场景竖版图（图生视频的首帧）
   * - i2v：带角色外观 + 场景 + 景别 + 姿态的专用首帧（解决"拿定妆照演大动作/场景漂移"）
   * 单镜首帧失败不阻断（i2v 渲染时回退角色定妆照，t2v 会被队列拦截并计入失败汇总）
   */
  private async buildShots(
    projectId: string,
    analysis: AnalyzeResult,
    characterMap: Map<string, Character>
  ): Promise<void> {
    const s = await this.settings.get()
    const shots: Shot[] = []
    const total = analysis.shots.length
    let imgIdx = 0
    let frameFailed = 0

    this.setStage(projectId, 'scenes', 'running', `生成镜头首帧 0/${total}...`, 5)

    // 角色外观锁定短语直接取自已持久化的角色卡（character.appearanceLock），
    // 保证项目重开/首帧重生时仍逐字复用同一份，杜绝跨镜改写外观
    const shotSizeCue: Record<string, string> = {
      closeup: 'extreme close-up shot, tight framing on face or hands, shallow depth of field',
      medium: 'medium shot, upper body framing',
      wide: 'wide shot, full body in environment'
    }

    // 正式建档（顺序 await 首帧图生成）
    for (let i = 0; i < analysis.shots.length; i++) {
      const as = analysis.shots[i]
      const id = `shot_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`

      let characterIds: string[] = []
      let character: Character | undefined
      if (as.type === 'i2v' && as.characterName) {
        character = characterMap.get(as.characterName)
        if (character) characterIds = [character.id]
      }

      let sceneImagePath: string | undefined
      let firstFramePath: string | undefined

      const frameRel = `projects/${projectId}/shots/${id}_${as.type === 't2v' ? 'scene' : 'frame'}.png`
      this.setStage(projectId, 'scenes', 'running',
        `生成镜头首帧 (${imgIdx + 1}/${total})...`,
        Math.round((imgIdx / Math.max(1, total)) * 100))

      try {
        if (as.type === 't2v') {
          // 空镜：竖版纯场景，无人物；emotion 五元组作为氛围词
          const mood = as.emotion ? `${as.emotion} atmosphere, ` : ''
          await this.image.generate(
            `cinematic vertical film still, ${as.sceneEn || as.scene}, ${mood}empty scene, no people, atmospheric, detailed environment, cinematic lighting, high detail, 8k`,
            path.join(this.baseDir, frameRel),
            { width: 512, height: 768 }
          )
          sceneImagePath = frameRel
        } else {
          // 人物镜：角色卡锁定外观 + 环境 + 景别 + 该镜动作姿态，合成专用首帧
          // （外观短语逐字来自角色卡，动作/环境才允许每镜不同——身份在参考，动作在 prompt）
          const look = character?.appearanceLock || 'attractive chinese person'
          const sizeCue = shotSizeCue[as.shotSize || 'medium']
          const env = as.sceneEn || as.scene
          // 情绪注入表情/氛围（emotion 为英文短语，由拆镜五元组给出）
          const emotionCue = as.emotion ? `${as.emotion} expression, moody emotional performance, ` : ''
          await this.image.generate(
            `cinematic vertical movie still frame, ${sizeCue}, ${look}, ${env}, ${emotionCue}${as.action}, single person only, no other faces, film grain, cinematic lighting, high detail, 8k`,
            path.join(this.baseDir, frameRel),
            { width: 512, height: 768 }
          )
          firstFramePath = frameRel
        }
      } catch {
        frameFailed++
        // 首帧失败：i2v 回退定妆照；t2v 渲染时会被队列拦截
      }
      imgIdx++

      shots.push({
        id,
        index: i + 1,
        scene: as.scene,
        action: as.action,
        dialogue: as.dialogue,
        characterIds,
        type: as.type,
        width: s.render.defaultWidth,
        height: s.render.defaultHeight,
        frames: s.render.defaultFrames,
        seed: Math.floor(Math.random() * 0xffffffff),
        shotSize: as.type === 'i2v' ? (as.shotSize || 'medium') : undefined,
        camera: as.camera || undefined,
        emotion: as.emotion || undefined,
        sceneImagePath,
        firstFramePath,
        status: 'pending'
      })
    }

    const project = await this.store.get(projectId)
    project.shots = shots
    await this.store.save(project)

    const state = this.states.get(projectId)!
    state.totalShots = shots.length

    // 空镜首帧全失败才判阶段失败（人物镜有定妆照兜底）
    const t2vTotal = shots.filter(x => x.type === 't2v').length
    const t2vFailed = shots.filter(s => s.type === 't2v' && !s.sceneImagePath).length
    const t2vFatal = t2vTotal > 0 && t2vFailed === t2vTotal
    this.setStage(projectId, 'scenes',
      t2vFatal ? 'error' : 'done',
      t2vFatal
        ? `已建档 ${shots.length} 个分镜，${t2vFailed} 张空镜首帧失败`
        : frameFailed
          ? `已建档 ${shots.length} 个分镜，${frameFailed} 张首帧失败已回退`
          : `已建档 ${shots.length} 个分镜`,
      100)
  }

  // ===== 渲染进度转发 =====

  private subscribeRenderProgress(projectId: string): void {
    this.unsubscribeRenderProgress(projectId)
    const listener = (e: { projectId?: string; shotId?: string; step?: string }): void => {
      if (e.projectId !== projectId) return
      const state = this.states.get(projectId)
      if (!state) return
      if (e.step === 'done') {
        state.doneShots++
        this.log(projectId, 'render', 'success', `镜头 ${e.shotId} 渲染完成`)
      }
      if (e.step === 'failed') {
        this.log(projectId, 'render', 'error', `镜头 ${e.shotId} 渲染失败，跳过并继续后续镜头`)
      }
      if (e.step === 'done' || e.step === 'failed') {
        this.setStage(projectId, 'render', 'running',
          `渲染中 ${state.doneShots}/${state.totalShots}...`,
          Math.round((state.doneShots / state.totalShots) * 100))
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
    state.running = false
    state.paused = false
    state.cancelled = this.cancelled.has(projectId)
    state.stages.done = {
      status: state.cancelled ? 'skipped' : 'done',
      message: doneMessage
        || (state.finalPath
          ? `成片: ${state.finalPath}`
          : state.cancelled ? '已取消' : '未产出成片'),
      percent: 100
    }
    state.finishedAt = Date.now()
    this.cancelled.delete(projectId)
    this.pauseRequested.delete(projectId)
    this.waiters.delete(projectId)
    this.gates.delete(projectId)
    this.unsubscribeRenderProgress(projectId)
    this.log(projectId, 'done',
      state.cancelled ? 'warn' : (doneMessage ? 'error' : 'success'),
      state.cancelled ? '任务已取消' : (doneMessage || '全部完成，成片已产出'))
    this.emitState(projectId)
    // 日志发完再清理序号器（避免最终日志 id 与历史冲突）
    this.logSeq.delete(projectId)
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
      }
    }
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
          durations.set(shot.id, Math.round(info.durationSec * 10) / 10)
          if (!info.hasAudio) {
            problems.set(shot.id, `第${shot.index}镜「${shot.scene}」无音轨`)
            continue
          }
          // segment = 画面 + 音频定格补齐：时长应 ≥ 画面设定，超太多说明台词与画面严重不配
          const expectSec = Math.max(1, Math.round((shot.frames - 1) / 16))
          if (info.durationSec < expectSec - 0.5 || info.durationSec > expectSec + 5) {
            problems.set(
              shot.id,
              `第${shot.index}镜「${shot.scene}」时长 ${info.durationSec.toFixed(1)}s 与画面设定 ${expectSec}s 不匹配`
            )
            continue
          }
        } catch {
          problems.set(shot.id, `第${shot.index}镜「${shot.scene}」视频信息读取失败`)
          continue
        }
        if (await this.ffmpeg.looksLikeBlankVideo(abs)) {
          problems.set(shot.id, `第${shot.index}镜「${shot.scene}」画面疑似纯色/黑帧`)
        }
      }
      return { problems, durations }
    }

    let { problems, durations } = await inspect()
    if (problems.size === 0) {
      return { approved: true, problems: [], retryIds: [], durations }
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
    try {
      await this.queue.start(projectId, retryIds)
      await this.queue.waitForFinish(projectId)
    } catch {
      // 结果由复检判定
    }

    const recheck = await inspect()
    problems = recheck.problems
    durations = recheck.durations
    return {
      approved: problems.size === 0,
      problems: [...problems.values()],
      retryIds,
      durations
    }
  }
}
