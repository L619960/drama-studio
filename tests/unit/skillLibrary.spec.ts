import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SkillLibrary } from '../../src/main/core/skillLibrary'

/**
 * 导演技能库加载单测（skillLibrary 首个 spec）：
 * 正常加载/缓存/强制重读、结构校验降级、质量条款拼接、路径与错误提示。
 */
const RULES = {
  name: 'director',
  version: 3,
  cinematicQuality: {
    quality: ['cinematic'],
    camera: ['shallow depth of field'],
    lighting: ['natural light'],
    fx: ['subtle film grain'],
    scene: ['realistic set dressing']
  },
  auditChecklist: [
    { id: 'a1', label: '单人', check: '画面只有主体一人', severity: 'block' as const }
  ],
  methodRules: ['先立人物动机，再写冲突']
}

describe('SkillLibrary', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-skills-'))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  const writeRules = async (content: unknown) => {
    await fs.mkdir(path.join(dir, 'director'), { recursive: true })
    await fs.writeFile(
      path.join(dir, 'director', 'rules.json'),
      typeof content === 'string' ? content : JSON.stringify(content),
      'utf8'
    )
  }

  it('加载合法 rules.json 并按需返回审核项与方法论', async () => {
    await writeRules(RULES)
    const lib = new SkillLibrary(dir)

    const rules = await lib.load()
    expect(rules?.version).toBe(3)
    await expect(lib.auditChecklist()).resolves.toEqual(RULES.auditChecklist)
    await expect(lib.methodRules()).resolves.toEqual(RULES.methodRules)
  })

  it('qualityBlock 按 quality→camera→lighting→fx→scene 顺序逗号拼接', async () => {
    await writeRules(RULES)
    const lib = new SkillLibrary(dir)
    await expect(lib.qualityBlock()).resolves.toBe(
      'cinematic, shallow depth of field, natural light, subtle film grain, realistic set dressing'
    )
  })

  it('默认缓存：文件改动后不 force 不重读，force 时重读磁盘', async () => {
    await writeRules(RULES)
    const lib = new SkillLibrary(dir)
    await lib.load()

    await writeRules({ ...RULES, version: 9 })
    expect((await lib.load())?.version).toBe(3)
    expect((await lib.load(true))?.version).toBe(9)
  })

  it('文件缺失时静默降级：返回 null、空清单与空质量块', async () => {
    const lib = new SkillLibrary(dir)
    await expect(lib.load()).resolves.toBeNull()
    await expect(lib.qualityBlock()).resolves.toBe('')
    await expect(lib.auditChecklist()).resolves.toEqual([])
    await expect(lib.methodRules()).resolves.toEqual([])
    expect(lib.loadErrorHint()).toBeTruthy()
  })

  it('JSON 损坏或结构不完整均降级为空', async () => {
    await writeRules('{oops')
    const broken = new SkillLibrary(dir)
    await expect(broken.load()).resolves.toBeNull()
    expect(broken.loadErrorHint()).toBeTruthy()

    await writeRules({ ...RULES, cinematicQuality: undefined })
    const invalid = new SkillLibrary(dir)
    await expect(invalid.load()).resolves.toBeNull()
    expect(invalid.loadErrorHint()).toContain('结构不完整')
  })

  it('dir() 指向 skills/director 目录', () => {
    expect(new SkillLibrary(dir).dir()).toBe(path.join(dir, 'director'))
  })
})
