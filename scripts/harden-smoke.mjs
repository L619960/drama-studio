// harden-smoke.mjs — 硬门禁冒烟：故意注入 katana 缺陷验证 lookEn 硬门禁拦截修正
// 小剧 2 角色（一男一女），剧本明确写"劫匪持武士刀 katana"（缺陷注入）→
// casting 阶段 hardenLookEnList 应自动修正为中式单械并在日志留痕；定妆生成后目检无 katana。
import { chromium } from 'playwright-core'
import fs from 'fs'

const LOG = 'e:/drama-studio/scripts/long-run.log'
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); try { fs.appendFileSync(LOG, l + '\n') } catch (e) {} }

const SCRIPT = `《硬门禁冒烟·月下竹影》——硬门禁链路验证用微型剧（非交付剧）。
故事：夜月竹林中，镖师李长青押一箱药草过山，遇持刀劫匪赵黑风拦路，对峙后劫匪败走。古装武侠，正向。
角色 2 名：
1. 李长青——镖师（男，约35，方脸剑眉）：深蓝(#2C3E50)交领劲装、高束马尾蓝色发带、手执长剑（中式古兵器）。
2. 赵黑风——劫匪（男，约40，络腮胡）：玄黑粗布劲装、布巾蒙下半脸（额头眉眼可见）、手执武士刀 katana（日式弯刀——故意缺陷注入，验证硬门禁拦截修正）。
分镜 2 镜：
镜1 台词（李长青拔剑对峙，单剑，台词：「此路是我镖局的，药草留下。退开。」）；镜2 动作（赵黑风持刀跃起扑来，刀剑相格火花，单械对单械）。
场景：月夜竹林山道——青石板路+竹影+月光，古装时代隔离（禁现代元素）。`

const PIDFILE = 'e:/drama-studio/scripts/harden-smoke.pid'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9225')
const page = browser.contexts().flatMap(c => c.pages()).find(p => (p.url() || '').includes('index.html'))
  || browser.contexts()[0]?.pages()[0]
if (!page) throw new Error('app page not found')

const created = await page.evaluate(
  async ({ title, genre }) => await window.api.project.create(title, genre),
  { title: '硬门禁冒烟·月下竹影', genre: '古装武侠' }
)
const shellPID = typeof created === 'string' ? created : (created?.id ?? created?.projectId)
log('smoke shell PID=' + shellPID)

const st = await page.evaluate(async ({ PID, SCRIPT }) =>
  await window.api.director.start({ projectId: PID, title: '硬门禁冒烟·月下竹影', genre: '古装武侠', script: SCRIPT, gateStages: ['casting'] }),
  { PID: shellPID, SCRIPT }
)
const realPID = (typeof st === 'string') ? st : (st?.projectId || st?.id || shellPID)
fs.writeFileSync(PIDFILE, realPID)
log('smoke director.start -> REALPID=' + realPID)
console.log('SMOKE_REALPID=' + realPID)
await browser.close()
