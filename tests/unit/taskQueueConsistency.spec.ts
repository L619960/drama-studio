/**
 * taskQueueConsistency 拆分模块单测（不起 ComfyUI/ffmpeg、不发网络）：
 * - runConsistencyCheck：非 i2v/off/不可用早退、R2V 锚点口径（抽帧成功/失败跳过写分）、
 *   达标摘帽、warn 仅告警/严重漂移标记、H3 兜底切 Wan、rerender 换 seed 复评（含复评抛错）
 * - recheckProjectConsistency：项目缺失/模型不可用抛错、镜头过滤、达标摘帽/仍偏低标记、
 *   R2V 不标记、单镜异常跳过、store.save 回写
 * - computeShotRoleConfusion：前置条件 null 各分支、锚图口径、self 分数来源、混淆命中/未命中、
 *   时长为 0、单角色比对失败跳过
 * - recheckProjectRoleConfusion：项目缺失抛错、单角色跳过、多角色扫描回填 roleConfusion/auditHint
 * 阈值常量用 importOriginal 保留真实值（FACE=0.5 / FULL=0.7 / H3_FALLBACK=0.3）。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/main/core/ffmpegService', () => ({
  FFmpegService: class {},
}))
vi.mock('../../src/main/core/projectStore', () => ({
  ProjectStore: class {},
}))
vi.mock('../../src/main/core/consistencyService', async (importOriginal) => {
  const actual = await (importOriginal as () => Promise<Record<string, unknown>>)()
  return { ...actual, ConsistencyService: class {} }
})
// 真实 detectRoleConfusion 逻辑（bestOther > self + margin），避免 roleBinding 顶层 pinyin 依赖
vi.mock('../../src/main/core/roleBinding', () => ({
  detectRoleConfusion: (opts: {
    selfScore?: number
    otherScores: Array<{ characterId: string; name: string; score: number }>
    margin?: number
  }) => {
    const self = opts.selfScore ?? 0
    let best: { characterId: string; name: string; score: number } | null = null
    for (const o of opts.otherScores) if (!best || o.score > best.score) best = o
    if (!best) return { confused: false, selfScore: self }
    const margin = opts.margin ?? 0.05
    if (best.score > self + margin) {
      return {
        confused: true,
        withCharacter: best.characterId,
        withName: best.name,
        selfScore: self,
        bestOther: best.score,
      }
    }
    return { confused: false, selfScore: self, bestOther: best.score }
  },
}))

import {
  runConsistencyCheck,
  recheckProjectConsistency,
  computeShotRoleConfusion,
  recheckProjectRoleConfusion,
} from '../../src/main/core/taskQueueConsistency'
import type { Project, ProgressEvent, Shot } from '../../src/shared/ipcTypes'

type PE = Omit<ProgressEvent, 'type'>

function makeShot(id: string, over: Partial<Shot> = {}): Shot {
  return {
    id,
    index: 1,
    type: 'i2v',
    status: 'done',
    scene: '街景',
    action: '站立微动',
    dialogue: '',
    emotion: 'calm',
    camera: '中景',
    frames: 49,
    characterIds: ['c1'],
    firstFramePath: `projects/p1/first_${id}.png`,
    segmentPath: `projects/p1/segments/${id}.mp4`,
    workflow: 'wan22_i2v',
    ...over,
  } as unknown as Shot
}

function makeProject(
  shots: Shot[],
  characters: Array<Record<string, unknown>> = [],
  over: Partial<Project> = {},
): Project {
  return {
    id: 'p1',
    title: 't',
    genre: '都市',
    status: 'draft',
    characters,
    scenes: [],
    sceneBoards: [],
    shots,
    ...over,
  } as unknown as Project
}

interface RtCfg {
  project?: Project | null
  service?: {
    available?: () => Promise<boolean>
    compareFrames?: (ref: string, seg: string, times: number[]) => Promise<{ score: number; method: 'face' | 'full' }>
    needsDownload?: boolean
  }
  extractFails?: boolean
  duration?: number
  resolveRef?: (shot: Shot, project: Project) => string
  resolveRefThrows?: boolean
}

function makeRt(cfg: RtCfg = {}) {
  const progress: PE[] = []
  const service = cfg.service ?? {}
  const svc = {
    available: service.available ?? (async () => true),
    compareFrames: service.compareFrames ?? (async () => ({ score: 0.8, method: 'full' as const })),
    needsDownload: service.needsDownload ?? false,
    lastMethodTrace: 'mock-trace',
  }
  const rt = {
    ffmpeg: {
      extractFrameAt: vi.fn(async (_inputPath: string, _outAbs: string, _timeSec: number) => {
        if (cfg.extractFails) throw new Error('extract-fail')
      }),
      getDuration: vi.fn(async (_path: string) => cfg.duration ?? 4),
    },
    store: {
      get: vi.fn(async (_id: string) => cfg.project ?? null),
      save: vi.fn(async (_project: Project) => {}),
    },
    getConsistencyService: () => svc,
    resolveInBase: (p: string) => `B:${p}`,
    resolveRefImageRel: (shot: Shot, project: Project) => {
      if (cfg.resolveRefThrows) throw new Error('no-ref')
      return cfg.resolveRef ? cfg.resolveRef(shot, project) : `projects/p1/refs/${shot.id}.png`
    },
    emitProgress: (e: PE) => {
      progress.push(e)
    },
  }
  return { rt: rt as never, obj: rt, progress, svc }
}

function checkOpts(shot: Shot, over: Partial<Parameters<typeof runConsistencyCheck>[1]> = {}) {
  return {
    projectId: 'p1',
    shot,
    refImageRel: 'projects/p1/refs/s1.png',
    segmentAbsPath: 'B:projects/p1/segments/s1.mp4',
    consistencyMode: 'warn' as const,
    renderSeed: 7,
    engine: 'wan',
    reRun: vi.fn(async () => {}),
    ...over,
  }
}

describe('runConsistencyCheck', () => {
  it('非 i2v 镜直接返回原 seed', async () => {
    const { rt, svc } = makeRt()
    const availSpy = vi.spyOn(svc, 'available')
    const seed = await runConsistencyCheck(rt, checkOpts(makeShot('s1', { type: 't2v' as never })))
    expect(seed).toBe(7)
    expect(availSpy).not.toHaveBeenCalled()
  })

  it('consistencyMode=off 直接返回原 seed', async () => {
    const { rt } = makeRt()
    const seed = await runConsistencyCheck(rt, checkOpts(makeShot('s1'), { consistencyMode: 'off' }))
    expect(seed).toBe(7)
  })

  it('一致性模型不可用返回原 seed', async () => {
    const { rt } = makeRt({ service: { available: async () => false } })
    const seed = await runConsistencyCheck(rt, checkOpts(makeShot('s1')))
    expect(seed).toBe(7)
  })

  it('全图达标：写分数、清除历史 lowConsistency、仅发校验中进度', async () => {
    const shot = makeShot('s1')
    shot.lowConsistency = true
    const { rt, progress } = makeRt({
      service: { compareFrames: async () => ({ score: 0.75, method: 'full' }) },
    })
    const seed = await runConsistencyCheck(rt, checkOpts(shot))
    expect(seed).toBe(7)
    expect(shot.consistencyScore).toBe(0.75)
    expect(shot.lowConsistency).toBeUndefined()
    expect(progress).toHaveLength(1)
    expect(progress[0]).toMatchObject({ step: 'combine', percent: 97, message: '人物一致性校验...' })
  })

  it('无首帧时参照回退渲染参考图，三帧抽样按 25/50/90%', async () => {
    const shot = makeShot('s1', { firstFramePath: undefined as never })
    const cmp = vi.fn(async (_ref: string, _seg: string, _times: number[]) => ({ score: 0.8, method: 'full' as const }))
    const { rt } = makeRt({ service: { compareFrames: cmp } })
    await runConsistencyCheck(rt, checkOpts(shot))
    expect(cmp.mock.calls[0]?.[0]).toBe('B:projects/p1/refs/s1.png')
    expect(cmp.mock.calls[0]?.[2]).toEqual([1, 2, 3.6])
  })

  it('needsDownload=true 时进度提示首次加载模型', async () => {
    const { rt, progress } = makeRt({ service: { needsDownload: true } })
    await runConsistencyCheck(rt, checkOpts(makeShot('s1')))
    expect(progress[0]?.message).toContain('首次加载人物一致性模型')
  })

  it('人脸模式达标（0.55 ≥ 0.5）摘帽', async () => {
    const shot = makeShot('s1')
    shot.lowConsistency = true
    const { rt } = makeRt({
      service: { compareFrames: async () => ({ score: 0.55, method: 'face' }) },
    })
    await runConsistencyCheck(rt, checkOpts(shot))
    expect(shot.lowConsistency).toBeUndefined()
  })

  it('R2V 镜以视频第 0 帧为锚比对', async () => {
    const cmp = vi.fn(async (_ref: string, _seg: string, _times: number[]) => ({ score: 0.8, method: 'full' as const }))
    const { rt, obj } = makeRt({ service: { compareFrames: cmp } })
    await runConsistencyCheck(rt, checkOpts(makeShot('s1', { audioPath: 'projects/p1/audio/s1.wav' as never })))
    expect(obj.ffmpeg.extractFrameAt.mock.calls[0]?.[2]).toBe(0.06)
    expect(cmp.mock.calls[0]?.[0]).toBe('B:projects/p1/shots/s1_anchor.png')
  })

  it('R2V 锚抽帧失败：跳过写分且不调用 compareFrames', async () => {
    const shot = makeShot('s1', { audioPath: 'projects/p1/audio/s1.wav' as never })
    const cmp = vi.fn(async () => ({ score: 0.1, method: 'full' as const }))
    const { rt, progress } = makeRt({ extractFails: true, service: { compareFrames: cmp } })
    const seed = await runConsistencyCheck(rt, checkOpts(shot))
    expect(seed).toBe(7)
    expect(cmp).not.toHaveBeenCalled()
    expect(shot.consistencyScore).toBeUndefined()
    expect(progress).toHaveLength(0)
  })

  it('compareFrames 抛错：score 未定义直接返回原 seed', async () => {
    const shot = makeShot('s1')
    const { rt, progress } = makeRt({
      service: {
        compareFrames: async () => {
          throw new Error('boom')
        },
      },
    })
    const seed = await runConsistencyCheck(rt, checkOpts(shot))
    expect(seed).toBe(7)
    expect(shot.consistencyScore).toBeUndefined()
    expect(progress).toHaveLength(1)
  })

  it('warn+全图 0.5：不标记，仅告警文案', async () => {
    const shot = makeShot('s1')
    const opts = checkOpts(shot)
    const { rt, progress } = makeRt({
      service: { compareFrames: async () => ({ score: 0.5, method: 'full' }) },
    })
    await runConsistencyCheck(rt, opts)
    expect(shot.lowConsistency).toBeUndefined()
    expect(opts.reRun).not.toHaveBeenCalled()
    expect(progress[1]?.message).toContain('仅告警，镜头保留进成片')
  })

  it('warn+人脸 0.3（<0.4）：标记严重漂移', async () => {
    const shot = makeShot('s1')
    const { rt, progress } = makeRt({
      service: { compareFrames: async () => ({ score: 0.3, method: 'face' }) },
    })
    await runConsistencyCheck(rt, checkOpts(shot))
    expect(shot.lowConsistency).toBe(true)
    expect(progress[1]?.message).toContain('已标记严重漂移')
  })

  it('warn+全图 0.1（灾难级）：标记但文案走仅告警分支', async () => {
    const shot = makeShot('s1')
    const { rt, progress } = makeRt({
      service: { compareFrames: async () => ({ score: 0.1, method: 'full' }) },
    })
    await runConsistencyCheck(rt, checkOpts(shot))
    expect(shot.lowConsistency).toBe(true)
    expect(progress[1]?.message).toContain('仅告警')
  })

  it('warn+R2V 0.1：R2V 漂移严重文案', async () => {
    const shot = makeShot('s1', { audioPath: 'projects/p1/audio/s1.wav' as never })
    const { rt, progress } = makeRt({
      service: { compareFrames: async () => ({ score: 0.1, method: 'full' }) },
    })
    await runConsistencyCheck(rt, checkOpts(shot))
    expect(shot.lowConsistency).toBe(true)
    expect(progress[1]?.message).toContain('R2V 漂移严重')
  })

  it('warn+R2V 0.5：分数仅供参考不标记', async () => {
    const shot = makeShot('s1', { audioPath: 'projects/p1/audio/s1.wav' as never })
    const { rt, progress } = makeRt({
      service: { compareFrames: async () => ({ score: 0.5, method: 'full' }) },
    })
    await runConsistencyCheck(rt, checkOpts(shot))
    expect(shot.lowConsistency).toBeUndefined()
    expect(progress[1]?.message).toContain('仅供参考，不标记')
  })

  it('warn+H3 0.1（<0.15 灾难级）：兜底切 Wan 重渲，复评达标摘帽', async () => {
    const shot = makeShot('s1')
    const cmp = vi
      .fn()
      .mockResolvedValueOnce({ score: 0.1, method: 'full' })
      .mockResolvedValueOnce({ score: 0.8, method: 'full' })
    const { rt, progress } = makeRt({ service: { compareFrames: cmp } })
    const opts = checkOpts(shot, { engine: 'h3-i2v' })
    const seed = await runConsistencyCheck(rt, opts)
    expect(seed).not.toBe(7)
    expect(shot.seed).toBe(seed)
    expect(opts.reRun).toHaveBeenCalledWith(seed, 'wan')
    expect(shot.lowConsistency).toBeUndefined()
    expect(shot.consistencyScore).toBe(0.8)
    expect(progress.map((p) => `${p.step}:${p.percent}`)).toEqual(['combine:97', 'render:20'])
    expect(progress[1]?.message).toContain('自动切换 Wan i2v 重渲')
  })

  it('warn+H3 0.2（≥0.15 非灾难）：不兜底，走仅告警分支', async () => {
    const shot = makeShot('s1')
    const opts = checkOpts(shot, { engine: 'h3-i2v' })
    const { rt } = makeRt({
      service: { compareFrames: async () => ({ score: 0.2, method: 'full' }) },
    })
    await runConsistencyCheck(rt, opts)
    expect(opts.reRun).not.toHaveBeenCalled()
    expect(shot.lowConsistency).toBeUndefined() // 0.2 边界：score<0.2 为 false，保留原值
  })

  it('rerender+非 H3 0.5：换 seed 重渲，复评仍偏低则标记并发 99 进度', async () => {
    const shot = makeShot('s1')
    const cmp = vi
      .fn()
      .mockResolvedValueOnce({ score: 0.5, method: 'full' })
      .mockResolvedValueOnce({ score: 0.3, method: 'face' })
    const { rt, progress } = makeRt({ service: { compareFrames: cmp } })
    const opts = checkOpts(shot, { consistencyMode: 'rerender', engine: 'wan' })
    const seed = await runConsistencyCheck(rt, opts)
    expect(opts.reRun).toHaveBeenCalledWith(seed)
    expect(shot.lowConsistency).toBe(true)
    expect(progress[2]).toMatchObject({ step: 'combine', percent: 99 })
    expect(progress[2]?.message).toContain('重渲后人脸相似度')
  })

  it('rerender+H3 0.25（<0.3）：按阈值切 Wan，复评抛错不阻塞', async () => {
    const shot = makeShot('s1')
    const cmp = vi
      .fn()
      .mockResolvedValueOnce({ score: 0.25, method: 'full' })
      .mockRejectedValueOnce(new Error('recheck-fail'))
    const { rt } = makeRt({ service: { compareFrames: cmp } })
    const opts = checkOpts(shot, { consistencyMode: 'rerender', engine: 'h3-r2v' })
    const seed = await runConsistencyCheck(rt, opts)
    expect(opts.reRun).toHaveBeenCalledWith(seed, 'wan')
    expect(shot.lowConsistency).toBeUndefined()
    expect(shot.consistencyScore).toBe(0.25)
  })
})

describe('recheckProjectConsistency', () => {
  it('项目不存在抛错', async () => {
    const { rt } = makeRt({ project: null })
    await expect(recheckProjectConsistency(rt, 'p1')).rejects.toThrow('项目不存在')
  })

  it('一致性模型不可用抛错', async () => {
    const { rt } = makeRt({ project: makeProject([]), service: { available: async () => false } })
    await expect(recheckProjectConsistency(rt, 'p1')).rejects.toThrow('一致性模型不可用')
  })

  it('过滤+摘帽+仍偏低+R2V 不标+异常跳过，回写 save', async () => {
    const done = makeShot('s1', { index: 1 })
    done.lowConsistency = true
    const still = makeShot('s2', { index: 2 })
    const r2v = makeShot('s3', { index: 3, audioPath: 'projects/p1/audio/s3.wav' as never })
    r2v.lowConsistency = true
    const boom = makeShot('s4', { index: 4 })
    const project = makeProject([
      makeShot('x1', { type: 't2v' as never }), // 非 i2v → skipped
      makeShot('x2', { status: 'pending' as never }), // 未完成 → skipped
      makeShot('x3', { segmentPath: undefined as never }), // 无产物 → skipped
      makeShot('x4'), // 无参考图 → skipped
      done,
      still,
      r2v,
      boom,
    ])
    const cmp = vi.fn(async (ref: string) => {
      if (ref.includes('s4')) throw new Error('cmp-fail')
      if (ref.includes('s2')) return { score: 0.4, method: 'full' as const }
      return { score: 0.8, method: 'full' as const }
    })
    const { rt, obj, progress } = makeRt({
      project,
      service: { compareFrames: cmp },
      resolveRef: (shot) => (shot.id === 'x4' ? '' : `projects/p1/refs/${shot.id}.png`),
    })
    const res = await recheckProjectConsistency(rt, 'p1')
    expect(res).toEqual({ rechecked: 3, cleared: 2, stillLow: 1, skipped: 5 })
    expect(done.lowConsistency).toBeUndefined()
    expect(done.consistencyScore).toBe(0.8)
    expect(still.lowConsistency).toBe(true)
    expect(r2v.lowConsistency).toBeUndefined() // R2V 低分也摘帽
    expect(boom.consistencyScore).toBeUndefined()
    expect(obj.store.save.mock.calls[0]?.[0]).toBe(project)
    expect(progress.some((p) => p.message.includes('第1镜 重跑人物一致性校验'))).toBe(true)
  })

  it('R2V 锚抽帧失败保持原参照仍复评', async () => {
    const shot = makeShot('s1', { audioPath: 'projects/p1/audio/s1.wav' as never, firstFramePath: undefined as never })
    const cmp = vi.fn(async (_ref: string, _seg: string, _times: number[]) => ({ score: 0.9, method: 'full' as const }))
    const { rt } = makeRt({
      project: makeProject([shot]),
      service: { compareFrames: cmp },
      extractFails: true,
    })
    const res = await recheckProjectConsistency(rt, 'p1')
    expect(res.rechecked).toBe(1)
    expect(cmp.mock.calls[0]?.[0]).toBe('B:projects/p1/refs/s1.png')
  })
})

describe('computeShotRoleConfusion', () => {
  const chars = [
    { id: 'c1', name: '甲', faceImagePath: 'projects/p1/chars/c1.png' },
    { id: 'c2', name: '乙', faceImagePath: 'projects/p1/chars/c2.png' },
  ]

  it('未绑定角色/角色不存在/无其他角色/非 done i2v/模型不可用均返回 null', async () => {
    const project = makeProject([], chars)
    const { rt } = makeRt()
    expect(await computeShotRoleConfusion(rt, 'p1', makeShot('s1', { characterIds: [] as never }), project)).toBeNull()
    expect(await computeShotRoleConfusion(rt, 'p1', makeShot('s1', { characterIds: ['cx'] }), project)).toBeNull()
    const single = makeProject([], [{ id: 'c1', name: '甲', faceImagePath: 'x.png' }])
    expect(await computeShotRoleConfusion(rt, 'p1', makeShot('s1'), single)).toBeNull()
    expect(await computeShotRoleConfusion(rt, 'p1', makeShot('s1', { status: 'pending' as never }), project)).toBeNull()
    const { rt: rt2 } = makeRt({ service: { available: async () => false } })
    expect(await computeShotRoleConfusion(rt2, 'p1', makeShot('s1'), project)).toBeNull()
  })

  it('更像另一角色：置 roleConfusion 并返回详情', async () => {
    const shot = makeShot('s1', { characterIds: ['c1'] })
    shot.consistencyScore = 0.3
    const cmp = vi.fn(async (ref: string) => ({ score: ref.includes('c2') ? 0.6 : 0.9, method: 'face' as const }))
    const { rt } = makeRt({ service: { compareFrames: cmp } })
    const v = await computeShotRoleConfusion(rt, 'p1', shot, makeProject([shot], chars))
    expect(v).toMatchObject({ confused: true, withCharacter: 'c2', withName: '乙', selfScore: 0.3, bestOther: 0.6 })
    expect(shot.roleConfusion).toBe(true)
    expect(cmp).toHaveBeenCalledTimes(1) // self 已有分数，只比对方
  })

  it('本角色更像：不混淆，roleConfusion 保持', async () => {
    const shot = makeShot('s1', { characterIds: ['c1'] })
    shot.consistencyScore = 0.7
    const cmp = vi.fn(async () => ({ score: 0.6, method: 'face' as const }))
    const { rt } = makeRt({ service: { compareFrames: cmp } })
    const v = await computeShotRoleConfusion(rt, 'p1', shot, makeProject([shot], chars))
    expect(v!.confused).toBe(false)
    expect(shot.roleConfusion).toBeUndefined()
  })

  it('无既有分数：先比 self 再比 other，仍偏低判混淆', async () => {
    const shot = makeShot('s1', { characterIds: ['c2'] })
    const cmp = vi.fn(async (ref: string) => ({ score: ref.includes('c1') ? 0.55 : 0.2, method: 'face' as const }))
    const { rt } = makeRt({ service: { compareFrames: cmp } })
    const v = await computeShotRoleConfusion(rt, 'p1', shot, makeProject([shot], chars))
    expect(cmp).toHaveBeenCalledTimes(2) // self（首帧参照）+ c2 之外的 c1
    expect(v).toMatchObject({ confused: true, selfScore: 0.2, bestOther: 0.55, withName: '甲' })
  })

  it('视频时长取不到返回 null', async () => {
    const shot = makeShot('s1', { characterIds: ['c1'] })
    const { rt } = makeRt({ duration: 0 })
    expect(await computeShotRoleConfusion(rt, 'p1', shot, makeProject([shot], chars))).toBeNull()
  })

  it('R2V 镜锚抽帧成功用锚图；失败保持首帧参照', async () => {
    const shot = makeShot('s1', { characterIds: ['c1'], audioPath: 'projects/p1/audio/s1.wav' as never })
    const ok = vi.fn(async (_ref: string, _seg: string, _times: number[]) => ({ score: 0.9, method: 'face' as const }))
    const { rt } = makeRt({ service: { compareFrames: ok } })
    await computeShotRoleConfusion(rt, 'p1', shot, makeProject([shot], chars))
    expect(ok.mock.calls[0]?.[0]).toBe('B:projects/p1/shots/s1_anchor.png')
    const fail = vi.fn(async (_ref: string, _seg: string, _times: number[]) => ({
      score: 0.9,
      method: 'face' as const,
    }))
    const { rt: rt2 } = makeRt({ service: { compareFrames: fail }, extractFails: true })
    await computeShotRoleConfusion(rt2, 'p1', shot, makeProject([shot], chars))
    expect(fail.mock.calls[0]?.[0]).toBe('B:projects/p1/first_s1.png')
  })

  it('无首帧且参考图解析抛错返回 null', async () => {
    const shot = makeShot('s1', { characterIds: ['c1'], firstFramePath: undefined as never })
    const { rt } = makeRt({ resolveRefThrows: true })
    expect(await computeShotRoleConfusion(rt, 'p1', shot, makeProject([shot], chars))).toBeNull()
  })

  it('对方角色比对抛错：跳过该角色，判不混淆', async () => {
    const shot = makeShot('s1', { characterIds: ['c1'] })
    shot.consistencyScore = 0.3
    const cmp = vi.fn(async () => {
      throw new Error('face-missing')
    })
    const { rt } = makeRt({ service: { compareFrames: cmp } })
    const v = await computeShotRoleConfusion(rt, 'p1', shot, makeProject([shot], chars))
    expect(v).toEqual({ confused: false, selfScore: 0.3 })
    expect(shot.roleConfusion).toBeUndefined()
  })
})

describe('recheckProjectRoleConfusion', () => {
  it('项目不存在抛错', async () => {
    const { rt } = makeRt({ project: null })
    await expect(recheckProjectRoleConfusion(rt, 'p1')).rejects.toThrow('项目不存在')
  })

  it('单角色项目全部跳过', async () => {
    const project = makeProject([makeShot('s1')], [{ id: 'c1', name: '甲', faceImagePath: 'a.png' }])
    const { rt } = makeRt({ project })
    const res = await recheckProjectRoleConfusion(rt, 'p1')
    expect(res).toEqual({ checked: 0, confused: 0, skipped: 1 })
  })

  it('多角色扫描：混淆回填 auditHint，未混淆与非 i2v/未绑定分别计数', async () => {
    const s1 = makeShot('s1', { characterIds: ['c1'] })
    s1.consistencyScore = 0.3
    const s2 = makeShot('s2', { characterIds: ['c2'] })
    s2.consistencyScore = 0.7
    const s3 = makeShot('s3', { type: 't2v' as never })
    const s4 = makeShot('s4', { characterIds: [] as never })
    const project = makeProject(
      [s1, s2, s3, s4],
      [
        { id: 'c1', name: '甲', faceImagePath: 'projects/p1/chars/c1.png' },
        { id: 'c2', name: '乙', faceImagePath: 'projects/p1/chars/c2.png' },
      ],
    )
    const cmp = vi.fn(async (_ref: string, _seg: string, _times: number[]) => ({ score: 0.6, method: 'face' as const }))
    const { rt, obj } = makeRt({ project, service: { compareFrames: cmp } })
    const res = await recheckProjectRoleConfusion(rt, 'p1')
    expect(res).toEqual({ checked: 2, confused: 1, skipped: 2 })
    expect(s1.roleConfusion).toBe(true)
    expect(s1.auditHint).toContain('甲')
    expect(s1.auditHint).toContain('乙')
    expect(s2.roleConfusion).toBeUndefined()
    expect(obj.store.save.mock.calls[0]?.[0]).toBe(project)
  })
})
