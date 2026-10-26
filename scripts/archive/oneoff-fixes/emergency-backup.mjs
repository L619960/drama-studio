// emergency-backup.mjs — 紧急：App 内存读青阳 project（若可读立即导出备份）+ 检查渲染产物
import { chromium } from 'playwright-core'
import fs from 'fs'
const PID = 'p_1792944323257_mpke'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9225')
const page = browser.contexts().flatMap(c => c.pages()).find(p => (p.url() || '').includes('index.html')) || browser.contexts()[0]?.pages()[0]
let res = {}
try {
  const proj = await page.evaluate(async (PID) => await window.api.project.get(PID), PID)
  res.memoryReadable = !!proj
  res.title = proj?.title
  res.shots = proj?.shots?.length
  res.chars = proj?.characters?.length
  if (proj?.shots?.length) {
    const bak = JSON.stringify(proj, null, 2)
    fs.writeFileSync('E:/drama-studio/scripts/qingyang_memory_backup.json', bak, 'utf-8')
    res.backup = 'E:/drama-studio/scripts/qingyang_memory_backup.json'
    res.shotStatus = proj.shots.map(s => `${s.index}:${s.status}`).join(',')
  }
} catch (e) {
  res.memoryReadable = false
  res.err = String(e).slice(0, 200)
}
console.log(JSON.stringify(res, null, 2))
await browser.close()
