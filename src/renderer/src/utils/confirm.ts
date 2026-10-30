import { ElMessageBox } from 'element-plus'

/**
 * 统一确认框（交互规范 1.3，2026-10-13 ux-standards.md）。
 * 按钮顺序固定：左「取消」右「确认」；ESC / 遮罩点击一律视为取消。
 * 危险操作（删除/清空/重置/覆盖）请用 confirmDanger，确认按钮自动染红。
 * 返回值：true=用户确认，false=取消或关闭。
 */

export interface ConfirmOptions {
  title?: string
  confirmText?: string
  cancelText?: string
}

function show(message: string, options: ConfirmOptions, danger: boolean): Promise<boolean> {
  return ElMessageBox.confirm(message, options.title ?? '操作确认', {
    confirmButtonText: options.confirmText ?? '确定',
    cancelButtonText: options.cancelText ?? '取消',
    confirmButtonClass: danger ? 'ds-danger-confirm' : '',
    distinguishCancelAndClose: true,
    ...(danger ? { type: 'warning' as const } : {}),
  })
    .then(() => true)
    .catch(() => false)
}

/** 危险操作确认（删除/清空/重置/覆盖等），确认按钮红色。confirmText 请传动作文案（如「删除」「重置」）。 */
export function confirmDanger(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  return show(message, options, true)
}

/** 普通操作确认（覆盖/重新生成/批量等）。 */
export function confirmAction(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  return show(message, options, false)
}

export type UnreviewedBatchAction = 'review' | 'render' | 'cancel'

/**
 * 未审镜入队前的三选一确认（REQ-04）：
 * 「去审看」为主按钮，右下；「仍要渲染」为次按钮，左下；ESC/遮罩 = 取消（不放行）。
 */
export function confirmUnreviewedBatch(
  message: string,
  title = '分镜未核对'
): Promise<UnreviewedBatchAction> {
  return ElMessageBox.confirm(message, title, {
    confirmButtonText: '去审看',
    cancelButtonText: '仍要渲染',
    distinguishCancelAndClose: true,
    type: 'warning'
  })
    .then(() => 'review' as const)
    .catch((action: unknown) => (action === 'cancel' ? 'render' as const : 'cancel' as const))
}
