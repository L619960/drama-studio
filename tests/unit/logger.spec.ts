import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createLogger } from '../../src/main/core/logger'

/**
 * 主进程日志器单测（logger 首个 spec）：
 * scope 前缀、时间戳格式、分级落到对应 console 方法、附加参数透传。
 */
describe('createLogger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('info/warn/error 分别写入对应 console 方法', () => {
    const log = createLogger('ComfyUI')
    log.info('a')
    log.warn('b')
    log.error('c')

    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('输出形如「hh:mm:ss.SSS [scope] msg」并透传附加参数', () => {
    const log = createLogger('Render')
    log.info('started', { shot: 1 }, 'extra')

    const [line, ...rest] = logSpy.mock.calls[0]
    expect(String(line)).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} \[Render\] started$/)
    expect(rest).toEqual([{ shot: 1 }, 'extra'])
  })

  it('不同 scope 互不影响前缀', () => {
    createLogger('A').info('x')
    createLogger('B').warn('y')
    expect(String(logSpy.mock.calls[0][0])).toContain('[A] x')
    expect(String(warnSpy.mock.calls[0][0])).toContain('[B] y')
  })
})
