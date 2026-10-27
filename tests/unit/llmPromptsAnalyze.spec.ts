/* eslint-disable @typescript-eslint/no-explicit-any -- 测试用 as any 构造简化 storyboard 配置，属测试夹具 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { analyzeSystemPrompt } from '../../src/main/core/llmPromptsAnalyze'

const sb = {
  minShots: 5, maxShots: 8, maxCharacters: 4,
  temperature: 0.7,
  enforcePropLock: true, enforceReactionBeats: true, enforceBoardingChain: false
} as any

function system(extraRules: string[] = []): string {
  return analyzeSystemPrompt({ sb, titleHint: '测试剧', tpl: undefined, extraRules })
}

describe('analyzeSystemPrompt 单一事实源（2026-10-23 全量整改）', () => {
  it('包含 doctrinePromptBlock（成片口径块）——旧内联版缺失项', () => {
    const s = system()
    expect(s).toContain('成片口径')
    expect(s).toContain('对白镜说完留白约 0.5 秒')
  })
  it('合规红线①为一镜一张脸口径（与 rules.json「单人一画」一致）', () => {
    const s = system()
    expect(s).toContain('一镜只允许一张可读人脸')
    // 不得残留旧口径"最多 2 个角色同框"
    expect(s).not.toContain('单镜画面最多 2 个角色')
  })
  it('extraRules 注入导演技能库方法论', () => {
    const s = system(['精确外观锁：每角色外观档案必须登记服装精确色名+色值'])
    expect(s).toContain('导演技能库方法论')
    expect(s).toContain('精确外观锁')
  })
  it('不含任何他剧/他项目残留角色名（污染名准入）', () => {
    const s = system()
    for (const n of ['白若曦', '孟瑶', '苏棠', '林一剪', '江哲', 'Chen Mo', 'Marcus', 'Elara', '沈青崖', '铁髯', '阿禾', '周野', '苏晚', '老陈', '灵气打卡', '雨夜山门', '深夜便利店']) {
      expect(s, `残留污染名: ${n}`).not.toContain(n)
    }
  })
  it('教学示例仍保留（格式教学价值不因去名受损）', () => {
    const s = system()
    expect(s).toContain('边界示例')
    expect(s).toContain('极短回应')
    expect(s).toContain('递接 umbrella handle')
  })
  it('输出为严格合法 JSON 骨架（单行字段规则在）', () => {
    const s = system()
    expect(s).toContain('JSON 硬规则')
    expect(s).toContain('禁止 markdown 代码围栏')
  })
})

describe('rules.json 污染准入（methodRules 注入 LLM 前必须无具体剧名/角色名）', () => {
  it('methodRules 无残留他剧剧名/角色名（2026-10-23 清理验收）', () => {
    const p = path.join(process.cwd(), 'skills', 'director', 'rules.json')
    const rules = JSON.parse(fs.readFileSync(p, 'utf-8'))
    const all = JSON.stringify(rules)
    for (const n of ['沈青崖', '铁髯', '阿禾', '灵气打卡', '雨夜山门', '深夜便利店', '周野', '苏晚', '老陈', 'Marcus', 'Elara', 'Chen Mo', '关东煮']) {
      expect(all, `rules.json 残留污染名: ${n}`).not.toContain(n)
    }
  })
  it('rules.json 结构完整（methodRules/auditChecklist 存在）', () => {
    const p = path.join(process.cwd(), 'skills', 'director', 'rules.json')
    const rules = JSON.parse(fs.readFileSync(p, 'utf-8'))
    expect(Array.isArray(rules.methodRules)).toBe(true)
    expect(rules.methodRules.length).toBeGreaterThanOrEqual(20)
    expect(Array.isArray(rules.auditChecklist)).toBe(true)
    expect(rules.auditChecklist.length).toBeGreaterThanOrEqual(8)
  })
})
