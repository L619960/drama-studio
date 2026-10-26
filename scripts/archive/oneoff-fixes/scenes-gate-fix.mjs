// scenes-gate-fix.mjs — 《孤栈惊变》scenes 门修正：写实资产替换 + 武打镜角色锁定 + Ryan 音轨注入
// 替换内容：face/refImagePath=写实抽帧；firstFramePath 文件内容=写实抽帧；镜1/4 characterIds 补铁面；音轨注入
import { chromium } from 'playwright-core'
import fs from 'fs'
import path from 'path'

const LOG = 'e:/drama-studio/scripts/scenes-gate-fix.log'
const DATA = 'C:/Users/蒋奎/AppData/Roaming/drama-studio/drama-studio'
const INPUT = 'D:/ComfyUI-V20/ComfyUI/input'
const ASSETS = 'C:/Users/蒋奎/AppData/Local/Doubao/User Data/Default/.doubao/agent_mode/workspace/.sessions/38447426014237442/agents/o_000ENVLtsGT/scratch/lugu_assets'
const PID = 'p_1792754781760_9v87'
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.appendFileSync(LOG, l + '\n') }

// 角色 → 写实抽帧映射（按 appearanceLock 色系匹配角色 id）
const CHAR_IMG = { 陆远: 'lugu_lu_720.png', 铁面: 'lugu_iron_720.png', 小禾: 'lugu_he_720.png' }
const WAV_BY_SHOT = { 2: 'h3_line_02.wav', 3: 'h3_line_03.wav', 5: 'h3_line_05.wav' }

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts().flatMap(c => c.pages()).find(p => (p.url() || '').includes('index.html'))
  || browser.contexts()[0]?.pages()[0]
if (!page) throw new Error('app page not found')

const proj = await page.evaluate(async (PID) => await window.api.project.get(PID), PID)
const chars = proj.characters || []
const byName = Object.fromEntries(chars.map(c => [c.name, c]))

// 1) 角色 face/ref 覆盖为写实抽帧
let faceFixed = 0
for (const [name, img] of Object.entries(CHAR_IMG)) {
  const c = byName[name]
  if (!c) { log('MISSING char ' + name); continue }
  const faceRel = c.faceImagePath // projects/PID/characters/xxx_face.png
  const src = path.join(ASSETS, img)
  const dst = path.join(DATA, faceRel)
  try { fs.copyFileSync(src, dst); log(`face ${name}: ${img} -> ${faceRel} (${Math.round(fs.statSync(dst).size / 1024)}KB)`); faceFixed++ } catch (e) { log(`face copy fail ${name}: ${e.message}`) }
  c.refImagePath = faceRel
}

// 2) 武打镜（1/4）characterIds 补铁面；台词镜角色核验
const ironId = byName['铁面']?.id
for (const s of proj.shots || []) {
  if (s.index === 1 || s.index === 4) {
    if (ironId && !(s.characterIds || []).includes(ironId)) {
      s.characterIds = [...new Set([...(s.characterIds || []), ironId])]
      log(`shot ${s.index}: characterIds + 铁面 = ${JSON.stringify(s.characterIds)}`)
    }
  }
}

// 3) 首帧文件覆盖为写实抽帧（按镜人物）
const SHOT_CHAR = { 1: '陆远', 2: '陆远', 3: '铁面', 4: '陆远', 5: '小禾' }
let firstFixed = 0
for (const s of proj.shots || []) {
  const cname = SHOT_CHAR[s.index]
  const img = CHAR_IMG[cname]
  const src = path.join(ASSETS, img)
  if (s.firstFramePath && img) {
    try { fs.copyFileSync(src, path.join(DATA, s.firstFramePath)); firstFixed++; log(`shot ${s.index} firstFrame -> ${img}`) } catch (e) { log(`first copy fail ${s.index}: ${e.message}`) }
  }
}

// 4) 音轨注入（复制到项目 audio 目录 + audioPath）
const audioDir = path.join(DATA, 'projects', PID, 'audio')
fs.mkdirSync(audioDir, { recursive: true })
let audioFixed = 0
for (const [idx, wav] of Object.entries(WAV_BY_SHOT)) {
  const s = proj.shots.find(x => x.index === Number(idx))
  if (!s) continue
  const rel = `projects/${PID}/audio/shot_${idx}.wav`
  try { fs.copyFileSync(path.join(INPUT, wav), path.join(DATA, rel)); s.audioPath = rel; audioFixed++; log(`shot ${idx} audio -> ${wav}`) } catch (e) { log(`audio copy fail ${idx}: ${e.message}`) }
}

await page.evaluate(async ({ PID, proj }) => await window.api.project.save(proj), { PID, proj })
log(`DONE faceFixed=${faceFixed} firstFixed=${firstFixed} audioFixed=${audioFixed}`)
process.exit(0)
