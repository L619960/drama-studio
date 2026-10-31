/**
 * SEC-06 单测：tFetchUrl 重定向逐跳复检（不再让 axios 自动跟随）。
 * axios 全程 mock，校验：
 * - 公网 302 正常跟随（相对 Location 按当前地址解析）
 * - 跳转到回环/私网/非 http(s) 协议 → 阻断
 * - 重定向超过上限 → 明确报错
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() },
}))

const axiosCtl = vi.hoisted(() => ({ impl: null as null | ((url: string, cfg: unknown) => Promise<unknown>) }))
vi.mock('axios', () => ({
  default: {
    get: (url: string, cfg: unknown) =>
      axiosCtl.impl ? axiosCtl.impl(url, cfg) : Promise.resolve({ data: '', headers: {}, status: 200 }),
  },
}))

import { tFetchUrl } from '../../src/main/core/conversationToolsNetwork'

const ok = (data: string, headers: Record<string, string> = {}, status = 200) => ({
  data,
  headers,
  status,
})
const redirect = (location: string) => ({ data: '', headers: { location }, status: 302 })

beforeEach(() => {
  axiosCtl.impl = null
})

describe('tFetchUrl 重定向复检', () => {
  it('公网 302 跟随成功：返回最终地址正文', async () => {
    const calls: string[] = []
    axiosCtl.impl = async (url) => {
      calls.push(url)
      if (url === 'https://a.example.com/start') return redirect('https://b.example.com/final')
      return ok('最终页面正文', { 'content-type': 'text/plain' })
    }
    const r = await tFetchUrl({ url: 'https://a.example.com/start' })
    expect(r.ok).toBe(true)
    expect(r.text).toContain('https://b.example.com/final')
    expect(r.text).toContain('最终页面正文')
    expect(calls).toEqual(['https://a.example.com/start', 'https://b.example.com/final'])
  })

  it('相对 Location 按当前地址解析', async () => {
    axiosCtl.impl = async (url) => {
      if (url === 'https://a.example.com/dir/start') return redirect('/next')
      return ok('ok', { 'content-type': 'text/plain' })
    }
    const r = await tFetchUrl({ url: 'https://a.example.com/dir/start' })
    expect(r.ok).toBe(true)
    expect(r.text).toContain('https://a.example.com/next')
  })

  it('重定向到回环地址 → 阻断且不再请求内网', async () => {
    const calls: string[] = []
    axiosCtl.impl = async (url) => {
      calls.push(url)
      return redirect('http://127.0.0.1:8080/admin')
    }
    const r = await tFetchUrl({ url: 'https://public.example.com/x' })
    expect(r.ok).toBe(false)
    expect(r.text).toContain('禁止访问')
    expect(calls).toEqual(['https://public.example.com/x'])
  })

  it('重定向到私网 / .internal / 非 http(s) 协议 → 阻断', async () => {
    for (const loc of ['http://192.168.1.1/', 'http://nas.local/', 'file:///C:/Windows/win.ini']) {
      axiosCtl.impl = async () => redirect(loc)
      const r = await tFetchUrl({ url: 'https://public.example.com/x' })
      expect(r.ok).toBe(false)
      expect(r.text).toContain('禁止访问')
    }
  })

  it('重定向次数超过上限 → 明确报错', async () => {
    let n = 0
    axiosCtl.impl = async () => {
      n++
      return redirect(`https://hop${n}.example.com/`)
    }
    const r = await tFetchUrl({ url: 'https://public.example.com/x' })
    expect(r.ok).toBe(false)
    expect(r.text).toContain('重定向次数过多')
  })

  it('初始地址即为回环 → 不发任何请求直接拒绝', async () => {
    const calls: string[] = []
    axiosCtl.impl = async (url) => {
      calls.push(url)
      return ok('x')
    }
    const r = await tFetchUrl({ url: 'http://127.0.0.1:8188/system_stats' })
    expect(r.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })
})
