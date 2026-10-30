/**
 * TaskQueue 补充分支单测（不起 ComfyUI、不发网络）：
 * - start/process：显式 shotIds、复合键去重、pendingFinishNotify 补发、取消项目残留任务跳过、排空后补消费
 * - cancel：镜头级排队移除 / 在渲中断等待、项目级在渲等待、补发 queue-finished 与状态重算（含 get 抛错）
 * - cancelAll 多项目、waitForFinish（idle/事件过滤/超时）
 * - renderShot：磁盘预检硬停/偏低提示、渲染失败回写 failed、取消回写 pending、manualTier 命中/回退探测
 * - recoverStaleRenders：产物在盘恢复 done、孤儿 tmp 清理、store.list 抛错
 * - quickRender：参数校验/全量占位符注入/自检失败/产物缺失/扩展名推断/下载分支
 * 既有覆盖（不重复）：taskQueueSchedule.spec（空目标 start、空转 cancel/cancelAll）、
 * taskQueue.quickRender.spec（WIDTH2/HEIGHT2）、taskQueueRetry/Scheduler/Shared/Refs/Render.spec（拆分模块）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { TaskQueue } from '../../src/main/core/taskQueue'
import { VRAM_TIERS } from '../../src/main/core/comfyuiClient'
import type { Project, Shot, ProgressEvent } from '../../src/shared/ipcTypes'

// statfs 注入：仅覆盖磁盘预检分支，其余 fs/promises 保持真实
const statfsCtl = vi.hoisted(() => ({
  impl: null as null | ((p: string) => Promise<{ bavail: number; bsize: number }>)
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await (importOriginal as () => Promise<Record<string, unknown>>)()
  return {
    ...actual,
    statfs: (...args: unknown[]) =>
      statfsCtl.impl
        ? statfsCtl.impl(args[0] as string)
        : (actual.statfs as (...a: unknown[]) => Promise<unknown>)(...args)
  }
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type Priv = {
  queue: Array<{ projectId: string; shotId: string }>
  cancelledProjects: Set<string>
  cancelledShotIds: Set<string>
  touchedProjects: Set<string>
  pendingFinishNotify: Set<string>
  current: { projectId: string; shotId: string } | null
  process(): Promise<void>
}
const priv = (q: TaskQueue) => q as unknown as Priv

function makeShot(id: string, over: Partial<Shot> = {}): Shot {
  return {
    id, index: 1, type: 'i2v', status: 'pending',
    scene: '街景', action: '站立微动', dialogue: '', emotion: 'calm',
    camera: '中景', frames: 49, characterIds: ['c1'],
    firstFramePath: `projects/p1/first_${id}.png`,
    workflow: 'wan22_i2v',
    ...over
  } as unknown as Shot
}
function makeProject(id: string, shots: Shot[], over: Partial<Project> = {}): Project {
  return {
    id, title: 't', genre: '都市', status: 'draft',
    characters: [], scenes: [], sceneBoards: [], shots,
    ...over
  } as unknown as Project
}

interface Cfg {
  projects?: Map<string, Project>
  getDelayFirstMs?: number
  getThrows?: boolean
  listThrows?: boolean
}

function makeStore(cfg: Cfg = {}) {
  const projects = cfg.projects ?? new Map()
  const saves: Project[] = []
  const getCalls: string[] = []
  let first = true
  return {
    saves, getCalls, projects,
    get: async (id: string) => {
      getCalls.push(id)
      if (cfg.getThrows) throw new Error('store down')
      const p = projects.get(id)
      if (!p) throw new Error(`no project ${id}`)
      if (first && cfg.getDelayFirstMs) { first = false; await sleep(cfg.getDelayFirstMs) }
      return p
    },
    update: async (id: string, cb: (p: Project) => void) => {
      const p = projects.get(id)
      if (!p) throw new Error(`no project ${id}`)
      cb(p)
    },
    save: async (p: Project) => { saves.push(p) },
    list: async () => {
      if (cfg.listThrows) throw new Error('list down')
      return [...projects.values()]
    }
  }
}

function makeComfy(over: Record<string, unknown> = {}) {
  const calls: string[] = []
  return {
    calls,
    comfy: {
      interrupt: async () => { calls.push('interrupt') },
      rejectPending: () => { calls.push('rejectPending') },
      clearQueue: async () => { calls.push('clearQueue') },
      getVramTier: async () => VRAM_TIERS.mid,
      ...over
    } as never
  }
}

/** workflow.list 延迟后抛错：让 renderShot 在 prepareShotAudio 之后快速失败（覆盖 failed/cancelled 回写） */
function makeFailWorkflow(listDelayMs = 0) {
  return {
    list: async () => {
      if (listDelayMs) await sleep(listDelayMs)
      throw new Error('wf-list-fail')
    },
    buildGraph: async () => ({})
  } as never
}

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'drama-tq-'))
}

function harness(opts: {
  dir: string
  store: ReturnType<typeof makeStore>
  comfy?: Record<string, unknown>
  workflow?: unknown
  settings?: Record<string, unknown>
} = { dir: '', store: makeStore() }) {
  const { calls, comfy } = makeComfy(opts.comfy)
  const q = new TaskQueue(
    opts.dir,
    comfy,
    (opts.workflow ?? makeFailWorkflow()) as never,
    {} as never,
    { ready: async () => undefined } as never,
    opts.store as never,
    { get: async () => opts.settings ?? { render: { resolutionTier: 'auto' } } } as never
  )
  const finished: string[] = []
  const progress: ProgressEvent[] = []
  q.on('queue-finished', (e: { projectId: string }) => finished.push(e.projectId))
  q.on('progress', (e: ProgressEvent) => progress.push(e))
  return { q, calls, finished, progress }
}

afterEach(() => { statfsCtl.impl = null })

describe('start / process', () => {
  it('显式 shotIds 入队：全部置 pending、项目转 rendering、清项目取消标记；渲染失败逐个回写 failed', async () => {
    const dir = await makeTmpDir()
    const shots = [makeShot('s1'), makeShot('s2', { status: 'failed' }), makeShot('s3', { status: 'done' })]
    const store = makeStore({ projects: new Map([['p1', makeProject('p1', shots)]]) })
    const { q, finished, progress } = harness({ dir, store })
    priv(q).cancelledProjects.add('p1')
    await q.start('p1', ['s1', 's2', 's3'])
    await new Promise<void>(res => q.once('queue-finished', () => res()))
    expect(priv(q).cancelledProjects.has('p1')).toBe(false)
    expect(shots.map(s => s.status)).toEqual(['failed', 'failed', 'failed'])
    expect(progress.filter(e => e.step === 'failed')).toHaveLength(3)
    expect(finished).toEqual(['p1'])
    // finally 收尾：有 failed → 项目重算为 failed 并落盘
    expect(store.saves).toHaveLength(1)
    expect(store.saves[0].status).toBe('failed')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('运行中重复 start：复合键去重不入队；pendingFinishNotify 已触达项目跳过补发、未触达项目补发', async () => {
    const dir = await makeTmpDir()
    const shots = [makeShot('s1'), makeShot('s2')]
    const p1 = makeProject('p1', shots)
    const p2 = makeProject('p2', [])
    const store = makeStore({ projects: new Map([['p1', p1], ['p2', p2]]), getDelayFirstMs: 150 })
    const { q, finished } = harness({ dir, store })
    await q.start('p1')
    await q.start('p1', ['s2'])   // s2 仍在队列 → 去重；running → pendingNotify p1
    await q.start('p2')           // 无目标；running → pendingNotify p2
    await sleep(600)
    expect(finished).toEqual(['p1', 'p2'])   // p1 只发一次（skip 分支），p2 补发
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('renderShot 找不到镜头 → 直接返回，不报错不写进度', async () => {
    const dir = await makeTmpDir()
    const shots = [makeShot('s1')]
    const store = makeStore({ projects: new Map([['p1', makeProject('p1', shots)]]), getDelayFirstMs: 120 })
    const { q, finished, progress } = harness({ dir, store })
    await q.start('p1')
    shots.length = 0   // 渲染取快照前移除镜头 → !shot 早退
    await new Promise<void>(res => q.once('queue-finished', () => res()))
    expect(progress.filter(e => e.step === 'failed')).toHaveLength(0)
    expect(finished).toEqual(['p1'])
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('process 跳过已取消项目的残留排队任务（不进入 renderShot）', async () => {
    const dir = await makeTmpDir()
    const store = makeStore({ projects: new Map() })
    const { q } = harness({ dir, store })
    priv(q).cancelledProjects.add('px')
    priv(q).queue.push({ projectId: 'px', shotId: 'sx' })
    await priv(q).process()
    expect(priv(q).queue).toHaveLength(0)
    expect(store.getCalls.filter(c => c === 'px')).toHaveLength(0)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('排空收尾后队列又有新任务 → 自动补一轮消费', async () => {
    const dir = await makeTmpDir()
    const p1 = makeProject('p1', [makeShot('s1')])
    const p2 = makeProject('p2', [])
    const store = makeStore({ projects: new Map([['p1', p1], ['p2', p2]]), getDelayFirstMs: 150 })
    const { q, finished } = harness({ dir, store })
    await q.start('p1')
    setTimeout(() => priv(q).queue.push({ projectId: 'p2', shotId: 'z' }), 80)
    await sleep(700)
    expect(finished).toEqual(['p1', 'p2'])
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('cancel / cancelAll', () => {
  it('cancel(shotId)：仅移除排队中的该镜头，不打断其他在渲镜头', async () => {
    const dir = await makeTmpDir()
    const store = makeStore({
      projects: new Map([['p1', makeProject('p1', [makeShot('s1'), makeShot('s2')])]]),
      getDelayFirstMs: 150
    })
    const { q, calls } = harness({ dir, store })
    await q.start('p1')
    await q.cancel('p1', 's2')
    expect(priv(q).queue).toHaveLength(0)
    expect(calls).not.toContain('interrupt')
    await sleep(400)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('cancel(shotId) 命中在渲镜头：中断 ComfyUI + 等待结束 + 清除镜头取消键', async () => {
    const dir = await makeTmpDir()
    const store = makeStore({
      projects: new Map([['p1', makeProject('p1', [makeShot('s1')])]]),
      getDelayFirstMs: 250
    })
    const { q, calls, finished } = harness({ dir, store })
    await q.start('p1')
    await q.cancel('p1', 's1')
    expect(calls).toContain('interrupt')
    expect(calls).toContain('rejectPending')
    expect(priv(q).cancelledShotIds.size).toBe(0)
    expect(finished).toEqual(['p1'])
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('cancel(projectId) 命中在渲项目：中断并等待本项目镜头结束，事件由 process 收尾（不重复补发）', async () => {
    const dir = await makeTmpDir()
    const p1 = makeProject('p1', [makeShot('s1')])
    const p2 = makeProject('p2', [makeShot('z1')])
    const store = makeStore({ projects: new Map([['p1', p1], ['p2', p2]]), getDelayFirstMs: 100 })
    const { q, calls, finished } = harness({ dir, store, workflow: makeFailWorkflow(300) })
    await q.start('p1')
    priv(q).queue.push({ projectId: 'p2', shotId: 'z1' })   // 取消等待期间队列继续消费其他项目
    await sleep(50)
    await q.cancel('p1')
    expect(calls).toContain('interrupt')
    expect(priv(q).cancelledProjects.has('p1')).toBe(true)
    await sleep(900)
    expect(finished).toEqual(['p1', 'p2'])
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('cancel 补发：未触达项目 rendering → 重算状态落盘 + queue-finished', async () => {
    const dir = await makeTmpDir()
    const p1 = makeProject('p1', [makeShot('s1', { status: 'failed' })], { status: 'rendering' })
    const store = makeStore({ projects: new Map([['p1', p1]]) })
    const { q, finished } = harness({ dir, store })
    await q.cancel('p1')
    await sleep(30)
    expect(p1.status).toBe('failed')
    expect(store.saves).toHaveLength(1)
    expect(finished).toEqual(['p1'])
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('cancel 补发：状态重算抛错（项目已删）仍发 queue-finished', async () => {
    const dir = await makeTmpDir()
    const store = makeStore({ projects: new Map() })
    const { q, finished } = harness({ dir, store })
    await q.cancel('gone')
    await sleep(30)
    expect(finished).toEqual(['gone'])
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('cancel 补发：项目非 rendering 状态不触发落盘', async () => {
    const dir = await makeTmpDir()
    const p1 = makeProject('p1', [], { status: 'draft' })
    const store = makeStore({ projects: new Map([['p1', p1]]) })
    const { q, finished } = harness({ dir, store })
    await q.cancel('p1')
    await sleep(30)
    expect(store.saves).toHaveLength(0)
    expect(finished).toEqual(['p1'])
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('cancelAll：逐个取消排队项目并补发完成事件', async () => {
    const dir = await makeTmpDir()
    const store = makeStore({
      projects: new Map([['p1', makeProject('p1', [])], ['p2', makeProject('p2', [])]])
    })
    const { q, finished } = harness({ dir, store })
    priv(q).queue.push({ projectId: 'p1', shotId: 'a' }, { projectId: 'p2', shotId: 'b' })
    await q.cancelAll()
    await sleep(30)
    expect(priv(q).queue).toHaveLength(0)
    expect(priv(q).cancelledProjects.has('p1')).toBe(true)
    expect(priv(q).cancelledProjects.has('p2')).toBe(true)
    expect(finished.sort()).toEqual(['p1', 'p2'])
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('waitForFinish', () => {
  it('队列空闲 → 立即解析', async () => {
    const dir = await makeTmpDir()
    const { q } = harness({ dir, store: makeStore() })
    await expect(q.waitForFinish('p1')).resolves.toBeUndefined()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('非空闲：其他项目事件被忽略，本项目事件解析', async () => {
    const dir = await makeTmpDir()
    const { q } = harness({ dir, store: makeStore() })
    priv(q).queue.push({ projectId: 'p1', shotId: 'a' })
    let done = false
    const p = q.waitForFinish('p1', 5000).then(() => { done = true })
    await sleep(20)
    q.emit('queue-finished', { projectId: 'other' })
    await sleep(20)
    expect(done).toBe(false)
    q.emit('queue-finished', { projectId: 'p1' })
    await p
    expect(done).toBe(true)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('超时 → reject 带超时秒数', async () => {
    const dir = await makeTmpDir()
    const { q } = harness({ dir, store: makeStore() })
    priv(q).queue.push({ projectId: 'p1', shotId: 'a' })
    await expect(q.waitForFinish('p1', 30)).rejects.toThrow(/超时/)
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('renderShot 磁盘预检 / 状态回写 / 档位选择', () => {
  it('磁盘余量 <0.5GB → 硬停：renderShot 抛错由 process 兜住，镜头不回写 failed', async () => {
    const dir = await makeTmpDir()
    statfsCtl.impl = async () => ({ bavail: 100, bsize: 1024 })
    const shots = [makeShot('s1')]
    const store = makeStore({ projects: new Map([['p1', makeProject('p1', shots)]]) })
    const { q, finished, progress } = harness({ dir, store })
    await q.start('p1')
    await new Promise<void>(res => q.once('queue-finished', () => res()))
    expect(shots[0].status).toBe('rendering')   // 预检在 try 外抛错，未走到 failed 回写
    expect(progress.filter(e => e.step === 'failed')).toHaveLength(0)
    expect(finished).toEqual(['p1'])
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('磁盘余量 <1.5GB → 偏低提示后继续；渲染失败回写 failed + 进度', async () => {
    const dir = await makeTmpDir()
    statfsCtl.impl = async () => ({ bavail: 1, bsize: 2 ** 30 })
    const shots = [makeShot('s1')]
    const store = makeStore({ projects: new Map([['p1', makeProject('p1', shots)]]) })
    const { q, finished, progress } = harness({ dir, store })
    await q.start('p1')
    await new Promise<void>(res => q.once('queue-finished', () => res()))
    expect(progress.some(e => (e.message || '').includes('磁盘余量') && (e.message || '').includes('偏低'))).toBe(true)
    expect(shots[0].status).toBe('failed')
    expect(shots[0].error).toBe('wf-list-fail')
    expect(finished).toEqual(['p1'])
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('渲染期间项目取消 → 镜头回写 pending + 已取消提示', async () => {
    const dir = await makeTmpDir()
    const shots = [makeShot('s1')]
    const store = makeStore({ projects: new Map([['p1', makeProject('p1', shots)]]) })
    const { q, calls, progress } = harness({ dir, store, workflow: makeFailWorkflow(300) })
    await q.start('p1')
    await sleep(80)
    await q.cancel('p1')
    expect(calls).toContain('interrupt')
    expect(shots[0].status).toBe('pending')
    expect(shots[0].error).toBeUndefined()
    expect(progress.some(e => e.message === '已取消')).toBe(true)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('manualTier 命中 VRAM_TIERS → 不做显存探测', async () => {
    const dir = await makeTmpDir()
    const shots = [makeShot('s1')]
    const store = makeStore({ projects: new Map([['p1', makeProject('p1', shots)]]) })
    let probe = 0
    const { q } = harness({
      dir, store,
      comfy: { getVramTier: async () => { probe++; return VRAM_TIERS.mid } },
      settings: { render: { resolutionTier: 'mid' } }
    })
    await q.start('p1')
    await new Promise<void>(res => q.once('queue-finished', () => res()))
    expect(probe).toBe(0)
    expect(shots[0].status).toBe('failed')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('manualTier 未知档位 → 回退显存探测', async () => {
    const dir = await makeTmpDir()
    const shots = [makeShot('s1')]
    const store = makeStore({ projects: new Map([['p1', makeProject('p1', shots)]]) })
    let probe = 0
    const { q } = harness({
      dir, store,
      comfy: { getVramTier: async () => { probe++; return VRAM_TIERS.low } },
      settings: { render: { resolutionTier: 'bogus-tier' } }
    })
    await q.start('p1')
    await new Promise<void>(res => q.once('queue-finished', () => res()))
    expect(probe).toBeGreaterThan(0)
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('recoverStaleRenders', () => {
  it('产物在盘恢复 done、无产物转 pending、孤儿临时文件清理、非在渲项目跳过', async () => {
    const dir = await makeTmpDir()
    // 孤儿 .tmp RGB 帧与 .part 中间产物
    await fs.mkdir(path.join(dir, '.tmp'), { recursive: true })
    const rgbFile = path.join(dir, '.tmp', 'rgb_orphan.rgb')
    await fs.writeFile(rgbFile, 'x')
    const segDir = path.join(dir, 'projects', 'pR', 'segments')
    await fs.mkdir(segDir, { recursive: true })
    await fs.writeFile(path.join(segDir, 's1.mp4'), 'video')       // s1 产物在盘
    const partFile = path.join(segDir, 's9.part.mp4')
    await fs.writeFile(partFile, 'half')                            // 崩溃残留
    const keepFile = path.join(segDir, 'keep.mp4')
    await fs.writeFile(keepFile, 'ok')
    // os.tmpdir 孤儿（随机后缀避免误伤他人）
    const rnd = Math.random().toString(36).slice(2, 8)
    const osOrphans = [
      path.join(os.tmpdir(), `concatfit_${rnd}`),
      path.join(os.tmpdir(), `smartconcat_${rnd}`),
      path.join(os.tmpdir(), `concat_${Math.floor(Math.random() * 1e6)}.txt`),
      path.join(os.tmpdir(), `ds_sub_${rnd}.ass`),
      path.join(os.tmpdir(), `qc_${Math.floor(Math.random() * 1e6)}_${rnd}.png`)
    ]
    await fs.mkdir(osOrphans[0], { recursive: true })
    await fs.mkdir(osOrphans[1], { recursive: true })
    for (const f of osOrphans.slice(2)) await fs.writeFile(f, 'x')

    const s1 = makeShot('s1', { status: 'rendering', segmentPath: 'projects/pR/segments/s1.mp4' })
    const s2 = makeShot('s2', { status: 'rendering', segmentPath: 'projects/pR/segments/gone.mp4' })
    const s3 = makeShot('s3', { status: 'rendering' })
    const e1 = makeShot('e1', { status: 'rendering' })
    const pR = makeProject('pR', [s1, s2, s3], { status: 'rendering' })
    const pD = makeProject('pD', [], { status: 'draft' })
    const pE = makeProject('pE', [e1], { status: 'draft' })
    const store = makeStore({ projects: new Map([['pR', pR], ['pD', pD], ['pE', pE]]) })
    const q2 = new TaskQueue(
      dir,
      { clearQueue: async () => { throw new Error('comfy down') }, interrupt: async () => { throw new Error('comfy down') } } as never,
      {} as never, {} as never, { ready: async () => undefined } as never,
      store as never, { get: async () => ({}) } as never
    )
    const recovered = await q2.recoverStaleRenders()
    expect(recovered).toBe(3)
    expect(s1.status).toBe('done')
    expect(s2.status).toBe('pending')
    expect((s2.error || '').includes('应用重启')).toBe(true)
    expect(s3.status).toBe('pending')
    expect(e1.status).toBe('pending')
    expect(pR.status).toBe('draft')     // 有 pending → 非 rendering
    expect(pE.status).toBe('draft')
    expect(store.saves.length).toBe(2)  // pR 与 pE 落盘，pD 跳过
    await expect(fs.stat(rgbFile)).rejects.toThrow()
    await expect(fs.stat(partFile)).rejects.toThrow()
    expect((await fs.stat(keepFile)).isFile()).toBe(true)
    for (const o of osOrphans) await expect(fs.stat(o)).rejects.toThrow()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('store.list 抛错 → 返回 0 不抛出', async () => {
    const dir = await makeTmpDir()
    const store = makeStore({ listThrows: true })
    const q = new TaskQueue(
      dir,
      { clearQueue: async () => undefined, interrupt: async () => undefined } as never,
      {} as never, {} as never, { ready: async () => undefined } as never,
      store as never, { get: async () => ({}) } as never
    )
    await expect(q.recoverStaleRenders()).resolves.toBe(0)
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('quickRender 剩余分支', () => {
  interface QStubOpts {
    meta?: { name: string; placeholders: string[]; hasDuration?: boolean } | null
    issues?: Array<{ message: string }>
    out?: unknown
    video?: unknown
  }
  function makeQuickHarness(o: QStubOpts, dir: string) {
    const captured: { vars?: Record<string, unknown>; graph?: unknown } = {}
    const uploads: string[] = []
    const downloads: Array<{ f: string; abs: string }> = []
    const fullDownloads: Array<{ fp: string; abs: string }> = []
    const workflow = {
      list: async () => (o.meta === null ? [] : [o.meta ?? { name: 't2v', placeholders: [] }]),
      buildGraph: async (_name: string, vars: Record<string, unknown>) => {
        captured.vars = vars
        return (captured.graph = {})
      },
      validateBuiltGraph: () => o.issues ?? []
    } as never
    const comfy = {
      uploadImage: async (p: string) => { uploads.push(p); return `up_${path.basename(p)}` },
      getObjectInfo: async () => ({}),
      submit: async () => ({ promptId: 'qp1' }),
      waitForCompletion: async (_pid: string, onProg?: (n: number) => void) => {
        onProg?.(50)
        return o.out ?? { images: [{ filename: 'clip.mp4', subfolder: '', type: 'output' }] }
      },
      findVideoOutput: (out: unknown) => (o.video === undefined
        ? ((out as { images?: unknown[] } | undefined)?.images?.[0] ?? null)
        : o.video),
      download: async (f: string, _s: string, _t: string, abs: string) => { downloads.push({ f, abs }) },
      downloadFromFullPath: async (fp: string, abs: string) => { fullDownloads.push({ fp, abs }) }
    } as never
    const q = new TaskQueue(
      dir, comfy, workflow, {} as never, { ready: async () => undefined } as never,
      makeStore() as never, { get: async () => ({}) } as never
    )
    return { q, captured, uploads, downloads, fullDownloads }
  }

  it('缺少 workflowName/prompt → 直接报错', async () => {
    const dir = await makeTmpDir()
    const { q } = makeQuickHarness({}, dir)
    await expect(q.quickRender({ workflowName: '', prompt: 'x' })).rejects.toThrow(/缺少/)
    await expect(q.quickRender({ workflowName: 't2v', prompt: '' })).rejects.toThrow(/缺少/)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('工作流不存在 → 报错', async () => {
    const dir = await makeTmpDir()
    const { q } = makeQuickHarness({ meta: null }, dir)
    await expect(q.quickRender({ workflowName: 'nope', prompt: 'x' })).rejects.toThrow(/工作流不存在/)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('全量参数注入：SEED/DURATION/FRAMES/WIDTH/HEIGHT/REF_IMAGE/END_IMAGE + 进度回调', async () => {
    const dir = await makeTmpDir()
    const h = makeQuickHarness({
      meta: {
        name: 't2v', hasDuration: true,
        placeholders: ['PROMPT', 'SEED', 'DURATION', 'FRAMES', 'WIDTH', 'HEIGHT', 'REF_IMAGE', 'END_IMAGE']
      }
    }, dir)
    const msgs: Array<[string, number]> = []
    const res = await h.q.quickRender({
      workflowName: 't2v', prompt: '猫', seed: 7, durationSec: 3,
      width: 512, height: 704, refImageAbs: 'E:/ref.png', endImageAbs: 'E:/end.png',
      onProgress: (m, p) => msgs.push([m, p])
    })
    expect(h.captured.vars).toMatchObject({
      PROMPT: '猫', SEED: 7, DURATION: 3, FRAMES: 48,
      WIDTH: 512, HEIGHT: 704, REF_IMAGE: 'up_ref.png', END_IMAGE: 'up_end.png'
    })
    expect(h.uploads).toEqual(['E:/ref.png', 'E:/end.png'])
    expect(msgs.some(m => m[0].includes('上传参考图'))).toBe(true)
    expect(msgs.some(m => m[0].includes('上传尾帧图'))).toBe(true)
    expect(msgs.some(m => m[0] === '渲染中... 50%')).toBe(true)
    expect(msgs[msgs.length - 1][0]).toBe('完成')
    expect(res.promptId).toBe('qp1')
    expect(res.outputAbs).toContain(path.join('quick'))
    expect(res.outputAbs.endsWith('.mp4')).toBe(true)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('环境自检失败 → 中文错误且未提交', async () => {
    const dir = await makeTmpDir()
    const h = makeQuickHarness({ issues: [{ message: '缺少节点 Foo' }] }, dir)
    await expect(h.q.quickRender({ workflowName: 't2v', prompt: '猫' }))
      .rejects.toThrow(/环境自检失败[\s\S]*缺少节点 Foo/)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('无输出文件 → 报错', async () => {
    const dir = await makeTmpDir()
    const h = makeQuickHarness({ video: null }, dir)
    await expect(h.q.quickRender({ workflowName: 't2v', prompt: '猫' }))
      .rejects.toThrow(/未输出任何文件/)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('扩展名推断与下载分支：png 名 / 无扩展名 output→mp4 / 无扩展名非 output→png / fullpath→downloadFromFullPath', async () => {
    const dir = await makeTmpDir()
    const h1 = makeQuickHarness({
      out: { images: [{ filename: 'shot.png', subfolder: 'a', type: 'output' }] }
    }, dir)
    const r1 = await h1.q.quickRender({ workflowName: 't2v', prompt: '猫' })
    expect(r1.outputAbs.endsWith('.png')).toBe(true)
    expect(h1.downloads).toHaveLength(1)

    const h2 = makeQuickHarness({
      out: { images: [{ filename: 'noext', subfolder: '', type: 'output', fullpath: 'E:/c/noext' }] }
    }, dir)
    const r2 = await h2.q.quickRender({ workflowName: 't2v', prompt: '猫' })
    expect(r2.outputAbs.endsWith('.mp4')).toBe(true)
    expect(h2.fullDownloads).toHaveLength(1)

    const h3 = makeQuickHarness({
      out: { images: [{ filename: 'noext', subfolder: '', type: 'temp' }] }
    }, dir)
    const r3 = await h3.q.quickRender({ workflowName: 't2v', prompt: '猫' })
    expect(r3.outputAbs.endsWith('.png')).toBe(true)
    expect(h3.downloads).toHaveLength(1)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
