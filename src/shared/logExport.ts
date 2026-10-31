import type { DirectorLogEntry } from './ipcTypes'

/** 本地时间戳 → YYYY-MM-DD HH:mm:ss.SSS（与面板显示同一时区） */
function formatTimestamp(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return ''
  const d = new Date(ts)
  const p = (n: number, len = 2) => String(n).padStart(len, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/** 单条日志 → 导出文本行（含结构化明细，与面板展开后内容一致） */
export function formatLogLine(entry: DirectorLogEntry): string {
  const kind = entry.errorKind ? ` [${entry.errorKind}]` : ''
  const head = `[${formatTimestamp(entry.timestamp)}] [${entry.level}] ${entry.stage}: ${entry.message}${kind}`
  return entry.detail ? `${head}\n${entry.detail}` : head
}

/** 日志环形缓冲 → .txt 文本（REQ-18 按项目导出） */
export function buildLogText(entries: DirectorLogEntry[]): string {
  return entries.map(formatLogLine).join('\n')
}
