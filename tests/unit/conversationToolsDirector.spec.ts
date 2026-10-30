import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  tStart, tSimple, tStatus, tListShots, tRerender,
  tRenderSample, tMakeTrailer, tRebuildFrames
} from '../../src/main/core/conversationToolsDirector'

/**
 * 对话工具·导演域（conversationToolsDirector）单测：
 * 开拍校验、暂停/继续/取消分支（含断点续跑回退）、状态/分镜列表、
 * 重渲门禁、试片/预告片、首帧重建委托。
 */
const tmpDirs: string[] = []
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-tools-'))
  tmpDirs.push(dir)
  return dir
}

function shot(over: Record<string, any> = {}): any {
  return {
    id: `s${over.index || 1}`, index: 1, type: 't2v', shotSize: 'medium',
    characterIds: [], scene: '天台', dialogue: '', status: 'pending', ...over
  }
}

function makeProject(over: Record<string, any> = {}): any {
  return {
    id: 'p1', title: '测试剧', genre: '都市',
    characters: [{ id: 'c1', name: '林夏', voice: 'zh-CN-XiaoxiaoNeural' }],
    shots: [shot()],
    ...over
  }
}

function makeHost(project: any = makeProject(), opts: Record<string, any> = {}): any {
  return {
    baseDir: opts.baseDir || '/tmp/nowhere',
    lastProjectId: undefined,
    director: {
      getState: vi.fn(() => opts.state ?? null),
      start: vi.fn(async () => 'new_p1'),
      pause: vi.fn(async () => undefined),
      resume: vi.fn(async () => undefined),
      resumeFromStage: opts.resumeFromStage || vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      rebuildShotFirstFrames: opts.rebuildShotFirstFrames || vi.fn(async () => ({ ok: true, text: 'ok' }))
    },
    projects: {
      get: opts.get || vi.fn(async () => project)
    },
    queue: { start: vi.fn(async () => undefined) },
    settings: { get: vi.fn(async () => opts.settings || {}) },
    ffmpeg: {
      concatSegments: opts.concatSegments || vi.fn(async () => undefined),
      getDuration: opts.getDuration || vi.fn(async () => 5),
      trimClip: opts.trimClip || vi.fn(async () => undefined),
      mixBgm: opts.mixBgm || vi.fn(async () => undefined)
    }
  }
}

describe('tStart', () => {
  it('缺片名/题材/剧本时拒绝', async () => {
    const host = makeHost()
    const r = await tStart(host, undefined, { title: '伞', genre: '悬疑' })
    expect(r.ok).toBe(false)
    expect(r.text).toContain('缺少片名/题材/剧本')
    expect(host.director.start).not.toHaveBeenCalled()
  })

  it('当前项目已有任务时拒绝', async () => {
    const host = makeHost(makeProject(), { state: { running: true, title: '旧剧' } })
    const r = await tStart(host, 'p1', { title: '伞', genre: '悬疑', script: '正文' })
    expect(r.ok).toBe(false)
    expect(r.text).toContain('已有任务在执行')
  })

  it('默认确认点 analyze/render，成功后绑定 lastProjectId', async () => {
    const host = makeHost()
    const r = await tStart(host, undefined, { title: '伞', genre: '悬疑', script: '正文' })
    expect(r.ok).toBe(true)
    expect(JSON.parse(r.text).gateStages).toEqual(['analyze', 'render'])
    expect(host.lastProjectId).toBe('new_p1')
    expect(host.director.start).toHaveBeenCalledWith(expect.objectContaining({
      title: '伞', genre: '悬疑', gateStages: ['analyze', 'render'], existingProjectId: undefined
    }))
  })

  it('传入 gate_stages 时过滤非字符串', async () => {
    const host = makeHost()
    const r = await tStart(host, 'p1', { title: 't', genre: 'g', script: 's', gate_stages: ['render', 1] })
    expect(r.ok).toBe(true)
    expect(JSON.parse(r.text).gateStages).toEqual(['render'])
    expect(host.director.start).toHaveBeenCalledWith(expect.objectContaining({ existingProjectId: 'p1' }))
  })
})

describe('tSimple', () => {
  it('无项目/无任务记录时拒绝', async () => {
    expect((await tSimple(makeHost(), undefined, 'pause')).text).toContain('没有打开的项目')
    const host = makeHost(makeProject(), { state: null })
    expect((await tSimple(host, 'p1', 'pause')).text).toContain('没有任务记录')
  })

  it('暂停：不在执行中拒绝，执行中调用 pause', async () => {
    const paused = makeHost(makeProject(), { state: { running: false, paused: false } })
    expect((await tSimple(paused, 'p1', 'pause')).ok).toBe(false)

    const host = makeHost(makeProject(), { state: { running: true, paused: false } })
    const r = await tSimple(host, 'p1', 'pause')
    expect(r.ok).toBe(true)
    expect(host.director.pause).toHaveBeenCalledWith('p1')
    expect(JSON.parse(r.text)).toMatchObject({ action: 'pause', accepted: true, projectTitle: '测试剧' })
  })

  it('继续：暂停态直接 resume；运行中与已取消分别拒绝', async () => {
    const host = makeHost(makeProject(), { state: { running: false, paused: true } })
    const r = await tSimple(host, 'p1', 'resume')
    expect(r.ok).toBe(true)
    expect(host.director.resume).toHaveBeenCalledWith('p1')

    const running = makeHost(makeProject(), { state: { running: true, paused: false } })
    expect((await tSimple(running, 'p1', 'resume')).text).toContain('正在运行中')

    const cancelled = makeHost(makeProject(), { state: { running: false, paused: false, cancelled: true } })
    expect((await tSimple(cancelled, 'p1', 'resume')).text).toContain('已被取消')
  })

  it('继续：无确认点且未跑完时按中断阶段断点续跑', async () => {
    const stages: Record<string, any> = {}
    for (const s of ['analyze', 'casting', 'scenes', 'render', 'combine', 'subtitle', 'review', 'bgm']) {
      stages[s] = { status: s === 'scenes' ? 'pending' : 'done' }
    }
    const resumeFromStage = vi.fn(async () => undefined)
    const host = makeHost(makeProject(), {
      state: { running: false, paused: false, cancelled: false, stages },
      resumeFromStage
    })

    const r = await tSimple(host, 'p1', 'resume')

    expect(r.ok).toBe(true)
    expect(resumeFromStage).toHaveBeenCalledWith('p1', 'scenes')
  })

  it('继续：优先使用 interruptedStage；续跑异常返回可读错误', async () => {
    const stages = { analyze: { status: 'done' }, casting: { status: 'done' }, scenes: { status: 'pending' } }
    const resumeFromStage = vi.fn(async () => { throw new Error('门禁未配置') })
    const host = makeHost(makeProject(), {
      state: { running: false, paused: false, cancelled: false, interruptedStage: 'render', stages },
      resumeFromStage
    })

    const r = await tSimple(host, 'p1', 'resume')

    expect(r.ok).toBe(false)
    expect(r.text).toContain('无法继续：门禁未配置')
    expect(resumeFromStage).toHaveBeenCalledWith('p1', 'render')
  })

  it('全部阶段完成时提示无需继续', async () => {
    const stages: Record<string, any> = {}
    for (const s of ['analyze', 'casting', 'scenes', 'render', 'combine', 'subtitle', 'review', 'bgm']) {
      stages[s] = { status: 'done' }
    }
    const host = makeHost(makeProject(), { state: { running: false, paused: false, cancelled: false, stages } })
    const r = await tSimple(host, 'p1', 'resume')
    expect(r.ok).toBe(false)
    expect(r.text).toContain('所有阶段均已完成')
  })

  it('取消直接调用 cancel', async () => {
    const host = makeHost(makeProject(), { state: { running: true } })
    const r = await tSimple(host, 'p1', 'cancel')
    expect(r.ok).toBe(true)
    expect(host.director.cancel).toHaveBeenCalledWith('p1')
  })
})

describe('tStatus / tListShots', () => {
  it('无项目或无任务时返回对应提示', async () => {
    expect((await tStatus(makeHost(), undefined)).text).toContain('没有打开的项目')
    const host = makeHost(makeProject(), { state: null })
    expect(JSON.parse((await tStatus(host, 'p1')).text)).toMatchObject({ hasTask: false, projectId: 'p1' })
  })

  it('有任务时输出阶段与镜头进度', async () => {
    const host = makeHost(makeProject(), {
      state: {
        title: '测试剧', running: true, paused: false, cancelled: false,
        totalShots: 3, doneShots: 1, failedShotIds: ['s2'],
        stages: {
          analyze: { status: 'done', message: 'ok', percent: 100 },
          render: { status: 'running', message: '渲染中', percent: 33 }
        }
      }
    })
    const r = await tStatus(host, 'p1')
    const data = JSON.parse(r.text)
    expect(data.hasTask).toBe(true)
    expect(data.doneShots).toBe(1)
    expect(data.failedShotIds).toEqual(['s2'])
    expect(data.stages.render).toEqual({ status: 'running', message: '渲染中', percent: 33 })
    expect(data.finalPath).toBeNull()
  })

  it('分镜列表最多 60 条并映射角色名/台词/状态', async () => {
    const shots = Array.from({ length: 65 }, (_, i) => shot({
      id: `s${i + 1}`, index: i + 1, type: 'i2v', characterIds: ['c1'], dialogue: `台词${i + 1}`
    }))
    const host = makeHost(makeProject({ shots }))
    const r = await tListShots(host, 'p1')
    const data = JSON.parse(r.text)
    expect(data.total).toBe(65)
    expect(data.characters).toEqual(['林夏(zh-CN-XiaoxiaoNeural)'])
    expect(data.shots).toHaveLength(60)
    expect(data.shots[0]).toMatchObject({ index: 1, character: '林夏', dialogue: '台词1', status: 'pending' })
  })
})

describe('tRerender', () => {
  it('缺少项目/镜号或镜号不存在时拒绝', async () => {
    expect((await tRerender(makeHost(), undefined, { shot_indexes: [1] })).text).toContain('没有打开的项目')
    expect((await tRerender(makeHost(), 'p1', {})).text).toContain('未指定镜号')
    const host = makeHost(makeProject({ shots: [shot({ index: 1 })] }))
    expect((await tRerender(host, 'p1', { shot_indexes: [9] })).text).toContain('没有找到镜号：9')
  })

  it('block 门禁拦下未核对首帧的 i2v 镜头', async () => {
    const host = makeHost(makeProject({
      shots: [shot({ index: 1, type: 'i2v', characterIds: ['c1'], reviewed: false })]
    }), { settings: { render: { shotReviewGate: 'block' } } })

    const r = await tRerender(host, 'p1', { shot_indexes: [1] })

    expect(r.ok).toBe(false)
    expect(r.text).toContain('分镜审核未通过：第1镜')
    expect(host.queue.start).not.toHaveBeenCalled()
  })

  it('warn 门禁放行并在结果中提示', async () => {
    const host = makeHost(makeProject({
      shots: [shot({ index: 1, type: 'i2v', characterIds: ['c1'], reviewed: false })]
    }), { settings: { render: { shotReviewGate: 'warn' } } })

    const r = await tRerender(host, 'p1', { shot_indexes: [1] })

    expect(r.ok).toBe(true)
    expect(r.text).toContain('尚未核对分镜图（按设置告警放行）')
    expect(host.queue.start).toHaveBeenCalledWith('p1', ['s1'])
  })

  it('force_rebuild 先重建首帧再重新读取项目入队', async () => {
    const before = makeProject({ shots: [shot({ index: 1, type: 'i2v', characterIds: ['c1'], reviewed: true })] })
    const after = makeProject({ shots: [shot({ index: 1, type: 'i2v', characterIds: ['c1'], reviewed: true })] })
    let served = 0
    const host = makeHost(before, {
      get: vi.fn(async () => (served++ === 0 ? before : after))
    })

    const r = await tRerender(host, 'p1', { shot_indexes: [1], force_rebuild: true })

    expect(r.ok).toBe(true)
    expect(host.director.rebuildShotFirstFrames).toHaveBeenCalledWith('p1', [1])
    expect(host.projects.get).toHaveBeenCalledTimes(2)
    expect(JSON.parse(r.text)).toMatchObject({ queued: true, count: 1, rebuilt: true })
  })
})

describe('tRenderSample', () => {
  it('无项目时拒绝', async () => {
    expect((await tRenderSample(makeHost(), undefined, {})).text).toContain('没有打开的项目')
  })

  it('尚无成片：自动挑选代表镜头入队', async () => {
    const shots = [
      shot({ index: 1, scene: '天台', characterIds: ['c1'], status: 'pending' }),
      shot({ index: 2, scene: '街道', characterIds: ['c1'], status: 'pending' }),
      shot({ index: 3, scene: '车内', characterIds: [], status: 'pending' })
    ]
    const host = makeHost(makeProject({ shots }))

    const r = await tRenderSample(host, 'p1', {})

    expect(r.ok).toBe(true)
    const data = JSON.parse(r.text)
    expect(data.queued).toBe(true)
    expect(data.shotIndexes.length).toBeGreaterThanOrEqual(2)
    expect(host.queue.start).toHaveBeenCalledWith('p1', expect.any(Array))
  })

  it('尚无成片且无待渲染镜头时拒绝', async () => {
    const host = makeHost(makeProject({ shots: [shot({ status: 'done' })] }))
    const r = await tRenderSample(host, 'p1', {})
    expect(r.ok).toBe(false)
    expect(r.text).toContain('没有可渲染的镜头')
  })

  it('已有成片：按指定镜号拼样片，超过 4 镜截断', async () => {
    const baseDir = await makeTmpDir()
    const shots = Array.from({ length: 6 }, (_, i) => shot({
      id: `s${i + 1}`, index: i + 1, segmentPath: `projects/p1/shots/s${i + 1}.mp4`
    }))
    const concatSegments = vi.fn(async () => undefined)
    const host = makeHost(makeProject({ shots }), { baseDir, concatSegments })

    const r = await tRenderSample(host, 'p1', { shot_indexes: [1, 2, 3, 4, 5, 6] })

    expect(r.ok).toBe(true)
    const data = JSON.parse(r.text)
    expect(data.sampleReady).toBe(true)
    expect(data.usedShots).toEqual([1, 2, 3, 4])
    expect(concatSegments).toHaveBeenCalledWith(
      shots.slice(0, 4).map(s => path.join(baseDir, s.segmentPath)),
      path.join(baseDir, 'projects/p1/sample.mp4')
    )
  })

  it('指定镜号尚未渲染完成时拒绝', async () => {
    const shots = [
      shot({ index: 1, segmentPath: 'a.mp4' }),
      shot({ index: 2 })
    ]
    const host = makeHost(makeProject({ shots }))
    const r = await tRenderSample(host, 'p1', { shot_indexes: [2] })
    expect(r.ok).toBe(false)
    expect(r.text).toContain('指定的镜头尚未渲染完成')
  })
})

describe('tMakeTrailer', () => {
  it('没有已渲染镜头时拒绝', async () => {
    const host = makeHost(makeProject({ shots: [shot({ status: 'pending' })] }))
    expect((await tMakeTrailer(host, 'p1', {})).text).toContain('无法制作预告片')
  })

  it('逐段截中段、拼接并按配置混 BGM 后覆盖原片', async () => {
    const baseDir = await makeTmpDir()
    await fs.mkdir(path.join(baseDir, 'projects', 'p1'), { recursive: true })
    const shots = [shot({ index: 1, segmentPath: 'projects/p1/shots/s1.mp4' })]
    const mixBgm = vi.fn(async (_video: string, _bgm: string, out: string) => {
      await fs.writeFile(out, 'mixed')
    })
    const host = makeHost(makeProject({ shots, bgmPath: 'projects/p1/bgm.mp3', bgmVolume: 40 }), {
      baseDir,
      mixBgm,
      getDuration: vi.fn(async () => 6)
    })

    const r = await tMakeTrailer(host, 'p1', { clip_seconds: 2, with_bgm: true })

    expect(r.ok).toBe(true)
    const data = JSON.parse(r.text)
    expect(data.clipSeconds).toBe(2)
    expect(data.withBgm).toBe(true)
    expect(host.ffmpeg.trimClip).toHaveBeenCalledWith(
      path.join(baseDir, 'projects/p1/shots/s1.mp4'), 2, 2,
      path.join(baseDir, 'projects/p1/trailer_clips/c0.mp4')
    )
    expect(mixBgm).toHaveBeenCalledWith(
      path.join(baseDir, 'projects/p1/trailer.mp4'),
      path.join(baseDir, 'projects/p1/bgm.mp3'),
      path.join(baseDir, 'projects/p1/trailer.mp4.bgm.mp4'),
      40
    )
    await expect(fs.access(path.join(baseDir, 'projects/p1/trailer.mp4'))).resolves.toBeUndefined()
  })

  it('clip_seconds 越界时钳到 0.5~3 秒，无 BGM 不混音', async () => {
    const baseDir = await makeTmpDir()
    const shots = [shot({ index: 1, segmentPath: 'a.mp4' })]
    const mixBgm = vi.fn(async () => undefined)
    const host = makeHost(makeProject({ shots }), { baseDir, mixBgm })

    const r = await tMakeTrailer(host, 'p1', { clip_seconds: 10, with_bgm: false })

    expect(r.ok).toBe(true)
    expect(JSON.parse(r.text).clipSeconds).toBe(3)
    expect(mixBgm).not.toHaveBeenCalled()
  })
})

describe('tRebuildFrames', () => {
  it('缺镜号时拒绝，否则委托 director.rebuildShotFirstFrames', async () => {
    const host = makeHost()
    expect((await tRebuildFrames(host, 'p1', {})).text).toContain('未指定镜号')

    const rebuild = vi.fn(async () => ({ ok: true, text: '已重建' }))
    const host2 = makeHost(makeProject(), { rebuildShotFirstFrames: rebuild })
    const r = await tRebuildFrames(host2, 'p1', { shot_indexes: [1, 2] })
    expect(r).toEqual({ ok: true, text: '已重建' })
    expect(rebuild).toHaveBeenCalledWith('p1', [1, 2])
  })
})
