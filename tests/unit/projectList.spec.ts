import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  filterProjects,
  sortProjects,
  projectCoverPath,
  directorProjectStatus,
  markProjectOpened,
  readProjectOpens
} from '../../src/renderer/src/utils/projectList'
import type { DirectorState, Project } from '../../src/shared/ipcTypes'

function makeProject(id: string, over: Partial<Project> = {}): Project {
  return {
    id,
    title: `项目${id}`,
    genre: '都市',
    episode: 1,
    status: 'draft',
    characters: [],
    shots: [],
    fps: 30,
    createdAt: 1000,
    updatedAt: 1000,
    ...over
  }
}

function makeDirectorState(over: Partial<DirectorState> = {}): DirectorState {
  return {
    projectId: 'p1',
    title: 'T',
    running: false,
    cancelled: false,
    paused: false,
    gateStages: [],
    stages: {} as DirectorState['stages'],
    totalShots: 0,
    doneShots: 0,
    failedShotIds: [],
    startedAt: 0,
    logs: [],
    ...over
  }
}

function stubStorage(): Map<string, string> {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size }
  })
  return store
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('REQ-08 项目检索', () => {
  it('按片名模糊匹配，大小写不敏感；空关键词返回全量副本', () => {
    const list = [
      makeProject('a', { title: '总裁的隐婚新娘' }),
      makeProject('b', { title: 'Reborn CEO' })
    ]
    expect(filterProjects(list, '隐婚').map(p => p.id)).toEqual(['a'])
    expect(filterProjects(list, 'ceo').map(p => p.id)).toEqual(['b'])
    const all = filterProjects(list, '   ')
    expect(all).toHaveLength(2)
    expect(all).not.toBe(list)
  })

  it('剧本关键词也能命中', () => {
    const list = [makeProject('a', { script: '雨夜天台，两人对峙' })]
    expect(filterProjects(list, '天台').map(p => p.id)).toEqual(['a'])
  })
})

describe('REQ-08 项目排序', () => {
  it('最近打开：有打开记录优先，其次按更新时间', () => {
    const list = [
      makeProject('a', { updatedAt: 3000 }),
      makeProject('b', { updatedAt: 2000 }),
      makeProject('c', { updatedAt: 1000 })
    ]
    expect(sortProjects(list, 'recent', { b: 9000 }).map(p => p.id)).toEqual(['b', 'a', 'c'])
    expect(sortProjects(list, 'recent', {}).map(p => p.id)).toEqual(['a', 'b', 'c'])
  })

  it('创建时间倒序', () => {
    const list = [
      makeProject('a', { createdAt: 1000 }),
      makeProject('b', { createdAt: 3000 }),
      makeProject('c', { createdAt: 2000 })
    ]
    expect(sortProjects(list, 'created').map(p => p.id)).toEqual(['b', 'c', 'a'])
  })

  it('完成状态：渲染中 → 失败 → 草稿 → 完成', () => {
    const list = [
      makeProject('done', { status: 'done' }),
      makeProject('draft', { status: 'draft' }),
      makeProject('failed', { status: 'failed' }),
      makeProject('rendering', { status: 'rendering' })
    ]
    expect(sortProjects(list, 'status').map(p => p.id)).toEqual([
      'rendering', 'failed', 'draft', 'done'
    ])
  })
})

describe('REQ-08 打开记录与封面', () => {
  it('打开项目写入时间戳并可读回', () => {
    stubStorage()
    markProjectOpened('p1', 12345)
    expect(readProjectOpens()).toEqual({ p1: 12345 })
    markProjectOpened('p2', 67890)
    expect(readProjectOpens()).toMatchObject({ p1: 12345, p2: 67890 })
  })

  it('存储损坏/无 localStorage 时退回空表且不抛错', () => {
    const store = stubStorage()
    store.set('drama-studio:projectOpens', '{bad json')
    expect(readProjectOpens()).toEqual({})
    vi.stubGlobal('localStorage', undefined)
    expect(() => markProjectOpened('p1')).not.toThrow()
    expect(readProjectOpens()).toEqual({})
  })

  it('封面取首镜首帧，缺失回退缩略图', () => {
    const withFrame = makeProject('a', {
      shots: [{ id: 's1', firstFramePath: 'projects/a/shots/s1_first.png' } as unknown as Project['shots'][number]]
    })
    expect(projectCoverPath(withFrame)).toBe('projects/a/shots/s1_first.png')
    expect(projectCoverPath(makeProject('b'))).toBe('projects/b/thumbnail.jpg')
  })
})

describe('REQ-08 进度事件 → 卡片状态', () => {
  it('运行/暂停都显示渲染中，成片完成显示完成', () => {
    expect(directorProjectStatus(makeDirectorState({ running: true }))).toBe('rendering')
    expect(directorProjectStatus(makeDirectorState({ paused: true }))).toBe('rendering')
    expect(
      directorProjectStatus(makeDirectorState({ finalPath: 'projects/p1/final.mp4' }))
    ).toBe('done')
  })

  it('未完成且有失败镜显示失败；无判定信息保留原状态', () => {
    expect(
      directorProjectStatus(makeDirectorState({ totalShots: 3, failedShotIds: ['s1'] }))
    ).toBe('failed')
    expect(directorProjectStatus(makeDirectorState({ totalShots: 3 }))).toBeNull()
  })
})
