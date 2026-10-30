<template>
  <teleport to="body">
    <div
      v-if="visible"
      class="input-ctx"
      :style="{ left: x + 'px', top: y + 'px' }"
      @click.stop
      @contextmenu.prevent
    >
      <div class="ctx-item" @click="doEdit('cut')">剪切</div>
      <div class="ctx-item" @click="doEdit('copy')">复制</div>
      <div class="ctx-item" @click="doEdit('paste')">粘贴</div>
      <div class="ctx-item" @click="doEdit('selectAll')">全选</div>
      <div class="ctx-divider" v-if="hasClear || history.length > 0" />
      <div class="ctx-item ctx-danger" @click="doClear" v-if="hasClear">清空内容</div>
      <!-- 历史记录：点选填入 -->
      <template v-if="history.length > 0">
        <div class="ctx-group-title">历史记录（{{ history.length }}）</div>
        <div
          v-for="(item, i) in history"
          :key="i"
          class="ctx-item ctx-history"
          :title="item"
          @click="pickHistory(item)"
        >
{{ item }}
</div>
        <div class="ctx-item ctx-muted" @click="clearHistory">清除本框历史</div>
      </template>
    </div>
  </teleport>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'

interface CtxTarget {
  el: HTMLInputElement | HTMLTextAreaElement
  /** 清空时的额外钩子（受控组件需要同步外部值） */
  onClear?: () => void
  /** 从历史点选填入时的额外钩子（默认：写入目标并触发 input 事件） */
  onPick?: (value: string) => void
  history?: string[]
  clearHistory?: () => void
}

const visible = ref(false)
const x = ref(0)
const y = ref(0)
const target = ref<CtxTarget | null>(null)
const history = ref<string[]>([])

const hasClear = ref(true)

function open(e: MouseEvent, t: CtxTarget): void {
  e.preventDefault()
  target.value = t
  history.value = t.history ?? []
  hasClear.value = true
  // 边缘 clamp：菜单宽约 200px，高按条目数估算
  const menuW = 220
  const menuH = 64 + Math.min(history.value.length, 8) * 30 + (history.value.length > 0 ? 30 : 0)
  const vw = window.innerWidth
  const vh = window.innerHeight
  x.value = Math.min(e.clientX, vw - menuW - 8)
  y.value = Math.min(e.clientY, vh - menuH - 8)
  visible.value = true
}

function close(): void {
  visible.value = false
  target.value = null
}

function doEdit(action: 'cut' | 'copy' | 'paste' | 'selectAll'): void {
  const el = target.value?.el
  if (!el) return close()
  el.focus()
  try {
    if (action === 'selectAll') {
      el.select()
    } else if (action === 'cut') {
      document.execCommand('cut')
    } else if (action === 'copy') {
      document.execCommand('copy')
    } else if (action === 'paste') {
      // execCommand('paste') 多数环境被禁，用剪贴板读取 + insertText
      navigator.clipboard.readText().then(text => {
        el.focus()
        const ok = document.execCommand('insertText', false, text)
        if (!ok) {
          // 兜底：手动写入并派发 input 事件同步 v-model
          const start = el.selectionStart ?? el.value.length
          const end = el.selectionEnd ?? el.value.length
          el.value = el.value.slice(0, start) + text + el.value.slice(end)
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }
      }).catch(() => ElMessage.warning('无法读取剪贴板'))
    }
  } catch {
    ElMessage.warning('该操作当前环境不支持')
  }
  close()
}

function doClear(): void {
  const t = target.value
  if (!t) return close()
  // 受控目标（el-select 记忆框）：只走 onClear 钩子写 v-model，
  // 不碰内部 input，避免残留输入态在后续变更周期回写旧值
  if (t.onClear) {
    t.onClear()
    close()
    return
  }
  t.el.focus()
  t.el.value = ''
  t.el.dispatchEvent(new Event('input', { bubbles: true }))
  close()
}

function pickHistory(item: string): void {
  const t = target.value
  if (!t) return close()
  // 受控目标（el-select 记忆框）：只走 onPick 钩子赋 v-model，
  // 绝不写入内部 filter input / 派发 input 事件（那是持久层回写的根源）
  if (t.onPick) {
    t.onPick(item)
    close()
    return
  }
  t.el.focus()
  t.el.value = item
  t.el.dispatchEvent(new Event('input', { bubbles: true }))
  close()
}

function clearHistory(): void {
  target.value?.clearHistory?.()
  history.value = []
  ElMessage.success('已清除本框历史')
  close()
}

// 点击外部 / Esc 关闭
function onGlobalClick(): void { close() }
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') close()
}
onMounted(() => {
  document.addEventListener('click', onGlobalClick)
  document.addEventListener('keydown', onKey)
})
onUnmounted(() => {
  document.removeEventListener('click', onGlobalClick)
  document.removeEventListener('keydown', onKey)
})

defineExpose({ open })
</script>

<style scoped>
.input-ctx {
  position: fixed;
  z-index: 3000;
  min-width: 200px;
  max-width: 320px;
  max-height: 420px;
  overflow-y: auto;
  background: var(--bg-menu, #1c2430);
  border: 1px solid var(--border-weak, rgba(255, 255, 255, 0.12));
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  padding: 6px;
  font-size: 13px;
}
.ctx-item {
  padding: 7px 10px;
  border-radius: 7px;
  color: var(--text-primary, #e8eef4);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ctx-item:hover { background: var(--bg-hover, rgba(255, 255, 255, 0.08)); }
.ctx-danger { color: #f07178; }
.ctx-muted { color: var(--text-muted, #9fb0c0); font-size: 12px; }
.ctx-divider { height: 1px; background: var(--border-weak, rgba(255, 255, 255, 0.1)); margin: 5px 8px; }
.ctx-group-title {
  padding: 6px 10px 2px;
  font-size: 11px;
  color: var(--text-muted, #9fb0c0);
  user-select: none;
}
.ctx-history { font-size: 12px; color: var(--text-secondary, #c8d2dc); }
</style>
