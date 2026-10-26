import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { MemoryItem, MemoryKind } from '../../shared/ipcTypes'
import { atomicWriteJson } from './fsUtil'

const SAVE_FILE = 'memory.json'
const KIND_TITLE: Record<MemoryKind, string> = {
  preference: '用户偏好',
  rule: '制作规则',
  lesson: '经验教训'
}
const PER_KIND_LIMIT = 30
/** token 优化：单条记忆注入 system prompt 的内容截断长度（title 全文 + content 截断）。
 *  记忆库 19 条实测 ≈ 1.5 万字符，若全量注入，每轮对话 ≈ 1 万 tokens 固定开销；
 *  截断到关键首段（规则类记忆头部通常即结论），细节需要时用 list_memories 工具取全文。 */
const MEMORY_CONTENT_KEEP = 240
/** 记忆摘要总预算（字符）：超出按更新时间从旧到新截断，防止记忆无限膨胀拖垮每轮上下文 */
const MEMORY_SUMMARY_BUDGET = 5000

/**
 * 导演跨项目长期记忆：偏好 / 规则 / 经验。
 * 全局单一文件 dataRoot/memory.json，对话 system prompt 注入摘要。
 */
export class MemoryStore {
  private cache: MemoryItem[] | null = null
  /** 变更串行链：create/update/remove 共用一条 Promise 链，避免并发读-改-写互相覆盖（M-8） */
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(private baseDir: string) {}

  private enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(fn, fn)
    this.writeChain = next.catch(() => undefined)
    return next
  }

  private get file(): string {
    return path.join(this.baseDir, SAVE_FILE)
  }

  async list(kind?: MemoryKind): Promise<MemoryItem[]> {
    if (!this.cache) {
      try {
        this.cache = JSON.parse(await fs.readFile(this.file, 'utf8')) as MemoryItem[]
      } catch {
        this.cache = []
      }
    }
    const all = [...this.cache].sort((a, b) => b.updatedAt - a.updatedAt)
    return kind ? all.filter(m => m.kind === kind) : all
  }

  async create(input: { kind: MemoryKind; title: string; content: string }): Promise<MemoryItem> {
    return this.enqueueWrite(async () => {
      const all = await this.list()
      const now = Date.now()
      const item: MemoryItem = {
        id: `mem_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        kind: input.kind,
        title: input.title.trim(),
        content: input.content.trim(),
        createdAt: now,
        updatedAt: now
      }
      all.unshift(item)
      this.cache = all
      await this.persist()
      return item
    })
  }

  async update(id: string, patch: Partial<Pick<MemoryItem, 'title' | 'content' | 'kind'>>): Promise<void> {
    await this.enqueueWrite(async () => {
      const all = await this.list()
      const idx = all.findIndex(m => m.id === id)
      if (idx < 0) throw new Error('记忆不存在')
      all[idx] = { ...all[idx], ...patch, updatedAt: Date.now() }
      this.cache = all
      await this.persist()
    })
  }

  async remove(id: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const all = await this.list()
      this.cache = all.filter(m => m.id !== id)
      await this.persist()
    })
  }

  /** 生成注入 system prompt 的中文摘要（截断长内容 + 总预算裁剪） */
  async summary(): Promise<string> {
    const all = await this.list()
    if (!all.length) return ''
    const sections: string[] = []
    let total = 0
    for (const kind of ['preference', 'rule', 'lesson'] as MemoryKind[]) {
      const items = all.filter(m => m.kind === kind).slice(0, PER_KIND_LIMIT)
      if (!items.length) continue
      const lines: string[] = []
      for (const m of items) {
        const content = m.content.length > MEMORY_CONTENT_KEEP
          ? `${m.content.slice(0, MEMORY_CONTENT_KEEP)}…（后略，需要全文可让我调 list_memories）`
          : m.content
        const line = `- ${m.title}：${content}`
        if (total + line.length > MEMORY_SUMMARY_BUDGET) {
          lines.push(`- ${m.title}：…（记忆较长已略，需要全文可让我调 list_memories）`)
          break
        }
        lines.push(line)
        total += line.length
      }
      sections.push(`【${KIND_TITLE[kind]}】\n${lines.join('\n')}`)
    }
    return sections.join('\n')
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await atomicWriteJson(this.file, this.cache || [])
  }
}
