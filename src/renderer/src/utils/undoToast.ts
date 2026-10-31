import { h } from 'vue'
import { ElMessage } from 'element-plus'
import { createUndoWindow } from '../../../shared/undoWindow'

export interface UndoToastOptions {
  /** 窗口时长（毫秒），默认 5000 */
  durationMs?: number
  /** 撤销按钮文案，默认「撤销」 */
  actionText?: string
}

/**
 * REQ-16：带「撤销」按钮的短时 toast。
 * - 点撤销：执行 onUndo 并关闭 toast；
 * - toast 超时/手动关闭：执行 onCommit（真正删除）。
 */
export function showUndoToast(
  message: string,
  onUndo: () => void | Promise<void>,
  onCommit: () => void | Promise<void>,
  options: UndoToastOptions = {}
): void {
  const durationMs = options.durationMs ?? 5000
  let closeToast: (() => void) | null = null
  const window = createUndoWindow({ onUndo, onCommit }, durationMs)
  const toast = ElMessage({
    type: 'warning',
    duration: durationMs,
    showClose: true,
    message: h('span', { class: 'undo-toast' }, [
      h('span', null, message),
      h(
        'button',
        {
          type: 'button',
          style: 'margin-left:12px;background:none;border:none;padding:0;cursor:pointer;font-weight:600;color:var(--brand-strong);',
          onClick: () => {
            // 先结算撤销，再关闭 toast：避免关闭回调抢先按「未撤销」提交
            void window.undo()
            closeToast?.()
          }
        },
        options.actionText || '撤销'
      )
    ]),
    onClose: () => { void window.close() }
  })
  closeToast = () => toast.close()
}
