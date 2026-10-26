import type { Project, PromptAuditTask } from './ipcTypes'
import {
  DISPLACEMENT_ACTION_RE, mergeNegative, sanitizeCinematicPrompt, stripSoundCuesForImage
} from './imagePrompts'
import {
  AI_FILLABLE_CODES, CJK_RE, ERA_TERMS, OOC_WARDROBE_TERMS, readStr, SLANG_RE,
  SOUND_CUE_LEFTOVER_RE, tidy
} from './promptAuditRules'
import { auditProjectPrompts } from './promptAuditEngine'

/** 一键修正器：仅处理确定性、无损的文本修复（语义类问题一律留给人工跳转编辑） */
type Fixer = (text: string, ctx: { period: boolean; positiveText: string }) => string

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const FIXERS: Record<string, Fixer> = {
  'chinese-char': t => tidy(t.replace(CJK_RE, ' ')),
  whitespace: t => tidy(t.replace(/\s+/g, ' ')),
  markdown: t => tidy(sanitizeCinematicPrompt(t)),
  slang: t => tidy(t.replace(SLANG_RE, ' ')),
  'sound-cue': t => tidy(stripSoundCuesForImage(t).replace(SOUND_CUE_LEFTOVER_RE, ' ')),
  'era-missing': (t, ctx) => (ctx.period ? tidy(mergeNegative(t, ERA_TERMS.join(', '))) : t),
  'wardrobe-conflict': (t, ctx) => {
    let out = t
    for (const term of OOC_WARDROBE_TERMS) {
      if (!ctx.positiveText.includes(term)) continue
      out = out.replace(new RegExp(`\\s*,?\\s*\\bno\\s+${escapeRe(term)}\\b`, 'gi'), '')
    }
    return tidy(out)
  }
}
/** 把修正结果写回克隆后的 project（只写提示词文本字段） */
export function assignField(project: Project, task: PromptAuditTask, field: string, value: string): boolean {
  if (task.scope === 'shot') {
    const shot = (project.shots || []).find(s => s.id === task.id)
    if (!shot) return false
    ;(shot as unknown as Record<string, unknown>)[field] = value
    return true
  }
  if (task.scope === 'character') {
    const character = (project.characters || []).find(c => c.id === task.id)
    if (!character) return false
    ;(character as unknown as Record<string, unknown>)[field] = value
    return true
  }
  if (task.scope === 'sceneBoard') {
    const board = (project.sceneBoards || []).find(b => b.id === task.id)
    if (!board) return false
    ;(board as unknown as Record<string, unknown>)[field] = value
    return true
  }
  if (task.scope === 'prop') {
    const prop = (project.props || []).find(p => p.id === task.id)
    if (!prop) return false
    ;(prop as unknown as Record<string, unknown>)[field] = value
    return true
  }
  return false
}
/** 读取任务某字段原文（用于修正前取当前值） */
function readField(project: Project, task: PromptAuditTask, field: string): string {
  if (task.scope === 'shot') return readStr((project.shots || []).find(s => s.id === task.id), field)
  if (task.scope === 'character') return readStr((project.characters || []).find(c => c.id === task.id), field)
  if (task.scope === 'sceneBoard') return readStr((project.sceneBoards || []).find(b => b.id === task.id), 'description')
  return readStr((project.props || []).find(p => p.id === task.id), field)
}
/**
 * 一键修正：对报告里 fixable=true 的问题执行确定性文本修复，返回**新的 project 副本**与改动字段数。
 * 不修改镜头 status / rendered 产物 / 任何非提示词字段；调用方拿到 applied>0 时自行落盘。
 */
export function applyAutoFixes(
  project: Project,
  input?: { taskIds?: string[]; now?: number }
): { project: Project; applied: number } {
  const report = auditProjectPrompts(project, { now: input?.now })
  const filter = input?.taskIds && input.taskIds.length > 0 ? new Set(input.taskIds) : null
  const clone: Project = JSON.parse(JSON.stringify(project)) as Project
  let applied = 0

  for (const task of report.tasks) {
    if (filter && !filter.has(task.id)) continue
    const positiveText = task.fields
      .filter(f => f.polarity === 'positive' && !f.system)
      .map(f => f.text)
      .join(' ')
      .toLowerCase()
    for (const field of task.fields) {
      if (field.system) continue
      const fixableIssues = task.issues.filter(i => i.field === field.field && i.fixable)
      if (fixableIssues.length === 0) continue
      const before = readField(clone, task, field.field)
      let text = before
      for (const issue of fixableIssues) {
        const fixer = FIXERS[issue.code]
        if (!fixer) continue
        text = fixer(text, { period: true, positiveText })
      }
      if (text === before) continue
      if (assignField(clone, task, field.field, text)) applied++
    }
  }
  return { project: clone, applied }
}
// ===== 批量 AI 补写：字段元数据与需补写字段抽取 =====

/** 字段补写指南：该字段应该描述什么、字数区间、必须/禁止项，供 LLM 构造 system prompt。 */
export interface FieldFillGuide {
  field: string
  label: string
  lang: 'en' | 'zh'
  /** 输出字数区间；上限 0 = 无上限 */
  range: [number, number]
  /** 该字段的职责描述（给 LLM 的角色说明核心句） */
  role: string
  /** 必须包含的语义要素（按上下文动态拼接，这里只给固定项） */
  mustInclude?: string[]
  /** 禁止出现的内容（与渲染铁律对齐） */
  mustAvoid?: string[]
}
const COMMON_AVOID = [
  'Markdown 标记（* 号、# 号）',
  '解释性句子、引号、换行',
  '人物外貌/服装描述（身份锚定妆已锁，禁止重写外观）',
  '套话词（clearly visible / holding a ... visible）',
  '其他项目/剧情的串台词（雨夜理发店、白裙寻亲等）'
]
/** 镜头各字段补写指南（i2v/t2v 共用，差异在调用方传入 type） */
function shotFillGuides(isI2v: boolean, displacement: boolean): FieldFillGuide[] {
  const list: FieldFillGuide[] = [
    {
      field: 'promptEn',
      label: isI2v ? '正向提示词（i2v 视频）' : '正向提示词（t2v 空镜视频）',
      lang: 'en',
      range: isI2v ? [60, 110] : [80, 130],
      role: isI2v
        ? 'AI 图生视频的 motion-first 运动提示词：四段短结构——①身份锚 the same [角色名] from the reference image + 3~5 个定妆已锁的服装道具词 ②可观察事件链核心动作（起始定格→程度词单一原子动作→结束定格位置，逐字呼应 action 的动词与道具名）③单条微运镜或 static + fixed framing ④节奏词 + smooth motion, no sudden movement'
        : 'AI 文生视频空镜提示词：场景概念结构——场景物理特征 + 光源类型/光线类型/时间段 + 景别 + 构图 + 色调 + 单条运镜，只写环境情绪与光线变化',
      mustAvoid: [...COMMON_AVOID, '外貌与服装描述（身份锚服装词除外）']
    },
    {
      field: 'negativeEn',
      label: '镜级负向提示词（增量风险，可选）',
      lang: 'en',
      range: [0, 20],
      role: '本镜增量风险英文负向提示词（0~20 词，可选，无增量风险可省略该字段）。通用漂移/画质/字幕/转场压制由渲染层系统负向统一注入，禁止照抄（no morphing / no clothing change / no extra limbs / no sudden movement / no large displacement / no position shift / no extra characters / consistent background 等一律不写）。只写本镜剧情特有的增量风险：夜景/室内镜加 no lighting flicker；古装/年代镜加时代隔离组 no modern vehicles, no cars, no electronics, no asphalt road, no glass buildings, no billboards（现代剧省略——实测事故：古装酒楼镜门外开进一辆现代 SUV，根因即缺时代词）；本镜特有道具变形/场景串台/动作倒放按实际风险选词',
      mustAvoid: ['照抄系统已覆盖词（no morphing / no clothing change / no extra limbs / no sudden movement / no large displacement / no position shift / no extra characters / consistent background / no subtitles / no watermark / no text 等一律不写）', '照抄通用皮肤瑕疵词（REALISM_NEGATIVE 已注入）', '与正向身份锚冲突的服装词（如定妆是西装就不能写 no blazer）']
    },
    {
      field: 'sceneEn',
      label: '环境短语（进图/进视频）',
      lang: 'en',
      range: [30, 60],
      role: '本镜英文环境短语：地点物理特征 + 天气时刻 + 光线强度/方向 + 时代特征 + 空气/远景层次 + 该镜剧情氛围句与 tone；同一场景多镜保持同一物理地点与光源方向',
      mustAvoid: [...COMMON_AVOID]
    }
  ]
  if (isI2v) {
    list.push({
      field: 'firstFrameEn', label: '首帧提示词（T2I）', lang: 'en', range: [20, 50],
      role: 'T2I 首帧画面描述：动作起点姿态 + 站位 + 景别 + 表情 + 光线，不写外貌服装',
      mustAvoid: [...COMMON_AVOID]
    })
  }
  list.push({
    field: 'midFrameEn', label: '中帧提示词（T2I，可选）', lang: 'en', range: [20, 40],
    role: 'T2I 中帧画面描述：动作进行中的关键过渡姿态；纯静态镜可省略',
    mustAvoid: [...COMMON_AVOID]
  })
  if (isI2v && displacement) {
    list.push({
      field: 'lastFrameEn', label: '尾帧提示词（T2I）', lang: 'en', range: [20, 50],
      role: 'T2I 尾帧画面描述：位移动作完成态 + 离开方向 + 光效收束 + 道具状态；必须与首帧同一人物同一服装',
      mustAvoid: [...COMMON_AVOID]
    })
    list.push({
      field: 'transitionEn', label: '首尾帧转场提示词（flf2v）', lang: 'en', range: [60, 120],
      role: 'flf2v 转场过程提示词：起始帧→结束帧的动态转场过程，按动作的位移路径拆解为 2~3 段，禁人名、禁技能词、禁文学修辞',
      mustAvoid: [...COMMON_AVOID]
    })
  }
  list.push({
    field: 'handoffToNext', label: '下镜衔接状态（可选）', lang: 'en', range: [10, 25],
    role: '本镜尾帧结束时的人物位置/姿态/道具归属，供下一镜首帧承接；末镜省略',
    mustAvoid: [...COMMON_AVOID]
  })
  return list
}
function characterFillGuides(): FieldFillGuide[] {
  return [
    {
      field: 'appearanceLock', label: '角色卡外观锁（英文，逐字复用）', lang: 'en', range: [40, 0],
      role: '角色英文外观锁：年龄+脸型+五官特征+肤色肤质+发型发色+服装（材质/颜色/款式）+体型+可辨识配饰；纯视觉特征，逗号分隔短语，是后续所有出图/视频的身份锚，必须稳定可逐字复用',
      mustAvoid: ['Markdown', '解释性文字', '抽象人格/性格词']
    },
    {
      field: 'description', label: '外貌描述（中文）', lang: 'zh', range: [20, 80],
      role: '角色中文外貌描述：年龄段、脸型五官、肤色、发型发色、典型服装、体型气质；用于 UI 展示与 LLM 二次理解',
      mustAvoid: ['Markdown', '解释性文字', '性格/背景故事']
    }
  ]
}
function sceneBoardFillGuides(): FieldFillGuide[] {
  return [{
    field: 'description', label: '场景视觉提示词（英文，驱动场景板 T2I）', lang: 'en', range: [40, 80],
    role: '场景板 T2I 视觉描述：地点物理结构 + 时代特征 + 光线（时刻/主光方向/色温）+ 材质纹理 + 色调氛围 + 远景层次；纯环境，不写人物',
    mustAvoid: ['人物', 'Markdown', '解释性文字']
  }]
}
function propFillGuides(): FieldFillGuide[] {
  return [
    {
      field: 'description', label: '道具形态描述（英文，锁形）', lang: 'en', range: [10, 30],
      role: '道具形态描述：材质 + 颜色 + 关键外形特征 + 磨损/使用痕迹；锁形用，后续出图逐字复用',
      mustAvoid: ['Markdown', '解释性文字']
    },
    {
      field: 'en', label: '道具英文名', lang: 'en', range: [1, 8],
      role: '道具英文名词（1~3 词），用于动作提示词中引用该道具',
      mustAvoid: ['形容词堆叠', 'Markdown']
    }
  ]
}
/** 取某任务所有字段的补写指南（按任务类型分发） */
export function fillGuidesFor(task: PromptAuditTask, project: Project): FieldFillGuide[] {
  if (task.scope === 'shot') {
    const shot = (project.shots || []).find(s => s.id === task.id)
    if (!shot) return []
    const isI2v = shot.type === 'i2v'
    const displacement = DISPLACEMENT_ACTION_RE.test(shot.action || '')
    return shotFillGuides(isI2v, displacement)
  }
  if (task.scope === 'character') return characterFillGuides()
  if (task.scope === 'sceneBoard') return sceneBoardFillGuides()
  return propFillGuides()
}
/** 从一个任务抽取「需要 AI 补写」的字段列表：有 AI_FILLABLE 问题、非系统字段、非敏感内容。 */
export function fillableFieldsOf(
  task: PromptAuditTask,
  project: Project
): Array<{ guide: FieldFillGuide; current: string }> {
  const guides = fillGuidesFor(task, project)
  const fillableFields = new Set(
    task.issues
      .filter(i => AI_FILLABLE_CODES.has(i.code) && !task.fields.find(f => f.field === i.field)?.system)
      .map(i => i.field)
  )
  const out: Array<{ guide: FieldFillGuide; current: string }> = []
  for (const guide of guides) {
    if (!fillableFields.has(guide.field)) continue
    const current = task.fields.find(f => f.field === guide.field)?.text ?? ''
    out.push({ guide, current })
  }
  return out
}
