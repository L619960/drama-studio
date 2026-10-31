/**
 * P1-05 真实链路 E2E（剧本 → 拆镜 → 首帧 → 渲染 → 成片）。
 *
 * 前置（缺一不可）：
 *   1. npm run build（本 spec 启动 out/ 产物）
 *   2. 本机 ComfyUI 已启动且模型齐备（设置已配置 baseUrl / API Key）
 *   3. 有可用 GPU 与足够显存；一次完整跑通需要数分钟
 * 运行：
 *   PowerShell: $env:E2E_REAL_CHAIN=1; npm run test:e2e -- real-chain
 * 未设置 E2E_REAL_CHAIN=1 时自动跳过，不进入日常 CI（见 .github/workflows/nightly.yml 说明）。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const enabled = process.env.E2E_REAL_CHAIN === '1'

// 最小测试剧本：2 镜、单一场景、无对白（避开 TTS/口型依赖，缩短链路）
const MINI_SCRIPT = `雨夜，城市天台。
第1镜：林川推开天台铁门，雨水打湿黑色大衣，他望向远处的霓虹。
第2镜：林川走到栏杆边，低头点燃一支烟，火光映亮半张脸。`

test.skip(!enabled, '需要本机 ComfyUI/GPU，设置 E2E_REAL_CHAIN=1 后运行')

test('真实链路: 剧本 → 拆镜 → 首帧 → 渲染 → 成片', async () => {
  test.setTimeout(15 * 60_000)

  const app = await electron.launch({
    args: ['.'],
    cwd: resolve(here, '..'),
    timeout: 30_000
  })
  const win = await app.firstWindow()
  const pageErrors: string[] = []
  win.on('pageerror', err => pageErrors.push(String(err)))

  await win.waitForLoadState('domcontentloaded', { timeout: 20_000 })
  await win.waitForSelector('#app', { timeout: 15_000 })

  // 1) 订阅完成事件（先挂监听再开拍，避免错过结束事件）
  await win.evaluate(() => {
    const w = window as unknown as {
      api: { director: { onFinished: (cb: (e: unknown) => void) => () => void } }
      __e2eFinished?: Promise<unknown>
    }
    w.__e2eFinished = new Promise(res => w.api.director.onFinished(e => res(e)))
  })

  // 2) 开拍：跳过所有阶段确认点，全自动跑到成片
  const projectId = await win.evaluate(script => {
    const w = window as unknown as {
      api: { director: { start: (input: unknown) => Promise<string> } }
    }
    return w.api.director.start({ title: 'E2E 最小短剧', genre: '悬疑', script, gateStages: [] })
  }, MINI_SCRIPT)
  expect(projectId).toBeTruthy()

  // 3) 等待收尾事件
  const finished = (await win.evaluate(
    () => (window as unknown as { __e2eFinished: Promise<unknown> }).__e2eFinished
  )) as {
    success: boolean
    cancelled: boolean
    failedShotIds: string[]
    finalPath?: string
    message: string
  }

  // 4) 断言：成功、无失败镜、成片存在且 ffprobe 可解析
  expect(finished.cancelled, `任务被取消：${finished.message}`).toBe(false)
  expect(finished.failedShotIds, `失败镜：${finished.failedShotIds.join(',')}`).toEqual([])
  expect(finished.success, `流水线未成功：${finished.message}`).toBe(true)
  expect(finished.finalPath, '未返回成片路径').toBeTruthy()

  const userData = (await app.evaluate(({ app: a }) => a.getPath('userData'))) as string
  const dataRoot = join(userData, 'drama-studio')
  const finalAbs = join(dataRoot, String(finished.finalPath).replace(/^projects[\\/]/, 'projects/'))
  expect(existsSync(finalAbs), `成片不存在：${finalAbs}`).toBe(true)

  // ffprobe-static 在依赖里随包分发；直接调用取时长/分辨率
  const { default: ffprobeStatic } = (await import('ffprobe-static')) as unknown as {
    default: { path: string }
  }
  const info = JSON.parse(
    execFileSync(ffprobeStatic.path, [
      '-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_type',
      '-of', 'json', finalAbs
    ], { encoding: 'utf-8' })
  ) as {
    format?: { duration?: string }
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>
  }
  const duration = Number(info.format?.duration ?? 0)
  expect(duration).toBeGreaterThan(2)
  const video = info.streams?.find(s => s.codec_type === 'video')
  expect(video?.width).toBeGreaterThan(0)
  expect(video?.height).toBeGreaterThan(0)

  // 5) 渲染期不应出现致命页面错误
  const fatal = pageErrors.filter(m => !/ECONNREFUSED|WebSocket|NetworkError|net::ERR/.test(m))
  expect(fatal, `致命页面错误: ${fatal.join('\n')}`).toEqual([])

  await app.close()
})
