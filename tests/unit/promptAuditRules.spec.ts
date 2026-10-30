import { describe, expect, it } from 'vitest'
import { CROSS_SOURCE, SLANG_RE, wordCount, readStr, tidy, makeIssue, hasPeriodCue, statusOf, sortIssues } from '../../src/shared/promptAuditRules'
import type { PromptAuditIssue } from '../../src/shared/ipcTypes'
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

// ===== 2026-10-30 补 promptAuditRules 函数覆盖 =====
describe('promptAuditRules · wordCount / readStr / tidy / makeIssue / hasPeriodCue / statusOf / sortIssues', () => {
  describe('wordCount：英文词数', () => {
    it('空串 → 0', () => { expect(wordCount('')).toBe(0) })
    it('undefined/falsy → 0（text ? ... : 0）', () => { expect(wordCount('')).toBe(0) })
    it('纯英文 → 正确计数', () => { expect(wordCount('a young woman walks')).toBe(4) })
    it('含撇号缩写 → 算一个词', () => { expect(wordCount("don't stop")).toBe(2) })
    it('含数字 → 不算词', () => { expect(wordCount('scene 12 shot 3')).toBe(2) })
  })

  describe('readStr：严格取字符串字段', () => {
    it('正常字符串 → trim 后返回', () => {
      expect(readStr({ name: '  hello  ' }, 'name')).toBe('hello')
    })
    it('字段不存在 → 空串', () => {
      expect(readStr({}, 'name')).toBe('')
    })
    it('null src → 空串', () => {
      expect(readStr(null, 'name')).toBe('')
    })
    it('非字符串值（数字）→ 空串', () => {
      expect(readStr({ x: 123 }, 'x')).toBe('')
    })
    it('非字符串值（对象）→ 空串', () => {
      expect(readStr({ x: {} }, 'x')).toBe('')
    })
    it('数组 → 空串', () => {
      expect(readStr({ x: ['a'] }, 'x')).toBe('')
    })
    it('boolean → 空串', () => {
      expect(readStr({ x: true }, 'x')).toBe('')
    })
  })

  describe('tidy：收尾清理（删虚词段、去悬空连接词、去空括号）', () => {
    it('删空括号和多余空白', () => {
      expect(tidy('woman (), walks')).toBe('woman, walks')
    })
    it('删掉悬空虚词段（只剩虚词）', () => {
      expect(tidy('the, of, woman walks')).toBe('woman walks')
    })
    it('去掉段首悬空连接词', () => {
      // 每段独立处理：段首 of 去掉，段尾保留（因为有实义词）
      const v = tidy('of rain and the sound, woman stands')
      expect(v).not.toMatch(/^of\s/)
      expect(v).toContain('rain')
      expect(v).toContain('woman stands')
    })
    it('空输入 → 空串', () => {
      expect(tidy('')).toBe('')
    })
    it('全是虚词 → 空串', () => {
      expect(tidy('the of and to')).toBe('')
    })
  })

  describe('makeIssue：构造 PromptAuditIssue', () => {
    it('返回正确结构', () => {
      const issue = makeIssue('missing', 'error', 'enPrompt', '英文提示词', '缺主角', true)
      expect(issue).toEqual({
        code: 'missing',
        level: 'error',
        field: 'enPrompt',
        fieldLabel: '英文提示词',
        message: '缺主角',
        fixable: true
      })
    })
  })

  describe('hasPeriodCue：古装/年代线索命中', () => {
    it('古装剧 → true', () => { expect(hasPeriodCue('古装武侠剧')).toBe(true) })
    it('民国 → true', () => { expect(hasPeriodCue('民国上海滩')).toBe(true) })
    it('现代剧 → false', () => { expect(hasPeriodCue('都市言情')).toBe(false) })
    it('空串 → false', () => { expect(hasPeriodCue('')).toBe(false) })
    it('undefined → false', () => { expect(hasPeriodCue(undefined)).toBe(false) })
  })

  describe('statusOf：issues → 审计状态', () => {
    it('有 error → error', () => {
      const issues: PromptAuditIssue[] = [makeIssue('x', 'error', 'f', 'F', 'm', true)]
      expect(statusOf(issues)).toBe('error')
    })
    it('只有 warn → warn', () => {
      const issues: PromptAuditIssue[] = [makeIssue('x', 'warn', 'f', 'F', 'm', true)]
      expect(statusOf(issues)).toBe('warn')
    })
    it('空数组 → ok', () => { expect(statusOf([])).toBe('ok') })
    it('error + warn → error 优先', () => {
      const issues: PromptAuditIssue[] = [
        makeIssue('x', 'warn', 'f', 'F', 'm', true),
        makeIssue('y', 'error', 'f', 'F', 'm', true)
      ]
      expect(statusOf(issues)).toBe('error')
    })
  })

  describe('sortIssues：error 在前，同级保持原序', () => {
    it('warn 然后 error → error 在前', () => {
      const issues: PromptAuditIssue[] = [
        makeIssue('a', 'warn', 'f', 'F', 'm', true),
        makeIssue('b', 'error', 'f', 'F', 'm', true)
      ]
      const sorted = sortIssues(issues)
      expect(sorted[0].code).toBe('b')
      expect(sorted[1].code).toBe('a')
    })

    it('同级保持稳定', () => {
      const issues: PromptAuditIssue[] = [
        makeIssue('a', 'error', 'f', 'F', 'm', true),
        makeIssue('b', 'error', 'f', 'F', 'm', true)
      ]
      const sorted = sortIssues(issues)
      expect(sorted[0].code).toBe('a')
      expect(sorted[1].code).toBe('b')
    })

    it('不修改原数组', () => {
      const issues: PromptAuditIssue[] = [
        makeIssue('a', 'warn', 'f', 'F', 'm', true),
        makeIssue('b', 'error', 'f', 'F', 'm', true)
      ]
      const sorted = sortIssues(issues)
      expect(sorted).not.toBe(issues) // 新数组
      expect(issues[0].code).toBe('a') // 原数组不变
    })
  })
})
