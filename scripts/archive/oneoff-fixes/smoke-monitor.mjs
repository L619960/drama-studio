// smoke-monitor.mjs — 监控已启动的冒烟项目（p_1792911471383_d9w4）至流水线终态
// 修复 smoke-run.mjs 的轮询 bug（project.create 返回对象，PID 取 .id），本脚本只读监控
import { chromium } from 'playwright-core'
import fs from 'fs'

const LOG = 'e:/drama-studio/scripts/smoke-monitor.log'
const PID = 'p_1792911471383_d9w4'
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.appendFileSync(LOG, l + '\n') }

const browser = await chromium.connectOverCDP('http://127.0.0.1:9225')
const page = browser.contexts().flatMap(c => c.pages()).find(p => (p.url() || '').includes('index.html'))
  || browser.contexts()[0]?.pages()[0]
if (!page) throw new Error('app page not found')

const deadline = Date.now() + 70 * 60 * 1000
let lastSig = ''
while (Date.now() < deadline) {
  const s2 = await page.evaluate(async (PID) => await window.api.director.getState(PID), PID)
  const stages = s2?.stages || {}
  const sig = JSON.stringify({
    running: s2?.running,
    cur: s2?.currentStage || null,
    halted: s2?.haltedStage || null,
    st: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, v?.status])),
    done: s2?.doneShots, total: s2?.totalShots, failed: (s2?.failedShotIds || []).length,
    err: s2?.error || s2?.lastError || null
  })
  if (sig !== lastSig) { lastSig = sig; log('poll: ' + sig) }
  if (s2 && s2.running === false) {
    if (s2.haltedStage) { log('HALTED at gate: ' + s2.haltedStage); break }
    log('PIPELINE FINISHED: ' + sig)
    break
  }
  await new Promise(r => setTimeout(r, 15000))
}
log('monitor DONE')
process.exit(0)
