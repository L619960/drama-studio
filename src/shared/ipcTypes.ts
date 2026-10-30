// ===== 数据模型 =====
export interface Project {
  id: string
  title: string
  genre: string
  episode: number
  status: 'draft' | 'rendering' | 'done' | 'failed'
  characters: Character[]
  /** 场景资产库：按场景键复用的无人空场景基准图（对齐可灵/即梦场景主体） */
  sceneBoards?: SceneBoard[]
  /** 道具资产库：分镜阶段提取的关键道具定妆图（渲染锁形参考） */
  props?: PropAsset[]
  shots: Shot[]
  fps: number
  defaultWorkflow?: string  // 项目默认工作流（未设则用全局默认）
  /** 资产生成工作流选择（角色/场景/道具定妆图），未设则用设置页默认 */
  assetWorkflows?: { character?: string; scene?: string; prop?: string }
  /** 原始剧本（入口三分输入或 AI 扩写后保存，可随时回看/编辑重拆） */
  script?: string
  bgmPath?: string          // BGM 音频相对路径（M4 混音）
  bgmVolume?: number        // BGM 音量 0-100
  createdAt: number
  updatedAt: number
}

/**
 * 场景资产：同名场景共用一张无人空场景板，分镜挂 sceneBoardId 复用，
 * 避免每镜重抽环境导致「同一雨夜天台」风格漂移。
 */
export interface SceneBoard {
  id: string
  /** 规范化场景键（trim + 小写 + 空白折叠），用于去重 */
  key: string
  /** 展示名（通常取首次出现的原始 scene 文案） */
  name: string
  description?: string
  /** 无人空场景基准图相对路径 */
  emptyPlatePath: string
  /** 全景固定场景：2:1 全景图相对路径（可选，panorama 开启时存在） */
  panoPath?: string
  /** 全景裁出的方位图相对路径（前/左/后/右…，数量=panoViewsCount，可选） */
  panoViews?: string[]
  /** 方位图拼成的宫格看板图相对路径（导演台可视化，可选） */
  panoGrid?: string
}

export interface Character {
  id: string
  name: string
  /**
   * 主参考图（兼容旧数据）：优先等于 faceImagePath；
   * 渲染回退链：firstFrame → face → ref → bodySheet
   */
  refImagePath: string
  /** 面部定妆特写（正脸/半身，锁身份） */
  faceImagePath?: string
  /** 全身三视图角色卡（正/侧/背或 3/4，锁体型与服装） */
  bodySheetPath?: string
  description: string
  voice: string
  voiceRate?: string
  /**
   * 角色卡锁定短语（英文，来自拆镜 lookEn）：定妆图与每镜首帧图逐字复用的唯一外观来源，
   * 含脸型/发型/锁定服装/高辨识度锚点，防止跨镜重采样漂移（2026 业界 Character Card 做法）
   */
  appearanceLock?: string
}

/** 角色渲染用主参考：脸 > 兼容 ref > 三视图 */
export function characterPrimaryRef(c: Character): string {
  return c.faceImagePath || c.refImagePath || c.bodySheetPath || ''
}

/** 场景名 → 稳定去重键 */
export function normalizeSceneKey(scene: string): string {
  return scene.trim().toLowerCase().replace(/\s+/g, ' ')
}

export type ShotType = 'i2v' | 't2v'

/** 景别：特写（面部/手部细节）/ 中景（腰部以上，对话表演）/ 远景（环境与全身动作） */
export type ShotSize = 'closeup' | 'medium' | 'wide'

/**
 * 镜头时长口径（taskQueue 动态定帧 / ffmpeg 音频留白 / 字幕时间轴共用同一组常量）。
 * - Wan2.2 帧数约束 16n+1，时长秒数 = (frames-1)/16。
 * - H3 帧数约束 17k+5 网格，实际时长 ≈ (frames-5)/17×0.75s：
 *   107 帧≈4.5s、124≈5.2s、141≈6.0s、158≈6.6s、175≈7.5s。
 *   注意 H3 一镜实际时长比 maxSec 短，长台词会被档位 maxFrames 截断（见 taskQueue 台词超长保护）。
 * - 短镜优先方法论（调研自 shuohao-skills 硬门分镜 2-5s / 青橙Lab 四宫格 15s 最佳）：
 *   无台词镜 4s 起、单镜不超过 8s，节奏紧凑且 AI 漂移面更小。
 */
export const SHOT_TIMING = {
  /** 每镜最短时长（秒）：无台词的情绪/空镜也不短于该值，避免节奏过赶 */
  minSec: 4,
  /** 每镜时长硬上限（秒），防异常长句把单镜拉得过长（8s = 129 帧 Wan / H3 需 175 帧以上档位） */
  maxSec: 8,
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
  /** 口型曾尝试但失败并回退原片时的原因摘要（供队列详情展示） */
  lipSyncFallback?: string
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
  /** 分镜级音色覆盖（未设则跟随角色音色 → 全局默认） */
  voice?: string
  /** 挂接的场景资产 id（Project.sceneBoards） */
  sceneBoardId?: string
  sceneImagePath?: string  // 场景参考图相对路径（空镜 t2v 图生视频用；可与场景板同源）
  shotSize?: ShotSize       // 景别（AI 拆镜给出，决定首帧构图）
  /** 本镜英文环境短语（LLM 拆镜给出，渲染场景提示；空镜 T2I/视频提示用） */
  sceneEn?: string
  firstFramePath?: string  // 镜头专用首帧图（场景+角色+姿态），i2v 优先使用，缺失时回退定妆照
  /** 镜头尾帧图：动作终点姿态；供首尾帧工作流与下镜连镜（上镜尾→下镜首） */
  lastFramePath?: string
  /** 五元组·镜头语言：英文机位/运镜短语（static close-up, slow push-in, handheld 等） */
  camera?: string
  /** 切镜方式（hard 硬切 / dissolve 叠化 / smash 强切）：决定剪辑转场与节奏 */
  transition?: 'hard' | 'dissolve' | 'smash'
  /** 五元组·情绪：英文情绪短语（tense, heartbroken, relieved 等），驱动表演与光影 */
  emotion?: string
  /** 镜头光线条件（英文短语：时刻+条件+主光方向，如 golden hour rim light from left / rainy night street lamp spill / warm practical lamp key from above）。全剧同一场景相邻镜保持同光源方向 */
  lighting?: string
  /** 人物朝向与画面位置（英文：facing camera / three-quarter toward frame-left / walking right-to-left）。锁定跨镜位置，防人物瞬移 */
  facing?: string
  /** 动作起点承接（英文：本镜开始时承接上一镜结尾的姿态/位置，如 standing at the door, hand on the handle）。防动作过程断裂 */
  continuity?: string
  /** 关键道具清单（LLM 分镜输出/人工补充）：注入首帧与视频提示词，防道具变样/消失 */
  props?: string[]
  /** 分镜图审核确认（视角/表情/人物数/场景/道具/构图六项核对后勾选） */
  reviewed?: boolean
  /** 末帧人物一致性相似度（0~1，CLIP 余弦），仅人物镜渲染后填充 */
  consistencyScore?: number
  /** 剪辑台：手动裁剪入点（秒，相对镜头原片起点；未设则用智能裁剪） */
  trimStart?: number
  /** 剪辑台：手动裁剪出点（秒，相对镜头原片起点；未设则用智能裁剪） */
  trimEnd?: number
  /** 剪辑台：跳过该镜（不参与成片合成） */
  skipped?: boolean
  /** 一致性重渲后仍低于阈值：该镜未达质量线，拼接成片时将被剔除并显式提示（防漂移镜混入成片） */
  lowConsistency?: boolean
  /** 角色混淆标记（多角色剧防张冠李戴）：渲染后相对判别，本镜输出人物更像另一角色的定妆（跨角色比对取最近），置 true 触发重渲/阻断 */
  roleConfusion?: boolean
  /** 逐镜审核整改指令（LLM 审图未过审时生成的英文修正提示，注入下次渲染提示词） */
  auditFix?: string
  /** 提示式审核留痕：渲染完成后快速技术审核未过的原因（不阻塞渲染，供用户后期逐镜整改） */
  auditHint?: string
  /** 分镜级完整英文正向提示词（LLM 分析生成，渲染优先使用；未生成则回退工业级模板拼装） */
  promptEn?: string
  /** 分镜级专属英文负向提示词（该镜穿帮/漂移风险，渲染并入视频负向指令） */
  negativeEn?: string
  /** 本镜时长规划（秒，3~6 秒短镜；按台词长度+动作复杂度计算） */
  frameSeconds?: number
  /** 首帧提示词（动作起点姿态/站位/景别/表情/光线） */
  firstFrameEn?: string
  /** 中帧提示词（可选）：动作进行中的关键过渡姿态 */
  midFrameEn?: string
  /** 尾帧提示词（动作完成态/离开方向/光效收束） */
  lastFrameEn?: string
  /** 下镜衔接状态（英文短语）：本镜尾帧为下一镜首帧提供什么（姿态/位置/道具状态） */
  handoffToNext?: string
  /** 首尾帧转场提示词（英文，flf2v 首尾帧视频专用）：起始帧→结束帧的动态转场过程描述，
   *  按 A/B 差异分类选择策略（A 关联强→原地演变；B 差异大→运镜驱动），含 10 秒拆解，禁人名/技能词 */
  transitionEn?: string
  /** 实际渲染参数档案（引擎/seed/帧数/口型路径等），每次生产成功后覆盖 */
  renderProfile?: RenderProfile
  status: 'pending' | 'rendering' | 'done' | 'failed'
  audioPath?: string
  /** TTS 生成失败（含风控限流）时置 true：本镜静音出片，待补配音 */
  audioFailed?: boolean
  /** TTS 失败原因（展示用） */
  audioFailedReason?: string
  /** 重拆镜标记：导演重拆分镜时旧镜保留待删（normalize 时清除），投影层据此识别幽灵镜 */
  intentReset?: boolean
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

/** 渲染队列快照（queue:list）：让任意页面回答「正渲哪镜 / 还排几镜 / 还要等多久」 */
export interface QueueSnapshot {
  running: { projectId: string; shotId: string; step: ProgressEvent['step']; percent: number } | null
  queued: Array<{ projectId: string; shotId: string }>
  /** 队列剩余预计耗时（秒）：按最近成片镜均耗时×剩余镜数估算；无历史样本时为 null */
  etaSeconds: number | null
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

/** 工作台产物重生成：产物类型（决定输出字段与参考图来源） */
export type AssetRegenerateKind = 'charFace' | 'charBody' | 'scenePlate' | 'firstFrame' | 'lastFrame'
export interface AssetRegenerateInput {
  projectId: string
  kind: AssetRegenerateKind
  /** charFace/charBody 用：角色 id */
  characterId?: string
  /** firstFrame/lastFrame 用：分镜 id */
  shotId?: string
  /** scenePlate 用：场景板 id */
  boardId?: string
  /** 正向提示词（默认取资产现有提示词） */
  prompt: string
  /** 负向提示词（可选） */
  negative?: string
  /** 工作流名（单次生效；不传用该资产当前默认） */
  workflow?: string
}

/** 提示词智能辅助输入：optimize=专业化改写，translate=中英互译 */
export interface PromptAssistInput {
  text: string
  action: 'optimize' | 'translate'
  /** optimize 用：正向/负向提示词语境 */
  kind?: 'positive' | 'negative'
}

// ===== 提示词批量体检（当前项目全部文生图 / 文生视频任务的正向+负向提示词）=====

/** 问题级别：error=必须处理（内容缺失/违规/串戏），warn=建议处理（字数/格式/风格） */
export type PromptAuditLevel = 'error' | 'warn'
/** 提示词极性：positive=正向，negative=负向 */
export type PromptAuditPolarity = 'positive' | 'negative'
/** 单条任务体检结论 */
export type PromptAuditStatus = 'ok' | 'warn' | 'error'
/** 任务归属：分镜（视频）/ 角色定妆 / 场景板 / 道具定妆（均为文生图） */
export type PromptAuditScope = 'shot' | 'character' | 'sceneBoard' | 'prop'
/** 任务类型：t2v=文生视频（空镜），i2v=图生视频（人物镜），t2i=文生图 */
export type PromptAuditTaskType = 't2v' | 'i2v' | 't2i'

/** 体检展示用字段（正向/负向提示词原文 + 统计） */
export interface PromptAuditField {
  /** 数据字段名（shot.promptEn / character.appearanceLock …），供跳转编辑定位 */
  field: string
  /** 中文标签（正向提示词 / 镜级负向提示词 …） */
  label: string
  polarity: PromptAuditPolarity
  text: string
  /** 英文词数（与渲染链路同口径：/[a-zA-Z'-]+/） */
  wordCount: number
  /** true=系统自动注入的负向（REALISM_NEGATIVE 等），只读展示，不参与一键修正 */
  system?: boolean
  /** 文本语言：en 走英文格式校验（中文残留/字数），zh 只校验非空 */
  lang: 'en' | 'zh'
}

/** 单条问题：类型说明 + 是否可一键修正（fixable=false 时走跳转编辑人工处理） */
export interface PromptAuditIssue {
  /** 机器码：missing / too-short / too-long / chinese-char / whitespace / markdown / slang /
   *  cross-project / sound-cue / era-missing / wardrobe-conflict / taboo-* / displacement-unexpected */
  code: string
  level: PromptAuditLevel
  field: string
  fieldLabel: string
  message: string
  fixable: boolean
}

export interface PromptAuditTask {
  /** 任务唯一 id = 实体 id（shot id / character id / sceneBoard id / prop id） */
  id: string
  scope: PromptAuditScope
  taskType: PromptAuditTaskType
  title: string
  shotIndex?: number
  shotId?: string
  characterId?: string
  sceneBoardId?: string
  propId?: string
  fields: PromptAuditField[]
  issues: PromptAuditIssue[]
  status: PromptAuditStatus
}

export interface PromptAuditReport {
  projectId: string
  auditedAt: number
  tasks: PromptAuditTask[]
  summary: {
    total: number
    ok: number
    warn: number
    error: number
    fieldTotal: number
    issueTotal: number
    /** 可一键修正的问题数 */
    fixableTotal: number
    /** 问题类型统计（按问题码聚合，供顶部筛选/概览） */
    byCode: Array<{ code: string; label: string; count: number }>
  }
}

export interface PromptAuditFixInput {
  projectId: string
  /** 限定任务 id（缺省=全部任务） */
  taskIds?: string[]
}

export interface PromptAuditFixResult {
  /** 实际改动字段数 */
  applied: number
  /** 修正后的最新体检报告 */
  report: PromptAuditReport
}

/** 批量 AI 补写入参：taskIds 缺省=全部任务；concurrency 缺省=1 */
export interface PromptBulkFillInput {
  projectId: string
  taskIds?: string[]
  concurrency?: number
}

/** 单个字段补写结果 */
export interface PromptBulkFillFieldResult {
  taskId: string
  field: string
  status: 'filled' | 'skipped' | 'failed' | 'unchanged'
  before: string
  after?: string
  error?: string
}

/** 批量 AI 补写进度事件（主进程逐字段推送，用于前端实时反馈） */
export interface PromptBulkFillProgress {
  projectId: string
  done: number
  total: number
  currentTaskId?: string
  currentField?: string
  lastResult?: PromptBulkFillFieldResult
}

/** 批量 AI 补写返回 */
export interface PromptBulkFillResult {
  /** 补写成功并写入的字段数 */
  filled: number
  /** 跳过的字段数（无可补写问题或非 AI 可处理） */
  skipped: number
  /** 失败的字段数 */
  failed: number
  /** 逐条结果（前端可展开查看） */
  results: PromptBulkFillFieldResult[]
  /** 补写后的最新体检报告 */
  report: PromptAuditReport
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
    importPropImage(projectId: string, propId: string): Promise<string>  // 道具上传本地图片并复制到项目目录，返回相对路径
  }
  character: {
    importImage(projectId: string): Promise<string>
    casting(projectId: string, characterId: string): Promise<{ faceRel: string; bodyRel: string; pickNote?: string }>
  }
  render: {
    /** 返回 reviewGate='warn' 时告警放行的未审核人物镜序号（block 模式有未审核镜会直接 reject） */
    start(projectId: string, shotIds?: string[], forceRebuildFirstFrame?: boolean): Promise<{ warnedShots: number[] }>
    cancel(projectId: string, shotId?: string): Promise<void>
    /** 队列快照：当前在渲镜 + 排队镜 + 剩余预计耗时（无历史样本时 etaSeconds=null） */
    list(): Promise<QueueSnapshot>
  }
  comfyui: {
    healthCheck(): Promise<boolean>
    getSystemStats(): Promise<ComfySystemStats | null>
    /** 已安装节点类名全集（GET /object_info 的 keys，主进程瘦身） */
    getObjectNodeNames(): Promise<string[]>
    /** 校验全部工作流模板：缺失节点/缺失模型 */
    validateWorkflows(): Promise<WorkflowCheckReport[]>
    /** ComfyUI models 目录绝对路径（设置 > inputDir 推断 > null），缺模型问题卡「打开目录」用 */
    getModelsDir(): Promise<string | null>
    /** 启动本机 ComfyUI（后台无窗口）。已在线返回 already；启动命令可配置 */
    start(): Promise<ComfyStartResult>
    /** 停止本机 ComfyUI：按「main.py + baseUrl 端口」定位进程并结束 */
    stop(): Promise<{ ok: boolean; killed: number; error?: string }>
  }
  memory: {
    list(kind?: MemoryKind): Promise<MemoryItem[]>
    create(input: { kind: MemoryKind; title: string; content: string }): Promise<MemoryItem>
    update(id: string, patch: Partial<Pick<MemoryItem, 'title' | 'content' | 'kind'>>): Promise<void>
    remove(id: string): Promise<void>
  }
  ffmpeg: {
    concat(segmentPaths: string[], outputPath: string): Promise<string>
    smartConcat(segments: Array<{ path: string; scene?: string; hasDialogue?: boolean; transition?: 'hard' | 'dissolve' | 'smash'; trimStart?: number; trimEnd?: number }>, outputPath: string): Promise<string>
    mergeVideoAudio(videoPath: string, audioPath: string, outputPath: string): Promise<string>
    getDuration(filePath: string): Promise<number>
    burnSubtitles(videoPath: string, srtPath: string, outputPath: string): Promise<string>
    mixBgm(videoPath: string, bgmPath: string, outputPath: string, bgmVolume?: number): Promise<string>
    extractFrames(videoPath: string, outDir: string, count?: number): Promise<string[]>
  }
  llm: {
    test(): Promise<string>
    translatePrompt(input: { scene: string; action: string; dialogue: string; genre: string }): Promise<string>
    splitScript(script: string, genre: string): Promise<GeneratedShot[]>
    writeScript(idea: string, genre: string, title?: string): Promise<string>
    /** AI 剧本医生：审查剧本逻辑 bug，返回问题清单 + 修改后完整剧本 */
    reviewScript(script: string, genre: string, title?: string): Promise<{ issues: Array<{ severity: 'block' | 'warn'; scene: string; problem: string; suggestion: string }>; revisedScript: string }>
    /** 视频拆解写剧本：抽帧后由多模态 LLM 看图扩写成短剧剧本 */
    writeScriptFromVideo(videoPath: string, genre: string): Promise<string>
  }
  shot: {
    importSceneImage(projectId: string): Promise<string>
  }
  subtitle: {
    generate(projectId: string): Promise<string>  // 生成 SRT，返回相对路径
  }
  /** 场景板：重建全景方位图 */
  scene: {
    regeneratePano(projectId: string, boardId: string): Promise<{ ok: boolean; text: string }>
  }
  /** 工作台产物重生成：按产物类型用指定工作流重新生成（单次生效，不改项目默认） */
  asset: {
    regenerate(input: AssetRegenerateInput): Promise<{ path: string; previousPath?: string }>
    /** 回滚到上一次生成前的旧产物（生成时主进程已备份） */
    rollback(input: AssetRegenerateInput): Promise<{ path: string }>
  }
  /** 提示词智能辅助：AI 专业优化 / 中英互译（走主进程 LLM 服务） */
  prompt: {
    assist(input: PromptAssistInput): Promise<{ text: string }>
    /** 批量体检：遍历当前项目全部文生图/文生视频任务，逐条校验正向+负向提示词（完整性/格式/敏感内容） */
    auditPrompts(projectId: string): Promise<PromptAuditReport>
    /** 一键修正可自动修复项（缺省=全部任务）；只改提示词文本，不动镜头状态与已生成产物 */
    fixPrompts(input: PromptAuditFixInput): Promise<PromptAuditFixResult>
    /** 批量 AI 补写：对缺失/过短/串戏等需语义补全的提示词字段调用 LLM 重写；
     *  taskIds 缺省=全部任务；concurrency 缺省=1（串行，避免 LLM 限流）。
     *  进度通过 prompt:bulkFillProgress 事件推送。 */
    bulkFillPrompts(input: PromptBulkFillInput): Promise<PromptBulkFillResult>
    /** 订阅批量 AI 补写进度事件，返回取消订阅函数 */
    onBulkFillProgress(cb: (evt: PromptBulkFillProgress) => void): () => void
  }
  file: {
    exists(relativePath: string): Promise<boolean>
    getSize(relativePath: string): Promise<number>
    copy(relativePath: string, absoluteTarget: string): Promise<void>
    delete(relativePath: string): Promise<void>
    resolvePath(relativePath: string): Promise<string>
    /** 本地媒体可播放 URL（本机 HTTP + Range，供 video/img src） */
    mediaUrl(relativePath: string): Promise<string>
  }
  shell: {
    showItem(relativePath: string): Promise<void>
    /** 打开本机任意已存在目录/文件（如 ComfyUI models 目录），不存在时抛错 */
    openPath(absolutePath: string): Promise<void>
  }
  tts: {
    preview(voice: string): Promise<string>
    /** Qwen3-TTS 语音克隆：参考音频 + 文本 → 克隆语音（相对路径） */
    clone(text: string, refAudioPath: string, relativeOutput: string, opts?: { refText?: string; seed?: number }): Promise<string>
  }
  workflow: {
    list(): Promise<WorkflowMeta[]>
    getMeta(name: string): Promise<WorkflowMeta>
    import(absolutePath: string): Promise<string>  // 导入工作流 JSON，返回工作流名称
    getParams(name: string): Promise<WorkflowParam[]>
    updateParam(name: string, nodeId: string, key: string, value: string | number | boolean): Promise<void>
  }
  image: {
    generate(
      prompt: string,
      relativeOutput: string,
      workflowNameOrOpts?: string | {
        workflowName?: string
        width?: number
        height?: number
        /** 参考图（i2i/融合工作流用），绝对或相对项目根路径 */
        referenceImagePath?: string
        referenceImagePaths?: string[]
        /** 严格按工作流参数渲染（禁用尺寸/seed 覆盖） */
        strictWorkflow?: boolean
        /** 分镜级负向提示词（并入视频/图像负向指令） */
        negative?: string
        seed?: number
        shouldAbort?: () => boolean
      }
    ): Promise<string>
    checkpoints(): Promise<string[]>
  }
  director: {
    start(input: DirectorStartInput): Promise<string>  // 返回 projectId
    cancel(projectId: string): Promise<void>
    /** 请求暂停：当前阶段结束后停在确认点（不中断进行中的渲染） */
    pause(projectId: string): Promise<void>
    /** 从确认点继续 */
    resume(projectId: string): Promise<void>
    /**
     * 断点续跑：从指定阶段重跑（该阶段及其后全部重新执行，此前已完成阶段跳过）。
     * 任务运行中/状态缺失/前置产物不满足时抛中文错误。
     */
    resumeFrom(projectId: string, stage: DirectorStage): Promise<void>
    /** 重跑项目全部 i2v 镜一致性校验（新逻辑摘帽误杀标记，不触发重渲），返回复评统计 */
    recheckConsistency(projectId: string): Promise<{ rechecked: number; cleared: number; stillLow: number; skipped: number }>
    /** 重拆镜：用当前剧本重新分析并替换分镜（保留资产），返回 {shots, characters, props} 计数 */
    reanalyze(projectId: string): Promise<{ shots: number; characters: number; props: number }>
    getState(projectId: string): Promise<DirectorState | null>
    /** 清空已结束任务的内存展示态（不删素材；切项目/关项目时防幽灵流水线） */
    clearState(projectId: string): Promise<void>
    /** 最近活跃任务的状态（含影子渲染任务）：全局控制台未绑定项目时展示用 */
    getLatestState(): Promise<DirectorState | null>
    /** 全部活跃任务状态（running/paused），供全局任务面板并行展示多项目 */
    getActiveStates(): Promise<DirectorState[]>
    /** 扫描磁盘上未跑完的任务（中断/残留 running），项目列表「一键继续」横幅用 */
    listInterrupted(): Promise<InterruptedTask[]>
    /** 重新启用「一口气跑到底」关闭的阶段确认点（剩余阶段生效） */
    enableGates(projectId: string): Promise<boolean>
    onProgress(cb: (e: DirectorProgressEvent) => void): () => void
    onLog(cb: (e: DirectorLogEvent) => void): () => void
    /** 后台流程（定妆/首帧/场景板/逐镜渲染）落盘后通知：前端面板收到即刷新项目数据 */
    onProjectUpdated(cb: (e: { projectId: string }) => void): () => void
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
    /** 中断当前正在进行的发送（LLM 请求与工具循环），返回是否确有任务被中断 */
    stop(scope: string): Promise<boolean>
    /** 查询指定作用域是否有正在进行的发送（路由切回后恢复发送态用） */
    isSending(scope: string): Promise<boolean>
    /** 回退到指定消息节点之前：删除该消息及其后的所有记录，返回回退后的消息列表 */
    rollback(scope: string, messageId: string): Promise<ConversationMessage[]>
    /** 弹出系统文件选择框，读取常见文本文件内容（超长截断），取消返回 null */
    uploadFile(): Promise<UploadedFilePayload | null>
    onToolEvent(cb: (e: ConversationToolEvent) => void): () => void
  }
  system: {
    /** 运行环境与功能自检，返回逐项结果 */
    selfcheck(): Promise<SelfCheckItem[]>
  }
  settings: {
    /** 主进程始终合并默认值后返回，不会是 null（I-11 修正：原契约误标 | null） */
    get(): Promise<AppSettings>
    save(settings: AppSettings): Promise<void>
    /** 人物/场景试生成预览（写入 preview/，不进项目） */
    previewAsset(input: PreviewAssetInput): Promise<PreviewAssetResult>
  }
  dialog: {
    selectDirectory(): Promise<string | null>
    selectFile(): Promise<string | null>
    selectAudio(): Promise<string | null>
    selectVideo(): Promise<string | null>
    saveFile(defaultName: string): Promise<string | null>
  }
  onProgress(cb: (e: ProgressEvent) => void): () => void
}

// ===== 工作流元数据 =====
/** 工作流能力标签：供导演按用户意图自动匹配工作流（文生视频/图生视频/首尾帧/文生图/图生图/音频） */
export type WorkflowCapability =
  | 't2v' | 'i2v' | 'flf2v'   // 视频：文生/图生/首尾帧
  | 't2i' | 'i2i'             // 图片：文生/图生
  | 'audio'                   // 音频/TTS/音乐
  | 'other'

export interface WorkflowMeta {
  name: string
  placeholders: string[]
  hasImageInput: boolean
  hasDuration: boolean
  /** 双图首尾帧（$END_IMAGE$） */
  hasEndFrame?: boolean
  /** 自动推断的能力标签（t2v/i2v/flf2v/t2i/i2i/audio/other），导演自动选流依据 */
  capability?: WorkflowCapability
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

// ===== 创作四模块设置 =====
export interface StoryboardModuleSettings {
  /** 最少镜头数 */
  minShots: number
  /** 最多镜头数 */
  maxShots: number
  /** 拆镜 LLM 温度 0~1 */
  temperature: number
  /** 角色上限 */
  maxCharacters: number
  /** 强制关键道具落幅校验 */
  enforcePropLock: boolean
  /** 强制入画后反应镜校验 */
  enforceReactionBeats: boolean
  /** 强制上车链/驶离结局校验 */
  enforceBoardingChain: boolean
}

export interface CharacterModuleSettings {
  faceWidth: number
  faceHeight: number
  bodyWidth: number
  bodyHeight: number
  /** 写实锁强度：strong 加强负向与身份复读 */
  realismLock: 'standard' | 'strong'
  seedMode: 'random' | 'fixed'
  seed: number
  /** 空=使用 ImageService 默认工作流 */
  t2iWorkflow: string
  /** 定妆候选张数 1–4；>1 时多 seed 抽卡 */
  candidates: number
  /** 多候选时由 LLM 结合分数挑最优 */
  llmPick: boolean
}

export interface SceneModuleSettings {
  plateWidth: number
  plateHeight: number
  frameWidth: number
  frameHeight: number
  /** 空场景板严禁出现人物 */
  emptyStrict: boolean
  weatherHint: 'auto' | 'rainy' | 'clear'
  /** 场景板文生图工作流覆盖（未设用默认） */
  t2iWorkflow?: string
  /** 场景板候选张数 1–4 */
  candidates: number
  /** 全景固定场景：每个场景生成 2:1 全景图并裁 N 张方位图，各镜首帧从方位图取景（场景不漂移）。
   *  默认开；关闭时回退旧版单张竖版场景板。 */
  panorama: boolean
  /** 全景方位图数量（水平均分 90° 间隔）：2 / 4 / 6 */
  panoViewsCount: number
  llmPick: boolean
}

export interface EditModuleSettings {
  defaultWidth: number
  defaultHeight: number
  defaultFrames: number
  /** Comfy 等待超时（秒） */
  comfyTimeoutSec: number
  lipSync: boolean
  lipSyncMode: 'auto' | 'latentsync' | 'h3-native'
  reviewGate: 'off' | 'warn' | 'block'
  defaultBgmVolume: number
  subtitleFontSize: number
  subtitleMarginV: number
  ttsRate: number
  ttsVolume: number
  /** 单镜渲染候选条数 1–3（多 seed）；>1 时抽卡留最优 */
  renderCandidates: number
  /** 多候选渲染时 LLM 介入挑选 */
  llmPick: boolean
}

export interface CreationPreset {
  id: string
  name: string
  updatedAt: number
  modules: {
    storyboard: StoryboardModuleSettings
    character: CharacterModuleSettings
    scene: SceneModuleSettings
    edit: EditModuleSettings
  }
}

export interface CreationSettings {
  storyboard: StoryboardModuleSettings
  character: CharacterModuleSettings
  scene: SceneModuleSettings
  edit: EditModuleSettings
  presets: CreationPreset[]
}

export interface PreviewAssetInput {
  kind: 'character' | 'scene'
  /** character: lookEn；scene: 场景描述 */
  promptHint: string
}

export interface PreviewAssetResult {
  relativePath: string
  mediaUrl: string
}

// ===== 设置数据模型 =====
export interface AppSettings {
  general: {
    autoSave: boolean
    /** 启动后自动触发导演「自主学习」（每周一轮，联网搜索+技能沉淀） */
    autoLearn: boolean
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
    /**
     * 分镜首帧审核门控（开渲前）：off=不检查；warn=未核对仍入队并返回 warnedShots；block=未核对直接拒绝入队
     */
    shotReviewGate: 'off' | 'warn' | 'block'
    /**
     * 成片复审门控（旧字段，兼容保留；新读点请用 finalReviewGate）：
     * off=只记录；warn=技术/剧情问题告警后放行；block=技术硬伤阻断 BGM，剧情问题仍告警放行
     */
    reviewGate: 'off' | 'warn' | 'block'
    /**
     * 成片复审门控（独立字段，与分镜首帧门 shotReviewGate 解耦）：
     * off=只记录；warn=技术/剧情问题告警后放行；block=技术硬伤阻断 BGM，剧情问题仍告警放行
     */
    finalReviewGate: 'off' | 'warn' | 'block'
    /** 定妆/场景板客户端并发（Comfy 侧仍排队）；1~3，默认 2 */
    assetConcurrency: number
    /** 逐镜即时审核（看守）：每渲染完一镜立即技术+LLM视觉审核，不过就注入修正指令重渲，过审才进下一镜；关=旧批量渲染后统一审批 */
    perShotAudit: boolean
    /** MiniMax H3 turbo LoRA 加速：i2v 挂 fl2v_turbo_8step(8步)、r2v 挂 ref2v_turbo_4step(4步)；默认开 */
    turboH3: boolean
    /**
     * 资产复用回退：T2I 模型缺失或角色/场景资产生成失败时，从该已完成项目（projectId）
     * 按出场顺序复制定妆/场景板资产继续流水线；留空=不回退（失败留痕）。
     */
    assetFallbackProjectId?: string
    /**
     * 首帧融合（单图定妆/全景双图 i2i）两级均失败后的兜底策略：
     * block（默认）= 直接 throw 阻断流水线，不带病前进（首帧丢定妆身份参考→i2v 漂移）；
     * allow = 允许回退文生兜底继续出图。
     */
    fusionFallback?: 'block' | 'allow'
  }
  /** 创作四模块：分镜 / 人物 / 场景 / 剪辑（与 render/tts 双向镜像兼容） */
  creation: CreationSettings
  comfyui: {
    baseUrl: string
    /** ComfyUI input 目录绝对路径：H3 参考音频上传失败时回退直接复制到此目录 */
    inputDir?: string
    /** ComfyUI models 目录绝对路径：缺模型问题卡「打开 models 目录」用，空则自动从 inputDir 推断 */
    modelsDir?: string
    /**
     * 一键启动命令（完整命令行，路径用英文引号包裹）。空=用内置默认
     * `"<秋叶整合包>\python\python.exe" "<整合包>\ComfyUI\main.py" --listen 127.0.0.1 --port 8188`
     */
    startCommand?: string
    /**
     * ComfyUI 工作流库目录（用户收集的 UI 格式工作流全集，扫描+转换导入用）。
     * 空=本机秋叶整合包默认库路径
     */
    workflowLibraryDir?: string
    /** comfy-mcp venv 绝对路径（优先于旧推导） */
    mcpVenvDir?: string
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
    /** 接口地址下拉记忆：用户保存过的 baseUrl 历史（去重置顶，最多 12 条） */
    baseUrlHistory?: string[]
  }
  appearance: {
    /** 主题：dark 深色（默认）｜ light 浅色 ｜ studio 深空导演棚 ｜ warm 暖色剪辑台 */
    theme: 'dark' | 'light' | 'studio' | 'warm'
  }
}

// ===== AI 拆分镜输出 =====
export interface GeneratedShot {
  scene: string
  action: string    // 英文动作提示词
  dialogue: string
  type: 'i2v' | 't2v'
  camera?: string   // 英文镜头语言短语（机位/运镜，需含机位高度）
  transition?: 'hard' | 'dissolve' | 'smash' // 切镜方式
  emotion?: string  // 英文情绪短语
  lighting?: string // 光线条件（时刻+主光方向），全剧统一光源方向
  facing?: string   // 人物朝向与画面位置
  continuity?: string // 动作起点承接（衔接上一镜结尾）
  /** 镜头内出现的角色名列表（同镜多人时给出全部，空镜省略）；i2v 至少一个 */
  characters?: string[]
  /** 镜头关键道具（英文名词，如 umbrella / sedan），提示词强约束 + 审核清单用 */
  props?: string[]
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
  characterName?: string        // i2v 镜头的主角名（兼容单主角；多主角见 characters）
  sceneEn?: string              // 英文场景短语（供空镜 T2I）
  shotSize?: ShotSize           // 景别
  /** 本镜完整英文正向提示词（60~140 词）：场景/光线/运镜/动作/人物状态/道具/情绪/一致性约束，渲染时直接喂模型 */
  promptEn?: string
  /** 本镜专属英文负向提示词（10~30 词）：该镜穿帮/漂移风险点，渲染时并入负向约束 */
  negativeEn?: string
  /** 首尾帧转场提示词（英文，flf2v 专用）：起始帧→结束帧动态转场，A/B 分类策略+10 秒拆解，禁人名/技能词 */
  transitionEn?: string
  /** 本镜时长规划（秒，3~6 秒短镜；按台词长度+动作复杂度计算） */
  frameSeconds?: number
  /** 首帧提示词（动作起点姿态/站位/景别/表情/光线） */
  firstFrameEn?: string
  /** 中帧提示词（可选）：动作进行中的关键过渡姿态 */
  midFrameEn?: string
  /** 尾帧提示词（动作完成态/离开方向/光效收束） */
  lastFrameEn?: string
  /** 下镜衔接状态（英文短语）：本镜尾帧为下一镜首帧提供什么（姿态/位置/道具状态） */
  handoffToNext?: string
}

/** 场景清单：分镜阶段提取的场景视觉提示词，写入场景板 description 供场景图生成 */
export interface AnalyzeScene {
  /** 中文场景名（与分镜 scene 完全一致） */
  name: string
  /** 英文场景视觉提示词（25~60 词：天气/光线/空间/氛围/剧情事件） */
  en?: string
}

export interface AnalyzeResult {
  logline?: string
  characters: AnalyzedCharacter[]
  shots: AnalyzedShot[]
  /** 全剧关键道具清单（LLM 从剧本提取；每项要求至少写入一镜 props/action，并生成道具定妆图资产） */
  props?: PropAsset[]
  /** 场景清单：场景名 → 场景图提示词（写入场景板 description） */
  scenes?: AnalyzeScene[]
  warnings?: string[]           // 后处理校验告警（如角色名无法匹配的镜头）
}

/** 道具资产：分镜阶段提取的关键道具，含定妆图（生成后回填 imagePath） */
export interface PropAsset {
  id: string
  /** 中文名（如 袋） */
  zh: string
  /** 英文名（如 paper bag） */
  en: string
  /** 英文形态描述：锁形用，注入渲染提示词（如 brown paper bag with a rope handle, slightly worn） */
  description?: string
  /** 道具定妆图相对路径（projects/{pid}/props/xxx.png），生成后回填 */
  imagePath?: string
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

export type StageStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped' | 'paused'

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

/** 门禁待处理原因：分镜首帧审核 / 阶段确认点 / 成片复审 */
export type GateReason = 'shotReview' | 'stageReview' | 'finalReview'

/** 结构化门禁负载：UI 据此显示「停在哪道门、哪几个镜待审、点哪里去审」 */
export interface PendingGate {
  stage: DirectorStage
  reason: GateReason
  /** 待审镜头 id 清单（完整不截断；stageReview/finalReview 可为空） */
  unreviewedShotIds: string[]
}

/** 中断任务摘要（director:listInterrupted）：项目列表「待恢复」横幅用 */
export interface InterruptedTask {
  projectId: string
  projectName: string
  interruptedStage?: DirectorStage
  /** 中断时间（毫秒）；无记录时缺省 */
  failedAt?: number
  /** 中文说明：停在哪个阶段/为何中断 */
  reason: string
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
  /** 门禁待处理结构化清单（paused 时填写，resume/cancel 后清空） */
  pendingGates?: PendingGate[]
  /** AI 自愈诊断：阶段失败时 LLM 诊断结论与修复建议（UI 在对应阶段卡片展示） */
  heal?: { stage: DirectorStage; diagnosis: string; suggestion: string }
  finalPath?: string
  /** 断点续跑输入快照（含原始剧本/BGM 路径），随状态持久化 */
  input?: DirectorStartInput
  /** 剧本分析结果快照：从 casting/scenes 续跑时复用，避免二次 LLM 拆镜 */
  analysis?: AnalyzeResult | null
  startedAt: number
  finishedAt?: number
  /** 上次任务因应用重启/崩溃中断（由 hydrate 修复时置位）：UI 展示「任务中断」提示 + 一键继续入口 */
  interrupted?: boolean
  /** 中断时正在执行的阶段：用于「从上次失败阶段继续」按钮定位 */
  interruptedStage?: DirectorStage
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
  /** 复用已有项目 ID（项目对话里开拍时传入，避免重复创建空项目） */
  existingProjectId?: string
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

/** 自主学习指令：渲染层「自主学习」按钮与主进程每日自动学习共用同一条文案 */
export const SELF_LEARN_PROMPT =
  '【自主学习】请执行一轮网络技能学习：先用工具查看已有技能避免重复，再搜索 AI 短剧制作与 AI 视频生成的最新技巧/行业动态，深入阅读最有价值的内容，把新知识沉淀为新技能或更新已有技能（没有值得沉淀的就直接说明，不要硬凑），最后汇报学到了什么、沉淀到了哪里、对后续创作有什么用。'

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

/** 对话上传文件：文本内容（超长截断） */
export interface UploadedFilePayload {
  name: string
  content: string
  truncated: boolean
}

// ===== 系统自检 =====
export interface SelfCheckItem {
  name: string
  ok: boolean
  detail: string
  /** 本次运行自动修复了问题 */
  fixed?: boolean
  /** 非故障但需用户注意（如 ComfyUI 离线）：面板渲染为告警而非绿勾 */
  warn?: boolean
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

/** 一键启动 ComfyUI 的结果 */
export interface ComfyStartResult {
  ok: boolean
  /** 启动前已在线（无需重复启动） */
  already?: boolean
  /** 已派生进程 PID */
  pid?: number
  error?: string
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
    promptStyle: 'city-night practical lights, cool-teal key with warm fill accents, shallow DOF, restrained contrast, vertical short-drama look development'
  },
  {
    key: '重生',
    label: '重生逆袭',
    promptStyle: 'heightened emotional contrast, desaturated day / saturated night, punchy midtones, cinematic color timing for revenge drama'
  },
  {
    key: '悬疑',
    label: '悬疑惊悚',
    promptStyle: 'low-key chiaroscuro, negative fill, cool practical spill, noir grain, tense static frames with micro push-ins'
  },
  {
    key: '甜宠',
    label: '甜宠言情',
    promptStyle: 'airy high-key lighting, soft pastel palette, gentle bokeh, bright skin tones, warm romantic glow, light dreamy haze'
  },
  {
    key: '虐恋',
    label: '虐恋催泪',
    promptStyle: 'moody desaturated grade, rain-washed atmosphere, lonely negative space, soft window light, tearful emotional close-ups'
  },
  {
    key: '战神',
    label: '战神归来',
    promptStyle: 'high-contrast heroic grade, dramatic rim light, gritty urban textures, wide establishing power shots, bold shadow play'
  },
  {
    key: '穿越',
    label: '时空穿越',
    promptStyle: 'anachronism blend, warm historical interiors with modern cool accents, dust-mote light shafts, period-correct costumes'
  },
  {
    key: '古装',
    label: '古装仙侠',
    promptStyle: 'wuxia cinematic look, flowing silk highlights, misty mountains, jade-and-gold palette, ethereal god rays, wire-work motion feel'
  },
  {
    key: '玄幻',
    label: '玄幻修仙',
    promptStyle: 'epic fantasy grade, luminous energy glows, dramatic scale contrast, mythical beast silhouettes, volumetric atmosphere'
  },
  {
    key: '都市',
    label: '都市职场',
    promptStyle: 'clean corporate realism, glass-and-steel reflections, neutral daylight grade, sharp modern geometry, professional pace'
  },
  {
    key: '民国',
    label: '民国传奇',
    promptStyle: 'vintage sepia-teal grade, art-deco interiors, opium-lamp warmth, period wardrobe, film-grain nostalgia'
  },
  {
    key: '校园',
    label: '青春校园',
    promptStyle: 'fresh daylight, youthful brightness, soft-focus lens flare, pastel uniforms, energetic handheld moments'
  },
  {
    key: '喜剧',
    label: '爆笑喜剧',
    promptStyle: 'vibrant saturated grade, lively fast pacing feel, broad dynamic poses, colorful practicals, upbeat bright look'
  },
  {
    key: '科幻',
    label: '科幻未来',
    promptStyle: 'neon-noir sci-fi grade, holographic UI accents, cool cyan-magenta palette, clean futuristic geometry, lens refraction glints'
  },
  {
    key: '宫廷',
    label: '古风宫斗',
    promptStyle: 'imperial gold-crimson palette, ornate palace interiors, silk embroidery detail, candle-lit warmth, regal static compositions'
  },
  {
    key: '家庭',
    label: '家庭伦理',
    promptStyle: 'naturalistic kitchen-sink realism, soft window daylight, intimate domestic close-ups, muted honest color grade'
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
  queueList: 'queue:list',
  comfyuiHealth: 'comfyui:health',
  comfySystemStats: 'comfyui:systemStats',
  comfyObjectNodes: 'comfyui:objectNodes',
  comfyValidate: 'comfyui:validate',
  comfyModelsDir: 'comfyui:modelsDir',
  comfyStart: 'comfyui:start',
  comfyStop: 'comfyui:stop',
  memoryList: 'memory:list',
  memoryCreate: 'memory:create',
  memoryUpdate: 'memory:update',
  memoryDelete: 'memory:delete',
  ffmpegConcat: 'ffmpeg:concat',
  ffmpegSmartConcat: 'ffmpeg:smartConcat',
  ffmpegExtractFrames: 'ffmpeg:extractFrames',
  ffmpegMerge: 'ffmpeg:merge',
  ffmpegDuration: 'ffmpeg:duration',
  ffmpegBurnSubtitles: 'ffmpeg:burnSubtitles',
  ffmpegMixBgm: 'ffmpeg:mixBgm',
  llmTest: 'llm:test',
  llmTranslate: 'llm:translate',
  llmSplitScript: 'llm:splitScript',
  llmWriteScript: 'llm:writeScript',
  llmReviewScript: 'llm:reviewScript',
  llmWriteScriptFromVideo: 'llm:writeScriptFromVideo',
  shotImportSceneImage: 'shot:importSceneImage',
  sceneRegeneratePano: 'scene:regeneratePano',
  subtitleGenerate: 'subtitle:generate',
  projectImportBgm: 'project:importBgm',
  projectImportPropImage: 'project:importPropImage',
  fileExists: 'file:exists',
  fileSize: 'file:size',
  fileCopy: 'file:copy',
  fileDelete: 'file:delete',
  fileResolvePath: 'file:resolvePath',
  fileMediaUrl: 'file:mediaUrl',
  shellShowItem: 'shell:showItem',
  shellOpenPath: 'shell:openPath',
  ttsPreview: 'tts:preview',
  ttsClone: 'tts:clone',
  workflowList: 'workflow:list',
  workflowMeta: 'workflow:meta',
  workflowImport: 'workflow:import',
  workflowGetParams: 'workflow:getParams',
  workflowUpdateParam: 'workflow:updateParam',
  imageGenerate: 'image:generate',
  imageCheckpoints: 'image:checkpoints',
  characterCasting: 'character:casting',
  assetRegenerate: 'asset:regenerate',
  assetRollback: 'asset:rollback',
  promptAssist: 'prompt:assist',
  promptAudit: 'prompt:auditPrompts',
  promptFix: 'prompt:fixPrompts',
  promptBulkFill: 'prompt:bulkFillPrompts',
  promptBulkFillProgress: 'prompt:bulkFillProgress',
  directorStart: 'director:start',
  directorCancel: 'director:cancel',
  directorPause: 'director:pause',
  directorResume: 'director:resume',
  directorResumeFrom: 'director:resumeFrom',
  directorRecheckConsistency: 'director:recheckConsistency',
  directorReanalyze: 'director:reanalyze',
  directorGetState: 'director:getState',
  directorClearState: 'director:clearState',
  directorLatestState: 'director:getLatestState',
  directorActiveStates: 'director:listActiveStates',
  directorListInterrupted: 'director:listInterrupted',
  directorEnableGates: 'director:enableGates',
  directorProgress: 'director:progress',
  directorLog: 'director:log',
  directorProjectUpdated: 'director:project-updated',
  skillList: 'skill:list',
  skillCreate: 'skill:create',
  skillUpdate: 'skill:update',
  skillDelete: 'skill:delete',
  conversationList: 'conversation:list',
  conversationSend: 'conversation:send',
  conversationClear: 'conversation:clear',
  conversationTool: 'conversation:tool',
  conversationStop: 'conversation:stop',
  conversationSending: 'conversation:sending',
  conversationRollback: 'conversation:rollback',
  conversationUpload: 'conversation:upload',
  systemSelfcheck: 'system:selfcheck',
  dialogSelectAudio: 'dialog:selectAudio',
  dialogSelectVideo: 'dialog:selectVideo',
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  settingsPreviewAsset: 'settings:previewAsset',
  dialogSelectDirectory: 'dialog:selectDirectory',
  dialogSelectFile: 'dialog:selectFile',
  dialogSaveFile: 'dialog:saveFile',
  progress: 'project:progress'
} as const
