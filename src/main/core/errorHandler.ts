/**
 * 主进程全局异常兜底（从 src/main/index.ts 抽离，便于单测）。
 *
 * 未捕获的 Promise rejection / 同步异常落盘到 <userData>/logs/main-error.log，
 * 防主进程静默崩溃。写日志用同步 API（进程可能正在退出，异步 fs 来不及 flush）；
 * 目录创建失败等全部静默吞掉。
 */
import { join } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'

/**
 * 写一条错误日志到 <logDir>/main-error.log。
 * @param kind  'unhandledRejection' | 'uncaughtException'
 * @param err   原始错误值
 * @param logDir 日志目录（生产态由调用方传 app.getPath('userData')）
 */
export function appendMainErrorLog(kind: string, err: unknown, logDir: string): void {
  try {
    mkdirSync(logDir, { recursive: true })
    const stack = (err && typeof err === 'object' && 'stack' in err)
      ? String((err as { stack: unknown }).stack)
      : String(err)
    appendFileSync(join(logDir, 'main-error.log'), `${new Date().toISOString()} ${kind}: ${stack}\n`)
  } catch {
    /* 日志写失败不再二次抛出 */
  }
}

/** unhandledRejection 处理器：console.error + 落盘。 */
export function handleUnhandledRejection(reason: unknown, logDir: string): void {
  // eslint-disable-next-line no-console
  console.error('[unhandledRejection]', reason)
  appendMainErrorLog('unhandledRejection', reason, logDir)
}

/** uncaughtException 处理器：console.error + 落盘。 */
export function handleUncaughtException(err: unknown, logDir: string): void {
  // eslint-disable-next-line no-console
  console.error('[uncaughtException]', err)
  appendMainErrorLog('uncaughtException', err, logDir)
}

/**
 * 安装全局 process 监听器。生产入口 index.ts 调用一次即可。
 * 测试不调用本函数，直接调 handle* 函数断言。
 */
export function installGlobalErrorHandlers(logDir: string): void {
  process.on('unhandledRejection', (reason) => handleUnhandledRejection(reason, logDir))
  process.on('uncaughtException', (err) => handleUncaughtException(err, logDir))
}
