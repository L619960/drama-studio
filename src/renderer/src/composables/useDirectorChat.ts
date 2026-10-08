import { computed, reactive, ref, type Ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type {
  ConversationMessage, ConversationToolEvent, DirectorState
} from '../../../shared/ipcTypes'

/**
 * 导演对话：消息流 + 工具卡片 + Markdown 渲染。
 *
 * 滚动 DOM（chatBoxRef）留在子组件 DirectorChat 内：composable 在每次消息变化时递增
 * `scrollTick`，子组件 watch 该 tick + nextTick 后判断"用户是否在回看历史"
 * （nearBottom 判断）决定是否滚到底部——保留原 [ConsoleView.vue] 的不打断逻辑。
 *
 * @param chatScope 对话作用域（projectId 或 'global'）
 * @param state     导演状态（用于动态推荐快捷指令 quickPrompts）
 */
export function useDirectorChat(
  chatScope: Ref<string>,
  state: Ref<DirectorState | null>
) {
  const messages = ref<ConversationMessage[]>([])
  const inputText = ref('')
  const sending = ref(false)
  const expandedTools = reactive(new Set<string>())
  /** 滚动信号：递增后由子组件 watch 并按需滚底 */
  const scrollTick = ref(0)
  function requestScroll(): void { scrollTick.value++ }

  /** 根据当前项目状态动态推荐快捷指令 */
  const quickPrompts = computed<string[]>(() => {
    const s = state.value
    const prompts: string[] = []
    if (s?.running) {
      prompts.push('现在进度怎么样？')
      if (s.failedShotIds.length > 0) prompts.push(`重渲失败的 ${s.failedShotIds.length} 个镜头`)
      else prompts.push('分镜都完成了吗？')
      if (s.paused) prompts.push('当前任务暂停了，帮我继续')
      else prompts.push('先暂停一下任务')
    } else if (s && !s.running) {
      if (s.cancelled) prompts.push('上次任务取消了，重新开拍一部霸总题材短片')
      else if (s.finalPath) prompts.push('成片做完了吗？给我总结一下这个项目')
      else prompts.push('继续跑未完成的流水线')
    } else {
      prompts.push('帮我开拍一部霸总题材短片', '现在有什么模板可以拍？')
    }
    prompts.push('检查一下 ComfyUI 状态')
    prompts.push('看看我存了哪些记忆')
    return prompts.slice(0, 4)
  })

  async function loadChat(): Promise<void> {
    messages.value = await window.api.conversation.list(chatScope.value)
    requestScroll()
  }

  function toggleTool(id: string): void {
    if (expandedTools.has(id)) expandedTools.delete(id)
    else expandedTools.add(id)
  }

  function useQuick(q: string): void {
    inputText.value = q
    void sendMessage()
  }

  /** 极简 Markdown 渲染：加粗、行内代码、代码块、无序/有序列表、换行（白名单，无 XSS 风险） */
  function renderMd(text: string): string {
    const esc = (s: string): string =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const inline = (s: string): string => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    const lines = text.split('\n')
    const out: string[] = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      // 代码块
      if (line.startsWith('```')) {
        const buf: string[] = []
        i++
        while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++])
        out.push(`<pre class="md-code">${esc(buf.join('\n'))}</pre>`)
        i++
        continue
      }
      // 无序列表
      if (/^[-*•] /.test(line)) {
        const items: string[] = []
        while (i < lines.length && /^[-*•] /.test(lines[i])) {
          items.push(`<li>${inline(lines[i].replace(/^[-*•] /, ''))}</li>`)
          i++
        }
        out.push(`<ul>${items.join('')}</ul>`)
        continue
      }
      // 有序列表
      if (/^\d+\. /.test(line)) {
        const items: string[] = []
        while (i < lines.length && /^\d+\. /.test(lines[i])) {
          items.push(`<li>${inline(lines[i].replace(/^\d+\. /, ''))}</li>`)
          i++
        }
        out.push(`<ol>${items.join('')}</ol>`)
        continue
      }
      // 空行 → 间距
      if (line.trim() === '') {
        out.push('<div class="md-spacer"></div>')
        i++
        continue
      }
      out.push(`<p>${inline(line)}</p>`)
      i++
    }
    return out.join('')
  }

  async function copyMsg(text: string): Promise<void> {
    await navigator.clipboard.writeText(text)
    ElMessage.success('已复制')
  }

  function resendMsg(m: ConversationMessage): void {
    inputText.value = m.content
    void sendMessage()
  }

  /** 工具实时事件：权威列表返回前可能先到达，找不到消息就合成一条，send 返回后以全量列表为准 */
  function applyToolEvent(e: ConversationToolEvent): void {
    if (e.scope !== chatScope.value) return
    const msg = messages.value.find(m => m.id === e.messageId)
    if (msg) {
      if (!msg.toolCalls) msg.toolCalls = []
      const idx = msg.toolCalls.findIndex(c => c.id === e.toolCall.id)
      if (idx >= 0) msg.toolCalls[idx] = e.toolCall
      else msg.toolCalls.push(e.toolCall)
    } else {
      messages.value.push({
        id: e.messageId,
        role: 'assistant',
        content: '',
        ts: Date.now(),
        toolCalls: [e.toolCall]
      })
    }
    requestScroll()
  }

  async function sendMessage(): Promise<void> {
    const text = inputText.value.trim()
    if (!text || sending.value) return
    inputText.value = ''
    messages.value.push({ id: `local_${Date.now()}`, role: 'user', content: text, ts: Date.now() })
    sending.value = true
    requestScroll()
    try {
      messages.value = await window.api.conversation.send(chatScope.value, text)
    } catch (e) {
      messages.value.push({
        id: `err_${Date.now()}`, role: 'assistant',
        content: `对话服务出错：${e instanceof Error ? e.message : String(e)}`,
        ts: Date.now(), error: true
      })
    } finally {
      sending.value = false
      requestScroll()
    }
  }

  async function clearChat(): Promise<void> {
    if (!messages.value.length) return
    try {
      await ElMessageBox.confirm('确定清空与导演的对话记录吗？此操作不可恢复。', '清空对话', {
        type: 'warning', confirmButtonText: '清空', cancelButtonText: '取消'
      })
    } catch { return }
    await window.api.conversation.clear(chatScope.value)
    messages.value = []
    expandedTools.clear()
  }

  let unsubTool: (() => void) | null = null
  function subscribe(): void {
    unsubTool = window.api.conversation.onToolEvent(applyToolEvent)
  }
  function unsubscribeAll(): void {
    unsubTool?.()
    unsubTool = null
  }

  return {
    messages, inputText, sending, expandedTools, scrollTick,
    quickPrompts,
    loadChat, toggleTool, useQuick, renderMd, copyMsg, resendMsg,
    sendMessage, clearChat, applyToolEvent,
    subscribe, unsubscribeAll
  }
}
