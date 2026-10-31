import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as nodeFs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createLogger, initFileLogger, setLogLevel } from '../../src/main/core/logger'

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

describe('P2-1 级别过滤与文件落盘', () => {
  it('debug 默认被过滤，setLogLevel(debug) 后输出', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const log = createLogger('Level')
    setLogLevel('info')
    log.debug('hidden')
    expect(spy).not.toHaveBeenCalled()
    setLogLevel('debug')
    log.debug('visible')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0][0])).toContain('[Level] visible')
    setLogLevel('info')
    spy.mockRestore()
  })

  it('initFileLogger 后日志批量落盘 main.log（含级别）', async () => {
    const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'drama-log-'))
    initFileLogger(dir)
    createLogger('File').info('hello', { shot: 1 })
    await new Promise(r => setTimeout(r, 450))
    const content = nodeFs.readFileSync(path.join(dir, 'main.log'), 'utf-8')
    expect(content).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3} INFO \[File\] hello \{"shot":1\}/)
    nodeFs.rmSync(dir, { recursive: true, force: true })
  })
})
