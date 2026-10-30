import { describe, it, expect } from 'vitest'
import { cleanLlmOutput } from '../../src/main/core/llmScriptOps'
import type { FieldFillGuide } from '../../src/shared/promptAuditFixes'

function zhGuide(min = 5, max = 30): FieldFillGuide {
  return {
    field: 'test',
    label: '测试字段',
    lang: 'zh',
    range: [min, max],
    role: '测试'
  }
}
function enGuide(min = 5, max = 30): FieldFillGuide {
  return { ...zhGuide(min, max), lang: 'en' }
}

describe('llmScriptOps · cleanLlmOutput（清洗 LLM 输出）', () => {
  // ---- 基础清洗 ----
  it('去代码块 ```json ... ```', () => {
    expect(cleanLlmOutput('```json\n雨中漫步，慢动作\n```', zhGuide(2, 10))).toBe('雨中漫步，慢动作')
  })
  it('去首尾成对引号', () => {
    expect(cleanLlmOutput('"雨中漫步"', zhGuide(2, 10))).toBe('雨中漫步')
    expect(cleanLlmOutput("'雨中漫步'", zhGuide(2, 10))).toBe('雨中漫步')
  })
  it('去解释性首尾句 Here is the prompt:', () => {
    expect(cleanLlmOutput('Here is the prompt: 雨中漫步', zhGuide(2, 10))).toBe('雨中漫步')
  })
  it('去 Sure/OK/当然/好的 前缀', () => {
    expect(cleanLlmOutput('Sure, 雨中漫步', zhGuide(2, 10))).toBe('雨中漫步')
    expect(cleanLlmOutput('好的，雨中漫步', zhGuide(2, 10))).toBe('雨中漫步')
  })
  it('合并多余空白和换行为单空格', () => {
    expect(cleanLlmOutput('雨中   漫步\n\n   慢动作', zhGuide(4, 20))).toBe('雨中 漫步 慢动作')
  })

  // ---- 空值抛错 ----
  it('清洗后为空 → throw', () => {
    expect(() => cleanLlmOutput('', zhGuide(5, 10))).toThrow(/LLM 返回为空/)
    expect(() => cleanLlmOutput('   ', zhGuide(5, 10))).toThrow(/LLM 返回为空/)
    expect(() => cleanLlmOutput('``` ```', zhGuide(5, 10))).toThrow(/LLM 返回为空/)
  })

  // ---- 字数校验 ----
  it('中文按汉字计数', () => {
    // 8 个汉字 → 应该在 [5, 30] 范围内
    expect(cleanLlmOutput('雨中漫步慢动作', zhGuide(5, 30))).toBe('雨中漫步慢动作')
  })
  it('中文字数不够 → throw', () => {
    expect(() => cleanLlmOutput('雨', zhGuide(5, 30))).toThrow(/超出区间/)
  })
  it('中文字数超上限 → throw', () => {
    const long = '雨'.repeat(100)
    expect(() => cleanLlmOutput(long, zhGuide(5, 30))).toThrow(/超出区间/)
  })
  it('英文按单词计数', () => {
    expect(cleanLlmOutput('a gentle rain walk in slow motion', enGuide(5, 30))).toBe('a gentle rain walk in slow motion')
  })
  it('英文单词不够 → throw', () => {
    expect(() => cleanLlmOutput('rain', enGuide(5, 30))).toThrow(/超出区间/)
  })
  it('maxW=0 时无上限', () => {
    const veryLong = '雨'.repeat(500)
    expect(cleanLlmOutput(veryLong, zhGuide(5, 0))).toBe(veryLong)
  })

  // ---- 综合场景 ----
  it('代码块 + 解释性前缀 + 引号 + 字数合格，一次过', () => {
    // 清洗顺序：去代码块 → 去首尾引号 → 去解释性前缀 → 合并空白
    const raw = '```json\nHere is the prompt: 雨中漫步，慢动作，侧脸特写\n```'
    const result = cleanLlmOutput(raw, zhGuide(5, 30))
    expect(result).toBe('雨中漫步，慢动作，侧脸特写')
  })
})
