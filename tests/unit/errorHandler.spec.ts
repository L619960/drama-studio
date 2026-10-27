import { describe, it, expect, vi, beforeEach } from 'vitest'

// ESM 命名空间不可直接 spy，用 vi.mock 整体替换 node:fs
const appendFileSyncMock = vi.fn()
const mkdirSyncMock = vi.fn()
vi.mock('node:fs', () => ({
  appendFileSync: (...args: unknown[]) => appendFileSyncMock(...args),
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args)
}))

import { handleUnhandledRejection, handleUncaughtException, appendMainErrorLog } from '../../src/main/core/errorHandler'

describe('errorHandler 全局异常兜底', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  const fakeLogDir = '/tmp/__test_logs__'

  beforeEach(() => {
    appendFileSyncMock.mockClear()
    mkdirSyncMock.mockClear()
    mkdirSyncMock.mockImplementation(() => undefined)
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('handleUnhandledRejection：console.error 带 [unhandledRejection] 前缀，落盘日志含 kind', () => {
    const reason = new Error('promise boom')
    handleUnhandledRejection(reason, fakeLogDir)

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    const [prefix, err] = consoleErrorSpy.mock.calls[0] as [string, unknown]
    expect(prefix).toBe('[unhandledRejection]')
    expect(err).toBe(reason)

    expect(mkdirSyncMock).toHaveBeenCalledWith(fakeLogDir, { recursive: true })
    expect(appendFileSyncMock).toHaveBeenCalledTimes(1)
    const [file, line] = appendFileSyncMock.mock.calls[0] as [string, string]
    expect(file).toContain('main-error.log')
    expect(line).toContain('unhandledRejection')
    expect(line).toContain('promise boom')
  })

  it('handleUncaughtException：console.error 带 [uncaughtException] 前缀，落盘日志含 kind', () => {
    const err = new Error('sync boom')
    handleUncaughtException(err, fakeLogDir)

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    const [prefix, e] = consoleErrorSpy.mock.calls[0] as [string, unknown]
    expect(prefix).toBe('[uncaughtException]')
    expect(e).toBe(err)

    expect(appendFileSyncMock).toHaveBeenCalledTimes(1)
    const [, line] = appendFileSyncMock.mock.calls[0] as [string, string]
    expect(line).toContain('uncaughtException')
    expect(line).toContain('sync boom')
  })

  it('appendMainErrorLog：非 Error 类型 reason（字符串/对象）也能落盘不崩', () => {
    expect(() => appendMainErrorLog('unhandledRejection', 'plain string reject', fakeLogDir)).not.toThrow()
    expect(() => appendMainErrorLog('uncaughtException', { weird: 1 } as unknown, fakeLogDir)).not.toThrow()
    expect(appendFileSyncMock).toHaveBeenCalledTimes(2)
  })

  it('appendMainErrorLog：mkdir/append 抛错时静默吞掉，不二次抛出', () => {
    mkdirSyncMock.mockImplementation(() => {
      throw new Error('eacces')
    })
    expect(() => appendMainErrorLog('uncaughtException', new Error('x'), fakeLogDir)).not.toThrow()
  })
})
