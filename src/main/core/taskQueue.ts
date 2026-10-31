﻿import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { ComfyUIClient, VRAM_TIERS, stepDownVramTier, type VramTier } from './comfyuiClient'
import { WorkflowLoader } from './workflowLoader'
import { TTSService } from './ttsService'
import { FFmpegService } from './ffmpegService'
import { ProjectStore } from './projectStore'
import { SettingsStore } from './settingsStore'
import { LipSyncService } from './lipSyncService'
import { ConsistencyService, type LoadedRgb, type ConsistencyResult } from './consistencyService'
import { isTransientError, isOomError, classifyError } from './errorClassify'
import { GENRE_TEMPLATES, SHOT_TIMING, type Project, type Shot, type ProgressEvent } from '../../shared/ipcTypes'
import {
  videoMotionPrompt, cleanAction, identityLockBlock, CINEMATIC_QUALITY_BLOCK, videoNegativeFor,
  oocWardrobeNegativeFor, mergeNegative, sanitizeCinematicPrompt, stripOocWardrobe,
  stripOtherPersonClauses, timelineProtocolBlock, DISPLACEMENT_ACTION_RE, faceExpressionLockFor,
  castPromptPoisoned, repairCastText, periodLockFor, motionCueFromAction, scrubSummoningTerms,
  negativeForSlot, keepDialogueChinese, WAN_QUALITY_NEGATIVE, ageDriftNegativeFor,
  isPlaybackOrVoiceoverAction
} from '../../shared/imagePrompts'
import { resolveCreation } from '../../shared/creationSettings'
import { orientVideoSize } from '../../shared/pipelineGuards'
import { assertMediaPath } from './assetPathGuard'
import { CandidatePickService } from './candidatePickService'
import type { LLMService } from './llmService'
import { createLogger } from './logger'
import {
  CANCEL_ERROR, LORA_T2V_TURBO, LORA_R2V_TURBO, type QueuedTask
} from './taskQueueShared'
import { driftLockBlock, usablePromptEn, buildH3Prompt } from './taskQueuePrompts'
import { referenceIsPortrait, resolveRefImageRel, resolveSceneImageRel } from './taskQueueRefs'
import {
  runConsistencyCheck as runConsistencyCheckFn,
  recheckProjectConsistency as recheckProjectConsistencyFn,
  recheckProjectRoleConfusion as recheckProjectRoleConfusionFn,
  computeShotRoleConfusion as computeShotRoleConfusionFn,
  type ConsistencyRuntime
} from './taskQueueConsistency'
import {
  prepareShotAudio as prepareShotAudioFn,
  repairSilentDialogue as repairSilentDialogueFn,
  type AudioRuntime
} from './taskQueueAudio'
import { isPlaceholderDialogueText } from './subtitleService'
import {
  selectEngineMode, computeWanDurationSec, computeH3NeedSec, computeH3Length,
  applyOomLightDowngrade, applyOomTierDowngrade,
  computeWantedCandidates, computeLipProfile, isFlf2vWorkflow, resolveFlfWorkflowName,
  injectH3TurboLora, type EngineMode
} from './taskQueueRender'
import { deriveProjectStatus, isProjectQueueIdle, createCancellationWatcher, buildQueueSnapshot } from './taskQueueScheduler'
import { decideRetryAction } from './taskQueueRetry'

const log = createLogger('TaskQueue')

export class TaskQueue extends EventEmitter {
  private queue: QueuedTask[] = []
  private running = false
  /** start 串行链（防 director/手动/对话并发入队导致重复渲染） */
  private startChain: Promise<void> = Promise.resolve()
  /** 按项目粒度的取消集合（多项目混合队列互不影响） */
  private cancelledProjects = new Set<string>()
  private cancelledShotIds = new Set<string>()
  /** 镜头级取消键：项目/镜头复合，避免跨项目同 id 镜头误伤 */
  private static shotKey(projectId: string, shotId: string): string {
    return `${projectId}/${shotId}`
  }
  private current: QueuedTask | null = null
  /** 当前在渲镜的最新进度（供 queue:list 快照展示，不必等下一个事件） */
  private currentProgress: { step: ProgressEvent['step']; percent: number } | null = null
  /** 最近成片镜耗时（毫秒，最多 20 条）：ETA 估算的历史样本，首跑无样本时不展示数字 */
  private recentDurationsMs: number[] = []
  /** 当前镜开始渲染时间戳（用于落 done 时记录耗时） */
  private currentStartedAt = 0
  private lastProjectId = ''
  /** 本轮 process 处理过的项目，排空后逐个收尾并发 queue-finished */
  private touchedProjects = new Set<string>()
  /** start() 空目标但队列运行中时登记，排空后补发 queue-finished（不重算状态） */
  private pendingFinishNotify = new Set<string>()

  /** 技能库电影级质量条款（index.ts 启动时注入）；为空时回退代码层精简条款 */
  qualityBlock = CINEMATIC_QUALITY_BLOCK

  constructor(
    private baseDir: string,
    private comfyui: ComfyUIClient,
    private workflow: WorkflowLoader,
    private tts: TTSService,
    private ffmpeg: FFmpegService,
    private store: ProjectStore,
    private settings: SettingsStore,
    private llm?: LLMService
  ) {
    super()
    this.lipSync = new LipSyncService(comfyui, workflow)
    this.picker = llm ? new CandidatePickService(llm) : null
  }

  private lipSync: LipSyncService
  private picker: CandidatePickService | null
  /** 人物一致性校验（懒加载，依赖/模型不可用时自动降级为关闭） */
  private consistency: ConsistencyService | null = null

  /**
   * 拆分出去的一致性函数（taskQueueConsistency）所需的运行时依赖。
   * 类的私有字段/私有方法不直接暴露，这里以适配器形式注入（共享同一批引用，
   * 行为与原 this 直调完全一致）。
   */
  private get consistencyRuntime(): ConsistencyRuntime {
    return {
      ffmpeg: this.ffmpeg,
      store: this.store,
      getConsistencyService: () => this.getConsistencyService(),
      resolveInBase: (p: string) => this.resolveInBase(p),
      resolveRefImageRel: (shot: Shot, project: Project) => resolveRefImageRel(shot, project),
      emitProgress: (e: Omit<ProgressEvent, 'type'>) => this.emitProgress(e)
    }
  }

  /**
   * 拆分出去的音频函数（taskQueueAudio）所需的运行时依赖。
   */
  private get audioRuntime(): AudioRuntime {
    return {
      store: this.store,
      ffmpeg: this.ffmpeg,
      tts: this.tts,
      settings: this.settings,
      resolveInBase: (p: string) => this.resolveInBase(p),
      checkCancelled: (pid: string, sid: string) => this.checkCancelled(pid, sid),
      emitProgress: (e: Omit<ProgressEvent, 'type'>) => this.emitProgress(e),
      patchShot: (pid: string, shot: Shot) => this.patchShot(pid, shot)
    }
  }

  private getConsistencyService(): ConsistencyService {
    if (!this.consistency) {
      const modelDir = path.join(this.baseDir, '.models')
      this.consistency = new ConsistencyService(modelDir, (src, timeSec, size) => this.loadRgb(src, timeSec, size))
    }
    return this.consistency
  }

  /**
   * 两张图片的人脸/全图相似度（供导演首帧生成后自检复用同一套模型与解码器）。
   * 依赖或模型不可用时返回 null（调用方静默跳过，绝不阻塞流水线）。
   */
  async compareImages(referenceAbs: string, targetAbs: string): Promise<ConsistencyResult | null> {
    try {
      const svc = this.getConsistencyService()
      if (!(await svc.available())) return null
      return await svc.compare(referenceAbs, targetAbs)
    } catch {
      return null
    }
  }

  /** ffmpeg 解码 size×size RGB24 裸帧（letterbox，绕开 sharp）；临时文件保留到 dispose，供人脸子进程读取 */
  private async loadRgb(srcPath: string, timeSec?: number, size = 640): Promise<LoadedRgb> {
    const tmp = path.join(
      this.baseDir, '.tmp',
      `rgb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.rgb`
    )
    await this.ffmpeg.dumpRgb24(srcPath, tmp, size, timeSec)
    const data = await fs.readFile(tmp)
    const rgb = new Uint8Array(data)
    return {
      data: rgb,
      width: size,
      height: size,
      channels: 3,
      filePath: tmp,
      dispose: () => fs.unlink(tmp).catch(() => undefined)
    }
  }

  /**
   * 入口：把指定项目的分镜（或全部待渲染/失败分镜）加入队列。
   */
  async start(projectId: string, shotIds?: string[]): Promise<void> {
    // 串行化 start：director 逐个镜头 start 与用户手动/对话 start 可能并发触发，
    // 若不互斥，两个调用都会用"入队前的空队列快照"判定，导致同一镜重复入队（重复渲染浪费）。
    const run = async (): Promise<void> => {
      await this.ffmpeg.ready()
      // 复合键去重：跨项目可能存在相同 shotId，仅按 shotId 会误拦其他项目的镜头
      const queued = new Set(this.queue.map(t => TaskQueue.shotKey(t.projectId, t.shotId)))
      if (this.current) queued.add(TaskQueue.shotKey(this.current.projectId, this.current.shotId))
      const toEnqueue: string[] = []

      await this.store.update(projectId, (project) => {
        let targets: Shot[]
        if (shotIds && shotIds.length > 0) {
          targets = project.shots.filter(s => shotIds.includes(s.id))
        } else {
          targets = project.shots.filter(s => s.status === 'pending' || s.status === 'failed')
        }
        targets = targets.filter(s => !queued.has(TaskQueue.shotKey(projectId, s.id)))
        for (const shot of targets) {
          shot.status = 'pending'
          shot.error = undefined
          toEnqueue.push(shot.id)
        }
        if (targets.length > 0) {
          this.cancelledProjects.delete(projectId)
          project.status = 'rendering'
        }
      })

      for (const shotId of toEnqueue) {
        this.queue.push({ projectId, shotId })
      }

      if (toEnqueue.length > 0) {
        void this.process()
      } else {
        // 无目标也要发 queue-finished，避免 waitForFinish 永久挂起。
        // 同步 emit 会被错过（调用方在 start 返回后才注册 waitForFinish），因此：
        // - 队列空闲：setImmediate 延迟到 handler 注册之后再发；
        // - 队列运行中：登记后由 process() 排空时补发，避免过早通知。
        if (this.running) {
          this.pendingFinishNotify.add(projectId)
        } else {
          setImmediate(() => this.emit('queue-finished', { projectId }))
        }
      }
    }
    const prev = this.startChain
    const next = prev.then(run, run)
    this.startChain = next.catch(() => undefined)
    return next
  }

  /**
   * 取消：
   * - 传 shotId：从待处理队列移除该镜；若该镜正在渲染则中断 ComfyUI 并等待其结束
   * - 不传 shotId：取消该项目全部任务
   */
  async cancel(projectId: string, shotId?: string): Promise<void> {
    if (shotId) {
      this.queue = this.queue.filter(
        t => !(t.projectId === projectId && t.shotId === shotId)
      )
      if (this.current?.projectId === projectId && this.current.shotId === shotId) {
        const key = TaskQueue.shotKey(projectId, shotId)
        this.cancelledShotIds.add(key)
        await this.comfyui.interrupt()
        this.comfyui.rejectPending(CANCEL_ERROR)
        while (this.current?.shotId === shotId) {
          await new Promise(r => setTimeout(r, 100))
        }
        this.cancelledShotIds.delete(key)
      }
      return
    }

    this.cancelledProjects.add(projectId)
    this.queue = this.queue.filter(t => t.projectId !== projectId)
    // 只有本项目正在渲染时才中断 ComfyUI：interrupt 是全局的，
    // 取消排队中的项目不应误伤其他项目正在进行的渲染
    if (this.current?.projectId === projectId) {
      await this.comfyui.interrupt()
      this.comfyui.rejectPending(CANCEL_ERROR)
      // 只等本项目的在渲镜头结束（cancellationWatcher 会中断它），
      // 不等整个队列排空——否则会被其他项目的长任务阻塞数分钟
      while (this.current?.projectId === projectId) {
        await new Promise(r => setTimeout(r, 100))
      }
    }
    // 任务全部未消费就被取消的项目从未进 touchedProjects，process() 的 finally
    // 不会为它补发 queue-finished——waitForFinish 永久挂起、project.status 残留
    // rendering。此处补发事件并重算状态（在渲任务由 process finally 收尾，不重复发）。
    if (!this.touchedProjects.has(projectId) && this.current?.projectId !== projectId) {
      try {
        const project = await this.store.get(projectId)
        if (project.status === 'rendering') {
          project.status = deriveProjectStatus(project)
          await this.store.save(project)
        }
      } catch {
        // 项目可能已被删除，跳过状态重算但仍需通知
      }
      // setImmediate：调用方可能在 cancel 返回后才注册 waitForFinish
      setImmediate(() => this.emit('queue-finished', { projectId }))
    }
  }

  /**
   * 跳过镜头（REQ-11 MP-08）：取消在跑/排队任务并落盘 skipped=true，
   * 拼接成片时按 skipped 自然剔除；队列继续渲染后续镜头。
   */
  async skipShot(projectId: string, shotId?: string): Promise<{ skippedShotId: string }> {
    const targetId =
      shotId ||
      (this.current?.projectId === projectId ? this.current.shotId : undefined) ||
      this.queue.find(t => t.projectId === projectId)?.shotId
    if (!targetId) throw new Error('当前没有可跳过的镜头')
    await this.cancel(projectId, targetId)
    await this.store.update(projectId, project => {
      const shot = project.shots.find(s => s.id === targetId)
      if (!shot) throw new Error('镜头不存在，可能已被删除')
      shot.skipped = true
    })
    return { skippedShotId: targetId }
  }

  /**
   * 退出时取消全部排队/在渲任务：收集 queue 与 current 里出现过的项目 ID，逐个 cancel。
   * 单个项目 cancel 失败不影响其他项目收尾。
   */
  async cancelAll(): Promise<void> {
    const projectIds = new Set<string>()
    for (const t of this.queue) projectIds.add(t.projectId)
    if (this.current) projectIds.add(this.current.projectId)
    for (const id of projectIds) {
      await this.cancel(id).catch(() => undefined)
    }
  }

  /**
   * 断点续渲（应用启动时调用一次）：
   * 上次运行中崩溃/退出会留下 status='rendering' 的孤儿镜头——此时 ComfyUI 端任务也已随
   * 其重启或进程消失（/history 不保证留存），继续等待没有意义。统一重置为 pending，
   * 用户在分镜页点渲染即可从断点继续（已完成镜头为 done 不会重渲）。
   * @returns 恢复的孤儿镜头数
   */
  async recoverStaleRenders(): Promise<number> {
    // 先清 ComfyUI 残留任务：应用重启但 ComfyUI 未重启时，上次提交的旧任务可能仍在
    // 排队/运行（drama-studio 侧已随进程消失无法再轮询）——统一中断+清队，
    // 避免后台继续渲染已作废镜头，浪费显存与时间。
    await this.comfyui.clearQueue().catch(() => undefined)
    await this.comfyui.interrupt().catch(() => undefined)
    // 清理上次崩溃残留的临时文件（ffmpeg 中间产物 / RGB24 裸帧 / 拼接临时目录）
    await this.cleanupOrphanTmp().catch(() => undefined)
    let recovered = 0
    try {
      const projects = await this.store.list()
      for (const project of projects) {
        const staleShots = project.shots.filter(s => s.status === 'rendering')
        if (project.status !== 'rendering' && staleShots.length === 0) continue
        for (const shot of staleShots) {
          // 产物已在盘则视为已完成：重启前渲染其实已出片，只是状态没来得及落盘。
          // 直接恢复为 done，避免误判中断导致重渲浪费（M-x 与 projectStore 保护同源）。
          if (shot.segmentPath) {
            let exists = false
            try {
              exists = (await fs.stat(this.resolveInBase(shot.segmentPath))).isFile()
            } catch { /* 文件不在盘 */ }
            if (exists) {
              shot.status = 'done'
              shot.error = undefined
              recovered += 0 // 不计数为"待恢复"，但也不再计为中断
              continue
            }
          }
          shot.status = 'pending'
          shot.error = '应用重启导致渲染中断，已恢复为待渲染，可重新续渲'
          recovered += 1
        }
        if (project.status === 'rendering') {
          project.status = deriveProjectStatus(project)
        }
        await this.store.save(project)
      }
      if (recovered > 0) {
        log.info(`断点续渲：${recovered} 个中断镜头已恢复为待渲染`)
      }
    } catch (e) {
      log.warn(`断点续渲扫描失败: ${e instanceof Error ? e.message : String(e)}`)
    }
    return recovered
  }

  /** REQ-15 DC-OPEN-22：低磁盘「清理临时产物」入口，复用崩溃残留清理逻辑 */
  async cleanupTmpFiles(): Promise<void> {
    await this.cleanupOrphanTmp()
  }

  /**
   * 清理上次崩溃残留的临时文件：
   * - baseDir/.tmp 下 rgb_*.rgb（一致性检测的 RGB24 裸帧，正常 dispose 会删；崩溃时留下）
   * - os.tmpdir() 下 concatfit_*、smartconcat_*、concat_*.txt、ds_sub_*.ass、qc_*.png
   *   （ffmpeg 拼接/字幕/质检的临时产物，正常 finally 会删；崩溃时留下）
   * - 项目目录下 *.part.mp4 / *.part.png / *.part.mp3（fluent-ffmpeg 的中间产物，
   *   成功后 rename 为正式产物；崩溃时残留半截文件）
   * 只删匹配明确前缀/后缀的文件，不动其他数据。失败静默（不阻塞启动恢复）。
   */
  private async cleanupOrphanTmp(): Promise<void> {
    // 1) baseDir/.tmp 下的 rgb_*.rgb
    try {
      const tmpDir = path.join(this.baseDir, '.tmp')
      const entries = await fs.readdir(tmpDir).catch(() => [] as string[])
      for (const name of entries) {
        if (/^rgb_.*\.rgb$/.test(name)) {
          await fs.unlink(path.join(tmpDir, name)).catch(() => undefined)
        }
      }
    } catch { /* .tmp 不存在 */ }

    // 2) os.tmpdir() 下本应用前缀的临时目录/文件
    const osTmp = os.tmpdir()
    const orphanPatterns = [
      /^concatfit_/, /^smartconcat_/, /^concat_\d+\.txt$/, /^ds_sub_.*\.ass$/, /^qc_\d+_.*\.png$/
    ]
    try {
      const entries = await fs.readdir(osTmp)
      for (const name of entries) {
        if (!orphanPatterns.some(re => re.test(name))) continue
        const abs = path.join(osTmp, name)
        const st = await fs.stat(abs).catch(() => null)
        if (!st) continue
        if (st.isDirectory()) {
          await fs.rm(abs, { recursive: true, force: true }).catch(() => undefined)
        } else {
          await fs.unlink(abs).catch(() => undefined)
        }
      }
    } catch { /* tmpdir 不可读 */ }

    // 3) 项目目录下的 *.part.* 中间产物（崩溃时 ffmpeg 没来得及 rename）
    try {
      const projectsDir = path.join(this.baseDir, 'projects')
      const projectDirs = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => [])
      for (const dir of projectDirs) {
        if (!dir.isDirectory()) continue
        const projectRoot = path.join(projectsDir, dir.name)
        // 递归扫两层（segments/ raw/ fit/ 等）
        const subdirs = await fs.readdir(projectRoot, { withFileTypes: true }).catch(() => [])
        for (const sub of subdirs) {
          if (!sub.isDirectory()) continue
          const subAbs = path.join(projectRoot, sub.name)
          const files = await fs.readdir(subAbs).catch(() => [])
          for (const name of files) {
            if (/\.part\.(mp4|png|mp3|wav)$/.test(name)) {
              await fs.unlink(path.join(subAbs, name)).catch(() => undefined)
            }
          }
        }
      }
    } catch { /* projects 目录不可读 */ }
  }

  private async process(): Promise<void> {
    if (this.running) return
    this.running = true

    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift()!
        // 项目级取消：跳过该项目的残留任务，不中断其他项目
        if (this.cancelledProjects.has(task.projectId)) continue
        this.current = task
        this.currentProgress = null
        this.currentStartedAt = Date.now()
        this.lastProjectId = task.projectId
        this.touchedProjects.add(task.projectId)
        try {
          await this.renderShot(task.projectId, task.shotId)
        } catch (e) {
          // 单镜异常不拖垮整个队列。renderShot 内部已兜底，这里是最后防线：
          // 兜住 try 块之外的前置段（project.json 损坏时 store.get 抛错、
          // 磁盘满/EPERM 时 patchShot 抛错）以及 catch 分支里 patchShot 的二次异常。
          log.error(`镜头渲染异常 ${task.projectId}/${task.shotId}: ${(e as Error).message}`)
        }
        this.current = null
        this.currentProgress = null
      }
    } finally {
      // 无论循环如何退出都必须复位 running 并逐项目收尾，
      // 否则 running 卡死导致后续 start() 全部丢弃任务、waitForFinish 永久挂起
      this.current = null
      this.currentProgress = null
      this.running = false

      // 逐项目收尾：更新状态 + 通知编排者
      const finished = [...this.touchedProjects]
      this.touchedProjects.clear()
      for (const pid of finished) {
        try {
          const project = await this.store.get(pid)
          project.status = deriveProjectStatus(project, { cancelled: this.cancelledProjects.has(pid) })
          await this.store.save(project)
        } catch {
          // 项目可能已被删除或落盘失败，跳过状态重算但仍需通知
        }
        this.emit('queue-finished', { projectId: pid })
      }

      // start() 空目标且队列运行中时登记的补发项：无需重算状态，仅补发事件
      const pending = [...this.pendingFinishNotify]
      this.pendingFinishNotify.clear()
      for (const pid of pending) {
        if (!finished.includes(pid)) {
          this.emit('queue-finished', { projectId: pid })
        }
      }
    }

    // 取消等待期间又有新任务入队（start 时 running=true 被跳过）：补一轮消费
    if (this.queue.length > 0) {
      void this.process()
    }
  }

  /**
   * 供 AI 导演编排：等待指定项目的队列排空。
   * 须在 start() 之后调用。空目标时 start() 用 setImmediate / pendingFinishNotify 补发，
   * 避免同步 emit 早于本方法注册而漏事件。
   */
  waitForFinish(projectId: string, timeoutMs = 6 * 60 * 60 * 1000): Promise<void> {
    if (this.isProjectQueueIdle(projectId)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('queue-finished', handler)
        reject(new Error(`等待渲染队列结束超时（${Math.round(timeoutMs / 1000)}s）`))
      }, timeoutMs)
      const handler = (p: { projectId: string }): void => {
        if (p.projectId !== projectId) return
        clearTimeout(timer)
        this.off('queue-finished', handler)
        resolve()
      }
      this.on('queue-finished', handler)
    })
  }

  /** 该项目没有在跑、也没有排队。用于补上「完成事件早于监听注册」的空窗。 */
  private isProjectQueueIdle(projectId: string): boolean {
    return isProjectQueueIdle(this.queue, this.current, projectId)
  }

  /** 队列快照（IPC queue:list）：任意页面可查询在渲镜 / 排队镜 / 剩余 ETA */
  getQueueSnapshot(): ReturnType<typeof buildQueueSnapshot> {
    return buildQueueSnapshot(this.queue, this.current, this.currentProgress, this.recentDurationsMs)
  }

  private emitProgress(e: Omit<ProgressEvent, 'type'>): void {
    const event = { ...e, type: 'project:progress' } as ProgressEvent
    // 记录在渲镜最新进度，供 queue:list 快照使用
    if (this.current && e.projectId === this.current.projectId && e.shotId === this.current.shotId) {
      this.currentProgress = { step: e.step, percent: e.percent }
    }
    // 成片镜耗时样本（最近 20 条）：供 ETA 估算；取消/失败不计入
    if (e.step === 'done' && this.currentStartedAt > 0) {
      const elapsed = Date.now() - this.currentStartedAt
      if (elapsed > 0) {
        this.recentDurationsMs.push(elapsed)
        if (this.recentDurationsMs.length > 20) this.recentDurationsMs.shift()
      }
    }
    // ETA 随进度事件下发（兼容既有 ProgressEvent.etaSeconds 契约）
    if (this.queue.length > 0) {
      const eta = buildQueueSnapshot(this.queue, this.current, this.currentProgress, this.recentDurationsMs).etaSeconds
      if (eta !== null) event.etaSeconds = eta
    }
    this.emit('progress', event)
  }

  /** 识别 ComfyUI 显存不足类错误（OOM/显存分配失败） */
  private isOOMError(err: unknown): boolean {
    return isOomError(err)
  }

  /** 只回写单个镜头的"渲染产物"字段（基于磁盘最新数据合并）：
   *  不用渲染开始时的内存快照整镜覆盖，否则用户渲染期间通过 IPC 修改的
   *  台词/景别/工作流等会被旧快照冲掉（M-5）。 */
  private async patchShot(projectId: string, shot: Shot): Promise<void> {
    await this.store.update(projectId, draft => {
      const idx = draft.shots.findIndex(s => s.id === shot.id)
      if (idx < 0) return
      const prev = draft.shots[idx]
      draft.shots[idx] = {
        ...prev,
        // 以下为 renderShot 全部会写入的字段（白名单）
        status: shot.status,
        error: shot.error,
        errorKind: shot.errorKind,
        retryCount: shot.retryCount,
        retryBudget: shot.retryBudget,
        audioPath: shot.audioPath ?? prev.audioPath,
        audioFailed: shot.audioFailed ?? prev.audioFailed,
        audioFailedReason: shot.audioFailedReason ?? prev.audioFailedReason,
        frames: shot.frames,
        frameSeconds: shot.frameSeconds ?? prev.frameSeconds,
        rawVideoPath: shot.rawVideoPath ?? prev.rawVideoPath,
        segmentPath: shot.segmentPath ?? prev.segmentPath,
        seed: shot.seed ?? prev.seed,
        width: shot.width,
        height: shot.height,
        renderProfile: shot.renderProfile ?? prev.renderProfile,
        consistencyScore: shot.consistencyScore ?? prev.consistencyScore,
        // 低一致性标记：renderShot 内存对象为权威（重渲通过会被清除），直接覆盖
        lowConsistency: shot.lowConsistency
      }
    })
  }

  /** 同步检查点：若项目或镜头已被取消则立即抛出 */
  private checkCancelled(projectId: string, shotId: string): void {
    if (this.cancelledProjects.has(projectId) || this.cancelledShotIds.has(TaskQueue.shotKey(projectId, shotId))) {
      throw new Error(CANCEL_ERROR)
    }
  }

  /**
   * 取消竞态：在长耗时 await（ComfyUI 渲染）期间被取消时，
   * 该 Promise 以 CANCEL_ERROR reject，使 Promise.race 提前结束。
   */
  private cancellationWatcher(projectId: string, shotId: string): {
    promise: Promise<never>
    stop(): void
  } {
    return createCancellationWatcher(
      this.cancelledProjects,
      this.cancelledShotIds,
      (pid, sid) => TaskQueue.shotKey(pid, sid),
      projectId,
      shotId
    )
  }

  /** 相对路径（新规范）或绝对路径（旧数据兼容）→ 绝对路径 */
  private resolveInBase(p: string): string {
    return path.isAbsolute(p) ? p : path.join(this.baseDir, p)
  }

  /** 项目尚无缩略图时，取本镜分段首帧 */
  private async ensureProjectThumbnail(
    projectId: string,
    segmentAbsPath: string
  ): Promise<void> {
    const thumbAbsPath = path.join(this.baseDir, `projects/${projectId}/thumbnail.jpg`)
    if (await this.ffmpeg.fileExists(thumbAbsPath)) return
    try {
      await this.ffmpeg.extractFirstFrame(segmentAbsPath, thumbAbsPath)
    } catch {
      // 缩略图失败不阻塞渲染
    }
  }

  /**
   * 手动重跑项目全部 i2v 镜一致性校验（只更新 consistencyScore/lowConsistency，不触发重渲）。
   * 用途：旧项目被旧逻辑误杀标记的镜头摘帽——新逻辑（小脸门控+分方法聚合）复评，
   * 误杀摘帽回成片，真漂移保持标记；随后从「拼接成片」续跑即可。
   */
  async recheckProjectConsistency(projectId: string): Promise<{ rechecked: number; cleared: number; stillLow: number; skipped: number }> {
    return recheckProjectConsistencyFn(this.consistencyRuntime, projectId)
  }

  /**
   * 多角色剧角色混淆扫描（拼接/复审前调用）：交叉比对各角色定妆，回填 shot.roleConfusion。
   */
  async recheckRoleConfusion(projectId: string): Promise<{ checked: number; confused: number; skipped: number }> {
    return recheckProjectRoleConfusionFn(this.consistencyRuntime, projectId)
  }

  /**
   * 单镜角色混淆相对判别（审核端现算）：本镜输出更像另一角色定妆 → 判混淆。
   */
  async checkShotRoleConfusion(
    projectId: string,
    shot: Shot,
    project: Project
  ): Promise<Awaited<ReturnType<typeof computeShotRoleConfusionFn>>> {
    return computeShotRoleConfusionFn(this.consistencyRuntime, projectId, shot, project)
  }

  /**
   * 台词镜 TTS 失败后的补配音：不重跑视频。
   * 成功则用 raw 视频与新音频重做分段并清除 audioFailed；
   * 仍失败或缺少 raw 的镜号返回，调用方不得把它们拼进成片。
   */
  async repairSilentDialogue(projectId: string): Promise<{ repaired: number[]; blocked: number[] }> {
    return repairSilentDialogueFn(this.audioRuntime, projectId)
  }

  private async renderShot(projectId: string, shotId: string): Promise<void> {
    this.lastProjectId = projectId
    const project = await this.store.get(projectId)
    const shot = project.shots.find(s => s.id === shotId)
    if (!shot) return

    shot.status = 'rendering'
    await this.patchShot(projectId, shot)

    // 2026-10-25 预防加固（专家D P1）：渲染前磁盘余量预检——历史 D 盘 0.98GB 时渲染中断/磁盘满
    // 报错只能靠 catch，没有事前闸门。低于 0.5GB 硬停（单镜产物约 200MB），低于 1.5GB 提示。
    try {
      const st = await fs.statfs(this.baseDir)
      const freeGb = (st.bavail * st.bsize) / 2 ** 30
      if (freeGb < 0.5) {
        throw new Error(`磁盘余量不足（${freeGb.toFixed(2)}GB < 0.5GB），渲染已停止；请清理磁盘后恢复任务`)
      }
      if (freeGb < 1.5) {
        this.emitProgress({ projectId, shotId, step: 'render', percent: 5, message: `磁盘余量 ${freeGb.toFixed(2)}GB（偏低，渲染前预检通过）` })
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('磁盘余量不足')) throw e
      log.warn(`磁盘预检不可用（不阻断）: ${e}`)
    }

    const watcher = this.cancellationWatcher(projectId, shotId)
    /** 自动重试预算（降档/瞬时重试合计）：供 UI 展示「已自动降档重试 1/2」 */
    const AUTO_RETRY_BUDGET = 2
    let autoRetryCount = 0

    try {
      let refImageRel = resolveRefImageRel(shot, project)
      // 显存档位先取（只依赖设置 + 显存探测），用于给 TTS 一个「本档位单镜能装多少秒语音」
      // 的硬上限：台词超长时提前提速，避免音频长于引擎输出被截断/出现静音空洞。
      const manualTier = (await this.settings.get()).render.resolutionTier
      let tier: VramTier = manualTier && manualTier !== 'auto'
        ? VRAM_TIERS[manualTier] ?? await this.comfyui.getVramTier()
        : await this.comfyui.getVramTier()
      // 容量按本镜实际引擎算：H3 是 17k+5 帧网格（≈(maxFrames-5)/17×0.75 秒），
      // Wan 是秒数上限。取两者最小值会让 H3 长镜被 Wan 的 5s 上限误压短。
      const wfHint = shot.workflow || project.defaultWorkflow || 'wan22_i2v'
      const engineCapSec = Math.min(
        SHOT_TIMING.maxSec,
        wfHint.startsWith('minimax_h3')
          ? ((tier.maxFrames - 5) / 17) * 0.75
          : tier.maxWanSec
      )
      const { syncAudioRelPath, audioSec } = await prepareShotAudioFn(
        this.audioRuntime,
        projectId, shot, project, watcher, { capSec: engineCapSec }
      )

      // 台词镜 r2v 口型修复（实测根因）：H3 原生口型精度依赖 ref_image_1 的脸部细节。
      // 中景首帧脸部占比小时 H3 提取不到清晰嘴部 → 口型漂移；但首帧同时承担"人物+场景"
      // 双重锚点，弃用首帧会让视频从定妆灰幕起跑（实测成片台词镜全是灰幕）。
      // 规则：有首帧 → 用首帧；仅缺首帧的中景台词镜才改用面部定妆图锁脸。
      // 必须在 upload 之前统一 refImageRel——上传与 workflow 引用同一文件，否则引用未上传文件提交失败。
      {
        const lipModeEarly = (await this.settings.get()).render.lipSyncMode || 'auto'
        const preferH3Early = (shot.workflow || project.defaultWorkflow || 'minimax_h3_i2v').startsWith('minimax_h3')
        // 有本镜首帧时必须用首帧：首帧是「人物+场景同机位」的融合图，视频从它起跑；
        // 若改喂定妆大头照，H3 会从摄影棚灰幕起画（实测成片所有台词镜都从灰幕起跑）。
        // 只有缺首帧的中景台词镜才退回面部定妆图锁脸。
        if (
          preferH3Early && !isPlaceholderDialogueText(shot.dialogue) && lipModeEarly !== 'latentsync' &&
          shot.shotSize !== 'closeup' && !shot.firstFramePath
        ) {
          const rChar = project.characters.find(c => c.id === shot.characterIds[0])
          if (rChar?.faceImagePath) refImageRel = rChar.faceImagePath
        }
      }

      // 4. 选择引擎与口型技术路线（优先级：分镜指定 > 项目默认 > 全局设置默认 > 'wan22_i2v'）
      this.emitProgress({ projectId, shotId, step: 'render', percent: 15, message: '构建工作流...' })
      const s0 = await this.settings.get()
      let baseWorkflow = shot.workflow || project.defaultWorkflow || s0.workflow.default || 'wan22_i2v'
      const preferH3 = baseWorkflow.startsWith('minimax_h3')
      const hasLine = Boolean(!isPlaceholderDialogueText(shot.dialogue) && syncAudioRelPath)
      const lipMode = s0.render.lipSyncMode || 'auto'

      // 首尾帧硬衔接：**分镜设计上无台词**且带尾帧图、未钉死工作流 → 自动走 Wan Remix 首尾帧
      // （首帧+尾帧双图约束，解决"首中尾帧图生没连接上"——H3 工作流只有 REF_IMAGE 一个图输入，无法接收尾帧）。
      // 判定用 shot.dialogue 而非 hasLine（hasLine 依赖本次 TTS 是否成功：TTS 临时失败时
      // syncAudioRelPath 为空，会把台词镜误判为无台词切走首尾帧——必须按剧本设计判，不能按 TTS 结果判）
      const metas = await this.workflow.list()
      // 防漂移铁律：flf2v 首尾帧只在「镜的意图动作含大幅位移」时自动切换；
      // 站立微动/对话/单动作完成镜即使有尾帧也不切（首尾帧自由插值=位移漂移第一重灾区）。
      // 位移判定与 llmService 尾帧必填判定共用同一份正则（DISPLACEMENT_ACTION_RE），口径禁止分裂
      let effectiveWorkflow = baseWorkflow
      if (!shot.workflow && shot.lastFramePath && isPlaceholderDialogueText(shot.dialogue) && DISPLACEMENT_ACTION_RE.test(shot.action || '')) {
        const flfName = resolveFlfWorkflowName(metas)
        if (flfName) {
          effectiveWorkflow = flfName
          this.emitProgress({
            projectId, shotId, step: 'render', percent: 15,
            message: `检测到分镜尾帧 → 改用首尾帧工作流 ${flfName}（首帧+尾帧双图衔接）`
          })
        }
      }
      // 台词镜永远走 H3（r2v 原生口型 → 失败回退 i2v+LatentSync），不切首尾帧
      const preferFlf = effectiveWorkflow !== baseWorkflow

      // auto：H3 台词镜走原生口型 r2v；latentsync：强制 i2v+LatentSync；h3-native：r2v 不回退
      // 录音/画外音才 forceI2v；默认工作流名 minimax_h3_i2v 不能钉死整片台词镜
      let mode: EngineMode = selectEngineMode({
        preferFlf, preferH3, hasLine, lipMode,
        forceI2v: isPlaybackOrVoiceoverAction(shot.action)
      })
      if (preferFlf) baseWorkflow = effectiveWorkflow

      // 时长参数（OOM 降档时会被压缩；初始上限受显存档位约束）
      let wanDurationSec = computeWanDurationSec(shot.frames, tier.maxWanSec)
      const h3NeedSec = computeH3NeedSec(shot, audioSec, project.shots, SHOT_TIMING.audioLeadSec)
      // H3 17k+5 网格：实际时长 ≈ (frames-5)/17×0.75s（如 158 帧≈6.6s，175 帧≈7.5s）
      const h3Len = computeH3Length(h3NeedSec, tier.maxFrames)
      let h3Length = h3Len.length
      if (h3Len.capped) {
        this.emitProgress({
          projectId, shotId, step: 'render', percent: 15,
          message: `台词需求 ${h3Len.needSecRounded}s 超过本档位 ${h3Len.capSec}s 上限，尾音可能被截断；建议拆分长句或提升分辨率档位`
        })
        log.warn(`[${shot.id}] 台词时长 ${h3Len.needSecRounded}s > 档位 ${tier.name} 容量 ${h3Len.capSec}s（maxFrames=${tier.maxFrames}），尾音可能被截断`)
      }
      // H3 采样步数：12 → 8（官方训练范围内，5060Ti 单镜提速约 33%；
      // 更少的步数在短镜上画质损失可接受，长镜/特写如需更高保真可在设置中调档）
      // turboH3=true 时：i2v 挂 fl2v_turbo_8step LoRA 用 8 步（画质更稳），r2v 挂 ref2v_turbo_4step LoRA 用 8 步
      // （实测：r2v 4 步在复杂联想场景（面馆/招牌/热气）画面漂移明显——背景乱变、叠影、自造招牌；
      // 步数 4→8 换取精度，质量优先于速度，速度代价约 1.5~2 倍可接受）
      const turboH3 = s0.render.turboH3 !== false
      // 2026-10-25 清理：死三元（r2v/i2v 现均为 8 步，注释已说明）；保留字面量
      let h3Steps = 8
      let renderSeed = shot.seed
      let oomDowngraded = false
      let audioName: string | undefined

      const rawRelPath = `projects/${projectId}/raw/${shotId}.mp4`
      const rawAbsPath = path.join(this.baseDir, rawRelPath)
      const segmentRelPath = `projects/${projectId}/segments/${shotId}.mp4`
      const segmentAbsPath = path.join(this.baseDir, segmentRelPath)

      /**
       * 单次生产：构建 graph（含提交前环境自检）→ 提交 → 等待 → 下载 → 口型 → 分段。
       * 可变状态（mode/h3Length/renderSeed 等）由外层重试循环控制。
       */
      let imageName = ''
      let endImageName = ''

      const runProduction = async (): Promise<void> => {
        let graph: Record<string, unknown>
        let workflowName: string
        const portrait = referenceIsPortrait(shot, project, s0, (p: string) => this.resolveInBase(p))
        const canvas = orientVideoSize(tier.width, tier.height, portrait)
        shot.width = canvas.width
        shot.height = canvas.height
        this.checkCancelled(projectId, shotId)
        this.emitProgress({ projectId, shotId, step: 'upload', percent: 10, message: '参考图对齐到视频画幅...' })
        const fitDir = path.join(this.baseDir, 'projects', projectId, 'fit')
        await fs.mkdir(fitDir, { recursive: true })
        const fittedRef = path.join(fitDir, `${shotId}_ref.png`)
        await this.ffmpeg.fitCover(this.resolveInBase(refImageRel), fittedRef, canvas.width, canvas.height)
        imageName = await this.comfyui.uploadImage(fittedRef)
        const endRel = shot.lastFramePath && shot.lastFramePath !== refImageRel ? shot.lastFramePath : null
        if (endRel) {
          const fittedEnd = path.join(fitDir, `${shotId}_end.png`)
          await this.ffmpeg.fitCover(this.resolveInBase(endRel), fittedEnd, canvas.width, canvas.height)
          endImageName = await this.comfyui.uploadImage(fittedEnd)
        } else {
          endImageName = imageName
        }

        if (mode === 'wan') {
          // ===== Wan 引擎 =====
          workflowName = baseWorkflow
          const metas = await this.workflow.list()
          // 有尾帧且镜头未钉死工作流 → 仅当动作含大幅位移才自动改走 Remix 首尾帧
          // （微动镜不切 flf2v，防止首尾帧自由插值产生行走/位移漂移）
          if (!shot.workflow && shot.lastFramePath && DISPLACEMENT_ACTION_RE.test(shot.action || '')) {
            const flfName = resolveFlfWorkflowName(metas)
            if (flfName) workflowName = flfName
          }
          const tpl = GENRE_TEMPLATES.find(t => t.key === project.genre)
          const char = project.characters.find(c => c.id === shot.characterIds[0])
          const board = (project.sceneBoards || []).find(b => b.id === shot.sceneBoardId)
          // 身份/发型/服装代码层强锁：压在最前，无论主提示词来源
          const lookEn = char?.appearanceLock || char?.description
          const identityLock = lookEn ? identityLockBlock(lookEn) : ''
          // 上下镜衔接：本镜尾帧为下一镜提供的连续状态
          const handoff = shot.handoffToNext ? `, HANDOFF TO NEXT SHOT: ${shot.handoffToNext}` : ''
          const meta = metas.find(w => w.name === workflowName)
          // 首尾帧转场提示词（flf2v 专用）：分镜 transitionEn 优先——它是起始帧→结束帧的
          // 动态转场过程描述（A/B 分类策略 + 10 秒拆解），比普通 promptEn 更贴合首尾帧桥接；
          // 无 transitionEn 回退常规组装。组装后强制逻辑原子化清洗。
          const isFlf2v = isFlf2vWorkflow(workflowName, meta)
          // 防漂移强锁块（代码层兜底，补 LLM promptEn 缺的位置/原子/机位/平滑约束）
          const driftLock = driftLockBlock(shot)
          const promptEn = usablePromptEn(shot, lookEn || '')
          const transitionEn = shot.transitionEn && !castPromptPoisoned(shot.action || '', shot.transitionEn, lookEn || '')
            ? shot.transitionEn
            : undefined
          const prompt = transitionEn && isFlf2v
            ? sanitizeCinematicPrompt(stripOocWardrobe(stripOtherPersonClauses(`${identityLock}, ${transitionEn}${handoff}, ${this.qualityBlock}`), lookEn || ''))
            : promptEn
              ? sanitizeCinematicPrompt(stripOocWardrobe(stripOtherPersonClauses(`${identityLock}, ${promptEn}, ${driftLock}${handoff}, ${this.qualityBlock}`), lookEn || ''))
              : sanitizeCinematicPrompt(videoMotionPrompt({
                  action: cleanAction(shot.action),
                  lookEn,
                  scene: board?.name || shot.scene,
                  emotion: shot.emotion,
                  camera: shot.camera,
                  dialogue: shot.dialogue,
                  genreStyle: tpl?.promptStyle,
                  shotSize: shot.shotSize,
                  lighting: shot.lighting,
                  facing: shot.facing,
                  continuity: shot.continuity
                }))
          const periodLock = periodLockFor(project.genre)
          // 面部表情锁定：H3 同款问题，Wan i2v 用首帧做起点图锁定较强，但表演段仍可能脸型漂移
          const faceLock = shot.characterIds.length ? `, ${faceExpressionLockFor(shot.emotion, shot.action)}` : ''
          // 时间轴稳定块（sanitize 之后拼接：Wan 引擎 16fps，总时长=DURATION 秒）
          const look = lookEn || ''
          const timeline = timelineProtocolBlock({
            sec: wanDurationSec,
            fps: 16,
            transition: shot.transition,
            firstFrameEn: repairCastText(shot.firstFrameEn, shot.action || '', look, 'frame'),
            midFrameEn: repairCastText(shot.midFrameEn, shot.action || '', look, 'frame'),
            lastFrameEn: repairCastText(shot.lastFrameEn, shot.action || '', look, 'frame'),
            motionEn: promptEn || motionCueFromAction(shot.action)
          })
          const vars: Record<string, string | number | boolean> = {
            PROMPT: keepDialogueChinese(scrubSummoningTerms(`${prompt}${faceLock}. ${periodLock}. ${timeline}`)),
            REF_IMAGE: imageName,
            SEED: renderSeed,
            DURATION: wanDurationSec
          }
          const wanNegative = negativeForSlot(
            Boolean(meta?.placeholders.includes('NEGATIVE')),
            mergeNegative(WAN_QUALITY_NEGATIVE, shot.negativeEn, videoNegativeFor(shot.action), oocWardrobeNegativeFor(lookEn || ''), ageDriftNegativeFor(lookEn || ''))
          )
          if (wanNegative) vars.NEGATIVE = wanNegative
          if (meta?.placeholders.includes('END_IMAGE')) {
            vars.END_IMAGE = endImageName
          }
          graph = await this.workflow.buildGraph(workflowName, vars)
          const resize = graph['25'] as { inputs?: Record<string, unknown> } | undefined
          if (resize?.inputs && typeof resize.inputs.width === 'number') {
            resize.inputs.width = canvas.width
            resize.inputs.height = canvas.height
            resize.inputs.keep_proportion = true
          }
        } else {
          // ===== H3 引擎：r2v（原生口型）或 i2v（原生环境音）=====
          // EngineMode → 实际工作流文件名映射
          workflowName = mode === 'h3-r2v' ? 'minimax_h3_r2v' : 'minimax_h3_i2v'
          if (mode === 'h3-r2v' && !audioName) {
            this.checkCancelled(projectId, shotId)
            this.emitProgress({ projectId, shotId, step: 'upload', percent: 12, message: '上传参考音频...' })
            audioName = await Promise.race([
              this.comfyui.uploadAudio(this.resolveInBase(syncAudioRelPath!), s0.comfyui.inputDir),
              watcher.promise
            ])
          }
          // r2v 场景双参考：ref_image_2 用场景板空景锁背景（r2v 对背景延续弱，
          // 实测镜7 首帧室内但视频街道）——<Picture 2> 提供独立背景锚，
          // 人物由 <Picture 1>（首帧）锁定，两者解耦各司其职
          let sceneImageName: string | undefined
          if (mode === 'h3-r2v') {
            const sceneRel = resolveSceneImageRel(shot, project, this.baseDir)
            if (sceneRel) {
              try {
                const fittedScene = path.join(this.baseDir, 'projects', projectId, 'fit', `${shotId}_scene.png`)
                await this.ffmpeg.fitCover(this.resolveInBase(sceneRel), fittedScene, canvas.width, canvas.height)
                sceneImageName = await this.comfyui.uploadImage(fittedScene)
              } catch (e) {
                log.warn(`[${shot.id}] 场景参考图上传失败，回退单参考: ${e instanceof Error ? e.message : String(e)}`)
              }
            }
          }
          const h3Width = canvas.width
          const h3Height = canvas.height
          const vars: Record<string, string | number> = {
            PROMPT: buildH3Prompt(shot, project, mode === 'h3-r2v', h3NeedSec, this.qualityBlock),
            REF_IMAGE: imageName,
            SEED: renderSeed,
            WIDTH: h3Width,
            HEIGHT: h3Height,
            LENGTH: h3Length,
            PREFIX: `drama/${projectId}`
          }
          if (audioName && mode === 'h3-r2v') vars.AUDIO = audioName
          // 2026-10-25 修复（全面排查 P1）：R2V 场景图缺失/上传失败时回退人物首帧当 ref_image_2
          // （与模板 ref_image_size:"match" 兼容）——此前注释承诺"回退单参考"但无代码路径，
          // vars 缺 SCENE_IMAGE → buildGraph 抛未替换占位符 → R2V 台词镜确定性判 failed。
          if (mode === 'h3-r2v') {
            vars.SCENE_IMAGE = sceneImageName || imageName
            if (!sceneImageName) log.warn(`[${shot.id}] 场景图缺失/上传失败，SCENE_IMAGE 回退人物首帧（单参考出片，背景锁弱化）`)
          }
          graph = await this.workflow.buildGraph(workflowName, vars)
          const sched = graph['42'] as { inputs?: Record<string, unknown> } | undefined
          if (sched?.inputs) sched.inputs.steps = h3Steps
          // H3 turbo LoRA 加速：在 UNETLoader(20) 之后插入 LoraLoaderModelOnly(25)，
          // 采样器/引导器的 model 引用改挂 LoRA 输出；i2v=8步LoRA、r2v=4步LoRA
          if (injectH3TurboLora(graph, mode, turboH3, LORA_T2V_TURBO, LORA_R2V_TURBO)) {
            this.emitProgress({
              projectId, shotId, step: 'render', percent: 16,
              message: `H3 turbo 加速：${mode === 'h3-r2v' ? 'ref2v_turbo_4step/4步' : 'fl2v_turbo_8step/8步'}`
            })
          }
        }

        // 4.5 提交前环境自检：缺节点/缺模型直接给中文错误，不交给 ComfyUI 抛 500
        const objectInfo = await this.comfyui.getObjectInfo()
        const envIssues = this.workflow.validateBuiltGraph(workflowName, graph, objectInfo)
        if (envIssues.length) {
          throw new Error('工作流环境自检失败：\n' + envIssues.map(i => `· ${i.message}`).join('\n'))
        }

        // 5. 提交并等待（取消竞态包裹）
        const { promptId } = await this.comfyui.submit(graph)
        this.emitProgress({ projectId, shotId, step: 'render', percent: 20, message: '渲染中...' })
        const timeoutMs = Math.max(60, resolveCreation(s0).edit.comfyTimeoutSec || 600) * 1000
        const output = await Promise.race([
          this.comfyui.waitForCompletion(promptId, (percent) => {
            this.emitProgress({
              projectId, shotId, step: 'render',
              percent: 20 + Math.round(percent * 0.6),
              message: `渲染中... ${percent}%`
            })
          }, timeoutMs),
          watcher.promise
        ])

        // 6. 下载原始视频
        this.checkCancelled(projectId, shotId)
        this.emitProgress({ projectId, shotId, step: 'render', percent: 85, message: '下载视频...' })
        const video = this.comfyui.findVideoOutput(output)
        if (!video) throw new Error('ComfyUI 未输出视频')
        if (video.fullpath) {
          await this.comfyui.downloadFromFullPath(video.fullpath, rawAbsPath)
        } else {
          await this.comfyui.download(video.filename, video.subfolder, video.type, rawAbsPath)
        }
        // 大文件下载可能耗时数十秒，下载完成后立即检查取消，避免已取消镜头继续合成到 done
        this.checkCancelled(projectId, shotId)
        shot.rawVideoPath = rawRelPath

        // 6.5 口型同步：
        // - wan 引擎台词镜 → LatentSync
        // - 强制 latentsync 路线 / r2v 失败回退的 h3-i2v 台词镜 → LatentSync 补口型
        // - h3-r2v 原生口型、无台词镜 → 跳过
        const needLipSync = hasLine && s0.render.lipSync && shot.type === 'i2v' &&
          (mode === 'wan' || mode === 'h3-i2v')
        let sourceRawAbs = rawAbsPath
        /** 口型失败回退原因（写入 renderProfile，队列进度也会展示） */
        let lipSyncFallback: string | undefined
        if (needLipSync && await this.lipSync.available()) {
          this.checkCancelled(projectId, shotId)
          this.emitProgress({ projectId, shotId, step: 'render', percent: 86, message: '口型同步中...' })
          try {
            const pre25Abs = path.join(this.baseDir, `projects/${projectId}/raw/${shotId}_25fps.mp4`)
            await this.ffmpeg.convertForLipSync(rawAbsPath, pre25Abs)
            const lipAbs = path.join(this.baseDir, `projects/${projectId}/raw/${shotId}_lipsync.mp4`)
            await this.lipSync.sync(
              pre25Abs,
              // 必须用带开口留白的音频驱动口型，与最终合轨同源，否则嘴型比声音早 lead 秒
              path.join(this.baseDir, syncAudioRelPath!),
              lipAbs,
              (percent) => this.emitProgress({
                projectId, shotId, step: 'render',
                percent: 86 + Math.round(percent * 0.04),
                message: `口型同步中... ${percent}%`
              })
            )
            sourceRawAbs = lipAbs
            await fs.unlink(pre25Abs).catch(() => undefined)
          } catch (lipErr) {
            if ((lipErr as Error).message === CANCEL_ERROR || this.cancelledShotIds.has(TaskQueue.shotKey(projectId, shotId))) {
              throw lipErr
            }
            const reason = lipErr instanceof Error ? lipErr.message : String(lipErr)
            lipSyncFallback = reason.slice(0, 120)
            log.warn(`LatentSync 失败，回退原片: ${reason}`)
            this.emitProgress({
              projectId, shotId, step: 'render', percent: 89,
              message: `口型同步失败，已用原片继续（${lipSyncFallback}）`
            })
          }
        }

        // 7. 制作统一规格分段
        // H3 原生音轨（r2v 人声 / 无台词 i2v 环境音）→ 直接归一化；
        // Wan 或走 LatentSync 的 H3 → 与 TTS 智能对齐合轨（leadSec=0，留白已在音频里）
        this.emitProgress({ projectId, shotId, step: 'combine', percent: 90, message: '合成段落...' })
        if (mode.startsWith('h3') && !needLipSync) {
          await this.ffmpeg.normalizeSegment(
            rawAbsPath,
            segmentAbsPath,
            (percent) => this.emitProgress({
              projectId, shotId, step: 'combine',
              percent: 90 + Math.round(percent * 0.1),
              message: `合成段落... ${percent}%`
            })
          )
        } else {
          await this.ffmpeg.prepareSegment(
            sourceRawAbs,
            syncAudioRelPath ? path.join(this.baseDir, syncAudioRelPath) : undefined,
            segmentAbsPath,
            (percent) => this.emitProgress({
              projectId, shotId, step: 'combine',
              percent: 90 + Math.round(percent * 0.1),
              message: `合成段落... ${percent}%`
            }),
            0
          )
        }
        // 合成（ffmpeg 分钟级）结束后的取消检查点：已取消镜头不得落 segmentPath 走到 done
        this.checkCancelled(projectId, shotId)
        shot.segmentPath = segmentRelPath

        // 渲染档案：记录本次生产最终生效的参数（OOM 降档/口型回退/重渲后均覆盖为最新）
        const lipProfile = computeLipProfile(mode, needLipSync, sourceRawAbs !== rawAbsPath)
        shot.seed = renderSeed
        shot.renderProfile = {
          engine: mode,
          workflow: workflowName,
          seed: renderSeed,
          frames: mode.startsWith('h3') ? h3Length : undefined,
          steps: mode.startsWith('h3') ? h3Steps : undefined,
          durationSec: mode === 'wan' ? wanDurationSec : undefined,
          oomDowngraded: oomDowngraded || undefined,
          lipSync: lipProfile,
          lipSyncFallback: lipSyncFallback || undefined,
          renderedAt: Date.now()
        }
      }

      // 渲染重试策略（每类重试各有独立预算，互不挤占）：
      // ① OOM → 先减帧/步/时长一次；再降分辨率档位一次
      // ② H3 原生口型失败（auto 路线）→ 回退 h3-i2v + LatentSync（仅非 OOM）
      // ③ 瞬时故障 → 指数退避最多 2 次
      let produced = false
      let transientRetries = 0
      let resDowngraded = false
      while (!produced) {
        this.checkCancelled(projectId, shotId)
        try {
          await runProduction()
          produced = true
        } catch (err) {
          const cancelled =
            (err instanceof Error && err.message === CANCEL_ERROR) ||
            this.cancelledShotIds.has(TaskQueue.shotKey(projectId, shotId)) || this.cancelledProjects.has(projectId)
          if (cancelled) throw err

          const isOOM = this.isOOMError(err)
          // 与原实现一致：OOM 错误（且未禁用 oomRetry）先中断 ComfyUI，再按决策动作重试
          if (s0.render.oomRetry !== false && isOOM) {
            await this.comfyui.interrupt().catch(() => undefined)
          }
          const decision = decideRetryAction({
            err,
            cancelled,
            isOOM,
            oomRetryEnabled: s0.render.oomRetry !== false,
            oomDowngraded,
            resDowngraded,
            canStepDownTier: stepDownVramTier(tier) != null,
            mode,
            lipMode,
            lipSyncEnabled: Boolean(s0.render.lipSync),
            transientRetries,
            isTransient: isTransientError(err)
          })

          if (decision.kind === 'oom-light') {
            oomDowngraded = true
            autoRetryCount++
            const downgraded = applyOomLightDowngrade(mode, { h3Length, h3Steps, wanDurationSec })
            h3Length = downgraded.h3Length
            h3Steps = downgraded.h3Steps
            wanDurationSec = downgraded.wanDurationSec
            this.emitProgress({
              projectId, shotId, step: 'render', percent: 20,
              message: `显存不足，已减负（${mode.startsWith('h3') ? `${h3Length}帧/8步` : `${wanDurationSec}秒`}）重试...`
            })
            continue
          }

          if (decision.kind === 'oom-tier') {
            const lower = stepDownVramTier(tier)!
            resDowngraded = true
            autoRetryCount++
            tier = lower
            const clamped = applyOomTierDowngrade(tier, h3Length, wanDurationSec)
            h3Length = clamped.h3Length
            wanDurationSec = clamped.wanDurationSec
            this.emitProgress({
              projectId, shotId, step: 'render', percent: 20,
              message: `显存仍不足，降分辨率至 ${tier.width}×${tier.height}（${tier.label}）重试...`
            })
            continue
          }

          if (decision.kind === 'r2v-fallback') {
            mode = 'h3-i2v'
            audioName = undefined
            this.emitProgress({
              projectId, shotId, step: 'render', percent: 20,
              message: 'H3 原生口型生成失败，回退 LatentSync 口型方案...'
            })
            continue
          }

          if (decision.kind === 'transient') {
            transientRetries++
            autoRetryCount++
            const delay = transientRetries * 4000
            this.emitProgress({
              projectId, shotId, step: 'render', percent: 20,
              message: `瞬时异常（${(err as Error).message.slice(0, 60)}），${delay / 1000}s 后自动重试（${transientRetries}/2）...`
            })
            // 超时类错误重试前先中断 ComfyUI 旧任务：否则旧 prompt 仍在跑，
            // 重提交会双份渲染浪费显存（单消费者设计下在渲的只会是本任务，interrupt 安全）
            if (/timeout|超时/i.test((err as Error).message)) {
              await this.comfyui.interrupt().catch(() => undefined)
            }
            // 退避 sleep 分片轮询取消标志：最长 8s 的等待必须可被取消打断
            const deadline = Date.now() + delay
            while (Date.now() < deadline) {
              this.checkCancelled(projectId, shotId)
              await new Promise(r => setTimeout(r, 200))
            }
            continue
          }

          throw err
        }
      }

      await this.ensureProjectThumbnail(projectId, segmentAbsPath)

      renderSeed = await runConsistencyCheckFn(this.consistencyRuntime, {
        projectId,
        shot,
        refImageRel,
        segmentAbsPath,
        consistencyMode: s0.render.consistencyMode || 'warn',
        renderSeed,
        engine: mode,
        reRun: async (seed, forceEngine) => {
          renderSeed = seed
          if (forceEngine) {
            const prev = mode
            mode = forceEngine as EngineMode
            // 兜底切 Wan 时，baseWorkflow 可能仍是 H3 工作流名（minimax_h3_*），
            // 强制替换为 Wan i2v 工作流，否则会用 H3 工作流跑 Wan 分支导致占位符报错
            if (forceEngine === 'wan') baseWorkflow = 'wan22_i2v'
            log.info(`[${shot.id}] 一致性兜底切换引擎 ${prev} → ${forceEngine}（工作流=${baseWorkflow}）`)
          }
          await runProduction()
        }
      })

      // 多候选渲染抽卡：再渲 N-1 条不同 seed，结合一致性分数 + LLM 留最优
      const editCfg = resolveCreation(s0).edit
      const wantCand = computeWantedCandidates(editCfg.renderCandidates)
      if (wantCand > 1 && this.picker) {
        const firstSeed = renderSeed
        const firstScore = typeof shot.consistencyScore === 'number' ? shot.consistencyScore : 0.5
        const c0Rel = `projects/${projectId}/segments/${shotId}_c0.mp4`
        const c0Abs = path.join(this.baseDir, c0Rel)
        await fs.copyFile(segmentAbsPath, c0Abs)
        const candSegs: Array<{ rel: string; seed: number; score: number }> = [{
          rel: c0Rel,
          seed: firstSeed,
          score: firstScore
        }]
        for (let ci = 1; ci < wantCand; ci++) {
          this.checkCancelled(projectId, shotId)
          const altSeed = Math.floor(Math.random() * 0xffffffff)
          const altRel = `projects/${projectId}/segments/${shotId}_c${ci}.mp4`
          const altAbs = path.join(this.baseDir, altRel)
          this.emitProgress({
            projectId, shotId, step: 'render', percent: 70,
            message: `渲染抽卡 ${ci + 1}/${wantCand}（seed 重试）...`
          })
          try {
            renderSeed = altSeed
            await runProduction()
            await fs.copyFile(segmentAbsPath, altAbs)
            let score = 0.5
            if (shot.type === 'i2v' && refImageRel) {
              try {
                const svc = this.getConsistencyService()
                if (await svc.available()) {
                  const r = await svc.compare(
                    this.resolveInBase(refImageRel),
                    altAbs,
                    0.5
                  )
                  score = r.score
                }
              } catch { /* ignore */ }
            }
            candSegs.push({ rel: altRel, seed: altSeed, score })
          } catch (e) {
            if ((e instanceof Error && e.message === CANCEL_ERROR) ||
              this.cancelledProjects.has(projectId) || this.cancelledShotIds.has(TaskQueue.shotKey(projectId, shotId))) {
              throw e
            }
            this.emitProgress({
              projectId, shotId, step: 'render', percent: 75,
              message: `抽卡候选 ${ci + 1} 失败已跳过`
            })
          }
        }
        if (candSegs.length > 1) {
          const picked = await this.picker.pick({
            kind: 'render',
            brief: `第${shot.index}镜 ${shot.scene}｜${shot.action.slice(0, 120)}｜台词:${shot.dialogue || '无'}`,
            candidates: candSegs.map((c, i) => ({
              id: `r${i}`,
              relativePath: c.rel,
              seed: c.seed,
              score: c.score,
              note: `consistency=${c.score.toFixed(3)}`
            })),
            llmPick: editCfg.llmPick
          })
          await fs.copyFile(path.join(this.baseDir, picked.winner.relativePath), segmentAbsPath)
          shot.seed = picked.winner.seed
          // 2026-10-25 修复（专家C P2-4/专家A P2-5）：抽卡 winner.score 是单帧 0.5s 排序口径，
          // 与主审 runConsistencyCheck（1062，3 帧平均+R2V 视频锚）口径不一致——不再覆盖
          // shot.consistencyScore（主审值已在主分段上按正式口径写入）；一致性 gate（approveShots/
          // auditSingleShot/lowConsistency）读主审值，避免被排序口径污染。winner 若需正式重算，
          // 走 recheckProjectConsistency（分镜页手动触发）。
          await this.picker.promoteWinner({
            baseDir: this.baseDir,
            winnerRel: picked.winner.relativePath,
            finalRel: segmentRelPath,
            rejectedRels: picked.rejected.map(r => r.relativePath),
            keepRejected: true
          })
          this.emitProgress({
            projectId, shotId, step: 'render', percent: 95,
            message: `渲染抽卡 ${candSegs.length}→1：${picked.reason}`
          })
        } else {
          // 仅保留主分段
          await fs.copyFile(c0Abs, segmentAbsPath).catch(() => undefined)
        }
      }

      // 完成
      shot.status = 'done'
      shot.error = undefined
      shot.errorKind = undefined
      shot.retryCount = undefined
      shot.retryBudget = undefined
      await this.patchShot(projectId, shot)
      this.emitProgress({ projectId, shotId, step: 'done', percent: 100, message: '完成' })

    } catch (error) {
      const isCancelled =
        (error instanceof Error && error.message === CANCEL_ERROR) ||
        this.cancelledProjects.has(projectId) ||
        this.cancelledShotIds.has(TaskQueue.shotKey(projectId, shotId))

      if (isCancelled) {
        shot.status = 'pending'
        shot.error = undefined
        shot.errorKind = undefined
        shot.retryCount = undefined
        shot.retryBudget = undefined
        await this.patchShot(projectId, shot)
        this.emitProgress({ projectId, shotId, step: 'queued', percent: 0, message: '已取消' })
      } else {
        shot.status = 'failed'
        shot.error = error instanceof Error ? error.message : String(error)
        // REQ-11 MP-04：结构化失败分层 + 自动重试次数，UI 据此出差异化引导
        shot.errorKind = classifyError(error)
        shot.retryCount = autoRetryCount
        shot.retryBudget = AUTO_RETRY_BUDGET
        await this.patchShot(projectId, shot)
        this.emitProgress({
          projectId, shotId, step: 'failed', percent: 100,
          message: shot.error, errorKind: shot.errorKind
        })
      }
    } finally {
      watcher.stop()
    }
  }

  /**
   * 快速生成（导演「直接做视频/图」入口，不依赖分镜流水线）：
   * 选任意已导入工作流 → 填占位符 → 提交 → 下载产物到 baseDir/quick/。
   * LLM 按用户意图自动选流：给图 → i2v/i2i；无图纯文字 → t2v/t2i；首尾帧 → flf2v。
   */
  async quickRender(params: {
    workflowName: string
    prompt: string
    refImageAbs?: string
    endImageAbs?: string
    seed?: number
    durationSec?: number
    width?: number
    height?: number
    onProgress?: (message: string, percent: number) => void
  }): Promise<{ outputAbs: string; promptId: string }> {
    const { workflowName, prompt, onProgress } = params
    if (!workflowName || !prompt) throw new Error('缺少 workflowName/prompt')
    const metas = await this.workflow.list()
    const meta = metas.find(w => w.name === workflowName)
    if (!meta) throw new Error(`工作流不存在：${workflowName}（用 list_workflows 查看可用模板）`)

    const vars: Record<string, string | number | boolean> = { PROMPT: prompt }
    if (params.seed !== undefined) vars.SEED = params.seed
    if (params.durationSec !== undefined && meta.hasDuration) vars.DURATION = params.durationSec
    // REMIX 等模板用 $FRAMES$（帧数）控制时长：DURATION 秒 → 帧数 ×16fps
    if (params.durationSec !== undefined && meta.placeholders.includes('FRAMES')) {
      vars.FRAMES = Math.max(1, Math.round(params.durationSec * 16))
    }
    if (params.width !== undefined && meta.placeholders.includes('WIDTH')) vars.WIDTH = params.width
    if (params.height !== undefined && meta.placeholders.includes('HEIGHT')) vars.HEIGHT = params.height
    // 双采模板：精修目标尺寸 WIDTH2/HEIGHT2 = 直出尺寸 ×1.5 向下对齐 32（H3 latent 对齐铁律）
    if (params.width !== undefined && meta.placeholders.includes('WIDTH2')) vars.WIDTH2 = Math.floor((params.width * 1.5) / 32) * 32
    if (params.height !== undefined && meta.placeholders.includes('HEIGHT2')) vars.HEIGHT2 = Math.floor((params.height * 1.5) / 32) * 32

    let imageName: string | undefined
    if (params.refImageAbs) {
      // S-06：LLM 可控参考图先过素材白名单，阻断敏感文件被当素材上传
      assertMediaPath(params.refImageAbs, 'image', '参考图', { requireAbsolute: true })
      onProgress?.('上传参考图...', 10)
      imageName = await this.comfyui.uploadImage(params.refImageAbs)
      vars.REF_IMAGE = imageName
    }
    if (params.endImageAbs) {
      assertMediaPath(params.endImageAbs, 'image', '尾帧图', { requireAbsolute: true })
      onProgress?.('上传尾帧图...', 12)
      vars.END_IMAGE = await this.comfyui.uploadImage(params.endImageAbs)
    }

    const graph = await this.workflow.buildGraph(workflowName, vars)

    // 提交前环境自检（缺节点/缺模型给中文错误）
    const objectInfo = await this.comfyui.getObjectInfo()
    const envIssues = this.workflow.validateBuiltGraph(workflowName, graph, objectInfo)
    if (envIssues.length) {
      throw new Error('工作流环境自检失败：\n' + envIssues.map(i => `· ${i.message}`).join('\n'))
    }

    onProgress?.('渲染中...', 20)
    const { promptId } = await this.comfyui.submit(graph)
    const s0 = await this.settings.get()
    const timeoutMs = Math.max(60, resolveCreation(s0).edit.comfyTimeoutSec || 600) * 1000
    const output = await this.comfyui.waitForCompletion(promptId, (pct) => {
      onProgress?.(`渲染中... ${pct}%`, 20 + Math.round(pct * 0.6))
    }, timeoutMs)

    // 下载产物（视频或图片，按实际输出类型决定扩展名）
    const item = this.comfyui.findVideoOutput(output)
    if (!item) throw new Error('ComfyUI 未输出任何文件')
    const outDir = path.join(this.baseDir, 'quick')
    await fs.mkdir(outDir, { recursive: true })
    const stamp = `${workflowName}_${Date.now()}`.replace(/[^\w一-龥-]/g, '_')
    const ext = /\.(mp4|webm|png|jpg|jpeg|webp)$/i.test(item.filename)
      ? item.filename.match(/\.(mp4|webm|png|jpg|jpeg|webp)$/i)![1]
      : item.type === 'output' ? 'mp4' : 'png'
    const outputAbs = path.join(outDir, `${stamp}.${ext}`)
    if (item.fullpath) {
      await this.comfyui.downloadFromFullPath(item.fullpath, outputAbs)
    } else {
      await this.comfyui.download(item.filename, item.subfolder, item.type, outputAbs)
    }
    onProgress?.('完成', 100)
    return { outputAbs, promptId }
  }
}
