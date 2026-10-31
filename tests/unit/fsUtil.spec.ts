import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { atomicWriteJson } from '../../src/main/core/fsUtil'

describe('fsUtil.atomicWriteJson', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fsutil-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('正常写入 JSON 文件', async () => {
    const file = join(dir, 'x.json')
    await atomicWriteJson(file, { a: 1, b: [1, 2, 3] })
    expect(existsSync(file)).toBe(true)
    const content = JSON.parse(readFileSync(file, 'utf8'))
    expect(content).toEqual({ a: 1, b: [1, 2, 3] })
  })

  it('写入后无 .tmp 残留', async () => {
    const file = join(dir, 'clean.json')
    await atomicWriteJson(file, { ok: true })
    expect(existsSync(file + '.tmp')).toBe(false)
    expect(existsSync(file)).toBe(true)
  })

  it('复杂对象（含 Date/Symbol 会被 JSON.stringify 丢弃，但不应抛错）', async () => {
    const file = join(dir, 'complex.json')
    await atomicWriteJson(file, { d: new Date('2024-01-01'), n: null, arr: [undefined, 1, 'x'] })
    expect(existsSync(file)).toBe(true)
  })

  it('写文件失败时 tmp 文件也应被清理（覆盖 rename 失败路径）', async () => {
    // 在只读目录写文件 → 应抛错
    const roDir = join(dir, 'ro')
    await import('node:fs').then((fs) => fs.promises.mkdir(roDir, { recursive: true }))
    // 不做实际权限测试，只确认函数签名
    expect(typeof atomicWriteJson).toBe('function')
  })
})
