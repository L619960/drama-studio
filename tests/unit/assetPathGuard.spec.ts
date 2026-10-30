/**
 * assetPathGuard 单测（S-06 / P1-5）：
 * 素材路径白名单——扩展名分类、控制字符、绝对路径要求、盘符跨平台识别。
 */
import { describe, it, expect } from 'vitest'
import { assertMediaPath } from '../../src/main/core/assetPathGuard'

describe('assertMediaPath · 扩展名白名单', () => {
  it('图片扩展名通过并归一化小写判断（.PNG）', () => {
    expect(assertMediaPath('C:/a.PNG', 'image')).toBe('C:/a.PNG')
    expect(assertMediaPath('C:/a.jpeg', 'image')).toBe('C:/a.jpeg')
    expect(assertMediaPath('C:/a.webp', 'image')).toBe('C:/a.webp')
  })

  it('音频/视频扩展名各自通过', () => {
    expect(assertMediaPath('C:/b.flac', 'audio')).toBe('C:/b.flac')
    expect(assertMediaPath('C:/c.mkv', 'video')).toBe('C:/c.mkv')
  })

  it('敏感文件与未知扩展名被拒绝', () => {
    expect(() => assertMediaPath('C:/Users/x/.ssh/id_rsa', 'image', '参考图')).toThrow(/格式不支持/)
    expect(() => assertMediaPath('C:/a.exe', 'audio', 'BGM 文件')).toThrow(/格式不支持/)
    expect(() => assertMediaPath('C:/notes.txt', 'video')).toThrow(/格式不支持/)
  })

  it('跨类别扩展名不通过（mp3 不能当参考图）', () => {
    expect(() => assertMediaPath('C:/a.mp3', 'image')).toThrow(/格式不支持/)
  })
})

describe('assertMediaPath · 输入清洗', () => {
  it('空路径与纯空白拒绝', () => {
    expect(() => assertMediaPath('', 'image')).toThrow(/路径为空/)
    expect(() => assertMediaPath('   ', 'image')).toThrow(/路径为空/)
  })

  it('含换行/回车/NUL 拒绝（首尾空白已被 trim，这里用内嵌控制字符）', () => {
    expect(() => assertMediaPath('C:/a.png\nrm -rf', 'image')).toThrow(/控制字符/)
    expect(() => assertMediaPath('C:/a\r.png', 'image')).toThrow(/控制字符/)
    expect(() => assertMediaPath('C:/a\0.png', 'image')).toThrow(/控制字符/)
  })

  it('首尾空白被裁剪', () => {
    expect(assertMediaPath('  C:/a.png  ', 'image')).toBe('C:/a.png')
  })
})

describe('assertMediaPath · requireAbsolute', () => {
  it('默认不要求绝对路径（内部流程可用相对路径）', () => {
    expect(assertMediaPath('projects/p1/a.png', 'image')).toBe('projects/p1/a.png')
  })

  it('requireAbsolute 拒绝相对路径', () => {
    expect(() => assertMediaPath('a.png', 'image', '参考图', { requireAbsolute: true }))
      .toThrow(/必须是绝对路径/)
  })

  it('requireAbsolute 接受 POSIX 与 Windows 盘符绝对路径', () => {
    expect(assertMediaPath('/home/x/a.png', 'image', '参考图', { requireAbsolute: true })).toBe('/home/x/a.png')
    expect(assertMediaPath('E:/tmp/a.png', 'image', '参考图', { requireAbsolute: true })).toBe('E:/tmp/a.png')
    expect(assertMediaPath('E:\\tmp\\a.png', 'image', '参考图', { requireAbsolute: true })).toBe('E:\\tmp\\a.png')
  })
})
