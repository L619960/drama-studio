import type { ErrorKind, Shot } from '../../../shared/ipcTypes'

export const ERROR_KIND_TEXT: Record<ErrorKind, string> = {
  oom: '显存不足',
  transient: '瞬时异常',
  permanent: '需人工处理',
  unknown: '未知原因'
}

/** 按失败分层给出可执行引导（队列失败行 / 详情展示） */
export function errorKindHint(kind?: ErrorKind): string {
  switch (kind) {
    case 'oom':
      return '显存不足：请检查显存占用或降低分辨率档位后重试'
    case 'transient':
      return '瞬时异常：网络/服务恢复后可直接重试'
    case 'permanent':
      return '需人工修改提示词或参数后再渲染'
    case 'unknown':
      return '未识别的失败原因，请查看完整错误信息'
    default:
      return ''
  }
}

/** 「已自动降档重试 1/2」机读文案；无自动重试时不展示 */
export function retryBadge(shot: Pick<Shot, 'retryCount' | 'retryBudget'>): string {
  if (!shot.retryCount) return ''
  return `已自动降档重试 ${shot.retryCount}/${shot.retryBudget ?? 2}`
}

/** 取消类 reject 白名单：用户在文件选择框取消不应弹「操作失败」 */
export function isCancelReject(message: string): boolean {
  const msg = message.trim()
  return msg === 'User cancelled' ||
    /^(__CANCELLED__|cancel(l)?ed|已取消|用户取消)$/i.test(msg)
}
