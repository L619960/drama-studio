import { onMounted, onUnmounted } from 'vue'

/**
 * 快捷键定义。
 * keys 格式：修饰键小写 + '+' + 主键小写，如 'ctrl+n'、'alt+1'、'ctrl+enter'、'f5'
 */
export interface HotkeyDef {
  keys: string
  handler: (e: KeyboardEvent) => void
  /** 在输入框/文本域中获得焦点时也触发（默认 false） */
  allowInInput?: boolean
  /** 是否阻止默认行为（默认 true） */
  preventDefault?: boolean
}

function comboOf(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  let k = e.key.toLowerCase()
  if (k === ' ') k = 'space'
  else if (k === ',') k = 'comma'
  parts.push(k)
  return parts.join('+')
}

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable
}

/**
 * 视图级快捷键注册。组件卸载时自动解绑。
 * 同一按键后注册者不覆盖（document capture 阶段按视图生命周期隔离）。
 */
export function useHotkeys(defs: HotkeyDef[]) {
  const map = new Map(defs.map(d => [d.keys, d]))

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return
    const def = map.get(comboOf(e))
    if (!def) return
    if (!def.allowInInput && isEditableTarget(e.target)) return
    if (def.preventDefault !== false) e.preventDefault()
    e.stopPropagation()
    def.handler(e)
  }

  onMounted(() => document.addEventListener('keydown', onKeyDown, true))
  onUnmounted(() => document.removeEventListener('keydown', onKeyDown, true))
}
