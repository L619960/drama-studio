import { app, BrowserWindow, ipcMain } from 'electron'
import { join, resolve, sep, isAbsolute } from 'node:path'
import { realpathSync } from 'node:fs'
import { sanitizeErrorText } from '../../shared/errorSanitize'

// 统一数据根目录：userData/drama-studio
// ProjectStore 的 projects 目录 = DATA_ROOT/projects
// 相对路径（如 projects/<id>/segments/x.mp4）一律相对 DATA_ROOT 解析
export const DATA_ROOT = join(app.getPath('userData'), 'drama-studio')
export const DATA_ROOT_RESOLVED = resolve(DATA_ROOT)
// 真实根路径：DATA_ROOT 若在磁盘上是 symlink/junction，词法比对会被绕过（I-8）
export const DATA_ROOT_REAL = (() => {
  try {
    return resolve(realpathSync(DATA_ROOT_RESOLVED))
  } catch {
    return DATA_ROOT_RESOLVED
  }
})()

const normPath = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)

/** 相对 DATA_ROOT 路径 → 窗口内 <video> 用的 app-file URL */
export function toAppFileUrl(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  const pathPart = normalized.split('/').map(encodeURIComponent).join('/')
  return `app-file://local/${pathPart}`
}

/**
 * 安全路径解析：相对路径相对 DATA_ROOT；绝对路径（旧数据兼容）也必须位于
 * DATA_ROOT 之内。防止目录穿越访问数据目录之外的文件。
 * I-8：已存在的路径用 realpath 比对识别符号链接逃逸（不存在则词法比对）；
 * Windows 下大小写不敏感。
 */
export function resolveInsideRoot(inputPath: string): string {
  const abs = resolve(isAbsolute(inputPath) ? inputPath : join(DATA_ROOT, inputPath))
  let real = abs
  try {
    real = resolve(realpathSync(abs))
  } catch {
    // 目标尚不存在（待创建的输出文件）：按词法路径校验
  }
  const target = normPath(real)
  const root = normPath(DATA_ROOT_REAL)
  const rootPrefix = root.endsWith(sep) ? root : root + sep
  if (target !== root && !target.startsWith(rootPrefix)) {
    throw new Error('非法路径：已拒绝数据根目录之外的访问')
  }
  return abs
}

/** 会话标识白名单：scope 直接拼文件名，主进程入口先挡一轮（I-13，服务层另有兜底） */
export function assertScope(scope: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(scope)) {
    throw new Error('非法会话标识')
  }
}

let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win
}

/** 进度/日志等事件统一经此转发：窗口已销毁时静默丢弃，避免对已销毁窗口调用 send 抛错中断渲染任务 */
export function sendToWindow(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

const rawIpcHandle = ipcMain.handle.bind(ipcMain)

/**
 * 统一 IPC handler 包装（I-10）：主进程异常先记主进程日志（含通道名，路径脱敏）
 * 再脱敏后透传（SEC-05：数据根路径 → <DATA_ROOT>、密钥样式掩码、截断 500 字）。
 * 此前 65 个 handler 裸注册，底层异常原文直透渲染层且主进程无日志可查。
 * 注意：渲染层按 Error.message 展示，故保留原始可读文案，只做敏感信息清洗。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPC 边界：渲染层透传参数为不可信外部输入，各 handler 内部自行断言
export function handleIpc(channel: string, fn: (...args: any[]) => unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPC 边界：args 来自渲染层，类型在业务 handler 内收窄
  rawIpcHandle(channel, async (_event, ...args: any[]) => {
    try {
      // 必须回传 event：业务 handler 首形参是 invokeEvent 占位，
      // 丢掉会导致所有带参 handler 参数左移一位（settings:save 报 ERR_INVALID_ARG_TYPE 即此因）
      return await fn(_event, ...args)
    } catch (err) {
      const sanitized = sanitizeErrorText(err instanceof Error ? err.message : String(err), {
        dataRoot: DATA_ROOT_RESOLVED,
      })
      console.error(`[IPC] ${channel} 失败: ${sanitized}`)
      throw new Error(sanitized, { cause: err })
    }
  })
}
