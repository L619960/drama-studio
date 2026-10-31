export interface ComfyStatusWatcherOptions {
  /** 健康检查：返回是否在线（抛错按离线处理） */
  check: () => Promise<boolean>
  /** 状态翻转时回调（含首次确定的状态） */
  onChange: (connected: boolean) => void
  /** 轮询间隔，默认 15s */
  intervalMs?: number
}

export interface ComfyStatusWatcher {
  /** 立即检查一次（并发保护：上一次未完成时跳过） */
  poll(): Promise<void>
  start(): void
  stop(): void
}

/**
 * REQ-15 MP-07：主进程 ComfyUI 连接状态轮询。
 * 仅在状态翻转（含首次确定）时回调，避免每轮都向渲染层推事件；
 * 恢复在线后自然继续下一次轮询，渲染条据此自动从「已断开」恢复。
 */
export function createComfyStatusWatcher(opts: ComfyStatusWatcherOptions): ComfyStatusWatcher {
  const intervalMs = opts.intervalMs ?? 15_000
  let last: boolean | null = null
  let inFlight = false
  let timer: ReturnType<typeof setInterval> | null = null

  async function poll(): Promise<void> {
    if (inFlight) return
    inFlight = true
    let connected: boolean
    try {
      connected = await opts.check()
    } catch {
      connected = false
    } finally {
      inFlight = false
    }
    if (last !== null && connected === last) return
    last = connected
    opts.onChange(connected)
  }

  return {
    poll,
    start(): void {
      if (timer !== null) return
      void poll()
      timer = setInterval(() => void poll(), intervalMs)
    },
    stop(): void {
      if (timer !== null) clearInterval(timer)
      timer = null
    }
  }
}
