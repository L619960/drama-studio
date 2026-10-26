import { reactive } from 'vue'

/**
 * 右键菜单状态管理（交互规范 3.2，2026-10-13 ux-standards.md）。
 * open 时按菜单估算尺寸做屏幕边缘防溢出；菜单渲染由使用方/ContextMenu.vue 负责。
 * Esc 关闭与窗口失焦关闭由使用方注册（或由 ContextMenu.vue 统一处理）。
 */

export interface ContextMenuState<T = unknown> {
  visible: boolean
  x: number
  y: number
  data: T | null
}

export function useContextMenu<T = unknown>(menuWidth = 180, menuHeight = 160) {
  const state = reactive<ContextMenuState<T>>({
    visible: false,
    x: 0,
    y: 0,
    data: null,
  })

  function open(e: MouseEvent, data: T): void {
    e.preventDefault()
    const pad = 8
    const maxX = window.innerWidth - menuWidth - pad
    const maxY = window.innerHeight - menuHeight - pad
    state.x = Math.min(e.clientX, Math.max(pad, maxX))
    state.y = Math.min(e.clientY, Math.max(pad, maxY))
    // reactive 会深度解包，此处需绕过 UnwrapRef 的类型限制（契约保持 data: T | null）
    state.data = data as unknown as typeof state.data
    state.visible = true
  }

  function close(): void {
    state.visible = false
    state.data = null
  }

  return { state, open, close }
}
