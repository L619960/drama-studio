/**
 * 创作四模块默认值、说明文案与从 AppSettings 解析有效配置。
 */
import type {
  AppSettings,
  CharacterModuleSettings,
  CreationSettings,
  EditModuleSettings,
  SceneModuleSettings,
  StoryboardModuleSettings
} from './ipcTypes'

export const DEFAULT_STORYBOARD: StoryboardModuleSettings = {
  minShots: 8,
  maxShots: 16,
  temperature: 0.4,
  maxCharacters: 6,
  enforcePropLock: true,
  enforceReactionBeats: true,
  enforceBoardingChain: true
}

export const DEFAULT_CHARACTER: CharacterModuleSettings = {
  faceWidth: 768,
  faceHeight: 1152,
  bodyWidth: 1344,
  bodyHeight: 896,
  realismLock: 'strong',
  seedMode: 'random',
  seed: 42,
  t2iWorkflow: '',
  candidates: 2,
  llmPick: true
}

export const DEFAULT_SCENE: SceneModuleSettings = {
  plateWidth: 768,
  plateHeight: 1152,
  frameWidth: 768,
  frameHeight: 1152,
  emptyStrict: true,
  weatherHint: 'auto',
  candidates: 2,
  llmPick: true,
  panorama: true,
  panoViewsCount: 4
}

export const DEFAULT_EDIT: EditModuleSettings = {
  defaultWidth: 720,
  defaultHeight: 480,
  defaultFrames: 81,
  comfyTimeoutSec: 600,
  lipSync: true,
  lipSyncMode: 'auto',
  reviewGate: 'block',
  defaultBgmVolume: 35,
  subtitleFontSize: 14,
  subtitleMarginV: 18,
  ttsRate: 88,
  ttsVolume: 100,
  // 默认 1：打开后耗时×N；需要更稳成片时在设置里调到 2–3
  renderCandidates: 1,
  llmPick: true
}

export const DEFAULT_CREATION: CreationSettings = {
  storyboard: { ...DEFAULT_STORYBOARD },
  character: { ...DEFAULT_CHARACTER },
  scene: { ...DEFAULT_SCENE },
  edit: { ...DEFAULT_EDIT },
  presets: []
}

/** 参数说明（设置页 tip） */
export const CREATION_PARAM_TIPS = {
  storyboard: {
    minShots: '拆镜最少镜头数；故事过短时也会尽量凑到此下限',
    maxShots: '拆镜上限；超过会压缩节拍，建议 12–20',
    temperature: '越低越稳、越高越跳戏；推荐 0.3–0.5',
    maxCharacters: '入选角色上限（群演不进表）',
    enforcePropLock: '片名/梗概中的关键道具必须写入分镜并尽量有交接特写',
    enforceReactionBeats: '对方入画空镜后必须先有「看见」反应再开口',
    enforceBoardingChain: '开车门后须有入座完成态；驶离结局须有车辆离开'
  },
  character: {
    faceWidth: '面部定妆宽度（竖屏推荐 768）',
    faceHeight: '面部定妆高度（竖屏推荐 1152）',
    bodyWidth: '三视图宽度（横版三面板推荐 1344）',
    bodyHeight: '三视图高度',
    realismLock: 'strong 加强塑料美颜/换装负向与身份复读',
    seedMode: 'fixed 可复现同款定妆；random 每次新样貌微调',
    seed: '仅 seedMode=fixed 时生效',
    t2iWorkflow: '留空使用默认文生图工作流（klein_t2i_clean，缺失自动回退 qwen_t2i_hq / builtin_t2i）',
    candidates: '定妆一次生成几张不同 seed，再抽卡留最优（1=关闭）',
    llmPick: '多候选时由 LLM 结合文件质量分挑选'
  },
  scene: {
    plateWidth: '空场景板宽度',
    plateHeight: '空场景板高度',
    frameWidth: '镜头首/尾帧宽度',
    frameHeight: '镜头首/尾帧高度',
    emptyStrict: '场景板禁止出现任何人物/人脸',
    weatherHint: 'auto 跟剧本情绪；rainy/clear 强制天气氛围词',
    candidates: '场景板抽卡张数（1=关闭）',
    llmPick: '多候选时由 LLM 挑选更贴地点/天气的一张',
    panorama: '全景固定场景：每场景生成 2:1 全景图裁方位图，各镜从方位图取景（关=旧版单张场景板）',
    panoViewsCount: '全景方位图数量（水平均分，90°/60° 间隔）'
  },
  edit: {
    defaultWidth: '新建分镜默认视频宽（Wan 图生视频档位仍可能覆盖）',
    defaultHeight: '新建分镜默认视频高',
    defaultFrames: '须为 16n+1（如 49/65/81）；约 (frames-1)/16 秒',
    comfyTimeoutSec: '单次 Comfy 任务等待上限（秒）',
    lipSync: '有台词人物镜做口型同步',
    lipSyncMode: 'auto 优先 H3 原生口型；失败可回退 LatentSync',
    reviewGate: '成片复审：技术硬伤是否阻断配 BGM',
    defaultBgmVolume: '导演流水线默认 BGM 音量 0–100',
    subtitleFontSize: '硬字幕字号',
    subtitleMarginV: '字幕距底边边距',
    ttsRate: '对白语速百分比，推荐 85–92',
    ttsVolume: '对白音量百分比',
    renderCandidates: '单镜渲染几条不同 seed 再抽卡（1=关闭；耗时×N）',
    llmPick: '多候选渲染时 LLM 结合一致性分数挑选最优条'
  }
} as const

/** 取 edit 字段：creation.edit 显式值（≠默认）优先；仍为默认或缺失时镜像 render/tts（旧配置迁移）。
 *  注意不能只判 undefined——settingsStore.merge 会用 DEFAULT_CREATION 填满 creation.edit，
 *  若缺省即等同默认，旧 render 值会被默认值静默覆盖（2026-10-20 测试回归发现并修正）。 */
function pickEdit<T>(v: T | undefined, fallback: T | undefined, def: T): T {
  if (v !== undefined && v !== def) return v
  if (fallback !== undefined) return fallback
  return def
}

/**
 * 双写收敛（REQ-12 RA-01）：creation.edit 与 render/tts 的重复字段互相同步。
 * 只在值确实不同时写入——避免「A 改 B、B 改 A」互相触发形成死循环。
 */
export function mirrorEditToRender(settings: AppSettings): void {
  const ed = settings.creation?.edit
  if (!ed || !settings.render || !settings.tts) return
  assignIfChanged(settings.render, 'defaultWidth', ed.defaultWidth)
  assignIfChanged(settings.render, 'defaultHeight', ed.defaultHeight)
  assignIfChanged(settings.render, 'defaultFrames', ed.defaultFrames)
  assignIfChanged(settings.render, 'timeout', ed.comfyTimeoutSec)
  assignIfChanged(settings.render, 'lipSync', ed.lipSync)
  assignIfChanged(settings.render, 'lipSyncMode', ed.lipSyncMode)
  assignIfChanged(settings.render, 'reviewGate', ed.reviewGate)
  assignIfChanged(settings.tts, 'rate', ed.ttsRate)
  assignIfChanged(settings.tts, 'volume', ed.ttsVolume)
}

/** 双写收敛反方向：设置「渲染/TTS」区改动写回 creation.edit */
export function mirrorRenderToEdit(settings: AppSettings): void {
  const ed = settings.creation?.edit
  if (!ed || !settings.render || !settings.tts) return
  assignIfChanged(ed, 'defaultWidth', settings.render.defaultWidth)
  assignIfChanged(ed, 'defaultHeight', settings.render.defaultHeight)
  assignIfChanged(ed, 'defaultFrames', settings.render.defaultFrames)
  assignIfChanged(ed, 'comfyTimeoutSec', settings.render.timeout)
  assignIfChanged(ed, 'lipSync', settings.render.lipSync)
  assignIfChanged(ed, 'lipSyncMode', settings.render.lipSyncMode)
  assignIfChanged(ed, 'reviewGate', settings.render.reviewGate)
  assignIfChanged(ed, 'ttsRate', settings.tts.rate)
  assignIfChanged(ed, 'ttsVolume', settings.tts.volume)
}

/** 仅在目标值与来源值不同时写入（同值写入无意义，且会触发响应式 watcher 回环） */
function assignIfChanged<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value === undefined) return
  if (target[key] !== value) target[key] = value as T[K]
}

export function resolveCreation(settings: AppSettings): CreationSettings {
  const c = settings.creation || DEFAULT_CREATION
  const edit: EditModuleSettings = {
    ...DEFAULT_EDIT,
    ...c.edit,
    defaultWidth: pickEdit(c.edit?.defaultWidth, settings.render?.defaultWidth, DEFAULT_EDIT.defaultWidth),
    defaultHeight: pickEdit(c.edit?.defaultHeight, settings.render?.defaultHeight, DEFAULT_EDIT.defaultHeight),
    defaultFrames: pickEdit(c.edit?.defaultFrames, settings.render?.defaultFrames, DEFAULT_EDIT.defaultFrames),
    comfyTimeoutSec: pickEdit(c.edit?.comfyTimeoutSec, settings.render?.timeout, DEFAULT_EDIT.comfyTimeoutSec),
    lipSync: pickEdit(c.edit?.lipSync, settings.render?.lipSync, DEFAULT_EDIT.lipSync),
    lipSyncMode: pickEdit(c.edit?.lipSyncMode, settings.render?.lipSyncMode, DEFAULT_EDIT.lipSyncMode),
    reviewGate: pickEdit(c.edit?.reviewGate, settings.render?.reviewGate, DEFAULT_EDIT.reviewGate),
    ttsRate: pickEdit(c.edit?.ttsRate, settings.tts?.rate, DEFAULT_EDIT.ttsRate),
    ttsVolume: pickEdit(c.edit?.ttsVolume, settings.tts?.volume, DEFAULT_EDIT.ttsVolume)
  }
  return {
    storyboard: { ...DEFAULT_STORYBOARD, ...c.storyboard },
    character: { ...DEFAULT_CHARACTER, ...c.character },
    scene: { ...DEFAULT_SCENE, ...c.scene },
    edit,
    presets: Array.isArray(c.presets) ? c.presets : []
  }
}

/** 效果摘要（设置页实时预览用，不触发生成） */
export function summarizeCreationEffects(c: CreationSettings): {
  storyboard: string[]
  character: string[]
  scene: string[]
  edit: string[]
} {
  const sb = c.storyboard
  const ch = c.character
  const sc = c.scene
  const ed = c.edit
  const sec = ((ed.defaultFrames - 1) / 16).toFixed(1)
  return {
    storyboard: [
      `镜头区间 ${sb.minShots}–${sb.maxShots}，温度 ${sb.temperature.toFixed(2)}`,
      `角色上限 ${sb.maxCharacters}`,
      `叙事校验：道具${sb.enforcePropLock ? '开' : '关'} / 反应${sb.enforceReactionBeats ? '开' : '关'} / 上车${sb.enforceBoardingChain ? '开' : '关'}`
    ],
    character: [
      `定妆 ${ch.faceWidth}×${ch.faceHeight}，三视图 ${ch.bodyWidth}×${ch.bodyHeight}`,
      `写实锁 ${ch.realismLock}，种子 ${ch.seedMode === 'fixed' ? ch.seed : '随机'}`,
      `抽卡 ${ch.candidates} 张${ch.llmPick ? ' + LLM 挑选' : ''}，工作流 ${ch.t2iWorkflow || '默认'}`
    ],
    scene: [
      sc.panorama
        ? `全景固定场景：${sc.plateWidth}×${sc.plateHeight} 全景裁 ${sc.panoViewsCount} 方位`
        : `场景板 ${sc.plateWidth}×${sc.plateHeight}，首尾帧 ${sc.frameWidth}×${sc.frameHeight}`,
      `空镜禁人 ${sc.emptyStrict ? '开' : '关'}，天气 ${sc.weatherHint}`,
      `抽卡 ${sc.candidates} 张${sc.llmPick ? ' + LLM 挑选' : ''}`
    ],
    edit: [
      `默认视频 ${ed.defaultWidth}×${ed.defaultHeight}，${ed.defaultFrames} 帧≈${sec}s`,
      `渲染抽卡 ${ed.renderCandidates} 条${ed.llmPick ? ' + LLM 挑选' : ''}`,
      `Comfy 超时 ${ed.comfyTimeoutSec}s，口型 ${ed.lipSync ? ed.lipSyncMode : '关'}`,
      `字幕 ${ed.subtitleFontSize}px / 底边距 ${ed.subtitleMarginV}，BGM 默认 ${ed.defaultBgmVolume}%`,
      `TTS 语速 ${ed.ttsRate}% / 音量 ${ed.ttsVolume}% ，复审 ${ed.reviewGate}`
    ]
  }
}
