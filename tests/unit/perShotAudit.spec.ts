/**
 * 逐镜审核暂停门禁单测（LOGIC-P0-03）：
 * 渲染完成汇总后——
 * - 软提示（auditHint，技术快审未过但不阻断）> 0 只留痕，不暂停、继续进剪辑；
 * - 硬失败（渲染失败镜）> 0 才暂停流水线等用户整改；
 * - 两者都为 0 正常进剪辑。
 * directorAgent 用 shouldPauseAfterAudit(hintCount, failCount) 做同一判定。
 */
import { describe, it, expect } from 'vitest'
import { shouldPauseAfterAudit } from '../../src/shared/pipelineGuards'

describe('shouldPauseAfterAudit（软提示不暂停，硬失败才暂停）', () => {
  it('hintCount>0, failCount=0 → 不暂停（放行进剪辑）', () => {
    expect(shouldPauseAfterAudit(3, 0)).toBe(false)
    expect(shouldPauseAfterAudit(1, 0)).toBe(false)
  })

  it('failCount>0 → 暂停（无论软提示多少）', () => {
    expect(shouldPauseAfterAudit(0, 1)).toBe(true)
    expect(shouldPauseAfterAudit(5, 2)).toBe(true)
    expect(shouldPauseAfterAudit(10, 1)).toBe(true)
  })

  it('都为 0 → 不暂停', () => {
    expect(shouldPauseAfterAudit(0, 0)).toBe(false)
  })

  it('负数入参按 0 处理，不误暂停', () => {
    expect(shouldPauseAfterAudit(-1, 0)).toBe(false)
  })
})
