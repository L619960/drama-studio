import { test, expect, _electron as electron } from '@playwright/test'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// Smoke：启动 Electron 主进程 → 窗口加载完成 → 无致命 pageerror → 截图留证。
// 不验证业务渲染细节，只确认应用"能起来不崩"。
test('smoke: 应用窗口加载且无致命错误', async () => {
  const app = await electron.launch({
    args: ['.'],
    cwd: resolve(here, '..'),
    timeout: 30_000
  })

  // 进程级：退出码异常 / 启动失败直接暴露
  const win = await app.firstWindow()

  const pageErrors: string[] = []
  win.on('pageerror', err => pageErrors.push(String(err)))

  await win.waitForLoadState('domcontentloaded', { timeout: 20_000 })
  // 渲染根容器存在
  await win.waitForSelector('#app', { timeout: 15_000 })
  // 给 Vue 挂载一点时间
  await win.waitForTimeout(1500)

  await win.screenshot({ path: 'e2e/smoke-window.png' })

  const title = await win.title().catch(() => '(无标题)')
  console.log('窗口标题:', title)

  await app.close()

  // 过滤掉已知的非致命网络错误（ComfyUI/边缘服务未启动时的 ECONNREFUSED 属预期）
  const fatal = pageErrors.filter(m =>
    !/ECONNREFUSED|WebSocket|NetworkError|net::ERR/.test(m)
  )
  expect(fatal, `致命页面错误: ${fatal.join('\n')}`).toEqual([])
})
