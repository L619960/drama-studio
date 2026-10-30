import type { ShotSize } from '../../../shared/ipcTypes'

/**
 * REQ-09 镜头语言字段（景别/机位/情绪）录入选项。
 * 渲染提示词消费的是英文短语，因此选项 value 存英文、label 展示中文；
 * LLM 拆镜写入的其他英文短语原样回显，不做强制映射。
 */
export interface MetaOption {
  value: string
  label: string
}

export const SHOT_SIZE_OPTIONS: ReadonlyArray<{ value: ShotSize; label: string }> = [
  { value: 'closeup', label: '特写' },
  { value: 'medium', label: '中景' },
  { value: 'wide', label: '远景' }
]

export const CAMERA_OPTIONS: ReadonlyArray<MetaOption> = [
  { value: 'eye-level', label: '平视' },
  { value: 'high-angle downward', label: '俯拍' },
  { value: 'low-angle upward', label: '仰拍' },
  { value: 'over-the-shoulder', label: '过肩' },
  { value: 'top-down view', label: '顶视' }
]

export const EMOTION_OPTIONS: ReadonlyArray<MetaOption> = [
  { value: 'calm', label: '平静' },
  { value: 'tense', label: '紧张' },
  { value: 'sad', label: '悲伤' },
  { value: 'joyful', label: '喜悦' },
  { value: 'angry', label: '愤怒' }
]

/** 命中选项返回中文标签，未命中原样返回（LLM 生成的自由短语不丢失） */
export function metaLabel(options: ReadonlyArray<MetaOption>, value?: string): string {
  const v = (value || '').trim()
  if (!v) return ''
  return options.find(o => o.value.toLowerCase() === v.toLowerCase())?.label || v
}

/** 审核/列表展示景别：空值明确写「未设定（默认中景）」，不再恒红 */
export function displayShotSize(value?: string): string {
  return value ? metaLabel(SHOT_SIZE_OPTIONS, value) : '未设定（默认中景）'
}
