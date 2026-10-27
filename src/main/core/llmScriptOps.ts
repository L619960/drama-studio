/**
 * 剧本操作层（从 llmService.ts 抽出）：
 * - 抽卡 pickCandidate / 提示词翻译 translatePrompt / 优化 optimizePrompt / 互译 translateText
 * - 字段补写 fillPromptField（含 cleanLlmOutput 清洗与字数硬校验）
 * - 写剧本 writeScript / 关键帧写剧本 writeScriptFromFrames
 * - 剧本医生 reviewScript / 拆分镜 splitScript / 剧本分析 analyze
 * 行为与原 LLMService 内联实现一字不差。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings, GeneratedShot, GenreTemplate, AnalyzeResult, AnalyzeScene, AnalyzedCharacter, AnalyzedShot, PropAsset } from '../../shared/ipcTypes'
import { resolveCreation } from '../../shared/creationSettings'
import { validateNarrativeContinuity } from '../../shared/narrativeBeats'
import type { FieldFillGuide } from '../../shared/promptAudit'
import { analyzeSystemPrompt } from './llmPromptsAnalyze'
// 2026-10-23 总实证修复：analyze 的角色绑定/串台改写统一消费 llmParsers 导出版
// （含 claimPerformer + alignStoryboardPrompts 生成期拦截），替代 private normalizeBindings
import { normalizeBindings as llmNormalizeBindings } from './llmParsers'
import { httpChat, httpChatRaw } from './llmHttp'
import { logLlmError } from './llmRequest'
import { enforcePromptLengths, backfillMissingProps } from './llmPostProcess'

/** 批量 AI 补写字段时传给 LLM 的本镜上下文（防止串戏/脑补） */
export interface FillPromptContext {
  /** 当前字段已有文本（可能为空） */
  currentText: string
  /** 本镜中文场景名 */
  scene?: string
  /** 本镜已锁环境短语（sceneEn，同场景多镜物理地点与光源锁定） */
  sceneEn?: string
  /** 本镜动作（必须逐字呼应动词与道具名） */
  action?: string
  /** 景别：closeup / medium / wide */
  shotSize?: string
  /** 镜头类型：i2v / t2v */
  type?: string
  /** 出场角色名 */
  characterName?: string
  /** 角色定妆外观锁（英文身份锚，promptEn 必须复用） */
  characterLocks?: string
  /** 本镜道具（逗号分隔） */
  props?: string
  /** 时代：如 古装 / 现代 */
  era?: string
  /** 触发本次补写的体检问题描述 */
  issue?: string
}

/** 清洗 LLM 输出：去代码块/引号/Markdown/解释性首尾/换行，保留单行逗号分隔短语。
 *  若清洗后字数仍超出 guide.range，抛错由主进程记该字段失败（不写入）。 */
export function cleanLlmOutput(raw: string, guide: FieldFillGuide): string {
  let s = (raw || '').trim()
  // 去代码块 ```...```
  s = s.replace(/```[\w]*\n?/g, '').replace(/```/g, '')
  // 去首尾成对引号
  s = s.replace(/^["'""'']+|["'""'']+$/g, '')
  // 去"Here is..."等解释性首尾句（按句号/冒号截断）
  s = s.replace(/^[^a-zA-Z一-龥]*((Here|下面|输出|结果|翻译|Here is|Here's)[^:：.。\n]{0,30}[:：])\s*/i, '')
  // 合并空白与换行为单空格
  s = s.replace(/\s+/g, ' ').trim()
  // 去首尾残留的解释性短语
  s = s.replace(/^(Sure[,，]?\s*|OK[,，]?\s*|当然[,，]?\s*|好的[,，]?\s*|Here is the prompt[:：]?\s*)/i, '')
  if (!s) throw new Error('LLM 返回为空')
  // 字数硬校验：英文按词计，中文按汉字计
  const wc = guide.lang === 'zh'
    ? (s.match(/[一-龥]/g) || []).length
    : (s.match(/[a-zA-Z'-]+/g) || []).length
  const [minW, maxW] = guide.range
  if (wc < minW || (maxW > 0 && wc > maxW)) {
    throw new Error(`LLM 输出 ${wc} 词，超出区间 [${minW}, ${maxW || '∞'}]`)
  }
  return s
}

/**
 * 多候选抽卡：依据简报 + 本地分数/备注选出最佳序号（1-based）。
 * 无多模态视觉时靠分数与 note 决策；解析失败抛错由调用方回退分数排序。
 */
export async function pickCandidateOp(
  getSettings: () => Promise<AppSettings>,
  input: {
    kind: 'character' | 'scene' | 'render'
    brief: string
    candidates: Array<{ index: number; seed: number; score?: number; note: string }>
  }
): Promise<{ index: number; reason: string }> {
  const kindLabel =
    input.kind === 'character' ? '人物定妆' : input.kind === 'scene' ? '场景板' : '镜头成片'
  const system = [
    `你是短剧 AI 生产线的「抽卡导演」，从多份${kindLabel}候选中挑出最适合成片的一张/一条。`,
    '优先：人脸清晰且符合设定、空场景无人、动作与台词匹配、分数高且 note 无严重缺陷。',
    '只输出 JSON：{"index":候选序号,"reason":"一句话理由"}，禁止 markdown。'
  ].join('\n')
  const listing = input.candidates
    .map(c => `#${c.index} seed=${c.seed} score=${c.score ?? 'n/a'} note=${c.note || '（无）'}`)
    .join('\n')
  const raw = await httpChat(
    getSettings,
    system,
    `创作简报：${input.brief}\n\n候选列表：\n${listing}`,
    0.2,
    60000
  )
  const cleaned = raw.replace(/```(?:json)?/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('抽卡输出格式异常')
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { index?: unknown; reason?: unknown }
  const index = Number(parsed.index)
  if (!Number.isFinite(index) || index < 1 || index > input.candidates.length) {
    throw new Error(`抽卡序号非法: ${parsed.index}`)
  }
  return { index, reason: String(parsed.reason || '').trim() || `选中 #${index}` }
}

/**
 * 中文分镜描述 → 英文专业提示词。
 * 只写动作与镜头语言，不写外貌（避免角色漂移）；带题材风格前缀。
 */
export async function translatePromptOp(
  getSettings: () => Promise<AppSettings>,
  genreTemplates: GenreTemplate[],
  input: { scene: string; action: string; dialogue: string; genre: string }
): Promise<string> {
  const tpl = genreTemplates.find(t => t.key === input.genre)
  const system = [
    'You are a professional cinematic prompt writer for AI video generation (image-to-video).',
    'Translate the Chinese shot description into ONE line of English prompt.',
    'Rules:',
    '- Describe ONLY actions, camera movement, lighting and atmosphere. Never describe character appearance/clothing (the reference image controls appearance).',
    '- Use slow, gentle motion verbs (slowly, gently, slightly) to avoid motion artifacts.',
    '- Comma-separated phrases, no sentences, no quotes, no explanations, 15~40 words.',
    tpl ? `- Style prefix to weave in: ${tpl.promptStyle}` : ''
  ].filter(Boolean).join('\n')

  const user = [
    `场景: ${input.scene || '未指定'}`,
    `动作: ${input.action}`,
    input.dialogue ? `台词情绪参考: ${input.dialogue}` : ''
  ].filter(Boolean).join('\n')

  return httpChat(getSettings, system, user, 0.5)
}

/** 提示词专业化优化：把用户粗略描述改写为影像级专业提示词（保持原语种，默认输出英文）。
 *  kind: positive（画面/动作正向）| negative（负面压制项） */
export async function optimizePromptOp(
  getSettings: () => Promise<AppSettings>,
  text: string,
  kind: 'positive' | 'negative' = 'positive'
): Promise<string> {
  const system = kind === 'negative'
    ? [
        'You are a professional prompt engineer for AI image/video generation.',
        'Rewrite the user\'s negative prompt into a professional, comma-separated list of artifacts/qualities to suppress.',
        'Rules: output ONLY the negative prompt itself, English, comma-separated short phrases, no sentences, no quotes, no explanations, keep the user\'s original intent, 5~20 phrases.'
      ].join('\n')
    : [
        'You are a professional cinematic prompt engineer for AI image/video generation.',
        'Rewrite the user\'s rough description into a professional visual prompt with precise terminology (camera, lens, lighting, composition, texture, mood).',
        'Rules: output ONLY the prompt itself, English, comma-separated phrases, no sentences, no quotes, no explanations, preserve the user\'s core content, 20~60 words.'
      ].join('\n')
  return httpChat(getSettings, system, `原始内容: ${text}`, 0.5)
}

/**
 * 批量 AI 补写·字段级补写器：按字段指南 + 镜头上下文调用 LLM 重写。
 * 关键约束（防止串戏/脑补）：
 *   1. 必须逐字呼应本镜 action 的动词与道具名；
 *   2. promptEn 身份锚必须复用定妆已锁的角色/服装/道具词（lookEn 锁）；
 *   3. 同一场景多镜的 sceneEn 物理地点与光源方向锁定；
 *   4. 禁止代入其他项目（雨夜理发店/白裙寻亲等示例剧情）；
 *   5. 输出严格落在 guide.range 词数区间内，超界抛错由主进程记失败不写入。
 */
export async function fillPromptFieldOp(
  getSettings: () => Promise<AppSettings>,
  guide: FieldFillGuide,
  ctx: FillPromptContext
): Promise<string> {
  const [minW, maxW] = guide.range
  const rangeText = maxW === 0 ? `≥${minW} 词（无上限）` : `${minW}~${maxW} 词`
  const langText = guide.lang === 'zh' ? '中文' : '英文'
  const avoidText = guide.mustAvoid?.length ? guide.mustAvoid.map(s => `- ${s}`).join('\n') : ''

  const system = [
    '你是资深 AI 短剧提示词工程师，精通电影分镜语言与 AI 出图/视频铁律。',
    '下面给你一个待补写/重写的提示词字段，连同该字段的职责、字数区间、上下文与禁止项。',
    '请严格按要求输出：只输出字段本身的纯文本，不要任何解释、引号、Markdown、换行。',
    '【示例禁令·最高优先级】严禁在输出中出现雨夜理发店、白裙寻亲、雨巷相逢等任何示例项目剧情。所有内容必须基于本镜上下文。',
    '【本镜字段】',
    `- 字段名：${guide.label}（${guide.field}）`,
    `- 输出语种：${langText}`,
    `- 字数区间：${rangeText}`,
    `- 职责：${guide.role}`,
    avoidText ? `【禁止项】\n${avoidText}` : '',
    '【输出硬约束】',
    `- 输出长度必须严格落在「${rangeText}」内（英文按空格分词计；中文按汉字计），绝不超界`,
    '- 只输出纯文本本身，不要前后缀、不要代码块、不要"Here is"之类的话'
  ].filter(Boolean).join('\n')

  const ctxLines: string[] = ['【本镜上下文（仅供参考，必须严格基于此，不得编造）】']
  if (ctx.scene) ctxLines.push(`- 场景：${ctx.scene}`)
  if (ctx.sceneEn) ctxLines.push(`- 同场景已锁环境短语（保持物理地点与光源一致）：${ctx.sceneEn}`)
  if (ctx.action) ctxLines.push(`- 本镜动作（必须逐字呼应动词与道具名）：${ctx.action}`)
  if (ctx.shotSize) ctxLines.push(`- 景别：${ctx.shotSize}`)
  if (ctx.type) ctxLines.push(`- 镜头类型：${ctx.type}`)
  if (ctx.characterName) ctxLines.push(`- 出场角色：${ctx.characterName}`)
  if (ctx.characterLocks) ctxLines.push(`- 角色定妆外观锁（身份锚，promptEn 必须复用）：${ctx.characterLocks}`)
  if (ctx.props) ctxLines.push(`- 本镜道具：${ctx.props}`)
  if (ctx.era) ctxLines.push(`- 时代：${ctx.era}`)
  if (ctx.issue) ctxLines.push(`- 体检问题：${ctx.issue}`)
  ctxLines.push(`- 当前字段内容（可保留其中合理部分，但必须满足字数与语义）：${ctx.currentText || '（空）'}`)

  const user = ctxLines.join('\n')
  // 首遍生成
  let raw = await httpChat(getSettings, system, user, 0.6, 90000, 2048)
  try {
    return cleanLlmOutput(raw, guide)
  } catch (e) {
    // 字数不达标时自动重试一次：明确要求扩写/压缩到目标区间中间值
    const msg = e instanceof Error ? e.message : String(e)
    if (!/词|word|超出区间/.test(msg)) throw e
    const [minW, maxW] = guide.range
    const target = maxW === 0 ? minW + 10 : Math.round((minW + maxW) / 2)
    const retryUser = [
      user,
      `【上一次输出不达标】${msg}`,
      `【硬性重写要求】请重新输出，严格控制在 ${minW}~${maxW === 0 ? '∞' : maxW} 词，目标约 ${target} 词。`,
      `上一次输出（参考，不可直接复用，必须重写到目标词数）：${raw}`
    ].join('\n')
    raw = await httpChat(getSettings, system, retryUser, 0.6, 90000, 2048)
    return cleanLlmOutput(raw, guide)
  }
}

/** 中英互译：自动检测输入语种，中文→英文、英文→中文。提示词语境下保留专业词汇。 */
export async function translateTextOp(getSettings: () => Promise<AppSettings>, text: string): Promise<string> {
  const system = [
    'You are a professional translator for AI image/video generation prompts.',
    'Detect the input language: if Chinese, translate to English; if English, translate to Chinese.',
    'Rules: output ONLY the translation, preserve comma-separated prompt structure and professional terms (e.g. depth of field, golden hour), no quotes, no explanations.'
  ].join('\n')
  return httpChat(getSettings, system, text, 0.3)
}

/**
 * 想法扩写成完整短剧剧本：一句灵感/一段设定 → 可直接进导演流水线的分场剧本。
 * 格式与 analyze 兼容（场景/动作/台词可被指称提取与分镜拆分解析）。
 */
export async function writeScriptOp(
  getSettings: () => Promise<AppSettings>,
  genreTemplates: GenreTemplate[],
  idea: string,
  genre: string,
  title?: string
): Promise<string> {
  const tpl = genreTemplates.find(t => t.key === genre)
  const system = [
    '你是一名资深中文短剧编剧，要把创作者的想法扩写成一部可直接用于 AI 短剧生产线的完整分场剧本。',
    '输出要求：',
    '- 纯文本剧本，不要 JSON、不要 markdown 标题符号、不要解释性文字',
    '- 每场格式：第一行「【第N场 · 场景名】」（场景名 4~8 字，如：雨夜天台），随后括号内写环境与动作（人物动作、道具、光线），再写对白「角色：台词」',
    '- 3~6 场，1 个主角 + 1~2 个关键配角 + 可容纳群演；总台词 8~20 句，每句不超过 30 字',
    '- 必须包含：明确的场景/动作/道具细节（供分镜与资产生成使用）、关键道具重复出现（如片名意象）、有起承转合的完整小剧情',
    '- 禁止：网络小说式大段心理描写、无动作的纯对话、超过 4 个有名有姓的角色',
    tpl ? `- 题材风格：${tpl.promptStyle}，开篇 20 字内要有钩子` : ''
  ].filter(Boolean).join('\n')
  const user = [
    title ? `片名：《${title}》（剧情与关键道具要呼应片名意象）` : '',
    `创作想法：\n${idea}`,
    genre ? `题材：${tpl?.label || genre}` : ''
  ].filter(Boolean).join('\n')
  return httpChat(getSettings, system, user, 0.8, 300000)
}

/**
 * 有视频入口：多模态 LLM 看图写短剧剧本（deepseek-flash 等多模态模型）。
 * 输入为抽帧绝对路径数组，一次调用带 2~6 张关键帧。
 */
export async function writeScriptFromFramesOp(
  getSettings: () => Promise<AppSettings>,
  genreTemplates: GenreTemplate[],
  framePaths: string[],
  genre: string
): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const images = await Promise.all(framePaths.map(async (p) => {
    try {
      const buf = await readFile(p)
      const ext = p.toLowerCase().match(/\.(\w+)$/)?.[1] || 'png'
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
      return { type: 'image_url' as const, image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } }
    } catch {
      return null
    }
  }))
  const valid = images.filter(Boolean)
  if (valid.length === 0) throw new Error('视频抽帧读取失败，无法分析画面')
  const tpl = genreTemplates.find(t => t.key === genre)
  const system = [
    '你是一名资深中文短剧编剧与拆解导演。下面给你一支视频的关键帧画面（按时间顺序），请根据画面内容反推并扩写为一部完整的 AI 短剧分场剧本。',
    '规则：',
    '- 画面中出现的人物/场景/道具必须纳入剧情；画面没有的信息（台词细节）可以合理创作但不得与画面冲突',
    '- 每场格式：第一行「【第N场 · 场景名】」，随后括号内写环境与动作（人物动作、道具、光线），再写对白「角色：台词」',
    '- 3~6 场，总台词 8~20 句，每句不超过 30 字，关键道具重复出现',
    '- 纯文本剧本，不要 JSON、不要 markdown 标题符号、不要解释性文字',
    tpl ? `- 题材风格：${tpl.promptStyle}` : ''
  ].filter(Boolean).join('\n')
  const body: Record<string, unknown> = {
    model: (await getSettings()).llm.model,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'text', text: `这是视频按时间顺序抽取的 ${valid.length} 帧关键画面，请据此写一部短剧剧本：` },
          ...valid
        ]
      }
    ],
    temperature: 0.7,
    // 多模态推理模型低推理档 + 大配额保证正文落地
    effort: 'low',
    max_tokens: 3000
  }
  return httpChatRaw(getSettings, body, 180000)
}

/**
 * AI 剧本医生：专业剧本审查。
 * 检查逻辑 bug（人物动机/时间线/场景连续性/台词动作矛盾/道具一致性/因果漏洞/节奏），
 * 输出问题清单 + 修改后的完整剧本（JSON）。
 */
export async function reviewScriptOp(
  getSettings: () => Promise<AppSettings>,
  genreTemplates: GenreTemplate[],
  script: string,
  genre: string,
  title?: string
): Promise<{
  issues: Array<{ severity: 'block' | 'warn'; scene: string; problem: string; suggestion: string }>
  revisedScript: string
}> {
  const tpl = genreTemplates.find(t => t.key === genre)
  const system = [
    '你是一位从业三十年的短剧剧本医生/资深编剧顾问，专治 AI 短剧剧本的逻辑病。',
    '审查范围（逐项过）：',
    '1. 人物：动机是否成立、性格是否前后矛盾、对话是否符合人设、角色是否工具化/凭空消失',
    '2. 逻辑因果：事件是否铺垫充分、转折是否有依据、是否有无来源信息/预言式跳跃',
    '3. 时间与空间：时间线是否自洽、场景切换是否有交代、人物是否瞬移、昼夜/天气是否冲突',
    '4. 道具与细节：关键道具是否交代去向、前后是否一致、是否有「用过的道具凭空出现」',
    '5. 台词与动作：台词和动作是否矛盾、对话是否答非所问、是否有多余废句',
    '6. 结构节奏：是否头重脚轻、高潮是否草率、结尾是否收得住、题材风格是否统一',
    '',
    '输出 ONLY JSON（禁止 markdown 围栏）：',
    '{"issues":[{"severity":"block 或 warn","scene":"第几场/位置","problem":"问题描述（中文，具体到细节）","suggestion":"修改建议（中文，可执行）"}],"revisedScript":"修复以上全部问题后的完整剧本，格式与原剧本一致（第N场标题行+括号动作+角色：台词），保留原有剧情骨架与人物"}',
    '- 没有问题的维度不要写；确实没问题的剧本 issues 可为空数组，revisedScript 与原剧本一致',
    '- block=会穿帮/明显违背逻辑必须修；warn=建议优化',
    '- revisedScript 必须是完整剧本（不是只列修改），AI 短剧生产线直接可用的分场格式',
    tpl ? `- 题材风格基调：${tpl.promptStyle}` : '',
    title ? `- 片名：《${title}》，意象需呼应` : ''
  ].filter(Boolean).join('\n')
  // 剧本医生要求输出完整改后剧本（长输出 + 推理模型思维链），180s 实测超时
  // （llm-error.log: timeout of 180000ms exceeded），放宽到 300s
  const raw = await httpChat(getSettings, system, script, 0.4, 300000)
  const cleaned = raw.replace(/```(?:json)?/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1) {
    // 落盘原始返回片段，便于定位「非 JSON / 思维链未收敛 / 被 max_tokens 截断」
    logLlmError('reviewScript.parse', new Error(`剧本医生返回格式异常，无法解析；原始返回前500字: ${cleaned.slice(0, 500)}`))
    throw new Error(`剧本医生返回格式异常，无法解析（返回前120字：${cleaned.slice(0, 120)}）`)
  }
  let parsed: { issues?: unknown; revisedScript?: unknown }
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1))
  } catch (e) {
    logLlmError('reviewScript.jsonParse', new Error(`JSON.parse 失败：${e instanceof Error ? e.message : String(e)}；片段: ${cleaned.slice(start, end + 1).slice(0, 500)}`))
    throw new Error(`剧本医生 JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)
  }
  const issues = ((Array.isArray(parsed.issues) ? parsed.issues : []) as Array<{ severity?: string; scene?: string; problem?: string; suggestion?: string }>)
    .filter(i => i && (i.problem || i.suggestion))
    .map(i => ({
      severity: i.severity === 'block' ? 'block' as const : 'warn' as const,
      scene: String(i.scene || '').trim(),
      problem: String(i.problem || '').trim(),
      suggestion: String(i.suggestion || '').trim()
    }))
  const revisedScript = String(parsed.revisedScript || '').trim()
  if (!revisedScript) {
    logLlmError('reviewScript.emptyRevised', new Error('剧本医生未返回修改后的剧本；原始返回前500字: ' + cleaned.slice(0, 500)))
    throw new Error('剧本医生未返回修改后的剧本')
  }
  return { issues, revisedScript }
}

/**
 * AI 拆分镜：剧本 → 分镜 JSON 数组。
 * 健壮解析：剥离 markdown 代码围栏，截取首个 [ 到末个 ]。
 */
export async function splitScriptOp(
  getSettings: () => Promise<AppSettings>,
  genreTemplates: GenreTemplate[],
  script: string,
  genre: string
): Promise<GeneratedShot[]> {
  const tpl = genreTemplates.find(t => t.key === genre)
  const system = [
    'You are a short-drama director. Split the script into shots for AI video generation.',
    'Output ONLY a JSON array, no markdown fences, no explanations.',
    'Each element: {"scene": "中文场景名(4~8字)", "action": "英文动作提示词(15~40词,逗号分隔短语,只写动作/镜头/光影,不写人物外貌)", "dialogue": "中文台词(无台词则为空字符串)", "type": "i2v 或 t2v", "camera": "英文机位运镜短语(static camera/slow push-in 等)", "emotion": "英文情绪短语(1~3个形容词)"}',
    '- type=i2v：有人物出现的镜头；type=t2v：纯空镜（环境/物品/场景过渡）',
    '- 动作提示词使用缓慢动词（slowly/gently/slightly），镜头以静态或缓推为主',
    '- 单镜节奏 3~6 秒，长句台词拆成两句或两镜；action 只写动作/镜头/光影，严禁 identical face/appearance/outfit 等外貌锁定措辞',
    '- camera/emotion 为必填英文短语',
    tpl ? `- 题材风格: ${tpl.promptStyle}` : '',
    '- 8~20 个镜头，按剧情顺序排列'
  ].filter(Boolean).join('\n')

  const raw = await httpChat(getSettings, system, script, 0.7, 120000)
  const cleaned = raw.replace(/```(?:json)?/g, '').trim()
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('LLM 返回格式异常，无法解析分镜列表')
  }
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as GeneratedShot[]
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('LLM 未拆分出任何分镜')
  }
  // 字段兜底清洗
  return parsed
    .filter(s => s && typeof s.action === 'string' && s.action.trim())
    .map(s => ({
      scene: String(s.scene || '').trim(),
      action: String(s.action).trim(),
      dialogue: String(s.dialogue || '').trim(),
      type: s.type === 't2v' ? 't2v' : 'i2v',
      camera: typeof s.camera === 'string' ? String(s.camera).trim() : undefined,
      emotion: typeof s.emotion === 'string' ? String(s.emotion).trim() : undefined
    }))
}

/**
 * AI 导演·剧本分析：一次调用同时产出角色清单与分镜列表。
 * 提示词强制六步方法论：指称提取 → 归一合并 → 入选判定 →
 * 角色档案 → 主角归属 → 输出自检；返回前再做本地归一化兜底。
 */
export async function analyzeOp(
  getSettings: () => Promise<AppSettings>,
  genreTemplates: GenreTemplate[],
  script: string,
  genre: string,
  opts?: { title?: string; extraRules?: string[] }
): Promise<AnalyzeResult> {
  const tpl = genreTemplates.find(t => t.key === genre)
  // title 韧性兜底：历史/外部数据可能把 title 存成非字符串（对象/数组），直接 .trim 会崩
  const titleHint = typeof opts?.title === 'string' ? opts.title.trim() : ''
  const creation = resolveCreation(await getSettings())
  const sb = creation.storyboard
  // 单一事实源（2026-10-23 全量排查整改）：system 提示词统一来自 llmPromptsAnalyze.analyzeSystemPrompt——
  // 此前 llmService 内联保留了一份旧副本，与拆分模块双份维护已产生实质漂移（内联版缺
  // doctrinePromptBlock 且「合规红线①」口径落后为"最多 2 人同框"）。切换后任何规则改动
  // 只需改 llmPromptsAnalyze 一处。
  const system = analyzeSystemPrompt({ sb, titleHint, tpl, extraRules: opts?.extraRules })

  // 角色识别优先确定性：温度来自创作设置·分镜模块
  // 长方法论 prompt + 完整角色/分镜 JSON 输出，云端/本地大模型长输出可达 10~20 分钟；
  // 超时放宽到 20 分钟避免长任务被误判超时反复重试（重试同样耗时且浪费 token）
  const raw = await httpChat(getSettings, system, script, sb.temperature, 1200000, 32768)
  // 解析容错：LLM 在 promptEn/negativeEn 等长文本字段里写入裸换行/控制字符会让 JSON.parse 失败
  // → 先剥离控制字符（字符串内裸换行替换为空格），仍失败则带修复指令重试一次
  const dumpDir = path.join(process.env.APPDATA || process.cwd(), 'drama-studio', 'drama-studio', 'tmp')
  let cleaned = raw.replace(/```(?:json)?/g, '').trim()
  let start = cleaned.indexOf('{')
  let end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('LLM 返回格式异常，无法解析分析结果')
  }
  let jsonText = cleaned.slice(start, end + 1)
  let parsed: { logline?: unknown; characters?: unknown; shots?: unknown; scenes?: unknown; props?: unknown }
  for (let attempt = 0; ; attempt++) {
    try {
      parsed = JSON.parse(jsonText) as typeof parsed
      // 成功也落盘一次（便于诊断 LLM 实际输出字段；失败路径另有 analyze-raw-dump.json）
      try {
        fs.mkdirSync(dumpDir, { recursive: true })
        fs.writeFileSync(path.join(dumpDir, 'analyze-last-ok.json'), jsonText, 'utf-8')
      } catch { /* 诊断落盘失败不阻断主流程 */ }
      break
    } catch (firstErr) {
      if (attempt >= 1) {
        try {
          fs.mkdirSync(dumpDir, { recursive: true })
          fs.writeFileSync(
            path.join(dumpDir, 'analyze-raw-dump.json'),
            jsonText,
            'utf-8'
          )
        } catch { /* 诊断落盘失败不阻断主流程 */ }
        throw new Error(`LLM 分析输出 JSON 两次解析失败（${(firstErr as Error).message.slice(0, 80)}），原始输出已存 tmp/analyze-raw-dump.json 便于排查`)
      }
      // 第一次失败：剥离控制字符后重试（裸换行→空格）
      const sanitized = jsonText.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
      if (sanitized === jsonText) {
        // 无控制字符可清 → 换修复指令重试一次
        jsonText = ''
        const retryRaw = await httpChat(
          getSettings,
          `${system}\n\n# 上次输出的 JSON 解析失败（${(firstErr as Error).message.slice(0, 100)}）。请重新输出，要求：promptEn/negativeEn 等所有字符串值必须是单行纯文本，不含换行、不含未转义双引号、不含 markdown 代码围栏；只输出一个合法 JSON 对象。`,
          script, sb.temperature, 1200000, 32768)
        cleaned = retryRaw.replace(/```(?:json)?/g, '').trim()
        start = cleaned.indexOf('{')
        end = cleaned.lastIndexOf('}')
        if (start === -1 || end === -1 || end <= start) throw new Error('LLM 修复输出仍非 JSON，无法解析分析结果')
        jsonText = cleaned.slice(start, end + 1)
      } else {
        jsonText = sanitized
      }
    }
  }

  const characters: AnalyzedCharacter[] = Array.isArray(parsed.characters)
    ? parsed.characters
        .filter((c): c is Record<string, unknown> =>
          Boolean(c) && typeof (c as Record<string, unknown>).name === 'string'
        )
        .map(c => ({
          name: String(c.name).trim(),
          gender: c.gender === 'male' ? 'male' : 'female',
          age: c.age ? String(c.age) : undefined,
          appearance: String(c.appearance || '').trim(),
          lookEn: String(c.lookEn || '').trim() || 'attractive person',
          aliases: Array.isArray(c.aliases)
            ? c.aliases.map(a => String(a).trim()).filter(Boolean)
            : undefined,
          confidence: ['high', 'medium', 'low'].includes(c.confidence as string)
            ? (c.confidence as 'high' | 'medium' | 'low')
            : undefined
        }))
    : []

  if (characters.length === 0) throw new Error('LLM 未识别出任何角色')

  const shots: AnalyzedShot[] = Array.isArray(parsed.shots)
    ? parsed.shots
        .filter((s): s is Record<string, unknown> =>
          Boolean(s) && typeof (s as Record<string, unknown>).action === 'string'
        )
        .map(s => {
          const type = s.type === 't2v' ? 't2v' : 'i2v'
          const characterName =
            type === 'i2v' && typeof s.characterName === 'string'
              ? String(s.characterName).trim()
              : undefined
          const shotSizeRaw = String(s.shotSize || '').trim().toLowerCase()
          // 电影工业景别 9 档 → 本系统三档（closeup/medium/wide），未知值归一 medium
          const shotSize =
            shotSizeRaw === 'closeup' || shotSizeRaw === 'wide'
              ? shotSizeRaw
              : /ecu|extreme.?close.?up|^cu$|close.?up|mcu|medium.?close.?up/.test(shotSizeRaw)
                ? 'closeup'
                : /ms|medium.?shot|mfs|medium.?full/.test(shotSizeRaw)
                  ? 'medium'
                  : /els|extreme.?long|^ls$|long.?shot|fs|full.?shot|wide/.test(shotSizeRaw)
                    ? 'wide'
                    : 'medium'
          return {
            scene: String(s.scene || '').trim(),
            sceneEn: typeof s.sceneEn === 'string' ? String(s.sceneEn).trim() : undefined,
            action: String(s.action).trim(),
            dialogue: String(s.dialogue || '').trim(),
            type,
            characterName,
            characters: characterName ? [characterName] : undefined,
            props: Array.isArray(s.props)
              ? s.props.map(p => String(p).trim()).filter(Boolean)
              : undefined,
            shotSize: type === 'i2v' ? shotSize : undefined,
            camera: typeof s.camera === 'string' ? String(s.camera).trim() : undefined,
            transition: ['hard', 'dissolve', 'smash'].includes(String(s.transition || ''))
              ? (s.transition as 'hard' | 'dissolve' | 'smash')
              : undefined,
            emotion: typeof s.emotion === 'string' ? String(s.emotion).trim() : undefined,
            lighting: typeof s.lighting === 'string' ? String(s.lighting).trim() : undefined,
            facing: typeof s.facing === 'string' ? String(s.facing).trim() : undefined,
            continuity: typeof s.continuity === 'string' ? String(s.continuity).trim() : undefined,
            promptEn: typeof s.promptEn === 'string' ? String(s.promptEn).trim() : undefined,
            negativeEn: typeof s.negativeEn === 'string' ? String(s.negativeEn).trim() : undefined,
            frameSeconds: typeof s.frameSeconds === 'number' && s.frameSeconds > 0 ? Math.min(6, Math.max(3, Math.round(s.frameSeconds))) : undefined,
            firstFrameEn: typeof s.firstFrameEn === 'string' ? String(s.firstFrameEn).trim() : undefined,
            midFrameEn: typeof s.midFrameEn === 'string' ? String(s.midFrameEn).trim() : undefined,
            lastFrameEn: typeof s.lastFrameEn === 'string' ? String(s.lastFrameEn).trim() : undefined,
            handoffToNext: typeof s.handoffToNext === 'string' ? String(s.handoffToNext).trim() : undefined,
            transitionEn: typeof s.transitionEn === 'string' ? String(s.transitionEn).trim() : undefined
          }
        })
    : []

  if (shots.length === 0) throw new Error('LLM 未拆分出任何分镜')

  // 解析全剧关键道具清单（propList）→ PropAsset[]
  const props: PropAsset[] = Array.isArray(parsed.props)
    ? parsed.props
        .filter((p): p is Record<string, unknown> => Boolean(p) && typeof (p as Record<string, unknown>).zh === 'string')
        .map((p, i) => ({
          id: `prop_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
          zh: String(p.zh).trim(),
          en: typeof p.en === 'string' ? String(p.en).trim() : String(p.zh).trim(),
          description: typeof p.description === 'string' ? String(p.description).trim() : undefined
        }))
        .filter(p => p.zh)
    : []

  // 解析场景清单（scenes）→ 场景板提示词
  const scenes: AnalyzeScene[] = Array.isArray(parsed.scenes)
    ? parsed.scenes
        .filter((s): s is Record<string, unknown> =>
          Boolean(s) && typeof (s as Record<string, unknown>).name === 'string'
        )
        .map(s => ({
          name: String(s.name).trim(),
          en: typeof s.en === 'string' ? String(s.en).trim() : undefined
        }))
        .filter(s => s.name)
    : []

  // 提示词字数硬校验 + 整改：LLM 分镜输出字数常打折（promptEn/negativeEn/首尾帧/场景 en/角色 lookEn），
  // 字数不足或含霓虹/套话会直接降低后续出图/出视频提示词质量。这里收集不达标字段，让 LLM 只补写
  // 不达标字段（聚焦短调用，最多 2 轮并复验），整改失败时保留原值并继续，不阻塞主流程。
  const lengthFixed = await enforcePromptLengths(getSettings, scenes, shots, characters)

  const result: AnalyzeResult = {
    logline: typeof parsed.logline === 'string' ? parsed.logline : undefined,
    characters: lengthFixed.characters,
    shots: lengthFixed.shots,
    props: props.length ? props : undefined,
    scenes: lengthFixed.scenes.length ? lengthFixed.scenes : undefined
  }
  // 本地兜底：别名归一 + 无法匹配的绑定记录为 warnings
  // 2026-10-23 总实证修复：切到 llmParsers.normalizeBindings（含 claimPerformer + alignStoryboardPrompts
  // 生成期串台/漂移改写）——此前用 private normalizeBindings 无 align，LLM 幻觉 promptEn（如"湿发白衣女"）
  // 原样落盘，只能靠渲染期 taskQueue 兜底；llmParsers 版从未被消费（与 llmPromptsAnalyze 同型双份漂移）。
  const normalized = llmNormalizeBindings(result)
  // 本地兜底：propList 中未写入任何镜头 action/props 的道具 → 自动注入相关镜头并记 warning
  backfillMissingProps(normalized)
  const narrative = validateNarrativeContinuity(
    titleHint,
    normalized.logline,
    script,
    normalized.shots.map((s, i) => ({
      index: i + 1,
      scene: s.scene,
      action: s.action,
      dialogue: s.dialogue,
      type: s.type,
      characterName: s.characterName,
      shotSize: s.shotSize
    })),
    {
      enforcePropLock: sb.enforcePropLock,
      enforceReactionBeats: sb.enforceReactionBeats,
      enforceBoardingChain: sb.enforceBoardingChain
    }
  )
  if (narrative.length > 0) {
    normalized.warnings = [...(normalized.warnings || []), ...narrative]
  }
  return normalized
}
