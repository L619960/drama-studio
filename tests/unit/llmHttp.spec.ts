/**
 * llmHttp HTTP client 层单测（P1-3 核心模块补测）：
 * mock axios / logger / llmRequest / node:fs，不发真实网络请求，覆盖
 * 请求体构建、400/422 thinking·effort 回退、429/5xx 重试、空响应、AbortSignal 透传。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const post = vi.fn()

vi.mock('axios', () => ({ default: { post: (...a: unknown[]) => post(...a) } }))
vi.mock('../../src/main/core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
vi.mock('../../src/main/core/llmRequest', () => ({
  logLlmError: vi.fn(() => 'boom')
}))
vi.mock('node:fs', () => {
  const m = { mkdirSync: vi.fn(), writeFileSync: vi.fn() }
  return { ...m, default: m }
})

import { httpChat, httpChatCompletion, httpChatRaw, httpTest } from '../../src/main/core/llmHttp'
import type { AppSettings } from '../../src/shared/ipcTypes'

const SETTINGS = {
  llm: { apiKey: 'sk-test', baseUrl: 'https://api.test///', model: 'test-model' }
} as unknown as AppSettings
const getSettings = async (): Promise<AppSettings> => SETTINGS

const okResp = (content = 'ok') => ({ data: { choices: [{ message: { content } }] } })

beforeEach(() => {
  post.mockReset()
})

describe('httpChatCompletion · 请求体与回退', () => {
  it('缺 API Key → 直接报错，不发请求', async () => {
    const noKey = async (): Promise<AppSettings> => ({ llm: { apiKey: '', baseUrl: '', model: '' } } as unknown as AppSettings)
    await expect(httpChatCompletion(noKey, [])).rejects.toThrow(/API Key/)
    expect(post).not.toHaveBeenCalled()
  })

  it('body 构建：tools → tool_choice=auto、effort 透传、contentParts 转 content 数组、baseUrl 去掉尾斜杠', async () => {
    post.mockResolvedValueOnce(okResp())
    await httpChatCompletion(getSettings, [
      { role: 'user', content: '看图', contentParts: [{ type: 'text', text: 'hi' }] }
    ], { temperature: 0.9, tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: {} } }], effort: 'high' })
    expect(post).toHaveBeenCalledTimes(1)
    const [url, body] = post.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe('https://api.test/chat/completions')
    expect(body).toMatchObject({ model: 'test-model', temperature: 0.9, tool_choice: 'auto', effort: 'high' })
    expect((body.messages as Array<Record<string, unknown>>)[0].content).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('provider 拒绝 effort/thinking（400）→ 去掉参数重试一次并成功', async () => {
    post
      .mockRejectedValueOnce({ response: { status: 400 } })
      .mockResolvedValueOnce(okResp('fallback-ok'))
    const r = await httpChatCompletion(getSettings, [{ role: 'user', content: 'x' }], { effort: 'high' })
    expect(r.content).toBe('fallback-ok')
    expect(post).toHaveBeenCalledTimes(2)
    const secondBody = post.mock.calls[1][1] as Record<string, unknown>
    expect(secondBody.effort).toBeUndefined()
    expect(secondBody.thinking).toBeUndefined()
  })

  it('非 400/422 错误 → 原样抛出', async () => {
    post.mockRejectedValueOnce({ response: { status: 500 } })
    await expect(httpChatCompletion(getSettings, [{ role: 'user', content: 'x' }])).rejects.toBeTruthy()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('响应缺 message → 抛「LLM 返回为空」', async () => {
    post.mockResolvedValueOnce({ data: { choices: [{ message: undefined }] } })
    await expect(httpChatCompletion(getSettings, [{ role: 'user', content: 'x' }])).rejects.toThrow('LLM 返回为空')
  })

  it('signal 透传给 axios（对话停止按钮可中断）', async () => {
    post.mockResolvedValueOnce(okResp())
    const ac = new AbortController()
    await httpChatCompletion(getSettings, [{ role: 'user', content: 'x' }], { signal: ac.signal })
    expect((post.mock.calls[0][2] as { signal?: AbortSignal }).signal).toBe(ac.signal)
  })
})

describe('httpChat · 重试 / 空响应 / signal', () => {
  it('429 → 退避后重试成功（共 2 次请求）', async () => {
    post
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockResolvedValueOnce(okResp('retried'))
    await expect(httpChat(getSettings, 'sys', 'user')).resolves.toBe('retried')
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('400 → 去掉 thinking 回退重试（不回退 429 逻辑）', async () => {
    post
      .mockRejectedValueOnce({ response: { status: 400 } })
      .mockResolvedValueOnce(okResp('no-thinking'))
    const r = await httpChat(getSettings, 'sys', 'user')
    expect(r).toBe('no-thinking')
    const secondBody = post.mock.calls[1][1] as Record<string, unknown>
    expect(secondBody.thinking).toBeUndefined()
    expect(secondBody.max_tokens).toBe(16384)
  })

  it('连续可重试错误耗尽 3 次 → 抛「LLM 请求失败」', async () => {
    post.mockRejectedValue({ response: { status: 503 } })
    await expect(httpChat(getSettings, 'sys', 'user')).rejects.toThrow(/LLM 请求失败/)
    expect(post).toHaveBeenCalledTimes(3)
  })

  it('空 content → 抛「LLM 返回为空」并落盘诊断', async () => {
    post.mockResolvedValueOnce({ data: { choices: [{ message: { content: '   ' } }], usage: {} } })
    await expect(httpChat(getSettings, 'sys', 'user')).rejects.toThrow('LLM 返回为空')
  })

  it('P1-2：signal 透传给 axios options', async () => {
    post.mockResolvedValueOnce(okResp())
    const ac = new AbortController()
    await httpChat(getSettings, 'sys', 'user', 0.7, 60000, 1024, ac.signal)
    expect((post.mock.calls[0][2] as { signal?: AbortSignal }).signal).toBe(ac.signal)
    // 自定义 maxTokens 生效
    expect((post.mock.calls[0][1] as Record<string, unknown>).max_tokens).toBe(1024)
  })
})

describe('httpChatRaw / httpTest', () => {
  it('httpChatRaw：直接提交完整 body，返回 trim 后的内容', async () => {
    post.mockResolvedValueOnce(okResp('  raw-content  '))
    await expect(httpChatRaw(getSettings, { model: 'm', messages: [] })).resolves.toBe('raw-content')
    expect(post.mock.calls[0][1]).toEqual({ model: 'm', messages: [] })
  })

  it('httpChatRaw：空内容抛「LLM 返回为空」', async () => {
    post.mockResolvedValueOnce({ data: { choices: [] } })
    await expect(httpChatRaw(getSettings, { messages: [] })).rejects.toThrow('LLM 返回为空')
  })

  it('httpTest：探针成功返回模型名', async () => {
    post.mockResolvedValueOnce(okResp())
    await expect(httpTest(getSettings)).resolves.toBe('test-model')
  })
})
