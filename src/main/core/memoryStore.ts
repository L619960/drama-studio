import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { MemoryItem, MemoryKind } from '../../shared/ipcTypes'

const SAVE_FILE = 'memory.json'
const KIND_TITLE: Record<MemoryKind, string> = {
  preference: '用户偏好',
  rule: '制作规则',
  lesson: '经验教训'
}
const PER_KIND_LIMIT = 30

/**
 * 导演跨项目长期记忆：偏好 / 规则 / 经验。
 * 全局单一文件 dataRoot/memory.json，对话 system prompt 注入摘要。
 */
export class MemoryStore {
  private cache: MemoryItem[] | null = null

  constructor(private baseDir: string) {}

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
  }

  async update(id: string, patch: Partial<Pick<MemoryItem, 'title' | 'content' | 'kind'>>): Promise<void> {
    const all = await this.list()
    const idx = all.findIndex(m => m.id === id)
    if (idx < 0) throw new Error('记忆不存在')
    all[idx] = { ...all[idx], ...patch, updatedAt: Date.now() }
    this.cache = all
    await this.persist()
  }

  async remove(id: string): Promise<void> {
    const all = await this.list()
    this.cache = all.filter(m => m.id !== id)
    await this.persist()
  }

  /** 生成注入 system prompt 的中文摘要 */
  async summary(): Promise<string> {
    const all = await this.list()
    if (!all.length) return ''
    const sections: string[] = []
    for (const kind of ['preference', 'rule', 'lesson'] as MemoryKind[]) {
      const items = all.filter(m => m.kind === kind).slice(0, PER_KIND_LIMIT)
      if (!items.length) continue
      sections.push(
        `【${KIND_TITLE[kind]}】\n` +
        items.map(m => `- ${m.title}：${m.content}`).join('\n')
      )
    }
    return sections.join('\n')
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(this.file, JSON.stringify(this.cache || [], null, 2))
  }
}
