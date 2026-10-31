import type { DirectorStage, AppSettings } from '../../shared/ipcTypes'

/**
 * AI 导演流水线的共享常量与纯函数（从 directorAgent.ts 抽出，
 * stateMachine / pipeline / assetBuilder / finish 等子模块共用）。
 */

export const STAGE_ORDER: DirectorStage[] = [
  'analyze',
  'casting',
  'scenes',
  'render',
  'combine',
  'subtitle',
  'review',
  'bgm',
  'done',
]

export const STAGE_LABELS: Record<DirectorStage, string> = {
  analyze: '剧本分析',
  casting: '角色建档',
  scenes: '场景板与首尾帧',
  render: '逐镜渲染 · 审批',
  combine: '拼接成片',
  subtitle: '烧录字幕',
  review: '成片复审',
  bgm: 'BGM 混音',
  done: '完成',
}

/** 阶段序号（断点续跑的先后比较用） */
export function stageIndexOf(stage: DirectorStage): number {
  return STAGE_ORDER.indexOf(stage)
}

/**
 * P2-2：读取「按阶段配置」的图片工作流覆盖值；未配置返回 undefined，由调用方回退内置默认。
 * 注意不回退 settings.workflow.default——后者是视频渲染默认（wan22_i2v 等），
 * 拿它来做 t2i/i2i 会直接选错模型。
 */
export function stageWorkflowOverride(
  settings: AppSettings | undefined | null,
  stage: 'casting' | 'scene' | 'shot' | 'prop',
): string | undefined {
  const v = settings?.workflow?.[stage]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/** 日志自增序号上限（每项目） */
export const LOG_LIMIT = 300
/** C 自愈预算：每项目每次流水线运行最多自动重试次数 */
export const HEAL_MAX = 2

/**
 * 从全景方位图中按镜头机位选一张（青橙Lab「全景固定场景」）。
 * 方位约定（cropPanoramaViews 从左到右裁）：view0=前视(默认)、view1=右90°、view2=后180°、view3=左270°；
 * panoViews 数量不足时取最后一档兜底。
 */
export function pickPanoView(camera: string | undefined, views: string[] | undefined): string | undefined {
  if (!views?.length) return undefined
  const cam = (camera || '').toLowerCase()
  let idx = 0
  if (/\b(left)\b|portrait side/.test(cam)) idx = Math.min(views.length - 1, 3)
  else if (/\b(right)\b|profile/.test(cam)) idx = Math.min(views.length - 1, 1)
  else if (/back|behind|rear|over-?shoulder|from behind/.test(cam)) idx = Math.min(views.length - 1, 2)
  return views[idx]
}

// 按性别轮转分配音色（非空元组：首项可作兜底，轮转取模后必为 string）
export const FEMALE_VOICES: readonly [string, ...string[]] = ['zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural']
export const MALE_VOICES: readonly [string, ...string[]] = [
  'zh-CN-YunjianNeural',
  'zh-CN-YunyeNeural',
  'zh-CN-YunjieNeural',
]
