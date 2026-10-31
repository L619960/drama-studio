import type { PromptAuditIssue, PromptAuditStatus } from './ipcTypes'
import { OOC_WARDROBE_CORE, PERIOD_CUE_RE } from './promptLexicon'

/** 问题码 → 中文类型名（顶部概览与筛选共用） */
export const AUDIT_CODE_LABELS: Record<string, string> = {
  missing: '内容缺失',
  'too-short': '字数不足',
  'too-long': '字数超限',
  'chinese-char': '英文提示词混入中文',
  whitespace: '空白/换行格式异常',
  markdown: '含 Markdown 标记',
  slang: '套话词',
  'cross-project': '跨项目/跨剧情串台词',
  'sound-cue': '含声场拟音词（进图无效）',
  'era-missing': '缺时代隔离约束（易穿帮）',
  'wardrobe-conflict': '正负向服装自相矛盾',
  'displacement-unexpected': '非位移镜多写尾帧/转场',
  'frame-seconds': '时长不合规（3~6 秒）',
  'scene-drift': '同场景光线/环境漂移',
  'taboo-nudity': '敏感·色情裸露',
  'taboo-violence': '敏感·血腥暴力',
  'taboo-drugs': '敏感·违禁毒品',
  'taboo-minor': '敏感·未成年人风险',
  'taboo-politics': '敏感·政治符号',
  'taboo-weapon': '敏感·武器/危险道具',
  'taboo-substance': '敏感·烟酒赌博',
}
/** 英文提示词里混入的中日韩全角/标点字符 */
export const CJK_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/g
/** 套话（与 llmService.enforcePromptLengths 同源） */
export const SLANG_RE = /\bclearly visible\b|\bholding a [\w -]+ visible\b/gi
/** 跨项目/跨剧情串台词（旧示例项目专属元素，与 llmService.CROSS_RE 同源） */
export const CROSS_SOURCE =
  '\\b(Lin Chuan|Su Wan|barber|scissor|razor|comb|denim jacket|satchel|barber chair|mirror reflection|dog-eared photograph)\\b'
/** 时代隔离组：古装/年代剧负向必须包含（实测事故：古装酒楼镜门外开进现代 SUV） */
export const ERA_TERMS = ['no modern vehicles', 'no cars', 'no electronics', 'no asphalt road', 'no glass buildings']
/** 中文提示词里的高危敏感词（中文描述字段兜底扫描） */
export const ZH_TABOO_RE = /(裸体|全裸|性行为|色情|血腥|肢解|冰毒|海洛因|未成年)/

/** 高危服装词（lock-unaware 负向会造成"挂上/脱掉"漂移；与 imagePrompts.oocWardrobeNegativeFor 同源，
 *  词表本体由 promptLexicon.OOC_WARDROBE_CORE 单一维护） */
export const OOC_WARDROBE_TERMS = OOC_WARDROBE_CORE

/** 敏感内容规则：error=内容违规必须处理，warn=高风险但不必然违规 */
interface TabooRule {
  code: string
  level: 'error' | 'warn'
  re: RegExp
}
export const TABOO_RULES: TabooRule[] = [
  {
    code: 'taboo-nudity',
    level: 'error',
    re: /\b(nude|naked|topless|bare breasts|explicit sex|pornograph\w*|erotic|sexually explicit|undress\w*)\b/i,
  },
  {
    code: 'taboo-violence',
    level: 'error',
    re: /\b(gore|bloody wound|mutilat\w*|dismember\w*|decapitat\w*|torture|corpse|open wound|stab wound|massacre)\b/i,
  },
  {
    code: 'taboo-drugs',
    level: 'error',
    re: /\b(cocaine|heroin|methamphetamine|meth\b|fentanyl|drug paraphernalia|injecting drug)\b/i,
  },
  {
    code: 'taboo-minor',
    level: 'error',
    re: /\b(underage|minor (?:girl|boy|child)|child (?:in|wearing) (?:bikini|swimsuit|lingerie|underwear))\b/i,
  },
  {
    code: 'taboo-politics',
    level: 'error',
    re: /\b(national flag|political slogan|protest banner|military emblem|government seal|leader portrait)\b/i,
  },
  {
    code: 'taboo-weapon',
    level: 'warn',
    re: /\b(handgun|pistol|rifle|machine gun|grenade|explosive device|bomb\b|dagger)\b/i,
  },
  { code: 'taboo-substance', level: 'warn', re: /\b(cigarette|smoking|whisky|vodka|gambling|casino|slot machine)\b/i },
]

/** 可交给 AI 补写的问题码：需要语义理解（缺失/过短/串戏）。
 *  格式类问题（chinese-char / whitespace / markdown / slang / sound-cue /
 *  era-missing / wardrobe-conflict）走「一键修正」确定性修复，不进 AI；
 *  敏感内容（taboo-*）和语义硬伤（too-long / displacement-unexpected）需人工确认。 */
export const AI_FILLABLE_CODES = new Set(['missing', 'too-short', 'cross-project'])
/** 字段校验规则（字数区间缺省不校验） */
export interface FieldSpec {
  field: string
  label: string
  polarity: 'positive' | 'negative'
  lang: 'en' | 'zh'
  required: boolean
  /** [最少词数, 最多词数]（英文按词计；上限 0 = 无上限） */
  range?: [number, number]
}

/** 英文词数（与 llmService 字数校验同口径） */
export function wordCount(text: string): number {
  return text ? (text.match(/[a-zA-Z'-]+/g) || []).length : 0
}

/** 严格取字符串字段：非字符串（null/数字/数组/对象）一律视为缺失，
 *  避免 String() 把畸形值（如 "[object Object]"）当成有效提示词放行。 */
export function readStr(src: unknown, field: string): string {
  const value = (src as Record<string, unknown> | null | undefined)?.[field]
  return typeof value === 'string' ? value.trim() : ''
}

/** 段内首尾可安全删去的虚词（删除词条后遗留的悬空连接词，如 "the hiss of" → "of"） */
const EDGE_STOP = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'with',
  'for',
  'to',
  'in',
  'on',
  'at',
  'by',
  'from',
  'as',
  'into',
  'over',
  'under',
  'that',
  'this',
  'its',
  'their',
  'his',
  'her',
])

/** 收尾清理：删除空的括号/标点杂块，丢弃「只剩虚词」的碎片段，并去掉各段首尾悬空连接词。
 *  例：'the hiss of rain and the sound of chatter,   wide hall interior'
 *   → 'rain, wide hall interior'；'**beauty** (多余空白)' → 'beauty'。 */
export function tidy(text: string): string {
  const stripped = text.replace(/\s*[[({]\s*[)\]}\s,;]*\s*[)\]}]/g, ' ').replace(/\s{2,}/g, ' ')
  const segments: string[] = []
  for (const raw of stripped.split(',')) {
    const tokens = raw.trim().split(/\s+/).filter(Boolean)
    // 保留有实义词的段（含数字或 ≥2 字母的词即视为实义；纯虚词残段丢弃）
    const meaningful = tokens.some((t) => !EDGE_STOP.has(t.toLowerCase()) && /[a-z]{2,}|\d/i.test(t))
    if (!meaningful) continue
    while (tokens.length > 1 && EDGE_STOP.has((tokens[0] ?? '').toLowerCase())) tokens.shift()
    while (tokens.length > 1 && EDGE_STOP.has((tokens[tokens.length - 1] ?? '').toLowerCase())) tokens.pop()
    segments.push(tokens.join(' '))
  }
  return segments
    .join(', ')
    .replace(/,\s*,/g, ',')
    .replace(/^[,\s]+|[,\s]+$/g, '')
    .trim()
}
export function makeIssue(
  code: string,
  level: 'error' | 'warn',
  field: string,
  fieldLabel: string,
  message: string,
  fixable: boolean,
): PromptAuditIssue {
  return { code, level, field, fieldLabel, message, fixable }
}

/** 古装/年代线索（只对命中该线索的镜头做时代隔离校验，避免现代剧被误加 no cars）。
 *  判定词表由 promptLexicon.PERIOD_CUE_RE 单一维护（比流派判定宽，含服化道线索）。 */
export function hasPeriodCue(text: string): boolean {
  return PERIOD_CUE_RE.test(text || '')
}
export function statusOf(issues: PromptAuditIssue[]): PromptAuditStatus {
  if (issues.some((i) => i.level === 'error')) return 'error'
  if (issues.length > 0) return 'warn'
  return 'ok'
}

/** 问题排序：error 在前，同级按字段出现顺序 */
export function sortIssues(issues: PromptAuditIssue[]): PromptAuditIssue[] {
  return [...issues].sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1))
}
/** 声场拟音残词（stripSoundCuesForImage 走短语匹配，剥除后常留 hiss/rustle 单词残渣，
 *  进图字段里这类词毫无作用，修正时一并对单词清扫） */
export const SOUND_CUE_LEFTOVER_RE =
  /\b(hiss\w*|rustl\w*|echo\w*|ambien\w*|chatter\w*|clatter\w*|murmur\w*|creak\w*|sizzl\w*|howl\w*|footstep\w*|reverb\w*|noise|noises|sound|sounds|voice|voices)\b/gi
