/** 低磁盘告警阈值：数据盘剩余空间低于 5GB 时提示清理（REQ-15 DC-OPEN-22） */
export const LOW_DISK_THRESHOLD_BYTES = 5 * 1024 ** 3

export function isLowDiskSpace(freeBytes: number, thresholdBytes: number = LOW_DISK_THRESHOLD_BYTES): boolean {
  if (!Number.isFinite(freeBytes) || freeBytes < 0) return false
  return freeBytes < thresholdBytes
}

/** 剩余空间的人类可读文案：>=1GB 用一位小数 GB，否则 MB */
export function formatFreeSpace(freeBytes: number): string {
  if (!Number.isFinite(freeBytes) || freeBytes < 0) return '未知'
  const gb = freeBytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${Math.max(1, Math.round(freeBytes / 1024 ** 2))} MB`
}
