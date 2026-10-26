// director-states.mjs — 打印指定项目导演状态
import { chromium } from 'playwright-core'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts().flatMap(c => c.pages()).find(p => (p.url() || '').includes('index.html'))
  || browser.contexts()[0]?.pages()[0]
for (const pid of process.argv.slice(2)) {
  try {
    const st = await page.evaluate(async (pid) => {
      const s = await window.api.director.getState(pid)
      if (!s) return null
      const stages = {}
      for (const [k, v] of Object.entries(s.stages || {})) if (v && v.status) stages[k] = v.status
      return { title: s.title, running: s.running, paused: s.paused, status: s.status, stages, doneShots: s.doneShots, failed: s.failedShotIds, finalPath: s.finalPath }
    }, pid)
    console.log(pid + ' -> ' + JSON.stringify(st))
  } catch (e) { console.log(pid + ' ERR ' + e.message) }
}
process.exit(0)
