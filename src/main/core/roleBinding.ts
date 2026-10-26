import pinyinMod from 'pinyin'
import type { Character } from '../../shared/ipcTypes'

const pinyinFn = ((pinyinMod as unknown as { pinyin?: (n: string, o?: unknown) => string[][] }).pinyin ||
  (pinyinMod as unknown as (n: string, o?: unknown) => string[][])) as (n: string, o?: unknown) => string[][]

/** 中文名 → 拼音空格名 / 首字母大写名，供单人镜提示词屏蔽英文戏名。 */
export function castNameVariants(name: string): string[] {
  const n = (name || '').trim()
  if (!n) return []
  const out = new Set<string>([n])
  try {
    const segs = pinyinFn(n, { heteronym: false })
    const spaced = segs.map(s => (s[0] || ''))
      .join(' ')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (spaced) {
      out.add(spaced)
      out.add(spaced.toLowerCase())
      out.add(spaced.replace(/\b\w/g, c => c.toUpperCase()))
      out.add(spaced.replace(/\s+/g, ''))
    }
  } catch { /* pinyin 不可用时只保留原文 */ }
  return [...out]
}

/**
 * 角色-资产绑定校验与角色混淆判别（纯函数，2026-10-23 角色混淆 bug 根因级修复）。
 *
 * 背景：用户实测《灵气打卡》成片"全是同一个人"——注入脚本只建 1 个角色表项、
 * 5 镜参考图全部指向同一张深蓝袍特写，渲染自然全片同一人；应用层缺
 * "角色资产绑定 + 防混淆判别"规则。本模块提供：
 * 1) validateCharacterAssets：多角色必须各绑唯一定妆图、外观锚点差异化（共享图=硬错误，趋同=警告）；
 * 2) detectRoleConfusion：渲染后相对判别——本镜输出更像"其他角色"的定妆即角色混淆。
 */

/** 服装主色系词典（appearanceLock 差异化检测用；含现代服化词——2026-10-23 现代剧适配） */
const COLOR_TERMS: Record<string, string[]> = {
  '浅色/素色': ['white', 'off-white', 'pale', 'light gray', 'light grey', 'beige', 'linen', 'cream', 'ivory', '麻', '浅', '米白', '米色'],
  '青色/蓝色': ['blue', 'cyan', 'teal', 'navy', 'indigo', 'slate', '青', '蓝', '靛', '藏青', '宝蓝'],
  '玄黑/深色': ['black', 'dark gray', 'dark grey', 'charcoal', 'graphite', 'grey', 'gray', '玄', '黑', '墨', '炭灰', '深灰'],
  '紫色': ['purple', 'violet', '紫'],
  '红色/绛色': ['red', 'crimson', 'vermillion', 'maroon', 'burgundy', 'wine', '绛', '红', '酒红', '暗红'],
  '赭褐/土黄': ['brown', 'ochre', 'tan', 'khaki', 'earthy', 'camel', 'caramel', '赭', '褐', '土', '棕'],
  '绿色': ['green', 'jade', 'olive', '绿', '墨绿', '军绿'],
  '金色/明黄': ['gold', 'yellow', '黄', '金']
}

/** 发型/年龄锚点词典（含现代发型——2026-10-23 现代剧适配） */
const HAIR_TERMS: Record<string, string[]> = {
  '高马尾': ['high ponytail', 'ponytail', '马尾'],
  '束发冠': ['topknot', 'bun', 'hair bun', '束发', '发冠', '冠'],
  '披发/长发': ['loose hair', 'long flowing hair', 'long straight hair', 'long hair', '披发', '散发', '长发'],
  '短发': ['short hair', 'short', 'bob', 'cropped hair', 'crew cut', 'undercut', 'pixie', '寸头', '短发', '齐肩'],
  '卷发': ['curly hair', 'wavy hair', 'curly', 'wavy', 'curls', '卷发', '波浪'],
  '垂髻/少年髻': ['braid', 'child bun', '垂髻', '髻'],
  '髯/胡须': ['beard', 'moustache', 'goatee', 'stubble', '髯', '胡须', '须'],
  '白发': ['white hair', 'gray hair', 'grey hair', '白发', '灰发'],
  '光头': ['bald', 'shaved head', '光头']
}

function anchorOf(text: string, dict: Record<string, string[]>): string[] {
  const t = (text || '').toLowerCase()
  const found: string[] = []
  for (const [label, terms] of Object.entries(dict)) {
    if (terms.some(term => t.includes(term))) found.push(label)
  }
  return found
}

/** 提取角色的差异化锚点：服装主色系 + 发型/年龄 */
export function extractLookAnchors(character: Character): { colors: string[]; hairs: string[] } {
  const src = [character.appearanceLock || '', character.description || ''].join(' ')
  return { colors: anchorOf(src, COLOR_TERMS), hairs: anchorOf(src, HAIR_TERMS) }
}

/**
 * 角色资产绑定校验：
 * - conflicts（硬错误）：两个角色共享同一张定妆/参考图（faceImagePath/refImagePath/bodySheetPath resolve 后相同）
 * - similarLooks（警告）：两角色外观锚点趋同（主色系与发型均相同且无差异化气质词）
 */
export function validateCharacterAssets(characters: Character[]): { conflicts: string[]; similarLooks: string[] } {
  const conflicts: string[] = []
  const similarLooks: string[] = []
  const n = characters.length
  for (let i = 0; i < n; i++) {
    const a = characters[i]
    for (let j = i + 1; j < n; j++) {
      const b = characters[j]
      const imgA = [a.faceImagePath, a.refImagePath, a.bodySheetPath].filter(Boolean) as string[]
      const imgB = [b.faceImagePath, b.refImagePath, b.bodySheetPath].filter(Boolean) as string[]
      const shared = imgA.find(x => imgB.includes(x))
      if (shared) {
        conflicts.push(`角色「${a.name}」与「${b.name}」共享同一张人物参考图 ${shared}（角色资产冲突：每个角色必须绑定唯一人物参考图）`)
      }
      const anchorsA = extractLookAnchors(a)
      const anchorsB = extractLookAnchors(b)
      const sameColor = anchorsA.colors.some(c => anchorsB.colors.includes(c))
      const sameHair = anchorsA.hairs.some(h => anchorsB.hairs.includes(h))
      if (sameColor && sameHair) {
        similarLooks.push(`角色「${a.name}」与「${b.name}」外观趋同（主色系 ${anchorsA.colors.join('/')}、发型 ${anchorsA.hairs.join('/')} 均重叠），多角色剧易被模型并成同一张脸，请拉开服装色系/发型/年龄气质差异`)
      }
    }
  }
  return { conflicts, similarLooks }
}

/**
 * 角色混淆相对判别：本镜 selfScore（vs 本角色定妆）与其他角色定妆得分比较，
 * 若"更像其他角色"（bestOther > self + margin），判定角色混淆（张冠李戴）。
 * margin 默认 0.05：ArcFace 绝对分数受构图/光照影响，用相对差防误报。
 */
export function detectRoleConfusion(opts: {
  selfScore?: number
  otherScores: Array<{ characterId: string; name: string; score: number }>
  margin?: number
}): {
  confused: boolean
  withCharacter?: string
  withName?: string
  selfScore?: number
  bestOther?: number
} {
  const self = opts.selfScore ?? 0
  let best: { characterId: string; name: string; score: number } | null = null
  for (const o of opts.otherScores) {
    if (!best || o.score > best.score) best = o
  }
  if (!best) return { confused: false, selfScore: self }
  const margin = opts.margin ?? 0.05
  if (best.score > self + margin) {
    return {
      confused: true,
      withCharacter: best.characterId,
      withName: best.name,
      selfScore: self,
      bestOther: best.score
    }
  }
  return { confused: false, selfScore: self, bestOther: best.score }
}
