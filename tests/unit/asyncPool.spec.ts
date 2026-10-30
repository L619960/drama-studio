import { describe, it, expect, vi } from 'vitest'
import { mapPool } from '../../src/main/core/asyncPool'

describe('mapPool 有限并发映射', () => {
  it('空数组直接返回空结果', async () => {
    const out = await mapPool<number, number>([], 3, async (x) => x * 2)
    expect(out).toEqual([])
  })

  it('concurrency=1 时顺序执行', async () => {
    const order: number[] = []
    await mapPool([1, 2, 3], 1, async (x) => {
      order.push(x)
      return x * 10
    })
    expect(order).toEqual([1, 2, 3])
  })

  it('并发数上限不超过数组长度', async () => {
    let running = 0
    let peak = 0
    const items = Array.from({ length: 20 }, (_, i) => i)
    await mapPool(items, 100, async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise(r => setTimeout(r, 5))
      running--
    })
    // 数组只有 20 项，实际并发数应被钳到 20
    expect(peak).toBe(20)
  })

  it('结果按原始索引返回（非执行顺序）', async () => {
    const items = [3, 1, 2]
    const out = await mapPool(items, 3, async (x) => {
      // 慢的先返回
      const delay = (4 - x) * 10
      await new Promise(r => setTimeout(r, delay))
      return x * 2
    })
    expect(out).toEqual([6, 2, 4])
  })

  it('item 处理失败时抛出错误', async () => {
    await expect(mapPool([1, 2, 3], 2, async (x) => {
      if (x === 2) throw new Error('boom')
      return x
    })).rejects.toThrow('boom')
  })

  it('shouldAbort 在 worker 中被检查，命中后抛出 abortError', async () => {
    const abort = { flag: false }
    const fn = vi.fn(async () => {
      // 让第三个 worker 拿到任务前 abort 已触发
      await new Promise(r => setTimeout(r, 5))
      return 1
    })
    const promise = mapPool(
      Array.from({ length: 10 }, () => 1),
      4,
      fn,
      { shouldAbort: () => abort.flag, abortError: new Error('CANCELLED') }
    )
    abort.flag = true
    await expect(promise).rejects.toThrow('CANCELLED')
  })

  it('并发数最小钳为 1（传 0 或负数时）', async () => {
    const out = await mapPool([1, 2, 3], 0, async (x) => x * 2)
    expect(out).toEqual([2, 4, 6])
    const out2 = await mapPool([1, 2, 3], -5, async (x) => x + 1)
    expect(out2).toEqual([2, 3, 4])
  })
})
