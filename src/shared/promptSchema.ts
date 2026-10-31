/**
 * 拆镜提示词规范层（2026-10-31）：
 * LLM 拆剧本产出的每个英文提示词字段都会被后续「场景图 / 首帧 / 视频」直接当提示词用，
 * 因此必须写得全、写得准、能被模型直接执行。本层是确定性兜底（不调 LLM、不改剧情）：
 * 1) 字段清洗：单行纯文本、去 Markdown、剥离英文提示词里的中文残留；
 * 2) 缺失补齐：camera/lighting/emotion/facing/continuity/frameSeconds/transition/
 *    firstFrameEn/promptEn/handoffToNext 一律补成标准英文；
 * 3) 同场景一致性：同一物理地点的 sceneEn / lighting 全剧统一，杜绝逐镜换地点、忽昼忽夜；
 * 4) 负向去重：剥离渲染层已统一注入的通用负向，现代剧剥离时代隔离词（避免误压正常现代场景）。
 * 原则：只补标准值、只统一同场景锚点，不删改 LLM 已写好的剧情内容。
 */
import type { AnalyzeScene, AnalyzedShot } from './ipcTypes'
import { extractOutfitLock } from './castAppearance'
import { shotSizeCueFor } from './scenePrompts'
import { CJK_RE, ERA_TERMS, hasPeriodCue, wordCount } from './promptAuditRules'
import { INDOOR_LIGHTING_RE } from './promptLexicon'

/** 英文提示词字段：必须单行英文短语；中文残留会稀释模型权重 */
export const ENGLISH_PROMPT_FIELDS = [
  'sceneEn',
  'promptEn',
  'negativeEn',
  'firstFrameEn',
  'midFrameEn',
  'lastFrameEn',
  'handoffToNext',
  'transitionEn',
  'camera',
  'lighting',
  'facing',
  'continuity',
  'emotion',
] as const

/** 渲染层已统一注入的通用负向词：镜级 negativeEn 重复写只会稀释本镜真正的增量风险 */
const SYSTEM_NEGATIVE_TERMS = [
  'no morphing',
  'no clothing change',
  'no extra limbs',
  'no sudden movement',
  'no large displacement',
  'no position shift',
  'no extra characters',
  'no extra people',
  'no background crowd',
  'consistent background',
  'no subtitles',
  'no watermark',
  'no text',
  'no distorted hands',
  'no distorted limbs',
]

const NIGHT_RE = /夜|晚|midnight|night|moon|moonlit|dark\b|evening|dusk/i
const RAIN_RE = /雨|rain|overcast|storm|雾|fog|haze|snow|snowy/i
const GOLDEN_RE = /黄昏|日落|sunset|golden hour|dawn|黎明|日出|morning|晨光/i

const CAMERA_ANGLE_RE =
  /\b(eye-level|low angle|high angle|aerial|over-shoulder|three-quarter|bird'?s eye|worm'?s eye|top-down|dutch angle)\b/i
const CAMERA_LENS_RE = /\b\d{2,3}\s?mm\b|\blens\b|depth of field|bokeh/i

/** 单行纯文本 + 去 Markdown + 收敛逗号空白（保留句首冠词，不做虚词裁剪） */
function oneLine(text: string): string {
  return text
    .replace(/\r?\n|\t/g, ' ')
    .replace(/[*#`]/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/,\s*,+/g, ',')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim()
}

/** 英文提示词清洗：剥中文残留后仍无英文则视为缺失（由调用方补标准值） */
export function sanitizeEnglishField(text?: string | null): string | undefined {
  if (typeof text !== 'string' || !text.trim()) return undefined
  const cleaned = oneLine(text.replace(CJK_RE, ' '))
  return /[a-zA-Z]/.test(cleaned) ? cleaned : undefined
}

function clampWords(text: string, max: number): string {
  const words = oneLine(text).split(/\s+/).filter(Boolean)
  if (words.length <= max) return words.join(' ')
  const out = words.slice(0, max).join(' ')
  return /[.!?]$/.test(out) ? out : `${out}.`
}

/** 光线兜底（正向描述；按场景文本推断时段与环境，避免给夜景配日光） */
export function defaultLightingFor(sceneText: string): string {
  const t = sceneText || ''
  if (NIGHT_RE.test(t) && RAIN_RE.test(t)) {
    return 'cool streetlight practical key from camera-left, wet reflections, low-key night exposure'
  }
  if (NIGHT_RE.test(t)) return 'cool moonlight key from camera-left, low-key exposure, deep shadows'
  if (RAIN_RE.test(t)) return 'overcast diffused daylight, soft even exposure from camera-left, muted contrast'
  if (GOLDEN_RE.test(t)) return 'warm golden-hour backlight from camera-left, soft rim light, gentle shadows'
  if (INDOOR_LIGHTING_RE.test(t))
    return 'warm practical interior key light from camera-left, soft shadows, natural falloff'
  return 'soft natural daylight key from camera-left, balanced exposure, gentle shadows'
}

/** 镜头参数兜底：机位高度 + 焦距 + 景深，按景别给标准值 */
export function defaultCameraFor(shotSize?: string): string {
  if ((shotSize || '').toLowerCase() === 'closeup') {
    return '85mm portrait lens, shallow depth of field, eye-level static'
  }
  if ((shotSize || '').toLowerCase() === 'wide') {
    return '24mm wide lens, deep depth of field, eye-level static'
  }
  return '50mm lens, medium depth of field, eye-level static'
}

/** 景别对应的镜头参数（焦距 + 景深），用于补全 camera 缺项 */
function lensFor(shotSize?: string): string {
  return defaultCameraFor(shotSize)
    .split(',')
    .slice(0, 2)
    .map((s) => s.trim())
    .join(', ')
}

/** 统一机位/镜头描述：缺机位高度补 eye-level，缺焦距景深补对应景别标准值 */
function ensureCamera(text: string | undefined, shotSize?: string): string {
  let out = text || defaultCameraFor(shotSize)
  if (!CAMERA_ANGLE_RE.test(out)) out = `${out}, eye-level`
  if (!CAMERA_LENS_RE.test(out)) out = `${out}, ${lensFor(shotSize)}`
  return oneLine(out)
}

/** 时长兜底：中文台词 4 字/秒 + 情绪/动作缓冲 2 秒，收敛到 3~6 秒 */
export function frameSecondsFor(dialogue?: string, frameSeconds?: number): number {
  if (typeof frameSeconds === 'number' && Number.isFinite(frameSeconds)) {
    const rounded = Math.round(frameSeconds)
    if (rounded >= 3 && rounded <= 6) return rounded
  }
  const chars = (dialogue || '').replace(/[^\u4e00-\u9fff]/g, '').length
  if (chars === 0) return 3
  return Math.min(6, Math.max(3, Math.ceil(chars / 4) + 2))
}

/** i2v 正向提示词兜底：身份锚 + 本镜动作 + 景别 + 情绪，全部取自已锁数据，不脑补剧情 */
function buildMotionPrompt(shot: AnalyzedShot, lookEn: string): string {
  const outfit = extractOutfitLock(lookEn || '')
  const anchor = outfit
    ? `the same person from the reference image, ${outfit}`
    : 'the same person from the reference image'
  const action = sanitizeEnglishField(shot.action) || 'holds the opening pose of this shot'
  const parts = [anchor, action, shotSizeCueFor(shot.shotSize), shot.emotion || 'calm, restrained', 'smooth motion']
  return clampWords(parts.join(', '), 110)
}

/** t2v 空镜正向提示词兜底：环境 + 光线 + 机位 + 氛围 */
function buildScenePrompt(shot: AnalyzedShot, sceneEn: string | undefined, lighting: string, camera: string): string {
  const parts = [sceneEn, lighting, camera, shot.emotion || 'quiet, atmospheric'].filter(Boolean).join(', ')
  return clampWords(parts, 130)
}

/** 首帧兜底：动作起点姿态 + 景别 + 情绪 + 光线（不写外貌服装） */
function buildFirstFrame(shot: AnalyzedShot, lighting: string): string {
  const action = sanitizeEnglishField(shot.action) || 'the character holds the opening pose'
  const parts = [
    action,
    shotSizeCueFor(shot.shotSize),
    shot.emotion || 'calm, restrained',
    lighting,
    'static posture at the start of the shot',
  ]
  return clampWords(parts.join(', '), 50)
}

/** 下镜衔接兜底：优先取本镜尾帧状态，其次动作收束 */
function buildHandoff(shot: AnalyzedShot, isLast: boolean): string | undefined {
  if (isLast) return undefined
  if (shot.lastFrameEn) return clampWords(`at the end of the shot: ${shot.lastFrameEn}`, 25)
  if (shot.type === 't2v') {
    return 'at the end of the shot the location stays unchanged, same light direction and same composition'
  }
  return 'at the end of the shot the character holds the final pose of this action, same position and same wardrobe'
}

/** 负向清洗：去中文残留、去系统已覆盖的通用词、现代剧去时代隔离词 */
function cleanNegative(text: string | undefined, period: boolean): string | undefined {
  let out = sanitizeEnglishField(text)
  if (!out) return undefined
  for (const term of SYSTEM_NEGATIVE_TERMS) {
    out = out.replace(new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '')
  }
  if (!period) {
    for (const term of ERA_TERMS) {
      out = out.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '')
    }
  }
  out = oneLine(out)
  out = clampWords(out, 20)
  return /[a-zA-Z]/.test(out) ? out : undefined
}

export interface PromptSchemaOptions {
  /** 场景清单（提供同场景统一的环境基底） */
  scenes?: AnalyzeScene[] | undefined
  /** 取某镜角色的外观锁（lookEn），用于补身份锚 */
  lookOf?: ((shot: AnalyzedShot) => string) | undefined
  /** 全剧题材（判定是否古装/年代，决定时代负向是否保留） */
  genre?: string | undefined
}

/**
 * 拆镜字段规范化主入口（确定性、幂等）。
 * 只补标准值与同场景锚点，不重写 LLM 已写好的剧情内容；返回 notes 供落盘告警。
 */
export function normalizeShotPrompts(
  shots: AnalyzedShot[],
  opts: PromptSchemaOptions = {},
): { shots: AnalyzedShot[]; notes: string[] } {
  const sceneBase = new Map<string, string>()
  for (const sc of opts.scenes || []) {
    const en = sanitizeEnglishField(sc.en)
    if (en) sceneBase.set(sc.name.trim(), clampWords(en, 60))
  }

  // 同场景光线基准：取该场景第一条有效 lighting；没有就按场景文本推断
  const lightingBase = new Map<string, string>()
  for (const s of shots) {
    const key = s.scene.trim()
    if (lightingBase.has(key)) continue
    const own = sanitizeEnglishField(s.lighting)
    const inferred = defaultLightingFor(`${key} ${sceneBase.get(key) || sanitizeEnglishField(s.sceneEn) || ''}`)
    lightingBase.set(key, own || inferred)
  }

  const filled = new Map<string, number[]>()
  const noteField = (field: string, idx: number): void => {
    const list = filled.get(field) || []
    list.push(idx)
    filled.set(field, list)
  }
  const unifiedScene: number[] = []
  const unifiedLight: number[] = []

  const out = shots.map((shot, i) => {
    const idx = i + 1
    const key = shot.scene.trim()
    const period = hasPeriodCue(`${opts.genre || ''} ${shot.scene || ''} ${shot.action || ''}`)
    const nxt: AnalyzedShot = { ...shot }

    // —— 1) 英文提示词字段统一清洗（中文残留剔除；清洗后无英文视为缺失）——
    for (const field of ENGLISH_PROMPT_FIELDS) {
      const cur = shot[field as keyof AnalyzedShot]
      if (typeof cur === 'string') {
        const cleaned = sanitizeEnglishField(cur)
        ;(nxt as unknown as Record<string, string | undefined>)[field] = cleaned
        if (cur.trim() && !cleaned) noteField(field, idx)
      }
    }
    // action 是剧情原文的英文动作描述：混写时剥中文；纯中文保留原文（交由审计标记，不销毁内容）
    const act = sanitizeEnglishField(shot.action)
    if (act) nxt.action = act

    // —— 2) 同场景环境基底统一（同一物理地点，全剧逐字复用）——
    const base = sceneBase.get(key)
    if (base) {
      if (nxt.sceneEn !== base) {
        if (nxt.sceneEn) unifiedScene.push(idx)
        nxt.sceneEn = base
      }
    } else if (!nxt.sceneEn) {
      noteField('sceneEn', idx)
    }

    // —— 3) 光线：同场景统一，缺失补标准值（杜绝忽昼忽夜）——
    const canonLight = lightingBase.get(key) || defaultLightingFor(key)
    if (nxt.lighting !== canonLight) {
      if (nxt.lighting) unifiedLight.push(idx)
      else noteField('lighting', idx)
      nxt.lighting = canonLight
    }

    // —— 4) 镜头 / 情绪 / 朝向 / 承接 ——
    const cam = ensureCamera(nxt.camera, shot.shotSize)
    if (!nxt.camera) noteField('camera', idx)
    nxt.camera = cam
    if (!nxt.emotion) {
      nxt.emotion = shot.type === 'i2v' ? 'calm, restrained' : 'quiet, atmospheric'
      noteField('emotion', idx)
    }
    if (shot.type === 'i2v') {
      if (!nxt.facing) {
        nxt.facing = 'facing camera, centered in frame'
        noteField('facing', idx)
      }
      if (!nxt.continuity) {
        const prev = shots[i - 1]
        nxt.continuity =
          prev && prev.scene.trim() === key
            ? 'continues from the previous shot end state in the same location'
            : 'standing in the opening pose of this shot'
        noteField('continuity', idx)
      }
    }

    // —— 5) 时长 / 切镜 / 帧提示词 ——
    const secs = frameSecondsFor(shot.dialogue, shot.frameSeconds)
    if (shot.frameSeconds !== secs) noteField('frameSeconds', idx)
    nxt.frameSeconds = secs
    if (!['hard', 'dissolve', 'smash'].includes(String(nxt.transition || ''))) {
      nxt.transition = 'hard'
      noteField('transition', idx)
    }
    if (shot.type === 'i2v' && (!nxt.firstFrameEn || wordCount(nxt.firstFrameEn) < 12)) {
      nxt.firstFrameEn = buildFirstFrame(shot, canonLight)
      noteField('firstFrameEn', idx)
    }
    if (!nxt.promptEn || wordCount(nxt.promptEn) < 20) {
      nxt.promptEn =
        shot.type === 'i2v'
          ? buildMotionPrompt(shot, opts.lookOf?.(shot) || '')
          : buildScenePrompt(shot, nxt.sceneEn, canonLight, cam)
      noteField('promptEn', idx)
    }

    // —— 6) 负向去重 / 时代词按题材保留 ——
    const negative = cleanNegative(shot.negativeEn, period)
    if (negative === undefined) delete nxt.negativeEn
    else nxt.negativeEn = negative

    // —— 7) 下镜衔接 ——
    const isLast = i === shots.length - 1
    if (!nxt.handoffToNext) {
      const built = buildHandoff(shot, isLast)
      if (built) {
        nxt.handoffToNext = built
        noteField('handoffToNext', idx)
      }
    }
    if (isLast) delete nxt.handoffToNext

    // —— 8) 道具：去空、去重、保留英文名 ——
    if (shot.props?.length) {
      nxt.props = [...new Set(shot.props.map((p) => oneLine(String(p))).filter(Boolean))]
    }

    return nxt
  })

  const notes: string[] = []
  const brief = (ids: number[]): string =>
    ids.length <= 6 ? `${ids.join('、')} 镜` : `${ids.slice(0, 6).join('、')} 镜 等 ${ids.length} 镜`
  for (const [field, ids] of filled) {
    if (!ids.length) continue
    notes.push(`提示词规范化：第 ${brief(ids)} 的 ${field} 已补标准英文值`)
  }
  if (unifiedScene.length) notes.push(`提示词规范化：第 ${brief(unifiedScene)} 的 sceneEn 已统一为同场景环境基底`)
  if (unifiedLight.length) notes.push(`提示词规范化：第 ${brief(unifiedLight)} 的 lighting 已统一为同场景光源方向`)
  return { shots: out, notes }
}
