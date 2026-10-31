import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SelfCheckService } from '../../src/main/core/selfCheckService'

/**
 * 自检服务（SelfCheckService）单测：
 * 目录自动创建、损坏会话隔离、项目档案损坏报告、工作流/技能/配置/FFmpeg/ComfyUI 检查。
 */
const tmpDirs: string[] = []
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-selfcheck-'))
  tmpDirs.push(dir)
  return dir
}

function goodSettings(over: Record<string, any> = {}): any {
  return {
    llm: { apiKey: 'sk-test', baseUrl: 'https://api.example.com', model: 'test-model' },
    comfyui: { baseUrl: 'http://127.0.0.1:8188' },
    workflow: { default: 'klein_t2i_clean' },
    tts: {},
    general: {},
    render: { defaultFrames: 81, assetConcurrency: 2, reviewGate: 'block' },
    creation: {
      storyboard: { minShots: 8, maxShots: 16 },
      character: { candidates: 2 },
      scene: { candidates: 2 },
      edit: { defaultFrames: 81, renderCandidates: 1, comfyTimeoutSec: 600, reviewGate: 'block' },
    },
    ...over,
  }
}

function makeSvc(opts: Record<string, any> = {}): any {
  return new SelfCheckService(
    opts.baseDir,
    {} as any,
    opts.skills || { list: vi.fn(async () => []) },
    opts.workflows || { list: vi.fn(async () => []) },
    opts.ffmpeg || { ready: vi.fn(async () => undefined) },
    opts.comfy || { healthCheck: vi.fn(async () => true) },
    {
      get: vi.fn(async () => opts.settings || goodSettings()),
      save: opts.save || vi.fn(async () => undefined),
    } as any,
  )
}

describe('checkDirs', () => {
  it('缺失目录自动创建并标记 fixed', async () => {
    const baseDir = await makeTmpDir()
    const svc = makeSvc({ baseDir })

    const item = await svc.checkDirs()

    expect(item.ok).toBe(true)
    expect(item.fixed).toBe(true)
    expect(item.detail).toContain('已自动创建缺失目录')
    for (const d of ['projects', 'conversations', 'uploads', 'tmp']) {
      await expect(fs.access(path.join(baseDir, d))).resolves.toBeUndefined()
    }
  })

  it('目录齐全时 detail 报告结构完整', async () => {
    const baseDir = await makeTmpDir()
    for (const d of ['projects', 'conversations', 'uploads', 'tmp']) {
      await fs.mkdir(path.join(baseDir, d), { recursive: true })
    }
    const svc = makeSvc({ baseDir })

    const item = await svc.checkDirs()

    expect(item.fixed).toBe(false)
    expect(item.detail).toContain('目录结构完整')
  })
})

describe('checkConversations', () => {
  it('损坏 JSON 自动备份隔离，正常档案保留', async () => {
    const baseDir = await makeTmpDir()
    const dir = path.join(baseDir, 'conversations')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'ok.json'), JSON.stringify([]))
    await fs.writeFile(path.join(dir, 'broken.json'), '{not json')
    await fs.writeFile(path.join(dir, 'obj.json'), JSON.stringify({ a: 1 }))
    const svc = makeSvc({ baseDir })

    const item = await svc.checkConversations()

    expect(item.ok).toBe(true)
    expect(item.fixed).toBe(true)
    expect(item.detail).toContain('2 个损坏会话已备份隔离')
    expect(item.detail).toContain('broken.json')
    const names = await fs.readdir(dir)
    expect(names.filter((n) => n.startsWith('broken.json.bak_')).length).toBe(1)
    expect(names).toContain('ok.json')
  })

  it('目录不存在时报告暂无对话记录', async () => {
    const baseDir = await makeTmpDir()
    const svc = makeSvc({ baseDir })

    const item = await svc.checkConversations()

    expect(item.ok).toBe(true)
    expect(item.detail).toBe('暂无对话记录')
  })
})

describe('checkProjects', () => {
  it('损坏档案报告为不通过并保留文件', async () => {
    const baseDir = await makeTmpDir()
    const root = path.join(baseDir, 'projects')
    await fs.mkdir(path.join(root, 'p1'), { recursive: true })
    await fs.writeFile(path.join(root, 'p1', 'project.json'), JSON.stringify({ id: 'p1', shots: [] }))
    await fs.mkdir(path.join(root, 'p2'), { recursive: true })
    await fs.writeFile(path.join(root, 'p2', 'project.json'), '{bad')
    const svc = makeSvc({ baseDir })

    const item = await svc.checkProjects()

    expect(item.ok).toBe(false)
    expect(item.detail).toContain('1 个项目档案损坏')
    expect(item.detail).toContain('p2/project.json')
    await expect(fs.access(path.join(root, 'p2', 'project.json'))).resolves.toBeUndefined()
  })

  it('统计渲染中断镜头并在 detail 提示', async () => {
    const baseDir = await makeTmpDir()
    const root = path.join(baseDir, 'projects')
    await fs.mkdir(path.join(root, 'p1'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'p1', 'project.json'),
      JSON.stringify({
        id: 'p1',
        shots: [{ status: 'rendering' }, { status: 'pending' }],
      }),
    )
    const svc = makeSvc({ baseDir })

    const item = await svc.checkProjects()

    expect(item.ok).toBe(true)
    expect(item.detail).toContain('1 个项目档案正常')
    expect(item.detail).toContain('1 个镜头处于渲染中断状态')
  })

  it('目录不存在时报告暂无项目', async () => {
    const baseDir = await makeTmpDir()
    const svc = makeSvc({ baseDir })
    const item = await svc.checkProjects()
    expect(item.detail).toBe('暂无项目')
  })
})

describe('checkSkills / checkWorkflows', () => {
  it('技能统计内置/自定义与可用工具数', async () => {
    const svc = makeSvc({
      skills: {
        list: vi.fn(async () => [
          { builtin: true, enabled: true, kind: 'tool' },
          { builtin: true, enabled: false, kind: 'prompt' },
          { builtin: false, enabled: true, kind: 'prompt' },
        ]),
      },
    })

    const item = await svc.checkSkills()

    expect(item.ok).toBe(true)
    expect(item.detail).toContain('内置 2 项 / 自定义 1 项')
    expect(item.detail).toContain('工具技能 1 项')
  })

  it('工作流缺失/读取失败均标记不通过', async () => {
    const empty = await makeSvc({ workflows: { list: vi.fn(async () => []) } }).checkWorkflows()
    expect(empty.ok).toBe(false)
    expect(empty.detail).toContain('未找到任何工作流模板')

    const broken = await makeSvc({
      workflows: {
        list: vi.fn(async () => {
          throw new Error('目录不可读')
        }),
      },
    }).checkWorkflows()
    expect(broken.ok).toBe(false)
    expect(broken.detail).toContain('模板目录读取失败：目录不可读')

    const ok = await makeSvc({
      workflows: { list: vi.fn(async () => [{ name: 'wf_a' }, { name: 'wf_b' }]) },
    }).checkWorkflows()
    expect(ok.ok).toBe(true)
    expect(ok.detail).toContain('2 个模板解析正常：wf_a、wf_b')
  })
})

describe('checkSettings', () => {
  it('合法配置通过并给出摘要', async () => {
    const svc = makeSvc()
    const item = await svc.checkSettings()
    expect(item.ok).toBe(true)
    expect(item.detail).toContain('LLM: test-model')
    expect(item.detail).toContain('抽卡 人2/景2/渲1')
  })

  it('非法帧数自动钳回 16n+1 并落盘', async () => {
    const save = vi.fn(async (_settings: unknown) => undefined)
    const svc = makeSvc({
      settings: goodSettings({ render: { defaultFrames: 80, assetConcurrency: 2, reviewGate: 'block' } }),
      save,
    })

    const item = await svc.checkSettings()

    expect(item.ok).toBe(true)
    expect(item.fixed).toBe(true)
    expect(item.detail).toContain('默认帧数 80→81')
    expect(save).toHaveBeenCalledTimes(1)
    expect((save.mock.calls[0]?.[0] as any).render.defaultFrames).toBe(81)
  })

  it('缺 Key/并发越界/创作配置非法时报告问题', async () => {
    const svc = makeSvc({
      settings: goodSettings({
        llm: { apiKey: '', model: 'm' },
        comfyui: { baseUrl: '' },
        render: { defaultFrames: 81, assetConcurrency: 4, reviewGate: 'block' },
        creation: {
          storyboard: { minShots: 20, maxShots: 8 },
          character: { candidates: 9 },
          scene: { candidates: 0 },
          edit: { defaultFrames: 80, renderCandidates: 5, comfyTimeoutSec: 30, reviewGate: 'block' },
        },
      }),
    })

    const item = await svc.checkSettings()

    expect(item.ok).toBe(false)
    for (const msg of [
      'LLM API Key 未配置',
      'ComfyUI 地址为空',
      '资产并发 4 超出 1~3',
      '分镜最少镜头大于最多镜头',
      '剪辑默认帧数非 16n+1',
      '人物抽卡张数非法',
      '场景抽卡张数非法',
      '渲染抽卡条数非法',
      'Comfy 超时过短',
    ]) {
      expect(item.detail).toContain(msg)
    }
  })
})

describe('checkFfmpeg / checkComfy', () => {
  it('ffmpeg 就绪通过，抛错时报告', async () => {
    const ok = await makeSvc({ ffmpeg: { ready: vi.fn(async () => undefined) } }).checkFfmpeg()
    expect(ok.ok).toBe(true)

    const bad = await makeSvc({
      ffmpeg: {
        ready: vi.fn(async () => {
          throw new Error('ffmpeg 缺失')
        }),
      },
    }).checkFfmpeg()
    expect(bad.ok).toBe(false)
    expect(bad.detail).toBe('ffmpeg 缺失')
  })

  it('ComfyUI 离线只提示 warn，不判失败', async () => {
    const offline = await makeSvc({ comfy: { healthCheck: vi.fn(async () => false) } }).checkComfy()
    expect(offline.ok).toBe(true)
    expect(offline.warn).toBe(true)
    expect(offline.detail).toContain('离线')

    const online = await makeSvc({ comfy: { healthCheck: vi.fn(async () => true) } }).checkComfy()
    expect(online.warn).toBe(false)
    expect(online.detail).toContain('在线')
  })
})

describe('run', () => {
  it('汇总九项检查（ComfyUI 离线仅 warn）', async () => {
    const baseDir = await makeTmpDir()
    const svc = makeSvc({
      baseDir,
      skills: { list: vi.fn(async () => [{ builtin: true, enabled: true, kind: 'tool' }]) },
      workflows: { list: vi.fn(async () => [{ name: 'wf_a' }]) },
      comfy: { healthCheck: vi.fn(async () => false) },
    })

    const items = await svc.run()

    expect(items).toHaveLength(9)
    expect(items.map((i: any) => i.name)).toEqual([
      '数据目录',
      '对话记录',
      '项目档案',
      '技能库',
      '工作流模板',
      '提示词工业标准',
      '关键配置',
      'FFmpeg',
      'ComfyUI',
    ])
    const comfy = items[8] as any
    expect(comfy.ok).toBe(true)
    expect(comfy.warn).toBe(true)
  })
})
