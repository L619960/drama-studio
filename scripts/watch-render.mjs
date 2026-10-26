import { chromium } from 'playwright-core'
import fs from 'fs'

const id = 'p_1792384082292_843v'
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  fs.appendFileSync('e:/drama-studio/scripts/run-and-verify.log', line + '\n')
}
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts().flatMap(c => c.pages()).find(p => (p.url() || '').includes('index.html'))
if (!page) throw new Error('no page')
const deadline = Date.now() + 18 * 60 * 1000
let last = ''
while (Date.now() < deadline) {
  const snap = await page.evaluate(async (pid) => {
    const s = await window.api.director.getState(pid)
    const p = await window.api.project.get(pid)
    return {
      running: s?.running,
      render: (s?.stages?.render?.status || '') + ':' + (s?.stages?.render?.message || ''),
      combine: s?.stages?.combine?.status,
      shots: (p.shots || []).map(sh => sh.index + ':' + sh.status + (sh.audioFailed ? ':audioFail' : '')),
      tail: (s?.logs || []).slice(-2).map(l => l.level + ' ' + l.message.slice(0, 110))
    }
  }, id)
  const sig = snap.render + snap.shots.join(',')
  if (sig !== last) {
    last = sig
    log('render ' + snap.render + ' running=' + snap.running + ' combine=' + snap.combine)
    log('shots ' + snap.shots.join(' | '))
    for (const t of snap.tail) log('log ' + t)
  }
  if (!snap.running) break
  const done = snap.shots.filter(s => s.includes(':done')).length
  if (done >= 1 && snap.render.startsWith('done')) break
  await new Promise(r => setTimeout(r, 20000))
}
log('watch render end')
process.exit(0)
