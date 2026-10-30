import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  finishImpl,
  evictFinishedStatesImpl,
  auditSingleShotImpl,
  renderShotsWithAuditImpl,
  approveShotsImpl
} from '../../src/main/core/directorFinish'
import { freshStateImpl } from '../../src/main/core/directorStateMachine'

/**
 * 审核与收尾单测（directorFinish 首个 spec）：
 * finish 状态/取消标志/映射清理、过期状态淘汰、单镜技术+视觉审核、
 * 提示式逐镜审核流程、批量审批（缺失/音轨/时长/黑帧/角色混淆/一致性）。
 */
function makeAgent(over: Record<string, any> = {}) {
  const agent: any = {
    baseDir: '',
    states: new Map(),
    cancelled: new Set(),
    pauseRequested: new Set(),
    waiters: new Map(),
    gates: new Map(),
    healBudget: new Map(),
    lastStageMsg: new Map(),
    logSeq: new Map(),
    progressUnsubs: new Map(),
    visionWarned: new Set(),
    emit: vi.fn(),
    unsubscribeRenderProgress: vi.fn(),
    store: { get: vi.fn(), save: vi.fn(async () => undefined) },
    settings: { get: vi.fn(async () => ({ render: { consistencyMode: 'warn' } })) },
    skills: { auditChecklist: vi.fn(async () => []) },
    ffmpeg: {
      getDuration: vi.fn(async () => 3),
      looksLikeBlankVideo: vi.fn(async () => false),
      fileExists: vi.fn(async () => true),
      getVideoInfo: vi.fn(async () => ({ durationSec: 5, hasAudio: true }))
    },
    queue: {
      start: vi.fn(async () => undefined),
      waitForFinish: vi.fn(async () => undefined),
      on: vi.fn(),
      off: vi.fn()
    },
    llm: { auditImage: vi.fn() },
    ...over
  }
  return agent
}

describe('directorFinish', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-finish-'))
  })

  afterEach(async () => {
    await new Promise(r => setTimeout(r, 60))
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  function makeAgentWithDir() {
    const agent = makeAgent()
    agent.baseDir = dir
    return agent
  }

  async function touch(rel: string) {
    const abs = path.join(dir, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, 'x')
  }

  describe('finishImpl', () => {
    it('无状态直接返回', () => {
      const agent = makeAgentWithDir()
      finishImpl(agent, 'p1')
      expect(agent.emit).not.toHaveBeenCalled()
    })

    it('正常完成：done 阶段写入成片路径并清理暂停/门禁/自愈映射', () => {
      const agent = makeAgentWithDir()
      const state = freshStateImpl(agent, 'p1', 't')
      state.finalPath = 'projects/p1/final.mp4'
      agent.states.set('p1', state)
      agent.pauseRequested.add('p1')
      agent.waiters.set('p1', {})
      agent.gates.set('p1', new Set(['render']))
      agent.healBudget.set('p1', 1)
      agent.lastStageMsg.set('p1:render', '渲染中')
      agent.lastStageMsg.set('p2:render', '别的项目')

      finishImpl(agent, 'p1')

      expect(state.running).toBe(false)
      expect(state.paused).toBe(false)
      expect(state.cancelled).toBe(false)
      expect(state.stages.done.status).toBe('done')
      expect(state.stages.done.message).toContain('projects/p1/final.mp4')
      expect(state.finishedAt).toBeTruthy()
      expect(agent.pauseRequested.has('p1')).toBe(false)
      expect(agent.waiters.has('p1')).toBe(false)
      expect(agent.gates.has('p1')).toBe(false)
      expect(agent.healBudget.has('p1')).toBe(false)
      expect(agent.lastStageMsg.has('p1:render')).toBe(false)
      expect(agent.lastStageMsg.has('p2:render')).toBe(true)
      expect(state.logs.some((l: any) => l.message.includes('全部完成'))).toBe(true)
    })

    it('取消态：done 置 skipped、日志告警，之后从取消集合移除', () => {
      const agent = makeAgentWithDir()
      const state = freshStateImpl(agent, 'p1', 't')
      agent.states.set('p1', state)
      agent.cancelled.add('p1')

      finishImpl(agent, 'p1')

      expect(state.cancelled).toBe(true)
      expect(state.stages.done.status).toBe('skipped')
      expect(state.stages.done.message).toBe('已取消')
      expect(state.logs.some((l: any) => l.level === 'warn' && l.message.includes('任务已取消'))).toBe(true)
      expect(agent.cancelled.has('p1')).toBe(false)
    })

    it('显式 doneMessage：按错误级别记录并作为完成消息', () => {
      const agent = makeAgentWithDir()
      const state = freshStateImpl(agent, 'p1', 't')
      agent.states.set('p1', state)

      finishImpl(agent, 'p1', '渲染失败过多')

      expect(state.stages.done.message).toBe('渲染失败过多')
      expect(state.logs.some((l: any) => l.level === 'error' && l.message === '渲染失败过多')).toBe(true)
    })

    it('REQ-05：正常完成发出 success=true 的终态事件', () => {
      const agent = makeAgentWithDir()
      const state = freshStateImpl(agent, 'p1', 't')
      state.finalPath = 'projects/p1/final.mp4'
      agent.states.set('p1', state)

      finishImpl(agent, 'p1')

      const finished = agent.emit.mock.calls.find((c: any[]) => c[0] === 'finished')?.[1]
      expect(finished).toMatchObject({
        type: 'director:finished',
        projectId: 'p1',
        success: true,
        cancelled: false,
        finalPath: 'projects/p1/final.mp4'
      })
    })

    it('REQ-05：失败收尾与取消分别发出 success=false 的终态事件', () => {
      const agent = makeAgentWithDir()
      const state = freshStateImpl(agent, 'p1', 't')
      state.failedShotIds = ['s1']
      agent.states.set('p1', state)
      finishImpl(agent, 'p1', '审批未通过')
      const failed = agent.emit.mock.calls.find((c: any[]) => c[0] === 'finished')?.[1]
      expect(failed).toMatchObject({
        type: 'director:finished', success: false, cancelled: false, failedShotIds: ['s1']
      })
      expect(failed.message).toBe('审批未通过')

      const agent2 = makeAgentWithDir()
      const state2 = freshStateImpl(agent2, 'p2', 't2')
      agent2.states.set('p2', state2)
      agent2.cancelled.add('p2')
      finishImpl(agent2, 'p2')
      const cancelled = agent2.emit.mock.calls.find((c: any[]) => c[0] === 'finished')?.[1]
      expect(cancelled).toMatchObject({
        type: 'director:finished', success: false, cancelled: true, failedShotIds: []
      })
    })
  })

  describe('evictFinishedStatesImpl', () => {
    it('只淘汰完成超过 1 小时的非运行状态', () => {
      const agent = makeAgentWithDir()
      const old = Date.now() - 61 * 60 * 1000
      const a = freshStateImpl(agent, 'old', 'a')
      a.running = false
      a.finishedAt = old
      const b = freshStateImpl(agent, 'running', 'b')
      b.running = true
      b.finishedAt = old
      const c = freshStateImpl(agent, 'recent', 'c')
      c.running = false
      c.finishedAt = Date.now()
      agent.states.set('old', a)
      agent.states.set('running', b)
      agent.states.set('recent', c)
      agent.logSeq.set('old', 5)

      evictFinishedStatesImpl(agent)

      expect(agent.states.has('old')).toBe(false)
      expect(agent.logSeq.has('old')).toBe(false)
      expect(agent.states.has('running')).toBe(true)
      expect(agent.states.has('recent')).toBe(true)
    })
  })

  describe('auditSingleShotImpl', () => {
    const baseShot = { id: 's1', index: 1, scene: '天台', type: 't2v', characterIds: [] }

    it('无产物路径 / 文件不存在 / 视频信息读取失败均判定未通过', async () => {
      const agent = makeAgentWithDir()
      const project = { characters: [], sceneBoards: [] }

      await expect(auditSingleShotImpl(agent, 'p1', baseShot as never, project as never, []))
        .resolves.toMatchObject({ passed: false, reason: '产物文件缺失', durationSec: -1 })

      await expect(auditSingleShotImpl(
        agent, 'p1', { ...baseShot, segmentPath: 'missing.mp4' } as never, project as never, []
      )).resolves.toMatchObject({ passed: false, reason: '产物文件不存在' })

      await touch('a.mp4')
      agent.ffmpeg.getDuration.mockRejectedValueOnce(new Error('ffprobe 失败'))
      await expect(auditSingleShotImpl(
        agent, 'p1', { ...baseShot, segmentPath: 'a.mp4' } as never, project as never, []
      )).resolves.toMatchObject({ passed: false, reason: '视频信息读取失败' })
    })

    it('时长过短 / 纯色黑帧判定未通过', async () => {
      const agent = makeAgentWithDir()
      await touch('a.mp4')
      const shot = { ...baseShot, segmentPath: 'a.mp4' } as never
      const project = { characters: [], sceneBoards: [] } as never

      agent.ffmpeg.getDuration.mockResolvedValue(0.5)
      const short = await auditSingleShotImpl(agent, 'p1', shot, project, [])
      expect(short).toMatchObject({ passed: false, durationSec: 0.5 })
      expect(short.reason).toContain('时长过短')

      agent.ffmpeg.getDuration.mockResolvedValue(3)
      agent.ffmpeg.looksLikeBlankVideo.mockResolvedValueOnce(true)
      await expect(auditSingleShotImpl(agent, 'p1', shot, project, []))
        .resolves.toMatchObject({ passed: false, reason: '画面疑似纯色/黑帧' })
    })

    it('rerender 模式下 i2v 一致性偏低判定未通过并给修复提示', async () => {
      const agent = makeAgentWithDir()
      await touch('a.mp4')
      agent.settings.get.mockResolvedValueOnce({ render: { consistencyMode: 'rerender' } })
      const shot = { ...baseShot, type: 'i2v', segmentPath: 'a.mp4', consistencyScore: 0.1 } as never
      const r = await auditSingleShotImpl(agent, 'p1', shot, { characters: [], sceneBoards: [] } as never, [])
      expect(r.passed).toBe(false)
      expect(r.reason).toContain('人物一致性偏低')
      expect(r.fixHint).toContain('keep exact face identity')
    })

    it('skipVision / 空清单直接通过，不做视觉审核', async () => {
      const agent = makeAgentWithDir()
      await touch('a.mp4')
      const shot = { ...baseShot, segmentPath: 'a.mp4' } as never
      const project = { characters: [], sceneBoards: [] } as never

      await expect(auditSingleShotImpl(agent, 'p1', shot, project, [{ id: 'x' } as never], true))
        .resolves.toMatchObject({ passed: true, vision: false })
      expect(agent.llm.auditImage).not.toHaveBeenCalled()

      await expect(auditSingleShotImpl(agent, 'p1', shot, project, []))
        .resolves.toMatchObject({ passed: true })
      expect(agent.llm.auditImage).not.toHaveBeenCalled()
    })

    it('视觉不可用：放行且每个项目只告警一次', async () => {
      const agent = makeAgentWithDir()
      await touch('a.mp4')
      const shot = { ...baseShot, segmentPath: 'a.mp4' } as never
      const project = { characters: [], sceneBoards: [] } as never
      agent.states.set('p1', freshStateImpl(agent, 'p1', 't'))
      agent.llm.auditImage.mockResolvedValue({ visionUnavailable: true, passed: true, blockedProblems: [], fixHint: '' })

      await expect(auditSingleShotImpl(agent, 'p1', shot, project, [{ id: 'x' } as never]))
        .resolves.toMatchObject({ passed: true, vision: false })
      await auditSingleShotImpl(agent, 'p1', shot, project, [{ id: 'x' } as never])

      const warnings = agent.states.get('p1')?.logs.filter((l: any) => l.message.includes('不支持视觉输入')) || []
      expect(warnings).toHaveLength(1)
    })

    it('视觉审核不通过返回阻断原因，通过时保留 fixHint', async () => {
      const agent = makeAgentWithDir()
      await touch('a.mp4')
      const shot = { ...baseShot, segmentPath: 'a.mp4', index: 2 } as never
      const project = {
        characters: [{ id: 'c1', name: '林夏', appearanceLock: 'long hair' }],
        sceneBoards: [{ id: 'b1', name: '天台' }]
      } as never

      agent.llm.auditImage.mockResolvedValueOnce({
        passed: false, blockedProblems: ['出现第二人', '道具缺失'], fixHint: '重渲'
      })
      await expect(auditSingleShotImpl(agent, 'p1', shot, project, [{ id: 'x' } as never]))
        .resolves.toMatchObject({ passed: false, reason: '出现第二人；道具缺失', fixHint: '重渲', vision: true })

      agent.llm.auditImage.mockResolvedValueOnce({
        passed: true, blockedProblems: [], fixHint: '可优化构图'
      })
      await expect(auditSingleShotImpl(agent, 'p1', shot, project, [{ id: 'x' } as never]))
        .resolves.toMatchObject({ passed: true, fixHint: '可优化构图' })
    })
  })

  describe('renderShotsWithAuditImpl', () => {
    it('取消后不启动任何队列任务，并退订进度', async () => {
      const agent = makeAgentWithDir()
      const state = freshStateImpl(agent, 'p1', 't')
      agent.states.set('p1', state)
      agent.cancelled.add('p1')
      agent.store.get.mockResolvedValue({
        shots: [{ id: 's1', status: 'pending' }]
      })

      await renderShotsWithAuditImpl(agent, 'p1', new Map())

      expect(agent.queue.start).not.toHaveBeenCalled()
      expect(agent.queue.off).toHaveBeenCalled()
    })

    it('逐镜渲染后即时审核：成功镜写入时长与提示，失败镜跳过', async () => {
      const agent = makeAgentWithDir()
      await touch('s1.mp4')
      const state = freshStateImpl(agent, 'p1', 't')
      agent.states.set('p1', state)
      const base = {
        shots: [
          { id: 's1', index: 1, scene: '天台', status: 'pending', segmentPath: 's1.mp4', action: '' },
          { id: 's2', index: 2, scene: '车内', status: 'failed', segmentPath: '', action: '' }
        ]
      }
      agent.store.get
        .mockResolvedValueOnce(base)
        .mockResolvedValueOnce({
          ...base,
          shots: [{ ...base.shots[0], status: 'done' }, base.shots[1]]
        })
        .mockResolvedValueOnce(base)
      const durations = new Map<string, number>()

      await renderShotsWithAuditImpl(agent, 'p1', durations)

      expect(agent.queue.start).toHaveBeenCalledTimes(2)
      expect(durations.get('s1')).toBe(3)
      expect(state.stages.render.message).toContain('渲染 1/2')
      const doneLog = state.logs.find((l: any) => l.message.includes('第1镜'))
      expect(doneLog.message).toContain('渲染完成')
      expect(agent.queue.off).toHaveBeenCalled()
    })
  })

  describe('approveShotsImpl', () => {
    function project(shots: Record<string, any>[]) {
      return { shots }
    }

    it('全部通过：返回时长映射与空问题列表', async () => {
      const agent = makeAgentWithDir()
      agent.store.get.mockResolvedValue(project([
        { id: 's1', index: 1, scene: '天台', status: 'done', segmentPath: 'a.mp4', frames: 81, type: 't2v' }
      ]))

      const r = await approveShotsImpl(agent, 'p1')

      expect(r).toMatchObject({ approved: true, problems: [], retryIds: [], warnings: [] })
      expect(r.durations.get('s1')).toBe(5)
      expect(agent.queue.start).not.toHaveBeenCalled()
    })

    it('分段缺失：换 seed 重渲并复检，仍失败则拦下', async () => {
      const agent = makeAgentWithDir()
      const shots = [
        { id: 's1', index: 1, scene: '天台', status: 'done', segmentPath: 'a.mp4', frames: 81, type: 't2v', seed: 1 }
      ]
      agent.store.get.mockResolvedValue(project(shots))
      agent.ffmpeg.fileExists.mockResolvedValue(false)

      const r = await approveShotsImpl(agent, 'p1')

      expect(r.approved).toBe(false)
      expect(r.retryIds).toEqual(['s1'])
      expect(r.problems[0]).toContain('分段文件缺失')
      expect(typeof shots[0].seed).toBe('number')
      expect(agent.queue.start).toHaveBeenCalledWith('p1', ['s1'])
      expect(agent.store.save).toHaveBeenCalled()
    })

    it('无音轨拦下', async () => {
      const agent = makeAgentWithDir()
      agent.store.get.mockResolvedValue(project([
        { id: 's1', index: 1, scene: '天台', status: 'done', segmentPath: 'a.mp4', frames: 81, type: 't2v', seed: 1 }
      ]))
      agent.ffmpeg.getVideoInfo.mockResolvedValue({ durationSec: 5, hasAudio: false })

      const r = await approveShotsImpl(agent, 'p1')

      expect(r.approved).toBe(false)
      expect(r.problems.join('；')).toContain('无音轨')
    })

    it('角色混淆拦下', async () => {
      const agent = makeAgentWithDir()
      agent.store.get.mockResolvedValue(project([
        {
          id: 's2', index: 2, scene: '车内', status: 'done', segmentPath: 'b.mp4',
          frames: 81, type: 't2v', seed: 2, roleConfusion: true
        }
      ]))

      const r = await approveShotsImpl(agent, 'p1')

      expect(r.approved).toBe(false)
      expect(r.problems.join('；')).toContain('角色混淆')
    })

    it('一致性偏低只告警放行，不触发重渲', async () => {
      const agent = makeAgentWithDir()
      agent.settings.get.mockResolvedValue({ render: { consistencyMode: 'rerender' } })
      agent.store.get.mockResolvedValue(project([
        {
          id: 's1', index: 1, scene: '天台', status: 'done', segmentPath: 'a.mp4',
          frames: 81, type: 'i2v', consistencyScore: 0.1
        }
      ]))

      const r = await approveShotsImpl(agent, 'p1')

      expect(r.approved).toBe(true)
      expect(r.warnings).toHaveLength(1)
      expect(r.warnings[0]).toContain('人物一致性偏低')
      expect(agent.queue.start).not.toHaveBeenCalled()
    })
  })
})
