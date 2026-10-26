import { describe, expect, it } from 'vitest'
import { CROSS_SOURCE, SLANG_RE } from '../../src/shared/promptAuditRules'
import { reviewedIsValid } from '../../src/shared/pipelineGuards'

const cross = new RegExp(CROSS_SOURCE, 'gi')

describe('串台拦截词表（2026-10-25 单源化后的验证）', () => {
  it('跨项目/跨剧情残留词全部命中（Marcus/Lin/barber/scissor 等）', () => {
    const poisoned = [
      'the same Lin Chuan from the reference image, holding a scissor',
      'Su Wan walks into the barber shop with a razor and comb',
      'a dog-eared photograph on the mirror reflection, denim jacket over satchel'
    ]
    for (const p of poisoned) {
      expect(cross.test(p), `应命中: ${p}`).toBe(true)
      cross.lastIndex = 0
    }
  })

  it('现代剧常用词不被误拦（t-shirt/jeans/office/apartment/car）', () => {
    const modern = [
      'chinese man in his late 20s wearing a grey t-shirt and jeans, standing in a modern office',
      'the same Li Wei from the reference image, navy shirt, dark trousers, outside a city apartment block',
      'a white car parked on the street, morning sunlight'
    ]
    for (const m of modern) {
      expect(cross.test(m), `不应命中: ${m}`).toBe(false)
      cross.lastIndex = 0
    }
  })

  it('套话审计表达式覆盖已删除的 clearly visible 注入形态', () => {
    // llmService backfill 已移除 "holding a X, clearly visible" 套话（2026-10-25）；
    // SLANG_RE 保留用于审计存量分镜/提示词是否仍带该形态
    expect(SLANG_RE.test('holding a black umbrella, clearly visible')).toBe(true)
    expect(SLANG_RE.test('holding a black umbrella')).toBe(false)
  })
})

describe('reviewedIsValid（index.ts renderStart 门禁统一口径）', () => {
  it('i2v 必须 reviewed 且有 firstFramePath 才算过审', () => {
    expect(reviewedIsValid('i2v', true, 'projects/f.png')).toBe(true)
    expect(reviewedIsValid('i2v', true, '')).toBe(false)
    expect(reviewedIsValid('i2v', true, undefined)).toBe(false)
    expect(reviewedIsValid('i2v', false, 'projects/f.png')).toBe(false)
  })

  it('非 i2v（t2v/r2v）不受首帧路径约束，但仍要求已审核', () => {
    expect(reviewedIsValid('t2v', true, undefined)).toBe(true)
    expect(reviewedIsValid('r2v', true, '')).toBe(true)
    expect(reviewedIsValid('t2v', false, undefined)).toBe(false)
  })
})
