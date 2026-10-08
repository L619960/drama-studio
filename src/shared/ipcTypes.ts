// ===== 数据模型 =====
export interface Project {
  id: string
  title: string
  genre: string
  episode: number
  status: 'draft' | 'rendering' | 'done' | 'failed'
  characters: Character[]
  shots: Shot[]
  fps: number
  defaultWorkflow?: string  // 项目默认工作流（未设则用全局默认）
  bgmPath?: string          // BGM 音频相对路径（M4 混音）
  bgmVolume?: number        // BGM 音量 0-100
  createdAt: number
  updatedAt: number
}

export interface Character {
  id: string
  name: string
  refImagePath: string
  description: string
  voice: string
  voiceRate?: string
  /**
   * 角色卡锁定短语（英文，来自拆镜 lookEn）：定妆图与每镜首帧图逐字复用的唯一外观来源，
   * 含脸型/发型/锁定服装/高辨识度锚点，防止跨镜重采样漂移（2026 业界 Character Card 做法）
   */
  appearanceLock?: string
}

export type ShotType = 'i2v' | 't2v'

/** 景别：特写（面部/手部细节）/ 中景（腰部以上，对话表演）/ 远景（环境与全身动作） */
export type ShotSize = 'closeup' | 'medium' | 'wide'

/**
 * 镜头时长口径（taskQueue 动态定帧 / ffmpeg 音频留白 / 字幕时间轴共用同一组常量）。
 * Wan2.2 工作流帧数约束 16n+1，时长秒数 = (frames-1)/16。
 */
export const SHOT_TIMING = {
  /** 每镜最短时长（秒）：无台词的情绪/空镜也不短于该值，避免节奏过赶 */
  minSec: 4,
  /** 每镜时长硬上限（秒），防异常长句把单镜拉得过长（10s = 161 帧） */
  maxSec: 10,
  /** 开口前留白（秒）：台词相对镜入延迟，人物先入画、稳定后再开口 */
  audioLeadSec: 0.4,
  /** 说完留反应（秒）：语音结束到切镜的最小余量，尾音不贴切点 */
  audioTailSec: 1.2
} as const

/**
 * 实际渲染参数档案：成片可复现 / 问题追溯。每次生产成功后覆盖写入，
 * 一致性重渲、OOM 降档、口型回退后均反映最终生效参数。
 */
export interface RenderProfile {
  engine: 'h3-r2v' | 'h3-i2v' | 'wan'
  /** 实际提交的工作流模板名 */
  workflow: string
  seed: number
  /** H3 实际帧数（17k+5 网格，OOM 降档后变小） */
  frames?: number
  /** H3 采样步数（常规 10，OOM 降档为 8） */
  steps?: number
  /** Wan 实际时长（秒） */
  durationSec?: number
  /** 是否经历 OOM 自动降档 */
  oomDowngraded?: boolean
  /** 口型方案：H3 r2v 原生 / LatentSync 补口型 / 无（空镜或未做） */
  lipSync: 'native' | 'latentsync' | 'none'
  renderedAt: number
}

export interface Shot {
  id: string
  index: number
  scene: string
  action: string
  dialogue: string
  characterIds: string[]
  type: ShotType
  width: number
  height: number
  frames: number
  seed: number
  workflow?: string  // 分镜指定工作流（未设则用项目默认）
  sceneImagePath?: string  // 场景参考图相对路径（空镜 t2v 图生视频用）
  shotSize?: ShotSize       // 景别（AI 拆镜给出，决定首帧构图）
  firstFramePath?: string  // 镜头专用首帧图（场景+角色+姿态），i2v 优先使用，缺失时回退定妆照
  /** 五元组·镜头语言：英文机位/运镜短语（static close-up, slow push-in, handheld 等） */
  camera?: string
  /** 五元组·情绪：英文情绪短语（tense, heartbroken, relieved 等），驱动表演与光影 */
  emotion?: string
  /** 末帧人物一致性相似度（0~1，CLIP 余弦），仅人物镜渲染后填充 */
  consistencyScore?: number
  /** 实际渲染参数档案（引擎/seed/帧数/口型路径等），每次生产成功后覆盖 */
  renderProfile?: RenderProfile
  status: 'pending' | 'rendering' | 'done' | 'failed'
  audioPath?: string
  rawVideoPath?: string
  segmentPath?: string
  error?: string
}

// ===== 进度事件 =====
export interface ProgressEvent {
  type: 'project:progress'
  projectId: string
  shotId: string
  step: 'queued' | 'tts' | 'upload' | 'render' | 'combine' | 'done' | 'failed'
  percent: number
  message: string
  etaSeconds?: number
}

// ===== ComfyUI WebSocket 消息类型 =====
export type ComfyWSMessage =
  | { type: 'status'; data: { status: { exec_info: { queue_remaining: number } }; sid?: string } }
  | { type: 'execution_start'; data: { prompt_id: string; timestamp: number } }
  | { type: 'execution_cached'; data: { prompt_id: string; timestamp: number; nodes: string[] } }
  | { type: 'executing'; data: { node: string | null; prompt_id: string; display_node?: string } }
  | { type: 'executed'; data: { node: string; prompt_id: string; output: { images?: Array<{ filename: string; subfolder: string; type: string }> } } }
  | { type: 'progress'; data: { value: number; max: number; prompt_id: string; node: string } }
  | { type: 'execution_success'; data: { prompt_id: string; timestamp: number } }
  | { type: 'execution_error'; data: { prompt_id: string; exception_message: string; traceback: string[] } }

// ===== ComfyUI 输出类型（适配 Wan2.2 工作流）=====
export interface ComfyUIOutputItem {
  filename: string
  subfolder: string
  type: string
  format?: string
  frame_rate?: number
  workflow?: string
  fullpath?: string
}

export interface ComfyUIHistoryOutput {
  images?: ComfyUIOutputItem[]
  videos?: ComfyUIOutputItem[]
  gifs?: ComfyUIOutputItem[]
  [key: string]: ComfyUIOutputItem[] | undefined
}

// ===== IPC API 契约 =====
export interface IpcApi {
  project: {
    list(): Promise<Project[]>
    create(title: string, genre: string): Promise<Project>
    get(id: string): Promise<Project>
    save(project: Project): Promise<void>
    delete(id: string): Promise<void>
    duplicate(id: string): Promise<Project>
    importBgm(projectId: string): Promise<string>  // 选择并复制 BGM 到项目目录，返回相对路径
  }
  character: {
    importImage(projectId: string): Promise<string>
  }
  render: {
    start(projectId: string, shotIds?: string[]): Promise<void>
    cancel(projectId: string, shotId?: string): Promise<void>
  }
  comfyui: {
    healthCheck(): Promise<boolean>
    getSystemStats(): Promise<ComfySystemStats | null>
    /** 已安装节点类名全集（GET /object_info 的 keys，主进程瘦身） */
    getObjectNodeNames(): Promise<string[]>
    /** 校验全部工作流模板：缺失节点/缺失模型 */
    validateWorkflows(): Promise<WorkflowCheckReport[]>
  }
  memory: {
    list(kind?: MemoryKind): Promise<MemoryItem[]>
    create(input: { kind: MemoryKind; title: string; content: string }): Promise<MemoryItem>
    update(id: string, patch: Partial<Pick<MemoryItem, 'title' | 'content' | 'kind'>>): Promise<void>
    remove(id: string): Promise<void>
  }
  ffmpeg: {
    concat(segmentPaths: string[], outputPath: string): Promise<string>
    mergeVideoAudio(videoPath: string, audioPath: string, outputPath: string): Promise<string>
    getDuration(filePath: string): Promise<number>
    burnSubtitles(videoPath: string, srtPath: string, outputPath: string): Promise<string>
    mixBgm(videoPath: string, bgmPath: string, outputPath: string, bgmVolume: number): Promise<string>
  }
  llm: {
    test(): Promise<string>
    translatePrompt(input: { scene: string; action: string; dialogue: string; genre: string }): Promise<string>
    splitScript(script: string, genre: string): Promise<GeneratedShot[]>
  }
  shot: {
    importSceneImage(projectId: string): Promise<string>
  }
  subtitle: {
    generate(projectId: string): Promise<string>  // 生成 SRT，返回相对路径
  }
  file: {
    exists(relativePath: string): Promise<boolean>
    getSize(relativePath: string): Promise<number>
    copy(relativePath: string, absoluteTarget: string): Promise<void>
    delete(relativePath: string): Promise<void>
    resolvePath(relativePath: string): Promise<string>
  }
  shell: {
    showItem(relativePath: string): Promise<void>
  }
  tts: {
    preview(voice: string): Promise<string>
  }
  workflow: {
    list(): Promise<WorkflowMeta[]>
    getMeta(name: string): Promise<WorkflowMeta>
    import(absolutePath: string): Promise<string>  // 导入工作流 JSON，返回工作流名称
    getParams(name: string): Promise<WorkflowParam[]>
    updateParam(name: string, nodeId: string, key: string, value: string | number | boolean): Promise<void>
  }
  image: {
    generate(prompt: string, relativeOutput: string, workflowName?: string): Promise<string>
    checkpoints(): Promise<string[]>
  }
  director: {
    start(input: DirectorStartInput): Promise<string>  // 返回 projectId
    cancel(projectId: string): Promise<void>
    /** 请求暂停：当前阶段结束后停在确认点（不中断进行中的渲染） */
    pause(projectId: string): Promise<void>
    /** 从确认点继续 */
    resume(projectId: string): Promise<void>
    getState(projectId: string): Promise<DirectorState | null>
    onProgress(cb: (e: DirectorProgressEvent) => void): () => void
    onLog(cb: (e: DirectorLogEvent) => void): () => void
  }
  skills: {
    list(): Promise<Skill[]>
    create(input: { name: string; description: string; promptTemplate: string }): Promise<Skill>
    update(id: string, patch: Partial<Pick<Skill, 'name' | 'description' | 'enabled' | 'promptTemplate'>>): Promise<void>
    remove(id: string): Promise<void>
    toggle(id: string, enabled: boolean): Promise<void>
  }
  conversation: {
    list(scope: string): Promise<ConversationMessage[]>
    send(scope: string, text: string): Promise<ConversationMessage[]>
    clear(scope: string): Promise<void>
    onToolEvent(cb: (e: ConversationToolEvent) => void): () => void
  }
  settings: {
    get(): Promise<AppSettings | null>
    save(settings: AppSettings): Promise<void>
  }
  dialog: {
    selectDirectory(): Promise<string | null>
    selectFile(): Promise<string | null>
    selectAudio(): Promise<string | null>
    saveFile(defaultName: string): Promise<string | null>
  }
  onProgress(cb: (e: ProgressEvent) => void): () => void
}

// ===== 工作流元数据 =====
export interface WorkflowMeta {
  name: string
  placeholders: string[]
  hasImageInput: boolean
  hasDuration: boolean
}

/** 工作流中可编辑的参数项 */
export interface WorkflowParam {
  nodeId: string
  nodeTitle: string
  classType: string
  key: string
  value: string | number | boolean
  type: 'string' | 'number' | 'boolean'
  isPlaceholder: boolean  // 值为 $XXX$ 占位符（只读）
  isConnection: boolean   // 值为节点连接引用数组（只读）
}

// ===== 工作流环境自检报告 =====
export interface WorkflowCheckIssue {
  kind: 'missing-node' | 'missing-model' | 'unknown'
  nodeId: string
  classType: string
  /** missing-node：缺失的节点类名；missing-model：缺失的模型文件名；附带的输入键名写在 inputKey */
  message: string
  inputKey?: string
}

export interface WorkflowCheckReport {
  workflow: string
  ok: boolean
  issues: WorkflowCheckIssue[]
}

// ===== 设置数据模型 =====
export interface AppSettings {
  general: {
    dataDir: string
    autoSave: boolean
  }
  render: {
    defaultWidth: number
    defaultHeight: number
    defaultFrames: number
    timeout: number
    lipSync: boolean  // 有台词镜头渲染后做音频驱动口型同步（需 ComfyUI 装 LatentSync 节点）
    /** 口型技术路线：auto=按引擎自动(H3原生口型, Wan走LatentSync)；latentsync=强制LatentSync；h3-native=仅H3原生口型不回退 */
    lipSyncMode: 'auto' | 'latentsync' | 'h3-native'
    /** 显存不足(OOM)时自动降帧数/步数重试一次 */
    oomRetry: boolean
    /** 人物一致性校验：off=关闭；warn=低相似度仅告警；rerender=低相似度换seed自动重渲一次 */
    consistencyMode: 'off' | 'warn' | 'rerender'
    /** 显存档位：auto=按 ComfyUI 显存自动定分辨率/帧长上限；其余为手动强制档位 */
    resolutionTier: 'auto' | 'low' | 'mid' | 'standard' | 'high' | 'ultra'
  }
  comfyui: {
    baseUrl: string
    workflowDir: string
    /** ComfyUI input 目录绝对路径：H3 参考音频上传失败时回退直接复制到此目录 */
    inputDir?: string
  }
  tts: {
    defaultVoice: string
    rate: number
    volume: number
  }
  workflow: {
    default: string  // 全局默认工作流名称
  }
  llm: {
    apiKey: string   // 火山方舟 API Key
    baseUrl: string  // OpenAI 兼容端点，默认 https://ark.cn-beijing.volces.com/api/v3
    model: string    // 推理接入点 / 模型 ID，如 ark-code-latest
  }
  appearance: {
    theme: 'dark' | 'light'
  }
}

// ===== AI 拆分镜输出 =====
export interface GeneratedShot {
  scene: string
  action: string    // 英文动作提示词
  dialogue: string
  type: 'i2v' | 't2v'
  camera?: string   // 英文镜头语言短语（机位/运镜）
  emotion?: string  // 英文情绪短语
}

// ===== AI 导演：剧本分析结果 =====
export interface AnalyzedCharacter {
  name: string                  // 标准名（全名优先）
  gender: 'male' | 'female'
  age?: string                  // 年龄段（中文）
  appearance: string            // 中文外貌描述
  lookEn: string                // 英文外貌短语（逗号分隔，供 T2I）
  aliases?: string[]            // 同一角色的其他指称（称呼/小名/头衔）
  confidence?: 'high' | 'medium' | 'low'
}

export interface AnalyzedShot extends GeneratedShot {
  characterName?: string        // i2v 镜头的主角名
  sceneEn?: string              // 英文场景短语（供空镜 T2I）
  shotSize?: ShotSize           // 景别
}

export interface AnalyzeResult {
  logline?: string
  characters: AnalyzedCharacter[]
  shots: AnalyzedShot[]
  warnings?: string[]           // 后处理校验告警（如角色名无法匹配的镜头）
}

// ===== AI 导演：流水线状态 =====
export type DirectorStage =
  | 'analyze' | 'casting' | 'scenes' | 'render'
  | 'combine' | 'subtitle' | 'review' | 'bgm' | 'done'

/** 单镜审批/复审问题 */
export interface ReviewIssue {
  shotId?: string
  message: string
}

export type StageStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped'

export interface StageState {
  status: StageStatus
  message: string
  percent: number
}

/** 执行日志单条（中文时间线） */
export interface DirectorLogEntry {
  id: number
  stage: DirectorStage
  level: 'info' | 'success' | 'warn' | 'error'
  message: string
  timestamp: number
}

export interface DirectorState {
  projectId: string
  title: string
  running: boolean
  cancelled: boolean
  /** 是否停在阶段间确认点，等待用户继续 */
  paused: boolean
  /** 本次任务配置的阶段门：在这些阶段结束后暂停等待确认 */
  gateStages: DirectorStage[]
  stages: Record<DirectorStage, StageState>
  totalShots: number
  doneShots: number
  failedShotIds: string[]
  /** 成片复审问题清单（review 阶段产出） */
  reviewIssues?: string[]
  finalPath?: string
  startedAt: number
  finishedAt?: number
  /** 最近 300 条中文执行日志（环形截断） */
  logs: DirectorLogEntry[]
}

export interface DirectorProgressEvent {
  type: 'director:progress'
  projectId: string
  state: DirectorState
}

export interface DirectorLogEvent {
  type: 'director:log'
  projectId: string
  entry: DirectorLogEntry
}

export interface DirectorStartInput {
  title: string
  genre: string
  script: string
  bgmAbsolutePath?: string
  /** 阶段间确认点：列出的阶段结束后暂停，等待用户点"继续" */
  gateStages?: DirectorStage[]
}

// ===== 导演技能（可配置技能框架）=====
/** tool=绑定内置工具；prompt=自定义提示词技能（调用时按模板走一次 LLM） */
export type SkillKind = 'tool' | 'prompt'

export interface Skill {
  id: string
  /** 中文名（同时作为对话工具展示名） */
  name: string
  /** 给 LLM 的能力说明（决定何时调用） */
  description: string
  enabled: boolean
  builtin: boolean
  kind: SkillKind
  /** kind=tool：内置工具名 */
  tool?: string
  /** kind=prompt：提示词模板，{{input}} 为用户输入 */
  promptTemplate?: string
  createdAt: number
}

// ===== 导演对话 =====
export type ToolCallStatus = 'running' | 'done' | 'error'

export interface ToolCallRecord {
  id: string
  /** 工具名（内置）或 custom_<skillId>（自定义提示词技能） */
  name: string
  /** 中文展示名（技能名） */
  label: string
  argsText: string
  /** 原始参数 JSON（跨轮重建 API 消息用，不展示） */
  argsJson?: string
  status: ToolCallStatus
  /** 执行结果/错误摘要 */
  result?: string
}

export interface ConversationMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  ts: number
  error?: boolean
  toolCalls?: ToolCallRecord[]
}

export interface ConversationToolEvent {
  type: 'conversation:tool'
  scope: string
  messageId: string
  toolCall: ToolCallRecord
}

// ===== 导演记忆库（跨项目持久化）=====
/** preference=用户偏好；rule=拆镜/制作规则；lesson=经验教训 */
export type MemoryKind = 'preference' | 'rule' | 'lesson'

export interface MemoryItem {
  id: string
  kind: MemoryKind
  title: string
  content: string
  createdAt: number
  updatedAt: number
}

// ===== ComfyUI 控制面板 =====
export interface ComfyGpuDevice {
  name: string
  type: string
  vramTotal: number
  vramFree: number
}

export interface ComfySystemStats {
  online: boolean
  version: string
  pythonVersion: string
  devices: ComfyGpuDevice[]
}

// ===== 题材模板（M4：预置提示词配方，渲染时作为风格前缀拼到提示词前）=====
export interface GenreTemplate {
  key: string
  label: string
  promptStyle: string
}

export const GENRE_TEMPLATES: GenreTemplate[] = [
  {
    key: '霸总',
    label: '霸总都市',
    promptStyle: 'modern urban luxury style, cinematic lighting, confident CEO atmosphere, high production value, dramatic composition'
  },
  {
    key: '重生',
    label: '重生逆袭',
    promptStyle: 'dramatic rebirth revenge drama, intense emotional expression, cinematic color grading, urban setting'
  },
  {
    key: '悬疑',
    label: '悬疑惊悚',
    promptStyle: 'suspense thriller atmosphere, moody low-key lighting, film noir style, tense cinematic composition'
  }
]

export const IpcChannels = {
  projectList: 'project:list',
  projectCreate: 'project:create',
  projectGet: 'project:get',
  projectSave: 'project:save',
  projectDelete: 'project:delete',
  projectDuplicate: 'project:duplicate',
  characterImport: 'character:import',
  renderStart: 'render:start',
  renderCancel: 'render:cancel',
  comfyuiHealth: 'comfyui:health',
  comfySystemStats: 'comfyui:systemStats',
  comfyObjectNodes: 'comfyui:objectNodes',
  comfyValidate: 'comfyui:validate',
  memoryList: 'memory:list',
  memoryCreate: 'memory:create',
  memoryUpdate: 'memory:update',
  memoryDelete: 'memory:delete',
  ffmpegConcat: 'ffmpeg:concat',
  ffmpegMerge: 'ffmpeg:merge',
  ffmpegDuration: 'ffmpeg:duration',
  ffmpegBurnSubtitles: 'ffmpeg:burnSubtitles',
  ffmpegMixBgm: 'ffmpeg:mixBgm',
  llmTest: 'llm:test',
  llmTranslate: 'llm:translate',
  llmSplitScript: 'llm:splitScript',
  shotImportSceneImage: 'shot:importSceneImage',
  subtitleGenerate: 'subtitle:generate',
  projectImportBgm: 'project:importBgm',
  fileExists: 'file:exists',
  fileSize: 'file:size',
  fileCopy: 'file:copy',
  fileDelete: 'file:delete',
  fileResolvePath: 'file:resolvePath',
  shellShowItem: 'shell:showItem',
  ttsPreview: 'tts:preview',
  workflowList: 'workflow:list',
  workflowMeta: 'workflow:meta',
  workflowImport: 'workflow:import',
  workflowGetParams: 'workflow:getParams',
  workflowUpdateParam: 'workflow:updateParam',
  imageGenerate: 'image:generate',
  imageCheckpoints: 'image:checkpoints',
  directorStart: 'director:start',
  directorCancel: 'director:cancel',
  directorPause: 'director:pause',
  directorResume: 'director:resume',
  directorGetState: 'director:getState',
  directorProgress: 'director:progress',
  directorLog: 'director:log',
  skillList: 'skill:list',
  skillCreate: 'skill:create',
  skillUpdate: 'skill:update',
  skillDelete: 'skill:delete',
  conversationList: 'conversation:list',
  conversationSend: 'conversation:send',
  conversationClear: 'conversation:clear',
  conversationTool: 'conversation:tool',
  dialogSelectAudio: 'dialog:selectAudio',
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  dialogSelectDirectory: 'dialog:selectDirectory',
  dialogSelectFile: 'dialog:selectFile',
  dialogSaveFile: 'dialog:saveFile',
  progress: 'project:progress'
} as const
