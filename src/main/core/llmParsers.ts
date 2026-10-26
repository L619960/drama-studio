/**
 * LLM 响应解析与本地后处理层（从 llmService.ts 抽出，**单一事实源**）：
 * - 角色绑定归一（normalizeBindings，含拼音容错 + claimPerformer 空镜认领
 *   + alignStoryboardPrompts 生成期串台/漂移改写）
 * 2026-10-25 全面排查：cleanLlmOutput/parseAnalyzeFields/enforcePromptLengths/backfillMissingProps
 * 四个导出在 src 零消费（llmService 仍持 private 副本且已漂移——串戏阈值 0.15↔0.35 等），
 * 属"看似抽出实则双份"漂移温床，已删除；live 行为以 llmService private 副本为准。
 */
import pinyinMod from 'pinyin'
import type { AnalyzeResult } from '../../shared/ipcTypes'
import { alignStoryboardPrompts, claimPerformer } from '../../shared/imagePrompts'

// 拼音容错：LLM 偶尔把中文名译成拼音（如 Lin Chuan），用于归一匹配（v3 导出为 { pinyin }）
const pinyinFn = ((pinyinMod as unknown as { pinyin?: (n: string, o?: unknown) => string[][] }).pinyin ||
  (pinyinMod as unknown as (n: string, o?: unknown) => string[][])) as (n: string, o?: unknown) => string[][]

/** 名称归一化键：去空白并小写（中文不受影响） */
function foldName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '')
}

/**
 * 角色绑定归一：镜头 characterName 与角色表匹配（别名/去头衔/去姓/拼音容错），
 * 再经 claimPerformer 认领空镜 + alignStoryboardPrompts 生成期串台改写。
 * 2026-10-23 总实证修复：llmService.analyze 统一消费本导出版（此前用 private 版无 align，
 * LLM 幻觉 promptEn 原样落盘只靠渲染期兜底）。
 */
export function normalizeBindings(result: AnalyzeResult): AnalyzeResult {
  const warnings: string[] = []
  const aliasMap = new Map<string, string>()
  for (const c of result.characters) {
    aliasMap.set(foldName(c.name), c.name)
    for (const a of c.aliases || []) {
      aliasMap.set(foldName(a), c.name)
    }
  }

  // 去头衔 / 去姓 索引：用于 LLM 写出"陆总""景琛"时的兜底匹配
  const TITLE_WORDS = [
    '先生', '小姐', '女士', '太太', '夫人', '总裁', '总',
    '少爷', '老板', '经理', '主任', '医生', '老师',
    '哥', '姐', '叔', '姨', '妈', '父', '母'
  ]
  const shortMap = new Map<string, string>()
  for (const c of result.characters) {
    shortMap.set(foldName(c.name), c.name)
    if (c.name.length >= 2) {
      shortMap.set(foldName(c.name.slice(1)), c.name) // 去掉姓
    }
  }

  for (const s of result.shots) {
    if (s.type !== 'i2v') continue

    if (!s.characterName) {
      warnings.push(`镜头「${s.scene}」为人物镜头但未归属主角`)
      continue
    }

    const rawName = s.characterName.trim()
    const exact = aliasMap.get(foldName(rawName))
    if (exact) {
      s.characterName = exact
      continue
    }

    let stripped = rawName
    for (const w of TITLE_WORDS) {
      if (stripped.endsWith(w) && stripped.length > w.length) {
        stripped = stripped.slice(0, stripped.length - w.length)
        break
      }
    }
    const folded = foldName(stripped)
    const fuzzy =
      shortMap.get(folded) ||
      [...shortMap.entries()].find(
        ([k]) => k.includes(folded) || folded.includes(k)
      )?.[1]

    if (fuzzy) {
      s.characterName = fuzzy
      if (s.characters) {
        s.characters = s.characters.map(n =>
          aliasMap.get(foldName(n.trim())) || n.trim()
        )
      }
      continue
    }

    // 拼音容错：LLM 偶尔把中文名音译成拼音（如 Lin Chuan ↔ 林川），角色表与姓名均转拼音比对
    const pyOf = (name: string): string => {
      try {
        const segs = pinyinFn(name, { heteronym: false })
        const raw = segs.map(s => (s[0] || '')).join('')
        // 剥离声调符号（NFD 分解后 ̀-ͯ 为组合音调符）
        return raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, '')
      } catch { return '' }
    }
    const rawPy = pyOf(stripped)
    if (rawPy) {
      const pyHit = [...aliasMap.entries()].find(([k, v]) =>
        /[\u4e00-\u9fff]/.test(k) && pyOf(v) === rawPy
      )?.[1]
      if (pyHit) {
        s.characterName = pyHit
        if (s.characters) {
          s.characters = s.characters.map(n =>
            aliasMap.get(foldName(n.trim())) || n.trim()
          )
        }
        continue
      }
    }

    warnings.push(
      `镜头「${s.scene}」的主角「${rawName}」无法匹配角色表（${result.characters.map(c => c.name).join('、')}）`
    )
  }

  const pyOf = (name: string): string => {
    try {
      const segs = pinyinFn(name, { heteronym: false })
      return segs.map(s => (s[0] || '')).join('')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, '')
    } catch { return '' }
  }
  const cast = result.characters.map(c => ({ name: c.name, pinyin: pyOf(c.name) }))
  result.shots = result.shots.map((s, i) => {
    const claimed = claimPerformer(s, cast)
    if (claimed.claimed) {
      warnings.push(`提示词核对：第${i + 1}镜动作是${claimed.shot.characterName}，已从空镜改回人物镜，避免脸和服装失去定妆`)
    }
    return claimed.shot
  })
  const lookOf = (s: { characterName?: string }): string => {
    const name = (s.characterName || '').trim()
    const c = result.characters.find(ch => ch.name === name || (ch.aliases || []).includes(name))
    return c?.lookEn || ''
  }
  const aligned = alignStoryboardPrompts(result.shots, lookOf)
  result.shots = aligned.shots
  warnings.push(...aligned.notes)

  if (warnings.length > 0) {
    result.warnings = [...(result.warnings || []), ...warnings]
  }
  return result
}
