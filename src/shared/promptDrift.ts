/**
 * 身份漂移/提示词中毒域：老年判定、身份漂移命中、动作内容重叠、中毒检测与修复、
 * 空镜认领角色、分镜提示词对齐。
 * 依赖：motion（actionLacksEnglish / motionCueFromAction）、castAppearance（extractOutfitLock）。
 */

import { actionLacksEnglish, motionCueFromAction } from './motion'
import { extractOutfitLock } from './castAppearance'

/** 定妆已写明老年时，允许提示词出现老年身份。 */
const ELDERLY_LOOK_RE =
  /\b(?:60s|70s|80s|90s|elderly|senior|old man|old woman|in his (?:6|7|8|9)0s|in her (?:6|7|8|9)0s)\b/i

/**
 * 视频模型会优先听「the same old man…」这类主语，压过前面的身份锁。
 * 这些短语不在定妆里、且定妆不是老年时，一律视为身份幻觉。
 */
const IDENTITY_DRIFT_RE =
  /\b(old man|old woman|elderly(?: man| woman| person)?|senior citizen|weathered face|white stubble|gr[ae]y stubble|white beard|gr[ae]y beard|white hair|silver hair)\b/gi

/** 定妆没有的服装名词。卫衣、紧身裤、牛仔是现代串戏的身份锚。 */
const FOREIGN_COAT_RE = /\b(?:[\w-]+\s+){0,3}(?:coat|gown|apron|blazer|hoodie|sweatshirt|leggings|jeans|t-shirt|shirt|sneakers|trainers|tank top|sweater|jacket|backpack|trench coat|puffer jacket)\b/gi
/** 本镜动作里没有的室内陈设/现代场景。中文 action 对不上英文时，这些词就是另一场戏。 */
const FOREIGN_PLACE_RE = /\b(doorknob|doorframe|hallway|bookshelf|floorboards?|cobwebs?|wooden door|cellar|basement|attic|kitchen|bathroom|bedroom|classroom|hospital|office|parking|sidewalk|driveway|gas station|supermarket|elevator|stairwell|corridor|warehouse|factory|apartment|dormitory)\b/gi

const ACTION_CONTENT_STOP = new Set([
  'the', 'from', 'with', 'then', 'than', 'that', 'this', 'these', 'those', 'into', 'onto',
  'over', 'under', 'while', 'their', 'there', 'here', 'have', 'has', 'had', 'his', 'her',
  'him', 'she', 'its', 'and', 'but', 'not', 'for', 'are', 'was', 'were', 'been', 'being',
  'same', 'reference', 'image', 'slight', 'slow', 'slowly', 'push', 'shot', 'pan', 'tilt',
  'arc', 'static', 'zoom', 'camera', 'rhythm', 'keeps', 'still', 'starting', 'fixed',
  'framing', 'level', 'speaking', 'naturally', 'motion'
])

export function lookAllowsElderly(lookEn: string): boolean {
  return ELDERLY_LOOK_RE.test(lookEn || '')
}

/** 提示词里与定妆冲突的身份/服装短语。空数组表示没有这类冲突。 */
export function identityDriftHits(text: string, lookEn: string): string[] {
  if (!text) return []
  const look = lookEn || ''
  const lookLower = look.toLowerCase()
  const hits: string[] = []
  if (!lookAllowsElderly(look)) {
    const re = new RegExp(IDENTITY_DRIFT_RE.source, 'gi')
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      if (!lookLower.includes(m[0].toLowerCase())) hits.push(m[0].toLowerCase())
    }
  }
  const woman = /\b(woman|female|girl)\b/i.test(look) && !/\b(man|male|boy)\b/i.test(look)
  const man = /\b(man|male|boy)\b/i.test(look) && !/\b(woman|female|girl)\b/i.test(look)
  const saysWoman = /\b(woman|women|girl|female|she|her|hers)\b/i.test(text)
  const saysMan = /\b(man|men|boy|male|he|him|his)\b/i.test(text) && !/\b(woman|women|she|her)\b/i.test(text)
  if (woman && saysMan) hits.push('man')
  if (man && saysWoman) hits.push('woman')
  const coat = new RegExp(FOREIGN_COAT_RE.source, 'gi')
  let c: RegExpExecArray | null
  while ((c = coat.exec(text))) {
    const noun = (c[0].toLowerCase().match(/coat|gown|apron|blazer|hoodie|sweatshirt|leggings|jeans|t-shirt|shirt|sneakers|trainers|tank top|sweater|jacket|backpack|trench coat|puffer jacket/) || [])[0]
    if (noun && !lookLower.includes(noun)) hits.push(c[0].toLowerCase().replace(/\s+/g, ' ').trim())
  }
  return [...new Set(hits)]
}

/** 定妆不是老年时，用正向锁年龄。不要在提示词里写 old man，写了就会被画出来。 */
export function ageLockFor(lookEn: string): string {
  if (!lookEn?.trim() || lookAllowsElderly(lookEn)) return ''
  return 'face age matches the reference image'
}

/**
 * action 内容词在 prompt 中的命中率。action 内容词不足 4 个时返回 null（无法判断）。
 * 低于 0.35 视为提示词在讲另一个故事。0.15 会放行「躲剑」提示词里夹一条走廊戏。
 */
export function actionContentOverlap(action: string, prompt: string): number | null {
  const words = (t: string): Set<string> =>
    new Set((t.toLowerCase().match(/[a-z]{4,}/g) || []).filter(w => !ACTION_CONTENT_STOP.has(w)))
  const aw = words(action || '')
  if (aw.size < 4) return null
  const pw = words(prompt || '')
  let hit = 0
  for (const w of aw) if (pw.has(w)) hit++
  return hit / aw.size
}

/** 身份与定妆冲突，或动作词几乎对不上本镜 action。
 *  sceneEn（可选）：本镜场景英文描述。加入 grounded 判定——现代剧的 office/apartment/kitchen
 *  等正常场景词若出现在本镜场景里，不判串台（2026-10-23 现代剧适配，防误拦现代场景词）。 */
export function castPromptPoisoned(action: string, prompt: string, lookEn: string, sceneEn?: string): boolean {
  if (!prompt?.trim()) return false
  if (identityDriftHits(prompt, lookEn).length > 0) return true
  if (actionLacksEnglish(action)) return true
  const grounded = `${action || ''} ${lookEn || ''} ${sceneEn || ''}`.toLowerCase()
  const place = new RegExp(FOREIGN_PLACE_RE.source, 'gi')
  if ([...prompt.matchAll(place)].some(m => !grounded.includes(m[0].toLowerCase()))) return true
  const ratio = actionContentOverlap(action, prompt)
  return ratio !== null && ratio < 0.35
}

/** 用本镜 action + 定妆服装重写视频动作提示，不再保留幻觉主语。 */
export function safeMotionFromAction(action: string, lookEn?: string): string {
  const outfit = lookEn ? extractOutfitLock(lookEn) : ''
  const act = motionCueFromAction(action)
  const anchor = outfit
    ? `the same person from the reference image, ${outfit}`
    : 'the same person from the reference image'
  return `${anchor}, ${act}, static camera, fixed framing, eye-level, smooth motion`
}

function stripDriftClauses(text: string, lookEn: string): string {
  let t = text
  for (const h of identityDriftHits(text, lookEn)) {
    const esc = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    t = t.replace(new RegExp(esc, 'gi'), '')
  }
  return t
    .replace(/\s*,\s*,\s*/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[,.\s]+|[,.\s]+$/g, '')
    .trim()
}

/**
 * 落盘与渲染共用。motion：整段换成 action 动作句。
 * frame：整段串戏则换成 action；只是夹了身份词则删掉冲突短语。
 */
export function repairCastText(
  text: string | undefined,
  action: string,
  lookEn: string,
  mode: 'motion' | 'frame'
): string | undefined {
  if (!text?.trim()) return text
  if (!castPromptPoisoned(action, text, lookEn)) return text
  if (mode === 'motion' || actionLacksEnglish(action)) return safeMotionFromAction(action, lookEn)
  const ratio = actionContentOverlap(action, text)
  if (ratio !== null && ratio < 0.35) return safeMotionFromAction(action, lookEn)
  return stripDriftClauses(text, lookEn) || safeMotionFromAction(action, lookEn)
}

export interface StoryboardPromptShot {
  type?: string
  scene?: string
  action?: string
  dialogue?: string
  characterName?: string
  characters?: string[]
  sceneEn?: string
  promptEn?: string
  firstFrameEn?: string
  midFrameEn?: string
  lastFrameEn?: string
  transitionEn?: string
  continuity?: string
  handoffToNext?: string
}

/**
 * 空镜动作里其实是角色表里的人（中文名或拼音连写，如 Chen Zhou → chenzhou）。
 * 这种镜必须改回人物镜，否则没有定妆参考，脸和服装会自由发挥。
 */
export function claimPerformer<T extends StoryboardPromptShot>(
  shot: T,
  cast: Array<{ name: string; pinyin: string }>
): { shot: T; claimed: boolean } {
  if (shot.type === 'i2v' && shot.characterName && /[\u4e00-\u9fff]/.test(shot.characterName)) {
    return { shot, claimed: false }
  }
  const raw = `${shot.action || ''} ${shot.characterName || ''} ${shot.dialogue || ''}`
  const flat = raw.toLowerCase().replace(/[^a-z\u4e00-\u9fff]+/g, '')
  const hit = cast.find(c =>
    (c.name && raw.includes(c.name)) ||
    (c.pinyin.length >= 2 && flat.includes(c.pinyin.toLowerCase()))
  )
  if (!hit) return { shot, claimed: false }
  return {
    shot: { ...shot, type: 'i2v', characterName: hit.name, characters: [hit.name] },
    claimed: true
  }
}

/**
 * 拆镜后立刻核对提示词。和本镜动作或定妆冲突的字段直接改写，不再交给模型返工。
 * 同一场景的下一镜如果没有衔接句，用上一镜动作收束补上。
 */
export function alignStoryboardPrompts<T extends StoryboardPromptShot>(
  shots: T[],
  lookOf: (shot: T) => string
): { shots: T[]; notes: string[] } {
  const notes: string[] = []
  let prev: T | undefined
  const aligned = shots.map((s, i) => {
    const look = lookOf(s)
    const action = s.action || ''
    const nxt: T = { ...s }
    const idx = i + 1
    const rewrite = (field: 'promptEn' | 'firstFrameEn' | 'midFrameEn' | 'lastFrameEn' | 'transitionEn' | 'handoffToNext' | 'continuity', mode: 'motion' | 'frame') => {
      const cur = nxt[field]
      const repaired = repairCastText(cur, action, look, mode)
      if (cur && repaired && repaired !== cur) {
        nxt[field] = repaired
        notes.push(`提示词核对：第${idx}镜 ${field} 与剧情或定妆不符，已按本镜动作改写`)
      }
    }
    rewrite('promptEn', 'motion')
    rewrite('firstFrameEn', 'frame')
    rewrite('midFrameEn', 'frame')
    rewrite('lastFrameEn', 'frame')
    rewrite('transitionEn', 'frame')
    rewrite('handoffToNext', 'frame')
    rewrite('continuity', 'frame')
    if (nxt.sceneEn && castPromptPoisoned(action, nxt.sceneEn, look)) {
      nxt.sceneEn = undefined
      notes.push(`提示词核对：第${idx}镜场景提示词串戏，已弃用，场景板改用场景名`)
    }
    if (prev && prev.scene && prev.scene === nxt.scene && prev.action && !nxt.continuity?.trim()) {
      const tail = prev.action.replace(/\s+/g, ' ').trim().split(/\s+/).slice(-18).join(' ')
      nxt.continuity = `continues immediately after the previous shot: ${tail}`
      notes.push(`提示词核对：第${idx}镜补上与上一镜的动作衔接`)
    }
    prev = nxt
    return nxt
  })
  return { shots: aligned, notes }
}
