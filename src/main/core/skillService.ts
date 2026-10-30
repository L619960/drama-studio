import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Skill } from '../../shared/ipcTypes'
import { atomicWriteJson } from './fsUtil'
import { BUILTIN_SKILLS } from './builtinSkills'
import { createLogger } from './logger'

const log = createLogger('SkillService')

/**
 * 导演技能框架：
 * - 内置技能（builtin, kind=tool）绑定对话工具，对应真实操作
 * - 自定义技能（kind=prompt）是用户可编辑的提示词模板，调用时按模板走一次 LLM
 * - 启用状态持久化 dataRoot/skills.json，升级时补齐新增内置技能
 */

export { BUILTIN_SKILLS } from './builtinSkills'
export { BUILTIN_TOOL_SPECS, customToolSpec } from './builtinToolSpecs'

const SAVE_FILE = 'skills.json'

export class SkillService {
  private cache: Skill[] | null = null

  constructor(private baseDir: string) {}

  private get file(): string {
    return path.join(this.baseDir, SAVE_FILE)
  }

  /** 读取全部技能；首次运行或升级时补齐内置种子 */
  async list(): Promise<Skill[]> {
    if (this.cache) return this.cache
    let saved: Skill[] = []
    // 读取失败 ≠ 首次运行：损坏/被占用/权限错误时禁止覆盖回写，
    // 否则用户自定义技能会被"仅含内置技能"的列表静默清零
    let readFailed = false
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (!Array.isArray(parsed)) throw new Error('skills.json 结构不是数组')
      saved = parsed as Skill[]
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err?.code === 'ENOENT') {
        // 首次运行：还没有历史文件
      } else {
        readFailed = true
        log.warn(`技能库读取失败，本轮跳过回写以保护历史数据: ${(e as Error).message}`)
        // 损坏文件先改名备份（与会话自检的备份策略一致），再以内置技能兜底启动；
        // 备份失败（如文件被占用）不阻塞启动，同样因 readFailed 不会回写
        try {
          await fs.rename(this.file, `${this.file}.bak_${Date.now()}`)
        } catch {
          // 忽略
        }
      }
    }
    const savedMap = new Map(saved.map(s => [s.id, s]))
    // 内置以代码为准（描述升级生效），启用状态沿用用户配置
    const merged: Skill[] = BUILTIN_SKILLS.map(b => {
      const old = savedMap.get(b.id)
      return old ? { ...b, enabled: old.enabled } : b
    })
    // 用户自定义技能追加在后
    for (const s of saved) {
      if (!s.builtin) merged.push(s)
    }
    this.cache = merged
    if (!readFailed) await this.persist()
    // 返回浅拷贝（M-17）：外部直接对返回数组 push/sort 会污染缓存，
    // 导致本应落盘的数据在内存中被"凭空"增删
    return [...merged]
  }

  /** 变更串行链：create/update/remove 并发时读-改-写互相覆盖会丢技能（同 M-8 的会话链模式） */
  private writeChain: Promise<unknown> = Promise.resolve()

  private enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(fn, fn)
    this.writeChain = next.catch(() => undefined)
    return next
  }

  async create(input: { name: string; description: string; promptTemplate: string }): Promise<Skill> {
    return this.enqueueWrite(async () => {
      const all = await this.list()
      const skill: Skill = {
        id: `sk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        name: input.name.trim(),
        description: input.description.trim(),
        enabled: true,
        builtin: false,
        kind: 'prompt',
        promptTemplate: input.promptTemplate,
        createdAt: Date.now()
      }
      all.push(skill)
      this.cache = all
      await this.persist()
      return skill
    })
  }

  async update(
    id: string,
    patch: Partial<Pick<Skill, 'name' | 'description' | 'enabled' | 'promptTemplate'>>
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const all = await this.list()
      const idx = all.findIndex(s => s.id === id)
      if (idx < 0) throw new Error('技能不存在')
      all[idx] = { ...all[idx], ...patch }
      this.cache = all
      await this.persist()
    })
  }

  async remove(id: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const all = await this.list()
      const target = all.find(s => s.id === id)
      if (!target) return
      if (target.builtin) throw new Error('内置技能不可删除')
      this.cache = all.filter(s => s.id !== id)
      await this.persist()
    })
  }

  async toggle(id: string, enabled: boolean): Promise<void> {
    await this.update(id, { enabled })
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await atomicWriteJson(this.file, this.cache || [])
  }
}
