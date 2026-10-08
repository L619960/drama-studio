/**
 * 主进程统一日志：分级 + scope 前缀 + 时间戳。
 * 替代散落的 console.log/warn，便于打包后追溯与未来接入 UI Console。
 * 设计为零依赖、无副作用，不阻塞调用方；首次调用即生效，无需初始化。
 */

export type LogLevel = 'info' | 'warn' | 'error'

export interface Logger {
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}

/** ISO 时间取到毫秒，仅保留 hh:mm:ss.SSS，避免日志过长 */
const ts = (): string => new Date().toISOString().slice(11, 23)

/**
 * 创建带 scope 前缀的 logger。
 * @example const log = createLogger('ComfyUI')
 *          log.info('WebSocket connected')
 *          // → "12:34:56.789 [ComfyUI] WebSocket connected"
 */
export function createLogger(scope: string): Logger {
  const tag = `[${scope}]`
  return {
    info: (msg, ...args) => console.log(`${ts()} ${tag} ${msg}`, ...args),
    warn: (msg, ...args) => console.warn(`${ts()} ${tag} ${msg}`, ...args),
    error: (msg, ...args) => console.error(`${ts()} ${tag} ${msg}`, ...args)
  }
}
