import { describe, it, expect, vi } from 'vitest'

// conversationToolsFile 直接 import electron + fs/promises
vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() }
}))
// 用 vi.mock 替代 vi.spyOn —— ESM 内置模块不支持 spyOn
vi.mock('node:fs/promises', () => ({
  default: {},
  stat: vi.fn(async () => { throw new Error('ENOENT') }),
  readdir: vi.fn(async () => []),
  copyFile: vi.fn(async () => {})
}))

import { tSetProjectBgm, tOpenFile } from '../../src/main/core/conversationToolsFile'

const BASE_DIR = 'C:/data'

describe('conversationToolsFile · tSetProjectBgm（参数校验分支，不触发 fs）', () => {
  it('缺少 pid → ok=false', async () => {
    const r = await tSetProjectBgm({ baseDir: BASE_DIR } as any, undefined, { absolute_path: 'C:/foo.mp3' })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/没有打开/)
  })

  it('缺少 absolute_path → ok=false', async () => {
    const r = await tSetProjectBgm({ baseDir: BASE_DIR } as any, 'pid1', {})
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/absolute_path/)
  })

  it('不支持的音频格式 → ok=false', async () => {
    const r = await tSetProjectBgm({ baseDir: BASE_DIR } as any, 'pid1', { absolute_path: 'C:/foo.exe' })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/不支持/)
  })

  it('支持的扩展名 .mp3 通过校验，走到 fs.stat → 文件不存在', async () => {
    const r = await tSetProjectBgm({ baseDir: BASE_DIR } as any, 'pid1', { absolute_path: 'C:/foo.mp3' })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/文件不存在/)
  })

  it('支持 .wav 扩展名', async () => {
    const r = await tSetProjectBgm({ baseDir: BASE_DIR } as any, 'pid1', { absolute_path: 'C:/foo.WAV' })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/文件不存在/) // 通过扩展名校验但文件不存在
  })
})

describe('conversationToolsFile · tOpenFile（路径安全分支）', () => {
  it('缺少 relative_path → ok=false', async () => {
    const r = await tOpenFile({ baseDir: BASE_DIR } as any, {})
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/relative_path/)
  })

  it('路径穿越 ../ 越界 → ok=false（路径安全校验）', async () => {
    const r = await tOpenFile({ baseDir: BASE_DIR } as any, { relative_path: '../secret.txt' })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/数据目录内/)
  })

  it('绝对路径外部文件 → ok=false', async () => {
    const r = await tOpenFile({ baseDir: BASE_DIR } as any, { relative_path: 'D:/outside.txt' })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/数据目录内/)
  })

  it('合法相对路径走到 fs.stat → 文件不存在', async () => {
    const r = await tOpenFile({ baseDir: BASE_DIR } as any, { relative_path: 'projects/pid/x.mp4' })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/文件不存在/)
  })
})
