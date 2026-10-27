import { readFileSync } from 'node:fs'
const h = readFileSync('out/renderer-stats.html', 'utf8')
const startMarker = 'const data = '
const s = h.indexOf(startMarker)
let i = s + startMarker.length, depth = 0, inStr = false, esc = false, end = -1
for (; i < h.length; i++) {
  const c = h[i]
  if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false }
  else { if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) { end = i; break } } }
}
const data = JSON.parse(h.slice(s + startMarker.length, end + 1))
function findLeaf(n) { return n.children && n.children.length ? findLeaf(n.children[n.children.length - 1]) : n }
const l = findLeaf(data.tree)
console.log('leaf keys:', Object.keys(l))
console.log('leaf sample:', JSON.stringify(l).slice(0, 400))
console.log('data top keys:', Object.keys(data))
console.log('data.sample:', JSON.stringify({...data, tree: undefined}).slice(0, 400))
