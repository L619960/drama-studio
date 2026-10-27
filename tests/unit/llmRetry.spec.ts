/**
 * llmService.chat 重试单测：429/5xx 瞬时错误重试 2 次（共 3 次尝试），指数退避；
 * 400/422（不支持 thinking 参数）走去参数兜底，不参与 429/5xx 重试计数。
 * axios 整体 mock，不起网络。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const axiosPost = vi.hoisted(() => vi.fn())

vi.mock('axios', () => ({
  default: { post: (...args: unknown[]) => axiosPost(...args) }
}))

import { LLMService } from '../../src/main/core/llmService'

function makeService(): LLMService {
  return new LLMService(
    async () => ({
      llm: { apiKey: 'test-key', baseUrl: 'https://api.example.com', model: 'test-model' }
    } as never),
    []
  )
}

function httpError(status: number): Error & { response: { status: number } } {
  const e = new Error(`Request failed: ${status}`) as Error & { response: { status: number } }
  e.response = { status }
  return e
}

function okResponse(content = 'ok') {
  return { data: { choices: [{ message: { content } }] } }
}

describe('llmService.chat 429/5xx 重试', () => {
  beforeEach(() => {
    axiosPost.mockReset()
  })

  it('429 重试两次后成功：共调用 3 次，最终返回内容', async () => {
    axiosPost
      .mockRejectedValueOnce(httpError(429))
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValueOnce(okResponse('hello'))

    const svc = makeService()
    const out = await svc.test()
    expect(axiosPost).toHaveBeenCalledTimes(3)
    expect(out).toBe('test-model')
  })

  it('500 持续失败：重试满 3 次后抛出', async () => {
    axiosPost.mockRejectedValue(httpError(500))
    const svc = makeService()
    await expect(svc.test()).rejects.toThrow(/LLM 请求失败/)
    expect(axiosPost).toHaveBeenCalledTimes(3)
  })

  it('502 重试一次后成功：共调用 2 次', async () => {
    axiosPost
      .mockRejectedValueOnce(httpError(502))
      .mockResolvedValueOnce(okResponse('fine'))
    const svc = makeService()
    await svc.test()
    expect(axiosPost).toHaveBeenCalledTimes(2)
  })

  it('400（不支持 thinking 参数）走去参数兜底，不按 429 重试计数', async () => {
    axiosPost
      .mockRejectedValueOnce(httpError(400))
      .mockResolvedValueOnce(okResponse('fallback-ok'))
    const svc = makeService()
    const out = await svc.test()
    expect(out).toBe('test-model')
    // 第一次（带 thinking）被拒 → 第二次去 thinking 成功：共 2 次，不进 429 重试分支
    expect(axiosPost).toHaveBeenCalledTimes(2)
    const fallbackBody = axiosPost.mock.calls[1][1] as Record<string, unknown>
    expect(fallbackBody.thinking).toBeUndefined()
    expect(fallbackBody.model).toBe('test-model')
  })
})
