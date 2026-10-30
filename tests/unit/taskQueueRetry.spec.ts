import { describe, it, expect } from 'vitest'
import { decideRetryAction, type RetryInput } from '../../src/main/core/taskQueueRetry'

function baseInput(overrides: Partial<RetryInput> = {}): RetryInput {
  return {
    err: new Error('fail'),
    cancelled: false,
    isOOM: false,
    oomRetryEnabled: true,
    oomDowngraded: false,
    resDowngraded: false,
    canStepDownTier: true,
    mode: 'h3-r2v',
    lipMode: 'auto',
    lipSyncEnabled: true,
    transientRetries: 0,
    isTransient: false,
    ...overrides
  }
}

describe('taskQueueRetry.decideRetryAction', () => {
  it('cancelled → cancel', () => {
    expect(decideRetryAction(baseInput({ cancelled: true }))).toEqual({ kind: 'cancel' })
  })

  it('OOM 首次 → oom-light', () => {
    expect(decideRetryAction(baseInput({ isOOM: true }))).toEqual({ kind: 'oom-light' })
  })

  it('OOM 已减负未换档且 canStepDownTier → oom-tier', () => {
    expect(decideRetryAction(baseInput({ isOOM: true, oomDowngraded: true }))).toEqual({ kind: 'oom-tier' })
  })

  it('OOM 减负完成但不能再换档 → 跳过 OOM 分支（isOOM 所以 r2v-fallback 也恒 false）→ give-up', () => {
    expect(decideRetryAction(baseInput({
      isOOM: true, oomDowngraded: true, resDowngraded: true, canStepDownTier: false
    }))).toEqual({ kind: 'give-up' })
  })

  it('OOM 已全部做完但还有一次档位（resDowngraded=false, canStepDownTier=false）→ 也是 give-up', () => {
    expect(decideRetryAction(baseInput({
      isOOM: true, oomDowngraded: true, resDowngraded: true, canStepDownTier: false
    }))).toEqual({ kind: 'give-up' })
  })

  it('OOM retry 禁用时不走 OOM 分支', () => {
    expect(decideRetryAction(baseInput({
      isOOM: true, oomRetryEnabled: false, isTransient: true, transientRetries: 1
    }))).toEqual({ kind: 'transient' })
  })

  it('r2v-fallback 条件命中（非 OOM / h3-r2v / lipMode=auto / lipSyncEnabled）→ r2v-fallback', () => {
    expect(decideRetryAction(baseInput({ isOOM: false }))).toEqual({ kind: 'r2v-fallback' })
  })

  it('r2v-fallback 非 auto 模式 → 不命中 → transient', () => {
    expect(decideRetryAction(baseInput({
      isOOM: false, lipMode: 'latentsync', isTransient: true, transientRetries: 1
    }))).toEqual({ kind: 'transient' })
  })

  it('transient 错误且 retry < 2 → transient（在 r2v-fallback 不命中之后）', () => {
    // 默认 mode='h3-r2v' + lipMode='auto' + lipSyncEnabled=true → r2v-fallback 先命中
    // 把这些关掉才能走到 transient 分支
    expect(decideRetryAction(baseInput({
      isTransient: true, transientRetries: 0,
      lipSyncEnabled: false, mode: 'wan'
    }))).toEqual({ kind: 'transient' })
    expect(decideRetryAction(baseInput({
      isTransient: true, transientRetries: 1,
      lipSyncEnabled: false, mode: 'wan'
    }))).toEqual({ kind: 'transient' })
  })

  it('transient 错误但 retry 已用满 2 次 → give-up', () => {
    expect(decideRetryAction(baseInput({
      isTransient: true, transientRetries: 2,
      lipSyncEnabled: false, mode: 'wan'
    }))).toEqual({ kind: 'give-up' })
    expect(decideRetryAction(baseInput({
      isTransient: true, transientRetries: 5,
      lipSyncEnabled: false, mode: 'wan'
    }))).toEqual({ kind: 'give-up' })
  })

  it('全部条件不命中 → give-up', () => {
    expect(decideRetryAction(baseInput({
      isOOM: false, isTransient: false, mode: 'wan'
    }))).toEqual({ kind: 'give-up' })
  })

  it('lipSync 关闭时 r2v-fallback 条件不命中', () => {
    expect(decideRetryAction(baseInput({
      isOOM: false, lipSyncEnabled: false, isTransient: true, transientRetries: 1
    }))).toEqual({ kind: 'transient' })
  })

  it('非 h3 模式下 r2v-fallback 不触发', () => {
    expect(decideRetryAction(baseInput({
      isOOM: false, mode: 'wan', isTransient: true, transientRetries: 1
    }))).toEqual({ kind: 'transient' })
  })
})
