/* eslint-disable @typescript-eslint/no-explicit-any -- 测试以最小 mock 对象替代真实服务依赖 */
import { describe, it, expect, vi } from 'vitest'
import {
  rebuildShotFirstFrames,
  regenerateScenePano,
  generateShotFirstFrame
} from '../../src/main/core/directorStageShots'
import type { DirectorStageRuntime } from '../../src/main/core/directorStageAssets'

/**
 * 分镜首帧维护入口单测（directorStageShots 首个 spec）：
 * 重渲前重建首帧的镜头筛选/审核作废/取消，以及场景板「重出全景」的写回与失败兜底。
 */
function makeRt(project: Record<string, any>) {
  const rt: any = {
    baseDir: '/tmp/drama-base',
    store: {
      get: vi.fn(async () => project),
      save: vi.fn(async () => undefined),
      update: vi.fn(async (_pid: string, fn: (p: Record<string, any>) => void) => {
        fn(project)
        return project
      })
    },
    settings: { get: vi.fn(async () => ({})) },
    image: { generate: vi.fn(async () => undefined) },
    ffmpeg: {
      cropPanoramaViews: vi.fn(async () => ['/tmp/pano/b1_v0.png', '/tmp/pano/b1_v1.png', '/tmp/pano/b1_v2.png', '/tmp/pano/b1_v3.png']),
      tileImages: vi.fn(async () => undefined)
    },
    isCancelled: vi.fn(() => false),
    log: vi.fn(),
    setStage: vi.fn(),
    finish: vi.fn(),
    maybeGate: vi.fn(async () => undefined),
    pauseUntilShotsReviewed: vi.fn(async () => true),
    subscribeRenderProgress: vi.fn(),
    unsubscribeRenderProgress: vi.fn(),
    ensureShadowState: vi.fn(() => ({ stages: {} })),
    emitProgressEvent: vi.fn(),
    notifyProjectUpdated: vi.fn()
  }
  return rt as DirectorStageRuntime & typeof rt
}

function shotProject() {
  return {
    id: 'p1',
    title: 't',
    characters: [],
    sceneBoards: [],
    shots: [
      {
        id: 'shot_a', index: 1, scene: '天台', action: '回头', type: 'i2v',
        characterIds: [], firstFramePath: 'projects/p1/shots/old_first.png',
        reviewed: true, status: 'done', segmentPath: 'projects/p1/shots/old.mp4'
      },
      { id: 'shot_b', index: 2, scene: '车内', action: '', type: 't2v', characterIds: [] }
    ]
  }
}

describe('rebuildShotFirstFrames', () => {
  it('没有匹配的 i2v 镜头时直接返回失败，不调用生图', async () => {
    const rt = makeRt(shotProject())
    const r = await rebuildShotFirstFrames(rt, 'p1', [2])
    expect(r.ok).toBe(false)
    expect(r.text).toContain('未找到可重建首帧的 i2v 镜头')
    expect(rt.image.generate).not.toHaveBeenCalled()
  })

  it('重建成功：写回首帧、作废审核、重置渲染状态并落盘', async () => {
    const project = shotProject()
    const rt = makeRt(project)
    const r = await rebuildShotFirstFrames(rt, 'p1', [1])
    expect(r.ok).toBe(true)
    expect(r.text).toContain('1/1')
    const shot = project.shots[0]
    expect(shot.firstFramePath).toBe('projects/p1/shots/shot_a_first.png')
    expect(shot.reviewed).toBeUndefined()
    expect(shot.status).toBe('pending')
    expect(shot.segmentPath).toBe('')
    expect(shot.intentReset).toBe(true)
    expect(rt.store.save).toHaveBeenCalledTimes(1)
    expect(rt.notifyProjectUpdated).toHaveBeenCalledWith('p1')
    expect(rt.image.generate).toHaveBeenCalledTimes(1)
  })

  it('生图全部失败（无定妆可复制）：不改写镜头，成功计数为 0', async () => {
    const project = shotProject()
    const rt = makeRt(project)
    // 三级链路（定妆融合/双图/文生）全部失败且无定妆图 → firstFramePath 不写入
    rt.image.generate.mockRejectedValueOnce(new Error('ComfyUI 离线'))
    const r = await rebuildShotFirstFrames(rt, 'p1', [1])
    expect(r.text).toContain('0/1')
    expect(project.shots[0].firstFramePath).toBe('projects/p1/shots/old_first.png')
    expect(project.shots[0].status).toBe('done')
    expect(project.shots[0].reviewed).toBe(true)
  })

  it('取消立即停止：返回「已取消」且不落盘', async () => {
    const rt = makeRt(shotProject())
    rt.isCancelled.mockReturnValue(true)
    const r = await rebuildShotFirstFrames(rt, 'p1', [1])
    expect(r.ok).toBe(false)
    expect(r.text).toBe('已取消')
    expect(rt.store.save).not.toHaveBeenCalled()
  })
})

describe('generateShotFirstFrame', () => {
  it('无人物定妆时走文生并写回首帧路径', async () => {
    const rt = makeRt(shotProject())
    const d = {
      id: 'shot_x', index: 3, characterIds: [],
      as: { type: 'i2v' as const, scene: '天台', action: '回头' }
    }
    await generateShotFirstFrame(rt, 'p1', d as never, { frameWidth: 576, frameHeight: 1024 }, () => false)
    expect(d).toMatchObject({ firstFramePath: 'projects/p1/shots/shot_x_first.png' })
    expect(rt.image.generate).toHaveBeenCalledTimes(1)
    const [prompt, out, opts] = rt.image.generate.mock.calls[0]
    expect(prompt).toContain('回头')
    expect(out).toContain('shot_x_first.png')
    expect(opts).toMatchObject({ width: 576, height: 1024, workflowName: 'klein_t2i_clean' })
  })

  it('图生图取消异常原样抛出，不降级为文生', async () => {
    const { ImageGenerateCancelled } = await import('../../src/main/core/imageService')
    const rt = makeRt(shotProject())
    rt.image.generate.mockRejectedValueOnce(new ImageGenerateCancelled())
    const d = {
      id: 'shot_y', index: 4, characterIds: ['c1'],
      character: { id: 'c1', name: '林夏', faceImagePath: 'projects/p1/cast/c1.png' },
      as: { type: 'i2v' as const, scene: '天台', action: '回头' }
    }
    await expect(generateShotFirstFrame(rt, 'p1', d as never, { frameWidth: 576, frameHeight: 1024 }, () => false))
      .rejects.toBeInstanceOf(ImageGenerateCancelled)
    expect(rt.image.generate).toHaveBeenCalledTimes(1)
  })
})

describe('regenerateScenePano', () => {
  function panoProject() {
    return {
      id: 'p1', title: 't', characters: [],
      sceneBoards: [{ id: 'b1', key: 'rooftop', name: '天台', description: 'rooftop', emptyPlatePath: 'old.png' }],
      shots: [
        { id: 's1', sceneBoardId: 'b1', type: 't2v', sceneImagePath: 'old.png' },
        { id: 's2', sceneBoardId: 'b1', type: 'i2v', sceneImagePath: 'keep.png' },
        { id: 's3', sceneBoardId: 'b2', type: 't2v', sceneImagePath: 'other.png' }
      ]
    }
  }

  it('场景板不存在时返回失败', async () => {
    const rt = makeRt(panoProject())
    const r = await regenerateScenePano(rt, 'p1', 'missing')
    expect(r.ok).toBe(false)
    expect(r.text).toContain('场景板不存在')
  })

  it('重出全景：更新方位图/看板并只同步同板 t2v 的参考图', async () => {
    const project = panoProject()
    const rt = makeRt(project)
    const r = await regenerateScenePano(rt, 'p1', 'b1')
    expect(r.ok).toBe(true)
    expect(r.text).toContain('4 方位')
    const board = project.sceneBoards[0] as Record<string, any>
    expect(board.panoViews).toHaveLength(4)
    expect(board.panoViews[0]).toBe('projects/p1/scenes/b1_v0.png')
    expect(board.emptyPlatePath).toBe('projects/p1/scenes/b1_v0.png')
    expect(board.panoGrid).toBe('projects/p1/scenes/b1_pano_grid.png')
    expect(project.shots[0].sceneImagePath).toBe('projects/p1/scenes/b1_v0.png')
    // i2v 与其他场景板不动
    expect(project.shots[1].sceneImagePath).toBe('keep.png')
    expect(project.shots[2].sceneImagePath).toBe('other.png')
    expect(rt.ffmpeg.tileImages).toHaveBeenCalledTimes(1)
    expect(rt.notifyProjectUpdated).toHaveBeenCalledWith('p1')
  })

  it('宫格看板拼接失败不阻断，仍写回方位图', async () => {
    const project = panoProject()
    const rt = makeRt(project)
    rt.ffmpeg.tileImages.mockRejectedValueOnce(new Error('ffmpeg 失败'))
    const r = await regenerateScenePano(rt, 'p1', 'b1')
    expect(r.ok).toBe(true)
    const board = project.sceneBoards[0] as Record<string, any>
    expect(board.panoViews).toHaveLength(4)
    // 实现会先记录 gridRel 再拼图，失败时路径仍写入但内容缺失（仅告警不阻断）
    expect(board.panoGrid).toBe('projects/p1/scenes/b1_pano_grid.png')
    expect(rt.log).toHaveBeenCalledWith('p1', 'scenes', 'warn', expect.stringContaining('宫格看板拼接失败'))
  })
})
