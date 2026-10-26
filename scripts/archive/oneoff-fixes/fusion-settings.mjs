// fusion-settings.mjs — 持久化 fusionFallback=block（API+disk 双证）
import { chromium } from 'playwright-core'
import fs from 'fs'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9225')
const page = browser.contexts().flatMap(c => c.pages()).find(p => (p.url() || '').includes('index.html')) || browser.contexts()[0]?.pages()[0]
const out = await page.evaluate(async () => {
  const s = await window.api.settings.get()
  const before = s.render?.fusionFallback
  s.render = { ...s.render, fusionFallback: 'block' }
  await window.api.settings.save(s)
  const after = await window.api.settings.get()
  return { before, after: after.render?.fusionFallback }
})
console.log('api:', JSON.stringify(out))
const disk = JSON.parse(fs.readFileSync('C:/Users/蒋奎/AppData/Roaming/drama-studio/settings.json', 'utf-8'))
console.log('disk:', JSON.stringify({ fusionFallback: disk.render?.fusionFallback, reviewGate: disk.render?.reviewGate }))
await browser.close()
