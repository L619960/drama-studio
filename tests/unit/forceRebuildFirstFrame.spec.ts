/**
 * renderStart 接线行为单测（LOGIC-P0-02 forceRebuildFirstFrame + LOGIC-P0-01 shotReviewGate）：
 * - forceRebuildFirstFrame=false 时不调 rebuildShotFirstFrame（审什么渲什么）；
 * - forceRebuildFirstFrame=true 时才对目标 i2v 镜重建首帧；
 * - shotReviewGate='block' 时未审 i2v 镜硬拦；'off' 放行。
 *
 * 用 ipcMain.handle 捕获注册的 listener，直接以 mock ctx 调用，不起 Electron。
 */
import { describe, it, expect, vi } from 'vitest'

const { handlers, userData } = vi.hoisted(() => {
  // vi.hoisted 先于 ESM import 执行，只能用 require；此处为 vitest 官方既定写法
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os')
  return {
    handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
    userData: path.join(os.tmpdir(), 'drama-renderstart-test')
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    }
  }
}))

import { IpcChannels } from '../../src/shared/ipcTypes'
import { registerRenderIpc } from '../../src/main/ipc/render'

function makeCtx(over: { gate?: 'off' | 'warn' | 'block'; shots: unknown[] }) {
  const rebuild = vi.fn(async () => undefined)
  const queueStart = vi.fn(async () => undefined)
  const project = { id: 'p1', shots: over.shots }
  const projectStore = { get: vi.fn(async () => project) }
  const settingsStore = { get: vi.fn(async () => ({ render: { shotReviewGate: over.gate ?? 'off' } })) }
  registerRenderIpc({
    projectStore, settingsStore,
    directorAgent: { rebuildShotFirstFrames: rebuild },
    taskQueue: { start: queueStart, cancel: vi.fn() },
    llmService: {}
  } as never)
  return { rebuild, queueStart }
}

const reviewedShot = { id: 'a', index: 1, type: 'i2v', status: 'pending', reviewed: true, firstFramePath: 'first/a.png' }
const unreviewedShot = { id: 'u', index: 2, type: 'i2v', status: 'pending', reviewed: false, firstFramePath: undefined }

describe('renderStart / forceRebuildFirstFrame', () => {
  it('forceRebuild=false：不重建首帧，直接入队渲染', async () => {
    const { rebuild, queueStart } = makeCtx({ shots: [reviewedShot] })
    const listener = handlers.get(IpcChannels.renderStart)!
    const res = await listener({}, { projectId: 'p1', shotIds: ['a'], forceRebuildFirstFrame: false })
    expect(rebuild).not.toHaveBeenCalled()
    expect(queueStart).toHaveBeenCalledWith('p1', ['a'])
    expect(res).toEqual({ warnedShots: [] })
  })

  it('forceRebuild=true：仅对目标 i2v 镜调 rebuildShotFirstFrames（传镜号）', async () => {
    const { rebuild, queueStart } = makeCtx({ shots: [reviewedShot] })
    const listener = handlers.get(IpcChannels.renderStart)!
    await listener({}, { projectId: 'p1', shotIds: ['a'], forceRebuildFirstFrame: true })
    expect(rebuild).toHaveBeenCalledTimes(1)
    expect(rebuild).toHaveBeenCalledWith('p1', [1])
    expect(queueStart).toHaveBeenCalledWith('p1', ['a'])
  })

  it('shotReviewGate=block + 未审 i2v 镜：硬拦，不入队', async () => {
    const { rebuild, queueStart } = makeCtx({ gate: 'block', shots: [unreviewedShot] })
    const listener = handlers.get(IpcChannels.renderStart)!
    await expect(
      listener({}, { projectId: 'p1', shotIds: ['u'], forceRebuildFirstFrame: false })
    ).rejects.toThrow(/分镜审核未通过/)
    expect(rebuild).not.toHaveBeenCalled()
    expect(queueStart).not.toHaveBeenCalled()
  })
})
