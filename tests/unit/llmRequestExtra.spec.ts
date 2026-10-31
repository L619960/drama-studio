/**
 * llmRequest 补充覆盖（2026-10-30）：logLlmError/llmBaseUrl 已由 llmRequest.spec.ts 覆盖，
 * 本文件专测 postChatCompletion（mock axios，不发真实请求）与 LLM_DUMP_DIR。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('axios', () => ({ default: { post: vi.fn() } }))

import axios from 'axios'
import path from 'node:path'
import type { AppSettings } from '../../src/shared/ipcTypes'
import { postChatCompletion, LLM_DUMP_DIR } from '../../src/main/core/llmRequest'

const post = axios.post as unknown as ReturnType<typeof vi.fn>

const settings = { llm: { baseUrl: 'https://api.test.com/', apiKey: 'sk-test' } } as unknown as AppSettings

const httpErr = (status: number) => ({ response: { status }, message: `HTTP ${status}` })

describe('postChatCompletion · 统一 POST 与 400/422 回退', () => {
  beforeEach(() => {
    post.mockReset()
  })

  it('成功 → 拼接去斜杠 URL、Bearer 头、默认 180s 超时，原样返回响应', async () => {
    const resp = { data: { choices: [] } }
    post.mockResolvedValue(resp)
    const body = { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }
    const out = await postChatCompletion(settings, body)
    expect(out).toBe(resp)
    expect(post).toHaveBeenCalledTimes(1)
    const call = post.mock.calls[0]
    if (!call) throw new Error('测试夹具缺少 post.mock.calls[0]')
    const [url, sentBody, cfg] = call
    expect(url).toBe('https://api.test.com/chat/completions')
    expect(sentBody).toBe(body)
    expect(cfg.headers).toEqual({ Authorization: 'Bearer sk-test' })
    expect(cfg.timeout).toBe(180000)
    expect(cfg.signal).toBeUndefined()
  })

  it('自定义 timeoutMs 与 signal 透传', async () => {
    post.mockResolvedValue({ data: {} })
    const ac = new AbortController()
    await postChatCompletion(settings, {}, { timeoutMs: 5000, signal: ac.signal })
    expect(post.mock.calls[0]?.[2]).toMatchObject({ timeout: 5000, signal: ac.signal })
  })

  it('400 + dropOn422 → 丢弃 thinking/effort 重试一次并成功', async () => {
    post.mockRejectedValueOnce(httpErr(400)).mockResolvedValueOnce({ data: { ok: 1 } })
    const body = { model: 'm', thinking: { type: 'enabled' }, effort: 'high', temperature: 0.7 }
    const out = await postChatCompletion(settings, body, { dropOn422: ['thinking', 'effort'] })
    expect(out.data).toEqual({ ok: 1 })
    expect(post).toHaveBeenCalledTimes(2)
    const retryBody = post.mock.calls[1]?.[1]
    expect(retryBody.thinking).toBeUndefined()
    expect(retryBody.effort).toBeUndefined()
    expect(retryBody.temperature).toBe(0.7)
    expect(retryBody).not.toBe(body) // 不改原 body
  })

  it('422 + dropOn422=["thinking"] → 仅丢 thinking', async () => {
    post.mockRejectedValueOnce(httpErr(422)).mockResolvedValueOnce({ data: { ok: 2 } })
    await postChatCompletion(settings, { thinking: 1, effort: 2 }, { dropOn422: ['thinking'] })
    const retryBody = post.mock.calls[1]?.[1]
    expect(retryBody.thinking).toBeUndefined()
    expect(retryBody.effort).toBe(2)
  })

  it('400 无 dropOn422 → 原样抛出，不重试', async () => {
    const err = httpErr(400)
    post.mockRejectedValue(err)
    await expect(postChatCompletion(settings, { a: 1 })).rejects.toBe(err)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('400 + dropOn422 空数组 → 不触发回退，原样抛出', async () => {
    const err = httpErr(400)
    post.mockRejectedValue(err)
    await expect(postChatCompletion(settings, {}, { dropOn422: [] })).rejects.toBe(err)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('非 400/422（500）+ dropOn422 → 仍原样抛出', async () => {
    const err = httpErr(500)
    post.mockRejectedValue(err)
    await expect(postChatCompletion(settings, { thinking: 1 }, { dropOn422: ['thinking'] })).rejects.toBe(err)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('重试仍失败 → 抛出重试的错误', async () => {
    const err1 = httpErr(400)
    const err2 = httpErr(401)
    post.mockRejectedValueOnce(err1).mockRejectedValueOnce(err2)
    await expect(postChatCompletion(settings, { thinking: 1 }, { dropOn422: ['thinking'] })).rejects.toBe(err2)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('错误无 response.status（网络层错误）→ 原样抛出', async () => {
    const err = new Error('socket hang up')
    post.mockRejectedValue(err)
    await expect(postChatCompletion(settings, {})).rejects.toBe(err)
  })
})

describe('LLM_DUMP_DIR 常量', () => {
  it('指向 drama-studio/tmp 目录（单重嵌套）', () => {
    // 只校验紧邻的两级目录名：仓库/工作目录本身可能就叫 drama-studio（CI 路径为 .../drama-studio/drama-studio）
    expect(path.basename(LLM_DUMP_DIR)).toBe('tmp')
    expect(path.basename(path.dirname(LLM_DUMP_DIR))).toBe('drama-studio')
  })
})
