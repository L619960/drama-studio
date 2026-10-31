/**
 * SEC-01 回归：项目 id 白名单校验。
 * id 会直接参与目录拼接，渲染层传入的任意字符串必须先过白名单，
 * 杜绝 `../`、绝对路径、盘符、URL 编码等路径穿越。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProjectStore, assertProjectId } from '../../src/main/core/projectStore'

vi.mock('../../src/main/core/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

let dir: string
let store: ProjectStore

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-sec01-'))
})

beforeEach(() => {
  store = new ProjectStore(path.join(dir, 'projects'))
})

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

describe('assertProjectId（SEC-01）', () => {
  it('create() 生成的 id 通过校验', async () => {
    const p = await store.create('t', '都市')
    expect(() => assertProjectId(p.id)).not.toThrow()
  })

  it.each([
    '../../etc/passwd',
    '../project.json',
    'p_../../x',
    'C:\\Windows\\system32',
    '/etc/passwd',
    '%2e%2e%2f',
    'p_',
    '',
    'p_a/b',
    'project',
  ])('拒绝非法 id：%s', (bad) => {
    expect(() => assertProjectId(bad)).toThrow(/非法/)
  })

  it('拒绝非字符串输入', () => {
    expect(() => assertProjectId(undefined)).toThrow(/非法/)
    expect(() => assertProjectId(123)).toThrow(/非法/)
  })
})

describe('ProjectStore 各入口统一校验（SEC-01）', () => {
  it('get：路径穿越 id 不会读到数据根之外的文件', async () => {
    // 在数据根之外放一个项目文件，确认穿越读不到
    await fs.mkdir(path.join(dir, 'outside'), { recursive: true })
    await fs.writeFile(path.join(dir, 'outside', 'project.json'), '{"id":"evil"}', 'utf-8')
    await expect(store.get('../outside')).rejects.toThrow(/非法项目标识/)
  })

  it('save：伪造 id 被拒绝', async () => {
    const project = {
      id: '../../evil',
      title: 't',
      genre: '都市',
      status: 'draft',
      characters: [],
      shots: [],
      createdAt: 0,
      updatedAt: 0,
    }
    await expect(store.save(project as never)).rejects.toThrow(/非法项目标识/)
  })

  it('save：缺少 shots/characters 的项目数据被拒绝', async () => {
    const p = await store.create('t', '都市')
    await expect(store.save({ id: p.id } as never)).rejects.toThrow(/缺少分镜或角色列表/)
  })

  it('delete：路径穿越 id 不会删除数据根之外的目录', async () => {
    await fs.mkdir(path.join(dir, 'outside'), { recursive: true })
    await fs.writeFile(path.join(dir, 'outside', 'keep.txt'), 'x', 'utf-8')
    await expect(store.delete('../outside')).rejects.toThrow(/非法项目标识/)
    await expect(fs.stat(path.join(dir, 'outside', 'keep.txt'))).resolves.toBeTruthy()
  })

  it('importBgm / getShotDir：非法 id 被拒绝', async () => {
    await expect(store.importBgm('../outside')).rejects.toThrow(/非法项目标识/)
    await expect(store.getShotDir('../outside', 'shot_1')).rejects.toThrow(/非法项目标识/)
  })

  it('正常项目仍可读写（回归）', async () => {
    const p = await store.create('正常项目', '都市')
    expect((await store.get(p.id)).title).toBe('正常项目')
    const shotDir = await store.getShotDir(p.id, 'shot_1')
    expect(await fs.stat(shotDir)).toBeTruthy()
  })
})
