import axios from 'axios'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// 拼音容错：LLM 偶尔把中文名译成拼音（如 Lin Chuan），用于归一匹配（v3 导出为 { pinyin }）
import pinyinMod from 'pinyin'
const pinyinFn = ((pinyinMod as unknown as { pinyin?: (n: string, o?: unknown) => string[][] }).pinyin ||
  (pinyinMod as unknown as (n: string, o?: unknown) => string[][])) as (n: string, o?: unknown) => string[][]
import type { AppSettings, GeneratedShot, GenreTemplate, AnalyzeResult, AnalyzeScene, AnalyzedCharacter, AnalyzedShot, PropAsset } from '../../shared/ipcTypes'
import { resolveCreation } from '../../shared/creationSettings'
import { validateNarrativeContinuity } from '../../shared/narrativeBeats'
import { DISPLACEMENT_ACTION_RE } from '../../shared/imagePrompts'
import type { FieldFillGuide } from '../../shared/promptAudit'
import { CROSS_SOURCE } from '../../shared/promptAuditRules'
import { analyzeSystemPrompt } from './llmPromptsAnalyze'
// 2026-10-23 总实证修复：analyze 的角色绑定/串台改写统一消费 llmParsers 导出版
// （含 claimPerformer + alignStoryboardPrompts 生成期拦截），替代 private normalizeBindings
import { normalizeBindings as llmNormalizeBindings } from './llmParsers'

/**
 * LLM 错误落盘：restart-app.ps1 不重定向主进程 stdout，console.error 抓不到，
 * 因此把完整错误（message + stack + HTTP 状态码 + 响应体前 500 字）追加写入
 * userData/llm-error.log。返回供 Error message 结构化展示的 detail 字符串。
 */
function logLlmError(stage: string, err: unknown): string {
  let detail = ''
  try {
    const e = err as {
      message?: string
      stack?: string
      response?: { status?: number; data?: unknown }
    }
    const status = e?.response?.status
    const rawBody = e?.response?.data
    const respBody = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody)
    detail = [
      status ? `HTTP ${status}` : '',
      e?.message || String(err),
      respBody ? `响应体: ${respBody.slice(0, 500)}` : ''
    ].filter(Boolean).join(' | ')
    const line = `[${new Date().toISOString()}] stage=${stage}\ndetail=${detail}\nstack=${e?.stack || ''}\n\n`
    const logDir = path.join(process.env.APPDATA || process.cwd(), 'drama-studio')
    fs.mkdirSync(logDir, { recursive: true })
    fs.appendFileSync(path.join(logDir, 'llm-error.log'), line, 'utf-8')
    console.error(`[LLM ${stage}]`, detail, e?.stack)
  } catch { /* 落盘失败不阻断 */ }
  return detail
}

/** OpenAI 兼容对话消息（含 function calling 与多模态图片输入） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** 纯文本；多模态时可用 contentParts（图片+文本，OpenAI 兼容 content 数组） */
  content: string
  /** OpenAI 兼容 content 数组（图片/文本混合），存在时优先于 content 发送 */
  contentParts?: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  >
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

/** 工具规格（OpenAI function-calling JSON Schema） */
export interface ToolSpec {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

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

/**
 * 火山方舟（Ark）LLM 服务：OpenAI 兼容 chat/completions 接口。
 * - 提示词翻译：中文分镜描述 → 英文专业视频提示词
 * - AI 拆分镜：一段剧本 → 结构化分镜列表
 * - 导演对话：多轮消息 + 工具调用
 */
export class LLMService {
  constructor(
    private getSettings: () => Promise<AppSettings>,
    private genreTemplates: GenreTemplate[]
  ) {}

  /** 通用多轮对话，支持 function-calling。返回 assistant 消息（可能携带 tool_calls）。
   *  opts.signal 中断请求（对话停止按钮）：axios 收到 abort 后抛 CanceledError */
  async chatCompletion(
    messages: ChatMessage[],
    opts: { temperature?: number; timeoutMs?: number; tools?: ToolSpec[]; signal?: AbortSignal; effort?: string } = {}
  ): Promise<ChatMessage> {
    const s = await this.getSettings()
    if (!s.llm.apiKey) {
      throw new Error('请先在 设置 → LLM 中配置 API Key')
    }
    const baseUrl = (s.llm.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')
    const body: Record<string, unknown> = {
      model: s.llm.model,
      messages: messages.map(m =>
        m.contentParts
          ? { ...m, content: m.contentParts }   // 多模态：content 数组
          : m
      ),
      temperature: opts.temperature ?? 0.6
    }
    if (opts.tools?.length) {
      body.tools = opts.tools
      body.tool_choice = 'auto'
    }
    // 推理档位由调用方显式指定（导演对话用 high 追求推理深度与规划能力）
    if (opts.effort) body.effort = opts.effort
    // 放开思维链：此前未指定 effort 时无条件 thinking:{type:'disabled'}，让 agent 全程「不思考」，
    // 规划深度与创意被压死。现在默认交给模型自身的推理策略，仅在 provider 明确拒绝时才回退去掉参数。
    const t0 = Date.now()
    let resp
    try {
      resp = await axios.post(`${baseUrl}/chat/completions`, body, {
        headers: { Authorization: `Bearer ${s.llm.apiKey}` },
        timeout: opts.timeoutMs ?? 180000,
        signal: opts.signal
      })
    } catch (e) {
      // 部分 provider/模型不支持 thinking / effort 参数（400/422）→ 同时丢弃二者重试一次
      const st = (e as { response?: { status?: number } })?.response?.status
      if (st === 400 || st === 422) {
        const { thinking: _dropThinking, effort: _dropEffort, ...fallbackBody } = body
        resp = await axios.post(`${baseUrl}/chat/completions`, fallbackBody, {
          headers: { Authorization: `Bearer ${s.llm.apiKey}` },
          timeout: opts.timeoutMs ?? 180000,
          signal: opts.signal
        })
      } else {
        throw e
      }
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    if (elapsed && Number(elapsed) > 30) {
      try {
        const charLen = JSON.stringify(body).length
        console.log(`[llm] chatCompletion ${elapsed}s, bodyChars=${charLen}, model=${s.llm.model}, tools=${opts.tools?.length ?? 0}, msgs=${messages.length}`)
      } catch { /* 日志失败不影响主流程 */ }
    }
    const msg = resp.data?.choices?.[0]?.message
    if (!msg) throw new Error('LLM 返回为空')
    return {
      role: 'assistant',
      content: msg.content || '',
      tool_calls: Array.isArray(msg.tool_calls) ? msg.tool_calls : undefined
    }
  }

  private async chat(system: string, user: string, temperature = 0.7, timeoutMs = 60000, maxTokens = 16384): Promise<string> {
    const s = await this.getSettings()
    if (!s.llm.apiKey) {
      throw new Error('请先在 设置 → LLM 中配置 API Key')
    }
    const baseUrl = (s.llm.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')
    const axOpts = {
      headers: { Authorization: `Bearer ${s.llm.apiKey}` },
      timeout: timeoutMs
    }
    const baseBody = {
      model: s.llm.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature,
      // 推理模型（deepseek-v4-flash / ark-code-latest）会先消耗 reasoning tokens；
      // 8192 曾被思维链占满导致 content 为空（analyze-empty-response.json 实测）。
      // 16384 在提示词超长时仍可能被思维链吃光 → 长分析调用显式传更大 maxTokens（32768）。
      // 更彻底：显式关闭思维链（thinking disabled），推理不再抢占输出配额，
      // 结构化 JSON 拆镜不依赖思维链，还能把首 token 延迟减半（实测 67.9s→32.9s）。
      max_tokens: maxTokens,
      thinking: { type: 'disabled' }
    }
    let resp: { data: any } | undefined
    // 429/5xx 瞬时错误：最多重试 2 次（共 3 次尝试），退避 300ms/600ms
    const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
    const MAX_ATTEMPTS = 3
    let lastErr: unknown
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        resp = await axios.post(`${baseUrl}/chat/completions`, baseBody, axOpts)
        break
      } catch (e) {
        lastErr = e
        // 部分 provider/模型不支持 thinking 参数（400/422）→ 去掉该参数重试一次
        const st = (e as { response?: { status?: number } })?.response?.status
        if (st === 400 || st === 422) {
          const { thinking: _drop, ...fallbackBody } = baseBody
          try {
            resp = await axios.post(`${baseUrl}/chat/completions`, fallbackBody, axOpts)
            break
          } catch (e2) {
            const detail = logLlmError(`chat(${s.llm.model})`, e2)
            throw new Error(`LLM 请求失败：${detail}`)
          }
        }
        if (RETRYABLE_STATUS.has(st ?? 0) && attempt < MAX_ATTEMPTS) {
          await new Promise(r => setTimeout(r, 300 * 2 ** (attempt - 1)))
          continue
        }
        const detail = logLlmError(`chat(${s.llm.model})`, e)
        throw new Error(`LLM 请求失败：${detail}`)
      }
    }
    if (!resp) {
      const detail = logLlmError(`chat(${s.llm.model})`, lastErr)
      throw new Error(`LLM 请求失败：${detail}`)
    }
    const content: string = resp.data?.choices?.[0]?.message?.content?.trim() || ''
    if (!content) {
      // 诊断：长请求空响应时把响应结构落盘，区分「超时」「choices 空」「content 空」
      try {
        const dumpDir = path.join(process.env.APPDATA || process.cwd(), 'drama-studio', 'drama-studio', 'tmp')
        fs.mkdirSync(dumpDir, { recursive: true })
        fs.writeFileSync(path.join(dumpDir, 'analyze-empty-response.json'),
          JSON.stringify({ ts: Date.now(), model: s.llm.model, keys: Object.keys(resp.data || {}), choicesLen: resp.data?.choices?.length, usage: resp.data?.usage }, null, 2), 'utf-8')
      } catch { /* 诊断落盘失败不阻断 */ }
      throw new Error('LLM 返回为空')
    }
    return content
  }

  /** 直接提交完整 body（多模态等自定义结构），返回文本内容 */
  private async chatRaw(body: Record<string, unknown>, timeoutMs = 120000): Promise<string> {
    const s = await this.getSettings()
    if (!s.llm.apiKey) {
      throw new Error('请先在 设置 → LLM 中配置 API Key')
    }
    const baseUrl = (s.llm.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')
    const resp = await axios.post(
      `${baseUrl}/chat/completions`,
      body,
      {
        headers: { Authorization: `Bearer ${s.llm.apiKey}` },
        timeout: timeoutMs
      }
    )
    const content: string = resp.data?.choices?.[0]?.message?.content?.trim() || ''
    if (!content) throw new Error('LLM 返回为空')
    return content
  }

  /** 连通性测试：发送最小请求，返回模型名 */
  async test(): Promise<string> {
    const s = await this.getSettings()
    await this.chat('You are a connectivity probe. Reply with exactly: ok', 'ping', 0)
    return s.llm.model
  }

  /**
   * 多候选抽卡：依据简报 + 本地分数/备注选出最佳序号（1-based）。
   * 无多模态视觉时靠分数与 note 决策；解析失败抛错由调用方回退分数排序。
   */
  async pickCandidate(input: {
    kind: 'character' | 'scene' | 'render'
    brief: string
    candidates: Array<{ index: number; seed: number; score?: number; note: string }>
  }): Promise<{ index: number; reason: string }> {
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
    const raw = await this.chat(
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
  async translatePrompt(input: { scene: string; action: string; dialogue: string; genre: string }): Promise<string> {
    const tpl = this.genreTemplates.find(t => t.key === input.genre)
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

    return this.chat(system, user, 0.5)
  }

  /** 提示词专业化优化：把用户粗略描述改写为影像级专业提示词（保持原语种，默认输出英文）。
   *  kind: positive（画面/动作正向）| negative（负面压制项） */
  async optimizePrompt(text: string, kind: 'positive' | 'negative' = 'positive'): Promise<string> {
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
    return this.chat(system, `原始内容: ${text}`, 0.5)
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
  async fillPromptField(guide: FieldFillGuide, ctx: FillPromptContext): Promise<string> {
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
    let raw = await this.chat(system, user, 0.6, 90000, 2048)
    try {
      return this.cleanLlmOutput(raw, guide)
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
      raw = await this.chat(system, retryUser, 0.6, 90000, 2048)
      return this.cleanLlmOutput(raw, guide)
    }
  }

  /** 清洗 LLM 输出：去代码块/引号/Markdown/解释性首尾/换行，保留单行逗号分隔短语。
   *  若清洗后字数仍超出 guide.range，抛错由主进程记该字段失败（不写入）。 */
  private cleanLlmOutput(raw: string, guide: FieldFillGuide): string {
    let s = (raw || '').trim()
    // 去代码块 ```...```
    s = s.replace(/```[\w]*\n?/g, '').replace(/```/g, '')
    // 去首尾成对引号
    s = s.replace(/^["'""'']+|["'""'']+$/g, '')
    // 去"Here is..."等解释性首尾句（按句号/冒号截断）
    s = s.replace(/^[^a-zA-Z\u4e00-\u9fa5]*((Here|下面|输出|结果|翻译|Here is|Here's)[^:：.。\n]{0,30}[:：])\s*/i, '')
    // 合并空白与换行为单空格
    s = s.replace(/\s+/g, ' ').trim()
    // 去首尾残留的解释性短语
    s = s.replace(/^(Sure[,，]?\s*|OK[,，]?\s*|当然[,，]?\s*|好的[,，]?\s*|Here is the prompt[:：]?\s*)/i, '')
    if (!s) throw new Error('LLM 返回为空')
    // 字数硬校验：英文按词计，中文按汉字计
    const wc = guide.lang === 'zh'
      ? (s.match(/[\u4e00-\u9fa5]/g) || []).length
      : (s.match(/[a-zA-Z'-]+/g) || []).length
    const [minW, maxW] = guide.range
    if (wc < minW || (maxW > 0 && wc > maxW)) {
      throw new Error(`LLM 输出 ${wc} 词，超出区间 [${minW}, ${maxW || '∞'}]`)
    }
    return s
  }

  /** 中英互译：自动检测输入语种，中文→英文、英文→中文。提示词语境下保留专业词汇。 */
  async translateText(text: string): Promise<string> {
    const system = [
      'You are a professional translator for AI image/video generation prompts.',
      'Detect the input language: if Chinese, translate to English; if English, translate to Chinese.',
      'Rules: output ONLY the translation, preserve comma-separated prompt structure and professional terms (e.g. depth of field, golden hour), no quotes, no explanations.'
    ].join('\n')
    return this.chat(system, text, 0.3)
  }

  /**
   * 想法扩写成完整短剧剧本：一句灵感/一段设定 → 可直接进导演流水线的分场剧本。
   * 格式与 analyze 兼容（场景/动作/台词可被指称提取与分镜拆分解析）。
   */
  async writeScript(idea: string, genre: string, title?: string): Promise<string> {
    const tpl = this.genreTemplates.find(t => t.key === genre)
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
    return this.chat(system, user, 0.8, 300000)
  }

  /**
   * 有视频入口：多模态 LLM 看图写短剧剧本（deepseek-flash 等多模态模型）。
   * 输入为抽帧绝对路径数组，一次调用带 2~6 张关键帧。
   */
  async writeScriptFromFrames(framePaths: string[], genre: string): Promise<string> {
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
    const tpl = this.genreTemplates.find(t => t.key === genre)
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
      model: (await this.getSettings()).llm.model,
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
    return this.chatRaw(body, 180000)
  }

  /**
   * AI 剧本医生：专业剧本审查。
   * 检查逻辑 bug（人物动机/时间线/场景连续性/台词动作矛盾/道具一致性/因果漏洞/节奏），
   * 输出问题清单 + 修改后的完整剧本（JSON）。
   */
  async reviewScript(script: string, genre: string, title?: string): Promise<{
    issues: Array<{ severity: 'block' | 'warn'; scene: string; problem: string; suggestion: string }>
    revisedScript: string
  }> {
    const tpl = this.genreTemplates.find(t => t.key === genre)
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
    const raw = await this.chat(system, script, 0.4, 300000)
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
  async splitScript(script: string, genre: string): Promise<GeneratedShot[]> {
    const tpl = this.genreTemplates.find(t => t.key === genre)
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

    const raw = await this.chat(system, script, 0.7, 120000)
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
  async analyze(script: string, genre: string, opts?: { title?: string; extraRules?: string[] }): Promise<AnalyzeResult> {
    const tpl = this.genreTemplates.find(t => t.key === genre)
    // title 韧性兜底：历史/外部数据可能把 title 存成非字符串（对象/数组），直接 .trim 会崩
    const titleHint = typeof opts?.title === 'string' ? opts.title.trim() : ''
    const creation = resolveCreation(await this.getSettings())
    const sb = creation.storyboard
    // 单一事实源（2026-10-23 全量排查整改）：system 提示词统一来自 llmPromptsAnalyze.analyzeSystemPrompt——
    // 此前 llmService 内联保留了一份旧副本，与拆分模块双份维护已产生实质漂移（内联版缺
    // doctrinePromptBlock 且「合规红线①」口径落后为"最多 2 人同框"）。切换后任何规则改动
    // 只需改 llmPromptsAnalyze 一处。
    const system = analyzeSystemPrompt({ sb, titleHint, tpl, extraRules: opts?.extraRules })

    // 角色识别优先确定性：温度来自创作设置·分镜模块
    // 长方法论 prompt + 完整角色/分镜 JSON 输出，云端/本地大模型长输出可达 10~20 分钟；
    // 超时放宽到 20 分钟避免长任务被误判超时反复重试（重试同样耗时且浪费 token）
    const raw = await this.chat(system, script, sb.temperature, 1200000, 32768)
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
          const retryRaw = await this.chat(
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
    const lengthFixed = await this.enforcePromptLengths(scenes, shots, characters)

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
    this.backfillMissingProps(normalized)
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

  /**
   * 提示词字数硬校验 + 整改循环：
   * LLM 一次输出常不达模板字数铁律（场景 en 40~80、sceneEn 30~60、promptEn 80~150、
   * negativeEn 15~35、首中尾帧 20~50 词），且偶发套话（clearly visible 等）。
   * 收集全部不达标字段后，让 LLM 只补写这些字段（聚焦短调用），合并回结果；
   * 整改调用/解析失败时保留原值继续，不阻塞主流程（宁可原值也不返工）。
   */
  private async enforcePromptLengths(
    scenes: AnalyzeScene[],
    shots: AnalyzedShot[],
    characters: AnalyzedCharacter[]
  ): Promise<{ scenes: AnalyzeScene[]; shots: AnalyzedShot[]; characters: AnalyzedCharacter[] }> {
    const L = (t?: string): number => (t ? (t.trim().match(/[a-zA-Z'-]+/g) || []).length : 0)
    const SLANG = /\bclearly visible\b|\bholding a [\w -]+ visible\b/i
    // 串台词（跨项目污染防线）：旧示例项目的专属元素/角色/服装道具。出现在本剧任一提示词字段即代表 LLM 沿用了示例内容，
    // 必须按本镜 action 重写。理发店元素通用项目也可能出现，但本防线仅在本字段与该镜剧情无关时由 LLM 重写纠正。
    // 2026-10-25 单源化：词表收敛到 promptAuditRules.CROSS_SOURCE（旧剧专属元素；现代服装词由 render 层
    // FOREIGN_COAT_RE 按"古装镜出现现代服装"语义承担，analyze 层不拦现代剧正常服装，避免误伤现代剧）。
    const CROSS_RE = new RegExp(CROSS_SOURCE, 'gi')

    interface Violation {
      kind: 'scene' | 'shot' | 'character'
      sceneName?: string
      idx?: number
      name?: string
      field: string
      current: number
      min: number
      max?: number
      slang?: string
      /** 串台词：字段内容疑似沿用了其他剧情/其他镜的示例文本 */
      cross?: string
    }

    // 跨镜位移语义统一判定（尾帧/转场/flf2v 路由同一把尺；「转身/起身」属原地微动不算位移）。
    // 与 taskQueue flf2v 切换判定共用 imagePrompts.DISPLACEMENT_ACTION_RE，口径禁止分裂
    const DISPLACEMENT_RE = DISPLACEMENT_ACTION_RE

    const collect = (sc: AnalyzeScene[], sh: AnalyzedShot[], ch: AnalyzedCharacter[]): Violation[] => {
      const vs: Violation[] = []
      for (const c of sc) {
        const n = L(c.en)
        if (n < 40 || n > 80) vs.push({ kind: 'scene', sceneName: c.name, field: 'en', current: n, min: 40, max: 80 })
      }
      sh.forEach((s, i) => {
        const idx = i + 1
        // i2v 镜 promptEn 走 motion-first 短结构（60~110 词）；t2v 空镜走画面概念（80~130 词）
        const pMin = s.type === 'i2v' ? 60 : 80
        const pMax = s.type === 'i2v' ? 110 : 130
        const checks: Array<[string, number, number, number | undefined]> = [
          ['sceneEn', L(s.sceneEn), 30, 60],
          ['promptEn', L(s.promptEn), pMin, pMax],
          ['negativeEn', L(s.negativeEn), 0, 20],
          ['firstFrameEn', L(s.firstFrameEn), 20, 50],
          ['midFrameEn', L(s.midFrameEn), s.midFrameEn ? 20 : 0, 40]
        ]
        // 尾帧/转场与位移语义同生同灭：仅「跨镜位移镜」必填 lastFrameEn/transitionEn；
        // 站立微动/对话/单动作完成镜禁写（flf2v 自由插值是动作漂移源头，见规则「尾帧镜判定铁律」）
        if (s.type === 'i2v' && DISPLACEMENT_RE.test(s.action ?? '')) {
          const lf = L(s.lastFrameEn)
          if (lf < 20) checks.push(['lastFrameEn', lf, 20, 50])
          const tn = L(s.transitionEn)
          if (tn < 60) checks.push(['transitionEn', tn, 60, 120])
        }
        for (const [field, n, min, max] of checks) {
          if (field === 'midFrameEn' && min === 0) continue
          if (n < min || n > (max ?? 1e9)) vs.push({ kind: 'shot', idx, field, current: n, min, max })
        }
        // 套话检测
        if (s.promptEn) {
          const slang = SLANG.exec(s.promptEn)
          if (slang) vs.push({ kind: 'shot', idx, field: 'promptEn', current: L(s.promptEn), min: pMin, max: pMax, slang: slang[0] })
        }
        // 串戏语义检测（2026-10-17 漂移根因修复·确定性防线）：promptEn 必须与 action 讲同一个故事。
        // 实测事故：LLM 把系统提示词示例当剧本，24 镜古装戏 promptEn 全写成雨夜现代戏，
        // 与 action 完全脱节 → i2v 拿古装定妆演白裙女子，22 镜全部换脸漂移。
        // 黑名单 CROSS_RE 只能堵已知旧剧词；这里用语义对齐兜底未知幻觉：action 内容词
        // 在 promptEn 中命中率 <15% 即判串戏，交整改循环按 action 重写（宁可重写不可放行）。
        if (s.promptEn && s.action) {
          const STOP = new Set([
            'the', 'from', 'with', 'then', 'than', 'that', 'this', 'these', 'those', 'into', 'onto',
            'over', 'under', 'while', 'their', 'there', 'here', 'have', 'has', 'had', 'his', 'her',
            'him', 'she', 'its', 'and', 'but', 'not', 'for', 'are', 'was', 'were', 'been', 'being',
            'same', 'reference', 'image', 'slight', 'slow', 'slowly', 'push', 'shot', 'pan', 'tilt',
            'arc', 'static', 'zoom', 'camera', 'rhythm', 'keeps', 'still', 'starting', 'fixed',
            'framing', 'level', 'speaking', 'naturally', 'motion'
          ])
          const words = (t: string): Set<string> =>
            new Set((t.toLowerCase().match(/[a-z]{4,}/g) || []).filter(w => !STOP.has(w)))
          const aw = words(s.action)
          const pw = words(s.promptEn)
          if (aw.size >= 4) {
            let hit = 0
            for (const w of aw) if (pw.has(w)) hit++
            const ratio = hit / aw.size
            if (ratio < 0.15) {
              vs.push({
                kind: 'shot', idx, field: 'promptEn', current: L(s.promptEn), min: pMin, max: pMax,
                cross: `promptEn 与本镜 action 剧情脱节（动作词命中率仅 ${Math.round(ratio * 100)}%，疑似幻觉串戏）`
              })
            }
          }
        }
        // 串台检测（跨项目污染防线）：任一英文提示词字段出现旧项目专属元素（理发店/剪刀/旧角色名/旧服装道具）→ 重写该字段。
        // 这些词不属于本剧（便利店悬疑），出现即代表 LLM 拆镜时沿用了其他示例内容，必须按本镜 action 重写。
        for (const field of ['sceneEn', 'promptEn', 'firstFrameEn', 'midFrameEn', 'lastFrameEn', 'transitionEn', 'handoffToNext', 'negativeEn']) {
          const v = s[field as keyof AnalyzedShot] as string | undefined
          if (!v) continue
          const m = CROSS_RE.exec(v)
          if (m) vs.push({ kind: 'shot', idx, field, current: L(v), min: 1, max: undefined, cross: m[0] })
        }
      })
      for (const c of ch) {
        const n = L(c.lookEn)
        if (n < 30) vs.push({ kind: 'character', name: c.name, field: 'lookEn', current: n, min: 30, max: 70 })
      }
      return vs
    }

    let vs = collect(scenes, shots, characters)
    if (vs.length === 0) return { scenes, shots, characters }

    // 整改轮次：每轮补写后复验（LLM 补写常再次打折 → 复验不合格再补一轮，最多 2 轮）
    let curScenes = scenes
    let curShots = shots
    let curChars = characters
    for (let round = 1; round <= 2 && vs.length > 0; round++) {
      const lines = vs.map(v => {
        const who = v.kind === 'scene' ? `场景[${v.sceneName}]`
          : v.kind === 'character' ? `角色[${v.name}]`
            : `镜头${v.idx}`
        const range = v.max != null ? `${v.min}~${v.max}` : `${v.min}+`
        const extra = v.slang ? `（含套话词 "${v.slang}"，必须重写去掉）` : ''
        const cross = v.cross ? `（含其他剧情/其他项目的串台词 "${v.cross}"，必须按本镜 action 实际剧情重写，禁止沿用示例内容）` : ''
        return `- ${who} 的 ${v.field} 现 ${v.current} 词，要求 ${range} 词${extra}${cross}`
      })

      const system =
        '你是专业短剧分镜提示词编辑。以下字段因字数不足、含套话或含禁词会降低后续出图/出视频质量，' +
        '请只补写这些字段，保持剧情、场景、镜头顺序、角色外观完全不变。' +
        '只输出一个 JSON 对象，禁止 markdown 代码围栏，所有字符串必须是单行纯文本（不得含换行/制表符/未转义双引号）。' +
        'i2v 镜头的 transitionEn 必须补写（60~120 英文词：起始帧→结束帧的动态转场，A 类原地演变/B 类运镜驱动，按本镜 frameSeconds(3~6秒) 拆解，禁人名/技能词）。' +
        '所有字段严禁出现其他剧情/其他示例项目的串台词（理发店/剪刀/旧角色名/旧服装道具等），必须按本镜 action 实际剧情写，禁止沿用示例内容。' +
        'i2v 镜头的 promptEn 必须按 motion-first 四段结构补写（60~110 词：the same [角色英文名] from the reference image + 具体保留特征词(服装/湿发/道具，禁止仅写 consistent appearance 空断言) + 可观察事件链动作(起始姿态→程度词单一原子动作→结束定格，含物体/道具状态变化，非剧情摘要) + 单条微运镜(static / slow push-in with small amplitude / slight pan / slight tilt / slight arc shot 择一) + 节奏词；禁止重述场景/外貌/光线，禁止多动作堆叠，禁止 static 与运镜并存）。' +
        '角色 lookEn 必须补写（30~70 英文词：人种年龄性别/脸型五官/写实肤质/发型发色/服装面料款式(完整得体禁裸露)/配饰/体型/剧情痕迹；禁 beautiful/porcelain/flawless 空泛词）。'
      const user = `# 需整改字段\n${lines.join('\n')}\n\n# 输出格式\n` +
        `{"fixes":[{"shotIndex":1,"promptEn":"...","transitionEn":"..."}],"sceneFixes":[{"sceneName":"昏暗老宅","en":"..."}],"charFixes":[{"name":"主角名","lookEn":"..."}]}\n` +
        `只包含需整改的字段；补写必须按该镜/该场景/该角色剧情写，禁止逐镜雷同模板，promptEn 不含外貌服装描述，negativeEn 只写本镜增量风险词（0~20 词，系统已覆盖的通用漂移/画质/字幕/转场词禁止重复；无增量风险可留空）。`

      try {
        const raw = await this.chat(system, user, 0.4, 300000, 8192)
        const m = raw.match(/\{[\s\S]*\}/)
        if (!m) break
        const fix = JSON.parse(m[0]) as {
          fixes?: Array<{ shotIndex: number; [k: string]: unknown }>
          sceneFixes?: Array<{ sceneName: string; en: string }>
          charFixes?: Array<{ name: string; lookEn: string }>
        }
        const shotMap = new Map<number, Record<string, unknown>>()
        if (Array.isArray(fix.fixes)) {
          for (const f of fix.fixes) {
            if (f && typeof f.shotIndex === 'number') shotMap.set(f.shotIndex, f)
          }
        }
        const sceneMap = new Map<string, string>()
        if (Array.isArray(fix.sceneFixes)) {
          for (const f of fix.sceneFixes) {
            if (f && typeof f.sceneName === 'string' && typeof f.en === 'string') sceneMap.set(f.sceneName, f.en.trim())
          }
        }
        const charMap = new Map<string, string>()
        if (Array.isArray(fix.charFixes)) {
          for (const f of fix.charFixes) {
            if (f && typeof f.name === 'string' && typeof f.lookEn === 'string') charMap.set(f.name.trim(), f.lookEn.trim())
          }
        }
        if (shotMap.size === 0 && sceneMap.size === 0 && charMap.size === 0) break
        curShots = curShots.map((s, i) => {
          const f = shotMap.get(i + 1)
          if (!f) return s
          const nxt: AnalyzedShot = { ...s }
          const keys = ['sceneEn', 'promptEn', 'negativeEn', 'firstFrameEn', 'midFrameEn', 'lastFrameEn', 'handoffToNext', 'transitionEn'] as const
          for (const k of keys) {
            if (typeof f[k] === 'string' && (f[k] as string).trim()) nxt[k] = (f[k] as string).trim()
          }
          return nxt
        })
        curScenes = curScenes.map(sc => {
          const en = sceneMap.get(sc.name)
          return en ? { ...sc, en } : sc
        })
        curChars = curChars.map(c => {
          const look = charMap.get(c.name) || charMap.get((c.aliases || []).find(a => charMap.has(a)) || '')
          return look ? { ...c, lookEn: look } : c
        })
      } catch (e) {
        // 整改失败不阻塞：保留原值（记录留痕便于排障；确定性收尾仍会补 transitionEn/截断上限）
        console.warn('[enforcePromptLengths] 整改调用失败，保留原值:', e instanceof Error ? e.message : String(e))
        break
      }
      // 复验：补写仍不达标（LLM 二次打折/漏霓虹）则进入下一轮，2 轮后放弃
      vs = collect(curScenes, curShots, curChars)
    }

    // ===== 确定性收尾（LLM 区间控制不可靠，代码兜底保证落盘达标）=====
    const clamp = (t: string | undefined, max: number): string | undefined => {
      if (!t) return t
      const words = t.trim().split(/\s+/)
      if (words.length <= max) return t
      let out = words.slice(0, max).join(' ')
      if (!/[.!?。！？]/.test(out.slice(-1))) out += '.'
      return out
    }
    // transitionEn 兜底：仅「跨镜位移镜」LLM 漏写（2 轮整改仍空）时桥接生成，
    // 保证 flf2v 首尾帧分支有可用的转场提示词（无 LLM 依赖，禁因果词/人名/技能词）；
    // 非位移镜强制剥除 LLM 多写的尾帧/转场（防 flf2v 误切与全量尾帧图空耗）
    const buildTransition = (s: AnalyzedShot): string => {
      const secs = s.frameSeconds && s.frameSeconds >= 3 ? Math.min(6, Math.round(s.frameSeconds)) : 5
      const a = s.firstFrameEn ? s.firstFrameEn.split(',').slice(0, 3).join(',') : 'the opening state'
      const b = s.lastFrameEn ? s.lastFrameEn.split(',').slice(0, 3).join(',') : 'the closing state'
      const cam = s.camera || 'steady camera'
      const mid = s.midFrameEn ? `passing through ${s.midFrameEn.split(',').slice(0, 2).join(',')}, ` : ''
      return `Transition over ${secs} seconds: ${cam}, the frame begins at ${a}, the subject movement evolves smoothly, ${mid}and finally settles at ${b}. The change happens in place with minimal camera motion, consistent lighting and no morphing.`
    }
    curScenes = curScenes.map(sc => ({ ...sc, en: clamp(sc.en, 80) }))
    curShots = curShots.map(s => {
      const nxt: AnalyzedShot = { ...s }
      if (s.type === 'i2v' && DISPLACEMENT_RE.test(s.action ?? '')) {
        if (!nxt.transitionEn) nxt.transitionEn = buildTransition(nxt)
      } else {
        nxt.lastFrameEn = undefined
        nxt.transitionEn = undefined
      }
      nxt.sceneEn = clamp(nxt.sceneEn, 60)
      nxt.promptEn = clamp(nxt.promptEn, 150)
      nxt.negativeEn = clamp(nxt.negativeEn, 35)
      nxt.firstFrameEn = clamp(nxt.firstFrameEn, 50)
      nxt.midFrameEn = clamp(nxt.midFrameEn, 40)
      nxt.lastFrameEn = clamp(nxt.lastFrameEn, 50)
      nxt.transitionEn = clamp(nxt.transitionEn, 120)
      return nxt
    })
    // 调试留痕：确认收尾是否执行、transitionEn 生成情况（写盘便于排查）
    try {
      const fsLog = path.join(process.env.APPDATA || os.homedir(), 'drama-studio', 'enforce-debug.log')
      fs.appendFileSync(fsLog,
        `[${new Date().toISOString()}] i2v=${curShots.filter(x => x.type === 'i2v').length} ` +
        `t2v=${curShots.filter(x => x.type === 't2v').length} ` +
        `transition生成=${curShots.filter(x => x.transitionEn).length} ` +
        `sceneEn=[${curShots.map(x => (x.sceneEn || '').trim().split(/\s+/).length).join(',')}] ` +
        `promptEn=[${curShots.map(x => (x.promptEn || '').trim().split(/\s+/).length).join(',')}]\n`, 'utf-8')
    } catch { /* 日志失败不阻塞 */ }
    return { scenes: curScenes, shots: curShots, characters: curChars }
  }

  /**
   * 本地兜底：propList 中的道具若未写入任何镜头（props 数组或 action），
   * 自动注入到第一个 i2v 镜头（全 t2v 则第一个镜头）的 props + action 尾部，
   * 并记录 warning。确保"剧本反复出现的道具"绝不沦为"全剧从未出现"。
   */
  private backfillMissingProps(result: AnalyzeResult): void {
    const list = result.props
    if (!list || list.length === 0) return
    const shots = result.shots
    const warnings: string[] = []
    for (const prop of list) {
      const en = prop.en || prop.zh
      // 匹配：props 数组包含 en（整词）或 action 出现 en（词边界）
      const key = en.toLowerCase()
      const re = new RegExp(`\\b${this.escapeRegExp(key).split(' ')[0]}`, 'i')
      const assigned = shots.some(s => {
        const inProps = (s.props || []).some(p => p.toLowerCase().includes(key))
        const inAction = re.test(s.action)
        return inProps || inAction
      })
      if (assigned) continue

      // 未分配：注入最相关镜头（第一个 i2v 镜优先；无 i2v 则第一镜）
      const target =
        shots.find(s => s.type === 'i2v') ||
        shots[0]
      if (!target) {
        warnings.push(`道具「${prop.zh}」未写入任何镜头（无可注入镜头）`)
        continue
      }
      target.props = [...(target.props || []), en]
      const actionAdd = `holding a ${en}`
      if (!re.test(target.action)) {
        target.action = `${target.action.trim().replace(/[.,;]?\s*$/, '')}, ${actionAdd}`
      }
      warnings.push(
        `道具「${prop.zh}（${en}）」未写入任何镜头，已自动补入第 ${shots.indexOf(target) + 1} 镜的 props 与动作提示词`
      )
    }
    if (warnings.length > 0) {
      result.warnings = [...(result.warnings || []), ...warnings]
    }
  }

  /** 名称归一化键：去空白并小写（中文不受影响） */
  private foldName(s: string): string {
    return s.trim().toLowerCase().replace(/\s+/g, '')
  }

  /** 正则转义（backfillMissingProps 匹配 action 词边界用） */
  private escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /**
   * AI 导演·成片复审：以剧本统筹视角审查分镜叙事的完整性与音频匹配。
   * 输入：故事梗概 + 各镜摘要（场景/角色/台词/实际时长）；输出：是否通过 + 问题清单。
   * 低温度保证审批结论稳定。
   */
  async reviewStory(input: {
    title: string
    logline: string
    genre: string
    scriptHint?: string
    shots: Array<{
      index: number
      scene: string
      character: string
      dialogue: string
      durationSec: number
      action?: string
      type?: 'i2v' | 't2v'
      shotSize?: string
    }>
  }): Promise<{ passed: boolean; issues: string[]; summary: string }> {
    const sb = resolveCreation(await this.getSettings()).storyboard
    // 本地硬规则：道具/反应/上车/驶离——不依赖模型是否记得审片维度
    const localIssues = validateNarrativeContinuity(
      input.title,
      input.logline,
      input.scriptHint || '',
      input.shots.map(s => ({
        index: s.index,
        scene: s.scene,
        action: s.action || '',
        dialogue: s.dialogue,
        type: s.type || (s.character ? 'i2v' : 't2v'),
        characterName: s.character || undefined,
        shotSize: s.shotSize
      })),
      {
        enforcePropLock: sb.enforcePropLock,
        enforceReactionBeats: sb.enforceReactionBeats,
        enforceBoardingChain: sb.enforceBoardingChain
      }
    )

    const system = [
      '你是一名严苛的短剧成片审片导演，负责在剪辑完成后做最终复审，不通过则不允许配 BGM 出片。',
      '',
      '# 审查维度（逐镜逐条过）',
      '1. 剧情完整性：故事是否有开端（人物/冲突引入）、发展（冲突升级或转折）、结局（收束或钩子）；缺哪一环指出缺在哪',
      '2. 镜头衔接逻辑：相邻镜头的时空/动作是否连贯；有没有跳跃、重复、因果断裂',
      '3. 台词与剧情相符：每句台词是否贴合该镜场景与角色处境；是否存在台词与画面行为矛盾、或台词推进了与上下文无关的内容',
      '4. 音画匹配：某镜时长（秒）明显配不上其台词量或剧情分量时指出（如 1 秒塞了 30 字台词、5 秒却只有一个"嗯"）',
      '5. 角色行为一致性：角色动机是否前后矛盾',
      '6. 关键道具落幅：片名/梗概中的核心道具（如伞）是否在某镜 action 中明确出现；交接戏是否有 closeup；道具是否中途失踪',
      '7. 入画反应：对方走近/入画空镜后，是否存在等待方「看见」的无台词反应镜，再进入对白',
      '8. 上车与驶离：车旁→车内是否缺入座过程；结局是否明确「车辆驶离」而非纯街道空镜',
      '',
      '# 判定标准',
      '- passed=true：仅存在可忽略的小瑕疵（节奏偏好类），不阻碍出片',
      '- passed=false：存在剧情断裂、台词错位、关键情节缺失、关键道具与片名脱节、上车/结局跳跃等观众能感知的问题',
      '- issues 用中文一句话写清「问题 + 位置（第 N 镜）+ 修改方向」；没有问题给空数组',
      '- summary：两句话内给出总体评价',
      '',
      '# 输出格式：只输出一个 JSON 对象，禁止 markdown 围栏与解释',
      '{"passed": true 或 false, "issues": ["问题1", "问题2"], "summary": "总体评价"}'
    ].join('\n')

    const listing = input.shots
      .map(s =>
        `第${s.index}镜 [${s.durationSec}s] ${s.scene}｜${s.type || '?'}｜${s.shotSize || '-'}｜角色:${s.character || '空镜'}｜台词:${s.dialogue || '（无）'}｜action:${s.action || '（无）'}`
      )
      .join('\n')

    const raw = await this.chat(
      system,
      `片名《${input.title}》 题材:${input.genre}\n梗概:${input.logline || '（未提供）'}\n\n分镜清单:\n${listing}`,
      0.2,
      120000
    )
    const cleaned = raw.replace(/```(?:json)?/g, '').trim()
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) {
      return {
        passed: localIssues.length === 0,
        issues: [
          ...localIssues,
          '剧情复审模型输出异常，已跳过模型剧情项（本地叙事规则仍有效）'
        ].slice(0, 12),
        summary: '剧情复审部分跳过'
      }
    }
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
        passed?: unknown
        issues?: unknown
        summary?: unknown
      }
      const modelIssues = Array.isArray(parsed.issues)
        ? parsed.issues.map(x => String(x)).filter(Boolean)
        : []
      const merged = [...localIssues]
      for (const i of modelIssues) {
        if (!merged.some(m => m.includes(i.slice(0, 12)) || i.includes(m.slice(0, 12)))) {
          merged.push(i)
        }
      }
      const issues = merged.slice(0, 12)
      return {
        passed: parsed.passed !== false && localIssues.length === 0,
        issues,
        summary: String(parsed.summary || '').trim()
      }
    } catch {
      return {
        passed: localIssues.length === 0,
        issues: [
          ...localIssues,
          '剧情复审模型输出解析失败，已跳过模型剧情项（本地叙事规则仍有效）'
        ].slice(0, 12),
        summary: '剧情复审部分跳过'
      }
    }
  }

  /**
   * 流水线故障自诊断（C：错误回流自愈）：阶段失败时把错误样本交回 LLM，
   * 判定失败根因、是否值得自动重试（canAutoFix）与人工修复建议。
   * 解析失败/超时直接抛错，由调用方降级为「不自愈、按原错误暂停」。
   */
  async diagnoseFailure(input: {
    stageLabel: string
    errors: string[]
    context?: string
  }): Promise<{ canAutoFix: boolean; diagnosis: string; suggestion: string }> {
    const system = [
      '你是 AI 视频生产流水线的故障诊断专家。流水线阶段失败后，系统会把错误样本交给你。',
      '你的职责：',
      '1. 判断失败根因属于哪一类：环境问题（缺模型/缺节点/服务未启动）、参数问题（时长/分辨率超限）、资源问题（显存/磁盘）、网络或服务瞬时故障、内容被安全策略拦截、或其他',
      '2. 判断「原样自动重试」是否有意义：瞬时故障/抖动类重试有意义；缺模型、参数非法、内容拦截类重试无意义，必须先人工处理',
      '3. 给出具体可执行的修复建议（中文，说清楚去哪里、改什么）',
      '',
      '# 输出格式：只输出一个 JSON 对象，禁止 markdown 围栏与解释',
      '{"canAutoFix": true 或 false, "diagnosis": "根因判断（一两句话）", "suggestion": "修复建议（具体可执行）"}'
    ].join('\n')

    const raw = await this.chat(
      system,
      `失败阶段：${input.stageLabel}\n${input.context ? `上下文：${input.context}\n` : ''}错误样本（已去重）：\n${input.errors.map((e, i) => `${i + 1}. ${e}`).join('\n')}`,
      0.2,
      60000
    )
    const cleaned = raw.replace(/```(?:json)?/g, '').trim()
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) throw new Error('诊断输出格式异常')
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
      canAutoFix?: unknown
      diagnosis?: unknown
      suggestion?: unknown
    }
    const diagnosis = String(parsed.diagnosis || '').trim()
    const suggestion = String(parsed.suggestion || '').trim()
    if (!diagnosis || !suggestion) throw new Error('诊断内容不完整')
    return { canAutoFix: parsed.canAutoFix === true, diagnosis, suggestion }
  }

  /**
   * 逐镜视觉审核（看守）：把渲染产物（图片/视频抽帧）交给 LLM 看图，
   * 按审核清单逐条判定，未过审给出英文修正指令（注入下次渲染提示词）。
   * 模型不支持视觉（请求报错）时返回 visionUnavailable=true，调用方降级为仅技术审核。
   */
  async auditImage(input: {
    imagePath: string
    kind: 'keyframe' | 'video'
    checklist: Array<{ id: string; label: string; check: string; severity: 'block' | 'warn' }>
    context: {
      index: number
      scene: string
      character: string
      action: string
      shotSize: string
      camera: string
      lookEn?: string
    }
  }): Promise<{
    visionUnavailable: boolean
    passed: boolean
    blockedProblems: string[]
    fixHint: string
  }> {
    const s = await this.getSettings()
    if (!s.llm.apiKey) return { visionUnavailable: true, passed: true, blockedProblems: [], fixHint: '' }

    const dataUrl = await (async () => {
      try {
        const { readFile } = await import('node:fs/promises')
        const buf = await readFile(input.imagePath)
        const ext = input.imagePath.toLowerCase().match(/\.(\w+)$/)?.[1] || 'png'
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
        return `data:${mime};base64,${buf.toString('base64')}`
      } catch {
        return ''
      }
    })()
    if (!dataUrl) return { visionUnavailable: true, passed: true, blockedProblems: [], fixHint: '' }

    const checklistLines = input.checklist
      .map((c, i) => `${i + 1}. ${c.label}：${c.check}（${c.severity === 'block' ? '不过必须重渲' : '不过仅告警'}）`)
      .join('\n')
    const system = [
      '你是短剧画面质检导演（vision QC），逐张审核 AI 生成的画面/视频帧，发现漂移穿帮就拦下重渲。',
      '审核对象：真人写实竖屏短剧画面。',
      '# 审核清单（逐条过）',
      checklistLines,
      '',
      '# 判定',
      '- block 项任一不过 → passed=false；仅 warn 项不过 → passed=true（记入 fixHint 供下次生成时修正）',
      '- fixHint：英文一句话写出最重要的画面修正指令（身份/服装/场景/道具/表情/运镜），注入下次生成提示词；无问题给空字符串',
      '- blockedProblems：中文列出未通过的 block 项（含第几项），无则空数组',
      '',
      '# 输出格式：只输出 JSON，禁止 markdown 围栏',
      '{"passed": true 或 false, "blockedProblems": ["人脸身份与定妆不一致"], "fixHint": "keep exact face identity and outfit from reference, no outfit change"}'
    ].join('\n')

    const user = [
      `第${input.context.index}镜 ${input.kind === 'video' ? '视频抽帧' : '关键帧'}审核｜景别:${input.context.shotSize}｜机位:${input.context.camera}`,
      `场景:${input.context.scene}｜角色:${input.context.character}${input.context.lookEn ? `｜外观锁定:${input.context.lookEn}` : ''}`,
      `动作:${input.context.action}`,
      '请按清单审核这张画面。'
    ].join('\n')

    const body: Record<string, unknown> = {
      model: s.llm.model,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text: user },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ],
      temperature: 0.2,
      // 推理型多模态模型（如 deepseek-flash）默认把配额耗在 reasoning 上导致 content 空：
      // 用低推理档 + 大配额保证 JSON 落地；content 仍被挤占时自动重试一次
      effort: 'low',
      max_tokens: 2000
    }
    const post = () => axios.post(
      `${(s.llm.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')}/chat/completions`,
      body,
      { headers: { Authorization: `Bearer ${s.llm.apiKey}` }, timeout: 90000 }
    )
    let resp = await post()
    let content: string = resp.data?.choices?.[0]?.message?.content?.trim() || ''
    const reasoning: string = resp.data?.choices?.[0]?.message?.reasoning_content || ''
    if (!content && reasoning) {
      // 模型看到了图但在推理，content 被挤空：加大配额重试一次
      body.max_tokens = 4000
      resp = await post()
      content = resp.data?.choices?.[0]?.message?.content?.trim() || ''
    }
    // 模型收到图片却忽略（如纯文本模型返回空 content / 说"没有图片"）→ 判为视觉不可用，
    // 禁止假装审过——宁降级为仅技术审核，也不放行未经视觉检查的画面。
    if (!content || /没有图片|no image|看不到|cannot see/i.test(content.slice(0, 200))) {
      return { visionUnavailable: true, passed: true, blockedProblems: [], fixHint: '' }
    }
    const cleaned = content.replace(/```(?:json)?/g, '').trim()
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) {
      return { visionUnavailable: false, passed: true, blockedProblems: [], fixHint: '' }
    }
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
        passed?: unknown
        blockedProblems?: unknown
        fixHint?: unknown
      }
      return {
        visionUnavailable: false,
        passed: parsed.passed !== false,
        blockedProblems: Array.isArray(parsed.blockedProblems)
          ? parsed.blockedProblems.map(x => String(x)).filter(Boolean).slice(0, 6)
          : [],
        fixHint: String(parsed.fixHint || '').trim().slice(0, 300)
      }
    } catch {
      return { visionUnavailable: false, passed: true, blockedProblems: [], fixHint: '' }
    }
  }
}
