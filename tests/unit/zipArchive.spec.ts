import { describe, it, expect } from 'vitest'
import { createZip, readZip, assertSafeEntryPath } from '../../src/shared/zipArchive'

describe('shared/zipArchive', () => {
  it('打包后能原样读回文本与二进制条目（含中文文件名）', () => {
    const binary = Buffer.from([0, 1, 2, 255, 254, 128])
    const zip = createZip([
      { path: 'project.json', data: Buffer.from('{"title":"重生"}', 'utf8') },
      { path: '成片/final.mp4', data: binary },
    ])
    const entries = readZip(zip)
    expect(entries.map((e) => e.path)).toEqual(['project.json', '成片/final.mp4'])
    expect(entries[0]?.data.toString('utf8')).toBe('{"title":"重生"}')
    expect(entries[1]?.data.equals(binary)).toBe(true)
  })

  it('重复内容按 deflate 压缩后仍可还原', () => {
    const text = 'A'.repeat(10_000)
    const zip = createZip([{ path: 'a.txt', data: Buffer.from(text) }])
    const [entry] = readZip(zip)
    expect(entry?.data.toString()).toBe(text)
  })

  it('拒绝目录穿越与绝对路径', () => {
    expect(() => assertSafeEntryPath('../../etc/passwd')).toThrow('非法路径')
    expect(() => assertSafeEntryPath('C:\\Windows\\system.ini')).toThrow('非法绝对路径')
    expect(() => assertSafeEntryPath('a/../../b')).toThrow('非法路径')
    expect(() => createZip([{ path: '../evil.txt', data: Buffer.from('x') }])).toThrow('非法路径')
  })

  it('非 ZIP 数据给出可读错误', () => {
    expect(() => readZip(Buffer.from('not a zip'))).toThrow('不是有效的项目包')
  })
})
