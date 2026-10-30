import { describe, it, expect, vi } from 'vitest'

// conversationToolsNetwork 通过 barrel 间接依赖 electron（conversationToolsFile）
vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() }
}))
// axios 在测试里不发请求
vi.mock('axios', () => ({
  default: {
    get: vi.fn(async () => ({ data: '', headers: {} }))
  }
}))

import { isBlockedFetchHost } from '../../src/main/core/conversationToolsNetwork'

describe('conversationToolsNetwork · isBlockedFetchHost（补充边界）', () => {
  // 已有 conversationTools.spec.ts 覆盖基础场景；这里补 normalizeIpv6 的边界分支

  it('IPv6 zone id 被剥除：fe80::1%eth0 → block', () => {
    expect(isBlockedFetchHost('fe80::1%eth0')).toBe(true)
  })

  it('非法 IPv6 让 normalizeIpv6 返回 null → 放行（交给 axios 报错）', () => {
    // 不是 IPv6 格式
    expect(isBlockedFetchHost('not-an-ip')).toBe(false)
    // IPv6 压缩段过多导致 left+right >= 8 → normalizeIpv6 返回 null → 放行
    expect(isBlockedFetchHost('a:b:c:d::e:f:g:h')).toBe(false)
  })

  it('IPv6 完整 8 段但不匹配任何规则 → 放行', () => {
    // 2001:db8::1 公共文档地址
    expect(isBlockedFetchHost('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(false)
  })

  it('::1 回环 → block', () => {
    expect(isBlockedFetchHost('::1')).toBe(true)
  })

  it('::（未指定）→ block', () => {
    expect(isBlockedFetchHost('::')).toBe(true)
  })

  it('fe80::/10 链路本地 → block', () => {
    expect(isBlockedFetchHost('fe80::1')).toBe(true)
    expect(isBlockedFetchHost('febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(true)
    // fec0::/10 是旧 site-local，不在我们的 block 里
    expect(isBlockedFetchHost('fec0::1')).toBe(false)
  })

  it('0.0.0.1（a===0）→ block', () => {
    expect(isBlockedFetchHost('0.0.0.1')).toBe(true)
  })

  it('非法 IPv4 字面量（octet > 255）→ 放行给 axios', () => {
    expect(isBlockedFetchHost('999.1.1.1')).toBe(false)
    expect(isBlockedFetchHost('1.2.3.999')).toBe(false)
  })

  it('末尾点 . 被 trim 掉', () => {
    expect(isBlockedFetchHost('127.0.0.1.')).toBe(true)
    expect(isBlockedFetchHost('example.com.')).toBe(false)
  })

  it('方括号包裹 IPv6 → 合法取出后判定', () => {
    expect(isBlockedFetchHost('[::1]')).toBe(true)
    expect(isBlockedFetchHost('[fe80::1]')).toBe(true)
    expect(isBlockedFetchHost('[2001:db8::1]')).toBe(false)
  })

  it('.local / .internal 域名后缀 → block', () => {
    expect(isBlockedFetchHost('nas.local')).toBe(true)
    expect(isBlockedFetchHost('jenkins.internal')).toBe(true)
  })

  it('.localhost 域名后缀 → block', () => {
    expect(isBlockedFetchHost('api.localhost')).toBe(true)
  })

  it('172.16..31 边界测试', () => {
    expect(isBlockedFetchHost('172.16.0.1')).toBe(true)
    expect(isBlockedFetchHost('172.31.255.254')).toBe(true)
    expect(isBlockedFetchHost('172.15.255.255')).toBe(false) // 172.15 不在 16..31
    expect(isBlockedFetchHost('172.32.0.0')).toBe(false) // 172.32 不在 16..31
  })
})
