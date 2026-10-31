import { describe, it, expect } from 'vitest'
import { errorKindHint, retryBadge, isCancelReject, ERROR_KIND_TEXT } from '../../src/renderer/src/utils/errorGuide'
import type { ErrorKind } from '../../src/shared/ipcTypes'

describe('errorGuide.errorKindHint', () => {
  it('按失败分层给出差异化引导', () => {
    expect(errorKindHint('oom')).toContain('显存')
    expect(errorKindHint('transient')).toContain('重试')
    expect(errorKindHint('permanent')).toContain('提示词')
    expect(errorKindHint('unknown')).toContain('完整错误')
  })

  it('未携带分层时返回空串', () => {
    expect(errorKindHint(undefined)).toBe('')
  })

  it('分层文案表覆盖全部取值', () => {
    const kinds: ErrorKind[] = ['transient', 'oom', 'permanent', 'unknown']
    for (const k of kinds) expect(ERROR_KIND_TEXT[k]).toBeTruthy()
  })
})

describe('errorGuide.retryBadge', () => {
  it('展示已自动降档重试次数与预算', () => {
    expect(retryBadge({ retryCount: 1 })).toBe('已自动降档重试 1/2')
    expect(retryBadge({ retryCount: 2, retryBudget: 3 })).toBe('已自动降档重试 2/3')
  })

  it('未发生自动重试时不展示', () => {
    expect(retryBadge({})).toBe('')
    expect(retryBadge({ retryCount: 0 })).toBe('')
  })
})

describe('errorGuide.isCancelReject', () => {
  it('文件选择取消哨兵不回弹操作失败', () => {
    expect(isCancelReject('User cancelled')).toBe(true)
    expect(isCancelReject('__CANCELLED__')).toBe(true)
    expect(isCancelReject('cancelled')).toBe(true)
    expect(isCancelReject('Canceled')).toBe(true)
    expect(isCancelReject('已取消')).toBe(true)
    expect(isCancelReject('用户取消')).toBe(true)
  })

  it('真实错误不被吞掉', () => {
    expect(isCancelReject('渲染失败：缺模型')).toBe(false)
    expect(isCancelReject('cannot cancel')).toBe(false)
    expect(isCancelReject('')).toBe(false)
  })
})
