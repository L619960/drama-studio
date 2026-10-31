/**
 * SEC-05 单测：跨 IPC 错误文本脱敏。
 * 覆盖：数据根路径替换（斜杠变体）、密钥/令牌掩码、控制字符剔除、超长截断、普通文案保留。
 */
import { describe, it, expect } from 'vitest'
import { sanitizeErrorText } from '../../src/shared/errorSanitize'

const ROOT = 'C:\\Users\\tester\\AppData\\Roaming\\drama-studio'

describe('sanitizeErrorText', () => {
  it('数据根路径（反斜杠 / 正斜杠 / 混合）统一替换为 <DATA_ROOT>', () => {
    const raw = [
      `${ROOT}\\projects\\p_abcd\\final.mp4 不存在`,
      `${ROOT.replace(/\\/g, '/')}/projects/p_abcd/final.mp4 不存在`,
      `${ROOT.replace(/\\/g, '/').replace(/\//g, '/')}`,
    ].join('\n')
    const out = sanitizeErrorText(raw, { dataRoot: ROOT })
    expect(out).not.toContain('C:\\Users')
    expect(out).not.toContain('/Users/tester')
    expect(out).toContain('<DATA_ROOT>')
  })

  it('密钥样式（sk-/Bearer/token=）被掩码', () => {
    const raw =
      '请求失败 Authorization: Bearer abc123def456ghi789, apiKey=sk-live-1234567890abcdef token=abcdef123456 独立密钥 sk-abc12345xyz'
    const out = sanitizeErrorText(raw)
    expect(out).not.toContain('abc123def456ghi789')
    expect(out).not.toContain('sk-live-1234567890abcdef')
    expect(out).not.toContain('abcdef123456')
    expect(out).not.toContain('abc12345xyz')
    expect(out).toContain('Bearer ***')
    expect(out).toContain('apiKey=***')
    expect(out).toContain('sk-***')
  })

  it('剔除不可见控制字符，保留换行与制表符', () => {
    const out = sanitizeErrorText('a\u0000b\u0007c\n\tok\u007f')
    expect(out).toBe('abc\n\tok')
  })

  it('超长错误截断到 500 字并标记，默认不截断短文案', () => {
    const short = '渲染失败：镜头 3 首帧缺失'
    expect(sanitizeErrorText(short)).toBe(short)
    const long = 'x'.repeat(600)
    const out = sanitizeErrorText(long)
    expect(out.length).toBeLessThan(520)
    expect(out).toContain('已截断')
  })

  it('非字符串输入（undefined / Error）安全降级为字符串', () => {
    expect(sanitizeErrorText(undefined)).toBe('')
    expect(sanitizeErrorText(new Error('boom'))).toBe('Error: boom')
  })
})
