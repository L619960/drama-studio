import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { ComfyUIClient, VRAM_TIERS, type VramTier } from './comfyuiClient'
import { WorkflowLoader } from './workflowLoader'
import { TTSService } from './ttsService'
import { FFmpegService } from './ffmpegService'
import { ProjectStore } from './projectStore'
import { SettingsStore } from './settingsStore'
import { LipSyncService } from './lipSyncService'
import { ConsistencyService, CONSISTENCY_THRESHOLD, FACE_CONSISTENCY_THRESHOLD, type LoadedRgb } from './consistencyService'
import { GENRE_TEMPLATES, SHOT_TIMING, type Project, type Shot, type ProgressEvent, type RenderProfile } from '../../shared/ipcTypes'
import { createLogger } from './logger'

const log = createLogger('TaskQueue')

interface QueuedTask {
  projectId: string
  shotId: string
}

const CANCEL_ERROR = '__CANCELLED__'

export class TaskQueue extends EventEmitter {
  private queue: QueuedTask[] = []
  private running = false
  /** 按项目粒度的取消集合（多项目混合队列互不影响） */
  private cancelledProjects = new Set<string>()
  private cancelledShotIds = new Set<string>()
  private current: QueuedTask | null = null
  private lastProjectId = ''
  /** 本轮 process 处理过的项目，排空后逐个收尾并发 queue-finished */
  private touchedProjects = new Set<string>()

  constructor(
    private baseDir: string,
    private comfyui: ComfyUIClient,
    private workflow: WorkflowLoader,
    private tts: TTSService,
    private ffmpeg: FFmpegService,
    private store: ProjectStore,
    private settings: SettingsStore
  ) {
    super()
    this.lipSync = new LipSyncService(comfyui, workflow)
  }

  private lipSync: LipSyncService
  /** 人物一致性校验（懒加载，依赖/模型不可用时自动降级为关闭） */
  private consistency: ConsistencyService | null = null

  private getConsistencyService(): ConsistencyService {
    if (!this.consistency) {
      const modelDir = path.join(this.baseDir, '.models')
      this.consistency = new ConsistencyService(modelDir, (src, timeSec, size) => this.loadRgb(src, timeSec, size))
    }
    return this.consistency
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
    await this.ffmpeg.ready()
    const project = await this.store.get(projectId)

    let targets: Shot[]
    if (shotIds && shotIds.length > 0) {
      targets = project.shots.filter(s => shotIds.includes(s.id))
    } else {
      targets = project.shots.filter(s => s.status === 'pending' || s.status === 'failed')
    }

    // 去重：已在队列或正在渲染的镜头不重复入队
    const queued = new Set(this.queue.map(t => t.shotId))
    if (this.current) queued.add(this.current.shotId)
    targets = targets.filter(s => !queued.has(s.id))

    for (const shot of targets) {
      shot.status = 'pending'
      shot.error = undefined
      this.queue.push({ projectId, shotId: shot.id })
    }

    if (targets.length > 0) {
      this.cancelledProjects.delete(projectId)
      project.status = 'rendering'
      await this.store.save(project)
      void this.process()
    } else {
      // 无目标也要发 queue-finished，避免 waitForFinish 永久挂起
      this.emit('queue-finished', { projectId })
    }
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
        this.cancelledShotIds.add(shotId)
        await this.comfyui.interrupt()
        while (this.current?.shotId === shotId) {
          await new Promise(r => setTimeout(r, 100))
        }
        this.cancelledShotIds.delete(shotId)
      }
      return
    }

    this.cancelledProjects.add(projectId)
    this.queue = this.queue.filter(t => t.projectId !== projectId)
    await this.comfyui.interrupt()
    while (this.running) {
      await new Promise(r => setTimeout(r, 100))
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
    let recovered = 0
    try {
      const projects = await this.store.list()
      for (const project of projects) {
        const staleShots = project.shots.filter(s => s.status === 'rendering')
        if (project.status !== 'rendering' && staleShots.length === 0) continue
        for (const shot of staleShots) {
          shot.status = 'pending'
          shot.error = '应用重启导致渲染中断，已恢复为待渲染，可重新续渲'
          recovered += 1
        }
        if (project.status === 'rendering') {
          const allDone = project.shots.length > 0 && project.shots.every(s => s.status === 'done')
          const anyFailed = project.shots.some(s => s.status === 'failed')
          project.status = allDone ? 'done' : anyFailed ? 'failed' : 'draft'
        }
        await this.store.save(project)
      }
      if (recovered > 0) {
        log.info(`断点续渲：${recovered} 个中断镜头已恢复为待渲染`)
      }
    } catch (e) {
      console.warn('[TaskQueue] 断点续渲扫描失败:', (e as Error).message)
    }
    return recovered
  }

  private async process(): Promise<void> {
    if (this.running) return
    this.running = true

    while (this.queue.length > 0) {
      const task = this.queue.shift()!
      // 项目级取消：跳过该项目的残留任务，不中断其他项目
      if (this.cancelledProjects.has(task.projectId)) continue
      this.current = task
      this.lastProjectId = task.projectId
      this.touchedProjects.add(task.projectId)
      await this.renderShot(task.projectId, task.shotId)
      this.current = null
    }

    this.running = false

    // 逐项目收尾：更新状态 + 通知编排者
    const finished = [...this.touchedProjects]
    this.touchedProjects.clear()
    for (const pid of finished) {
      try {
        const project = await this.store.get(pid)
        if (this.cancelledProjects.has(pid) || project.shots.length === 0) {
          project.status = 'draft'
        } else {
          const anyFailed = project.shots.some(s => s.status === 'failed')
          const allDone = project.shots.every(s => s.status === 'done')
          project.status = allDone ? 'done' : anyFailed ? 'failed' : 'draft'
        }
        await this.store.save(project)
      } catch {
        // 忽略
      }
      this.emit('queue-finished', { projectId: pid })
    }

    // 取消等待期间又有新任务入队（start 时 running=true 被跳过）：补一轮消费
    if (this.queue.length > 0) {
      void this.process()
    }
  }

  /**
   * 供 AI 导演编排：等待指定项目的队列排空。
   * 必须在 start() 之后调用（事件在排空后才发出，不存在错过竞态）。
   */
  waitForFinish(projectId: string): Promise<void> {
    return new Promise((resolve) => {
      const handler = (p: { projectId: string }): void => {
        if (p.projectId !== projectId) return
        this.off('queue-finished', handler)
        resolve()
      }
      this.on('queue-finished', handler)
    })
  }

  private emitProgress(e: Omit<ProgressEvent, 'type'>): void {
    this.emit('progress', { ...e, type: 'project:progress' } as ProgressEvent)
  }

  /**
   * 构建 H3 结构化提示词（integrated_multimodal_description 格式，H3 模型训练格式）：
   * - 五元组：场景/人物 + 情绪(mood) + 机位运镜(camera) + 动作(action)
   * - i2v：场景/人物参考 <Picture 1> + 环境音描述
   * - r2v：额外注入台词 <d>[Chinese]...</d> 与参考音频 <Audio 1>，驱动口型与音色
   */
  private buildH3Prompt(shot: Shot, project: Project, withAudio: boolean): string {
    const tpl = GENRE_TEMPLATES.find(t => t.key === project.genre)
    const style = tpl ? `${tpl.promptStyle}. ` : ''
    const subject = shot.type === 'i2v' && shot.characterIds.length
      ? 'The person shown in <Picture 1>, appearance and clothing fully preserved'
      : 'The scene shown in <Picture 1>, fully preserved'
    const mood = shot.emotion ? ` Mood: ${shot.emotion}.` : ''
    const camera = shot.camera ? ` Camera: ${shot.camera}, stable framing.` : ''
    if (withAudio) {
      return `integrated_multimodal_description: [Shot 1] Live-action, cinematic. ${style}${subject}.${mood}${camera} At 0.4 seconds, says: <d>[Chinese] ${shot.dialogue}</d> Lips move naturally in sync with the Mandarin speech of reference audio <Audio 1>. ${shot.action}. overall_soundscape: natural ambience. non_diegetic_music: N/A`
    }
    return `integrated_multimodal_description: [Shot 1] Live-action, cinematic. ${style}${subject}.${mood}${camera} ${shot.action}. overall_soundscape: natural ambience. non_diegetic_music: N/A`
  }

  /** 识别 ComfyUI 显存不足类错误（OOM/显存分配失败） */
  private isOOMError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err)
    return /out of memory|oom|cuda error|alloc.*(memory|failed)|vram|hbm|显存不足|内存不足/i.test(msg)
  }

  /** 只回写单个镜头的字段（基于磁盘最新数据），不覆盖其他并发修改 */
  private async patchShot(projectId: string, shot: Shot): Promise<void> {
    await this.store.update(projectId, draft => {
      const idx = draft.shots.findIndex(s => s.id === shot.id)
      if (idx >= 0) draft.shots[idx] = { ...shot }
    })
  }

  /** 同步检查点：若项目或镜头已被取消则立即抛出 */
  private checkCancelled(projectId: string, shotId: string): void {
    if (this.cancelledProjects.has(projectId) || this.cancelledShotIds.has(shotId)) {
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
    let timer: NodeJS.Timeout
    const promise = new Promise<never>((_, reject) => {
      timer = setInterval(() => {
        if (this.cancelledProjects.has(projectId) || this.cancelledShotIds.has(shotId)) {
          reject(new Error(CANCEL_ERROR))
        }
      }, 150)
    })
    return { promise, stop: () => clearInterval(timer) }
  }

  /** 相对路径（新规范）或绝对路径（旧数据兼容）→ 绝对路径 */
  private resolveInBase(p: string): string {
    return path.isAbsolute(p) ? p : path.join(this.baseDir, p)
  }

  /**
   * 设置页数字(50-200 / 0-100)转 msedge-tts 百分比字符串。
   * 100 → '+0%'，150 → '+50%'，50 → '-50%'
   */
  private toPercent(value: number): string {
    const v = Math.round(value) - 100
    return `${v >= 0 ? '+' : ''}${v}%`
  }

  private async renderShot(projectId: string, shotId: string): Promise<void> {
    this.lastProjectId = projectId
    const project = await this.store.get(projectId)
    const shot = project.shots.find(s => s.id === shotId)
    if (!shot) return

    shot.status = 'rendering'
    await this.patchShot(projectId, shot)

    const watcher = this.cancellationWatcher(projectId, shotId)

    try {
      // 0. 空镜(t2v)：有场景参考图时按图生视频处理；无图则拦截
      //    （内置工作流为纯 I2V，LoadImage / start_image 必需）
      if (shot.type === 't2v' && !shot.sceneImagePath) {
        throw new Error('空镜缺少场景参考图，请在分镜编辑中上传场景参考图')
      }

      // 1. 定位参考图：空镜 → 场景首帧；人物镜 → 镜头专用首帧（缺失回退角色定妆照）
      let refImageRel: string
      if (shot.type === 't2v') {
        refImageRel = shot.sceneImagePath!
      } else {
        const character = project.characters.find(c => c.id === shot.characterIds[0])
        if (!character) {
          throw new Error('该镜头未绑定角色，无法图生视频')
        }
        if (shot.firstFramePath) {
          refImageRel = shot.firstFramePath
        } else {
          if (!character.refImagePath) {
            throw new Error(`角色「${character.name}」缺少定妆图`)
          }
          refImageRel = character.refImagePath
        }
      }

      // 2. TTS（仅有台词时）
      let audioRelPath: string | undefined
      let audioSec: number | undefined
      if (shot.dialogue.trim()) {
        this.checkCancelled(projectId, shotId)
        this.emitProgress({ projectId, shotId, step: 'tts', percent: 0, message: '生成语音中...' })
        const rel = `projects/${projectId}/audio/${shotId}.mp3`
        // 语速/音量：优先角色级 voiceRate，否则取全局设置；数字(50-200/0-100)转 msedge-tts 字符串
        const s = await this.settings.get()
        // 空镜 TTS 无角色绑定，用全局默认音色；人物镜用角色音色
        const character = shot.type === 't2v' ? undefined : project.characters.find(c => c.id === shot.characterIds[0])
        const rate = character?.voiceRate || this.toPercent(s.tts.rate)
        const volume = this.toPercent(s.tts.volume)
        const voice = character?.voice || s.tts.defaultVoice
        audioRelPath = await Promise.race([
          this.tts.generate(shot.dialogue, voice, rel, rate, volume),
          watcher.promise
        ])
        shot.audioPath = audioRelPath
        audioSec = await this.ffmpeg.getDuration(this.resolveInBase(audioRelPath))
      }

      // 2.5 音频前置留白：后续 LatentSync 口型驱动与最终合轨共用这一条，
      // 保证「嘴型延迟」与「声音延迟」一致，且定帧按纯语音时长计算（见下）
      let syncAudioRelPath: string | undefined
      if (audioRelPath) {
        syncAudioRelPath = `projects/${projectId}/audio/${shotId}_leaded.mp3`
        await this.ffmpeg.padAudioLead(
          this.resolveInBase(audioRelPath),
          this.resolveInBase(syncAudioRelPath),
          SHOT_TIMING.audioLeadSec
        )
      }

      // 动态帧数口径（Wan2.2 帧数 = 秒*16+1，渲染前最终定帧）：
      // - 有台词：画面 = 开口留白 + 语音 + 反应余量，人物先入画再开口、说完不立刻切
      // - 无台词：不低于 minSec，情绪/空镜也有足够停留，避免全片 2~3 秒快切
      // - 上限 maxSec 防异常长句；不低于设置里的默认帧数秒数
      {
        const defaultSec = Math.max(1, Math.round((shot.frames - 1) / 16))
        const needSec = audioSec !== undefined
          ? Math.ceil(audioSec + SHOT_TIMING.audioLeadSec + SHOT_TIMING.audioTailSec)
          : 0
        const finalSec = Math.min(
          SHOT_TIMING.maxSec,
          Math.max(defaultSec, SHOT_TIMING.minSec, needSec)
        )
        shot.frames = finalSec * 16 + 1
        await this.patchShot(projectId, shot)
      }

      // 3. 上传参考图（定妆图或场景图）
      this.checkCancelled(projectId, shotId)
      this.emitProgress({ projectId, shotId, step: 'upload', percent: 10, message: '上传参考图...' })
      const imageName = await this.comfyui.uploadImage(this.resolveInBase(refImageRel))

      // 4. 选择引擎与口型技术路线（优先级：分镜指定 > 项目默认 > 全局设置默认 > 'wan22_i2v'）
      this.emitProgress({ projectId, shotId, step: 'render', percent: 15, message: '构建工作流...' })
      const s0 = await this.settings.get()
      const baseWorkflow = shot.workflow || project.defaultWorkflow || s0.workflow.default || 'wan22_i2v'
      const preferH3 = baseWorkflow.startsWith('minimax_h3')
      const hasLine = Boolean(shot.dialogue.trim() && syncAudioRelPath)
      const lipMode = s0.render.lipSyncMode || 'auto'

      // 显存档位：auto 时按 ComfyUI 实际显存探测（5 分钟缓存），手动档位强制；
      // 只决定初始分辨率/帧长上限，OOM 退避仍会在此基础上继续降档
      const manualTier = s0.render.resolutionTier
      const tier: VramTier = manualTier && manualTier !== 'auto'
        ? VRAM_TIERS[manualTier] ?? await this.comfyui.getVramTier()
        : await this.comfyui.getVramTier()

      type EngineMode = 'h3-r2v' | 'h3-i2v' | 'wan'
      // auto：H3 台词镜走原生口型 r2v；latentsync：强制 i2v+LatentSync；h3-native：r2v 不回退
      let mode: EngineMode = preferH3
        ? (hasLine && lipMode !== 'latentsync' ? 'h3-r2v' : 'h3-i2v')
        : 'wan'

      // 时长参数（OOM 降档时会被压缩；初始上限受显存档位约束）
      let wanDurationSec = Math.min(tier.maxWanSec, Math.max(1, Math.round((shot.frames - 1) / 16)))
      const h3NeedSec = audioSec !== undefined
        ? audioSec + SHOT_TIMING.audioLeadSec + SHOT_TIMING.audioTailSec
        : Math.max(2, Math.round((shot.frames - 1) / 16))
      let h3Length = Math.min(tier.maxFrames, 17 * Math.max(3, Math.ceil((h3NeedSec * 24 - 5) / 17)) + 5)
      let h3Steps = 10
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
      const runProduction = async (): Promise<void> => {
        let graph: Record<string, unknown>
        let workflowName: string

        if (mode === 'wan') {
          // ===== Wan 引擎 =====
          workflowName = baseWorkflow
          const tpl = GENRE_TEMPLATES.find(t => t.key === project.genre)
          const talkCue = shot.dialogue
            ? ', talking, lips moving naturally while speaking, expressive facial expression'
            : ''
          // 五元组：情绪 + 机位运镜显式入词
          const emoCue = shot.emotion ? `, ${shot.emotion} expression` : ''
          const camCue = shot.camera ? `, ${shot.camera}` : ''
          const prompt = (tpl ? `${tpl.promptStyle}, ${shot.action}` : shot.action) + emoCue + camCue + talkCue
          graph = await this.workflow.buildGraph(workflowName, {
            PROMPT: prompt,
            REF_IMAGE: imageName,
            SEED: renderSeed,
            DURATION: wanDurationSec
          })
        } else {
          // ===== H3 引擎：r2v（原生口型）或 i2v（原生环境音）=====
          // EngineMode → 实际工作流文件名映射
          workflowName = mode === 'h3-r2v' ? 'minimax_h3_r2v' : 'minimax_h3_i2v'
          if (mode === 'h3-r2v' && !audioName) {
            this.checkCancelled(projectId, shotId)
            this.emitProgress({ projectId, shotId, step: 'upload', percent: 12, message: '上传参考音频...' })
            audioName = await this.comfyui.uploadAudio(this.resolveInBase(syncAudioRelPath!), s0.comfyui.inputDir)
          }
          const vars: Record<string, string | number> = {
            PROMPT: this.buildH3Prompt(shot, project, mode === 'h3-r2v'),
            REF_IMAGE: imageName,
            SEED: renderSeed,
            WIDTH: tier.width,
            HEIGHT: tier.height,
            LENGTH: h3Length,
            PREFIX: `drama/${projectId}`
          }
          if (audioName && mode === 'h3-r2v') vars.AUDIO = audioName
          graph = await this.workflow.buildGraph(workflowName, vars)
          const sched = graph['42'] as { inputs?: Record<string, unknown> } | undefined
          if (sched?.inputs) sched.inputs.steps = h3Steps
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
        const output = await Promise.race([
          this.comfyui.waitForCompletion(promptId, (percent) => {
            this.emitProgress({
              projectId, shotId, step: 'render',
              percent: 20 + Math.round(percent * 0.6),
              message: `渲染中... ${percent}%`
            })
          }),
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
        shot.rawVideoPath = rawRelPath

        // 6.5 口型同步：
        // - wan 引擎台词镜 → LatentSync
        // - 强制 latentsync 路线 / r2v 失败回退的 h3-i2v 台词镜 → LatentSync 补口型
        // - h3-r2v 原生口型、无台词镜 → 跳过
        const needLipSync = hasLine && s0.render.lipSync && shot.type === 'i2v' &&
          (mode === 'wan' || mode === 'h3-i2v')
        let sourceRawAbs = rawAbsPath
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
            if ((lipErr as Error).message === CANCEL_ERROR || this.cancelledShotIds.has(shotId)) {
              throw lipErr
            }
            console.warn('[TaskQueue] LatentSync 失败，回退原片:', (lipErr as Error).message)
            this.emitProgress({ projectId, shotId, step: 'render', percent: 89, message: '口型同步失败，使用原片' })
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
        shot.segmentPath = segmentRelPath

        // 渲染档案：记录本次生产最终生效的参数（OOM 降档/口型回退/重渲后均覆盖为最新）
        const lipProfile: RenderProfile['lipSync'] =
          mode === 'h3-r2v'
            ? 'native'
            : (needLipSync && sourceRawAbs !== rawAbsPath)
              ? 'latentsync'
              : 'none'
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
          renderedAt: Date.now()
        }
      }

      // 渲染重试策略（最多 3 次生产）：
      // ① OOM → 自动降档（H3 减帧/8步，Wan 减 2 秒）一次
      // ② H3 原生口型失败（auto 路线）→ 回退 h3-i2v + LatentSync
      let produced = false
      for (let attempt = 0; attempt < 3 && !produced; attempt++) {
        this.checkCancelled(projectId, shotId)
        try {
          await runProduction()
          produced = true
        } catch (err) {
          const cancelled =
            (err instanceof Error && err.message === CANCEL_ERROR) ||
            this.cancelledShotIds.has(shotId) || this.cancelledProjects.has(projectId)
          if (cancelled) throw err

          if (s0.render.oomRetry !== false && this.isOOMError(err) && !oomDowngraded) {
            oomDowngraded = true
            await this.comfyui.interrupt().catch(() => undefined)
            if (mode.startsWith('h3')) {
              h3Length = Math.max(56, h3Length - 17)
              h3Steps = 8
            } else {
              wanDurationSec = Math.max(2, wanDurationSec - 2)
            }
            this.emitProgress({
              projectId, shotId, step: 'render', percent: 20,
              message: `显存不足，已自动降档（${mode.startsWith('h3') ? `${h3Length}帧/8步` : `${wanDurationSec}秒`}）重试...`
            })
            continue
          }

          if (mode === 'h3-r2v' && lipMode === 'auto' && s0.render.lipSync) {
            mode = 'h3-i2v'
            audioName = undefined
            this.emitProgress({
              projectId, shotId, step: 'render', percent: 20,
              message: 'H3 原生口型生成失败，回退 LatentSync 口型方案...'
            })
            continue
          }

          throw err
        }
      }
      if (!produced) throw new Error('渲染失败（重试次数耗尽）')

      // 7.5 生成项目缩略图：仅当尚无缩略图时，取本镜（首个完成镜头）第一帧
      const thumbRelPath = `projects/${projectId}/thumbnail.jpg`
      const thumbAbsPath = path.join(this.baseDir, thumbRelPath)
      const thumbExists = await this.ffmpeg.fileExists(thumbAbsPath)
      if (!thumbExists) {
        try {
          await this.ffmpeg.extractFirstFrame(segmentAbsPath, thumbAbsPath)
        } catch {
          // 缩略图生成失败不阻塞渲染流程
        }
      }

      // 7.6 人物一致性校验（人物镜：末帧 vs 参考首帧，CLIP 余弦）
      // warn：低分仅告警；rerender：低分换 seed 自动重渲一次，仍低则保留并告警
      if (shot.type === 'i2v' && s0.render.consistencyMode !== 'off') {
        const service = this.getConsistencyService()
        if (await service.available()) {
          let score: number | undefined
          let method: 'face' | 'full' = 'full'
          try {
            this.emitProgress({
              projectId, shotId, step: 'combine', percent: 97,
              message: service.needsDownload ? '首次加载人物一致性模型（约90MB）...' : '人物一致性校验...'
            })
            const dur = await this.ffmpeg.getDuration(segmentAbsPath)
            const result = await service.compare(
              this.resolveInBase(refImageRel),
              segmentAbsPath,
              Math.max(0.1, dur * 0.9)
            )
            score = result.score
            method = result.method
            shot.consistencyScore = Math.round(score * 1000) / 1000
            log.info(`一致性 ${shotId}：${method === 'face' ? '人脸' : '全图'}相似度 ${score.toFixed(3)}`)
          } catch (e) {
            console.warn('[TaskQueue] 一致性校验跳过:', (e as Error).message)
          }

          if (score !== undefined && score < (method === 'face' ? FACE_CONSISTENCY_THRESHOLD : CONSISTENCY_THRESHOLD)) {
            const modeText = method === 'face' ? '人脸' : '全图'
            const warnMsg = `${modeText}相似度 ${score.toFixed(2)} 偏低，可能存在面部/造型漂移`
            if (s0.render.consistencyMode === 'rerender') {
              renderSeed = Math.floor(Math.random() * 0xffffffff)
              shot.seed = renderSeed
              this.emitProgress({
                projectId, shotId, step: 'render', percent: 20,
                message: `${warnMsg}，换 seed 自动重渲一次...`
              })
              await runProduction()
              // 重渲后复评一次（仅记录，不再触发重渲）
              try {
                const dur2 = await this.ffmpeg.getDuration(segmentAbsPath)
                const result2 = await service.compare(
                  this.resolveInBase(refImageRel),
                  segmentAbsPath,
                  Math.max(0.1, dur2 * 0.9)
                )
                shot.consistencyScore = Math.round(result2.score * 1000) / 1000
                if (result2.score < (result2.method === 'face' ? FACE_CONSISTENCY_THRESHOLD : CONSISTENCY_THRESHOLD)) {
                  this.emitProgress({
                    projectId, shotId, step: 'combine', percent: 99,
                    message: `重渲后${result2.method === 'face' ? '人脸' : '全图'}相似度 ${result2.score.toFixed(2)} 仍偏低，已保留（可手动重渲该镜）`
                  })
                }
              } catch {
                // 复评失败不阻塞
              }
            } else {
              this.emitProgress({
                projectId, shotId, step: 'combine', percent: 99,
                message: `${warnMsg}（已保留，可手动重渲该镜）`
              })
            }
          }
        }
      }

      // 8. 完成
      shot.status = 'done'
      shot.error = undefined
      await this.patchShot(projectId, shot)
      this.emitProgress({ projectId, shotId, step: 'done', percent: 100, message: '完成' })

    } catch (error) {
      const isCancelled =
        (error instanceof Error && error.message === CANCEL_ERROR) ||
        this.cancelledProjects.has(projectId) ||
        this.cancelledShotIds.has(shotId)

      if (isCancelled) {
        shot.status = 'pending'
        shot.error = undefined
        await this.patchShot(projectId, shot)
        this.emitProgress({ projectId, shotId, step: 'queued', percent: 0, message: '已取消' })
      } else {
        shot.status = 'failed'
        shot.error = error instanceof Error ? error.message : String(error)
        await this.patchShot(projectId, shot)
        this.emitProgress({ projectId, shotId, step: 'failed', percent: 100, message: shot.error })
      }
    } finally {
      watcher.stop()
    }
  }
}
