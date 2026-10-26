import { describe, it, expect } from 'vitest'
import { planAssetReuse, pickFromPool, genreCompatible } from '../../src/main/core/assetReuse'

describe('assetReuse · 资产复用回退（T2I 缺失兜底映射）', () => {
  const pool = ['charA', 'charB', 'charC']

  it('目标数与池等长：一一对应', () => {
    expect(planAssetReuse(3, pool)).toEqual(['charA', 'charB', 'charC'])
  })

  it('目标多于池：超出部分钳到池末（复用最后一个角色）', () => {
    expect(planAssetReuse(5, pool)).toEqual(['charA', 'charB', 'charC', 'charC', 'charC'])
  })

  it('目标少于池：只取前 N 个', () => {
    expect(planAssetReuse(2, pool)).toEqual(['charA', 'charB'])
  })

  it('池为空：全部返回 undefined（回退不可用，流水线留痕继续）', () => {
    expect(planAssetReuse(3, [])).toEqual([undefined, undefined, undefined])
  })

  it('pickFromPool 越界钳到最后一位，空池返回 undefined', () => {
    expect(pickFromPool(pool, 0)).toBe('charA')
    expect(pickFromPool(pool, 2)).toBe('charC')
    expect(pickFromPool(pool, 99)).toBe('charC')
    expect(pickFromPool([], 0)).toBeUndefined()
  })
})

describe('genreCompatible · 回退资产题材一致性门禁（现代剧防穿帮）', () => {
  it('同题材（古装→古装）允许复用', () => {
    expect(genreCompatible('古装', '古装')).toBe(true)
  })
  it('跨题材（现代剧→古装资产库）禁止复用', () => {
    expect(genreCompatible('古装', '现代')).toBe(false)
    expect(genreCompatible('现代', '古装')).toBe(false)
  })
  it('资产库项目题材缺失 → 保守禁止（宁可回退失败不穿帮）', () => {
    expect(genreCompatible(undefined, '现代')).toBe(false)
    expect(genreCompatible('', '现代')).toBe(false)
    expect(genreCompatible(undefined, undefined)).toBe(false)
  })
  it('本项目题材缺失 → 禁止（无题材锚点无法证明同题材）', () => {
    expect(genreCompatible('古装', undefined)).toBe(false)
  })
})
