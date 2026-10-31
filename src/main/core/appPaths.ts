/**
 * 主进程数据目录解析（单一事实源）。
 *
 * 打包版的 Electron userData 由 productName 决定（可能是「本地AI短剧工坊」），
 * 先前 comfyuiClient / llmRequest 直接用 `%APPDATA%/drama-studio` 硬编码，
 * 打包后会与 `app.getPath('userData')` 分叉，日志/诊断落到另一个目录。
 *
 * 这里优先取 Electron userData；单测等无 Electron 运行时回退到
 * `%APPDATA%/drama-studio`（与原硬编码路径保持等价，测试断言不受影响）。
 */
import path from 'node:path'
import { createRequire } from 'node:module'

function electronUserData(): string {
  try {
    // 主进程构建产物是 CJS（electron-vite 默认），__filename 可用；单测按 ESM 跑时
    // __filename 未定义会抛 ReferenceError，由 catch 兜底走下面的环境变量回退。
    // 用 createRequire 而非直接 require()：避免触发 @typescript-eslint/no-require-imports。
    const electron = createRequire(__filename)('electron') as {
      app?: { getPath?: (name: string) => string }
    }
    const dir = electron?.app?.getPath?.('userData')
    if (dir) return dir
  } catch {
    // Electron 不可用（单测 / 纯 Node 工具脚本）：走环境变量回退
  }
  const base = process.env.APPDATA || process.env.HOME || process.cwd()
  return path.join(base, 'drama-studio')
}

/** 应用数据目录（等价于 app.getPath('userData')；无 Electron 时回退 APPDATA/drama-studio） */
export function userDataDir(): string {
  return electronUserData()
}

/** 应用日志目录（userData/logs，与 logger / errorHandler 保持一致） */
export function appLogsDir(): string {
  return path.join(userDataDir(), 'logs')
}
