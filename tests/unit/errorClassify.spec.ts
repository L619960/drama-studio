import { describe, it, expect } from 'vitest'
import { isTransientError, isOomError, classifyError } from '../../src/main/core/errorClassify'

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

describe('errorClassify.classifyError', () => {
  it('OOM 优先归为 oom', () => {
    expect(classifyError(new Error('CUDA out of memory'))).toBe('oom')
    expect(classifyError('显存不足')).toBe('oom')
  })

  it('网络/超时归为 transient', () => {
    expect(classifyError(new Error('socket hang up'))).toBe('transient')
    expect(classifyError(new Error('Request failed with status code 503'))).toBe('transient')
  })

  it('缺模型/参数类归为 permanent', () => {
    expect(classifyError(new Error('model not found'))).toBe('permanent')
    expect(classifyError(new Error('缺少模型：wan2.2'))).toBe('permanent')
    expect(classifyError(new Error('内容安全拦截'))).toBe('permanent')
  })

  it('未识别原因归为 unknown', () => {
    expect(classifyError(new Error('unexpected render failure'))).toBe('unknown')
  })
})

