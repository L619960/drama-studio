/**
 * 会话持久化：按 scope（'global' 或 projectId）读写 conversations/<scope>.json。
 * 从 conversationService.ts 抽出，行为不变。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ConversationMessage } from '../../shared/ipcTypes'
import { atomicWriteJson } from './fsUtil'
import type { ConversationService } from './conversationService'
import { createLogger } from './logger'

const log = createLogger('ConvSession')

export function scopeFileImpl(agent: ConversationService, scope: string): string {
  const safe = /^[a-zA-Z0-9_-]+$/.test(scope) ? scope : 'global'
  return path.join(agent.baseDir, 'conversations', `${safe}.json`)
}

export async function listImpl(agent: ConversationService, scope: string): Promise<ConversationMessage[]> {
  const file = agent.scopeFile(scope)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return [] // 文件不存在/读取失败：视为空历史
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) throw new Error('历史文件不是消息数组')
    return parsed as ConversationMessage[]
  } catch (e) {
    // C6：历史文件损坏时先备份再按空历史处理，防止 save 直接覆盖清零导致无法找回
    const bak = `${file}.corrupt-${Date.now()}.bak`
    await fs.writeFile(bak, raw, 'utf8').catch(() => undefined)
    log.warn(`会话历史解析失败，已备份到 ${bak}: ${e instanceof Error ? e.message : e}`)
    return []
  }
}

export async function clearImpl(agent: ConversationService, scope: string): Promise<void> {
  await fs.rm(agent.scopeFile(scope), { force: true })
}

/** 项目被删除时清理主进程内存指针，防止「幽灵项目」残留 */
export function forgetProjectImpl(agent: ConversationService, id: string): void {
  if (agent.lastProjectId === id) agent.lastProjectId = undefined
}

export async function saveImpl(agent: ConversationService, scope: string, msgs: ConversationMessage[]): Promise<void> {
  const file = agent.scopeFile(scope)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await atomicWriteJson(file, msgs.slice(-200))
}
