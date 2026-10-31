import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const evidenceDir = resolve(here, '../docs/audit/evidence/acceptance-2026-10-31')

interface StepRecord {
  name: string
  ok: boolean
  ms: number
  detail: string
  error?: string
}

interface PageRecord {
  route: string
  heading: string
  ms: number
  buttons: { text: string; disabled: boolean }[]
  toasts: string[]
  errorCount: number
}

const steps: StepRecord[] = []
const pages: PageRecord[] = []
const consoleErrors: { kind: string; text: string }[] = []
const pageErrors: string[] = []
const mainLogs: string[] = []

async function record(name: string, fn: () => Promise<string | void>): Promise<void> {
  const started = Date.now()
  try {
    const detail = (await fn()) || ''
    steps.push({ name, ok: true, ms: Date.now() - started, detail })
  } catch (e) {
    const msg = e instanceof Error ? `${e.message}\n${e.stack || ''}` : String(e)
    steps.push({ name, ok: false, ms: Date.now() - started, detail: '', error: msg })
  }
}

/** 读取当前页面的可见按钮清单（文案 + 是否禁用），用于死按钮/禁用态核查 */
async function readButtons(win: Page): Promise<{ text: string; disabled: boolean }[]> {
  return win.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[]
    return nodes
      .filter((b) => {
        const r = b.getBoundingClientRect()
        const style = getComputedStyle(b)
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      })
      .map((b) => ({
        text: (b.innerText || b.getAttribute('aria-label') || b.title || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 40),
        disabled: b.disabled || b.getAttribute('aria-disabled') === 'true'
      }))
      .filter((b) => b.text.length > 0)
  })
}

async function readToasts(win: Page): Promise<string[]> {
  return win.evaluate(() => {
    return Array.from(document.querySelectorAll('.el-message--error, .el-message--warning'))
      .map((n) => (n as HTMLElement).innerText.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
  })
}

async function goto(win: Page, hash: string, headingText: string, selector = '.page-header h1'): Promise<number> {
  const started = Date.now()
  await win.evaluate((h: string) => {
    window.location.hash = h
  }, hash)
  await win.locator(selector).first().waitFor({ timeout: 20_000 })
  await expect(win.locator(selector).first()).toHaveText(new RegExp(headingText), { timeout: 10_000 })
  return Date.now() - started
}

test('交付验收：全页面走查、按钮清点与错误采集', async () => {
  test.setTimeout(240_000)
  mkdirSync(evidenceDir, { recursive: true })
  const userData = mkdtempSync(join(tmpdir(), 'ds-acceptance-'))

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: resolve(here, '..'),
    timeout: 40_000,
    env: { ...process.env, DS_ACCEPTANCE: '1' } as Record<string, string>
  })
  const proc = app.process()
  proc.stderr?.on('data', (buf: Buffer) => mainLogs.push(buf.toString()))
  proc.stdout?.on('data', (buf: Buffer) => mainLogs.push(buf.toString()))

  const launchStart = Date.now()
  const win = await app.firstWindow()
  win.on('pageerror', (err) => pageErrors.push(String(err)))
  win.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      consoleErrors.push({ kind: msg.type(), text: msg.text() })
    }
  })
  win.on('requestfailed', (req) => {
    const url = req.url()
    if (!/app-file:|comfyui|127\.0\.0\.1:8188/.test(url)) {
      consoleErrors.push({ kind: 'requestfailed', text: `${url} ${req.failure()?.errorText || ''}` })
    }
  })

  await win.waitForLoadState('domcontentloaded', { timeout: 20_000 })
  await win.waitForSelector('#app', { timeout: 20_000 })
  const firstPaintMs = Date.now() - launchStart
  steps.push({ name: '窗口启动与首屏挂载', ok: true, ms: firstPaintMs, detail: `首屏 #app 就绪 ${firstPaintMs}ms` })
  await win.screenshot({ path: join(evidenceDir, '01-launch.png') })

  // ===== 隐藏入口 1：首次运行向导 =====
  await record('首次运行向导：出现且可三步导航/跳过', async () => {
    const wizard = win.locator('.first-run-wizard')
    await wizard.waitFor({ timeout: 15_000 })
    await win.screenshot({ path: join(evidenceDir, '02-first-run-wizard.png') })
    const stepTitles = await win.locator('.wizard-steps .el-step__title').allInnerTexts()
    await win.locator('button:has-text("下一步")').click()
    await win.locator('button:has-text("上一步")').waitFor()
    await win.locator('button:has-text("上一步")').click()
    await win.locator('button:has-text("跳过引导")').click()
    await win.locator('.first-run-wizard').waitFor({ state: 'hidden', timeout: 10_000 })
    return `步骤标题: ${stepTitles.join(' / ')}`
  })

  // ===== 项目列表：新建项目（含空标题校验） =====
  await record('项目列表：新建项目对话框与空标题校验', async () => {
    await win.locator('.page-header h1:has-text("项目")').waitFor({ timeout: 15_000 })
    await win.locator('button:has-text("新建项目")').first().click()
    const dialog = win.locator('.el-dialog:has-text("新建项目")')
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.locator('button:has-text("创建")').click()
    const warn = win.locator('.el-message--warning')
    await warn.first().waitFor({ timeout: 5_000 }).catch(() => undefined)
    const warnText = await warn.first().innerText().catch(() => '')
    await dialog.locator('input').first().fill('验收演示项目')
    await dialog.locator('button:has-text("创建")').click()
    await win.locator('.page-header h1:has-text("分镜编辑")').waitFor({ timeout: 20_000 })
    return `空标题提示: ${warnText.replace(/\s+/g, ' ')}`
  })

  const hash = await win.evaluate(() => window.location.hash)
  const projectId = /\/project\/([^/]+)\//.exec(hash)?.[1] || ''
  expect(projectId, '项目创建后应进入 /project/<id>/storyboard').toBeTruthy()
  await win.screenshot({ path: join(evidenceDir, '03-storyboard-empty.png') })

  const routes: { hash: string; heading: string; selector?: string; file: string }[] = [
    { hash: '#/', heading: '项目', file: '04-projects.png' },
    { hash: '#/console', heading: '导演控制台', selector: '.aside-title', file: '05-console-global.png' },
    { hash: `#/project/${projectId}/console`, heading: '导演控制台', selector: '.aside-title', file: '06-console-project.png' },
    { hash: `#/project/${projectId}/storyboard`, heading: '分镜编辑', file: '07-storyboard.png' },
    { hash: `#/project/${projectId}/characters`, heading: '角色库', file: '08-characters.png' },
    { hash: `#/project/${projectId}/scenes`, heading: '场景板', file: '09-scenes.png' },
    { hash: `#/project/${projectId}/props`, heading: '道具库', file: '10-props.png' },
    { hash: `#/project/${projectId}/script`, heading: '剧本', file: '11-script.png' },
    { hash: `#/project/${projectId}/queue`, heading: '渲染队列', file: '12-queue.png' },
    { hash: `#/project/${projectId}/result`, heading: '成片预览', file: '13-result.png' },
    { hash: '#/settings', heading: '设置', file: '14-settings.png' }
  ]

  for (const r of routes) {
    await record(`页面加载：${r.heading}`, async () => {
      const ms = await goto(win, r.hash, r.heading, r.selector)
      await win.waitForTimeout(400)
      const buttons = await readButtons(win)
      const toasts = await readToasts(win)
      const errorBefore = pageErrors.length + consoleErrors.filter((c) => c.kind === 'error').length
      pages.push({ route: r.hash, heading: r.heading, ms, buttons, toasts, errorCount: errorBefore })
      await win.screenshot({ path: join(evidenceDir, r.file) })
      return `${ms}ms，可见按钮 ${buttons.length} 个（禁用 ${buttons.filter((b) => b.disabled).length}）`
    })
  }

  // ===== 设置页 13 个分区逐个切换 =====
  await record('设置页：13 个分区切换', async () => {
    const navs = win.locator('.settings-nav .nav-item')
    const count = await navs.count()
    const seen: string[] = []
    for (let i = 0; i < count; i++) {
      await navs.nth(i).click()
      await win.waitForTimeout(120)
      const active = await win.locator('.settings-nav .nav-item.active').innerText()
      const title = await win.locator('.settings-content .section:visible h2').first().innerText().catch(() => '(无标题)')
      seen.push(`${active}→${title}`)
    }
    await win.locator('.settings-nav .nav-item').filter({ hasText: '渲染' }).click()
    await win.screenshot({ path: join(evidenceDir, '15-settings-render.png') })
    return seen.join(' | ')
  })

  // ===== 控制台 5 个模块切换 =====
  await record('导演控制台：5 个功能模块切换', async () => {
    await goto(win, `#/project/${projectId}/console`, '导演控制台', '.aside-title')
    const items = win.locator('.aside-menu .el-menu-item')
    const count = await items.count()
    const seen: string[] = []
    for (let i = 0; i < count; i++) {
      await items.nth(i).click()
      await win.waitForTimeout(250)
      const panel = await win.locator('.console-main > *').first().getAttribute('class').catch(() => '')
      seen.push(`${(await items.nth(i).innerText()).replace(/\s+/g, ' ')}=>${panel}`)
    }
    await win.screenshot({ path: join(evidenceDir, '16-console-selfcheck.png') })
    return seen.join(' | ')
  })

  // ===== 安全弹窗：打开后 Esc 关闭 =====
  const dialogs: { page: string; open: string; route: string; ready?: string }[] = [
    { page: '分镜编辑', open: '添加分镜', route: `#/project/${projectId}/storyboard` },
    { page: '角色库', open: '添加角色', route: `#/project/${projectId}/characters` },
    { page: '场景板', open: '添加场景板', route: `#/project/${projectId}/scenes` },
    { page: '道具库', open: '添加道具', route: `#/project/${projectId}/props` },
    { page: '剧本', open: 'AI 生成剧本', route: `#/project/${projectId}/script`, ready: '.script-editor' }
  ]
  for (const d of dialogs) {
    await record(`${d.page}：打开「${d.open}」弹窗并可关闭`, async () => {
      await goto(win, d.route, d.page)
      await win.waitForTimeout(900)
      if (d.ready) await win.locator(d.ready).waitFor({ timeout: 12_000 })
      await win.locator(`button:has-text("${d.open}")`).first().click()
      const visibleDialog = win.locator('.el-dialog:visible').first()
      await visibleDialog.waitFor({ timeout: 10_000 })
      const title = await visibleDialog.locator('.el-dialog__title').innerText()
      await win.keyboard.press('Escape')
      await visibleDialog.waitFor({ state: 'hidden', timeout: 8_000 })
      return `弹窗标题: ${title}`
    })
  }

  // ===== 隐藏入口 2：全局快捷键 =====
  await record('隐藏入口：Alt+1~6 与 Ctrl+, 快捷键', async () => {
    const probes: { key: string; route: string; heading: string; selector?: string }[] = [
      { key: 'Alt+1', route: '#/', heading: '项目' },
      { key: 'Alt+2', route: `#/project/${projectId}/storyboard`, heading: '分镜编辑' },
      { key: 'Alt+3', route: `#/project/${projectId}/characters`, heading: '角色库' },
      { key: 'Alt+4', route: `#/project/${projectId}/scenes`, heading: '场景板' },
      { key: 'Alt+5', route: `#/project/${projectId}/queue`, heading: '渲染队列' },
      { key: 'Alt+6', route: `#/project/${projectId}/result`, heading: '成片预览' },
      { key: 'Control+,', route: '#/settings', heading: '设置' }
    ]
    const out: string[] = []
    for (const p of probes) {
      await win.locator('.page-header h1').first().waitFor({ timeout: 10_000 }).catch(() => undefined)
      await win.keyboard.press(p.key)
      await win.waitForTimeout(400)
      const actual = await win.evaluate(() => window.location.hash)
      out.push(`${p.key}→${actual}`)
    }
    expect(out.find((x) => x.startsWith('Alt+2'))).toContain(`/project/${projectId}/storyboard`)
    expect(out.find((x) => x.startsWith('Alt+6'))).toContain('/result')
    return out.join(' | ')
  })

  // ===== 隐藏入口 3：侧栏折叠 =====
  await record('隐藏入口：侧栏折叠/展开', async () => {
    const before = await win.locator('.sidebar').evaluate((el: Element) => el.getBoundingClientRect().width)
    await win.locator('.collapse-btn').click()
    await win.waitForTimeout(400)
    const after = await win.locator('.sidebar').evaluate((el: Element) => el.getBoundingClientRect().width)
    await win.screenshot({ path: join(evidenceDir, '17-sidebar-collapsed.png') })
    await win.locator('.collapse-btn').click()
    await win.waitForTimeout(400)
    const restored = await win.locator('.sidebar').evaluate((el: Element) => el.getBoundingClientRect().width)
    return `${Math.round(before)}→${Math.round(after)}→${Math.round(restored)}`
  })

  // ===== 隐藏入口 4：右键菜单（项目卡片 / 素材卡片） =====
  await record('隐藏入口：右键菜单展开与关闭（项目卡片 / 角色卡片）', async () => {
    const readMenu = async (): Promise<string[]> => {
      const menu = win.locator('.context-menu:visible').first()
      await menu.waitFor({ timeout: 5_000 })
      const items = await menu.locator('.menu-item').allInnerTexts()
      return items.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean)
    }
    const closeMenu = async (): Promise<void> => {
      await win.keyboard.press('Escape')
      await win.locator('.context-menu').waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined)
    }

    await goto(win, '#/', '项目')
    const projectCard = win.locator('.project-card').first()
    await projectCard.waitFor({ timeout: 10_000 })
    await projectCard.click({ button: 'right' })
    const projectItems = await readMenu()
    await closeMenu()

    await goto(win, `#/project/${projectId}/characters`, '角色库')
    await win.locator('button:has-text("添加角色")').first().click()
    const charDialog = win.locator('.el-dialog:has-text("添加角色")')
    await charDialog.waitFor({ timeout: 10_000 })
    await charDialog.locator('input').first().fill('右键验收角色')
    await charDialog.locator('button:has-text("保存")').click()
    await win.locator('.character-card').first().waitFor({ timeout: 10_000 })
    await win.locator('.character-card').first().click({ button: 'right' })
    const charItems = await readMenu()
    await closeMenu()

    expect(projectItems.length, '项目卡片右键菜单应至少 4 项').toBeGreaterThanOrEqual(4)
    expect(charItems.length, '角色卡片右键菜单应至少 4 项').toBeGreaterThanOrEqual(4)
    return `项目卡片: ${projectItems.join(' / ')}；角色卡片: ${charItems.join(' / ')}`
  })

  // ===== 全量按钮清点（按页面） =====
  await record('按钮清点：全部页面可见按钮', async () => {
    const out: string[] = []
    for (const r of routes) {
      await goto(win, r.hash, r.heading, r.selector)
      await win.waitForTimeout(250)
      const buttons = await readButtons(win)
      out.push(`${r.heading}(${buttons.length}): ${buttons.map((b) => `${b.text}${b.disabled ? '[禁用]' : ''}`).join(', ')}`)
    }
    return out.join('\n')
  })

  const report = {
    generatedAt: new Date().toISOString(),
    firstPaintMs,
    projectId,
    steps,
    pages,
    consoleErrors,
    pageErrors,
    mainLogTail: mainLogs.slice(-120)
  }
  writeFileSync(join(evidenceDir, 'walkthrough.json'), JSON.stringify(report, null, 2), 'utf8')

  await app.close()

  const failed = steps.filter((s) => !s.ok)
  expect(failed, `失败步骤: ${failed.map((f) => `${f.name}: ${f.error}`).join('\n')}`).toEqual([])
})
