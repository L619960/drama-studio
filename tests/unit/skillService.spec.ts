import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SkillService, BUILTIN_SKILLS } from '../../src/main/core/skillService'

/**
 * 技能库落盘与内置技能合并（skillService 首个单测）：
 * 覆盖首次种子、启用状态继承、自定义技能保留、并发写串行、内置不可删、
 * 损坏文件保护（改名备份且不回写覆盖）。
 */
describe('SkillService 技能库', () => {
  let dir: string
  let svc: SkillService

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-skill-'))
    svc = new SkillService(dir)
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  const file = () => path.join(dir, 'skills.json')

  it('首次运行：返回全部内置技能并落盘 skills.json', async () => {
    const list = await svc.list()
    expect(list).toHaveLength(BUILTIN_SKILLS.length)
    expect(list.every((s) => s.builtin)).toBe(true)
    const saved = JSON.parse(await fs.readFile(file(), 'utf8'))
    expect(Array.isArray(saved)).toBe(true)
    expect(saved).toHaveLength(BUILTIN_SKILLS.length)
  })

  it('升级内置技能：描述以代码为准，启用状态沿用用户配置', async () => {
    const builtin0 = BUILTIN_SKILLS[0]
    if (!builtin0) throw new Error('测试夹具缺少 BUILTIN_SKILLS[0]')
    await fs.writeFile(file(), JSON.stringify([{ ...builtin0, description: '旧描述', enabled: false }]))
    const list = await new SkillService(dir).list()
    const first = list.find((s) => s.id === builtin0.id)!
    expect(first.description).toBe(builtin0.description)
    expect(first.enabled).toBe(false)
    // 用户文件里缺失的内置技能会被补齐
    expect(list).toHaveLength(BUILTIN_SKILLS.length)
  })

  it('自定义技能追加在内置之后，重载后仍保留', async () => {
    const created = await svc.create({ name: ' 节奏检查 ', description: ' 检查节奏 ', promptTemplate: 'X' })
    expect(created.name).toBe('节奏检查')
    expect(created.builtin).toBe(false)
    expect(created.kind).toBe('prompt')

    const reloaded = await new SkillService(dir).list()
    expect(reloaded).toHaveLength(BUILTIN_SKILLS.length + 1)
    expect(reloaded[reloaded.length - 1]?.id).toBe(created.id)
  })

  it('update / toggle 持久化，remove 只允许自定义技能', async () => {
    const created = await svc.create({ name: 'a', description: 'b', promptTemplate: 'c' })
    await svc.update(created.id, { name: 'a2', promptTemplate: 'c2' })
    await svc.toggle(created.id, false)
    const reloaded = await new SkillService(dir).list()
    const found = reloaded.find((s) => s.id === created.id)!
    expect(found.name).toBe('a2')
    expect(found.promptTemplate).toBe('c2')
    expect(found.enabled).toBe(false)

    await svc.remove(created.id)
    expect((await new SkillService(dir).list()).some((s) => s.id === created.id)).toBe(false)
    const builtinId = BUILTIN_SKILLS[0]?.id
    if (!builtinId) throw new Error('测试夹具缺少 BUILTIN_SKILLS[0]')
    await expect(svc.remove(builtinId)).rejects.toThrow('内置技能不可删除')
    await expect(svc.update('sk_missing', { name: 'x' })).rejects.toThrow('技能不存在')
  })

  it('并发 create 不丢技能（写串行链）', async () => {
    await Promise.all([
      svc.create({ name: 's1', description: '', promptTemplate: '1' }),
      svc.create({ name: 's2', description: '', promptTemplate: '2' }),
      svc.create({ name: 's3', description: '', promptTemplate: '3' }),
    ])
    const list = await new SkillService(dir).list()
    const custom = list.filter((s) => !s.builtin)
    expect(custom.map((s) => s.name).sort()).toEqual(['s1', 's2', 's3'])
  })

  it('list 返回浅拷贝，外部修改不污染缓存', async () => {
    const a = await svc.list()
    a.pop()
    expect(await svc.list()).toHaveLength(BUILTIN_SKILLS.length)
  })

  it('skills.json 损坏：改名备份、以内置技能兜底、不回写覆盖', async () => {
    const broken = '{"oops": '
    await fs.writeFile(file(), broken)
    const list = await svc.list()
    expect(list).toHaveLength(BUILTIN_SKILLS.length)

    const entries = await fs.readdir(dir)
    const bak = entries.find((n) => n.startsWith('skills.json.bak_'))
    expect(bak).toBeTruthy()
    expect(await fs.readFile(path.join(dir, bak!), 'utf8')).toBe(broken)
    // 原始文件已被改名，且本轮不回写新的 skills.json
    await expect(fs.access(file())).rejects.toBeTruthy()
  })

  it('skills.json 结构不是数组：按损坏处理', async () => {
    await fs.writeFile(file(), JSON.stringify({ skills: [] }))
    const list = await svc.list()
    expect(list).toHaveLength(BUILTIN_SKILLS.length)
    const entries = await fs.readdir(dir)
    expect(entries.some((n) => n.startsWith('skills.json.bak_'))).toBe(true)
  })
})
