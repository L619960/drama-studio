import { describe, it, expect, vi, afterEach } from 'vitest'
import { createComfyStatusWatcher } from '../../src/main/core/comfyStatusWatcher'

afterEach(() => {
  vi.useRealTimers()
})

describe('ComfyUI 连接状态轮询（REQ-15 MP-07）', () => {
  it('首次检查即回调确定状态，状态不变不重复回调', async () => {
    const onChange = vi.fn()
    let online = false
    const watcher = createComfyStatusWatcher({ check: async () => online, onChange })
    await watcher.poll()
    expect(onChange).toHaveBeenLastCalledWith(false)
    await watcher.poll()
    expect(onChange).toHaveBeenCalledTimes(1)
    online = true
    await watcher.poll()
    expect(onChange).toHaveBeenLastCalledWith(true)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('健康检查抛错按离线处理，并在恢复时触发翻转', async () => {
    const onChange = vi.fn()
    let shouldThrow = true
    const watcher = createComfyStatusWatcher({
      check: async () => {
        if (shouldThrow) throw new Error('ECONNREFUSED')
        return true
      },
      onChange,
    })
    await watcher.poll()
    expect(onChange).toHaveBeenLastCalledWith(false)
    shouldThrow = false
    await watcher.poll()
    expect(onChange).toHaveBeenLastCalledWith(true)
  })

  it('并发轮询时跳过重复检查', async () => {
    const onChange = vi.fn()
    let resolveCheck: (v: boolean) => void = () => {}
    const watcher = createComfyStatusWatcher({
      check: () =>
        new Promise<boolean>((resolve) => {
          resolveCheck = resolve
        }),
      onChange,
    })
    const first = watcher.poll()
    await watcher.poll()
    expect(onChange).not.toHaveBeenCalled()
    resolveCheck?.(true)
    await first
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('start 立即轮询并定时检查，stop 后不再触发', async () => {
    vi.useFakeTimers()
    const onChange = vi.fn()
    let online = true
    const watcher = createComfyStatusWatcher({
      check: async () => online,
      onChange,
      intervalMs: 1000,
    })
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(onChange).toHaveBeenCalledWith(true)
    online = false
    await vi.advanceTimersByTimeAsync(1000)
    expect(onChange).toHaveBeenLastCalledWith(false)
    watcher.stop()
    online = true
    await vi.advanceTimersByTimeAsync(3000)
    expect(onChange).toHaveBeenCalledTimes(2)
  })
})
