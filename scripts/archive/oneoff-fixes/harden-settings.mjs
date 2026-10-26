// harden-settings.mjs — 持久化硬门禁 settings（reviewGate=block + consistencyMode=rerender）并读回验证
import { chromium } from 'playwright-core'
import fs from 'fs'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9225')
const page = browser.contexts().flatMap(c => c.pages()).find(p => (p.url() || '').includes('index.html'))
  || browser.contexts()[0]?.pages()[0]
if (!page) throw new Error('app page not found')

const out = await page.evaluate(async () => {
  const s = await window.api.settings.get()
  const before = { reviewGate: s.render.reviewGate, creationReviewGate: s.creation?.edit?.reviewGate, consistencyMode: s.render.consistencyMode }
  // 单源在 creation.edit.reviewGate（settingsStore normalize 会写回 render.reviewGate）
  s.creation = { ...s.creation, edit: { ...s.creation.edit, reviewGate: 'block' } }
  s.render = { ...s.render, reviewGate: 'block', consistencyMode: 'rerender' }
  await window.api.settings.save(s)
  const after = await window.api.settings.get()
  return { before, after: { reviewGate: after.render.reviewGate, creationReviewGate: after.creation?.edit?.reviewGate, consistencyMode: after.render.consistencyMode } }
})
console.log(JSON.stringify(out, null, 2))
const file = 'C:/Users/蒋奎/AppData/Roaming/drama-studio/settings.json'
const disk = JSON.parse(fs.readFileSync(file, 'utf-8'))
console.log('disk:', JSON.stringify({ reviewGate: disk.render?.reviewGate, consistencyMode: disk.render?.consistencyMode }))
await browser.close()
