<template>
  <div class="panel chat-panel">
    <div class="panel-title chat-title">
      <span class="chat-title-text"><el-icon><ChatDotRound /></el-icon>&nbsp;导演对话</span>
      <span class="chat-title-actions">
        <el-button
          v-if="props.taskRunning || props.taskPaused"
          link
          size="small"
          type="danger"
          :icon="CircleClose"
          class="chat-cancel"
          @click="emit('cancelTask')"
        >取消任务</el-button>
        <el-button link size="small" :icon="Delete" class="chat-clear" @click="emit('clear')">清空</el-button>
      </span>
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
          >
{{ q }}
</el-tag>
        </div>
      </div>

      <div
        v-for="m in messages"
        :key="m.id"
        class="msg-row"
        :class="[m.role === 'user' ? 'is-user' : 'is-assistant', { 'is-error': m.error }]"
      >
        <div v-if="m.role === 'user'" class="msg-user-wrap" @contextmenu.prevent="onMsgContextMenu($event, m)">
          <div class="bubble bubble-user">{{ m.content }}</div>
          <div class="msg-user-foot">
            <span class="msg-time">{{ formatTime(m.ts) }}</span>
            <button type="button" class="msg-op" title="复制" @click="emit('copyMsg', m.content)"><el-icon><CopyDocument /></el-icon></button>
            <button type="button" class="msg-op" title="回退到此消息之前重新交互" @click="emit('rollbackMsg', m)"><el-icon><RefreshLeft /></el-icon></button>
            <button type="button" class="msg-op" title="重新发送" @click="emit('resendMsg', m)"><el-icon><Refresh /></el-icon></button>
          </div>
        </div>
        <div v-else class="bubble bubble-assistant" @contextmenu.prevent="onMsgContextMenu($event, m)">
          <div v-if="m.content" class="msg-text msg-actionable" v-html="renderMd(m.content)" />
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
            <button type="button" class="msg-op" title="复制" @click="emit('copyMsg', m.content)"><el-icon><CopyDocument /></el-icon></button>
          </div>
        </div>
      </div>

      <div v-if="sending" class="msg-row is-assistant">
        <div class="bubble bubble-assistant typing">
          <el-icon class="is-loading"><Loading /></el-icon><span>导演思考中…</span>
        </div>
      </div>
    </div>

    <!-- 快捷指令按钮（REQ-14 DC-OPEN-26：继续/暂停/重渲第X镜/看进度） -->
    <div class="quick-actions">
      <el-button size="small" plain @click="emit('useQuick', '继续')">继续</el-button>
      <el-button size="small" plain @click="emit('useQuick', '暂停')">暂停</el-button>
      <el-button size="small" plain @click="quickRerenderShot">重渲第X镜</el-button>
      <el-button size="small" plain @click="emit('useQuick', '看看进度')">看进度</el-button>
    </div>

    <div class="chat-input">
      <el-tooltip content="上传文件（txt/md/json/剧本等文本）" placement="top">
        <el-button circle :icon="Paperclip" :disabled="sending" class="chat-upload" @click="emit('upload')" />
      </el-tooltip>
      <el-tooltip content="自主学习：让导演上网搜索最新技巧并沉淀为新技能" placement="top">
        <el-button circle :icon="Reading" :disabled="sending" class="chat-learn" @click="emit('selfLearn')" />
      </el-tooltip>
      <el-input
        ref="chatInputRef"
        :model-value="inputText"
        @update:model-value="onInputChange"
        type="textarea"
        :autosize="{ minRows: 1, maxRows: 4 }"
        placeholder="给导演下达指令，Enter 发送 / Shift+Enter 换行"
        :disabled="sending"
        @keydown.enter.exact.prevent="handleSend()"
      />
      <!-- 发送中变为停止按钮：随时中断导演的思考与工具调用 -->
      <el-button
        v-if="sending"
        circle
        type="danger"
        :icon="VideoPause"
        title="停止生成"
        @click="emit('stop')"
      />
      <el-button v-else type="primary" circle :icon="Promotion" @click="handleSend()" />
    </div>

    <!-- 对话气泡右键菜单（交互规范 3.1：替代原"右键=直接复制"） -->
    <ContextMenu ref="msgMenuRef" :items="msgMenuItems" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import {
  ChatDotRound, ChatLineSquare, Loading, CircleCheckFilled, CircleCloseFilled, CircleClose,
  Promotion, Delete, CopyDocument, Refresh, RefreshLeft, CaretBottom, Paperclip, VideoPause, Reading
} from '@element-plus/icons-vue'
import type { ConversationMessage } from '../../../../shared/ipcTypes'
import { buildRerenderShotCommand } from '../../../../shared/quickCommands'
// R-13：formatTime 唯一实现在 useDirectorState，删除第三份本地副本
import { formatTime } from '../../composables/useDirectorState'
import ContextMenu, { type CtxItem } from '../ContextMenu.vue'

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
  /** 导演任务是否执行中/已暂停（用于显示取消任务按钮） */
  taskRunning: boolean
  taskPaused: boolean
}

const props = defineProps<ChatProps>()

const emit = defineEmits<{
  toggleTool: [id: string]
  useQuick: [q: string]
  copyMsg: [text: string]
  resendMsg: [m: ConversationMessage]
  rollbackMsg: [m: ConversationMessage]
  regenerate: []
  send: []
  stop: []
  upload: []
  selfLearn: []
  clear: []
  cancelTask: []
  'update:inputText': [v: string]
}>()

function onInputChange(val: string): void {
  emit('update:inputText', val)
}

/**
 * 发送入口（Enter 与发送按钮共用）。
 * IME 兜底：中文输入法组合尚未结束时（isComposing=true），el-input 的 v-model
 * 不会把文字提交到 inputText，此时直接点发送会静默失败（表现为"点了没反应、
 * 文字还在输入框"）。这里先从输入框 DOM 强制同步一次再发送。
 */
const chatInputRef = ref<{ textarea: HTMLTextAreaElement } | null>(null)
function handleSend(): void {
  const ta = chatInputRef.value?.textarea
  if (ta && ta.value && !props.inputText) {
    emit('update:inputText', ta.value)
  }
  emit('send')
}

/** REQ-14 DC-OPEN-26：重渲第X镜——先问镜号，再按统一文案发送指令 */
async function quickRerenderShot(): Promise<void> {
  try {
    const r = await ElMessageBox.prompt('要重渲第几镜？', '重渲单镜', {
      inputPlaceholder: '镜号，如 3',
      inputPattern: /^[1-9]\d*$/,
      inputErrorMessage: '请输入正整数镜号',
      confirmButtonText: '发送指令',
      cancelButtonText: '取消'
    })
    const command = buildRerenderShotCommand(r.value)
    if (command) emit('useQuick', command)
  } catch {
    // 用户取消输入：不发送任何指令
  }
}

// ===== 对话气泡右键菜单（替代原"右键=直接复制"） =====
const msgMenuRef = ref<InstanceType<typeof ContextMenu> | null>(null)
const currentMsg = ref<ConversationMessage | null>(null)

const msgMenuItems = computed<CtxItem[]>(() => {
  const m = currentMsg.value
  if (!m) return []
  const isUser = m.role === 'user'
  const items: CtxItem[] = [
    { label: '复制文本', icon: CopyDocument, action: () => emit('copyMsg', m.content) }
  ]
  if (isUser) {
    items.push({ divider: true })
    items.push({ label: '回退到此消息之前', icon: RefreshLeft, action: () => emit('rollbackMsg', m) })
    items.push({ label: '重新发送', icon: Refresh, action: () => emit('resendMsg', m) })
    return items
  }
  // 助理气泡：复制 + 重新生成。
  // 仅当本条是列表尾部 assistant 且非发送中时，才可让导演就上一条提问重答；
  // 中间历史里的回答不支持重生成（会割裂后续上下文），发送中也禁用。
  const last = props.messages[props.messages.length - 1]
  const isTailAssistant = !!last && last.id === m.id
  const regenerateDisabled = !isTailAssistant || props.sending
  items.push({ divider: true })
  items.push({
    label: '重新生成',
    icon: Refresh,
    disabled: regenerateDisabled,
    tip: regenerateDisabled
      ? (props.sending ? '发送中，请稍候' : '仅最后一条回答可重新生成')
      : undefined,
    action: () => emit('regenerate')
  })
  return items
})

function onMsgContextMenu(e: MouseEvent, m: ConversationMessage): void {
  currentMsg.value = m
  msgMenuRef.value?.open(e, m)
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
.chat-title-actions { display: flex; align-items: center; gap: 2px; }
.chat-cancel { margin-right: 4px; }

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
  border-radius: 12px;
  padding: 9px 12px;
  font-size: 13px;
  line-height: 1.7;
  word-break: break-word;
  transition: box-shadow var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.bubble-user {
  background: var(--accent);
  color: var(--on-brand);
  border-bottom-right-radius: 4px;
}
.bubble-assistant {
  background: var(--bg-input);
  border: 1px solid var(--border-weak);
  color: var(--text-primary);
  border-bottom-left-radius: 4px;
  width: 100%;
  max-width: 100%;
}
.bubble-assistant:hover { border-color: var(--border-strong); }
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
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
  font-size: 13px;
  font-family: inherit;
}
.msg-row:hover .msg-op { opacity: 1; }
.msg-op:focus-visible { opacity: 1; }
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

.quick-actions { display: flex; gap: 6px; padding: 4px 0; flex-wrap: wrap; }
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
