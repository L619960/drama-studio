import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildCharacters, buildPropAssets, rerunCasting
} from '../../src/main/core/directorStageCharacters'
import { ImageGenerateCancelled } from '../../src/main/core/imageService'

/**
 * 角色/道具资产建档单测（directorStageCharacters）：
 * buildCharacters 建档主路径与失败降级、资产复用回退、取消传播；
 * buildPropAssets 早退/失败不阻断/取消；rerunCasting 重出定妆计数。
 */
const tmpDirs: string[] = []
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-chars-'))
  tmpDirs.push(dir)
  return dir
}

function makeProject(over: Record<string, any> = {}): any {
  return {
    id: 'p1',
    title: '测试剧',
    genre: '都市',
    characters: [],
    shots: [],
    sceneBoards: [],
    ...over
  }
}

function makeRt(project: any, opts: Record<string, any> = {}): any {
  return {
    baseDir: opts.baseDir || '/tmp/nowhere',
    states: new Map(),
    gates: new Map(),
    healBudget: new Map(),
    visionWarned: new Set(),
    store: {
      get: opts.get || vi.fn(async () => project),
      save: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined)
    },
    settings: { get: vi.fn(async () => opts.settings || {}) },
    image: { generate: opts.generate || vi.fn(async () => undefined) },
    picker: {
      pick: vi.fn(async (req: any) => ({
        winner: req.candidates[0],
        rejected: req.candidates.slice(1),
        reason: 'mock pick'
      })),
      promoteWinner: vi.fn(async () => undefined)
    },
    log: vi.fn(),
    setStage: vi.fn(),
    notifyProjectUpdated: vi.fn(),
    isCancelled: vi.fn(() => Boolean(opts.cancelled))
  }
}

const settingsOnce = {
  creation: { character: { candidates: 1 } },
  render: { assetConcurrency: 2 }
}

describe('buildCharacters', () => {
  it('建档成功：生成面部与三视图并落盘通知', async () => {
    const project = makeProject()
    const rt = makeRt(project, { settings: settingsOnce })
    const analysis: any = {
      characters: [
        { name: '林夏', gender: 'female', appearance: '红色连衣裙', lookEn: 'chinese, long black hair, red dress' },
        { name: '沈川', gender: 'male', appearance: '蓝色夹克', lookEn: 'chinese, short hair, blue jacket' }
      ],
      shots: []
    }

    const result = await buildCharacters(rt, 'p1', analysis)

    expect(result.size).toBe(2)
    const lin = result.get('林夏') as any
    expect(lin.voice).toMatch(/^zh-CN-/)
    expect(lin.faceImagePath).toMatch(/projects\/p1\/characters\/.+_face\.png$/)
    expect(lin.bodySheetPath).toMatch(/projects\/p1\/characters\/.+_body\.png$/)
    expect(lin.refImagePath).toBe(lin.faceImagePath)
    // 面容 + 三视图，每角色两张
    expect(rt.image.generate).toHaveBeenCalledTimes(4)
    expect(rt.store.save).toHaveBeenCalledTimes(1)
    expect(rt.notifyProjectUpdated).toHaveBeenCalledWith('p1')
    expect(rt.setStage).toHaveBeenLastCalledWith('p1', 'casting', 'done', expect.stringContaining('2 个角色'), 100)
  })

  it('生成失败不落档：角色描述追加失败标记，阶段置 error', async () => {
    const project = makeProject()
    const generate = vi.fn(async () => { throw new Error('ComfyUI 未启动') })
    const rt = makeRt(project, { settings: settingsOnce, generate })
    const analysis: any = {
      characters: [{ name: '林夏', gender: 'female', appearance: '红衣', lookEn: 'chinese, red dress' }],
      shots: []
    }

    const result = await buildCharacters(rt, 'p1', analysis)

    const lin = result.get('林夏') as any
    expect(lin.faceImagePath).toBeUndefined()
    expect(lin.description).toContain('定妆资产生成失败')
    expect(rt.setStage).toHaveBeenLastCalledWith('p1', 'casting', 'error', expect.stringContaining('ComfyUI'), 0)
    expect(rt.log).toHaveBeenCalledWith('p1', 'casting', 'warn', expect.stringContaining('失败'))
  })

  it('取消时抛出 CANCELLED，不进入生成', async () => {
    const project = makeProject()
    const rt = makeRt(project, { settings: settingsOnce, cancelled: true })

    await expect(buildCharacters(rt, 'p1', {
      characters: [{ name: '林夏', gender: 'female', appearance: '红衣', lookEn: 'chinese, red dress' }],
      shots: []
    } as any)).rejects.toThrow('CANCELLED')
    expect(rt.image.generate).not.toHaveBeenCalled()
  })

  it('T2I 不可用时按题材从资产库项目复用定妆', async () => {
    const baseDir = await makeTmpDir()
    const project = makeProject()
    const fbProject: any = makeProject({
      id: 'fbp',
      characters: [{
        id: 'c1',
        name: '旧角',
        faceImagePath: 'projects/fbp/characters/c1_face.png',
        bodySheetPath: 'projects/fbp/characters/c1_body.png',
        appearanceLock: 'chinese, red dress'
      }]
    })
    await fs.mkdir(path.join(baseDir, 'projects', 'fbp', 'characters'), { recursive: true })
    await fs.mkdir(path.join(baseDir, 'projects', 'p1', 'characters'), { recursive: true })
    await fs.writeFile(path.join(baseDir, 'projects', 'fbp', 'characters', 'c1_face.png'), 'face')
    await fs.writeFile(path.join(baseDir, 'projects', 'fbp', 'characters', 'c1_body.png'), 'body')

    const rt = makeRt(project, {
      baseDir,
      settings: {
        creation: { character: { candidates: 1 } },
        render: { assetConcurrency: 1, assetFallbackProjectId: 'fbp' }
      },
      get: vi.fn(async (id: string) => (id === 'fbp' ? fbProject : project)),
      generate: vi.fn(async () => { throw new Error('T2I 模型缺失') })
    })

    const result = await buildCharacters(rt, 'p1', {
      characters: [{ name: '林夏', gender: 'female', appearance: '红衣', lookEn: 'chinese, red dress' }],
      shots: []
    } as any)

    const lin = result.get('林夏') as any
    expect(lin.faceImagePath).toMatch(/projects\/p1\/characters\/.+_face\.png$/)
    expect(lin.bodySheetPath).toMatch(/projects\/p1\/characters\/.+_body\.png$/)
    expect(lin.appearanceLock).toBe('chinese, red dress')
    expect(rt.log).toHaveBeenCalledWith('p1', 'casting', 'warn', expect.stringContaining('复用定妆资产'))
  })
})

describe('buildPropAssets', () => {
  it('无道具直接返回，不触发生成与设置读取', async () => {
    const rt = makeRt(makeProject())
    await buildPropAssets(rt, 'p1', { characters: [], shots: [] } as any)
    expect(rt.settings.get).not.toHaveBeenCalled()
    expect(rt.image.generate).not.toHaveBeenCalled()
  })

  it('成功生成道具图并回填保存', async () => {
    const baseDir = await makeTmpDir()
    const project = makeProject()
    const rt = makeRt(project, { baseDir, settings: settingsOnce })
    const props: any[] = [
      { id: 'prop_1', zh: '纸袋', en: 'paper bag', description: 'brown paper bag with rope handle' }
    ]

    await buildPropAssets(rt, 'p1', { characters: [], shots: [], props } as any)

    expect(props[0].imagePath).toBe('projects/p1/props/prop_1.png')
    expect(project.props).toEqual(props)
    expect(rt.store.save).toHaveBeenCalledTimes(1)
    expect(rt.log).toHaveBeenCalledWith('p1', 'casting', 'info', expect.stringContaining('道具定妆图 1/1'))
  })

  it('单张生成失败只告警，不阻断其余道具', async () => {
    const project = makeProject()
    let call = 0
    const generate = vi.fn(async () => {
      call++
      if (call === 1) throw new Error('队列繁忙')
    })
    const rt = makeRt(project, { settings: { creation: { character: { candidates: 1 } }, render: { assetConcurrency: 1 } }, generate })
    const props: any[] = [
      { id: 'prop_1', zh: '纸袋', en: 'paper bag' },
      { id: 'prop_2', zh: '绳', en: 'rope' }
    ]

    await buildPropAssets(rt, 'p1', { characters: [], shots: [], props } as any)

    expect(props[0].imagePath).toBeUndefined()
    expect(props[1].imagePath).toBe('projects/p1/props/prop_2.png')
    expect(rt.log).toHaveBeenCalledWith('p1', 'casting', 'warn', expect.stringContaining('纸袋'))
  })

  it('取消时抛出 ImageGenerateCancelled', async () => {
    const project = makeProject()
    const generate = vi.fn(async () => { throw new ImageGenerateCancelled() })
    const rt = makeRt(project, { settings: settingsOnce, generate })

    await expect(buildPropAssets(rt, 'p1', {
      characters: [], shots: [], props: [{ id: 'prop_1', zh: '纸袋', en: 'paper bag' }]
    } as any)).rejects.toBeInstanceOf(ImageGenerateCancelled)
  })
})

describe('rerunCasting', () => {
  it('无角色时返回提示文本', async () => {
    const rt = makeRt(makeProject())
    const r = await rerunCasting(rt, 'p1')
    expect(r).toEqual({ ok: false, text: '项目暂无角色，无法重出定妆' })
    expect(rt.image.generate).not.toHaveBeenCalled()
  })

  it('成功重出所有角色面部与三视图', async () => {
    const project = makeProject({
      characters: [{ id: 'c1', name: '林夏', appearanceLock: 'chinese, red dress', refImagePath: '' }]
    })
    const rt = makeRt(project, { settings: settingsOnce })

    const r = await rerunCasting(rt, 'p1')

    expect(r.ok).toBe(true)
    expect(r.text).toContain('1 位角色')
    const c = project.characters[0]
    expect(c.faceImagePath).toBe('projects/p1/characters/c1_face.png')
    expect(c.refImagePath).toBe('projects/p1/characters/c1_face.png')
    expect(c.bodySheetPath).toBe('projects/p1/characters/c1_body.png')
    expect(rt.store.save).toHaveBeenCalledTimes(1)
  })

  it('部分失败时 ok=false 并汇总失败详情', async () => {
    const project = makeProject({
      characters: [{ id: 'c1', name: '林夏', appearanceLock: 'chinese, red dress', refImagePath: '' }]
    })
    const generate = vi.fn(async () => { throw new Error('超时') })
    const rt = makeRt(project, { settings: settingsOnce, generate })

    const r = await rerunCasting(rt, 'p1')

    expect(r.ok).toBe(false)
    expect(r.text).toContain('「林夏」面部')
    expect(r.text).toContain('「林夏」三视图')
  })

  it('取消沿 ImageGenerateCancelled 向上传播', async () => {
    const project = makeProject({
      characters: [{ id: 'c1', name: '林夏', appearanceLock: 'chinese, red dress' }]
    })
    const generate = vi.fn(async () => { throw new ImageGenerateCancelled() })
    const rt = makeRt(project, { settings: settingsOnce, generate })

    await expect(rerunCasting(rt, 'p1')).rejects.toBeInstanceOf(ImageGenerateCancelled)
    expect(rt.store.save).not.toHaveBeenCalled()
  })
})
