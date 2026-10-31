import { describe, it, expect, vi, afterEach } from 'vitest'
import { createUndoWindow } from '../../src/shared/undoWindow'

afterEach(() => {
  vi.useRealTimers()
})

describe('删除后悔窗口（REQ-16）', () => {
  it('窗口内未操作：超时后执行提交，且只执行一次', async () => {
    vi.useFakeTimers()
    const onUndo = vi.fn()
    const onCommit = vi.fn()
    createUndoWindow({ onUndo, onCommit }, 5000)
    expect(onCommit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onUndo).not.toHaveBeenCalled()
  })

  it('点撤销：执行恢复，超时后不再提交', async () => {
    vi.useFakeTimers()
    const onUndo = vi.fn()
    const onCommit = vi.fn()
    const handle = createUndoWindow({ onUndo, onCommit }, 5000)
    await handle.undo()
    expect(onUndo).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(6000)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('手动关闭 toast：立即提交（不等超时）', async () => {
    vi.useFakeTimers()
    const onUndo = vi.fn()
    const onCommit = vi.fn()
    const handle = createUndoWindow({ onUndo, onCommit }, 5000)
    await handle.close()
    expect(onCommit).toHaveBeenCalledTimes(1)
    await handle.undo()
    await vi.advanceTimersByTimeAsync(6000)
    expect(onUndo).not.toHaveBeenCalled()
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('dispose 后既不撤销也不提交', async () => {
    vi.useFakeTimers()
    const onUndo = vi.fn()
    const onCommit = vi.fn()
    const handle = createUndoWindow({ onUndo, onCommit }, 5000)
    handle.dispose()
    await vi.advanceTimersByTimeAsync(6000)
    expect(onUndo).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
  })
})
