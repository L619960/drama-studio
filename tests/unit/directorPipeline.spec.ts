import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  withTransientRetryImpl,
  selfHealStageImpl,
  concatDoneShotsImpl,
  runPipelineImpl
} from '../../src/main/core/directorPipeline'
import { freshStateImpl } from '../../src/main/core/directorStateMachine'
import { HEAL_MAX } from '../../src/main/core/directorConstants'

/**
 * 导演流水线编排单测（directorPipeline 首个 spec）：
 * 瞬时重试、C 自愈预算与判定、拼接参数映射、断点续跑从指定阶段开始且不重跑前置阶段。
 * 全部依赖以最小 mock agent 提供，不触碰真实 LLM/ComfyUI/文件产物。
 */
describe('directorPipeline', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-pipe-'))
  })

  afterEach(async () => {
    // emitStateImpl 的落盘是 fire-and-forget，留出完成窗口避免 Windows 句柄占用
    await new Promise(r => setTimeout(r, 60))
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  const settings = {
    render: { shotReviewGate: 'warn', finalReviewGate: 'block', perShotAudit: true, consistencyMode: 'warn' },
    creation: { storyboard: { maxShots: 20 }, edit: { subtitleFontSize: 18, subtitleMarginV: 20, defaultBgmVolume: 30 } }
  }

  function makeAgent(over: Record<string, unknown> = {}) {
    const agent: any = {
      baseDir: dir,
      states: new Map(),
      cancelled: new Set<string>(),
      gates: new Map(),
      pauseRequested: new Set<string>(),
      waiters: new Map(),
      logSeq: new Map(),
      healBudget: new Map(),
      lastStageMsg: new Map(),
      shadowSettledShots: new Map(),
      shadowRenders: new Set<string>(),
      lastStepByShot: new Map(),
      progressUnsubs: new Map(),
      visionWarned: new Set<string>(),
      emit: vi.fn(),
      unsubscribeRenderProgress: vi.fn(),
      skills: {
        load: vi.fn(async () => null),
        auditChecklist: vi.fn(async () => []),
        methodRules: vi.fn(async () => []),
        loadErrorHint: () => ''
      },
      settings: { get: vi.fn(async () => settings) },
      store: {
        get: vi.fn(async () => ({
          title: '测试剧',
          shots: [],
          characters: [],
          sceneBoards: []
        })),
        save: vi.fn(async () => undefined)
      },
      llm: { diagnoseFailure: vi.fn(), reviewStory: vi.fn(), analyze: vi.fn(), auditImage: vi.fn() },
      ffmpeg: { getVideoInfo: vi.fn(async () => ({ hasAudio: true, durationSec: 3 })), smartConcatSegments: vi.fn() },
      queue: { start: vi.fn(), waitForFinish: vi.fn(), on: vi.fn(), off: vi.fn() },
      subtitles: { generate: vi.fn() },
      ...over
    }
    return agent
  }

  describe('withTransientRetryImpl', () => {
    it('成功一次不重试', async () => {
      const fn = vi.fn(async () => 'ok')
      await expect(withTransientRetryImpl(makeAgent(), fn)).resolves.toBe('ok')
      expect(fn).toHaveBeenCalledTimes(1)
    })

    it('永久性错误立即抛出，不做退避', async () => {
      const err = new Error('模型不存在')
      const fn = vi.fn(async () => { throw err })
      await expect(withTransientRetryImpl(makeAgent(), fn)).rejects.toBe(err)
      expect(fn).toHaveBeenCalledTimes(1)
    })

    it('取消信号在等待期间生效：抛 CANCELLED', async () => {
      let cancelled = false
      const fn = vi.fn(async () => { throw new Error('ECONNRESET') })
      setTimeout(() => { cancelled = true }, 50)
      await expect(withTransientRetryImpl(makeAgent(), fn, { isCancelled: () => cancelled }))
        .rejects.toThrow('CANCELLED')
      expect(fn).toHaveBeenCalledTimes(1)
    })

    it('瞬时错误按 retries=0 直接抛出（不进入退避）', async () => {
      const fn = vi.fn(async () => { throw new Error('status code 503') })
      await expect(withTransientRetryImpl(makeAgent(), fn, { retries: 0 })).rejects.toThrow('503')
      expect(fn).toHaveBeenCalledTimes(1)
    })
  })

  describe('selfHealStageImpl', () => {
    it('无运行状态 / 预算耗尽时不诊断', async () => {
      const agent = makeAgent()
      const llm = agent.llm.diagnoseFailure
      const retry = vi.fn()
      await expect(selfHealStageImpl(agent, 'p1', 'render', '逐镜渲染', ['x'], retry)).resolves.toBe(false)
      expect(llm).not.toHaveBeenCalled()

      agent.states.set('p1', freshStateImpl(agent, 'p1', 't'))
      agent.healBudget.set('p1', HEAL_MAX)
      await expect(selfHealStageImpl(agent, 'p1', 'render', '逐镜渲染', ['x'], retry)).resolves.toBe(false)
      expect(llm).not.toHaveBeenCalled()
      expect(retry).not.toHaveBeenCalled()
    })

    it('诊断调用失败 / 不可自动修复：记录建议且不重试', async () => {
      const agent = makeAgent()
      agent.states.set('p1', freshStateImpl(agent, 'p1', 't'))
      agent.llm.diagnoseFailure.mockRejectedValueOnce(new Error('LLM 离线'))
      const retry = vi.fn()
      await expect(selfHealStageImpl(agent, 'p1', 'render', '逐镜渲染', ['x'], retry)).resolves.toBe(false)
      expect(retry).not.toHaveBeenCalled()

      agent.llm.diagnoseFailure.mockResolvedValueOnce({
        canAutoFix: false, diagnosis: '参考图缺失', suggestion: '补传参考图'
      })
      await expect(selfHealStageImpl(agent, 'p1', 'render', '逐镜渲染', ['x'], retry)).resolves.toBe(false)
      const state = agent.states.get('p1')
      expect(state.heal).toEqual({ stage: 'render', diagnosis: '参考图缺失', suggestion: '补传参考图' })
      expect(retry).not.toHaveBeenCalled()
    })

    it('可自动修复：消耗一次预算并重试成功', async () => {
      const agent = makeAgent()
      agent.states.set('p1', freshStateImpl(agent, 'p1', 't'))
      agent.llm.diagnoseFailure.mockResolvedValueOnce({
        canAutoFix: true, diagnosis: '显存偶发不足', suggestion: ''
      })
      const retry = vi.fn(async () => undefined)
      await expect(selfHealStageImpl(agent, 'p1', 'render', '逐镜渲染', ['x'], retry)).resolves.toBe(true)
      expect(agent.healBudget.get('p1')).toBe(1)
      expect(retry).toHaveBeenCalledTimes(1)
      const state = agent.states.get('p1')
      expect(state.heal.stage).toBe('render')
      expect(state.heal.suggestion).toContain('已自动重试')
    })

    it('重试再次失败：返回 false 并留错误日志', async () => {
      const agent = makeAgent()
      agent.states.set('p1', freshStateImpl(agent, 'p1', 't'))
      agent.llm.diagnoseFailure.mockResolvedValueOnce({
        canAutoFix: true, diagnosis: '可修', suggestion: ''
      })
      const retry = vi.fn(async () => { throw new Error('还是失败') })
      await expect(selfHealStageImpl(agent, 'p1', 'render', '逐镜渲染', ['x'], retry)).resolves.toBe(false)
      const logs = agent.states.get('p1').logs
      expect(logs.some((l: { message: string }) => l.message.includes('自动重试仍未成功'))).toBe(true)
    })
  })

  describe('concatDoneShotsImpl', () => {
    it('没有已完成镜头时报错', async () => {
      const agent = makeAgent()
      await expect(concatDoneShotsImpl(agent, 'p1', [], 'projects/p1/final.mp4'))
        .rejects.toThrow('没有已完成可拼接的镜头')
    })

    it('按 baseDir 拼接绝对路径并透传剪辑参数', async () => {
      const agent = makeAgent()
      const shots = [
        { segmentPath: 'projects/p1/shots/a.mp4', scene: '天台', dialogue: '走吧', transition: 'hard', trimStart: 0.5, trimEnd: 1, skipped: false },
        { segmentPath: 'projects/p1/shots/b.mp4', scene: '车内', dialogue: '', skipped: true }
      ]
      await concatDoneShotsImpl(agent, 'p1', shots as never, 'projects/p1/final.mp4')
      const [segs, out] = agent.ffmpeg.smartConcatSegments.mock.calls[0]
      expect(segs.map((s: { path: string }) => s.path)).toEqual([
        path.join(dir, 'projects/p1/shots/a.mp4'),
        path.join(dir, 'projects/p1/shots/b.mp4')
      ])
      expect(segs[0]).toMatchObject({ scene: '天台', hasDialogue: true, transition: 'hard', trimStart: 0.5, trimEnd: 1 })
      expect(segs[1]).toMatchObject({ hasDialogue: false, skipped: true })
      expect(out).toBe(path.join(dir, 'projects/p1/final.mp4'))
    })
  })

  describe('runPipelineImpl 断点续跑', () => {
    function reviewProject() {
      return {
        title: '测试剧',
        characters: [{ id: 'c1', name: '林夏' }],
        sceneBoards: [],
        shots: [
          {
            id: 's1', index: 1, scene: '天台', type: 'i2v', action: '回头', dialogue: '走吧',
            characterIds: ['c1'], shotSize: 'medium', frames: 81, status: 'done',
            segmentPath: 'projects/p1/shots/s1.mp4', transition: 'hard'
          }
        ]
      }
    }

    it('从 review 续跑：前置阶段保持 pending，仅执行 review/bgm 并产出成片路径', async () => {
      const agent = makeAgent()
      const project = reviewProject()
      agent.store.get.mockResolvedValue(project)
      agent.llm.reviewStory.mockResolvedValue({ issues: [], summary: '节奏紧凑' })
      agent.ffmpeg.getVideoInfo.mockResolvedValue({ hasAudio: true, durationSec: 4 })
      const state = freshStateImpl(agent, 'p1', '测试剧')
      state.totalShots = 1
      state.stages.subtitle = { status: 'done', message: '字幕已烧录', percent: 100 }
      agent.states.set('p1', state)

      await runPipelineImpl(agent, 'p1', {
        title: '测试剧', genre: '都市', script: '剧本'
      } as never, 'review')

      expect(agent.skills.load).toHaveBeenCalledWith(true)
      // 前置阶段未被重跑
      for (const st of ['analyze', 'casting', 'scenes', 'render', 'combine', 'subtitle'] as const) {
        expect(state.stages[st].status).toBe(st === 'subtitle' ? 'done' : 'pending')
      }
      expect(state.stages.review.status).toBe('done')
      expect(state.stages.review.message).toContain('复审通过')
      expect(state.stages.bgm.status).toBe('skipped')
      expect(state.finalPath).toBe('projects/p1/final_subtitled.mp4')
      expect(state.stages.done.status).toBe('done')
      expect(state.running).toBe(false)
      expect(agent.llm.reviewStory).toHaveBeenCalledTimes(1)
      // final + 每个分段各一次
      expect(agent.ffmpeg.getVideoInfo).toHaveBeenCalledTimes(2)
    })

    it('复审硬门禁：成片缺音轨时阻断并结束任务', async () => {
      const agent = makeAgent()
      agent.store.get.mockResolvedValue(reviewProject())
      agent.llm.reviewStory.mockResolvedValue({ issues: [], summary: '' })
      agent.ffmpeg.getVideoInfo.mockResolvedValue({ hasAudio: false, durationSec: 4 })
      const state = freshStateImpl(agent, 'p1', '测试剧')
      state.totalShots = 1
      state.stages.subtitle = { status: 'done', message: '', percent: 100 }
      agent.states.set('p1', state)

      await runPipelineImpl(agent, 'p1', {
        title: '测试剧', genre: '都市', script: '剧本'
      } as never, 'review')

      expect(state.stages.review.status).toBe('error')
      expect(state.stages.review.message).toContain('缺少音轨')
      expect(state.reviewIssues).toContain('成片缺少音轨')
      expect(state.running).toBe(false)
      // 硬门禁在 review 内直接收尾，不再进入 bgm，finalPath 不赋值
      expect(state.stages.done.message).toContain('复审未通过')
      expect(state.stages.bgm.status).toBe('pending')
    })

    it('复审叙事类提醒在 block 门禁下放行：阶段标记 done', async () => {
      const agent = makeAgent()
      agent.store.get.mockResolvedValue(reviewProject())
      agent.llm.reviewStory.mockResolvedValue({ issues: ['第1镜台词与字幕不符'], summary: '' })
      agent.ffmpeg.getVideoInfo.mockResolvedValue({ hasAudio: true, durationSec: 4 })
      const state = freshStateImpl(agent, 'p1', '测试剧')
      state.totalShots = 1
      state.stages.subtitle = { status: 'done', message: '', percent: 100 }
      agent.states.set('p1', state)

      await runPipelineImpl(agent, 'p1', {
        title: '测试剧', genre: '都市', script: '剧本'
      } as never, 'review')

      // 叙事类提醒在 block 门禁下放行
      expect(state.stages.review.status).toBe('done')
      expect(state.stages.review.message).toContain('已放行')
      expect(state.running).toBe(false)
    })
  })
})
