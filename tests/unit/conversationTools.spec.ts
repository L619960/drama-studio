import { describe, it, expect } from 'vitest'
import { isBlockedFetchHost, tFetchUrl } from '../../src/main/core/conversationTools'

/** 模拟 tFetchUrl 内部判定路径：new URL(url).hostname → isBlockedFetchHost */
function blockedByFetchUrl(url: string): boolean {
  try {
    return isBlockedFetchHost(new URL(url).hostname)
  } catch {
    return false
  }
}

describe('isBlockedFetchHost（tFetchUrl SSRF 受限防护）', () => {
  it.each([
    // 回环
    ['127.0.0.1', true],
    ['127.0.0.254', true],
    ['127.255.255.254', true],
    ['localhost', true],
    ['localhost.', true],
    ['api.localhost', true],
    ['::1', true],
    // 私网 IPv4
    ['10.0.0.1', true],
    ['10.255.255.254', true],
    ['172.16.0.1', true],
    ['172.31.255.254', true],
    ['192.168.1.1', true],
    // 私网边界放行
    ['172.15.0.1', false],
    ['172.32.0.1', false],
    // 链路本地 / 云元数据
    ['169.254.169.254', true],
    ['169.254.1.5', true],
    ['fe80::1', true],
    ['fe80::abcd:1', true],
    // 未指定地址
    ['0.0.0.0', true],
    ['::', true],
    // 内网域名后缀
    ['nas.local', true],
    ['jenkins.internal', true],
    // 公网放行
    ['example.com', false],
    ['api.github.com', false],
    ['1.1.1.1', false],
    ['8.8.8.8', false]
  ])('%s → blocked=%s', (host, expected) => {
    expect(isBlockedFetchHost(host)).toBe(expected)
  })

  it('tFetchUrl 完整链路：内网/云元数据地址在发请求前被拒', async () => {
    const cases = [
      'http://127.0.0.1:8188/system_stats',       // 本机 ComfyUI
      'http://169.254.169.254/latest/meta-data', // 云元数据
      'http://10.0.0.5:3000',                    // 私网
      'http://192.168.1.1/',                      // 私网
      'http://172.20.0.2/',                       // 私网
      'http://localhost:11434/'                    // 回环域名
    ]
    for (const u of cases) {
      const r = await tFetchUrl({ url: u })
      expect(r.ok).toBe(false)
      expect(r.text).toContain('该地址被禁止访问')
    }
  })

  it('tFetchUrl 协议校验保持不变：非 http(s) 仍拒', async () => {
    const r = await tFetchUrl({ url: 'ftp://example.com/file' })
    expect(r.ok).toBe(false)
    expect(r.text).toContain('http/https')
  })

  it('tFetchUrl 公网地址不被 SSRF 规则误拦（仅验前置分支不拦截，不发网络请求）', () => {
    expect(blockedByFetchUrl('http://example.com/')).toBe(false)
    expect(blockedByFetchUrl('https://api.github.com/')).toBe(false)
  })
})
