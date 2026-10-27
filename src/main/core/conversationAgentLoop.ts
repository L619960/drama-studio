/**
 * 导演对话 agent loop：send 入队后的实际执行体。
 * 负责构建 system prompt 与工具清单、历史→OpenAI 消息转换、按 80K 字符预算裁剪、
 * 工具调用循环（含死循环同签名保险、保险上限总结收尾、abort 回填 running 工具记录）。
 * 从 conversationService.ts 抽出，行为不变。
 */
import axios from 'axios'
import type { ChatMessage, ToolSpec } from './llmService'
import { BUILTIN_TOOL_SPECS, customToolSpec } from './skillService'
import type { Skill, ConversationMessage, ConversationToolEvent, ToolCallRecord } from '../../shared/ipcTypes'
import {
  MAX_TOOL_ROUNDS, SAME_CALL_LIMIT, HISTORY_LIMIT, RESULT_LIMIT,
  FULL_TOOL_RESULTS, OLD_RESULT_KEEP, CONTEXT_CHAR_BUDGET, mid
} from './conversationConstants'
import type { ConversationService } from './conversationService'

export async function doSendImpl(agent: ConversationService, scope: string, text: string, controller: AbortController): Promise<ConversationMessage[]> {
  // C5：排队期被取消的发送直接返回现状（不落用户消息、不启动 LLM）
  if (controller.signal.aborted) return agent.list(scope)
  const history = await agent.list(scope)
  history.push({ id: mid(), role: 'user', content: text, ts: Date.now() })
  await agent.save(scope, history)

  const system = await agent.buildSystemPrompt(scope)
  const allSkills = await agent.skills.list()
  const enabled = allSkills.filter(s => s.enabled)
  const tools: ToolSpec[] = [
    // 注意：BUILTIN_TOOL_SPECS 是按工具名索引的查表，skill 配置里可能出现
    // 已下线的 tool 名，查不到会混入 undefined 导致 LLM 工具描述损坏（M-11）
    ...enabled.filter(s => s.kind === 'tool' && s.tool && BUILTIN_TOOL_SPECS[s.tool])
      .map(s => BUILTIN_TOOL_SPECS[s.tool!]),
    ...enabled.filter(s => s.kind === 'prompt').map(customToolSpec),
    // comfy-mcp：一对多动态展开（tool==='comfy_mcp' 的技能开启时注入全量 MCP 工具）
    // 未安装 venv 时 listToolSpecs 抛错——吞掉并让 LLM 走内置工具，不阻断对话
    ...(enabled.some(s => s.tool === 'comfy_mcp') && agent.comfyMcp
      ? await agent.comfyMcp.listToolSpecs().catch(() => [])
      : [])
  ]

  // 工作消息序列：system + 历史重建（assistant 工具调用与其结果严格配对）
  // token 优化：先压缩历史工具结果，再按预算裁剪
  const converted = agent.toLlmMessages(history.slice(-HISTORY_LIMIT))
  // C1：钉住目标为本轮用户指令（converted 末尾即刚推入的 user 消息），而非窗口内最旧 user
  const currentInstruction = converted[converted.length - 1]
  const working: ChatMessage[] = [
    { role: 'system', content: system },
    ...agent.trimByBudget(converted, currentInstruction)
  ]

  const signal = controller.signal

  try {
    let lastCallSig = ''
    let sameCallCount = 0
    let stopReason: string | null = null // 非空 = 达到保险上限或死循环，需总结收尾而非硬截断

    for (let round = 0; ; round++) {
      if (round >= MAX_TOOL_ROUNDS) {
        stopReason = `工具调用已达 ${MAX_TOOL_ROUNDS} 轮保险上限（防失控设计，正常任务远达不到）`
        break
      }
      // token 优化：每轮开跑前做一次预算裁剪。工具循环持续变长，早期轮次的工具
      // 结果 LLM 已消费，超预算时从最旧的消息组丢弃（配对完整性由分组保证）
      if (round > 0) {
        const trimmed = agent.trimByBudget(working.slice(1), currentInstruction)
        if (trimmed.length !== working.length - 1) {
          working.length = 1
          working.push(...trimmed)
        }
      }
      // 高推理档 + 稍高温度：导演对话需要深层规划与创意，不再压到最低档
      const reply = await agent.llm.chatCompletion(working, { tools, temperature: 0.7, signal, timeoutMs: 300000, effort: 'high' })

      if (!reply.tool_calls?.length) {
        history.push({
          id: mid(), role: 'assistant',
          content: reply.content || '（导演没有返回内容，请重试）',
          ts: Date.now()
        })
        await agent.save(scope, history)
        return history
      }

      // 死循环保险：连续多轮发起完全相同的调用（参数始终不变）大概率卡死，第 SAME_CALL_LIMIT 轮拦截
      const sig = reply.tool_calls.map(c => `${c.function.name}:${c.function.arguments}`).join('|')
      sameCallCount = sig === lastCallSig ? sameCallCount + 1 : 0
      lastCallSig = sig
      if (sameCallCount >= SAME_CALL_LIMIT - 1) {
        stopReason = `连续 ${SAME_CALL_LIMIT} 轮发起完全相同的工具调用且参数从未变化（疑似死循环）`
        break // 这条 reply 不入列、不再重复执行
      }

      // API 原始 assistant 消息直接进工作序列（保留原始 call id 与 arguments）
      working.push(reply)

      // 面板展示用的工具调用记录
      const records: ToolCallRecord[] = reply.tool_calls.map(c => ({
        id: c.id,
        name: c.function.name,
        label: agent.toolLabel(c.function.name, enabled),
        argsText: agent.prettyArgs(c.function.arguments),
        argsJson: c.function.arguments,
        status: 'running'
      }))
      const assistantMsg: ConversationMessage = {
        id: mid(), role: 'assistant',
        content: reply.content || '',
        toolCalls: records,
        ts: Date.now()
      }
      history.push(assistantMsg)
      await agent.save(scope, history)

      for (let i = 0; i < reply.tool_calls.length; i++) {
        if (signal.aborted) throw new Error('aborted')
        const call = reply.tool_calls[i]
        agent.emitTool(scope, assistantMsg.id, records[i])
        const result = await agent.executeTool(scope, call.function.name, call.function.arguments, signal)
        const updated: ToolCallRecord = {
          ...records[i],
          status: result.ok ? 'done' : 'error',
          result: result.text
        }
        assistantMsg.toolCalls![i] = updated
        agent.emitTool(scope, assistantMsg.id, updated)
        await agent.save(scope, history)
        working.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result.text.slice(0, RESULT_LIMIT)
        })
      }
    }
    // 触发保险上限/死循环时：注入系统提示让 LLM 基于已有结果总结，而不是硬截断
    if (stopReason) {
      working.push({
        role: 'user',
        content: `（系统提示：${stopReason}。请基于以上已执行的工具结果，总结当前进度、已完成与未完成事项，并给出下一步建议；不要再调用工具。）`
      })
      const final = await agent.llm.chatCompletion(working, { temperature: 0.7, signal, timeoutMs: 300000, effort: 'high' })
      history.push({
        id: mid(), role: 'assistant',
        content: final.content || '（执行中断，请查看上方工具结果；可让我继续。）',
        ts: Date.now()
      })
    }
  } catch (e) {
    if (axios.isCancel(e) || signal.aborted) {
      // C3：停止时把仍处于 running 的工具记录回填为已中断，避免面板永久转圈、
      // 历史重建时产出「工具未执行完成」的假配对
      for (const m of history) {
        if (m.role !== 'assistant' || !m.toolCalls) continue
        for (const c of m.toolCalls) {
          if (c.status === 'running') {
            c.status = 'error'
            c.result = '（本轮已停止，工具未执行完成）'
            agent.emitTool(scope, m.id, c)
          }
        }
      }
      // 用户主动停止：落一条轻提示，不按错误处理
      history.push({
        id: mid(), role: 'assistant',
        content: '（本轮操作已停止，可继续补充指令或点消息旁的回退重新来）',
        ts: Date.now()
      })
    } else {
      history.push({
        id: mid(), role: 'assistant',
        content: `出错了：${e instanceof Error ? e.message : String(e)}`,
        ts: Date.now(), error: true
      })
    }
  } finally {
    const set = agent.aborts.get(scope)
    if (set) {
      set.delete(controller)
      if (set.size === 0) agent.aborts.delete(scope)
    }
  }
  await agent.save(scope, history)
  return history
}

export function emitToolImpl(agent: ConversationService, scope: string, messageId: string, toolCall: ToolCallRecord): void {
  const e: ConversationToolEvent = { type: 'conversation:tool', scope, messageId, toolCall }
  agent.emit('tool', e)
}

export function toolLabelImpl(agent: ConversationService, name: string, skills: Skill[]): string {
  if (name.startsWith('custom_')) {
    return skills.find(s => `custom_${s.id}` === name)?.name || '自定义技能'
  }
  return skills.find(s => s.tool === name)?.name || name
}

export function prettyArgsImpl(agent: ConversationService, raw: string): string {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    return Object.entries(obj)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join('，')
  } catch {
    return raw
  }
}

/**
 * 持久化消息 → OpenAI 消息序列。
 * 含工具调用的 assistant 消息后，严格按顺序补配对的 role=tool 结果消息。
 * token 优化：工具结果是最重的上下文（单条可达 RESULT_LIMIT=12KB），逐轮原样
 * 重发是消耗主因。仅最近 FULL_TOOL_RESULTS 条保留全文，更早的截为短摘要——
 * 其内容 LLM 已消费过，关键结论沉淀在后续 assistant 回复里；需要完整数据可重调工具。
 */
export function toLlmMessagesImpl(agent: ConversationService, history: ConversationMessage[]): ChatMessage[] {
  // 先从末尾向前标记最近 N 条工具结果（全文保留）
  const fullSet = new Set<string>()
  let remaining = FULL_TOOL_RESULTS
  for (let i = history.length - 1; i >= 0 && remaining > 0; i--) {
    const m = history[i]
    if (m.role === 'assistant' && m.toolCalls?.length) {
      for (let j = m.toolCalls.length - 1; j >= 0 && remaining > 0; j--) {
        fullSet.add(`${i}:${j}`)
        remaining--
      }
    }
  }

  const out: ChatMessage[] = []
  for (let i = 0; i < history.length; i++) {
    const m = history[i]
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: m.content || '',
        tool_calls: m.toolCalls.map(c => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.argsJson || '{}' }
        }))
      })
      for (let j = 0; j < m.toolCalls.length; j++) {
        const c = m.toolCalls[j]
        const raw = (c.status === 'running' ? '工具未执行完成' : c.result) || '（无返回）'
        const content = fullSet.has(`${i}:${j}`) || raw.length <= OLD_RESULT_KEEP
          ? raw
          : `${raw.slice(0, OLD_RESULT_KEEP)}…（早期工具结果已压缩：结论见后续回复，需要完整数据请重新调用工具）`
        out.push({ role: 'tool', tool_call_id: c.id, content })
      }
    } else if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: m.content })
    }
  }
  return out
}

/** 估算单条消息字符量（content + 工具调用参数），预算裁剪用 */
export function msgChars(m: ChatMessage): number {
  let n = (m.content || '').length
  if (m.tool_calls) {
    for (const c of m.tool_calls) n += c.function.name.length + c.function.arguments.length
  }
  return n
}

/**
 * 上下文预算裁剪：总字符量超 CONTEXT_CHAR_BUDGET 时，从最旧的「消息组」开始丢弃。
 * 消息组 = assistant-with-tools 与其全部 tool 结果整体，保证不拆散 OpenAI 严格配对；
 * 最新一组无条件保留；本轮用户指令（pinTarget）钉住不丢且计入预算——长任务中裁掉
 * 任务目标会让 agent 迷失乱调工具，反而更烧 token（C1：钉本轮指令而非窗口最旧 user；
 * C2：钉住的消息占用预算额度，不再免费搭车）。
 */
export function trimByBudgetImpl(agent: ConversationService, msgs: ChatMessage[], pinTarget?: ChatMessage): ChatMessage[] {
  const total = msgs.reduce((n, m) => n + msgChars(m), 0)
  if (total <= CONTEXT_CHAR_BUDGET) return msgs

  // 从末尾向前分组
  const groups: ChatMessage[][] = []
  let i = msgs.length - 1
  while (i >= 0) {
    if (msgs[i].role === 'tool') {
      let j = i
      while (j >= 0 && msgs[j].role === 'tool') j--
      if (j >= 0 && msgs[j].tool_calls?.length) {
        groups.push(msgs.slice(j, i + 1))
        i = j - 1
      } else {
        i-- // 孤儿 tool 消息（异常场景）：直接丢弃
      }
    } else {
      groups.push([msgs[i]])
      i--
    }
  }

  // C1/C2：本轮指令所在组先从轮换中取出，作为强制保留项预先计入预算
  let pinGroup: ChatMessage[] | null = null
  if (pinTarget) {
    const idx = groups.findIndex(g => g.includes(pinTarget))
    if (idx >= 0) pinGroup = groups.splice(idx, 1)[0]
  }

  // 从最新往最旧累积，超预算即停（至少保留最新一组）
  const kept: ChatMessage[][] = []
  let acc = pinGroup ? pinGroup.reduce((n, m) => n + msgChars(m), 0) : 0
  for (const g of groups) {
    const size = g.reduce((n, m) => n + msgChars(m), 0)
    if (kept.length > 0 && acc + size > CONTEXT_CHAR_BUDGET) break
    kept.push(g)
    acc += size
  }
  const ordered = kept.reverse().flat()

  // 钉住的本轮指令置于最前（目标提醒位）：不影响其后消息的相对时序
  if (pinGroup) ordered.unshift(...pinGroup)
  return ordered
}
