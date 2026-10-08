<template>
  <div class="panel chat-panel">
    <div class="panel-title chat-title">
      <span class="chat-title-text"><el-icon><ChatDotRound /></el-icon>&nbsp;导演对话</span>
      <el-button link size="small" :icon="Delete" class="chat-clear" @click="emit('clear')">清空</el-button>
    </div>

    <div ref="chatBoxRef" class="chat-box">
      <div v-if="!messages.length" class="chat-empty">
        <el-icon class="chat-empty-icon"><ChatLineSquare /></el-icon>
        <p>和导演说句话吧：开拍、查进度、暂停继续、重渲镜头都可以。</p>
        <div class="quick-chips">
          <el-tag
            v-for="q in quickPrompts"
            :key="q"
            class="quick-chip"
            effect="plain"
            @click="emit('useQuick', q)"
          >{{ q }}</el-tag>
        </div>
      </div>

      <div
        v-for="m in messages"
        :key="m.id"
        class="msg-row"
        :class="[m.role === 'user' ? 'is-user' : 'is-assistant', { 'is-error': m.error }]"
      >
        <div v-if="m.role === 'user'" class="msg-user-wrap">
          <div class="bubble bubble-user">{{ m.content }}</div>
          <div class="msg-user-foot">
            <span class="msg-time">{{ formatTime(m.ts) }}</span>
            <span class="msg-op" title="复制" @click="emit('copyMsg', m.content)"><el-icon><CopyDocument /></el-icon></span>
            <span class="msg-op" title="重新发送" @click="emit('resendMsg', m)"><el-icon><Refresh /></el-icon></span>
          </div>
        </div>
        <div v-else class="bubble bubble-assistant">
          <div v-if="m.content" class="msg-text msg-actionable" v-html="renderMd(m.content)" @contextmenu.prevent="emit('copyMsg', m.content)" />
          <div v-if="m.toolCalls?.length" class="tool-list">
            <div
              v-for="tc in m.toolCalls"
              :key="tc.id"
              class="tool-card"
              :class="`is-${tc.status}`"
            >
              <div class="tool-head" @click="emit('toggleTool', tc.id)">
                <el-icon v-if="tc.status === 'running'" class="tool-icon is-loading"><Loading /></el-icon>
                <el-icon v-else-if="tc.status === 'done'" class="tool-icon tc-done"><CircleCheckFilled /></el-icon>
                <el-icon v-else class="tool-icon tc-error"><CircleCloseFilled /></el-icon>
                <span class="tool-label">{{ tc.label }}</span>
                <span v-if="tc.argsText" class="tool-args">{{ tc.argsText }}</span>
                <el-icon v-if="tc.result" class="tool-caret"><CaretBottom /></el-icon>
              </div>
              <div v-if="tc.result && expandedTools.has(tc.id)" class="tool-result">
                <pre>{{ tc.result }}</pre>
              </div>
            </div>
          </div>
          <div class="msg-foot">
            <span class="msg-time">{{ formatTime(m.ts) }}</span>
            <span class="msg-op" title="复制" @click="emit('copyMsg', m.content)"><el-icon><CopyDocument /></el-icon></span>
          </div>
        </div>
      </div>

      <div v-if="sending" class="msg-row is-assistant">
        <div class="bubble bubble-assistant typing">
          <el-icon class="is-loading"><Loading /></el-icon><span>导演思考中…</span>
        </div>
      </div>
    </div>

    <div class="chat-input">
      <el-input
        :model-value="inputText"
        @update="onInputChange"
        type="textarea"
        :autosize="{ minRows: 1, maxRows: 4 }"
        placeholder="给导演下达指令，Enter 发送 / Shift+Enter 换行"
        :disabled="sending"
        @keydown.enter.exact.prevent="emit('send')"
      />
      <el-button type="primary" circle :icon="Promotion" :loading="sending" @click="emit('send')" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import {
  ChatDotRound, ChatLineSquare, Loading, CircleCheckFilled, CircleCloseFilled,
  Promotion, Delete, CopyDocument, Refresh, CaretBottom
} from '@element-plus/icons-vue'
import type { ConversationMessage } from '../../../../shared/ipcTypes'

interface ChatProps {
  messages: ConversationMessage[]
  inputText: string
  sending: boolean
  expandedTools: Set<string>
  quickPrompts: string[]
  /** 滚动信号：composable 在 messages 变化时递增此值，子组件 watch 后滚底 */
  scrollTick: number
  /** 由壳传入的 Markdown 渲染函数 */
  renderMd: (text: string) => string
}

const props = defineProps<ChatProps>()

const emit = defineEmits<{
  toggleTool: [id: string]
  useQuick: [q: string]
  copyMsg: [text: string]
  resendMsg: [m: ConversationMessage]
  send: []
  clear: []
  'update:inputText': [v: string]
}>()

function formatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function onInputChange(val: string): void {
  emit('update:inputText', val)
}

// 滚动信号触发后滚底（用户正在回看历史时不打断）
const chatBoxRef = ref<HTMLElement | null>(null)
watch(() => props.scrollTick, async () => {
  await nextTick()
  const box = chatBoxRef.value
  if (!box) return
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140
  if (nearBottom) box.scrollTop = box.scrollHeight
})
</script>

<style scoped>
.panel {
  background: var(--bg-card);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  padding: 12px 14px;
}
.panel-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 10px;
  display: flex;
  align-items: center;
}

.chat-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.chat-title { justify-content: space-between; margin-bottom: 8px; }
.chat-title-text { display: flex; align-items: center; }
.chat-clear { color: var(--text-muted); }

.chat-box {
  flex: 1;
  overflow-y: auto;
  padding: 4px 2px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.chat-empty {
  margin: auto;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.8;
  padding: 0 16px;
}
.chat-empty-icon { font-size: 34px; margin-bottom: 10px; }
.chat-empty p { margin: 0 0 14px; }
.quick-chips { display: flex; flex-direction: column; gap: 8px; align-items: center; }
.quick-chip {
  cursor: pointer;
  padding: 6px 12px;
  height: auto;
  line-height: 1.5;
}

.msg-row { display: flex; }
.msg-row.is-user { justify-content: flex-end; }
.msg-row.is-assistant { justify-content: flex-start; }
.bubble {
  max-width: 88%;
  border-radius: 10px;
  padding: 9px 12px;
  font-size: 13px;
  line-height: 1.7;
  word-break: break-word;
}
.bubble-user {
  background: #67c23a;
  color: #fff;
  border-bottom-right-radius: 3px;
}
.bubble-assistant {
  background: var(--bg-input);
  border: 1px solid var(--border-weak);
  color: var(--text-primary);
  border-bottom-left-radius: 3px;
  width: 100%;
  max-width: 100%;
}
.msg-row.is-error .bubble-assistant { border-color: #f56c6c; color: #f56c6c; }
.msg-text { white-space: pre-wrap; }

.msg-user-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
  max-width: 88%;
}
.msg-user-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px;
}

.msg-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 5px;
  justify-content: flex-end;
}
.msg-time {
  font-size: 11px;
  color: var(--text-muted);
}
.msg-op {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
  font-size: 13px;
}
.msg-row:hover .msg-op { opacity: 1; }
.msg-op:hover { color: var(--text-primary); background: var(--bg-input); }

.msg-text p { margin: 0; line-height: 1.7; }
.msg-text .md-spacer { height: 6px; }
.msg-text ul, .msg-text ol { margin: 4px 0; padding-left: 20px; }
.msg-text li { margin: 2px 0; line-height: 1.7; }
.msg-text code {
  background: var(--bg-card);
  border: 1px solid var(--border-weak);
  border-radius: 3px;
  padding: 0 4px;
  font-size: 12px;
  font-family: monospace;
}
.msg-text .md-code {
  background: var(--bg-card);
  border: 1px solid var(--border-weak);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  font-family: monospace;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 6px 0;
  line-height: 1.6;
  max-height: 220px;
  overflow-y: auto;
}
.msg-text strong { font-weight: 600; }

.typing {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  width: auto;
}
.is-loading { animation: spin 1.4s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.tool-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.tool-card {
  border: 1px solid var(--border-weak);
  border-radius: 6px;
  background: var(--bg-card);
  overflow: hidden;
}
.tool-card.is-running { border-color: #409eff66; }
.tool-card.is-done { border-color: #67c23a55; }
.tool-card.is-error { border-color: #f56c6c66; }
.tool-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 10px;
  cursor: pointer;
  font-size: 12px;
}
.tool-icon { font-size: 14px; flex-shrink: 0; }
.tc-done { color: #67c23a; }
.tc-error { color: #f56c6c; }
.tool-label { font-weight: 600; color: var(--text-primary); flex-shrink: 0; }
.tool-args {
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.tool-caret { color: var(--text-muted); flex-shrink: 0; }
.tool-result {
  border-top: 1px dashed var(--border-weak);
  padding: 7px 10px;
  max-height: 180px;
  overflow: auto;
}
.tool-result pre {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  font-family: inherit;
}

.chat-input {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border-weak);
}
.chat-input .el-button { flex-shrink: 0; }
</style>
