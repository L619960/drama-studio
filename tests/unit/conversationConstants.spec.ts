import { describe, it, expect, vi } from 'vitest'
import * as cc from '../../src/main/core/conversationConstants'

describe('conversationConstants · 常量与工具函数（2026-10-30 补 mid 函数 0% 缺口）', () => {
  it('常量导出为预期值', () => {
    expect(cc.MAX_TOOL_ROUNDS).toBe(100)
    expect(cc.SAME_CALL_LIMIT).toBe(20)
    expect(cc.HISTORY_LIMIT).toBe(80)
    expect(cc.RESULT_LIMIT).toBe(24000)
    expect(cc.FULL_TOOL_RESULTS).toBe(16)
    expect(cc.OLD_RESULT_KEEP).toBe(320)
    expect(cc.CONTEXT_CHAR_BUDGET).toBe(80000)
  })

  describe('mid：生成唯一 message id', () => {
    it('格式：m_<base36时间戳>_<5位随机>', () => {
      const id = cc.mid()
      expect(id.startsWith('m_')).toBe(true)
      expect(id.split('_').length).toBe(3)
    })

    it('每次调用返回不同值', () => {
      const ids = new Set<string>()
      for (let i = 0; i < 100; i++) ids.add(cc.mid())
      expect(ids.size).toBe(100)
    })

    it('时间戳部分与 Date.now 对齐', () => {
      vi.useFakeTimers()
      const now = 1700000000000
      vi.setSystemTime(now)
      const id = cc.mid()
      const parts = id.split('_')
      expect(parts[1]).toBe(now.toString(36))
      vi.useRealTimers()
    })
  })
})
