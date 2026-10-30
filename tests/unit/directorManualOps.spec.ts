import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  rebuildShotFirstFramesImpl, rerunCastingImpl, regenerateScenePanoImpl
} from '../../src/main/core/directorManualOps'
import { ImageGenerateCancelled } from '../../src/main/core/imageService'

/**
 * 手动操作单测（directorManualOps，agent 注入版）：
 * 重建首帧、重出定妆、重出场景全景的成败分支与取消传播。
 */
const tmpDirs: string[] = []
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-manual-'))
  tmpDirs.push(dir)
  return dir
}

function makeProject(over: Record<string, any> = {}): any {
  return {
    id: 'p1',
    title: '测试剧',
    genre: '都市',
    characters: [{ id: 'c1', name: '林夏', appearanceLock: 'chinese, red dress' }],
    shots: [],
    sceneBoards: [],
    ...over
  }
}

function makeAgent(project: any, opts: Record<string, any> = {}): any {
  return {
    baseDir: opts.baseDir || '/tmp/nowhere',
    states: opts.states || new Map(),
    gates: new Map(),
    healBudget: new Map(),
    cancelled: opts.cancelled || new Set<string>(),
    lastStageMsg: new Map(),
    logSeq: new Map(),
    shadowSettledShots: new Map(),
    shadowRenders: new Set<string>(),
    emit: vi.fn(),
    store: {
      get: vi.fn(async () => project),
      save: vi.fn(async () => undefined),
      update: vi.fn(async (_id: string, fn: (p: any) => void) => { fn(project) })
    },
    settings: { get: vi.fn(async () => opts.settings || {}) },
    image: { generate: opts.generate || vi.fn(async () => undefined) },
    ffmpeg: {
      cropPanoramaViews: opts.cropPanoramaViews || vi.fn(async () => [
        'a.png', 'b.png', 'c.png', 'd.png'
      ]),
      tileImages: opts.tileImages || vi.fn(async () => undefined)
    },
    generateShotFirstFrame: opts.generateShotFirstFrame || vi.fn(async () => undefined)
  }
}

describe('rebuildShotFirstFramesImpl', () => {
  it('没有 i2v 目标镜时返回提示文本', async () => {
    const project = makeProject({
      shots: [{ id: 's1', index: 1, type: 't2v', characterIds: [] }]
    })
    const agent = makeAgent(project)

    const r = await rebuildShotFirstFramesImpl(agent, 'p1', [1])

    expect(r.ok).toBe(false)
    expect(r.text).toContain('未找到可重建首帧的 i2v 镜头')
    expect(agent.generateShotFirstFrame).not.toHaveBeenCalled()
  })

  it('逐镜重建首帧：成功镜复位待重渲，失败镜汇总不影响其余', async () => {
    const project = makeProject({
      shots: [
        { id: 's1', index: 1, type: 'i2v', characterIds: ['c1'], status: 'done', segmentPath: 'seg1.mp4', reviewed: true },
        { id: 's2', index: 2, type: 'i2v', characterIds: ['c1'], status: 'done', segmentPath: 'seg2.mp4' }
      ]
    })
    let call = 0
    const generateShotFirstFrame = vi.fn(async (_pid: string, d: any) => {
      call++
      if (call === 1) d.firstFramePath = 'projects/p1/frames/1.png'
      else throw new Error('首帧生成失败')
    })
    const agent = makeAgent(project, { generateShotFirstFrame })

    const r = await rebuildShotFirstFramesImpl(agent, 'p1', [1, 2])

    expect(r.ok).toBe(false)
    expect(r.text).toContain('成功 1/2')
    expect(r.text).toContain('镜2')
    const s1 = project.shots[0]
    expect(s1.firstFramePath).toBe('projects/p1/frames/1.png')
    expect(s1.status).toBe('pending')
    expect(s1.segmentPath).toBe('')
    expect(s1.reviewed).toBeUndefined()
    expect(project.shots[1].firstFramePath).toBeUndefined()
    expect(agent.store.save).toHaveBeenCalledTimes(1)
    expect(agent.emit).toHaveBeenCalledWith('projectUpdated', expect.anything())
  })

  it('已取消项目直接返回「已取消」且不落盘', async () => {
    const project = makeProject({
      shots: [{ id: 's1', index: 1, type: 'i2v', characterIds: ['c1'] }]
    })
    const agent = makeAgent(project, { cancelled: new Set(['p1']) })

    const r = await rebuildShotFirstFramesImpl(agent, 'p1', [1])

    expect(r).toEqual({ ok: false, text: '已取消' })
    expect(agent.generateShotFirstFrame).not.toHaveBeenCalled()
    expect(agent.store.save).not.toHaveBeenCalled()
  })
})

describe('rerunCastingImpl', () => {
  it('无角色时返回提示文本', async () => {
    const project = makeProject({ characters: [] })
    const agent = makeAgent(project)

    const r = await rerunCastingImpl(agent, 'p1')

    expect(r).toEqual({ ok: false, text: '项目暂无角色，无法重出定妆' })
  })

  it('成功重出定妆并通知刷新', async () => {
    const project = makeProject({
      characters: [{ id: 'c1', name: '林夏', appearanceLock: 'chinese, red dress', refImagePath: '' }]
    })
    const agent = makeAgent(project)

    const r = await rerunCastingImpl(agent, 'p1')

    expect(r.ok).toBe(true)
    const c = project.characters[0]
    expect(c.faceImagePath).toBe('projects/p1/characters/c1_face.png')
    expect(c.bodySheetPath).toBe('projects/p1/characters/c1_body.png')
    expect(c.refImagePath).toBe(c.faceImagePath)
    expect(agent.image.generate).toHaveBeenCalledTimes(2)
    expect(agent.store.save).toHaveBeenCalledTimes(1)
    expect(agent.emit).toHaveBeenCalledWith('projectUpdated', expect.anything())
  })

  it('失败时汇总面部与三视图错误并返回 ok=false', async () => {
    const project = makeProject({
      characters: [{ id: 'c1', name: '林夏', appearanceLock: 'chinese, red dress' }]
    })
    const agent = makeAgent(project, {
      generate: vi.fn(async () => { throw new Error('ComfyUI 超时') })
    })

    const r = await rerunCastingImpl(agent, 'p1')

    expect(r.ok).toBe(false)
    expect(r.text).toContain('「林夏」面部')
    expect(r.text).toContain('「林夏」三视图')
    expect(agent.store.save).toHaveBeenCalledTimes(1)
  })

  it('取消时 ImageGenerateCancelled 向上传播', async () => {
    const project = makeProject({
      characters: [{ id: 'c1', name: '林夏', appearanceLock: 'chinese, red dress' }]
    })
    const agent = makeAgent(project, {
      generate: vi.fn(async () => { throw new ImageGenerateCancelled() })
    })

    await expect(rerunCastingImpl(agent, 'p1')).rejects.toBeInstanceOf(ImageGenerateCancelled)
    expect(agent.store.save).not.toHaveBeenCalled()
  })
})

describe('regenerateScenePanoImpl', () => {
  it('场景板不存在时返回提示文本', async () => {
    const agent = makeAgent(makeProject({ sceneBoards: [] }))
    const r = await regenerateScenePanoImpl(agent, 'p1', 'missing')
    expect(r).toEqual({ ok: false, text: '场景板不存在' })
  })

  it('重出全景：回填方位图/宫格看板并同步 t2v 镜头场景图', async () => {
    const baseDir = await makeTmpDir()
    const project = makeProject({
      sceneBoards: [{ id: 'b1', name: '天台', description: 'rooftop at dusk' }],
      shots: [
        { id: 's1', index: 1, type: 't2v', sceneBoardId: 'b1', sceneImagePath: '' },
        { id: 's2', index: 2, type: 'i2v', sceneBoardId: 'b1', sceneImagePath: 'keep.png' }
      ]
    })
    const agent = makeAgent(project, { baseDir })

    const r = await regenerateScenePanoImpl(agent, 'p1', 'b1')

    expect(r.ok).toBe(true)
    expect(r.text).toContain('4 方位')
    const board = project.sceneBoards[0]
    expect(board.panoPath).toBe('projects/p1/scenes/b1_pano.png')
    expect(board.panoViews).toHaveLength(4)
    expect(board.panoGrid).toBe('projects/p1/scenes/b1_pano_grid.png')
    expect(board.emptyPlatePath).toBe(board.panoViews[0])
    expect(project.shots[0].sceneImagePath).toBe(board.panoViews[0])
    expect(project.shots[1].sceneImagePath).toBe('keep.png')
    expect(agent.ffmpeg.cropPanoramaViews).toHaveBeenCalledWith(
      path.join(baseDir, 'projects/p1/scenes/b1_pano.png'),
      path.join(baseDir, 'projects/p1/scenes'),
      expect.objectContaining({ count: 4, outW: 480, outH: 864, prefix: 'b1' })
    )
    expect(agent.emit).toHaveBeenCalledWith('projectUpdated', expect.anything())
  })

  it('宫格拼接失败只告警，仍保留方位图结果', async () => {
    const baseDir = await makeTmpDir()
    const project = makeProject({
      sceneBoards: [{ id: 'b1', name: '天台', description: 'rooftop' }],
      shots: []
    })
    const states = new Map([['p1', { stages: {}, logs: [] }]])
    const agent = makeAgent(project, {
      baseDir,
      states,
      tileImages: vi.fn(async () => { throw new Error('ffmpeg 失败') })
    })

    const r = await regenerateScenePanoImpl(agent, 'p1', 'b1')

    expect(r.ok).toBe(true)
    // 宫格路径在拼接前已赋值，失败时仅告警、不回填可用宫格文件属既有行为
    expect(project.sceneBoards[0].panoGrid).toBe('projects/p1/scenes/b1_pano_grid.png')
    expect(project.sceneBoards[0].panoViews).toHaveLength(4)
    const logs = (states.get('p1') as any).logs
    expect(logs.some((l: any) => l.level === 'warn' && l.message.includes('宫格看板拼接失败'))).toBe(true)
  })

  it('全景生成失败时返回失败文本', async () => {
    const baseDir = await makeTmpDir()
    const project = makeProject({
      sceneBoards: [{ id: 'b1', name: '天台', description: 'rooftop' }]
    })
    const agent = makeAgent(project, {
      baseDir,
      generate: vi.fn(async () => { throw new Error('T2I 不可用') })
    })

    const r = await regenerateScenePanoImpl(agent, 'p1', 'b1')

    expect(r.ok).toBe(false)
    expect(r.text).toContain('全景重出失败')
    expect(agent.ffmpeg.cropPanoramaViews).not.toHaveBeenCalled()
  })
})
