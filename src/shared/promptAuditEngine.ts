import type {
  Character, Project, PromptAuditField, PromptAuditIssue, PromptAuditReport,
  PromptAuditTask, PropAsset, SceneBoard, Shot
} from './ipcTypes'
import { normalizeSceneKey } from './ipcTypes'
import {
  DISPLACEMENT_ACTION_RE, REALISM_NEGATIVE, mergeNegative,
  sceneNegativeFor, stripSoundCuesForImage
} from './imagePrompts'
import {
  AUDIT_CODE_LABELS, CJK_RE, CROSS_SOURCE, ERA_TERMS, FieldSpec, hasPeriodCue,
  makeIssue, OOC_WARDROBE_TERMS, readStr, SLANG_RE, SOUND_CUE_LEFTOVER_RE,
  sortIssues, statusOf, TABOO_RULES, wordCount, ZH_TABOO_RE
} from './promptAuditRules'

/** 单字段完整性 + 格式 + 敏感内容校验 */
function checkField(
  spec: FieldSpec,
  text: string,
  issues: PromptAuditIssue[],
  opts: { soundCue: boolean; period: boolean }
): void {
  const blank = !text
  if (blank) {
    if (spec.required) {
      issues.push(makeIssue(
        'missing', 'error', spec.field, spec.label,
        `「${spec.label}」缺失（空）：渲染将回退通用模板，本任务的画面/身份锁会失效，请补齐`,
        false
      ))
    }
    return
  }
  if (spec.lang === 'en') {
    if (CJK_RE.test(text)) {
      CJK_RE.lastIndex = 0
      issues.push(makeIssue(
        'chinese-char', 'warn', spec.field, spec.label,
        `「${spec.label}」为英文提示词却混入中文字符：模型只识别英文，中文字符会稀释权重，建议删除`,
        true
      ))
    }
    if (/\s{2,}|\n|\t|\r/.test(text)) {
      issues.push(makeIssue(
        'whitespace', 'warn', spec.field, spec.label,
        `「${spec.label}」含多余空白/换行/制表符：提示词必须是单行纯文本，多余空白会干扰分词`,
        true
      ))
    }
    if (/\*{1,}/.test(text)) {
      issues.push(makeIssue(
        'markdown', 'warn', spec.field, spec.label,
        `「${spec.label}」含 Markdown 星号：模型会把 ** 当画面元素，需净化`,
        true
      ))
    }
    SLANG_RE.lastIndex = 0
    const slang = SLANG_RE.exec(text)
    if (slang) {
      issues.push(makeIssue(
        'slang', 'warn', spec.field, spec.label,
        `「${spec.label}」含套话词 "${slang[0]}"：空断言对模型无效且干扰权重，需删除`,
        true
      ))
    }
    const cross = new RegExp(CROSS_SOURCE, 'i').exec(text)
    if (cross) {
      issues.push(makeIssue(
        'cross-project', 'error', spec.field, spec.label,
        `「${spec.label}」出现其他剧情/其他项目的串台词 "${cross[0]}"：本任务讲的是别的故事，必须按本镜内容重写`,
        false
      ))
    }
    if (spec.range) {
      const [min, max] = spec.range
      const n = wordCount(text)
      if (n < min) {
        issues.push(makeIssue(
          'too-short', 'warn', spec.field, spec.label,
          `「${spec.label}」仅 ${n} 词，低于下限 ${min} 词：信息量不足以锁画面/身份，建议补写`,
          false
        ))
      } else if (max > 0 && n > max) {
        issues.push(makeIssue(
          'too-long', 'warn', spec.field, spec.label,
          `「${spec.label}」${n} 词，超出上限 ${max} 词：过长会稀释关键信息、拖慢推理，建议精简`,
          false
        ))
      }
    }
    if (opts.soundCue && (stripSoundCuesForImage(text) !== text || SOUND_CUE_LEFTOVER_RE.test(text))) {
      SOUND_CUE_LEFTOVER_RE.lastIndex = 0
      issues.push(makeIssue(
        'sound-cue', 'warn', spec.field, spec.label,
        `「${spec.label}」含声场拟音词（hiss/rustle/ambience/sound of 等）：出图端不响应声音描述，只会稀释视觉权重，建议剥除`,
        true
      ))
    }
  } else if (ZH_TABOO_RE.test(text)) {
    issues.push(makeIssue(
      'taboo-violence', 'error', spec.field, spec.label,
      `「${spec.label}」含敏感内容词：请立即删除违规描述`,
      false
    ))
  }
  if (opts.period && spec.field === 'negativeEn') {
    const low = text.toLowerCase()
    if (!ERA_TERMS.some(t => low.includes(t))) {
      issues.push(makeIssue(
        'era-missing', 'warn', spec.field, spec.label,
        `「${spec.label}」缺时代隔离约束（如 no modern vehicles / no electronics）：古装/年代镜头实测会出现窗外现代车辆等穿帮，建议补写`,
        true
      ))
    }
  }
  for (const rule of TABOO_RULES) {
    const m = rule.re.exec(text)
    if (!m) continue
    issues.push(makeIssue(
      rule.code, rule.level, spec.field, spec.label,
      `「${spec.label}」命中敏感内容 "${m[0]}"（${AUDIT_CODE_LABELS[rule.code]}）：可能被平台风控拦截，请改写`,
      false
    ))
  }
}
function shotSizeLabel(shot: Shot): string {
  switch (shot.shotSize) {
    case 'closeup': return '特写'
    case 'wide': return '远景'
    case 'medium': return '中景'
    default: return '景别未设'
  }
}
const LIGHT_TIME_CUE_RE = /\b(golden hour|night|midnight|moonlight|moonlit|daylight|sunset|sunrise|dawn|dusk|overcast|morning|evening)\b/
const LIGHT_DIRECTION_CUE_RE = /\b(camera-left|camera-right|from above|overhead|top|backlight|back|front|left|right)\b/i

/** 光线时段/主光方向特征：用于同场景跨镜比对（忽昼忽夜、主光左右反转的直接判据） */
function primaryLightCue(text: string): string {
  const low = (text || '').toLowerCase()
  const time = (low.match(LIGHT_TIME_CUE_RE) || [])[0] || ''
  const dir = (low.match(LIGHT_DIRECTION_CUE_RE) || [])[0] || ''
  return `${time}|${dir}`
}
/** 取英文短语的前 N 个实义词（场景基底比对用） */
function leadWords(text: string, n = 6): string[] {
  return (text.toLowerCase().match(/[a-z]{2,}/g) || []).slice(0, n)
}
/** 同场景漂移基线：由全项目预计算一次，逐镜审计时只做比对 */
export interface ShotDriftBaseline {
  /** 场景键 → 该场景首镜的光线时段/方向特征 */
  lighting: Map<string, string>
  /** 场景键 → 场景板英文描述的前 6 个实义词 */
  sceneBoard: Map<string, string[]>
}
export function buildShotDriftBaseline(shots: Shot[], project: Project): ShotDriftBaseline {
  const lighting = new Map<string, string>()
  for (const s of shots) {
    const key = normalizeSceneKey(s.scene || '')
    if (lighting.has(key)) continue
    const cue = primaryLightCue(readStr(s, 'lighting'))
    if (cue.replace('|', '')) lighting.set(key, cue)
  }
  const sceneBoard = new Map<string, string[]>()
  for (const board of project.sceneBoards || []) {
    const desc = readStr(board, 'description')
    if (!desc) continue
    sceneBoard.set(normalizeSceneKey(board.name || ''), leadWords(desc))
  }
  return { lighting, sceneBoard }
}
/** 镜头任务：i2v 人物镜（首帧 T2I + 视频）/ t2v 空镜（文生视频） */
function auditShot(shot: Shot, project: Project, baseline?: ShotDriftBaseline): PromptAuditTask {
  const isI2v = shot.type === 'i2v'
  // 时代锁定：本镜（或全剧题材）命中古装/年代线索才校验时代隔离，现代剧不误伤
  const period = hasPeriodCue(`${project.genre || ''} ${shot.scene || ''} ${shot.action || ''}`)
  const displacement = DISPLACEMENT_ACTION_RE.test(shot.action || '')
  const specs: FieldSpec[] = [
    { field: 'action', label: '动作提示词（英文）', polarity: 'positive', lang: 'en', required: true, range: [10, 45] },
    { field: 'camera', label: '镜头机位/运镜', polarity: 'positive', lang: 'en', required: true, range: [3, 18] },
    { field: 'lighting', label: '光线条件', polarity: 'positive', lang: 'en', required: true, range: [3, 18] },
    { field: 'emotion', label: '情绪短语', polarity: 'positive', lang: 'en', required: true, range: [1, 10] },
    ...(isI2v
      ? [
        { field: 'facing', label: '人物朝向与画面位置', polarity: 'positive' as const, lang: 'en' as const, required: true, range: [3, 18] as [number, number] },
        { field: 'continuity', label: '动作起点承接', polarity: 'positive' as const, lang: 'en' as const, required: true, range: [3, 25] as [number, number] }
      ]
      : []),
    {
      field: 'promptEn',
      label: isI2v ? '正向提示词（视频）' : '正向提示词（空镜视频）',
      polarity: 'positive', lang: 'en', required: true,
      range: isI2v ? [60, 110] : [80, 130]
    },
    { field: 'negativeEn', label: '镜级负向提示词（增量风险，可选）', polarity: 'negative', lang: 'en', required: false, range: [0, 20] },
    { field: 'sceneEn', label: '环境短语（进图/进视频）', polarity: 'positive', lang: 'en', required: true, range: [30, 60] },
    ...(isI2v
      ? [{ field: 'firstFrameEn', label: '首帧提示词（T2I）', polarity: 'positive' as const, lang: 'en' as const, required: true, range: [20, 50] as [number, number] }]
      : []),
    { field: 'midFrameEn', label: '中帧提示词（T2I，可选）', polarity: 'positive', lang: 'en', required: false, range: [20, 40] },
    ...(isI2v
      ? [
        { field: 'lastFrameEn', label: '尾帧提示词（T2I）', polarity: 'positive' as const, lang: 'en' as const, required: displacement, range: [20, 50] as [number, number] },
        { field: 'transitionEn', label: '首尾帧转场提示词（flf2v）', polarity: 'positive' as const, lang: 'en' as const, required: displacement, range: [60, 120] as [number, number] }
      ]
      : []),
    { field: 'handoffToNext', label: '下镜衔接状态（可选）', polarity: 'positive', lang: 'en', required: false, range: [10, 25] }
  ]

  const fields: PromptAuditField[] = []
  const issues: PromptAuditIssue[] = []
  const read = (f: string): string => readStr(shot, f)
  // 声场拟音词只在「纯进图」字段上算问题：sceneEn 按设计保留拟音供视频声场，
  // 由 imagePrompts.stripSoundCuesForImage 在 T2I 入口剥除，故 sceneEn 不检该项。
  const soundCueFields = new Set(['firstFrameEn', 'midFrameEn', 'lastFrameEn'])

  for (const spec of specs) {
    const text = read(spec.field)
    if (!spec.required && !text) continue
    fields.push({
      field: spec.field, label: spec.label, polarity: spec.polarity,
      text, wordCount: wordCount(text), lang: spec.lang
    })
    checkField(spec, text, issues, { soundCue: soundCueFields.has(spec.field), period })
  }

  // 非位移镜多写尾帧/转场：flf2v 自由插值是漂移来源，规则禁止写（需人工确认后清空）
  if (isI2v && !displacement) {
    for (const key of [['lastFrameEn', '尾帧提示词（T2I）'], ['transitionEn', '首尾帧转场提示词（flf2v）']] as const) {
      if (!read(key[0])) continue
      issues.push(makeIssue(
        'displacement-unexpected', 'warn', key[0], key[1],
        `本镜非跨镜位移镜（action 无位移语义），按铁律不得写「${key[1]}」：首尾帧自由插值会让原地动作漂移，建议清空`,
        false
      ))
    }
  }

  // 时长合规：3~6 秒短镜铁律（越界会被 H3/ffmpeg 定帧裁切或拖慢节奏）
  const secs = shot.frameSeconds
  if (!(typeof secs === 'number' && Number.isFinite(secs) && secs >= 3 && secs <= 6)) {
    issues.push(makeIssue(
      'frame-seconds', 'warn', 'frameSeconds', '本镜时长',
      `本镜 frameSeconds = ${typeof secs === 'number' ? secs : '空'}，必须为 3~6 秒整数：越界会触发定帧裁切或台词被截断`,
      false
    ))
  }

  // 同场景漂移：同一物理地点必须同一时刻/同一主光方向，sceneEn 必须复用场景板基底
  if (baseline) {
    const sceneKey = normalizeSceneKey(shot.scene || '')
    const canonLight = baseline.lighting.get(sceneKey)
    const ownLight = primaryLightCue(read('lighting'))
    if (canonLight && ownLight.replace('|', '')) {
      const [canonTime, canonDir] = canonLight.split('|')
      const [ownTime, ownDir] = ownLight.split('|')
      if ((canonTime && ownTime && canonTime !== ownTime) || (canonDir && ownDir && canonDir !== ownDir)) {
        issues.push(makeIssue(
          'scene-drift', 'warn', 'lighting', '光线条件',
          `同场景「${shot.scene}」光线与前序镜不一致（前序 ${canonLight.replace('|', ' / ')}，本镜 ${ownLight.replace('|', ' / ')}）：忽昼忽夜或主光左右反转会让画面光影断层，请统一为同一时刻与同一主光方向`,
          false
        ))
      }
    }
    const boardWords = baseline.sceneBoard.get(sceneKey)
    const sceneEn = read('sceneEn')
    if (boardWords?.length && sceneEn) {
      const own = leadWords(sceneEn)
      const overlap = own.filter(w => boardWords.includes(w)).length
      if (own.length && overlap / Math.max(own.length, boardWords.length) < 0.34) {
        issues.push(makeIssue(
          'scene-drift', 'warn', 'sceneEn', '环境短语',
          `本镜 sceneEn 与场景板「${shot.scene}」的英文基底几乎不重合：同场景被逐镜改写会让背景与光线跳变，请复用场景板的场景基底`,
          false
        ))
      }
    }
  }

  // 正负向服装自相矛盾（lock-unaware 负向）：正向已锁的服装被负向 no 掉 → 模型中途挂上/脱掉
  const positiveText = ['promptEn', 'sceneEn', 'firstFrameEn', 'midFrameEn', 'lastFrameEn']
    .map(read).join(' ').toLowerCase()
  const negativeText = read('negativeEn')
  for (const term of OOC_WARDROBE_TERMS) {
    if (!positiveText.includes(term)) continue
    const re = new RegExp(`\\bno\\s+${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (!re.test(negativeText)) continue
    issues.push(makeIssue(
      'wardrobe-conflict', 'warn', 'negativeEn', '镜级负向提示词',
      `正向提示词已锁定「${term}」，负向却写「no ${term}」：正负相冲会让模型中途脱掉/挂上该服装，建议删除该负向词`,
      true
    ))
  }

  const characters = (shot.characterIds || [])
    .map(id => (project.characters || []).find(c => c.id === id)?.name)
    .filter((n): n is string => Boolean(n))
  const title = [
    `第 ${shot.index} 镜`,
    shotSizeLabel(shot),
    shot.scene || '（未填场景）',
    characters.length ? characters.join('、') : ''
  ].filter(Boolean).join(' · ')

  const sorted = sortIssues(issues)
  return {
    id: shot.id,
    scope: 'shot',
    taskType: isI2v ? 'i2v' : 't2v',
    title,
    shotIndex: shot.index,
    shotId: shot.id,
    fields,
    issues: sorted,
    status: statusOf(sorted)
  }
}
/** 角色定妆任务（T2I）：正向 = 角色卡外观锁；负向 = 系统写实负向（只读） */
function auditCharacter(character: Character): PromptAuditTask {
  const specs: FieldSpec[] = [
    { field: 'appearanceLock', label: '角色卡外观锁（英文，逐字复用）', polarity: 'positive', lang: 'en', required: true, range: [40, 0] },
    { field: 'description', label: '外貌描述（中文）', polarity: 'positive', lang: 'zh', required: true }
  ]
  const fields: PromptAuditField[] = []
  const issues: PromptAuditIssue[] = []
  const read = (f: string): string => readStr(character, f)
  for (const spec of specs) {
    const text = read(spec.field)
    if (!spec.required && !text) continue
    fields.push({ field: spec.field, label: spec.label, polarity: spec.polarity, text, wordCount: wordCount(text), lang: spec.lang })
    checkField(spec, text, issues, { soundCue: false, period: false })
  }
  const sysNeg = mergeNegative(REALISM_NEGATIVE)
  fields.push({
    field: 'negativeEn', label: '系统负向（定妆自动注入，只读）', polarity: 'negative',
    text: sysNeg, wordCount: wordCount(sysNeg), system: true, lang: 'en'
  })
  const sorted = sortIssues(issues)
  return {
    id: character.id,
    scope: 'character',
    taskType: 't2i',
    title: `角色定妆 · ${character.name || '未命名'}`,
    characterId: character.id,
    fields,
    issues: sorted,
    status: statusOf(sorted)
  }
}
/** 场景板任务（T2I）：正向 = 场景视觉提示词（写入 description）；负向 = 系统场景负向（只读） */
function auditSceneBoard(board: SceneBoard): PromptAuditTask {
  const specs: FieldSpec[] = [
    { field: 'description', label: '场景视觉提示词（英文，驱动场景板 T2I）', polarity: 'positive', lang: 'en', required: true, range: [40, 80] }
  ]
  const fields: PromptAuditField[] = []
  const issues: PromptAuditIssue[] = []
  const text = readStr(board, 'description')
  fields.push({ field: 'description', label: specs[0].label, polarity: 'positive', text, wordCount: wordCount(text), lang: 'en' })
  checkField(specs[0], text, issues, { soundCue: true, period: hasPeriodCue(board.name || '') })
  const sysNeg = sceneNegativeFor('standard')
  fields.push({
    field: 'negativeEn', label: '系统负向（场景 T2I 自动注入，只读）', polarity: 'negative',
    text: sysNeg, wordCount: wordCount(sysNeg), system: true, lang: 'en'
  })
  const sorted = sortIssues(issues)
  return {
    id: board.id,
    scope: 'sceneBoard',
    taskType: 't2i',
    title: `场景板 · ${board.name || '未命名'}`,
    sceneBoardId: board.id,
    fields,
    issues: sorted,
    status: statusOf(sorted)
  }
}
/** 道具定妆任务（T2I）：正向 = 形态描述 + 英文名；负向 = 系统写实负向（只读） */
function auditProp(prop: PropAsset): PromptAuditTask {
  const specs: FieldSpec[] = [
    { field: 'description', label: '道具形态描述（英文，锁形）', polarity: 'positive', lang: 'en', required: true, range: [10, 30] },
    { field: 'en', label: '道具英文名', polarity: 'positive', lang: 'en', required: true, range: [1, 8] }
  ]
  const fields: PromptAuditField[] = []
  const issues: PromptAuditIssue[] = []
  const read = (f: string): string => readStr(prop, f)
  for (const spec of specs) {
    const text = read(spec.field)
    if (!spec.required && !text) continue
    fields.push({ field: spec.field, label: spec.label, polarity: spec.polarity, text, wordCount: wordCount(text), lang: spec.lang })
    checkField(spec, text, issues, { soundCue: false, period: false })
  }
  const sysNeg = mergeNegative(REALISM_NEGATIVE)
  fields.push({
    field: 'negativeEn', label: '系统负向（道具 T2I 自动注入，只读）', polarity: 'negative',
    text: sysNeg, wordCount: wordCount(sysNeg), system: true, lang: 'en'
  })
  const sorted = sortIssues(issues)
  return {
    id: prop.id,
    scope: 'prop',
    taskType: 't2i',
    title: `道具定妆 · ${prop.zh || prop.en || '未命名'}`,
    propId: prop.id,
    fields,
    issues: sorted,
    status: statusOf(sorted)
  }
}
/**
 * 批量体检：遍历项目全部文生图/文生视频任务，返回完整报告。
 * 每条任务独立兜底：异常数据只跳过该任务，不影响其余任务与调用方。
 */
export function auditProjectPrompts(project: Project, opts?: { now?: number }): PromptAuditReport {
  const tasks: PromptAuditTask[] = []
  const baseline = buildShotDriftBaseline(project.shots || [], project)
  const push = (build: () => PromptAuditTask): void => {
    try {
      const task = build()
      if (task) tasks.push(task)
    } catch {
      // 单条任务数据异常：跳过，不中断整场体检（错误处理要求）
    }
  }

  for (const shot of project.shots || []) push(() => auditShot(shot, project, baseline))
  for (const character of project.characters || []) push(() => auditCharacter(character))
  for (const board of project.sceneBoards || []) push(() => auditSceneBoard(board))
  for (const prop of project.props || []) push(() => auditProp(prop))

  let fieldTotal = 0
  let issueTotal = 0
  let fixableTotal = 0
  let ok = 0
  let warn = 0
  let error = 0
  const codeCount = new Map<string, number>()
  for (const task of tasks) {
    fieldTotal += task.fields.length
    issueTotal += task.issues.length
    if (task.status === 'ok') ok++
    else if (task.status === 'warn') warn++
    else error++
    for (const issue of task.issues) {
      if (issue.fixable) fixableTotal++
      codeCount.set(issue.code, (codeCount.get(issue.code) || 0) + 1)
    }
  }

  return {
    projectId: project.id,
    auditedAt: opts?.now ?? Date.now(),
    tasks,
    summary: {
      total: tasks.length,
      ok,
      warn,
      error,
      fieldTotal,
      issueTotal,
      fixableTotal,
      byCode: [...codeCount.entries()]
        .map(([code, count]) => ({ code, label: AUDIT_CODE_LABELS[code] || code, count }))
        .sort((a, b) => b.count - a.count)
    }
  }
}
