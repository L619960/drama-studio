import { chromium } from 'playwright-core'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts()[0].pages().find(p => p.url().includes('index.html') || p.url().startsWith('file:'))
  || browser.contexts()[0].pages()[0]
if (!page) throw new Error('no page')

const notes = []
async function go(hash) {
  await page.evaluate((h) => { location.hash = h }, hash)
  await page.waitForTimeout(600)
}

await go('#/')
await page.waitForTimeout(800)
const home = await page.locator('body').innerText()
notes.push(home.includes('短剧') || home.includes('项目') ? 'home:ok' : 'home:missing-title')

const directorBtn = page.getByRole('button', { name: 'AI 导演' }).first()
if (await directorBtn.count()) {
  await directorBtn.click()
  await page.waitForTimeout(500)
  const dlg = await page.locator('.el-dialog').filter({ hasText: 'AI 导演' }).first().isVisible().catch(() => false)
  notes.push(dlg ? 'director-dialog:ok' : 'director-dialog:missing')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
} else {
  notes.push('director-button:missing')
}

await go('#/settings')
await page.waitForTimeout(800)
await page.locator('.settings-nav .nav-item', { hasText: '渲染' }).click()
await page.waitForTimeout(400)
const settingsText = await page.locator('.settings-view').innerText()
notes.push(settingsText.includes('分镜审核门控') ? 'shot-gate:ok' : 'shot-gate:missing')
notes.push(settingsText.includes('成片复审门控') ? 'final-gate:ok' : 'final-gate:missing')

await go('#/console')
await page.waitForTimeout(600)
const consoleText = await page.locator('body').innerText()
notes.push(consoleText.includes('全局对话') || consoleText.includes('当前项目对话') ? 'console-scope:ok' : 'console-scope:missing')

console.log(notes.join('\n'))
const bad = notes.filter(n => n.endsWith('missing'))
if (bad.length) process.exit(1)
