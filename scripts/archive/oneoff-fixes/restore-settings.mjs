// restore-settings.mjs — 还原 resolutionTier=mid / timeout=600
import { chromium } from 'playwright-core'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts().flatMap(c => c.pages()).find(p => (p.url() || '').includes('index.html'))
  || browser.contexts()[0]?.pages()[0]
const r = await page.evaluate(async () => {
  const s = await window.api.settings.get()
  const old = { tier: s.render?.resolutionTier, timeout: s.render?.timeout }
  s.render = { ...s.render, resolutionTier: 'mid', timeout: 600 }
  await window.api.settings.save(s)
  const now = await window.api.settings.get()
  return { old, now: { tier: now.render?.resolutionTier, timeout: now.render?.timeout } }
})
console.log(JSON.stringify(r))
process.exit(0)
