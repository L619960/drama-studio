import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { freshStateImpl } from '../../src/main/core/directorStateMachine'
import { selfHealStage, withTransientRetry } from '../../src/main/core/directorStageHealing'

/**
 * C 自愈与 B 瞬时重试单测（directorStageHealing 首个 spec）：
 * 预算/诊断降级/不可自动修复不重试、可修复时消耗预算并重试、
 * 永久错误立即抛出、瞬时错误退避重试、退避期间取消立即生效。
 */
function makeRt(over: Record<string, any> = {}) {
  const rt: any = {
    states: new Map(),
    healBudget: new Map(),
    setStage: vi.fn(),
    log: vi.fn(),
    llm: { diagnoseFailure: vi.fn() },
    ...over
  }
  return rt
}

describe('selfHealStage', () => {
  it('预算耗尽或无运行状态时不诊断', async () => {
    const rt = makeRt()
    const retry = vi.fn()
    await expect(selfHealStage(rt, 'p1', 'render', '逐镜渲染', ['x'], retry)).resolves.toBe(false)
    expect(rt.llm.diagnoseFailure).not.toHaveBeenCalled()

    rt.states.set('p1', freshStateImpl(rt, 'p1', 't'))
    rt.healBudget.set('p1', 2)
    await expect(selfHealStage(rt, 'p1', 'render', '逐镜渲染', ['x'], retry)).resolves.toBe(false)
    expect(rt.llm.diagnoseFailure).not.toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
  })

  it('诊断服务异常：降级为不自愈，不消耗预算', async () => {
    const rt = makeRt()
    rt.states.set('p1', freshStateImpl(rt, 'p1', 't'))
    rt.llm.diagnoseFailure.mockRejectedValueOnce(new Error('LLM 离线'))
    const retry = vi.fn()
    await expect(selfHealStage(rt, 'p1', 'render', '逐镜渲染', ['x'], retry)).resolves.toBe(false)
    expect(rt.healBudget.get('p1')).toBeUndefined()
    expect(retry).not.toHaveBeenCalled()
  })

  it('判定不可自动修复：记录诊断与建议，不重试也不消耗预算', async () => {
    const rt = makeRt()
    rt.states.set('p1', freshStateImpl(rt, 'p1', 't'))
    rt.llm.diagnoseFailure.mockResolvedValueOnce({
      canAutoFix: false, diagnosis: '参考图缺失', suggestion: '补传参考图'
    })
    const retry = vi.fn()
    await expect(selfHealStage(rt, 'p1', 'render', '逐镜渲染', ['x'], retry)).resolves.toBe(false)
    expect(rt.states.get('p1').heal).toEqual({
      stage: 'render', diagnosis: '参考图缺失', suggestion: '补传参考图'
    })
    expect(rt.healBudget.has('p1')).toBe(false)
    expect(rt.log).toHaveBeenCalledWith('p1', 'render', 'warn', expect.stringContaining('需人工处理后重试'))
    expect(retry).not.toHaveBeenCalled()
  })

  it('可自动修复：消耗一次预算并自动重试成功', async () => {
    const rt = makeRt()
    rt.states.set('p1', freshStateImpl(rt, 'p1', 't'))
    rt.llm.diagnoseFailure.mockResolvedValueOnce({
      canAutoFix: true, diagnosis: '显存偶发不足', suggestion: '稍后重试'
    })
    const retry = vi.fn(async () => undefined)
    await expect(selfHealStage(rt, 'p1', 'render', '逐镜渲染', ['x'], retry)).resolves.toBe(true)
    expect(rt.healBudget.get('p1')).toBe(1)
    expect(retry).toHaveBeenCalledTimes(1)
    expect(rt.states.get('p1').heal.suggestion).toContain('已自动重试')
  })

  it('诊断入参只带前 5 条错误，并附镜头进度上下文', async () => {
    const rt = makeRt()
    const state = freshStateImpl(rt, 'p1', 't')
    state.totalShots = 12
    state.doneShots = 7
    rt.states.set('p1', state)
    rt.llm.diagnoseFailure.mockResolvedValueOnce({ canAutoFix: false, diagnosis: 'd', suggestion: 's' })

    await selfHealStage(rt, 'p1', 'render', '逐镜渲染', ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'], vi.fn())

    const arg = rt.llm.diagnoseFailure.mock.calls[0][0]
    expect(arg.errors).toEqual(['e1', 'e2', 'e3', 'e4', 'e5'])
    expect(arg.context).toContain('12 镜')
    expect(arg.context).toContain('7 镜')
  })

  it('自动重试再次失败：返回 false 并留错误日志', async () => {
    const rt = makeRt()
    rt.states.set('p1', freshStateImpl(rt, 'p1', 't'))
    rt.llm.diagnoseFailure.mockResolvedValueOnce({ canAutoFix: true, diagnosis: '可修', suggestion: '' })
    const retry = vi.fn(async () => { throw new Error('还是失败') })
    await expect(selfHealStage(rt, 'p1', 'render', '逐镜渲染', ['x'], retry)).resolves.toBe(false)
    expect(rt.log).toHaveBeenCalledWith('p1', 'render', 'error', expect.stringContaining('自动重试仍未成功'))
  })
})

describe('withTransientRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('一次成功不重试', async () => {
    const fn = vi.fn(async () => 'ok')
    await expect(withTransientRetry(fn)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('永久错误立即抛出，不做退避', async () => {
    const err = new Error('模型不存在')
    const fn = vi.fn(async () => { throw err })
    await expect(withTransientRetry(fn)).rejects.toBe(err)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('瞬时错误按 3s/6s 退避重试并通知进度', async () => {
    let calls = 0
    const fn = vi.fn(async () => {
      calls++
      if (calls === 1) throw new Error('ECONNRESET')
      return 'ok'
    })
    const notify = vi.fn()
    const p = withTransientRetry(fn, { notify })

    await vi.advanceTimersByTimeAsync(3200)
    await expect(p).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('3s 后自动重试（1/2）'))
  })

  it('重试耗尽后抛出最后一次错误', async () => {
    const err = new Error('status code 503')
    const fn = vi.fn(async () => { throw new Error('status code 503') })
    await expect(withTransientRetry(fn, { retries: 0 })).rejects.toBeInstanceOf(Error)
    await expect(withTransientRetry(fn, { retries: 0 })).rejects.toThrow('503')
    expect(err.message).toBe('status code 503')
  })

  it('退避等待期间取消：立即抛 CANCELLED', async () => {
    const fn = vi.fn(async () => { throw new Error('socket hang up') })
    let cancelled = false
    const p = withTransientRetry(fn, { isCancelled: () => cancelled })
    const assertion = expect(p).rejects.toThrow('CANCELLED')
    cancelled = true
    await vi.advanceTimersByTimeAsync(200)
    await assertion
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
