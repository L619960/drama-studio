// smoke-run.mjs — 冒烟测试：全新现代都市微短剧 2 镜（1 台词 R2V + 1 动作 I2V），全自动链路
// analyze→casting→scenes→render→combine→subtitle→review；冒烟专属前缀 smoke_*，不覆盖正式资产
import { chromium } from 'playwright-core'
import fs from 'fs'

const LOG = 'e:/drama-studio/scripts/smoke-run.log'
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.appendFileSync(LOG, l + '\n') }

const SCRIPT = `《街角·抉择》——全新现代都市微短剧（冒烟测试专用剧本，验证现代题材链路与修复体系）。
故事：傍晚的城市街角便利店外，青年外卖骑手林越送单途中被一名黑衣青年拦住，对方认出他是当年的发小，两人对峙几句后，林越冷静地推开对方继续赶路。都市情感 + 轻动作。
角色 2 名（务必按此顺序建档，不得增减）：
1. 林越——青年外卖骑手：荧光橙(#FF6A00)连帽工装外套、深灰长裤、白色运动鞋、黑发短寸头、背黑色双肩包。
2. 阿峻——青年：藏青(#1F3A5F)连帽卫衣、黑色工装裤、脏辫发、右手缠黑色护腕。
台词硬约束（逐字使用、不得改写；字幕必须与以下文本逐字一致）：
- 镜1（阿峻）：「真的是你？五年没见了，你跑外卖了？」
分镜约束：全剧 2 镜。镜1 台词（阿峻特写，林越背影虚化过肩，R2V 参考音频驱动口型）；镜2 动作（林越单肩背包、单手推开阿峻侧身走过，单械、无路人、无台词）。傍晚城市街角便利店外，写实电影感。`

const browser = await chromium.connectOverCDP('http://127.0.0.1:9225')
const page = browser.contexts().flatMap(c => c.pages()).find(p => (p.url() || '').includes('index.html'))
  || browser.contexts()[0]?.pages()[0]
if (!page) throw new Error('app page not found')

// 1) settings：tier=high（640×1152，32 倍数，组装时 lanczos 到 720×1280）+ 清 assetFallbackProjectId（防现代剧回退古装）
const old = await page.evaluate(async () => {
  const s = await window.api.settings.get()
  const prev = {
    tier: s.render.resolutionTier,
    fb: s.render.assetFallbackProjectId,
    consistency: s.render.consistencyMode
  }
  s.render = { ...s.render, resolutionTier: 'high', assetFallbackProjectId: '' }
  await window.api.settings.save(s)
  return prev
})
log('settings backup: ' + JSON.stringify(old))

// 2) create 冒烟项目（专属前缀，勿覆盖正式剧资产）
const PID = await page.evaluate(
  async ({ title, genre }) => await window.api.project.create(title, genre),
  { title: 'smoke_街角抉择', genre: '现代都市' }
)
log('projectId=' + PID)

// 3) director.start（gateStages=[] 全自动；冒烟先试全自动链路）
const st = await page.evaluate(async ({ PID, SCRIPT }) =>
  await window.api.director.start({ projectId: PID, title: 'smoke_街角抉择', genre: '现代都市', script: SCRIPT, gateStages: [] }),
  { PID, SCRIPT }
)
log('director.start -> ' + JSON.stringify(st))

// 4) 轮询至流水线终态（running=false）：全部 stage done = 链路通；halted 非空 = 卡门（记录，可续）
const deadline = Date.now() + 60 * 60 * 1000
let lastSig = ''
while (Date.now() < deadline) {
  const s2 = await page.evaluate(async (PID) => await window.api.director.getState(PID), PID)
  const sig = JSON.stringify({
    running: s2?.running,
    stages: s2?.stages && Object.fromEntries(Object.entries(s2.stages).map(([k, v]) => [k, v?.status])),
    halted: s2?.haltedStage || null,
    current: s2?.currentStage || null,
    shots: s2?.shots?.filter(sh => sh.status === 'done').length
  })
  if (sig !== lastSig) { lastSig = sig; log('poll: ' + sig) }
  if (s2 && s2.running === false) {
    if (s2.haltedStage) {
      log('HALTED at gate: ' + s2.haltedStage)
      break
    }
    log('PIPELINE FINISHED — stages: ' + JSON.stringify(s2.stages))
    break
  }
  await new Promise(r => setTimeout(r, 15000))
}
log('smoke DONE — PID=' + PID)
console.log('PID=' + PID)
process.exit(0)
