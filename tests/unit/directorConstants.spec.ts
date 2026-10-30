import { describe, it, expect } from 'vitest'
import {
  STAGE_ORDER,
  STAGE_LABELS,
  stageIndexOf,
  pickPanoView,
  LOG_LIMIT,
  HEAL_MAX,
  FEMALE_VOICES,
  MALE_VOICES
} from '../../src/main/core/directorConstants'

/**
 * 导演共享常量单测（directorConstants 首个 spec）：
 * 阶段顺序/序号、日志上限与自愈预算、全景方位选取、音色轮转表。
 */
describe('directorConstants', () => {
  it('阶段顺序覆盖完整流水线且序号与数组下标一致', () => {
    expect(STAGE_ORDER).toEqual([
      'analyze', 'casting', 'scenes', 'render',
      'combine', 'subtitle', 'review', 'bgm', 'done'
    ])
    STAGE_ORDER.forEach((st, i) => expect(stageIndexOf(st)).toBe(i))
  })

  it('每个阶段都有中文标签，且未知阶段返回 -1', () => {
    expect(Object.keys(STAGE_LABELS)).toHaveLength(STAGE_ORDER.length)
    for (const st of STAGE_ORDER) expect(STAGE_LABELS[st]).toBeTruthy()
    expect(stageIndexOf('unknown' as never)).toBe(-1)
  })

  it('日志上限与自愈预算为约定值', () => {
    expect(LOG_LIMIT).toBe(300)
    expect(HEAL_MAX).toBe(2)
  })

  describe('pickPanoView', () => {
    const views = ['front.png', 'right.png', 'back.png', 'left.png']

    it('无方位图或空数组时返回 undefined', () => {
      expect(pickPanoView('medium shot', undefined)).toBeUndefined()
      expect(pickPanoView(undefined, [])).toBeUndefined()
    })

    it('无机位描述默认取前视（view0）', () => {
      expect(pickPanoView(undefined, views)).toBe('front.png')
      expect(pickPanoView('medium shot, eye level', views)).toBe('front.png')
    })

    it('按机位词映射左/右/后方位', () => {
      expect(pickPanoView('left profile', views)).toBe('left.png')
      expect(pickPanoView('portrait side', views)).toBe('left.png')
      expect(pickPanoView('right side, profile', views)).toBe('right.png')
      expect(pickPanoView('from behind', views)).toBe('back.png')
      expect(pickPanoView('over-shoulder', views)).toBe('back.png')
      expect(pickPanoView('rear angle', views)).toBe('back.png')
    })

    it('方位图不足四张时兜底取最后一张，不越界', () => {
      const two = ['front.png', 'right.png']
      expect(pickPanoView('left profile', two)).toBe('right.png')
      expect(pickPanoView('from behind', two)).toBe('right.png')
    })
  })

  it('音色表按性别分组且非空', () => {
    expect(FEMALE_VOICES.length).toBeGreaterThan(0)
    expect(MALE_VOICES.length).toBeGreaterThan(0)
    expect(FEMALE_VOICES.every(v => v.startsWith('zh-CN-'))).toBe(true)
    expect(MALE_VOICES.every(v => v.startsWith('zh-CN-'))).toBe(true)
  })
})
