/**
 * 跨 contextBridge / IPC 前的纯对象快照。
 * Vue3 reactive Proxy 无法通过 contextBridge 参数克隆
 * （报 "An object could not be cloned"），必须在渲染端先转成纯对象。
 *
 * P2-19：先用 toRaw 拿到未代理的原始对象（O(1)，子对象本身就是纯对象），
 * 再用 structuredClone 原生深拷贝——避免对大项目做 stringify+parse（既慢又产生
 * 大字符串内存抖动），也避免逐属性触发 Proxy get trap。
 * structuredClone 不可用时（极端旧运行时）回退 JSON 方案。
 */
import { toRaw } from 'vue'

export function snapshot<T>(v: T): T {
  if (typeof v !== 'object' || v === null) return v
  const raw = toRaw(v)
  try {
    return structuredClone(raw) as T
  } catch {
    // 含不可克隆值（函数/Proxy 深层残留等）时回退，保证 IPC 前必为纯数据
    return JSON.parse(JSON.stringify(raw)) as T
  }
}
