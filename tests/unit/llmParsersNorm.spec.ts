import { describe, it, expect } from 'vitest'
import { normalizeBindings } from '../../src/main/core/llmParsers'
import type { AnalyzeResult } from '../../src/shared/ipcTypes'

// 2026-10-23 总实证修复：llmService.analyze 切到 llmParsers.normalizeBindings（含 align 生成期拦截）。
// 回归毒样本：《孤栈惊变》analyze 输出 5 镜 promptEn 全是"湿发白衣女"幻觉（nightgown/bed/corner），
// 此前 private 版无 align → 脏文本落盘只靠渲染期兜底。llmParsers 版应认领角色 + 改写为动作模板。
const luLook =
  'chinese man in his mid-20s, lean athletic build, moon-white (#F0EFEA) cross-collar right-lapel fine linen robe, black hair tied in a high ponytail, no hair crown, single-edged green steel longsword'

function makeResult(): AnalyzeResult {
  return {
    logline: '镖师陆远夜宿孤栈遇劫镖刀客',
    characters: [
      {
        name: '陆远',
        gender: 'male',
        age: 'mid-20s',
        appearance: '月白袍青年剑客',
        lookEn: luLook,
        aliases: [],
        confidence: 'high',
      },
    ],
    props: [],
    scenes: [],
    shots: [
      {
        type: 'i2v',
        scene: '雨夜孤栈',
        action:
          "Lu Yuan draws his green steel sword and clashes with Tie Mian's ring-pommel saber, sparks fly, static camera, fixed framing, eye-level, smooth motion",
        dialogue: '',
        characterName: '',
        promptEn:
          'the same young woman from the reference image, wearing a torn white nightgown with wet hair clinging to her face, she pressed into the corner of the room, trembling, static camera, fixed framing, eye-level, smooth motion',
      },
    ],
  }
}

describe('llmParsers.normalizeBindings 生成期串台改写（总实证修复）', () => {
  it('认领空镜动作里的角色（拼音容错）并补 characterName', () => {
    const r = makeResult()
    const out = normalizeBindings(r)
    expect(out.shots[0]?.characterName).toBe('陆远')
  })
  it('alignStoryboardPrompts 把 nightgown 幻觉 promptEn 整体改写成动作模板', () => {
    const r = makeResult()
    const out = normalizeBindings(r)
    const p = out.shots[0]?.promptEn || ''
    expect(p).not.toContain('young woman')
    expect(p).not.toContain('nightgown')
    expect(p).not.toContain('corner')
    expect(p.toLowerCase()).toContain('the same person from the reference image')
    expect(p.toLowerCase()).toContain('moon-white')
  })
  it('align 改写不污染 warnings（串台改写已执行但不刷屏）', () => {
    const r = makeResult()
    const out = normalizeBindings(r)
    // align 注记不再 push 到 warnings 刷屏——代码层面已完成改写（见上一个用例），
    // 但 warnings 只保留真正需要导演关注的冲突（如角色表不匹配）
    // 这里验证 warnings 里没有残留的提示词核对噪音
    const hasNoise = (out.warnings || []).some((w) => w.includes('提示词核对'))
    expect(hasNoise).toBe(false)
  })
})
