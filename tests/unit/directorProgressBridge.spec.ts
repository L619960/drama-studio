import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  emitProgressEventImpl,
  notifyProjectUpdatedImpl,
  ensureShadowStateImpl,
  onExternalProgressImpl,
  onExternalQueueFinishedImpl,
  subscribeRenderProgressImpl,
  unsubscribeRenderProgressImpl
} from '../../src/main/core/directorProgressBridge'
import { freshStateImpl } from '../../src/main/core/directorStateMachine'

/**
 * 进度桥单测（directorProgressBridge 首个 spec）：
 * 影子任务状态创建/复用、外部进度日志与去重、队列排空收尾、
 * 流水线渲染进度订阅的磁盘重算与退订。
 */
function makeAgent(over: Record<string, any> = {}) {
  const agent: any = {
    baseDir: '',
    states: new Map(),
    cancelled: new Set(),
    emit: vi.fn(),
    logSeq: new Map(),
    lastStageMsg: new Map(),
    progressUnsubs: new Map(),
    shadowRenders: new Set(),
    shadowSettledShots: new Map(),
    lastStepByShot: new Map(),
    store: {
      get: vi.fn(async () => ({
        title: '测试剧',
        shots: [
          { id: 's1', status: 'done' },
          { id: 's2', status: 'failed' }
        ]
      }))
    },
    queue: { on: vi.fn(), off: vi.fn() },
    unsubscribeRenderProgress: vi.fn(),
    ...over
  }
  return agent
}

const flush = () => new Promise(r => setTimeout(r, 0))

describe('directorProgressBridge', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-bridge-'))
  })

  afterEach(async () => {
    // emitStateImpl 的落盘是 fire-and-forget，留出完成窗口避免 Windows 句柄占用
    await new Promise(r => setTimeout(r, 60))
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  function makeAgentWithDir() {
    const agent = makeAgent()
    agent.baseDir = dir
    return agent
  }

  describe('事件推送', () => {
    it('emitProgressEvent 无状态时不发事件，有状态时推送 progress', () => {
      const agent = makeAgentWithDir()
      emitProgressEventImpl(agent, 'p1')
      expect(agent.emit).not.toHaveBeenCalled()

      const state = freshStateImpl(agent, 'p1', 't')
      agent.states.set('p1', state)
      emitProgressEventImpl(agent, 'p1')
      expect(agent.emit).toHaveBeenCalledWith('progress', {
        type: 'director:progress', projectId: 'p1', state
      })
    })

    it('notifyProjectUpdated 固定推送 projectUpdated', () => {
      const agent = makeAgent()
      notifyProjectUpdatedImpl(agent, 'p1')
      expect(agent.emit).toHaveBeenCalledWith('projectUpdated', {
        type: 'director:project-updated', projectId: 'p1'
      })
    })
  })

  describe('ensureShadowState', () => {
    it('无状态时创建影子任务，并从项目分镜补齐计数', async () => {
      const agent = makeAgentWithDir()
      const state = ensureShadowStateImpl(agent, 'p1')

      expect(state.running).toBe(true)
      expect(state.stages.render.status).toBe('running')
      expect(agent.shadowRenders.has('p1')).toBe(true)
      await flush()
      expect(state.title).toBe('测试剧')
      expect(state.totalShots).toBe(2)
      expect(state.doneShots).toBe(1)
      expect(state.failedShotIds).toEqual(['s2'])
      expect(agent.emit).toHaveBeenCalledWith('progress', expect.objectContaining({ projectId: 'p1' }))
    })

    it('已运行状态直接复用，不重置计数', () => {
      const agent = makeAgentWithDir()
      const state = freshStateImpl(agent, 'p1', 't')
      state.doneShots = 3
      state.running = true
      agent.states.set('p1', state)

      expect(ensureShadowStateImpl(agent, 'p1')).toBe(state)
      expect(state.doneShots).toBe(3)
      expect(agent.shadowRenders.has('p1')).toBe(false)
    })

    it('上一轮已收尾：重开渲染监控并重置本批计数，保留历史日志', () => {
      const agent = makeAgentWithDir()
      const state = freshStateImpl(agent, 'p1', 't')
      state.running = false
      state.finishedAt = 123
      state.doneShots = 5
      state.failedShotIds = ['s9']
      state.logs.push({ id: 1, stage: 'render', level: 'info', message: '历史', timestamp: 1 })
      agent.states.set('p1', state)

      ensureShadowStateImpl(agent, 'p1')

      expect(state.running).toBe(true)
      expect(state.finishedAt).toBeUndefined()
      expect(state.doneShots).toBe(0)
      expect(state.failedShotIds).toEqual([])
      expect(state.logs).toHaveLength(1)
      expect(agent.shadowRenders.has('p1')).toBe(true)
    })
  })

  describe('onExternalProgress', () => {
    it('无 projectId 或已被流水线订阅时直接忽略', () => {
      const agent = makeAgentWithDir()
      onExternalProgressImpl(agent, { shotId: 's1', step: 'render' })
      expect(agent.states.size).toBe(0)

      agent.progressUnsubs.set('p1', () => undefined)
      onExternalProgressImpl(agent, { projectId: 'p1', shotId: 's1', step: 'render' })
      expect(agent.states.size).toBe(0)
      expect(agent.emit).not.toHaveBeenCalled()
    })

    it('首次进入 render 记录开始日志，重复心跳不刷屏', () => {
      const agent = makeAgentWithDir()
      onExternalProgressImpl(agent, { projectId: 'p1', shotId: 's1', step: 'render' })
      const state = agent.states.get('p1')
      expect(state.logs.some((l: any) => l.message.includes('镜头 s1 开始渲染'))).toBe(true)

      onExternalProgressImpl(agent, { projectId: 'p1', shotId: 's1', step: 'render' })
      const renderLogs = state.logs.filter((l: any) => l.message.includes('开始渲染'))
      expect(renderLogs).toHaveLength(1)
    })

    it('done 同镜去重计数，failed 同镜去重并记录错误', () => {
      const agent = makeAgentWithDir()
      const state = ensureShadowStateImpl(agent, 'p1')
      onExternalProgressImpl(agent, { projectId: 'p1', shotId: 's1', step: 'done' })
      onExternalProgressImpl(agent, { projectId: 'p1', shotId: 's1', step: 'done' })
      expect(state.doneShots).toBe(1)
      expect(state.logs.filter((l: any) => l.message.includes('镜头 s1 渲染完成'))).toHaveLength(2)
      // done 后 lastStep 已清理
      expect(agent.lastStepByShot.has('p1:s1')).toBe(false)

      onExternalProgressImpl(agent, { projectId: 'p1', shotId: 's2', step: 'failed', message: 'OOM' })
      onExternalProgressImpl(agent, { projectId: 'p1', shotId: 's2', step: 'failed', message: 'OOM' })
      expect(state.failedShotIds).toEqual(['s2'])
      expect(state.logs.some((l: any) => l.message.includes('渲染失败：OOM'))).toBe(true)
    })

    it('显存不足与非 render 阶段收尾信息写入日志', () => {
      const agent = makeAgentWithDir()
      const state = ensureShadowStateImpl(agent, 'p1')
      onExternalProgressImpl(agent, { projectId: 'p1', shotId: 's1', step: 'combine', percent: 50, message: '显存不足，已降档' })
      expect(state.logs.some((l: any) => l.level === 'warn' && l.message.includes('显存不足'))).toBe(true)

      onExternalProgressImpl(agent, { projectId: 'p1', shotId: 's1', step: 'combine', percent: 99, message: '一致性校验完成' })
      expect(state.logs.some((l: any) => l.message.includes('一致性校验完成'))).toBe(true)
    })

    it('queued + 已取消 记录告警并清理步骤跟踪', () => {
      const agent = makeAgentWithDir()
      const state = ensureShadowStateImpl(agent, 'p1')
      agent.lastStepByShot.set('p1:s1', 'queued')
      onExternalProgressImpl(agent, { projectId: 'p1', shotId: 's1', step: 'queued', message: '已取消' })
      expect(state.logs.some((l: any) => l.level === 'warn' && l.message.includes('已取消'))).toBe(true)
      expect(agent.lastStepByShot.has('p1:s1')).toBe(false)
    })
  })

  describe('onExternalQueueFinished', () => {
    it('非影子任务直接忽略', () => {
      const agent = makeAgentWithDir()
      const state = freshStateImpl(agent, 'p1', 't')
      agent.states.set('p1', state)
      onExternalQueueFinishedImpl(agent, 'p1')
      expect(state.running).toBe(true)
    })

    it('全部成功：render 置 done 并停表', () => {
      const agent = makeAgentWithDir()
      const state = ensureShadowStateImpl(agent, 'p1')
      state.doneShots = 2
      onExternalQueueFinishedImpl(agent, 'p1')

      expect(state.stages.render.status).toBe('done')
      expect(state.stages.render.message).toContain('成功 2 镜')
      expect(state.running).toBe(false)
      expect(state.finishedAt).toBeTruthy()
      expect(agent.shadowRenders.has('p1')).toBe(false)
      expect(agent.shadowSettledShots.has('p1')).toBe(false)
    })

    it('存在失败镜：render 置 error 并提示重渲', () => {
      const agent = makeAgentWithDir()
      const state = ensureShadowStateImpl(agent, 'p1')
      state.doneShots = 1
      state.failedShotIds = ['s2']
      onExternalQueueFinishedImpl(agent, 'p1')

      expect(state.stages.render.status).toBe('error')
      expect(state.stages.render.message).toContain('失败 1')
      expect(state.stages.render.message).toContain('分镜页重渲')
    })
  })

  describe('渲染进度订阅', () => {
    it('订阅前先退订旧订阅，done/failed 触发按磁盘重算', async () => {
      const agent = makeAgentWithDir()
      const state = freshStateImpl(agent, 'p1', 't')
      state.totalShots = 2
      agent.states.set('p1', state)
      const old = vi.fn()
      agent.progressUnsubs.set('p1', old)

      subscribeRenderProgressImpl(agent, 'p1')
      expect(agent.unsubscribeRenderProgress).toHaveBeenCalledWith('p1')
      expect(agent.queue.on).toHaveBeenCalledWith('progress', expect.any(Function))

      const listener = agent.queue.on.mock.calls[0][1]
      listener({ projectId: 'other', step: 'done' })
      expect(agent.logSeq.has('other')).toBe(false)

      listener({ projectId: 'p1', shotId: 's1', step: 'done' })
      await flush()
      expect(state.doneShots).toBe(1)
      expect(state.stages.render.message).toContain('渲染中 1/2')
      expect(state.stages.render.percent).toBe(50)
    })

    it('退订调用 queue.off 并从映射移除；重复退订安全', () => {
      const agent = makeAgentWithDir()
      subscribeRenderProgressImpl(agent, 'p1')
      unsubscribeRenderProgressImpl(agent, 'p1')
      expect(agent.queue.off).toHaveBeenCalledWith('progress', expect.any(Function))
      expect(agent.progressUnsubs.has('p1')).toBe(false)

      unsubscribeRenderProgressImpl(agent, 'p1')
      expect(agent.queue.off).toHaveBeenCalledTimes(1)
    })
  })
})
