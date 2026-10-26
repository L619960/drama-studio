// watch-gate.mjs — 只读轮询至 gate 暂停或终态（长剧 v2 监控）
import { chromium } from 'playwright-core'
import fs from 'fs'

const LOG = 'e:/drama-studio/scripts/long-run.log'
const PID = fs.readFileSync('e:/drama-studio/scripts/long-run.pid', 'utf-8').trim()
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); try { fs.appendFileSync(LOG, l + '\n') } catch (e) {} }

const browser = await chromium.connectOverCDP('http://127.0.0.1:9225')
const page = browser.contexts().flatMap(c => c.pages()).find(p => (p.url() || '').includes('index.html'))
  || browser.contexts()[0]?.pages()[0]
if (!page) throw new Error('app page not found')

log('watch start PID=' + PID)
const deadline = Date.now() + 240 * 60 * 1000
let lastSig = ''
while (Date.now() < deadline) {
  const s2 = await page.evaluate(async (PID) => await window.api.director.getState(PID), PID)
  const stages = s2?.stages || {}
  const sig = JSON.stringify({
    running: s2?.running, cur: s2?.currentStage || null, halted: s2?.haltedStage || null, paused: s2?.paused,
    st: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, v?.status])),
    done: s2?.doneShots, total: s2?.totalShots, failed: (s2?.failedShotIds || []).length,
    err: s2?.error || s2?.lastError || null
  })
  if (sig !== lastSig) { lastSig = sig; log('poll: ' + sig) }
  if (s2) {
    if (s2.paused || s2.haltedStage) { log('GATE HALTED at: ' + (s2.haltedStage || 'paused')); break }
    if (s2.running === false && !s2.paused) { log('PIPELINE FINISHED: ' + sig); break }
  }
  await new Promise(r => setTimeout(r, 15000))
}
log('watch DONE — PID=' + PID)
process.exit(0)
