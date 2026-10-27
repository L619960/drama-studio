// 解析 rollup-plugin-visualizer 生成的 out/renderer-stats.html，打印 renderer bundle 最大模块
import { readFileSync, writeFileSync } from 'node:fs'

const html = readFileSync('out/renderer-stats.html', 'utf8')
const startMarker = 'const data = '
const s = html.indexOf(startMarker)
let i = s + startMarker.length, depth = 0, inStr = false, esc = false, end = -1
for (; i < html.length; i++) {
  const c = html[i]
  if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false }
  else { if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) { end = i; break } } }
}
const data = JSON.parse(html.slice(s + startMarker.length, end + 1))
const parts = data.nodeParts

const rows = []
function walk(node, path) {
  if (!node) return
  const name = node.name || ''
  const nextPath = path ? `${path}/${name}` : name
  const p = node.uid ? parts[node.uid] : null
  const size = p ? (p.renderedLength || 0) : 0
  if (!node.children || node.children.length === 0) {
    rows.push({ name: nextPath, size })
  } else {
    // 中间节点也记录（聚合用）
    for (const c of node.children) walk(c, nextPath)
  }
}
walk(data.tree, '')

rows.sort((a, b) => b.size - a.size)
console.log(`叶子模块数: ${rows.length}`)
console.log('\n=== Top 40 叶子模块 (renderedLength, gzip 前) ===')
for (const r of rows.slice(0, 40)) {
  console.log(`${String((r.size / 1024).toFixed(1)).padStart(9)} KB  ${r.name.replace('root/assets/index-DU4Q1Gdj.js/E:/drama-studio/', '')}`)
}

// 按 node_modules 顶层包聚合（只统计叶子里属于该包的）
const byPkg = {}
for (const r of rows) {
  const idx = r.name.indexOf('node_modules/')
  let pkg = null
  if (idx >= 0) {
    const sub = r.name.slice(idx + 'node_modules/'.length)
    const segs = sub.split('/')
    pkg = sub.startsWith('@') ? segs.slice(0, 2).join('/') : segs[0]
  } else {
    pkg = '(src/内部)'
  }
  byPkg[pkg] = (byPkg[pkg] || 0) + r.size
}
const pkgRows = Object.entries(byPkg).map(([pkg, size]) => ({ pkg, size }))
pkgRows.sort((a, b) => b.size - a.size)
const total = pkgRows.reduce((s, r) => s + r.size, 0)
console.log(`\n=== 按顶层包聚合 (合计 ${(total/1024).toFixed(0)} KB) Top 30 ===`)
for (const r of pkgRows.slice(0, 30)) {
  const pct = ((r.size / total) * 100).toFixed(1)
  console.log(`${String((r.size / 1024).toFixed(1)).padStart(9)} KB  ${pct.padStart(5)}%  ${r.pkg}`)
}

// 关键包是否进入 renderer
console.log('\n=== 关键包存在性检查 ===')
for (const key of ['@xenova/transformers', 'onnxruntime-node', 'msedge-tts', 'pinyin', 'fluent-ffmpeg', 'ffmpeg-static', 'ws', 'axios', '@modelcontextprotocol']) {
  const hit = pkgRows.find(r => r.pkg === key)
  console.log(`  ${hit ? 'IN ' : 'out'}  ${key}${hit ? '  ' + (hit.size/1024).toFixed(1)+'KB' : ''}`)
}
writeFileSync('out/renderer-stats.json', JSON.stringify({ rows, pkgRows }, null, 2))
