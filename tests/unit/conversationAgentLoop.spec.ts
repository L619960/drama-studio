/**
 * conversationAgentLoop 纯函数单测（P1-3 核心模块补测）：
 * 历史→OpenAI 消息重建（工具配对/延迟压缩）、上下文预算裁剪（分组完整性 + 本轮指令钉住）、
 * 字符估算、工具标签与参数美化。doSendImpl 的实际循环不在本文件覆盖。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  toLlmMessagesImpl,
  trimByBudgetImpl,
  msgChars,
  toolLabelImpl,
  prettyArgsImpl,
} from '../../src/main/core/conversationAgentLoop'
import {
  CONTEXT_CHAR_BUDGET,
  FULL_TOOL_RESULTS,
  OLD_RESULT_KEEP,
  RESULT_LIMIT,
} from '../../src/main/core/conversationConstants'
import type { ConversationMessage, Skill } from '../../src/shared/ipcTypes'
import type { ConversationService } from '../../src/main/core/conversationService'

const agent = {} as unknown as ConversationService

describe('toLlmMessagesImpl · 历史重建与配对', () => {
  it('user / 纯文本 assistant 原样转换', () => {
    const history: ConversationMessage[] = [
      { id: '1', role: 'user', content: '开拍', ts: 1 },
      { id: '2', role: 'assistant', content: '好的', ts: 2 },
    ]
    expect(toLlmMessagesImpl(agent, history)).toEqual([
      { role: 'user', content: '开拍' },
      { role: 'assistant', content: '好的' },
    ])
  })

  it('带工具的 assistant → 每个工具调用补一条严格配对的 role=tool 消息', () => {
    const history: ConversationMessage[] = [
      {
        id: 'a',
        role: 'assistant',
        content: '',
        ts: 1,
        toolCalls: [
          {
            id: 'c1',
            name: 'get_director_status',
            label: '',
            argsJson: '{"a":1}',
            argsText: '',
            status: 'done',
            result: 'R1',
          },
          { id: 'c2', name: 'list_shots', label: '', argsJson: '', argsText: '', status: 'error', result: 'R2' },
        ],
      },
    ]
    const out = toLlmMessagesImpl(agent, history)
    expect(out[0]).toMatchObject({
      role: 'assistant',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'get_director_status', arguments: '{"a":1}' } },
        { id: 'c2', type: 'function', function: { name: 'list_shots', arguments: '{}' } },
      ],
    })
    expect(out[1]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'R1' })
    expect(out[2]).toEqual({ role: 'tool', tool_call_id: 'c2', content: 'R2' })
  })

  it('running 状态工具 → 内容替换为「工具未执行完成」（防假配对）', () => {
    const history: ConversationMessage[] = [
      {
        id: 'a',
        role: 'assistant',
        content: '',
        ts: 1,
        toolCalls: [{ id: 'c1', name: 'x', label: '', argsJson: '{}', argsText: '', status: 'running' }],
      },
    ]
    expect(toLlmMessagesImpl(agent, history)[1]?.content).toBe('工具未执行完成')
  })

  it('最近 FULL_TOOL_RESULTS 条保留全文，更早的超长结果压缩为摘要', () => {
    const long = 'x'.repeat(OLD_RESULT_KEEP + 100)
    const mk = (i: number): ConversationMessage => ({
      id: `a${i}`,
      role: 'assistant',
      content: '',
      ts: i,
      toolCalls: [{ id: `c${i}`, name: 'x', label: '', argsJson: '{}', argsText: '', status: 'done', result: long }],
    })
    const total = FULL_TOOL_RESULTS + 1
    const history = Array.from({ length: total }, (_, i) => mk(i))
    const out = toLlmMessagesImpl(agent, history)
    // 第 1 条（最旧）被压缩，最近 FULL_TOOL_RESULTS 条保持全文
    const toolMsgs = out.filter((m) => m.role === 'tool')
    expect(toolMsgs).toHaveLength(total)
    expect(toolMsgs[0]?.content).toContain('早期工具结果已压缩')
    expect(toolMsgs[1]?.content).toBe(long)
    expect(toolMsgs[toolMsgs.length - 1]?.content).toBe(long)
  })

  it('短结果即使很旧也不压缩（不值得付出摘要提示的 token 成本）', () => {
    const short = 'y'.repeat(OLD_RESULT_KEEP)
    const mk = (i: number): ConversationMessage => ({
      id: `a${i}`,
      role: 'assistant',
      content: '',
      ts: i,
      toolCalls: [{ id: `c${i}`, name: 'x', label: '', argsJson: '{}', argsText: '', status: 'done', result: short }],
    })
    const history = Array.from({ length: FULL_TOOL_RESULTS + 2 }, (_, i) => mk(i))
    const toolMsgs = toLlmMessagesImpl(agent, history).filter((m) => m.role === 'tool')
    expect(toolMsgs[0]?.content).toBe(short)
  })
})

describe('trimByBudgetImpl · 预算裁剪', () => {
  it('未超预算 → 原数组原样返回（引用不变）', () => {
    const msgs = [{ role: 'user' as const, content: 'hi' }]
    expect(trimByBudgetImpl(agent, msgs)).toBe(msgs)
  })

  it('超预算 → 丢最旧组、保留最新一组，且工具组不被拆散', () => {
    const big = 'z'.repeat(Math.ceil(CONTEXT_CHAR_BUDGET / 4))
    const msgs = [
      { role: 'user' as const, content: 'old' },
      { role: 'user' as const, content: big },
      { role: 'user' as const, content: big },
      { role: 'user' as const, content: big },
      { role: 'user' as const, content: big },
      { role: 'user' as const, content: 'latest' },
    ]
    const out = trimByBudgetImpl(agent, msgs)
    // 最旧的 'old' 被丢弃，最新消息必留
    expect(out.some((m) => m.content === 'old')).toBe(false)
    expect(out[out.length - 1]?.content).toBe('latest')
    // 保留内容总量不超过预算
    expect(out.reduce((n, m) => n + msgChars(m), 0)).toBeLessThanOrEqual(CONTEXT_CHAR_BUDGET)
  })

  it('assistant-with-tools 与其 tool 结果整体成组，不产生孤儿 tool 消息', () => {
    const big = 'q'.repeat(Math.ceil(CONTEXT_CHAR_BUDGET / 2))
    const msgs = [
      { role: 'user' as const, content: 'u1' },
      {
        role: 'assistant' as const,
        content: big,
        tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'f', arguments: '{}' } }],
      },
      { role: 'tool' as const, tool_call_id: 'c1', content: big },
      { role: 'user' as const, content: 'u2' },
    ]
    const out = trimByBudgetImpl(agent, msgs)
    // 若工具组被丢，其 tool 结果也必须一起消失（不允许孤儿）
    const hasTool = out.some((m) => m.role === 'tool')
    const hasCaller = out.some((m) => m.tool_calls?.length)
    expect(hasTool).toBe(hasCaller)
  })

  it('pinTarget（本轮用户指令）超预算时仍保留，并置于最前', () => {
    const big = 'p'.repeat(Math.ceil(CONTEXT_CHAR_BUDGET / 3))
    const pin = { role: 'user' as const, content: '本轮任务：逐镜重渲' }
    const msgs = [
      pin,
      { role: 'user' as const, content: big },
      { role: 'user' as const, content: big },
      { role: 'user' as const, content: big },
    ]
    const out = trimByBudgetImpl(agent, msgs, pin)
    expect(out[0]?.content).toBe(pin.content)
  })
})

describe('msgChars', () => {
  it('统计 content + 工具名 + 参数长度', () => {
    expect(msgChars({ role: 'user', content: 'abc' })).toBe(3)
    const withTools = {
      role: 'assistant' as const,
      content: 'ab',
      tool_calls: [{ id: 'i', type: 'function' as const, function: { name: 'fn', arguments: '{"k":1}' } }],
    }
    // 2 + 'fn'(2) + '{"k":1}'(7)
    expect(msgChars(withTools)).toBe(11)
  })
})

describe('toolLabelImpl / prettyArgsImpl', () => {
  const skills: Skill[] = [
    {
      id: 's1',
      name: '自定义技能A',
      enabled: true,
      kind: 'prompt',
      tool: 'custom_tool',
      createdAt: 0,
      description: '',
    },
    {
      id: 's2',
      name: '查询状态',
      enabled: true,
      kind: 'tool',
      tool: 'get_director_status',
      createdAt: 0,
      description: '',
    },
  ] as Skill[]

  it('custom_ 前缀 → 按 skill.id 匹配中文名；未匹配回退「自定义技能」', () => {
    expect(toolLabelImpl(agent, 'custom_s1', skills)).toBe('自定义技能A')
    expect(toolLabelImpl(agent, 'custom_unknown', skills)).toBe('自定义技能')
  })

  it('内置工具 → 技能名；未知工具名原样返回', () => {
    expect(toolLabelImpl(agent, 'get_director_status', skills)).toBe('查询状态')
    expect(toolLabelImpl(agent, 'not_a_tool', skills)).toBe('not_a_tool')
  })

  it('prettyArgs：字符串原样、对象 JSON 化、非法 JSON 回退原文', () => {
    expect(prettyArgsImpl(agent, '{"a":"x","b":2}')).toBe('a=x，b=2')
    expect(prettyArgsImpl(agent, '{bad json')).toBe('{bad json')
    expect(prettyArgsImpl(agent, '{}')).toBe('')
  })
})

describe('常量约束（与实现一致，防止静默漂移）', () => {
  it('RESULT_LIMIT 与 OLD_RESULT_KEEP 的关系合理（截断上界 ≥ 摘要阈值）', () => {
    expect(RESULT_LIMIT).toBeGreaterThan(0)
    expect(OLD_RESULT_KEEP).toBeGreaterThan(0)
    expect(RESULT_LIMIT).toBeGreaterThanOrEqual(OLD_RESULT_KEEP)
  })

  it('FULL_TOOL_RESULTS ≥ 1（至少保留最近一组全文）', () => {
    expect(FULL_TOOL_RESULTS).toBeGreaterThanOrEqual(1)
    vi.fn()
  })
})
