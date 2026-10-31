export interface UndoWindowCallbacks {
  /** 用户点击「撤销」：恢复暂存内容 */
  onUndo: () => void | Promise<void>
  /** 窗口结束（自然超时或关闭 toast）：提交删除 */
  onCommit: () => void | Promise<void>
}

export interface UndoWindowHandle {
  /** 用户点撤销（只会结算一次） */
  undo(): Promise<void>
  /** toast 关闭/超时：按未撤销处理并提交 */
  close(): Promise<void>
  /** 放弃本窗口：既不撤销也不提交（组件卸载等） */
  dispose(): void
}

/**
 * REQ-16：删除后悔窗口（默认 5 秒）。
 * 只结算一次：撤销后不会再走提交；超时后撤销按钮消失，删除真正生效。
 * 纯状态机便于单测，UI 由 renderer 侧 toast 封装。
 */
export function createUndoWindow(
  callbacks: UndoWindowCallbacks,
  durationMs = 5000
): UndoWindowHandle {
  let settled = false
  const timer = setTimeout(() => { void settle(false) }, durationMs)

  async function settle(undone: boolean): Promise<void> {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (undone) {
      await callbacks.onUndo()
    } else {
      await callbacks.onCommit()
    }
  }

  return {
    undo: () => settle(true),
    close: () => settle(false),
    dispose: () => {
      settled = true
      clearTimeout(timer)
    }
  }
}
