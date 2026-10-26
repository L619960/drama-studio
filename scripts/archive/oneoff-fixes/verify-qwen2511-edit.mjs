// verify-qwen2511-edit.mjs — 单点验证：qwen2511_i2i_edit 工作流（定妆图做底 → 场景动作编辑）
// comfy API 直连（不依赖应用），验证节点兼容 + 模型可用 + 输出可取
import fs from 'fs'
import path from 'path'

const COMFY = 'http://127.0.0.1:8188'
const WF = JSON.parse(fs.readFileSync('E:/drama-studio/workflows/qwen2511_i2i_edit.json', 'utf-8'))
const REF = 'C:/Users/蒋奎/AppData/Roaming/drama-studio/drama-studio/projects/p_1792944323257_mpke/characters/char_1792944404215_iqni_face.png'
const OUT = 'C:/Users/蒋奎/AppData/Local/Doubao/User Data/Default/.doubao/agent_mode/workspace/.sessions/38447426014237442/agents/o_000ENVLtsGT/scratch/qwen2511_verify1.png'
const PROMPT = '保持人物脸部、发型、深蓝色交领服装完全不变，将人物置于山间土路暮色场景，骑在棕马上，回望身后远方，远处有马车火把与队伍远景剪影，古装武侠电影感，写实，无现代元素'

const upload = async (file) => {
  const form = new FormData()
  const data = fs.readFileSync(file)
  form.append('image', new Blob([data]), path.basename(file))
  const r = await fetch(`${COMFY}/upload/image`, { method: 'POST', body: form })
  const j = await r.json()
  return j.name || j.images?.[0]?.name
}

const seed = Math.floor(Math.random() * 0xffffffff)
const refName = await upload(REF)
const graph = JSON.parse(JSON.stringify(WF).replaceAll('$PROMPT$', PROMPT).replaceAll('$SEED$', String(seed)).replaceAll('$REF_IMAGE$', refName))
console.log('uploaded ref:', refName, '| seed:', seed)

const r = await fetch(`${COMFY}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: graph }) })
const j = await r.json()
if (j.error) { console.log('SUBMIT_ERROR', JSON.stringify(j.error).slice(0, 500)); process.exit(1) }
const promptId = j.prompt_id
console.log('submitted:', promptId)

// 轮询 history
const deadline = Date.now() + 8 * 60 * 1000
let last = ''
while (Date.now() < deadline) {
  await new Promise(r2 => setTimeout(r2, 8000))
  const h = await (await fetch(`${COMFY}/history/${promptId}`)).json()
  const rec = h[promptId]
  if (rec?.outputs) {
    for (const nid of Object.keys(rec.outputs)) {
      const imgs = rec.outputs[nid]?.images
      if (imgs?.length) {
        const img = imgs[0]
        const dl = await fetch(`${COMFY}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${img.type}`)
        fs.writeFileSync(OUT, Buffer.from(await dl.arrayBuffer()))
        console.log('DONE ->', OUT, '| status:', rec.status)
        process.exit(0)
      }
    }
  }
  const cur = (await (await fetch(`${COMFY}/queue`)).json())
  console.log('waiting... queue:', cur.queue_running?.length, 'pending:', cur.queue_pending?.length)
}
console.log('TIMEOUT')
process.exit(1)
