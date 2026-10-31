import { computed, reactive, ref, watch, type Ref } from 'vue'
import { ElMessage } from 'element-plus'
import { confirmDanger } from '../utils/confirm'
import { throttleTap } from '../utils/throttle'
import type { ConversationMessage, ConversationToolEvent, DirectorState } from '../../../shared/ipcTypes'
import { SELF_LEARN_PROMPT } from '../../../shared/ipcTypes'

/** RC-02：未发送草稿按作用域存取（localStorage），切换会话域后自动恢复 */
const DRAFT_PREFIX = 'drama-studio:chatDraft:'

function readDraft(scope: string): string {
  if (typeof localStorage === 'undefined') return ''
  return localStorage.getItem(DRAFT_PREFIX + scope) || ''
}

function writeDraft(scope: string, text: string): void {
  if (typeof localStorage === 'undefined') return
  const key = DRAFT_PREFIX + scope
  if (text.trim()) localStorage.setItem(key, text)
  else localStorage.removeItem(key)
}

/**
 * 导演对话：消息流 + 工具卡片 + Markdown 渲染。
 * 滚动 DOM 留在子组件 DirectorChat，本 composable 只递增 `scrollTick`，
 * 由子组件判断用户是否在回看历史后决定是否滚底，避免打断阅读。
 *
 * @param chatScope 对话作用域（projectId 或 'global'）
 * @param state     导演状态（用于动态推荐快捷指令 quickPrompts）
 */
export function useDirectorChat(chatScope: Ref<string>, state: Ref<DirectorState | null>) {
  const messages = ref<ConversationMessage[]>([])
  // RC-02：未发送内容按对话作用域暂存，切换全局/项目对话后回来仍在输入框
  const inputText = ref(readDraft(chatScope.value))
  watch(inputText, (text) => writeDraft(chatScope.value, text))
  const sending = ref(false)
  /** C-01：本组件被卸载但主进程仍在发送时，切回后靠轮询恢复发送态 */
  let sendingPoll: ReturnType<typeof setInterval> | null = null
  watch(chatScope, (scope) => {
    // UI-01：切换项目/全局对话必须复位发送态并清掉旧作用域轮询，
    // 否则旧 scope 的 in-flight 发送会让新 scope 永久卡在"发送中"
    //（syncSending 见 sending=true 直接 return，刷新前无法再发消息）。
    // 新作用域若确在发送，随后 loadChat() → syncSending() 会重新判定并接管轮询。
    inputText.value = readDraft(scope)
    if (sendingPoll) {
      clearInterval(sendingPoll)
      sendingPoll = null
    }
    sending.value = false
    // 复位后按新作用域重新判定：若新 scope 确实在发送，恢复发送态并接管轮询
    void syncSending()
  })
  const expandedTools = reactive(new Set<string>())
  /** 滚动信号：递增后由子组件 watch 并按需滚底 */
  const scrollTick = ref(0)
  function requestScroll(): void {
    scrollTick.value++
  }

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
    const scope = chatScope.value
    // R-8/R-9：自兜底 catch——onMounted 与路由 watch 中若此处 reject 会产生
    // unhandled rejection 且连坐跳过后续初始化
    try {
      const list = await window.api.conversation.list(scope)
      // 异步期间用户已切到别的项目：丢弃过期结果，防止旧对话覆盖新对话
      if (chatScope.value !== scope) return
      messages.value = list
      requestScroll()
      // C-01：路由切回时若主进程仍在发送，恢复发送态并在完成后自动刷新
      void syncSending()
    } catch (e) {
      ElMessage.error(`会话加载失败：${e instanceof Error ? e.message : String(e)}`)
    }
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
    const inline = (s: string): string =>
      esc(s)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    const lines = text.split('\n')
    const out: string[] = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (line === undefined) break
      // 代码块
      if (line.startsWith('```')) {
        const buf: string[] = []
        i++
        while (i < lines.length && !(lines[i] ?? '').startsWith('```')) buf.push(lines[i++] ?? '')
        out.push(`<pre class="md-code">${esc(buf.join('\n'))}</pre>`)
        i++
        continue
      }
      // 无序列表
      if (/^[-*•] /.test(line)) {
        const items: string[] = []
        while (i < lines.length && /^[-*•] /.test(lines[i] ?? '')) {
          items.push(`<li>${inline((lines[i] ?? '').replace(/^[-*•] /, ''))}</li>`)
          i++
        }
        out.push(`<ul>${items.join('')}</ul>`)
        continue
      }
      // 有序列表
      if (/^\d+\. /.test(line)) {
        const items: string[] = []
        while (i < lines.length && /^\d+\. /.test(lines[i] ?? '')) {
          items.push(`<li>${inline((lines[i] ?? '').replace(/^\d+\. /, ''))}</li>`)
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
    const msg = messages.value.find((m) => m.id === e.messageId)
    if (msg) {
      if (!msg.toolCalls) msg.toolCalls = []
      const idx = msg.toolCalls.findIndex((c) => c.id === e.toolCall.id)
      if (idx >= 0) msg.toolCalls[idx] = e.toolCall
      else msg.toolCalls.push(e.toolCall)
    } else {
      messages.value.push({
        id: e.messageId,
        role: 'assistant',
        content: '',
        ts: Date.now(),
        toolCalls: [e.toolCall],
      })
    }
    requestScroll()
  }

  async function sendMessage(text?: string): Promise<void> {
    const content = (text ?? inputText.value).trim()
    if (!content) {
      // 不再静默：空内容/IME 未提交时给用户明确反馈，避免"点了没反应"
      if (throttleTap('director-send-empty', 500)) ElMessage.warning('请输入内容后再发送')
      return
    }
    if (sending.value) return
    const scope = chatScope.value
    inputText.value = ''
    messages.value.push({ id: `local_${Date.now()}`, role: 'user', content, ts: Date.now() })
    sending.value = true
    requestScroll()
    try {
      const list = await window.api.conversation.send(scope, content)
      // 异步期间已切换项目：丢弃旧 scope 的全量结果，避免覆盖新会话
      if (chatScope.value !== scope) return
      messages.value = list
    } catch (e) {
      if (chatScope.value !== scope) return
      messages.value.push({
        id: `err_${Date.now()}`,
        role: 'assistant',
        content: `对话服务出错：${e instanceof Error ? e.message : String(e)}`,
        ts: Date.now(),
        error: true,
      })
    } finally {
      // 作用域已切换时不能复位：旧 scope 的 in-flight 发送收尾会把新 scope 的发送态误清
      if (chatScope.value === scope) {
        sending.value = false
        requestScroll()
      }
    }
  }

  /** 停止当前发送：主进程中断 LLM 请求与工具循环，返回后以落盘历史为准 */
  async function stopSend(): Promise<void> {
    if (!sending.value) return
    try {
      await window.api.conversation.stop(chatScope.value)
    } catch {
      /* 主进程会在发送收尾时自行落盘 */
    }
  }

  /** 回退到某条用户消息之前：删除该消息及其后记录，用户可重新编辑发送 */
  async function rollbackMsg(m: ConversationMessage): Promise<void> {
    if (m.role !== 'user') return
    const okRollback = await confirmDanger('将删除这条消息及其后的全部对话，回到此处重新交互。确定回退吗？', {
      title: '回退对话',
      confirmText: '回退',
    })
    if (!okRollback) return
    const scope = chatScope.value
    try {
      const list = await window.api.conversation.rollback(scope, m.id)
      // 异步期间已切换项目：丢弃旧 scope 的结果，避免覆盖新会话
      if (chatScope.value !== scope) return
      messages.value = list
      ElMessage.success('已回退')
    } catch (e) {
      if (chatScope.value !== scope) return
      ElMessage.error(`回退失败：${e instanceof Error ? e.message : String(e)}`)
    }
    requestScroll()
  }

  /**
   * 重新生成：让导演就"最后一条 user 提问"重新回答（与 resendMsg 区分）。
   *
   * - resendMsg = 原样重发某条 user 消息，后续历史全部保留（再追加一轮）；
   * - regenerateMsg = 以"最后一条 user 提问"为界：删掉它及其后的旧回答（含尾 assistant），
   *   再用同一提问原文重发——更早的上下文保持不变，旧回答被新回答替换。
   *
   * 实现复用既有机制，不另起一套：
   * - truncation 走既有 rollback IPC 落盘（后端 send 是"追加 user"，不先删旧回答会重复历史）；
   * - 重发直接调用 sendMessage：复用其 sending 状态、乐观 user 气泡、scope 切换守卫、
   *   错误处理与 scrollTick；工具过程仍由 applyToolEvent 实时推进，最终以权威列表收尾。
   * 仅当列表尾部为 assistant 且非发送中才可触发（UI 侧禁用，此处再做幂等兜底）。
   */
  async function regenerateMsg(): Promise<void> {
    // 挡住 rollback 落盘等待期间的连击；正式发送期由 sending 守卫
    if (!throttleTap('director-regenerate', 1000)) return
    if (sending.value) return
    const list = messages.value
    const last = list[list.length - 1]
    // 仅当尾部是 assistant 时才有"重新回答"对象
    if (!last || last.role !== 'assistant') return
    // 向前找触发本轮回答的最近一条 user 提问
    let userIdx = -1
    for (let i = list.length - 2; i >= 0; i--) {
      const item = list[i]
      if (item?.role === 'user') {
        userIdx = i
        break
      }
    }
    if (userIdx < 0) {
      ElMessage.warning('找不到对应的提问，无法重新生成回答')
      return
    }
    const userMsg = list[userIdx]
    if (!userMsg) return
    const userContent = userMsg.content
    const scope = chatScope.value
    try {
      // 先在落盘侧删掉旧提问与旧回答（保留更早上下文）
      const kept = await window.api.conversation.rollback(scope, userMsg.id)
      // 异步期间已切换项目：丢弃旧 scope 结果
      if (chatScope.value !== scope) return
      // 立即刷新本地视图，避免旧气泡与新乐观气泡并存造成闪烁
      messages.value = kept
      requestScroll()
      // 用同一提问原文重发：sendMessage 会 push 新 user 气泡、置 sending、走工具循环，
      // 并以权威列表收尾——尾 assistant 即为本轮新回答
      await sendMessage(userContent)
    } catch (e) {
      if (chatScope.value !== scope) return
      ElMessage.error(`重新生成失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 上传文件：选择文本文件后把内容拼进用户消息发给导演 */
  async function uploadAndSend(): Promise<void> {
    if (sending.value) return
    let payload: { name: string; content: string; truncated: boolean } | null
    try {
      payload = await window.api.conversation.uploadFile()
    } catch (e) {
      // 用户在文件选择框点取消：主进程 reject 'User cancelled'，不报错
      if (e instanceof Error && e.message === 'User cancelled') return
      ElMessage.error(`文件读取失败：${e instanceof Error ? e.message : String(e)}`)
      return
    }
    if (!payload) return
    const header = `我上传了文件「${payload.name}」${payload.truncated ? '（内容过长已截断）' : ''}，请查收并按内容处理：`
    await sendMessage(`${header}\n\n${payload.content}`)
  }

  /** 自主学习：让导演上网搜索最新技巧并沉淀/更新技能（指令文案与主进程每日自动学习共用） */
  function selfLearn(): void {
    if (sending.value) return
    void sendMessage(SELF_LEARN_PROMPT)
  }

  async function clearChat(): Promise<void> {
    if (!messages.value.length) return
    const ok = await confirmDanger('确定清空与导演的对话记录吗？此操作不可恢复。', {
      title: '清空对话',
      confirmText: '清空',
    })
    if (!ok) return
    try {
      await window.api.conversation.clear(chatScope.value)
      messages.value = []
      expandedTools.clear()
      ElMessage.success('对话已清空')
    } catch (e) {
      ElMessage.error(`清空失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** C-01：本组件未持有发送过程（路由切走时被卸载）但主进程仍在发送时，恢复 sending 态并轮询至完成后刷新 */
  async function syncSending(): Promise<void> {
    if (sending.value || sendingPoll) return
    const scope = chatScope.value
    try {
      if (!(await window.api.conversation.isSending(scope))) return
      if (chatScope.value !== scope) return
      sending.value = true
      sendingPoll = setInterval(() => {
        void (async () => {
          try {
            const still = await window.api.conversation.isSending(scope)
            if (chatScope.value !== scope || !still) {
              if (sendingPoll) {
                clearInterval(sendingPoll)
                sendingPoll = null
              }
              if (chatScope.value === scope) {
                sending.value = false
                await loadChat()
              }
            }
          } catch {
            /* 下一轮再试 */
          }
        })()
      }, 2000)
    } catch {
      /* 状态查询失败不影响主流程 */
    }
  }

  let unsubTool: (() => void) | null = null
  function subscribe(): void {
    unsubTool = window.api.conversation.onToolEvent(applyToolEvent)
  }
  function unsubscribeAll(): void {
    unsubTool?.()
    unsubTool = null
    if (sendingPoll) {
      clearInterval(sendingPoll)
      sendingPoll = null
    }
  }

  return {
    messages,
    inputText,
    sending,
    expandedTools,
    scrollTick,
    quickPrompts,
    loadChat,
    toggleTool,
    useQuick,
    renderMd,
    copyMsg,
    resendMsg,
    sendMessage,
    stopSend,
    rollbackMsg,
    regenerateMsg,
    uploadAndSend,
    selfLearn,
    clearChat,
    applyToolEvent,
    subscribe,
    unsubscribeAll,
  }
}
