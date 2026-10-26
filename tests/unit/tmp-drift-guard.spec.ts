import { describe, it, expect } from 'vitest'
import { repairCastText, castPromptPoisoned } from '../../src/shared/promptDrift'

const poison = 'the same young woman from the reference image, wearing a torn white nightgown with wet hair clinging to her face, she pressed into the corner of the room, trembling, static camera, fixed framing, eye-level, smooth motion'
const action = "Lu Yuan draws his green steel sword and clashes with Tie Mian's ring-pommel saber, sparks fly from the crossed blades, rain droplets scatter, static camera, fixed framing, eye-level, tense standoff, smooth motion"
const lookLu = 'chinese man in his mid-20s, lean athletic build, moon-white (#F0EFEA) cross-collar right-lapel fine linen robe, black hair tied in a high ponytail, no hair crown, single-edged green steel longsword'

describe('drift guard on new-drama hallucinated promptEn', () => {
  it('castPromptPoisoned 命中 nightgown 串台（gown 词表 + 动作内容重叠）', () => {
    expect(castPromptPoisoned(action, poison, lookLu)).toBe(true)
  })
  it('repairCastText motion 模式整体换动作模板，不含 young woman/nightgown', () => {
    const repaired = repairCastText(poison, action, lookLu, 'motion') || ''
    expect(repaired).not.toContain('young woman')
    expect(repaired).not.toContain('nightgown')
    expect(repaired).not.toContain('corner')
    expect(repaired.toLowerCase()).toContain('the same person from the reference image')
  })
  it('lookEn 为空时同样命中（武打镜 characterName 缺失场景）', () => {
    expect(castPromptPoisoned(action, poison, '')).toBe(true)
  })
})
