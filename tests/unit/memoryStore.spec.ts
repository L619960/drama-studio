import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryStore } from '../../src/main/core/memoryStore'
import type { MemoryKind } from '../../src/shared/ipcTypes'

const KINDS: MemoryKind[] = ['preference', 'rule', 'lesson']

describe('MemoryStore', () => {
  let dir: string
  let store: MemoryStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mem-'))
    store = new MemoryStore(dir)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('list / create', () => {
    it('空存储返回空数组', async () => {
      expect(await store.list()).toEqual([])
    })

    it('create 后可 list 到，id 格式正确', async () => {
      const item = await store.create({ kind: 'preference', title: '喜欢短镜头', content: '尽量 2s 内' })
      expect(item.id).toMatch(/^mem_[0-9a-z]+_[0-9a-z]{4}$/)
      expect(item.createdAt).toBeGreaterThan(0)
      expect(item.updatedAt).toBeGreaterThan(0)
      expect(item.content).toBe('尽量 2s 内')
      expect(await store.list()).toHaveLength(1)
    })

    it('kind 过滤生效', async () => {
      await store.create({ kind: 'preference', title: 't1', content: 'c1' })
      await store.create({ kind: 'rule', title: 't2', content: 'c2' })
      await store.create({ kind: 'lesson', title: 't3', content: 'c3' })
      expect(await store.list('preference')).toHaveLength(1)
      expect(await store.list('rule')).toHaveLength(1)
      expect(await store.list('lesson')).toHaveLength(1)
      expect(await store.list()).toHaveLength(3)
    })

    it('title/content 自动 trim', async () => {
      const item = await store.create({ kind: 'rule', title: '  规则X  ', content: '  内容Y  ' })
      expect(item.title).toBe('规则X')
      expect(item.content).toBe('内容Y')
    })
  })

  describe('update / remove', () => {
    it('update 修改 content 和 updatedAt', async () => {
      const item = await store.create({ kind: 'preference', title: 't', content: 'old' })
      await store.update(item.id, { content: 'new' })
      const after = await store.list()
      expect(after[0]?.content).toBe('new')
      expect(after[0]?.updatedAt).toBeGreaterThanOrEqual(item.updatedAt)
    })

    it('update 不存在的 id 抛错', async () => {
      await expect(store.update('mem_fake', { content: 'x' })).rejects.toThrow('记忆不存在')
    })

    it('remove 删除条目', async () => {
      const item = await store.create({ kind: 'rule', title: 't', content: 'c' })
      await store.remove(item.id)
      expect(await store.list()).toEqual([])
    })

    it('remove 不存在的 id 静默（不抛错）', async () => {
      await expect(store.remove('mem_fake')).resolves.toBeUndefined()
    })
  })

  describe('summary 生成', () => {
    it('空存储返回空字符串', async () => {
      expect(await store.summary()).toBe('')
    })

    it('含条目时按 kind 分组生成中文摘要', async () => {
      await store.create({ kind: 'preference', title: '短镜头', content: '喜欢短镜头' })
      await store.create({ kind: 'rule', title: '单械', content: '角色只拿一把武器' })
      await store.create({ kind: 'lesson', title: '别用橙色', content: '橙色衣服在某些场景过曝' })
      const s = await store.summary()
      expect(s).toContain('【用户偏好】')
      expect(s).toContain('【制作规则】')
      expect(s).toContain('【经验教训】')
      expect(s).toContain('短镜头')
      expect(s).toContain('单械')
    })

    it('长内容被 MEMORY_CONTENT_KEEP 截断并带“后略”标记', async () => {
      const long = 'X'.repeat(500)
      await store.create({ kind: 'rule', title: '长规则', content: long })
      const s = await store.summary()
      expect(s).toContain('…（后略')
      // 原始长内容（500 字符）不会完整出现（只保留前 240）
      expect(s.length).toBeLessThan(long.length + 200)
    })
  })

  describe('持久化与跨实例', () => {
    it('重启实例后 list 到之前的数据', async () => {
      await store.create({ kind: 'preference', title: '持久', content: '跨实例' })
      const store2 = new MemoryStore(dir)
      const list = await store2.list()
      expect(list).toHaveLength(1)
      expect(list[0]?.title).toBe('持久')
    })
  })

  describe('并发写入安全（writeChain 串行化）', () => {
    it('多次 create 并发执行后全部落盘', async () => {
      const promises = KINDS.map((k, i) => store.create({ kind: k, title: `t${i}`, content: `c${i}` }))
      const items = await Promise.all(promises)
      expect(items).toHaveLength(3)
      expect(await store.list()).toHaveLength(3)
    })

    it('create + update + remove 交错并发不丢数据', async () => {
      const a = await store.create({ kind: 'preference', title: 'A', content: 'a' })
      const b = await store.create({ kind: 'rule', title: 'B', content: 'b' })
      await Promise.all([
        store.update(a.id, { content: 'a2' }),
        store.remove(b.id),
        store.create({ kind: 'lesson', title: 'C', content: 'c' }),
      ])
      const list = await store.list()
      expect(list).toHaveLength(2)
      const titles = list.map((i) => i.title).sort()
      expect(titles).toEqual(['A', 'C'])
    })
  })
})
