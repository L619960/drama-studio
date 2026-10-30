import type { SelfCheckItem } from '../../../shared/ipcTypes'

/** 首次启动引导完成标记（跳过后同样写入，避免反复打扰） */
export const ONBOARDED_KEY = 'ds:onboarded'
/** 设置页「重新运行环境检查」→ App 打开首跑向导的事件名 */
export const ONBOARDING_OPEN_EVENT = 'onboarding:open'

/** 向导第二步预填的示例项目 */
export const SAMPLE_PROJECT = {
  title: '总裁的隐婚新娘',
  genre: '都市甜宠'
} as const

function storage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

export function isOnboarded(): boolean {
  return storage()?.getItem(ONBOARDED_KEY) === '1'
}

export function markOnboarded(): void {
  storage()?.setItem(ONBOARDED_KEY, '1')
}

/**
 * 自检清单里的 ComfyUI 是否离线。
 * selfCheckService 把离线记为 `warn: true`（ok 仍为 true），部分失败路径才是 ok=false，
 * 两种都要算「未连接」，否则首跑向导会误判环境全绿。
 */
export function isComfyOffline(items: SelfCheckItem[]): boolean {
  const item = items.find(i => i.name === 'ComfyUI')
  return item ? item.warn === true || !item.ok : false
}
