/**
 * imagePrompts.ts 是纯 re-export 枢纽，本测试只为触发它的 export 行覆盖。
 * 所有导出函数的逻辑已在各子模块测试中覆盖，此处只做烟雾存在性验证。
 */
import { describe, it, expect } from 'vitest'
import * as ip from '../../src/shared/imagePrompts'

describe('imagePrompts · re-export 枢纽烟雾测试（2026-10-30 触发模块行覆盖）', () => {
  it('mergeNegative 存在（从 promptUtils re-export）', () => {
    expect(typeof ip.mergeNegative).toBe('function')
    expect(ip.mergeNegative('a,,b')).toBe('a, b')
  })

  it('motion 动作清洗函数存在', () => {
    expect(typeof ip.cleanAction).toBe('function')
    expect(typeof ip.actionLacksEnglish).toBe('function')
    expect(typeof ip.motionCueFromAction).toBe('function')
    expect(typeof ip.chooseRenderWorkflow).toBe('function')
  })

  it('动作判定正则导出', () => {
    expect(ip.DISPLACEMENT_ACTION_RE.test('walks')).toBe(true)
    expect(ip.STRONG_ACTION_RE.test('slams')).toBe(true)
    expect(ip.COMBAT_ACTION_RE.test('parries')).toBe(true)
  })

  it('文本净化函数存在', () => {
    expect(typeof ip.sanitizeCinematicPrompt).toBe('function')
    expect(typeof ip.soloizeAction).toBe('function')
    expect(typeof ip.maskCastNames).toBe('function')
    expect(typeof ip.stripOtherPersonClauses).toBe('function')
    expect(typeof ip.stripDialogueDirections).toBe('function')
    expect(typeof ip.isPlaybackOrVoiceoverAction).toBe('function')
    expect(typeof ip.stripOutdoorHints).toBe('function')
  })

  it('定妆外观函数存在（castAppearance re-export）', () => {
    expect(typeof ip.sanitizeCastLook).toBe('function')
    expect(typeof ip.identityLockBlock).toBe('function')
    expect(typeof ip.stripOocWardrobe).toBe('function')
  })

  it('promptConstants 常量导出（shotDoctrine 已覆盖 100%）', () => {
    expect(ip.SHOT_SIZE_CUE).toBeDefined()
    expect(ip.REALISM_POSITIVE).toBeDefined()
  })
})
