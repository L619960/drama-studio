/**
 * LLM HTTP client 层（从 llmService.ts 抽出）：
 * - chatCompletion：通用多轮对话 + function-calling（支持 AbortSignal / tools / effort）
 * - chat：系统+用户单轮对话，含 429/5xx 重试与 400/422 thinking 参数回退
 * - chatRaw：直接提交完整 body（多模态等自定义结构）
 * - test：连通性探针
 * 行为与原 LLMService 内联实现一字不差（含双嵌套 tmp 诊断落盘路径）。
 */
import axios from 'axios'
import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings } from '../../shared/ipcTypes'
import { logLlmError } from './llmRequest'

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

/** 通用多轮对话，支持 function-calling。返回 assistant 消息（可能携带 tool_calls）。
 *  opts.signal 中断请求（对话停止按钮）：axios 收到 abort 后抛 CanceledError */
export async function httpChatCompletion(
  getSettings: () => Promise<AppSettings>,
  messages: ChatMessage[],
  opts: { temperature?: number; timeoutMs?: number; tools?: ToolSpec[]; signal?: AbortSignal; effort?: string } = {}
): Promise<ChatMessage> {
  const s = await getSettings()
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

/** 系统+用户单轮对话（原 LLMService.private chat），含 429/5xx 重试与 400/422 thinking 回退 */
export async function httpChat(
  getSettings: () => Promise<AppSettings>,
  system: string,
  user: string,
  temperature = 0.7,
  timeoutMs = 60000,
  maxTokens = 16384
): Promise<string> {
  const s = await getSettings()
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
  let resp: { data: { choices?: Array<{ message?: { content?: string } }>; usage?: unknown } } | undefined
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
          throw new Error(`LLM 请求失败：${detail}`, { cause: e2 })
        }
      }
      if (RETRYABLE_STATUS.has(st ?? 0) && attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 300 * 2 ** (attempt - 1)))
        continue
      }
      const detail = logLlmError(`chat(${s.llm.model})`, e)
      throw new Error(`LLM 请求失败：${detail}`, { cause: e })
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

/** 直接提交完整 body（多模态等自定义结构），返回文本内容（原 LLMService.private chatRaw） */
export async function httpChatRaw(
  getSettings: () => Promise<AppSettings>,
  body: Record<string, unknown>,
  timeoutMs = 120000
): Promise<string> {
  const s = await getSettings()
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
export async function httpTest(getSettings: () => Promise<AppSettings>): Promise<string> {
  const s = await getSettings()
  await httpChat(getSettings, 'You are a connectivity probe. Reply with exactly: ok', 'ping', 0)
  return s.llm.model
}
