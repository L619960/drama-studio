// cancel-director.mjs — 取消指定导演流水线
import { chromium } from 'playwright-core'
const PID = process.argv[2]
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts().flatMap(c => c.pages()).find(p => (p.url() || '').includes('index.html'))
  || browser.contexts()[0]?.pages()[0]
const r = await page.evaluate(async (PID) => {
  if (!PID) return 'no-pid'
  await window.api.director.cancel(PID)
  return 'cancelled ' + PID
}, PID)
console.log(r)
process.exit(0)
