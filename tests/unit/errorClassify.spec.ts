import { describe, it, expect } from 'vitest'
import { isTransientError, isOomError } from '../../src/main/core/errorClassify'

describe('errorClassify.isTransientError', () => {
  it('识别 axios 超时 / 网络层瞬态错误', () => {
    expect(isTransientError(new Error('timeout of 60000ms exceeded'))).toBe(true)
    expect(isTransientError(new Error('ETIMEDOUT'))).toBe(true)
    expect(isTransientError(new Error('ECONNREFUSED'))).toBe(true)
    expect(isTransientError(new Error('socket hang up'))).toBe(true)
    expect(isTransientError(new Error('connection closed'))).toBe(true)
    expect(isTransientError('fetch failed')).toBe(true)
  })

  it('识别 HTTP 限流与服务端错误', () => {
    expect(isTransientError(new Error('Request failed with status code 429'))).toBe(true)
    expect(isTransientError(new Error('Request failed with status code 408'))).toBe(true)
    expect(isTransientError(new Error('Request failed with status code 503'))).toBe(true)
  })

  it('识别服务繁忙与中文瞬态提示', () => {
    expect(isTransientError(new Error('服务繁忙，请稍后重试'))).toBe(true)
    expect(isTransientError('请求超时')).toBe(true)
    expect(isTransientError('连接被重置')).toBe(true)
  })

  it('永久性错误不得误判为瞬态', () => {
    expect(isTransientError(new Error('model not found'))).toBe(false)
    expect(isTransientError(new Error('Prompt is not valid'))).toBe(false)
    expect(isTransientError(new Error('内容安全拦截'))).toBe(false)
  })
})

describe('errorClassify.isOomError', () => {
  it('识别显存/OOM', () => {
    expect(isOomError(new Error('CUDA out of memory'))).toBe(true)
    expect(isOomError(new Error('OutOfMemoryError'))).toBe(true)
    expect(isOomError(new Error('failed to allocate memory'))).toBe(true)
    expect(isOomError(new Error('显存不足'))).toBe(true)
  })

  it('网络错误不算 OOM', () => {
    expect(isOomError(new Error('socket hang up'))).toBe(false)
    expect(isOomError(new Error('timeout of 60000ms exceeded'))).toBe(false)
  })
})
