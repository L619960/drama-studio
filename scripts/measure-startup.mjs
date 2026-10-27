// 冷启动计时：启动 electron . ，轮询 CDP 9222 直到 page target 出现（窗口可交互）
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const t0 = Date.now()
const child = spawn('npx', ['electron', '.'], {
  cwd: process.cwd(),
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DS_CDP_PORT: '9222' }
})
child.stdout.on('data', d => process.stdout.write('[electron] ' + d))
child.stderr.on('data', d => process.stderr.write('[electron-err] ' + d))

async function getPageTargets() {
  try {
    const r = await fetch('http://127.0.0.1:9222/json/list')
    if (!r.ok) return []
    return await r.json()
  } catch {
    return []
  }
}

let shownAt = -1
let loadedAt = -1
for (let i = 0; i < 120; i++) {
  await sleep(100)
  const targets = await getPageTargets()
  const page = targets.find(t => t.type === 'page')
  if (page && shownAt < 0) {
    shownAt = Date.now() - t0
  }
  // 页面 target 出现且 url 已是 file:// 或 dev url，视为可交互
  if (page && page.url && !page.url.startsWith('devtools://')) {
    loadedAt = Date.now() - t0
    break
  }
}

console.log(`\n===== 冷启动计时 =====`)
console.log(`进程启动 -> 首个 page target 出现: ${shownAt} ms`)
console.log(`进程启动 -> 窗口页面就绪(file url): ${loadedAt} ms`)
console.log(`electron pid: ${child.pid}`)

// 留 1.5s 让首屏稳定，然后结束进程
await sleep(1500)
try { child.kill() } catch {}
process.exit(0)
