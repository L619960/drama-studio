import { describe, it, expect } from 'vitest'
import { castPromptPoisoned } from '../../src/shared/promptDrift'
import { COMBAT_ACTION_RE } from '../../src/shared/motion'
import { propsConstraintBlock, sceneCueFor, noExtrasLockFor } from '../../src/main/core/taskQueuePrompts'

const lookShen = 'chinese man in his early 20s, lean athletic build, oval face, straight sword-like brows, bright dark eyes, straight nose, pale moon-white linen cross-collar robe, black high ponytail, holding a green-steel longsword'

describe('道具数量硬约束 propsConstraintBlock', () => {
  it('持械镜（拔剑）→ 单械锁', () => {
    const s = { type: 'i2v', characterIds: ['c1'], action: '缓缓拔出青锋剑，剑指铁髯' } as any
    const b = propsConstraintBlock(s)
    expect(b).toContain('exactly ONE weapon only')
    expect(b).toContain('held in ONE hand')
    expect(b).toContain('other hand empty')
    expect(b).toContain('no dual wielding')
    expect(b).toContain('no weapon changing into another')
  })
  it('持械镜（格挡）→ 单械锁', () => {
    const s = { type: 'i2v', characterIds: ['c1'], action: '刀剑交格，二人对峙发力' } as any
    expect(propsConstraintBlock(s)).toContain('exactly ONE weapon only')
  })
  it('持械镜（英文 parry）→ 单械锁', () => {
    const s = { type: 'i2v', characterIds: ['c1'], action: 'parries once, blades meet and hold' } as any
    expect(propsConstraintBlock(s)).toContain('exactly ONE weapon only')
  })
  it('空手台词镜 → 双手无物', () => {
    const s = { type: 'i2v', characterIds: ['c1'], action: '冷声喝问', dialogue: '新来的？' } as any
    const b = propsConstraintBlock(s)
    expect(b).toContain('hands empty, no object held')
    expect(b).toContain('no fan, no scroll')
  })
  it('无角色镜 → 空字符串', () => {
    const s = { type: 'i2v', characterIds: [] } as any
    expect(propsConstraintBlock(s)).toBe('')
  })
  it('持物豁免：action 明确端碗（现代剧镜3 周野端关东煮）→ 不锁空手', () => {
    const s = { type: 'i2v', characterIds: ['c1'], action: 'holds a cup of steaming oden, a slight look of curiosity on his face' } as any
    const b = propsConstraintBlock(s)
    expect(b).toContain('hands hold only the object specified in the action')
    expect(b).not.toContain('hands empty, no object held')
  })
  it('持物豁免：action 持剑立姿（非武打）→ 只锁指定物', () => {
    const s = { type: 'i2v', characterIds: ['c1'], action: 'stands holding a lantern, looking at the distant gate' } as any
    expect(propsConstraintBlock(s)).toContain('hands hold only the object specified')
  })
  it('纯台词空手镜（无持物词）仍锁空手', () => {
    const s = { type: 'i2v', characterIds: ['c1'], action: 'speaks the line softly, mouth moves naturally' } as any
    expect(propsConstraintBlock(s)).toContain('hands empty, no object held')
  })
})

describe('COMBAT_ACTION_RE 武打判定', () => {
  it('中文持械动作命中', () => {
    expect(COMBAT_ACTION_RE.test('拔剑出鞘')).toBe(true)
    expect(COMBAT_ACTION_RE.test('格挡')).toBe(true)
    expect(COMBAT_ACTION_RE.test('持剑而立')).toBe(true)
    expect(COMBAT_ACTION_RE.test('横剑')).toBe(true)
  })
  it('英文持械动作命中', () => {
    expect(COMBAT_ACTION_RE.test('draws the sword once and holds the point forward')).toBe(true)
    expect(COMBAT_ACTION_RE.test('parries once, the blades meet and hold')).toBe(true)
    expect(COMBAT_ACTION_RE.test('sheathes the sword in one motion')).toBe(true)
  })
  it('非持械动作不命中', () => {
    expect(COMBAT_ACTION_RE.test('冷声喝问')).toBe(false)
    expect(COMBAT_ACTION_RE.test('speaks the line, mouth moves')).toBe(false)
    expect(COMBAT_ACTION_RE.test('steps back once and stops')).toBe(false)
  })
})

describe('castPromptPoisoned 串台提示词兜底（扩展词表）', () => {
  it('他剧场景（cellar）→ 中毒', () => {
    const p = 'the same Lin from the reference image, crouching on the damp cellar floor, her fingers dig into the muddy ground'
    expect(castPromptPoisoned('拔剑出鞘，剑指铁髯', p, lookShen)).toBe(true)
  })
  it('他剧服装（tank top）→ 中毒', () => {
    const p = 'the same Lin from the reference image, wearing a torn grey tank top, she lifts her head'
    expect(castPromptPoisoned('拔剑出鞘', p, lookShen)).toBe(true)
  })
  it('女性代词（her）在男角镜 → 中毒', () => {
    const p = 'the same Lin from the reference image, with wet black hair plastered across her forehead'
    expect(castPromptPoisoned('拔剑出鞘', p, lookShen)).toBe(true)
  })
  it('正常武打提示词不误伤（英文 action + 干净同剧 prompt）', () => {
    const p = 'the young swordsman in the pale moon-white robe draws the green-steel longsword once, holds the point forward, one hand on the hilt, the other hand empty'
    expect(castPromptPoisoned('draws the sword once and holds the point forward', p, lookShen)).toBe(false)
  })
  it('同剧场景词（night rain / gate）不误伤（英文 action）', () => {
    const p = 'the swordsman stands before the mountain gate in the night rain, one hand on the sword'
    expect(castPromptPoisoned('holds still, one hand on the sword', p, lookShen)).toBe(false)
  })
})

describe('sceneCueFor 场景词兜底（2026-10-23 现代剧首跑修复）', () => {
  it('sceneEn 有英文 → 直接用', () => {
    expect(sceneCueFor({ sceneEn: 'a modern office with desks at night', action: 'x' }, 'a modern office with desks at night')).toContain('office')
  })
  it('sceneEn 为空 + action 含 convenience store → 兜底注入便利店词锁', () => {
    const c = sceneCueFor({ sceneEn: '', action: 'An older man pokes his head out from the back door of the convenience store' }, '')
    expect(c).toContain('convenience store interior')
  })
  it('sceneEn 为空 + action 无场景词 → 空（不硬造场景）', () => {
    expect(sceneCueFor({ sceneEn: '', action: 'speaks the line softly' }, '')).toBe('')
  })
  it('sceneEn 为中文 → 丢弃并回退 action 提取', () => {
    expect(sceneCueFor({ sceneEn: '深夜便利店', action: 'pushes open the glass door of the shop' }, '深夜便利店')).toContain('shop interior')
  })
})

describe('castPromptPoisoned 现代剧适配（sceneEn 场景词感知）', () => {
  const lookModern = 'chinese man in his early 30s, short neat black hair, navy suit with white shirt, clean-shaven'
  it('现代场景词在 sceneEn 中 → 放行（office 属本镜场景）', () => {
    const p = 'the man in the navy suit steps into the office, walks to the desk, one hand adjusting his tie'
    expect(castPromptPoisoned('walks into the office and sits down', p, lookModern, 'a modern office with desks and windows at night')).toBe(false)
  })
  it('现代场景词不在 sceneEn/action 中 → 仍判串台（他剧场景）', () => {
    const p = 'the man in the navy suit steps into the office and sits at the desk'
    expect(castPromptPoisoned('stands at the street corner waiting for the bus', p, lookModern, 'a rainy city street at night')).toBe(true)
  })
  it('现代角色正常动作描述不误伤（sceneEn 场景归属正确）', () => {
    const p = 'the young woman with short bob haircut in a beige overcoat walks down the sidewalk, bag in one hand'
    expect(castPromptPoisoned('walks down the sidewalk with her bag', p, 'chinese woman in her late 20s, short bob haircut, beige overcoat', 'a modern city sidewalk in daylight')).toBe(false)
  })
})

describe('场景无路人锁 noExtrasLockFor（2026-10-23《雨夜山门 v2》外观漂移修复）', () => {
  it('武打镜（单人拔剑）→ 锁仅 1 人 + 无路人', () => {
    const s = { action: '缓缓拔出青锋剑，剑指铁髯', characterIds: ['c1'], shotSize: 'medium' } as any
    const b = noExtrasLockFor(s)
    expect(b).toContain('exactly ONE person')
    expect(b).toContain('background is empty')
  })
  it('武打镜（英文 duel 双人）→ 锁仅 2 人', () => {
    const s = { action: 'two swordsmen duel in the courtyard, blades clash', characterIds: ['c1', 'c2'], shotSize: 'medium' } as any
    const b = noExtrasLockFor(s)
    expect(b).toContain('exactly 2 people')
    expect(b).toContain('only the 2 characters from the reference images')
  })
  it('台词特写镜 → 同样锁无路人（背景不得出现剧本外人物）', () => {
    const s = { action: '冷声喝问', characterIds: ['c1'], shotSize: 'closeup' } as any
    expect(noExtrasLockFor(s)).toContain('exactly ONE person')
  })
  it('远景过场镜（无武打非特写）→ 不注入（避免误锁多人群像）', () => {
    const s = { action: '雨夜山门外景，远山雾气', characterIds: ['c1'], shotSize: 'wide' } as any
    expect(noExtrasLockFor(s)).toBe('')
  })
  it('中景普通镜（非武打）→ 同样锁无路人（H3 任意镜都可能自由添背景人）', () => {
    const s = { action: '徐步走过石阶', characterIds: ['c1'], shotSize: 'medium' } as any
    expect(noExtrasLockFor(s)).toContain('exactly ONE person')
  })
})
