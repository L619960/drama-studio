/**
 * 幂等补丁：修复 element-plus 2.14.7 el-dialog 打开时的
 *   TypeError: Cannot set properties of null (setting 'scrollTop')
 * 根因：use-dialog 的 nextTick 回调里只判了 targetRef.value 非空，
 *       未判 targetRef.value.parentElement 非空。当 dialog 元素在
 *       快速开/关竞态中已从 DOM 摘除时，parentElement 为 null 即抛错。
 * 同时处理 esm 与 cjs 两个产物。已打过补丁则跳过（幂等）。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const TARGETS = [
  'node_modules/element-plus/es/components/dialog/src/use-dialog.mjs',
  'node_modules/element-plus/lib/components/dialog/src/use-dialog.js',
]

// 仅匹配「if (targetRef.value) {」后紧跟 parentElement.scrollTop 赋值的那一处
// （其余 if (!targetRef.value) / fullscreen 块不受影响）
const RE = /if \(targetRef\.value\) \{\r?\n(\s*)targetRef\.value\.parentElement\.scrollTop/
const REPLACEMENT = 'if (targetRef.value && targetRef.value.parentElement) {\n$1targetRef.value.parentElement.scrollTop'

for (const rel of TARGETS) {
  let src
  try {
    src = readFileSync(rel, 'utf8')
  } catch (e) {
    console.log(`[skip] ${rel} 读取失败: ${e.message}`)
    continue
  }

  if (src.includes('targetRef.value && targetRef.value.parentElement')) {
    console.log(`[skipped] ${rel} 已含 parentElement 判空`)
    continue
  }

  if (!RE.test(src)) {
    console.log(`[warn] ${rel} 未匹配到目标模式，未改动`)
    continue
  }

  const out = src.replace(RE, REPLACEMENT)
  writeFileSync(rel, out, 'utf8')
  console.log(`[patched] ${rel}`)
}
