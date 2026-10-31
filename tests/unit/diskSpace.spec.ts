import { describe, it, expect } from 'vitest'
import { LOW_DISK_THRESHOLD_BYTES, formatFreeSpace, isLowDiskSpace } from '../../src/shared/diskSpace'

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
