import { describe, it, expect } from 'vitest'
import { analyzeSystemPrompt } from '../../src/main/core/llmPromptsAnalyze'
import { emptySceneNegativeFor } from '../../src/shared/negatives'
import { panoramaScenePrompt } from '../../src/shared/scenePrompts'

describe('一致性整改：颜色逐字锁 + 湿身状态 + 全景 artifact 压制', () => {
  it('analyze system prompt 必须包含颜色逐字翻译铁律', () => {
    const prompt = analyzeSystemPrompt({
      sb: { minShots: 4, maxShots: 8, temperature: 0.7, maxCharacters: 3, enforcePropLock: true, enforceReactionBeats: true, enforceBoardingChain: true },
      titleHint: '雨夜里的伞'
    })
    // 必须明确禁止 black→dark grey 降级
    expect(prompt).toContain('颜色逐字铁律')
    expect(prompt).toContain('black trench coat')
    expect(prompt).toMatch(/dark grey.*降级|禁止降级/i)
  })

  it('analyze system prompt 必须强制湿身/淋雨状态写进 lookEn', () => {
    const prompt = analyzeSystemPrompt({
      sb: { minShots: 4, maxShots: 8, temperature: 0.7, maxCharacters: 3, enforcePropLock: true, enforceReactionBeats: true, enforceBoardingChain: true },
      titleHint: '雨夜里的伞'
    })
    expect(prompt).toContain('rain-soaked')
    expect(prompt).toMatch(/湿透|淋雨|淋湿/i)
  })

  it('空场景负向必须压轮胎/井盖 artifact', () => {
    const neg = emptySceneNegativeFor('standard', '天台')
    expect(neg).toContain('tires')
    expect(neg).toContain('manhole')
  })

  it('全景正向 prompt 不得出现 "no xxx" 否定式（会被 CLIP 召唤）', () => {
    const p = panoramaScenePrompt('天台夜暴雨', 'noir', { weatherHint: 'rainy' })
    // 正向里不应再出现独立的 no tires / no wheels 这类否定短语
    expect(p).not.toMatch(/\bno tires\b/i)
    expect(p).not.toMatch(/\bno wheels\b/i)
  })
})
