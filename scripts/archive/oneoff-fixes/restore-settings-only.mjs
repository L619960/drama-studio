// restore-settings-only.mjs — 还原 settings tier=mid/timeout=600，保留 assetFallback
import { chromium } from 'playwright-core'
import fs from 'fs'
const LOG = 'e:/drama-studio/scripts/run-director-resume.log'
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.appendFileSync(LOG, l + '\n') }
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = (await browser.contexts())[0].pages()[0]
const r = await page.evaluate(async () => {
  const s = await window.api.settings.get()
  s.render.resolutionTier = 'mid'
  s.render.timeout = 600
  await window.api.settings.save(s)
  const s2 = await window.api.settings.get()
  return { tier: s2.render.resolutionTier, timeout: s2.render.timeout, fallback: s2.render.assetFallbackProjectId }
})
log('settings restored: ' + JSON.stringify(r))
await browser.close()
