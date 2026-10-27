import { defineConfig } from '@playwright/test'

// E2E（Electron）起步：只做 smoke——启动打包后的主进程，窗口能加载、不崩、截图。
// 运行：npm run test:e2e （前置：先 npm run build 生成 out/）
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    // Electron 不使用浏览器 channel
  }
})
