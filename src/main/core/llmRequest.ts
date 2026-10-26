/**
 * LLM HTTP/provider 适配层（从 llmService.ts 抽出，行为与原内联实现一字不差）：
 * - baseURL 解析（默认 deepseek 官方端点，去末尾斜杠）
 * - 统一 POST {baseUrl}/chat/completions，含 400/422 推理参数（thinking/effort）回退
 * - 错误落盘（userData/llm-error.log）与诊断落盘目录（tmp/）
 * 注意：非 400/422 错误一律原样抛出，不包装——与原实现一致。
 */
import axios from 'axios'
import type { AxiosResponse } from 'axios'
import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings } from '../../shared/ipcTypes'

/** D-02（2026-10-20）：LLM 诊断落盘统一目录（userData/drama-studio/tmp）——
 *  此前两处硬编码 `drama-studio/drama-studio/tmp` 双重嵌套，与数据根不一致 */
export const LLM_DUMP_DIR = path.join(process.env.APPDATA || process.cwd(), 'drama-studio', 'tmp')

/**
 * LLM 错误落盘：restart-app.ps1 不重定向主进程 stdout，console.error 抓不到，
 * 因此把完整错误（message + stack + HTTP 状态码 + 响应体前 500 字）追加写入
 * userData/llm-error.log。返回供 Error message 结构化展示的 detail 字符串。
 */
export function logLlmError(stage: string, err: unknown): string {
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

/** OpenAI 兼容 baseURL（去末尾斜杠；默认 deepseek 官方端点） */
export function llmBaseUrl(s: AppSettings): string {
  return (s.llm.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')
}

/**
 * POST {baseUrl}/chat/completions。
 * 部分 provider/模型不支持 thinking / effort 参数（400/422）→ 按 dropOn422 清单
 * 丢弃对应参数重试一次；其他错误（含重试抛出的错误）原样向上抛，不做包装。
 */
export async function postChatCompletion(
  s: AppSettings,
  body: Record<string, unknown>,
  opts: { timeoutMs?: number; signal?: AbortSignal; dropOn422?: Array<'thinking' | 'effort'> } = {}
): Promise<AxiosResponse> {
  const headers = { Authorization: `Bearer ${s.llm.apiKey}` }
  try {
    return await axios.post(`${llmBaseUrl(s)}/chat/completions`, body, {
      headers,
      timeout: opts.timeoutMs ?? 180000,
      signal: opts.signal
    })
  } catch (e) {
    const st = (e as { response?: { status?: number } })?.response?.status
    if ((st === 400 || st === 422) && opts.dropOn422?.length) {
      const fallbackBody: Record<string, unknown> = { ...body }
      for (const k of opts.dropOn422) delete fallbackBody[k]
      return await axios.post(`${llmBaseUrl(s)}/chat/completions`, fallbackBody, {
        headers,
        timeout: opts.timeoutMs ?? 180000,
        signal: opts.signal
      })
    }
    throw e
  }
}
