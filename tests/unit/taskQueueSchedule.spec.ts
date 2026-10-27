/**
 * TaskQueue 调度控制路径单测（不起 ComfyUI）：
 * - start() 无待渲镜头 → 立即发 queue-finished（waitForFinish 不挂死）；
 * - cancel(projectId) 空转安全（无队列/无在渲）；
 * - cancelAll() 对所有排队项目逐个取消，空队列不抛错。
 * renderShot 深度依赖（comfy 出图/tts/ffmpeg）不在本文件覆盖，见 taskQueueRender.spec。
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { TaskQueue } from '../../src/main/core/taskQueue'
import type { Project } from '../../src/shared/ipcTypes'

async function makeQueue(): Promise<TaskQueue> {
  const project = {
    id: 'p1', title: 't', genre: '都市', status: 'draft',
    characters: [], scenes: [], shots: []
  } as unknown as Project
  const store = {
    get: async (id: string) => (id === 'p1' ? project : undefined),
    update: async (_id: string, cb: (p: Project) => void) => { cb(project) },
    save: async () => undefined
  }
  const comfy = {
    interrupt: async () => undefined,
    rejectPending: () => undefined,
    clearQueue: async () => undefined
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-queue-'))
  return new TaskQueue(
    dir,
    comfy as never,
    {} as never,
    {} as never,
    { ready: async () => undefined } as never,
    store as never,
    { get: async () => ({}) } as never
  )
}

describe('TaskQueue 调度控制路径', () => {
  it('start() 无待渲镜头：解析并发 queue-finished（不挂起）', async () => {
    const queue = await makeQueue()
    const finished = new Promise<void>(resolve => {
      queue.once('queue-finished', (e: { projectId: string }) => {
        expect(e.projectId).toBe('p1')
        resolve()
      })
    })
    await queue.start('p1')
    await finished
  })

  it('cancel(projectId)：无在渲任务时安全解析，不抛错', async () => {
    const queue = await makeQueue()
    await expect(queue.cancel('p1')).resolves.toBeUndefined()
  })

  it('cancelAll()：空队列时安全解析，不抛错', async () => {
    const queue = await makeQueue()
    await expect(queue.cancelAll()).resolves.toBeUndefined()
  })

  it('start() 后立即 cancel：取消路径快速返回，不遗留 rejected 等待', async () => {
    const queue = await makeQueue()
    await queue.start('p1')
    await queue.cancel('p1')
  })
})
