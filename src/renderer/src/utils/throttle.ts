/**
 * 轻量防抖节流：防止按钮连点导致重复触发（重复保存/重复 LLM 调用/重复入队）。
 * 用 localStorage 持久化时间戳，组件重建/路由切换后仍生效，同一 key 全局共享。
 */
import { ElMessage } from 'element-plus'

const TAP_PREFIX = 'ds:tap:'
/** 被吞点击的提示本身也节流（1.5s 最多一条），避免连点刷屏 */
let lastTip = 0

export function throttleTap(key: string, ms = 800): boolean {
  const now = Date.now()
  let last: number
  try {
    last = Number(localStorage.getItem(TAP_PREFIX + key) || 0)
  } catch {
    last = 0
  }
  if (now - last < ms) {
    // B-02：不再静默吞掉点击，给用户轻提示
    if (now - lastTip > 1500) {
      lastTip = now
      ElMessage.info('操作太频繁，请稍候')
    }
    return false
  }
  try {
    localStorage.setItem(TAP_PREFIX + key, String(now))
  } catch {
    /* ignore */
  }
  return true
}

/** 清理某个 key 的节流状态（用于显式重置，如弹窗重新打开） */
export function resetTap(key: string): void {
  try {
    localStorage.removeItem(TAP_PREFIX + key)
  } catch {
    /* ignore */
  }
}
