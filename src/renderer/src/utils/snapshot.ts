/**
 * 跨 contextBridge / IPC 前的纯对象快照。
 * Vue3 reactive Proxy 无法通过 contextBridge 参数克隆
 * （报 "An object could not be cloned"），必须在渲染端先转成纯对象。
 */
export function snapshot<T>(v: T): T {
  if (typeof v === 'object' && v !== null) {
    return JSON.parse(JSON.stringify(v)) as T
  }
  return v
}
