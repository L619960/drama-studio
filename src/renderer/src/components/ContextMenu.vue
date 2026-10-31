<template>
  <teleport to="body">
    <div
      v-if="visible"
      ref="menuEl"
      class="context-menu"
      role="menu"
      :style="{ left: x + 'px', top: y + 'px' }"
      @click.stop
      @contextmenu.prevent.stop
    >
      <template v-for="(item, i) in items" :key="i">
        <div v-if="item.divider" class="menu-divider" />
        <div
          v-else
          class="menu-item"
          :class="{ danger: item.danger, disabled: item.disabled }"
          role="menuitem"
          tabindex="-1"
          :data-index="i"
          :aria-disabled="item.disabled ? 'true' : undefined"
          :title="item.tip"
          @click="onItemClick(item)"
        >
          <el-icon v-if="item.icon" class="menu-icon"><component :is="item.icon" /></el-icon>
          <span v-if="item.label" class="menu-label">{{ item.label }}</span>
          <span v-if="item.tip" class="menu-tip">{{ item.tip }}</span>
        </div>
      </template>
    </div>
  </teleport>
</template>

<script setup lang="ts">
import { nextTick, onMounted, onBeforeUnmount, ref } from 'vue'
import type { Component } from 'vue'

/**
 * 全局右键菜单组件（交互规范 3.2 / 3.3，2026-10-13 ux-standards.md）。
 *
 * 用法：
 *   const menuRef = ref<InstanceType<typeof ContextMenu> | null>(null)
 *   <div @contextmenu.prevent="onContextMenu($event, row)">...</div>
 *   <ContextMenu ref="menuRef" :items="buildItems(row)" />
 *   function onContextMenu(e: MouseEvent, row: Row) {
 *     menuRef.value?.open(e, row)
 *   }
 *
 * 内置能力：
 *  - teleport 到 body
 *  - 屏幕边缘防溢出（打开后按实际宽高 clamp）
 *  - Esc 关闭
 *  - 点击菜单外部关闭
 *  - 窗口失焦关闭
 *  - 菜单项点击后自动关闭（disabled 项不触发 action）
 *  - 再次在别处右键：本菜单先关闭，由新的 @contextmenu 触发新菜单
 */

export interface CtxItem {
  label?: string
  icon?: Component
  danger?: boolean
  disabled?: boolean
  tip?: string | undefined
  action?: (data: unknown) => void
  divider?: boolean
}

const props = defineProps<{
  items: CtxItem[]
}>()

const visible = ref(false)
const x = ref(0)
const y = ref(0)
const data = ref<unknown>(null)
const menuEl = ref<HTMLElement | null>(null)
/** 打开前的焦点位置：关闭时归还，键盘用户不会丢失当前位置 */
let restoreFocusTo: HTMLElement | null = null

const PAD = 8

/** 可聚焦的菜单项（跳过 disabled 与分隔线） */
function focusableItems(): HTMLElement[] {
  if (!menuEl.value) return []
  return Array.from(menuEl.value.querySelectorAll<HTMLElement>('.menu-item:not(.disabled)'))
}

function open(e: MouseEvent, d: unknown = null): void {
  data.value = d
  restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
  // 先以粗略尺寸打开，再 nextTick 实测后 clamp
  x.value = Math.min(e.clientX, window.innerWidth - 200 - PAD)
  y.value = Math.min(e.clientY, window.innerHeight - 160 - PAD)
  visible.value = true
  void nextTick(() => {
    const el = menuEl.value
    if (!el) return
    const rect = el.getBoundingClientRect()
    const maxX = window.innerWidth - rect.width - PAD
    const maxY = window.innerHeight - rect.height - PAD
    x.value = Math.max(PAD, Math.min(e.clientX, maxX))
    y.value = Math.max(PAD, Math.min(e.clientY, maxY))
    // 键盘可达：打开即把焦点移到首个可用项，Tab/方向键即可继续操作
    focusableItems()[0]?.focus()
  })
}

function close(): void {
  const hadFocusInMenu =
    !document.activeElement ||
    document.activeElement === document.body ||
    Boolean(menuEl.value?.contains(document.activeElement))
  visible.value = false
  data.value = null
  // 只有焦点原本在菜单内/已丢失时才归还，避免从菜单外点击时把焦点抢回来
  const back = restoreFocusTo
  restoreFocusTo = null
  if (hadFocusInMenu && back && document.contains(back)) back.focus()
}

function onItemClick(item: CtxItem): void {
  if (item.disabled) return
  const d = data.value
  close()
  item.action?.(d)
}

function onDocumentClick(e: MouseEvent): void {
  if (!visible.value) return
  if (menuEl.value && menuEl.value.contains(e.target as Node)) return
  close()
}

function onDocumentContextMenu(e: MouseEvent): void {
  if (!visible.value) return
  if (menuEl.value && menuEl.value.contains(e.target as Node)) return
  // 在菜单外右键：先关旧菜单，让新的 contextmenu 处理器自己打开新菜单
  close()
}

function onKeydown(e: KeyboardEvent): void {
  if (!visible.value) return
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
    return
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const items = focusableItems()
    if (!items.length) return
    e.preventDefault()
    const idx = items.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length
    items[next]?.focus()
    return
  }
  // 菜单项是 div，Enter/Space 默认不触发 click：手动派发到当前聚焦项
  if (e.key === 'Enter' || e.key === ' ') {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !menuEl.value?.contains(active)) return
    const idx = Number(active.dataset.index)
    const item = props.items[idx]
    if (!item || item.divider || item.disabled) return
    e.preventDefault()
    onItemClick(item)
  }
}

function onWindowBlur(): void {
  if (visible.value) close()
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick, true)
  document.addEventListener('contextmenu', onDocumentContextMenu, true)
  document.addEventListener('keydown', onKeydown, true)
  window.addEventListener('blur', onWindowBlur)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick, true)
  document.removeEventListener('contextmenu', onDocumentContextMenu, true)
  document.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('blur', onWindowBlur)
})

defineExpose({ open, close })
</script>

<style>
/* 复用 theme.css 已定义的 .context-menu / .menu-item / .menu-divider 全局样式。
   这里只补菜单项内图标与 tip 的微调（非 scoped，因为 teleport 到 body）。 */
.context-menu .menu-icon {
  font-size: 14px;
  flex-shrink: 0;
}
.context-menu .menu-label {
  flex: 1;
  min-width: 0;
}
.context-menu .menu-tip {
  margin-left: 8px;
  font-size: 11px;
  color: var(--text-muted);
}
</style>
