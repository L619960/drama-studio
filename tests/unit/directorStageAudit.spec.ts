import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { concatDoneShots, renderShotsWithAudit, approveShots } from '../../src/main/core/directorStageAudit'
import type { Shot } from '../../src/shared/ipcTypes'

const tmpDirs: string[] = []
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-audit-'))
  tmpDirs.push(dir)
  return dir
}

/**
 * 阶段审核（rt 注入版）单测（directorStageAudit 首个 spec）：
 * 可拼接镜头过滤与参数映射、提示式逐镜审核、多角色混淆判别、
 * 审批全通过快路径。
 */
function makeRt(over: Record<string, any> = {}) {
  const rt: any = {
    baseDir: '/tmp/drama-audit',
    store: { get: vi.fn(), save: vi.fn(async () => undefined) },
    settings: { get: vi.fn(async () => ({ render: { consistencyMode: 'warn' } })) },
    skills: { auditChecklist: vi.fn(async () => []) },
    ffmpeg: {
      smartConcatSegments: vi.fn(async () => undefined),
      fileExists: vi.fn(async () => true),
      getVideoInfo: vi.fn(async () => ({ durationSec: 5, hasAudio: true })),
      looksLikeBlankVideo: vi.fn(async () => false),
      getDuration: vi.fn(async () => 3),
    },
    queue: {
      start: vi.fn(async () => undefined),
      waitForFinish: vi.fn(async () => undefined),
      checkShotRoleConfusion: vi.fn(async () => undefined),
    },
    isCancelled: vi.fn(() => false),
    subscribeRenderProgress: vi.fn(),
    unsubscribeRenderProgress: vi.fn(),
    notifyProjectUpdated: vi.fn(),
    log: vi.fn(),
    setStage: vi.fn(),
    ...over,
  }
  return rt
}

function shot(over: Record<string, any> = {}): Shot {
  return {
    id: 's1',
    index: 1,
    scene: '天台',
    status: 'done',
    segmentPath: 'projects/p1/shots/s1.mp4',
    dialogue: '走吧',
    transition: 'hard',
    trimStart: 0.5,
    trimEnd: 1,
    frames: 81,
    type: 't2v',
    ...over,
  } as Shot
}

describe('concatDoneShots', () => {
  it('没有可拼接镜头时报错', async () => {
    const rt = makeRt()
    await expect(concatDoneShots(rt, 'p1', [], 'projects/p1/final.mp4')).rejects.toThrow('没有可拼接镜头')
    expect(rt.ffmpeg.smartConcatSegments).not.toHaveBeenCalled()
  })

  it('跳过无分段/未完成镜头，按 baseDir 拼绝对路径并透传剪辑参数', async () => {
    const rt = makeRt()
    const shots = [shot(), shot({ id: 's2', status: 'pending', segmentPath: '' }), shot({ id: 's3', skipped: true })]
    await concatDoneShots(rt, 'p1', shots as never, 'projects/p1/final.mp4')

    const [segs, out] = rt.ffmpeg.smartConcatSegments.mock.calls[0]
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({
      path: path.join(rt.baseDir, 'projects/p1/shots/s1.mp4'),
      scene: '天台',
      hasDialogue: true,
      transition: 'hard',
      trimStart: 0.5,
      trimEnd: 1,
    })
    expect(out).toBe(path.join(rt.baseDir, 'projects/p1/final.mp4'))
  })
})

describe('renderShotsWithAudit', () => {
  it('取消时不再启动队列任务，仍退订进度', async () => {
    const rt = makeRt()
    rt.isCancelled.mockReturnValue(true)
    rt.store.get.mockResolvedValue({ shots: [{ id: 's1', status: 'pending' }] })

    await renderShotsWithAudit(rt, 'p1', new Map())

    expect(rt.queue.start).not.toHaveBeenCalled()
    expect(rt.unsubscribeRenderProgress).toHaveBeenCalledWith('p1')
  })

  it('成功镜留痕并写回时长，失败镜跳过', async () => {
    const baseDir = await makeTmpDir()
    await fs.writeFile(path.join(baseDir, 'a.mp4'), 'video')
    const rt = makeRt({ baseDir })
    rt.store.get
      .mockResolvedValueOnce({
        shots: [{ id: 's1', index: 1, scene: '天台', status: 'pending', segmentPath: 'a.mp4', action: '' }],
      })
      .mockResolvedValueOnce({
        shots: [{ id: 's1', index: 1, scene: '天台', status: 'done', segmentPath: 'a.mp4', action: '' }],
      })
    const durations = new Map<string, number>()

    await renderShotsWithAudit(rt, 'p1', durations)

    expect(rt.queue.start).toHaveBeenCalledWith('p1', ['s1'])
    expect(durations.get('s1')).toBe(3)
    expect(rt.store.save).toHaveBeenCalled()
    expect(rt.notifyProjectUpdated).toHaveBeenCalledWith('p1')
    expect(rt.log).toHaveBeenCalledWith('p1', 'render', 'info', expect.stringContaining('第1镜'))
    expect(rt.unsubscribeRenderProgress).toHaveBeenCalledWith('p1')
  })
})

describe('approveShots', () => {
  it('全部通过：不触发重渲，返回时长', async () => {
    const rt = makeRt()
    rt.store.get.mockResolvedValue({ shots: [shot()], characters: [] })

    const r = await approveShots(rt, 'p1')

    expect(r.approved).toBe(true)
    expect(r.durations.get('s1')).toBe(5)
    expect(rt.queue.start).not.toHaveBeenCalled()
  })

  it('多角色 i2v 混淆判别命中：作为问题拦下并重渲一轮', async () => {
    const rt = makeRt()
    const project = {
      characters: [
        { id: 'c1', name: '林夏' },
        { id: 'c2', name: '林川' },
      ],
      shots: [shot({ type: 'i2v', characterIds: ['c1'], seed: 1 })],
    }
    rt.store.get.mockResolvedValue(project)
    rt.queue.checkShotRoleConfusion.mockResolvedValue({
      confused: true,
      withName: '林川',
      bestOther: 0.9,
      selfScore: 0.2,
    })

    const r = await approveShots(rt, 'p1')

    expect(r.approved).toBe(false)
    expect(r.retryIds).toEqual(['s1'])
    expect(r.problems.join('；')).toContain('应出现「林夏」')
    expect(typeof project.shots[0]?.seed).toBe('number')
    expect(rt.queue.start).toHaveBeenCalledWith('p1', ['s1'])
  })
})
