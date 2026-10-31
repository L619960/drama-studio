import { describe, it, expect, vi } from 'vitest'
import { dirname } from 'node:path'
import { statfs } from 'node:fs/promises'
import { LOW_DISK_THRESHOLD_BYTES, formatFreeSpace, isLowDiskSpace } from '../../src/shared/diskSpace'

vi.mock('node:fs/promises', () => ({ statfs: vi.fn() }))

import { getDiskSpace } from '../../src/main/core/diskSpace'

describe('磁盘空间判定与文案（REQ-15 DC-OPEN-22）', () => {
  it('低于 5GB 判为告急，等于阈值不算', () => {
    expect(isLowDiskSpace(LOW_DISK_THRESHOLD_BYTES - 1)).toBe(true)
    expect(isLowDiskSpace(LOW_DISK_THRESHOLD_BYTES)).toBe(false)
    expect(isLowDiskSpace(LOW_DISK_THRESHOLD_BYTES + 100)).toBe(false)
  })

  it('非法值不触发告警', () => {
    expect(isLowDiskSpace(Number.NaN)).toBe(false)
    expect(isLowDiskSpace(-1)).toBe(false)
  })

  it('支持自定义阈值（测试/特殊盘符）', () => {
    expect(isLowDiskSpace(2 * 1024 ** 3, 3 * 1024 ** 3)).toBe(true)
    expect(isLowDiskSpace(4 * 1024 ** 3, 3 * 1024 ** 3)).toBe(false)
  })

  it('文案：GB 保留一位小数，不足 1GB 用 MB', () => {
    expect(formatFreeSpace(4.2 * 1024 ** 3)).toBe('4.2 GB')
    expect(formatFreeSpace(3.5 * 1024 ** 2)).toBe('4 MB')
    expect(formatFreeSpace(Number.NaN)).toBe('未知')
  })
})

describe('主进程磁盘统计：数据目录不存在时的回退（P2-01）', () => {
  const st = { bavail: 100, blocks: 200, bsize: 4096 }

  it('目录存在时按字节返回可用/总空间', async () => {
    vi.mocked(statfs).mockResolvedValueOnce(st as never)
    const r = await getDiskSpace('C:/data/drama-studio')
    expect(r).toEqual({ freeBytes: 100 * 4096, totalBytes: 200 * 4096 })
  })

  it('数据目录 ENOENT 时回退到父目录，仍统计同一块盘', async () => {
    const child = 'C:/data/drama-studio'
    vi.mocked(statfs)
      .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      .mockResolvedValueOnce(st as never)
    const r = await getDiskSpace(child)
    expect(vi.mocked(statfs).mock.calls[1]?.[0]).toBe(dirname(child))
    expect(r.freeBytes).toBe(100 * 4096)
  })

  it('非 ENOENT 错误不吞掉，直接抛出', async () => {
    vi.mocked(statfs).mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
    await expect(getDiskSpace('/tmp/x')).rejects.toThrow('EACCES')
  })

  it('一路回退到根仍不存在时抛出原始 ENOENT', async () => {
    vi.mocked(statfs).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    await expect(getDiskSpace('/tmp/x')).rejects.toThrow('ENOENT')
  })
})
