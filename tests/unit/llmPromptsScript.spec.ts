import { describe, it, expect } from 'vitest'
import {
  writeScriptPrompts, writeScriptFromFramesSystem,
  reviewScriptSystem, splitScriptSystem
} from '../../src/main/core/llmPromptsScript'

/**
 * 剧本生产提示词（llmPromptsScript）单测：
 * 写剧本/抽帧反写/剧本医生/拆分镜的格式约束与题材风格注入。
 */
describe('writeScriptPrompts', () => {
  it('system 含场次格式与题材风格，user 含片名/想法/题材标签', () => {
    const r = writeScriptPrompts(
      { idea: '雨夜一把伞', title: '伞', genre: '悬疑' },
      { label: '悬疑剧', promptStyle: '冷冽克制' } as any
    )
    expect(r.system).toContain('【第N场 · 场景名】')
    expect(r.system).toContain('3~6 场')
    expect(r.system).toContain('题材风格：冷冽克制')
    expect(r.user).toContain('片名：《伞》')
    expect(r.user).toContain('创作想法：\n雨夜一把伞')
    expect(r.user).toContain('题材：悬疑剧')
  })

  it('无片名/无模板时省略对应行', () => {
    const r = writeScriptPrompts({ idea: '想法', genre: '都市' }, undefined)
    expect(r.user).not.toContain('片名')
    expect(r.user).toContain('题材：都市')
    expect(r.system).not.toContain('题材风格')
  })
})

describe('writeScriptFromFramesSystem', () => {
  it('要求按画面反推并保留关键道具', () => {
    const s = writeScriptFromFramesSystem('温情')
    expect(s).toContain('反推')
    expect(s).toContain('关键道具重复出现')
    expect(s).toContain('题材风格：温情')
  })
})

describe('reviewScriptSystem', () => {
  it('六维审查与 JSON 输出约束', () => {
    const s = reviewScriptSystem(undefined, undefined)
    expect(s).toContain('1. 人物')
    expect(s).toContain('6. 结构节奏')
    expect(s).toContain('"issues"')
    expect(s).toContain('revisedScript')
    expect(s).not.toContain('题材风格基调')
    expect(s).not.toContain('片名：')
  })

  it('注入风格与片名意象要求', () => {
    const s = reviewScriptSystem('古风', '伞')
    expect(s).toContain('题材风格基调：古风')
    expect(s).toContain('片名：《伞》')
  })
})

describe('splitScriptSystem', () => {
  it('要求 JSON 数组、字段与镜头数量', () => {
    const s = splitScriptSystem('都市')
    expect(s).toContain('Output ONLY a JSON array')
    expect(s).toContain('"scene"')
    expect(s).toContain('"type": "i2v 或 t2v"')
    expect(s).toContain('严禁 identical face/appearance/outfit')
    expect(s).toContain('题材风格: 都市')
    expect(s).toContain('8~20 个镜头')
  })
})
