import { describe, it, expect } from 'vitest'
import { buildLogText, formatLogLine } from '../../src/shared/logExport'
import type { DirectorLogEntry } from '../../src/shared/ipcTypes'

function entry(partial: Partial<DirectorLogEntry> = {}): DirectorLogEntry {
  return {
    id: 1,
    stage: 'render',
    level: 'info',
    message: '测试消息',
    timestamp: new Date(2026, 9, 31, 10, 30, 5, 120).getTime(),
    ...partial
  }
}

describe('日志导出文本（REQ-18）', () => {
  it('单条：本地时间 + 级别 + 阶段 + 消息', () => {
    expect(formatLogLine(entry())).toBe('[2026-10-31 10:30:05.120] [info] render: 测试消息')
  })

  it('带 errorKind 时附分类标记', () => {
    expect(formatLogLine(entry({ level: 'error', errorKind: 'oom', message: '显存不足' })))
      .toBe('[2026-10-31 10:30:05.120] [error] render: 显存不足 [oom]')
  })

  it('带结构化明细时换行附在下一行，保持原缩进', () => {
    const line = formatLogLine(entry({ detail: '{\n  "shotId": "s1"\n}' }))
    expect(line.endsWith('测试消息\n{\n  "shotId": "s1"\n}')).toBe(true)
  })

  it('批量导出按条换行', () => {
    const text = buildLogText([entry({ id: 1, message: 'A' }), entry({ id: 2, message: 'B' })])
    expect(text.split('\n').filter(Boolean)).toHaveLength(2)
    expect(text).toContain('A')
    expect(text).toContain('B')
  })
})
