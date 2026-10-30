/**
 * directorStateMachine 纯状态操作单测（线 A2 拆分后补齐）。
 *
 * stateMachine 把 DirectorAgent 上的 13 个 Map/Set 抽成接收 agent 上下文的纯函数，
 * 这里用一个手工 mock agent（不 new DirectorAgent、不起 Electron/ComfyUI）直测：
 *   freshState / getState / setStage / cancel 同步 / pause-resume 门控 / hydrate 崩溃恢复 / clearState。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'

// 单元测试只测状态机逻辑，不落盘：mock 掉原子写，避免 emitStateImpl 里 fire-and-forget
// 的 persistImpl 在测试清理 tmp 目录时抛未处理 rejection。hydrate 的读盘仍用真实 fs。
vi.mock('../../src/main/core/fsUtil', () => ({
  atomicWriteJson: vi.fn().mockResolvedValue(undefined)
}))

import type { DirectorAgent } from '../../src/main/core/directorAgent'
import type { DirectorState, DirectorStage, StageState } from '../../src/shared/ipcTypes'
import { STAGE_ORDER, LOG_LIMIT } from '../../src/main/core/directorConstants'
import {
  freshStateImpl,
  getStateImpl,
  getLatestStateImpl,
  listActiveStatesImpl,
  setStageImpl,
  isCancelledImpl,
  currentStageImpl,
  maybeGateImpl,
  pauseUntilShotsReviewedImpl,
  hydrateImpl,
  recoverAllImpl,
  clearStateImpl,
  emitStateImpl
} from '../../src/main/core/directorStateMachine'

function makeState(projectId: string): DirectorState {
  const stages = {} as Record<DirectorStage, StageState>
  for (const s of STAGE_ORDER) stages[s] = { status: 'pending', message: '', percent: 0 }
  return {
    projectId,
    title: '测试片',
    running: true,
    cancelled: false,
    paused: false,
    gateStages: [],
    stages,
    totalShots: 0,
    doneShots: 0,
    failedShotIds: [],
    startedAt: Date.now(),
    logs: []
  }
}

function makeAgent(baseDir: string) {
  return {
    states: new Map<string, DirectorState>(),
    cancelled: new Set<string>(),
    gates: new Map<string, Set<DirectorStage>>(),
    pauseRequested: new Set<string>(),
    waiters: new Map<string, () => void>(),
    logSeq: new Map<string, number>(),
    healBudget: new Map<string, number>(),
    shadowSettledShots: new Map<string, unknown>(),
    visionWarned: new Set<string>(),
    shadowRenders: new Map<string, unknown>(),
    lastStageMsg: new Map<string, string>(),
    lastStepByShot: new Map<string, string>(),
    baseDir,
    emit: vi.fn(),
    unsubscribeRenderProgress: vi.fn(),
    // 仅 pauseUntilShotsReviewed / recoverAll 用到，本测试不触达，留空
    settings: { get: vi.fn() },
    store: { get: vi.fn() }
  } as unknown as DirectorAgent & {
    waiters: Map<string, () => void>
  }
}

let tmpDir = ''

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ds-state-'))
})

afterEach(async () => {
  // Windows 上状态文件句柄可能尚未释放，rm 偶发 EBUSY → 重试退避，避免 CI flaky
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('freshStateImpl / getStateImpl', () => {
  it('freshState：running=true、全部 9 阶段 pending、结构完整', () => {
    const agent = makeAgent(tmpDir)
    const s = freshStateImpl(agent, 'p1', '片名')
    expect(s.running).toBe(true)
    expect(s.cancelled).toBe(false)
    expect(s.paused).toBe(false)
    expect(s.projectId).toBe('p1')
    for (const stage of STAGE_ORDER) {
      expect(s.stages[stage].status).toBe('pending')
      expect(s.stages[stage].percent).toBe(0)
    }
    // getState：入内存后可取回
    agent.states.set('p1', s)
    expect(getStateImpl(agent, 'p1')).toBe(s)
    expect(getStateImpl(agent, 'nope')).toBeNull()
  })
})

describe('setStageImpl', () => {
  it('更新阶段状态/消息/百分比，并 emit progress', () => {
    const agent = makeAgent(tmpDir)
    agent.states.set('p1', makeState('p1'))
    setStageImpl(agent, 'p1', 'render', 'running', '渲染中', 40)
    const st = agent.states.get('p1')!
    expect(st.stages.render.status).toBe('running')
    expect(st.stages.render.message).toBe('渲染中')
    expect(st.stages.render.percent).toBe(40)
    expect(agent.emit).toHaveBeenCalledWith('progress', expect.objectContaining({ projectId: 'p1' }))
  })

  it('同阶段重复 running 消息被抑制，不重复写日志', () => {
    const agent = makeAgent(tmpDir)
    agent.states.set('p1', makeState('p1'))
    setStageImpl(agent, 'p1', 'render', 'running', '同一条进度', 10)
    setStageImpl(agent, 'p1', 'render', 'running', '同一条进度', 20)
    const logs = agent.states.get('p1')!.logs
    expect(logs.filter(l => l.message.includes('同一条进度'))).toHaveLength(1)
  })
})

describe('cancel（isCancelled / emitStateImpl 同步 cancelled 标志）', () => {
  it('cancelled 集合命中 → isCancelled=true，emitStateImpl 把 state.cancelled 置真', () => {
    const agent = makeAgent(tmpDir)
    agent.states.set('p1', makeState('p1'))
    expect(isCancelledImpl(agent, 'p1')).toBe(false)
    agent.cancelled.add('p1')
    expect(isCancelledImpl(agent, 'p1')).toBe(true)
    const st = agent.states.get('p1')!
    expect(st.cancelled).toBe(false)
    emitStateImpl(agent, 'p1')
    expect(st.cancelled).toBe(true)
  })
})

describe('currentStageImpl', () => {
  it('返回当前 running 的阶段；无 running 阶段时返回 done', () => {
    const s = makeState('p1')
    expect(currentStageImpl(s)).toBe('done')
    s.stages.scenes.status = 'running'
    expect(currentStageImpl(s)).toBe('scenes')
  })
})

describe('maybeGateImpl：pause → resume 放行', () => {
  it('pauseRequested 命中 → 置 paused 并等待；调用 waiter 后恢复执行', async () => {
    const agent = makeAgent(tmpDir)
    agent.states.set('p1', makeState('p1'))
    agent.pauseRequested.add('p1')

    const done = maybeGateImpl(agent, 'p1', 'scenes')
    // 此时应已挂起：paused=true，waiters 里登记了 resolve
    await vi.waitFor(() => {
      expect(agent.states.get('p1')!.paused).toBe(true)
    })
    expect(agent.waiters.has('p1')).toBe(true)
    expect(agent.pauseRequested.has('p1')).toBe(false)

    // 模拟 resume：调用登记的 resolve
    const resolve = agent.waiters.get('p1')!
    resolve()
    await done

    // 恢复后应补一条「已继续执行」日志
    const logs = agent.states.get('p1')!.logs.map(l => l.message)
    expect(logs.some(m => m.includes('已继续执行'))).toBe(true)
  })

  it('已取消时直接放行，不挂起', async () => {
    const agent = makeAgent(tmpDir)
    agent.states.set('p1', makeState('p1'))
    agent.cancelled.add('p1')
    agent.pauseRequested.add('p1')
    await maybeGateImpl(agent, 'p1', 'scenes')
    expect(agent.states.get('p1')!.paused).toBe(false)
  })
})

describe('hydrateImpl：崩溃恢复', () => {
  it('磁盘无 director-state.json → 返回 null', async () => {
    const agent = makeAgent(tmpDir)
    expect(await hydrateImpl(agent, 'ghost')).toBeNull()
  })

  it('磁盘残留 running=true → 降级为已中断，running 阶段转 error 并补中断日志', async () => {
    const agent = makeAgent(tmpDir)
    const projDir = path.join(tmpDir, 'projects', 'p1')
    await fs.mkdir(projDir, { recursive: true })
    const disk = makeState('p1')
    disk.stages.render.status = 'running'
    disk.stages.render.percent = 33
    await fs.writeFile(path.join(projDir, 'director-state.json'), JSON.stringify(disk))

    const restored = await hydrateImpl(agent, 'p1')
    expect(restored).not.toBeNull()
    expect(restored!.running).toBe(false)
    expect(restored!.paused).toBe(false)
    // render 阶段 running → error，保留 percent
    expect(restored!.stages.render.status).toBe('error')
    expect(restored!.stages.render.percent).toBe(33)
    expect(restored!.stages.render.message).toContain('应用重启')
    // 补了一条中断说明日志
    expect(restored!.logs.some(l => l.message.includes('应用重启'))).toBe(true)
    // 已入内存
    expect(agent.states.get('p1')).toBe(restored)
  })

  it('内存已有状态 → 直接返回 existing，不读盘覆盖', async () => {
    const agent = makeAgent(tmpDir)
    const existing = makeState('p1')
    existing.title = '内存版'
    agent.states.set('p1', existing)
    const got = await hydrateImpl(agent, 'p1')
    expect(got).toBe(existing)
    expect(got!.title).toBe('内存版')
  })

  // ===== P0-1：任务中断标记 + 一键继续入口定位 =====
  it('P0-1：残留 running → 置 interrupted=true 并记录 interruptedStage', async () => {
    const agent = makeAgent(tmpDir)
    const projDir = path.join(tmpDir, 'projects', 'p_int')
    await fs.mkdir(projDir, { recursive: true })
    const disk = makeState('p_int')
    disk.stages.render.status = 'running'
    await fs.writeFile(path.join(projDir, 'director-state.json'), JSON.stringify(disk))

    const restored = await hydrateImpl(agent, 'p_int')
    expect(restored!.interrupted).toBe(true)
    expect(restored!.interruptedStage).toBe('render')
  })

  it('P0-1：多个 running 阶段 → interruptedStage 取流水线顺序第一个', async () => {
    const agent = makeAgent(tmpDir)
    const projDir = path.join(tmpDir, 'projects', 'p_multi')
    await fs.mkdir(projDir, { recursive: true })
    const disk = makeState('p_multi')
    // scenes 与 render 同时 running（异常中断的边界态）
    disk.stages.scenes.status = 'running'
    disk.stages.render.status = 'running'
    await fs.writeFile(path.join(projDir, 'director-state.json'), JSON.stringify(disk))

    const restored = await hydrateImpl(agent, 'p_multi')
    // scenes 在 STAGE_ORDER 中先于 render → 取 scenes
    expect(restored!.interruptedStage).toBe('scenes')
    // 两个阶段都降级为 error
    expect(restored!.stages.scenes.status).toBe('error')
    expect(restored!.stages.render.status).toBe('error')
  })

  it('P0-1：无 running 阶段（正常结束态）→ 不置 interrupted 标记', async () => {
    const agent = makeAgent(tmpDir)
    const projDir = path.join(tmpDir, 'projects', 'p_done')
    await fs.mkdir(projDir, { recursive: true })
    const disk = makeState('p_done')
    disk.running = false
    disk.paused = false
    disk.stages.done.status = 'done'
    await fs.writeFile(path.join(projDir, 'director-state.json'), JSON.stringify(disk))

    const restored = await hydrateImpl(agent, 'p_done')
    expect(restored!.interrupted).toBeUndefined()
    expect(restored!.interruptedStage).toBeUndefined()
  })

  it('P0-1：中断日志包含阶段名，便于用户定位', async () => {
    const agent = makeAgent(tmpDir)
    const projDir = path.join(tmpDir, 'projects', 'p_log')
    await fs.mkdir(projDir, { recursive: true })
    const disk = makeState('p_log')
    disk.stages.casting.status = 'running'
    await fs.writeFile(path.join(projDir, 'director-state.json'), JSON.stringify(disk))

    const restored = await hydrateImpl(agent, 'p_log')
    const interruptedLog = restored!.logs.find(l => l.message.includes('应用重启'))
    expect(interruptedLog).toBeTruthy()
    expect(interruptedLog!.message).toContain('角色建档')
  })
})

describe('recoverAllImpl：启动扫描残留', () => {
  it('扫描 projects 目录，把残留 running 项目计入 repaired', async () => {
    const agent = makeAgent(tmpDir)
    const projDir = path.join(tmpDir, 'projects', 'p2')
    await fs.mkdir(projDir, { recursive: true })
    const disk = makeState('p2')
    disk.stages.combine.status = 'running'
    await fs.writeFile(path.join(projDir, 'director-state.json'), JSON.stringify(disk))

    const repaired = await recoverAllImpl(agent)
    expect(repaired).toBe(1)
    // 已回填内存并降级
    const restored = agent.states.get('p2')!
    expect(restored.running).toBe(false)
    expect(restored.stages.combine.status).toBe('error')
  })

  it('projects 目录不存在 → 返回 0，不抛错', async () => {
    const agent = makeAgent(path.join(tmpDir, 'nonexistent'))
    expect(await recoverAllImpl(agent)).toBe(0)
  })
})

describe('clearStateImpl：清残留防幽灵流水线', () => {
  it('删除项目在 states/cancelled/gates/pauseRequested/waiters/logSeq 等全部 Map/Set 条目', () => {
    const agent = makeAgent(tmpDir)
    agent.states.set('p1', makeState('p1'))
    agent.cancelled.add('p1')
    agent.gates.set('p1', new Set(['render' as DirectorStage]))
    agent.pauseRequested.add('p1')
    agent.waiters.set('p1', () => {})
    agent.logSeq.set('p1', 5)
    agent.lastStageMsg.set('p1:render', 'x')

    clearStateImpl(agent, 'p1')
    expect(agent.states.has('p1')).toBe(false)
    expect(agent.cancelled.has('p1')).toBe(false)
    expect(agent.gates.has('p1')).toBe(false)
    expect(agent.pauseRequested.has('p1')).toBe(false)
    expect(agent.waiters.has('p1')).toBe(false)
    expect(agent.logSeq.has('p1')).toBe(false)
    expect(agent.lastStageMsg.has('p1:render')).toBe(false)
    expect(agent.unsubscribeRenderProgress).toHaveBeenCalledWith('p1')
  })
})

describe('LOG_LIMIT：日志上限截断', () => {
  it('日志超过 LOG_LIMIT 时丢弃最旧条目', async () => {
    const agent = makeAgent(tmpDir)
    const s = makeState('p1')
    agent.states.set('p1', s)
    // 直接写满超阈值（status=running 非 pending，每条不同 message 都会落日志）
    for (let i = 0; i < LOG_LIMIT + 50; i++) {
      setStageImpl(agent, 'p1', 'render', 'running', `进度${i}`, i)
    }
    expect(s.logs.length).toBeLessThanOrEqual(LOG_LIMIT)
  })
})

describe('getLatestStateImpl：最近活跃任务', () => {
  it('多状态中按最后日志/完成/开始时间挑最新；空 states 返回 null', () => {
    const agent = makeAgent(tmpDir)
    expect(getLatestStateImpl(agent)).toBeNull()
    const oldS = makeState('p-old')
    oldS.startedAt = 1000
    const newS = makeState('p-new')
    newS.startedAt = 2000
    agent.states.set('p-old', oldS)
    agent.states.set('p-new', newS)
    expect(getLatestStateImpl(agent)!.projectId).toBe('p-new')
  })
})

describe('listActiveStatesImpl：并行活跃任务', () => {
  it('只返回 running/paused，按最近活动倒序', () => {
    const agent = makeAgent(tmpDir)
    expect(listActiveStatesImpl(agent)).toEqual([])

    const running = makeState('p-run')
    running.startedAt = 1000
    const paused = makeState('p-pause')
    paused.running = false
    paused.paused = true
    paused.startedAt = 3000
    const finished = makeState('p-done')
    finished.running = false
    finished.paused = false
    finished.startedAt = 5000
    agent.states.set('p-run', running)
    agent.states.set('p-pause', paused)
    agent.states.set('p-done', finished)

    const active = listActiveStatesImpl(agent)
    expect(active.map(s => s.projectId)).toEqual(['p-pause', 'p-run'])
  })

  it('最后日志时间优先于 startedAt', () => {
    const agent = makeAgent(tmpDir)
    const a = makeState('a')
    a.startedAt = 100
    const b = makeState('b')
    b.startedAt = 50
    b.logs.push({ id: 1, stage: 'analyze', level: 'info', message: 'x', timestamp: 900 })
    agent.states.set('a', a)
    agent.states.set('b', b)
    expect(listActiveStatesImpl(agent)[0].projectId).toBe('b')
  })
})

describe('pauseUntilShotsReviewedImpl：结构化门禁负载', () => {
  function makeProject(ids: string[]) {
    return {
      shots: ids.map((id, i) => ({
        id, index: i + 1, type: 'i2v' as const, reviewed: undefined as boolean | undefined,
        firstFramePath: ''
      }))
    }
  }

  it('block 模式：pendingGates 写入完整镜号清单，恢复后清空', async () => {
    const agent = makeAgent(tmpDir)
    agent.states.set('p1', makeState('p1'))
    agent.settings.get = vi.fn(async () => ({ render: { shotReviewGate: 'block' } }))
    agent.store.get = vi.fn(async () => makeProject(['a', 'b', 'c', 'd', 'e', 'f']))

    const promise = pauseUntilShotsReviewedImpl(agent, 'p1')
    await vi.waitFor(() => {
      const st = agent.states.get('p1')!
      expect(st.paused).toBe(true)
      expect(st.pendingGates).toEqual([{
        stage: 'render', reason: 'shotReview',
        unreviewedShotIds: ['a', 'b', 'c', 'd', 'e', 'f']
      }])
    })
    agent.waiters.get('p1')!()
    await promise
    expect(agent.states.get('p1')!.pendingGates).toEqual([])
  })

  it('warn 模式：告警放行，不暂停也不写负载', async () => {
    const agent = makeAgent(tmpDir)
    agent.states.set('p1', makeState('p1'))
    agent.settings.get = vi.fn(async () => ({ render: { shotReviewGate: 'warn' } }))
    agent.store.get = vi.fn(async () => makeProject(['a']))
    await expect(pauseUntilShotsReviewedImpl(agent, 'p1')).resolves.toBe(true)
    expect(agent.states.get('p1')!.paused).toBe(false)
    expect(agent.states.get('p1')!.pendingGates).toBeUndefined()
  })

  it('无待审镜：清理残留 pendingGates 并放行', async () => {
    const agent = makeAgent(tmpDir)
    const st = makeState('p1')
    st.pendingGates = [{ stage: 'render', reason: 'shotReview', unreviewedShotIds: ['old'] }]
    agent.states.set('p1', st)
    agent.settings.get = vi.fn(async () => ({ render: { shotReviewGate: 'block' } }))
    agent.store.get = vi.fn(async () => ({ shots: [] }))
    await expect(pauseUntilShotsReviewedImpl(agent, 'p1')).resolves.toBe(true)
    expect(agent.states.get('p1')!.pendingGates).toEqual([])
  })
})

describe('maybeGateImpl：配置门命中', () => {
  it('gates 配置命中 afterStage → 挂起并等待 resume', async () => {
    const agent = makeAgent(tmpDir)
    agent.states.set('p1', makeState('p1'))
    agent.gates.set('p1', new Set(['render' as DirectorStage]))
    const done = maybeGateImpl(agent, 'p1', 'render')
    await vi.waitFor(() => {
      expect(agent.states.get('p1')!.paused).toBe(true)
    })
    // 调用登记的 resolve 放行；函数本身只补续跑日志，paused 由调用方续跑时清除
    agent.waiters.get('p1')!()
    await done
    expect(agent.states.get('p1')!.logs.some(l => l.message.includes('已继续执行'))).toBe(true)
  })
})

describe('hydrateImpl：paused 状态同样降级', () => {
  it('磁盘残留 paused=true → 也降级为非 paused 并补中断日志', async () => {
    const agent = makeAgent(tmpDir)
    const projDir = path.join(tmpDir, 'projects', 'pz')
    await fs.mkdir(projDir, { recursive: true })
    const disk = makeState('pz')
    disk.paused = true
    disk.stages.scenes.status = 'running'
    await fs.writeFile(path.join(projDir, 'director-state.json'), JSON.stringify(disk))

    const restored = await hydrateImpl(agent, 'pz')
    expect(restored!.running).toBe(false)
    expect(restored!.paused).toBe(false)
    expect(restored!.stages.scenes.status).toBe('error')
  })
})
