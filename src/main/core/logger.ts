/**
 * 主进程统一日志：分级 + scope 前缀 + 时间戳 + 文件落盘 + 轮转。
 * 替代散落的 console.log/warn，便于打包后追溯；P2-1 起支持落盘（userData/logs/main.log）。
 *
 * - 级别过滤：环境变量 LOG_LEVEL=debug|info|warn|error（默认 info，debug 仅控制台+落盘均输出）
 * - 落盘：`initFileLogger(dir)` 在 app ready 后调用（logger 模块本身零副作用，便于单测）
 * - 轮转：单文件 5MB 上限，保留 main.log.1 ~ main.log.2 两个历史文件
 * - 写入：缓冲 300ms 批量 appendFileSync，避免每行日志都同步 IO 阻塞主进程
 */

import * as fs from 'node:fs'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(msg: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function parseLevel(v: string | undefined): LogLevel {
  const s = (v || '').trim().toLowerCase()
  return s === 'debug' || s === 'info' || s === 'warn' || s === 'error' ? s : 'info'
}

let minLevel: LogLevel = parseLevel(process.env.LOG_LEVEL)
let logFilePath = ''
let currentBytes = 0
let pending: string[] = []
let flushTimer: NodeJS.Timeout | null = null

const MAX_LOG_BYTES = 5 * 1024 * 1024
const ROTATE_KEEP = 2

/** ISO 时间取到毫秒，仅保留 hh:mm:ss.SSS，避免日志过长 */
const ts = (): string => new Date().toISOString().slice(11, 23)

function fmtArg(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Error) return v.stack || v.message
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function rotate(): void {
  if (!logFilePath) return
  try {
    const oldest = `${logFilePath}.${ROTATE_KEEP}`
    if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true })
    for (let i = ROTATE_KEEP - 1; i >= 1; i--) {
      const from = `${logFilePath}.${i}`
      if (fs.existsSync(from)) fs.renameSync(from, `${logFilePath}.${i + 1}`)
    }
    if (fs.existsSync(logFilePath)) fs.renameSync(logFilePath, `${logFilePath}.1`)
    currentBytes = 0
  } catch { /* 轮转失败不阻断日志 */ }
}

function flush(): void {
  flushTimer = null
  if (!logFilePath || !pending.length) return
  const chunk = pending.join('')
  pending = []
  try {
    if (currentBytes + Buffer.byteLength(chunk) > MAX_LOG_BYTES) rotate()
    fs.appendFileSync(logFilePath, chunk, 'utf-8')
    currentBytes += Buffer.byteLength(chunk)
  } catch { /* 落盘失败不影响主流程 */ }
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(flush, 300)
  flushTimer.unref?.()
}

/** 初始化文件日志（app ready 后调用；重复调用幂等） */
export function initFileLogger(logDir: string): void {
  if (logFilePath) return
  try {
    fs.mkdirSync(logDir, { recursive: true })
    logFilePath = `${logDir}/main.log`
    currentBytes = fs.existsSync(logFilePath) ? fs.statSync(logFilePath).size : 0
    if (currentBytes >= MAX_LOG_BYTES) rotate()
    // 退出前把缓冲日志刷盘（app.exit 前 last chance）
    process.on('exit', flush)
    process.on('beforeExit', flush)
  } catch {
    logFilePath = ''
  }
}

/** 运行期调整级别（测试/诊断用） */
export function setLogLevel(level: LogLevel): void {
  minLevel = level
}

function emit(level: LogLevel, scope: string, msg: string, args: unknown[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return
  // 控制台保持原格式「hh:mm:ss.SSS [scope] msg」+ 附加参数透传（保留对象的原生打印）
  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  consoleFn(`${ts()} [${scope}] ${msg}`, ...args)
  if (!logFilePath) return
  // 落盘额外带上级别，便于事后按级别过滤
  pending.push(`${ts()} ${level.toUpperCase()} [${scope}] ${msg}${args.length ? ' ' + args.map(fmtArg).join(' ') : ''}\n`)
  scheduleFlush()
}

/**
 * 创建带 scope 前缀的 logger。
 * @example const log = createLogger('ComfyUI')
 *          log.info('WebSocket connected')
 *          // → "12:34:56.789 INFO [ComfyUI] WebSocket connected"
 */
export function createLogger(scope: string): Logger {
  return {
    debug: (msg, ...args) => emit('debug', scope, msg, args),
    info: (msg, ...args) => emit('info', scope, msg, args),
    warn: (msg, ...args) => emit('warn', scope, msg, args),
    error: (msg, ...args) => emit('error', scope, msg, args)
  }
}
