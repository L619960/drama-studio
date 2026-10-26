/** 项目 / 镜头状态 → Element Plus Tag type 与中文文案（三视图共用） */

export type StatusTagType = 'info' | 'success' | 'warning' | 'danger'

const TAG_TYPE: Record<string, StatusTagType> = {
  draft: 'info',
  pending: 'info',
  rendering: 'warning',
  done: 'success',
  failed: 'danger'
}

const PROJECT_TEXT: Record<string, string> = {
  draft: '草稿',
  rendering: '渲染中',
  done: '完成',
  failed: '失败'
}

const SHOT_TEXT: Record<string, string> = {
  pending: '待渲染',
  rendering: '渲染中',
  done: '完成',
  failed: '失败'
}

export function statusTagType(status: string): StatusTagType {
  return TAG_TYPE[status] || 'info'
}

export function projectStatusText(status: string): string {
  return PROJECT_TEXT[status] || status
}

/** @param pendingLabel 队列页用「排队中」，分镜页默认「待渲染」 */
export function shotStatusText(status: string, pendingLabel: '待渲染' | '排队中' = '待渲染'): string {
  if (status === 'pending') return pendingLabel
  return SHOT_TEXT[status] || status
}

export function formatLocaleTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN')
}
