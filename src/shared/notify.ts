import type { DirectorFinishedEvent } from './ipcTypes'

/** 系统通知文案（标题 + 正文） */
export interface NotificationCopy {
  title: string
  body: string
}

/**
 * REQ-15：任务终态系统通知文案。
 * - 用户主动取消不通知（操作本身就在眼前）；
 * - 完成：`《片名》渲染完成，共 N 镜`；
 * - 失败：`《片名》任务失败：<收尾原因>`。
 * 返回 null 表示本次不发通知。
 */
export function buildFinishedNotification(event: DirectorFinishedEvent): NotificationCopy | null {
  if (event.cancelled) return null
  const name = event.title?.trim() || '未命名项目'
  if (event.success) {
    const shots = Number.isFinite(event.totalShots) && (event.totalShots as number) > 0
      ? `，共 ${event.totalShots} 镜`
      : ''
    return { title: '渲染完成', body: `《${name}》渲染完成${shots}` }
  }
  const reason = (event.message || '').trim()
  return { title: '任务失败', body: `《${name}》任务失败${reason ? `：${reason}` : ''}` }
}
