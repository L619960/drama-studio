/**
 * 对话工具·网络域：web_search / fetch_url（含 P3 SSRF 受限防护）。
 * 从 conversationTools.ts 按域拆分外移，行为不变。
 */
import axios from 'axios'
import type { ConversationToolsHost, ToolResult } from './conversationTools'
import { RESULT_LIMIT } from './conversationConstants'

export async function tWebSearch(args: Record<string, unknown>): Promise<ToolResult> {
  const query = String(args.query || '').trim()
  if (!query) return { ok: false, text: '缺少 query' }
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10&mkt=zh-CN`
  const resp = await axios.get<string>(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    },
    timeout: 15000,
    responseType: 'text'
  })
  const html = typeof resp.data === 'string' ? resp.data : ''
  const results: Array<{ title: string; url: string; snippet: string }> = []
  for (const chunk of html.split('<li class="b_algo"').slice(1)) {
    const href = chunk.match(/href="(https?:\/\/[^"]+)"/)?.[1] || ''
    if (!href || href.includes('bing.com')) continue
    const titleRaw = chunk.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/)?.[1] || ''
    const snippetRaw = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] || ''
    const title = decodeEntities(stripHtmlTags(titleRaw)).trim()
    const snippet = decodeEntities(stripHtmlTags(snippetRaw)).trim()
    if (!title) continue
    results.push({ title, url: href, snippet: snippet.slice(0, 300) })
    if (results.length >= 8) break
  }
  if (!results.length) return { ok: false, text: '搜索没有返回结果（可能是网络不可达），可稍后重试或换个关键词' }
  return { ok: true, text: JSON.stringify({ query, results }) }
}

export async function tFetchUrl(args: Record<string, unknown>): Promise<ToolResult> {
  const url = String(args.url || '').trim()
  if (!/^https?:\/\//i.test(url)) return { ok: false, text: 'url 必须以 http/https 开头' }
  // P3 SSRF 受限防护：拒绝回环/私网/链路本地/未指定地址（含云元数据 169.254.169.254）。
  // 仅校验初始 URL 的主机名；跟随重定向后的目标不复查（普通域名不做 DNS 解析，
  // DNS rebinding 属深度防御未覆盖）。URL 解析失败时放行给 axios 报错，行为与原来一致。
  let blocked = false
  try {
    blocked = isBlockedFetchHost(new URL(url).hostname)
  } catch {
    blocked = false
  }
  if (blocked) {
    return { ok: false, text: '该地址被禁止访问：仅允许公网 http/https 目标（回环/内网/链路本地地址不支持）' }
  }
  const resp = await axios.get<string>(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
    },
    timeout: 20000,
    maxContentLength: 1024 * 1024,
    responseType: 'text'
  })
  const ct = String(resp.headers?.['content-type'] || '')
  let text: string
  if (ct.includes('html')) {
    text = decodeEntities(
      stripHtmlTags(
        String(resp.data)
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<(br|\/p|\/div|\/li|\/h[1-6])[^>]*>/gi, '\n')
      )
    ).replace(/\n{3,}/g, '\n\n').trim()
  } else {
    text = String(resp.data)
  }
  if (!text) return { ok: false, text: '页面没有可读文本' }
  const truncated = text.length > RESULT_LIMIT
  return { ok: true, text: `【${url} 的正文${truncated ? '（已截断）' : ''}】\n${text.slice(0, RESULT_LIMIT)}` }
}

// ---------------------------------------------------------------- HTML 工具函数（网页正文提取用，不涉及安全转义场景）

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ')
}

/** 解码常见 HTML 实体与数字引用 */
function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    '#39': "'", '#x27': "'", '#x2F': '/', '#160': ' '
  }
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z#x0-9]+);/g, (raw, name) => named[name] ?? raw)
}

// ---------------------------------------------------------------- SSRF 受限防护

/** 展开 IPv6 压缩地址为 8 段补齐 hex；非法输入返回 null（交由 axios 报 URL 错） */
function normalizeIpv6(addr: string): string[] | null {
  const body = addr.split('%')[0] // 去掉 zone id（fe80::1%eth0）
  if (!body.includes(':')) return null
  let parts: string[]
  if (body.includes('::')) {
    const [a, b] = body.split('::')
    const left = a ? a.split(':') : []
    const right = b ? b.split(':') : []
    if (left.length + right.length >= 8) return null
    parts = [...left, ...new Array<string>(8 - left.length - right.length).fill('0'), ...right]
  } else {
    parts = body.split(':')
    if (parts.length !== 8) return null
  }
  if (!parts.every(g => /^[0-9a-fA-F]{1,4}$/.test(g))) return null
  return parts.map(g => g.padStart(4, '0'))
}

/**
 * tFetchUrl 的 SSRF 受限防护纯判定：hostname 来自 new URL().hostname（无端口/用户信息）。
 * 拒绝：回环（localhost/127.0.0.0/8/::1）、私网（10/8、172.16.0.0/12、192.168/16）、
 * 链路本地（169.254/16 含云元数据 169.254.169.254、fe80::/10）、未指定（0.0.0.0/8、::）。
 * 普通域名不做 DNS 解析（避免依赖与重定向竞态）：放行由 axios 发起请求，
 * 因此「公网域名解析到内网 IP」的 DNS rebinding 场景属深度防御未覆盖，如实留档。
 */
export function isBlockedFetchHost(hostname: string): boolean {
  let h = hostname.trim().toLowerCase().replace(/\.+$/, '') // 去末尾点
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h.endsWith('.local') || h.endsWith('.internal')) return true
  // IPv4 字面量
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const o = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])]
    if (o.some(n => n > 255)) return false // 非法字面量：放行给 axios 报错
    const [a, b] = o
    if (a === 0) return true // 0.0.0.0/8 未指定
    if (a === 127) return true // 127.0.0.0/8 回环
    if (a === 10) return true // 10.0.0.0/8 私网
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 私网
    if (a === 192 && b === 168) return true // 192.168.0.0/16 私网
    if (a === 169 && b === 254) return true // 169.254.0.0/16 链路本地（云元数据）
    return false
  }
  // IPv6 字面量
  if (h.includes(':')) {
    const g = normalizeIpv6(h)
    if (!g) return false // 非法 IPv6：放行给 axios 报错
    if (g.every(x => x === '0000')) return true // :: 未指定
    if (g.slice(0, 7).every(x => x === '0000') && g[7] === '0001') return true // ::1 回环
    const first = parseInt(g[0], 16)
    if (first >= 0xfe80 && first <= 0xfebf) return true // fe80::/10 链路本地
    return false
  }
  return false // 普通域名：不做 DNS 解析，放行
}
