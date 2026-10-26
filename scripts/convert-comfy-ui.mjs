/**
 * ComfyUI 前端工作流（nodes/links）→ 可 /prompt 提交的 API 图。
 * 依赖本机 ComfyUI :8188 的 /object_info 做 widget 名校验（缺省则按节点 inputs 顺序）。
 */
import fs from 'node:fs'
import path from 'node:path'

const COMFY = process.env.COMFY_URL || 'http://127.0.0.1:8188'
const VIRTUAL = new Set([
  'GetNode', 'SetNode', 'easy getNode', 'easy setNode',
  'Reroute', 'Note', 'MarkdownNote', 'PreviewImage',
  'PrimitiveNode', 'PrimitiveInt', 'PrimitiveString'
])
const AFTER_GEN = new Set(['fixed', 'increment', 'decrement', 'randomize'])

async function fetchInfo(classType) {
  const url = `${COMFY}/object_info/${encodeURIComponent(classType)}`
  const res = await fetch(url)
  if (!res.ok) return null
  const json = await res.json()
  return json[classType] || null
}

function buildLinkIndex(links) {
  const byId = new Map()
  for (const L of links || []) {
    byId.set(L[0], { from: L[1], fromSlot: L[2], to: L[3], toSlot: L[4] })
  }
  return byId
}

export async function convertUiWorkflow(ui, opts = {}) {
  const byId = new Map(ui.nodes.map((n) => [n.id, n]))
  const linkById = buildLinkIndex(ui.links)

  const setSource = new Map()
  for (const n of ui.nodes) {
    if (n.type === 'SetNode' || n.type === 'easy setNode') {
      const name = Array.isArray(n.widgets_values) ? n.widgets_values[0] : n.widgets_values
      const link = (n.inputs || []).find((i) => i.link != null)?.link
      if (name && link != null) setSource.set(String(name), link)
    }
  }

  function resolveFrom(nodeId, slot, depth = 0) {
    if (depth > 20) throw new Error('GetNode/Reroute 解析过深')
    const node = byId.get(nodeId)
    if (!node) throw new Error(`找不到节点 ${nodeId}`)
    if (node.type === 'Reroute') {
      const inLink = (node.inputs || [])[0]?.link
      if (inLink == null) throw new Error(`Reroute ${nodeId} 未连接`)
      const L = linkById.get(inLink)
      return resolveFrom(L.from, L.fromSlot, depth + 1)
    }
    if (node.type === 'GetNode' || node.type === 'easy getNode') {
      const name = Array.isArray(node.widgets_values) ? node.widgets_values[0] : node.widgets_values
      const srcLink = setSource.get(String(name))
      if (srcLink == null) throw new Error(`GetNode「${name}」没有对应 SetNode（可能是环路，已跳过）`)
      const L = linkById.get(srcLink)
      return resolveFrom(L.from, L.fromSlot, depth + 1)
    }
    return [String(nodeId), slot]
  }

  const infoCache = new Map()
  const graph = {}

  for (const n of ui.nodes) {
    if (VIRTUAL.has(n.type)) continue
    if (n.mode === 2) continue
    let info = infoCache.get(n.type)
    if (info === undefined) {
      info = opts.skipFetch ? null : await fetchInfo(n.type)
      infoCache.set(n.type, info)
    }

    const inputs = {}
    const wv = n.widgets_values
    const named = wv && typeof wv === 'object' && !Array.isArray(wv)
    let wi = 0

    const consumeArray = () => {
      if (!Array.isArray(wv)) return undefined
      return wv[wi++]
    }

    const discardWidget = (name) => {
      if (!Array.isArray(wv)) return
      let val = consumeArray()
      if (typeof val === 'string' && AFTER_GEN.has(val)) consumeArray()
      if (typeof name === 'string' && /seed/i.test(name) && AFTER_GEN.has(wv[wi])) wi++
    }

    for (const inp of n.inputs || []) {
      if (inp.link != null) {
        const L = linkById.get(inp.link)
        if (!L) continue
        try {
          inputs[inp.name] = resolveFrom(L.from, L.fromSlot)
        } catch (e) {
          if (String(e.message).includes('环路')) continue
          throw e
        }
        // 已连线的 widget 仍占 widgets_values 槽位，必须丢弃否则后续参数错位
        if (inp.widget) discardWidget(inp.name)
        continue
      }
      if (named && inp.name in wv) {
        const v = wv[inp.name]
        if (v && typeof v === 'object' && !Array.isArray(v) && 'hidden' in v) continue
        inputs[inp.name] = v
        continue
      }
      if (named) continue
      if (!inp.widget) continue
      let val = consumeArray()
      if (val === undefined) continue
      if (typeof val === 'string' && AFTER_GEN.has(val)) val = consumeArray()
      inputs[inp.name] = val
      if (typeof inp.name === 'string' && /seed/i.test(inp.name) && Array.isArray(wv) && AFTER_GEN.has(wv[wi])) {
        wi++
      }
    }

    // 对象 widgets 里尚未写入的键
    if (named) {
      for (const [k, v] of Object.entries(wv)) {
        if (k in inputs) continue
        if (v && typeof v === 'object' && !Array.isArray(v) && ('hidden' in v || 'paused' in v)) continue
        inputs[k] = v
      }
    }

    graph[String(n.id)] = {
      class_type: n.type,
      inputs,
      _meta: { title: n.title || n.type }
    }
  }

  return graph
}

function injectPlaceholders(graph, ui) {
  const byId = new Map(ui.nodes.map((n) => [n.id, n]))
  let promptSet = false
  const loadImages = []

  for (const [id, node] of Object.entries(graph)) {
    const n = node
    if (n.class_type === 'CR Text' && typeof n.inputs.text === 'string' && !promptSet) {
      n.inputs.text = '$PROMPT$'
      promptSet = true
    }
    if (n.class_type === 'CLIPTextEncode' && typeof n.inputs.text === 'string' && n.inputs.text.length > 8 && !n.inputs.text.includes('低质量') && !n.inputs.text.includes('blurry')) {
      if (!promptSet) {
        n.inputs.text = '$PROMPT$'
        promptSet = true
      }
    }
    if (n.class_type === 'LoadImage') loadImages.push(id)
    if (n.class_type === 'ImpactInt' && (n._meta?.title?.includes('秒') || n._meta?.title?.includes('时间'))) {
      n.inputs.value = '$DURATION$'
    }
    if (typeof n.inputs.seed === 'number') n.inputs.seed = '$SEED$'
    if (typeof n.inputs.noise_seed === 'number') n.inputs.noise_seed = '$SEED$'
    if (n.class_type === 'EmptySD3LatentImage' || n.class_type === 'EmptyLatentImage') {
      if ('width' in n.inputs) n.inputs.width = '$WIDTH$'
      if ('height' in n.inputs) n.inputs.height = '$HEIGHT$'
    }
    if (n.class_type === 'WanMoeKSampler' && typeof n.inputs.seed === 'number') {
      n.inputs.seed = '$SEED$'
    }
  }

  // 首尾帧：按 WanFirstLastFrameToVideo 的 start/end 反查 LoadImage
  for (const node of Object.values(graph)) {
    if (node.class_type !== 'WanFirstLastFrameToVideo') continue
    const start = Array.isArray(node.inputs.start_image) ? String(node.inputs.start_image[0]) : null
    const end = Array.isArray(node.inputs.end_image) ? String(node.inputs.end_image[0]) : null
    const markLoad = (startId, ph) => {
      if (!startId || !graph[startId]) return
      if (graph[startId].class_type === 'LoadImage') graph[startId].inputs.image = ph
      else {
        // 预处理链：向上找 LoadImage
        for (const [id, n] of Object.entries(graph)) {
          if (n.class_type === 'LoadImage' && JSON.stringify(graph).includes(`"${id}"`)) {
            /* fallthrough via BFS */
          }
        }
      }
    }
    const findLoad = (fromId, seen = new Set()) => {
      if (!fromId || seen.has(fromId)) return null
      seen.add(fromId)
      const n = graph[fromId]
      if (!n) return null
      if (n.class_type === 'LoadImage') return fromId
      for (const v of Object.values(n.inputs || {})) {
        if (Array.isArray(v) && typeof v[0] === 'string') {
          const hit = findLoad(v[0], seen)
          if (hit) return hit
        }
      }
      return null
    }
    const sLoad = findLoad(start)
    const eLoad = findLoad(end)
    if (sLoad) graph[sLoad].inputs.image = '$REF_IMAGE$'
    if (eLoad) graph[eLoad].inputs.image = '$END_IMAGE$'
  }

  // 单图 I2V
  const hasFlf = Object.values(graph).some((n) => n.class_type === 'WanFirstLastFrameToVideo')
  if (!hasFlf) {
    const loads = Object.entries(graph).filter(([, n]) => n.class_type === 'LoadImage')
    if (loads[0]) loads[0][1].inputs.image = '$REF_IMAGE$'
  }

  // PainterI2V 也吃单图
  return graph
}

const jobs = [
  {
    src: 'D:/ComfyUI-V20/ComfyUI/user/default/workflows/03.wan2.2工作流/1.REMIX模型_工作流/3.Wan2.2_REMIX V3首尾帧视频.json',
    dest: 'workflows/wan22_remix_flf2v.json',
    comment: 'Wan2.2 Remix V3 首尾帧（WanFirstLastFrameToVideo）。$REF_IMAGE$ 首帧 $END_IMAGE$ 尾帧 $PROMPT$ $SEED$ $DURATION$'
  },
  {
    src: 'D:/ComfyUI-V20/ComfyUI/user/default/workflows/02.Qwen图片工作流/1.Qwen2511次采样文生图.json',
    dest: 'workflows/qwen_t2i_hq.json',
    comment: 'Qwen Rapid AIO 二次采样竖版文生图。$PROMPT$ $SEED$ $WIDTH$ $HEIGHT$'
  }
]

const outDir = path.resolve('e:/drama-studio')
for (const job of jobs) {
  const ui = JSON.parse(fs.readFileSync(job.src, 'utf8'))
  const graph = await convertUiWorkflow(ui)
  injectPlaceholders(graph, ui)
  graph._comment = job.comment
  const dest = path.join(outDir, job.dest)
  fs.writeFileSync(dest, JSON.stringify(graph, null, 2), 'utf8')
  const ph = JSON.stringify(graph).match(/\$[A-Z_]+\$/g)
  console.log('wrote', job.dest, 'nodes', Object.keys(graph).filter(k => k !== '_comment').length, 'placeholders', [...new Set(ph || [])].join(','))
}
