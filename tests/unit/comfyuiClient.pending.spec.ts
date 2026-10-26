/**
 * ComfyUIClient pending 清理单测
 *
 * 被测机制（src/main/core/comfyuiClient.ts）：
 * - waitForCompletion 把 { resolve, reject, timer, pollTimer } 登记进私有 pendingPrompts Map；
 * - settlePrompt 统一 clearTimeout(timer) + clearInterval(pollTimer) + 从 Map 删除；
 * - 结束路径三条：①timer 超时（519-522）；②disconnect() 批量 settle+reject（493-497）；
 *   ③rejectPending(message) 取消路径（373-375）。
 *
 * 测试缝（不改生产代码）：
 * - pendingPrompts/timer 是私有字段，不改生产代码观测；用公共行为断言清理效果：
 *   vi.useFakeTimers 推进时钟后，pollTimer 若残留会按 5s 间隔调 getHistory ——
 *   用 vi.spyOn(client, 'getHistory') 统计调用次数，0 调用即证明 interval 已清；
 * - promise 的 settle 次数用附着的 catch 处理器计数，重复 settle 在原生 Promise 上不可观测，
 *   这里断言「只按预期路径 reject 一次、且后续任何定时器触发不再改变 settle 次数」。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ComfyUIClient } from '../../src/main/core/comfyuiClient'

function makeClient(): ComfyUIClient {
  // 不连真实 ComfyUI：waitForCompletion 只写 Map，不需要 connect；
  // 断线路径 disconnect() 在 ws 为 null 时跳过 close，直接走 pending 清理循环。
  return new ComfyUIClient({ baseUrl: 'http://127.0.0.1:18188', clientId: 'test-client' })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ComfyUIClient pending 清理', () => {
  it('路径①超时：timer 触发后 reject，pollTimer 同时清理（之后 10s 不再轮询 history）', async () => {
    vi.useFakeTimers()
    const client = makeClient()
    const getHistorySpy = vi.spyOn(client, 'getHistory').mockResolvedValue(null)

    let settleCount = 0
    const p = client.waitForCompletion('p-timeout', () => undefined, 1000)
    p.catch(() => { settleCount++ })

    // 推进 1s：pending.timer 触发 → settlePrompt 清双定时器 + reject('timeout after 1s')
    await vi.advanceTimersByTimeAsync(1000)
    await expect(p).rejects.toThrow('timeout after 1s')
    expect(settleCount).toBe(1)
    // pollTimer 未到 5s 首触发点
    expect(getHistorySpy).not.toHaveBeenCalled()

    // 再推进 10s：pollTimer 若残留会在 5s/10s 各触发一次；spy 保持 0 即证明已 clearInterval
    await vi.advanceTimersByTimeAsync(10000)
    expect(getHistorySpy).not.toHaveBeenCalled()
    expect(settleCount).toBe(1)
  })

  it('路径②disconnect：批量 settle + reject 「ComfyUI WebSocket disconnected」，定时器清理且 Map 排空', async () => {
    vi.useFakeTimers()
    const client = makeClient()
    const getHistorySpy = vi.spyOn(client, 'getHistory').mockResolvedValue(null)
    const onProgress = vi.fn()

    let settleCount = 0
    const p = client.waitForCompletion('p-disc', onProgress, 5 * 60 * 1000)
    p.catch(() => { settleCount++ })

    // disconnect 同步走 pendingPrompts 循环：settlePrompt（清 timer/pollTimer + 删 Map）→ reject
    client.disconnect()
    await expect(p).rejects.toThrow('ComfyUI WebSocket disconnected')
    expect(settleCount).toBe(1)

    // pollTimer 若残留会在 5s 后开始轮询；spy 为 0 证明 interval 已清
    await vi.advanceTimersByTimeAsync(10000)
    expect(getHistorySpy).not.toHaveBeenCalled()

    // Map 已排空的公共行为证据：disconnect 后新登记的 pending 只被 rejectPending 影响，
    // 旧 pending 不会再以任何方式被二次触碰（settleCount 不变）
    const p2 = client.waitForCompletion('p-fresh', undefined, 5 * 60 * 1000)
    client.rejectPending('用户取消')
    await expect(p2).rejects.toThrow('用户取消')
    expect(settleCount).toBe(1)
  })

  it('路径③rejectPending：取消渲染时清理所有 pending 并带自定义消息 reject', async () => {
    vi.useFakeTimers()
    const client = makeClient()
    const getHistorySpy = vi.spyOn(client, 'getHistory').mockResolvedValue(null)

    let settleCount = 0
    const p = client.waitForCompletion('p-cancel', undefined, 5 * 60 * 1000)
    p.catch(() => { settleCount++ })

    client.rejectPending('手动取消渲染')
    await expect(p).rejects.toThrow('手动取消渲染')
    expect(settleCount).toBe(1)

    // 定时器已清：再推进 10s 无 history 轮询、无二次 settle
    await vi.advanceTimersByTimeAsync(10000)
    expect(getHistorySpy).not.toHaveBeenCalled()
    expect(settleCount).toBe(1)
  })
})
