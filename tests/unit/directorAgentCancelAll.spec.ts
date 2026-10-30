/**
 * P0-3：退出前的 cancelAll —— 并行项目可能同时在跑，不能只收尾「最近一个」。
 * DirectorAgent 构造依赖较重，这里用 `prototype.cancelAll.call(fakeThis)` 直测收尾范围。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), on: vi.fn(), whenReady: vi.fn() },
  shell: { showItemInFolder: vi.fn() }
}))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
  getDefaultEnvironment: vi.fn()
}))

import { DirectorAgent } from '../../src/main/core/directorAgent'
import { STAGE_ORDER } from '../../src/main/core/directorConstants'
import type { DirectorState, DirectorStage, StageState } from '../../src/shared/ipcTypes'

function mkState(projectId: string, patch: Partial<DirectorState> = {}): DirectorState {
  const stages = {} as Record<DirectorStage, StageState>
  for (const s of STAGE_ORDER) stages[s] = { status: 'pending', message: '', percent: 0 }
  return {
    projectId,
    title: projectId,
    running: false,
    cancelled: false,
    paused: false,
    gateStages: [],
    stages,
    totalShots: 0,
    doneShots: 0,
    failedShotIds: [],
    startedAt: Date.now(),
    logs: [],
    ...patch
  }
}

function mkHost(states: DirectorState[]) {
  return {
    states: new Map(states.map(s => [s.projectId, s])),
    cancel: vi.fn(async () => undefined)
  } as unknown as DirectorAgent
}

describe('DirectorAgent.cancelAll（P0-3 退出收尾）', () => {
  it('取消所有 running / paused 任务，跳过已结束任务', async () => {
    const host = mkHost([
      mkState('run-a', { running: true }),
      mkState('paused-b', { paused: true }),
      mkState('done-c'),
      mkState('idle-d')
    ])
    await DirectorAgent.prototype.cancelAll.call(host)
    const ids = (host.cancel as unknown as { mock: { calls: string[][] } }).mock.calls.map(c => c[0])
    expect(ids.sort()).toEqual(['paused-b', 'run-a'])
  })

  it('单个项目取消失败不阻断其他项目收尾（退出流程不能被卡死）', async () => {
    const host = mkHost([
      mkState('bad', { running: true }),
      mkState('good', { running: true })
    ])
    host.cancel = vi.fn(async (id: string) => {
      if (id === 'bad') throw new Error('渲染中断失败')
    })
    await expect(DirectorAgent.prototype.cancelAll.call(host)).resolves.toBeUndefined()
    expect(host.cancel).toHaveBeenCalledTimes(2)
  })

  it('没有运行中的任务 → 不调用 cancel', async () => {
    const host = mkHost([mkState('done-x')])
    await DirectorAgent.prototype.cancelAll.call(host)
    expect(host.cancel).not.toHaveBeenCalled()
  })
})
