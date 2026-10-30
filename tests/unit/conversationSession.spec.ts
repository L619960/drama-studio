/* eslint-disable @typescript-eslint/no-explicit-any -- 测试以最小 mock 对象替代真实服务依赖 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  scopeFileImpl, listImpl, clearImpl, forgetProjectImpl, saveImpl
} from '../../src/main/core/conversationSession'
import type { ConversationMessage } from '../../src/shared/ipcTypes'

/**
 * 会话持久化（conversationSession 首个 spec）：scope 文件名净化、缺失/损坏文件兜底、
 * 200 条截断、清除与项目指针回收。
 */
describe('conversationSession', () => {
  let dir: string
  let agent: any

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-conv-'))
    agent = {
      baseDir: dir,
      lastProjectId: undefined as string | undefined,
      scopeFile: (scope: string) => scopeFileImpl(agent, scope)
    }
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  const msg = (i: number): ConversationMessage => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `m${i}`,
    timestamp: i
  } as ConversationMessage)

  it('scope 只接受字母数字下划线连字符，其余回退 global', () => {
    expect(scopeFileImpl(agent, 'project_abc-1')).toBe(path.join(dir, 'conversations', 'project_abc-1.json'))
    expect(scopeFileImpl(agent, '../evil')).toBe(path.join(dir, 'conversations', 'global.json'))
    expect(scopeFileImpl(agent, '中文')).toBe(path.join(dir, 'conversations', 'global.json'))
  })

  it('文件不存在时返回空历史', async () => {
    await expect(listImpl(agent, 'p1')).resolves.toEqual([])
  })

  it('save 后能读回，且只保留最后 200 条', async () => {
    const many = Array.from({ length: 230 }, (_, i) => msg(i))
    await saveImpl(agent, 'p1', many)
    const list = await listImpl(agent, 'p1')
    expect(list).toHaveLength(200)
    expect(list[0].content).toBe('m30')
    expect(list[199].content).toBe('m229')
  })

  it('历史文件损坏：备份原文并返回空历史，不覆盖原文件', async () => {
    const file = scopeFileImpl(agent, 'p1')
    await fs.mkdir(path.dirname(file), { recursive: true })
    const broken = '{"broken":'
    await fs.writeFile(file, broken)

    await expect(listImpl(agent, 'p1')).resolves.toEqual([])
    const entries = await fs.readdir(path.join(dir, 'conversations'))
    const bak = entries.find(n => n.includes('.corrupt-') && n.endsWith('.bak'))
    expect(bak).toBeTruthy()
    expect(await fs.readFile(path.join(dir, 'conversations', bak!), 'utf8')).toBe(broken)
    // 损坏文件仍保留，等待用户/后续手工恢复
    expect(await fs.readFile(file, 'utf8')).toBe(broken)
  })

  it('历史文件不是数组：同样按损坏处理', async () => {
    const file = scopeFileImpl(agent, 'p1')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ messages: [] }))
    await expect(listImpl(agent, 'p1')).resolves.toEqual([])
    const entries = await fs.readdir(path.join(dir, 'conversations'))
    expect(entries.some(n => n.includes('.corrupt-'))).toBe(true)
  })

  it('clear 删除该 scope 历史，不影响其他 scope', async () => {
    await saveImpl(agent, 'p1', [msg(0)])
    await saveImpl(agent, 'p2', [msg(1)])
    await clearImpl(agent, 'p1')
    await expect(listImpl(agent, 'p1')).resolves.toEqual([])
    await expect(listImpl(agent, 'p2')).resolves.toHaveLength(1)
  })

  it('forgetProject 只清理匹配的项目指针', () => {
    agent.lastProjectId = 'p1'
    forgetProjectImpl(agent, 'p2')
    expect(agent.lastProjectId).toBe('p1')
    forgetProjectImpl(agent, 'p1')
    expect(agent.lastProjectId).toBeUndefined()
  })
})
