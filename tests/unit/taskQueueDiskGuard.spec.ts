/**
 * CORE-01 回归：渲染前磁盘预检抛错必须落 failed，不能把镜头永久停在 rendering。
 * 通过 mock node:fs/promises 的 statfs 制造低磁盘，驱动真实 start → process → renderShot 链路。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { statfs } from 'node:fs/promises'
import type { Project, Shot } from '../../src/shared/ipcTypes'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, statfs: vi.fn() }
})

import { TaskQueue } from '../../src/main/core/taskQueue'

const PID = 'p_1761800000000_ab12'

function makeShot(over: Partial<Shot> = {}): Shot {
  return {
    id: 'shot_1',
    index: 1,
    type: 'i2v',
    status: 'pending',
    scene: '夜巷',
    action: '回头',
    dialogue: '',
    characterIds: [],
    width: 576,
    height: 1024,
    frames: 81,
    seed: 1,
    ...over,
  } as Shot
}

function makeProject(): Project {
  return {
    id: PID,
    title: 't',
    genre: '都市',
    status: 'draft',
    characters: [],
    sceneBoards: [],
    shots: [makeShot()],
    createdAt: 0,
    updatedAt: 0,
    fps: 24,
  } as unknown as Project
}

/** 内存 ProjectStore stub：只实现 start/renderShot 用到的 get/update/save/list */
function makeStore(project: Project) {
  return {
    get: async () => JSON.parse(JSON.stringify(project)) as Project,
    update: async (_id: string, fn: (draft: Project) => void | Promise<void>) => {
      await fn(project)
      return project
    },
    save: async (p: Project) => {
      Object.assign(project, p)
    },
    list: async () => [project],
  }
}

beforeEach(() => {
  vi.mocked(statfs).mockReset()
})

describe('磁盘预检失败 → 镜头置 failed（CORE-01）', () => {
  it('可用空间 <0.5GB 时抛错，镜头状态为 failed 且带原因', async () => {
    const project = makeProject()
    const store = makeStore(project)
    vi.mocked(statfs).mockResolvedValue({
      bavail: 10,
      bsize: 4096,
      blocks: 100,
    } as never)

    const queue = new TaskQueue(
      'C:/tmp/drama-base',
      {} as never,
      {} as never,
      {} as never,
      { ready: async () => undefined } as never,
      store as never,
      { get: async () => ({}) } as never,
    )
    await queue.start(PID)
    await queue.waitForFinish(PID, 10_000)

    const shot = project.shots[0]
    if (!shot) throw new Error('测试夹具缺少 shots[0]')
    expect(shot.status).toBe('failed')
    expect(shot.error || '').toMatch(/磁盘余量不足/)
  })

  it('预检本身不可用（statfs 抛非磁盘错误）不阻断渲染流程', async () => {
    const project = makeProject()
    const store = makeStore(project)
    vi.mocked(statfs).mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
    const queue = new TaskQueue(
      'C:/tmp/drama-base',
      {} as never,
      {} as never,
      {} as never,
      { ready: async () => undefined } as never,
      store as never,
      { get: async () => ({}) } as never,
    )
    // 预检放行后会在 settings/渲染阶段抛错，但不应抛出「磁盘余量不足」
    await queue.start(PID)
    await queue.waitForFinish(PID, 10_000)
    expect(project.shots[0]?.error || '').not.toMatch(/磁盘余量不足/)
  })
})
