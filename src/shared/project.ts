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
 *   无台词镜 4s 起、单镜不超过 6s，节奏紧凑且 AI 漂移面更小。
 */
export const SHOT_TIMING = {
  /** 每镜最短时长（秒）：无台词的情绪/空镜也不短于该值，避免节奏过赶 */
  minSec: 4,
  /** 每镜时长硬上限（秒）。与 shotDoctrine.maxSec 一致，长句拆镜而不是拉长单镜 */
  maxSec: 6,
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
  /** 一致性低于阈值时的标记。成片仍保留该镜，除非用户勾选跳过。 */
  lowConsistency?: boolean
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
  rawVideoPath?: string
  segmentPath?: string
  error?: string
  /**
   * 仅内存/保存瞬间：用户或流水线显式作废旧成片。
   * ProjectStore 见到后不再把磁盘上的 done 状态盖回来，落盘前会删掉该字段。
   */
  intentReset?: boolean
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
  /** 镜头内出现的角色名。一镜只保留一个可读角色，空镜省略。 */
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

