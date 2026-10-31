/**
 * directorAssetBuilder 单测（不发网络、不启动 ComfyUI）：
 * - 3 个纯函数（sanitizeCameraForFrame / buildCloseupEditPrompt / buildPanoEditPrompt）全分支。
 * - async 资产构建函数（buildCharacters / buildPropAssets / tryReuseSceneBoard / ensureSceneEn /
 *   generateShotFirstFrame / buildShots）用最小 mock agent 触发：正常生成、取消透传、复用命中/未命中、
 *   部分失败、缓存已存在跳过、融合两级降级与 block halt。
 * fs/promises 用同步 fs mock（ttsService 同款手法），全部纯微任务驱动，无 fake timers。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as nodeFs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { DirectorAgent } from '../../src/main/core/directorAgent'
import type {
  AnalyzeResult,
  AppSettings,
  Character,
  Project,
  SceneBoard,
  DirectorState,
  DirectorStage,
  StageState,
} from '../../src/shared/ipcTypes'
import { STAGE_ORDER } from '../../src/main/core/directorConstants'

const state = vi.hoisted(() => ({
  fsCalls: [] as Array<{ fn: string; args: unknown[] }>,
  statFail: false,
  mkdirFail: false,
  copyFileFail: false,
  renameFail: false,
}))

// fs/promises mock：用 node:fs 同步方法 + Promise 包装（纯微任务，无真实异步 IO 竞态）。
// stat 默认返回伪文件大小（真实目标文件不存在），existsSync 固定 false 走"Python 不可用"跳过分支。
vi.mock('node:fs/promises', async () => {
  const ok = (v: unknown) => Promise.resolve(v)
  const fail = (e: Error) => Promise.reject(e)
  return {
    stat: (...args: unknown[]) => {
      state.fsCalls.push({ fn: 'stat', args })
      if (state.statFail) return fail(new Error('ENOENT'))
      return ok({ size: 20480 })
    },
    mkdir: (...args: unknown[]) => {
      state.fsCalls.push({ fn: 'mkdir', args })
      if (state.mkdirFail) return fail(new Error('EACCES'))
      return ok(undefined)
    },
    copyFile: (...args: unknown[]) => {
      state.fsCalls.push({ fn: 'copyFile', args })
      if (state.copyFileFail) return fail(new Error('ENOENT'))
      return ok(undefined)
    },
    rename: (...args: unknown[]) => {
      state.fsCalls.push({ fn: 'rename', args })
      if (state.renameFail) return fail(new Error('ENOENT'))
      return ok(undefined)
    },
    existsSync: () => false,
  }
})

// 避免 emitStateImpl fire-and-forget 的 persistImpl 写盘
vi.mock('../../src/main/core/fsUtil', () => ({
  atomicWriteJson: vi.fn().mockResolvedValue(undefined),
}))

import {
  sanitizeCameraForFrameImpl,
  buildCloseupEditPromptImpl,
  buildPanoEditPromptImpl,
  buildCharactersImpl,
  buildPropAssetsImpl,
  tryReuseSceneBoardImpl,
  ensureSceneEnImpl,
  generateShotFirstFrameImpl,
  buildShotsImpl,
} from '../../src/main/core/directorAssetBuilder'
import { ImageGenerateCancelled, type ImageGenerateOptions } from '../../src/main/core/imageService'

type DeepPartial<T> = T extends (infer U)[]
  ? Array<DeepPartial<U>>
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

// ===== 夹具 =====

function mkState(projectId: string): DirectorState {
  const stages = {} as Record<DirectorStage, StageState>
  for (const s of STAGE_ORDER) stages[s] = { status: 'pending', message: '', percent: 0 }
  return {
    projectId,
    title: '测试片',
    running: true,
    cancelled: false,
    paused: false,
    gateStages: [],
    stages,
    totalShots: 0,
    doneShots: 0,
    failedShotIds: [],
    startedAt: Date.now(),
    logs: [],
  }
}

function mkSettings(over: DeepPartial<AppSettings> = {}): AppSettings {
  return {
    render: {
      defaultWidth: 720,
      defaultHeight: 480,
      defaultFrames: 81,
      timeout: 600,
      lipSync: false,
      lipSyncMode: 'auto',
      oomRetry: false,
      consistencyMode: 'off',
      resolutionTier: 'standard',
      shotReviewGate: 'off',
      reviewGate: 'off',
      finalReviewGate: 'off',
      assetConcurrency: 2,
      perShotAudit: false,
      turboH3: true,
      fusionFallback: 'block',
      ...(over.render as object),
    },
    creation: {
      storyboard: {} as never,
      character: {
        faceWidth: 768,
        faceHeight: 1152,
        bodyWidth: 1344,
        bodyHeight: 896,
        realismLock: 'strong',
        seedMode: 'random',
        seed: 42,
        t2iWorkflow: '',
        candidates: 1,
        llmPick: false,
      },
      scene: {
        plateWidth: 768,
        plateHeight: 1152,
        frameWidth: 768,
        frameHeight: 1152,
        emptyStrict: true,
        weatherHint: 'auto',
        candidates: 1,
        llmPick: false,
        panorama: true,
        panoViewsCount: 4,
      },
      edit: {} as never,
      presets: [],
    },
    comfyui: {},
    ...over,
  } as unknown as AppSettings
}

function mkProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    title: '测试',
    genre: '悬疑',
    episode: 1,
    status: 'draft',
    characters: [],
    shots: [],
    fps: 24,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as Project
}

function mkBoard(over: Partial<SceneBoard> = {}): SceneBoard {
  return {
    id: 'sb1',
    key: '雨夜天台',
    name: '雨夜天台',
    description: 'desc',
    emptyPlatePath: '',
    ...over,
  }
}

function mkChar(name = '林川', over: Partial<Character> = {}): Character {
  return {
    id: 'c1',
    name,
    refImagePath: '',
    description: '黑色大衣',
    voice: 'zh-CN-YunjianNeural',
    appearanceLock: 'chinese man, black coat',
    ...over,
  }
}

function mkShot(over: Partial<AnalyzeResult['shots'][number]> = {}): AnalyzeResult['shots'][number] {
  return {
    scene: '雨夜天台',
    action: 'Lin walks to the window',
    dialogue: '',
    type: 'i2v',
    camera: 'medium eye level',
    emotion: 'tense',
    lighting: 'moonlight from left',
    facing: 'left third',
    continuity: '',
    characters: ['林川'],
    props: [],
    characterName: '林川',
    sceneEn: 'interior apartment living room at night, warm lamps, rain on window',
    shotSize: 'medium',
    promptEn: 'a cinematic shot of Lin by the window',
    firstFrameEn: 'Lin stands by the window',
    lastFrameEn: 'Lin turns away from the window',
    ...over,
  } as AnalyzeResult['shots'][number]
}

function mkFrameD(over: Record<string, unknown> = {}) {
  return {
    id: 'shot_x',
    index: 3,
    as: mkShot(),
    board: mkBoard(),
    characterIds: ['c1'],
    character: mkChar('林川', { faceImagePath: 'projects/p1/characters/c1_face.png' }),
    ...over,
  } as Parameters<typeof generateShotFirstFrameImpl>[2]
}

let baseDir = ''

function makeAgent(over: Record<string, unknown> = {}) {
  const settings = { get: vi.fn(async () => mkSettings()) }
  const store = {
    get: vi.fn(async (_id: string) => mkProject()),
    save: vi.fn(async (_project: Project) => {}),
  }
  const image = {
    generate: vi.fn(async (_prompt: string, _absOutput: string, _options: ImageGenerateOptions) => {}),
    restoreFace: vi.fn(async (_absInput: string, _absOutput: string) => {}),
  }
  const ffmpeg = {
    cropPanoramaViews: vi.fn(async (..._args: unknown[]) => [path.join(baseDir, 'v0.png')]),
    tileImages: vi.fn(async (..._args: unknown[]) => {}),
  }
  const picker = {
    pick: vi.fn(
      async (_opts: {
        kind: 'character' | 'scene' | 'render'
        brief: string
        candidates: Array<{ id: string; relativePath: string; seed: number; score?: number; note?: string }>
        llmPick: boolean
      }) => ({ winner: { relativePath: 'w.png' }, rejected: [] as Array<{ relativePath: string }>, reason: 'ok' }),
    ),
    promoteWinner: vi.fn(
      async (_opts: {
        baseDir: string
        winnerRel: string
        finalRel: string
        rejectedRels: string[]
        keepRejected?: boolean
      }) => {},
    ),
  }
  const llm = {
    fillPromptField: vi.fn(
      async (_guide: unknown, _ctx: { currentText: string; scene?: string; sceneEn?: string; action?: string }) =>
        'a bright modern kitchen interior in the morning, sun from east window, warm wood cabinets, clean counters, soft shadows, cozy atmosphere',
    ),
  }
  const agent = {
    baseDir,
    states: new Map<string, DirectorState>([['p1', mkState('p1')]]),
    cancelled: new Set<string>(),
    gates: new Map<string, Set<DirectorStage>>(),
    pauseRequested: new Set<string>(),
    waiters: new Map<string, () => void>(),
    logSeq: new Map<string, number>(),
    healBudget: new Map<string, number>(),
    shadowSettledShots: new Map<string, Set<string>>(),
    visionWarned: new Set<string>(),
    shadowRenders: new Set<string>(),
    lastStageMsg: new Map<string, string>(),
    lastStepByShot: new Map<string, string>(),
    emit: vi.fn(),
    settings,
    store,
    image,
    ffmpeg,
    picker,
    llm,
    ...over,
  } as unknown as DirectorAgent & {
    settings: typeof settings
    store: typeof store
    image: typeof image
    ffmpeg: typeof ffmpeg
    picker: typeof picker
    llm: typeof llm
  }
  return { agent, settings, store, image, ffmpeg, picker, llm }
}

beforeEach(async () => {
  baseDir = await nodeFs.promises.mkdtemp(path.join(os.tmpdir(), 'dab-'))
  Object.assign(state, { fsCalls: [], statFail: false, mkdirFail: false, copyFileFail: false, renameFail: false })
})

afterEach(async () => {
  await nodeFs.promises.rm(baseDir, { recursive: true, force: true })
})

// ===== 纯函数 =====

describe('sanitizeCameraForFrameImpl', () => {
  it('无禁用词：原样合并', () => {
    expect(sanitizeCameraForFrameImpl('low angle, from behind')).toBe('low angle, from behind')
  })
  it('剥离英文第二人/背景人影从句', () => {
    expect(sanitizeCameraForFrameImpl('another person enters, low angle, background figure')).toBe('low angle')
  })
  it('剥离中文路人/剪影从句', () => {
    expect(sanitizeCameraForFrameImpl('路人走过，另一人入画，剪影在窗边，中景')).toBe('中景')
  })
  it('中文顿号与空格混用、空段过滤', () => {
    expect(sanitizeCameraForFrameImpl(' high angle ， out of focus ， ， closeup ')).toBe('high angle, closeup')
  })
  it('空输入返回空串', () => {
    expect(sanitizeCameraForFrameImpl('')).toBe('')
    expect(sanitizeCameraForFrameImpl('   ')).toBe('')
  })
})

describe('buildCloseupEditPromptImpl', () => {
  const d = (over: Record<string, unknown> = {}) => ({
    as: {
      action: 'Lin opens the door',
      emotion: 'calm',
      camera: 'low angle',
      shotSize: 'closeup',
      firstFrameEn: 'Lin at door',
      lastFrameEn: 'Lin closes door',
      props: ['umbrella'] as string[],
      ...over,
    },
  })

  it('start 相位优先 action，含关键道具锁', () => {
    const p = buildCloseupEditPromptImpl('书房', d(), 'CU', 'start')
    expect(p).toContain('把图1中的人物放入场景「书房」')
    expect(p).toContain('，Lin opens the door')
    expect(p).toContain('，calm的表情')
    expect(p).toContain('，low angle')
    expect(p).toContain('画面中必须清晰出现本镜关键道具：umbrella')
  })

  it('end 相位优先 lastFrameEn，action 兜底', () => {
    const p = buildCloseupEditPromptImpl('书房', d(), 'CU', 'end')
    expect(p).toContain('，Lin closes door')
    expect(buildCloseupEditPromptImpl('书房', d({ lastFrameEn: '   ' }), 'CU', 'end')).toContain('，Lin opens the door')
  })

  it('start 相位 action 为空时 firstFrameEn 兜底', () => {
    const p = buildCloseupEditPromptImpl('书房', d({ action: '  ' }), 'CU', 'start')
    expect(p).toContain('，Lin at door')
  })

  it('无 emotion/props 时的默认道具约束文案', () => {
    const p = buildCloseupEditPromptImpl('书房', d({ emotion: '  ', props: [] }), 'CU', 'start')
    expect(p).toContain('动作描述中出现的手持道具必须清晰入画')
    expect(p).toContain('严禁出现与动作描述无关的碗、筷、勺')
    expect(p).not.toContain('calm的表情')
  })
})

describe('buildPanoEditPromptImpl', () => {
  const d = () => ({
    as: {
      action: 'Lin walks in',
      emotion: 'sad',
      camera: 'wide',
      shotSize: 'wide',
      firstFrameEn: 'Lin enters',
      lastFrameEn: 'Lin exits',
      props: [] as string[],
    },
  })

  it('start 相位与图2人物/图1场景约束', () => {
    const p = buildPanoEditPromptImpl('look', '天台', d(), 'WS', 'start')
    expect(p).toContain('把图2中的人物放入图1的场景「天台」')
    expect(p).toContain('，Lin walks in')
    expect(p).toContain('场景的空间布局、光线、色调、机位角度与图1完全一致')
  })

  it('end 相位 lastFrameEn 优先', () => {
    expect(buildPanoEditPromptImpl('look', '天台', d(), 'WS', 'end')).toContain('，Lin exits')
  })
})

// ===== buildCharactersImpl =====

describe('buildCharactersImpl', () => {
  const analysis: AnalyzeResult = {
    characters: [
      { name: '林川', gender: 'male', appearance: '黑色大衣', lookEn: 'chinese man, black coat' },
      { name: '苏晚', gender: 'female', appearance: '白色长裙', lookEn: 'asian woman, white dress' },
    ],
    shots: [mkShot()],
  }

  it('正常建档（candidates=1，随机种子）', async () => {
    const { agent, image, store } = makeAgent()
    const result = await buildCharactersImpl(agent, 'p1', analysis)
    expect(result.size).toBe(2)
    const lin = result.get('林川')!
    expect(lin.voice).toBe('zh-CN-YunjianNeural')
    expect(lin.faceImagePath).toMatch(/^projects\/p1\/characters\/char_.*_face\.png$/)
    expect(lin.bodySheetPath).toMatch(/^projects\/p1\/characters\/char_.*_body\.png$/)
    expect(lin.refImagePath).toBe(lin.faceImagePath)
    expect(result.get('苏晚')!.voice).toBe('zh-CN-XiaoxiaoNeural')
    expect(image.generate).toHaveBeenCalledTimes(4)
    // 保存 + 通知
    expect(store.save).toHaveBeenCalledTimes(1)
    expect(store.save.mock.calls[0]?.[0]?.characters).toHaveLength(2)
    expect(agent.emit).toHaveBeenCalledWith('projectUpdated', expect.objectContaining({ projectId: 'p1' }))
    expect(agent.states.get('p1')!.stages.casting.status).toBe('done')
  })

  it('fixed 种子：face/body 均用 ch.seed 且随候选偏移', async () => {
    const { agent, image } = makeAgent()
    agent.settings.get.mockImplementation(async () =>
      mkSettings({
        creation: { character: { candidates: 1, seedMode: 'fixed', seed: 42 } },
      }),
    )
    await buildCharactersImpl(agent, 'p1', { characters: analysis.characters.slice(0, 1), shots: [] })
    expect(image.generate.mock.calls[0]?.[2].seed).toBe(42)
    expect(image.generate.mock.calls[1]?.[2].seed).toBe(42)
  })

  it('candidates>1：stat 打分 + picker 抽卡 + promoteWinner 落位', async () => {
    const { agent, image, picker } = makeAgent()
    agent.settings.get.mockImplementation(async () =>
      mkSettings({
        creation: { character: { candidates: 2, llmPick: true } },
      }),
    )
    picker.pick.mockResolvedValue({
      winner: { relativePath: 'projects/p1/characters/c_f_face_c1.png' },
      rejected: [{ relativePath: 'projects/p1/characters/c_f_face_c0.png' }],
      reason: '五官更清晰',
    })
    const result = await buildCharactersImpl(agent, 'p1', { characters: analysis.characters.slice(0, 1), shots: [] })
    const lin = result.get('林川')!
    expect(lin.faceImagePath).toMatch(/char_.*_face\.png$/) // finalRel（promote 后）
    expect(image.generate).toHaveBeenCalledTimes(3) // 2 face + 1 body
    expect(picker.pick).toHaveBeenCalledWith(expect.objectContaining({ kind: 'character' }))
    expect(picker.promoteWinner).toHaveBeenCalledWith(
      expect.objectContaining({ winnerRel: 'projects/p1/characters/c_f_face_c1.png', keepRejected: true }),
    )
  })

  it('candidates>1 且 stat 失败：note 标 stat 失败仍可抽卡', async () => {
    const { agent, picker } = makeAgent()
    agent.settings.get.mockImplementation(async () =>
      mkSettings({
        creation: { character: { candidates: 2 } },
      }),
    )
    state.statFail = true
    await buildCharactersImpl(agent, 'p1', { characters: analysis.characters.slice(0, 1), shots: [] })
    const items = picker.pick.mock.calls[0]?.[0]?.candidates as unknown as Array<{ note: string }>
    expect(items.every((c) => c.note === 'stat 失败')).toBe(true)
  })

  it('面部失败、三视图成功：refImagePath 回退 body，warning 日志', async () => {
    const { agent, image } = makeAgent()
    image.generate.mockRejectedValueOnce(new Error('face boom'))
    const result = await buildCharactersImpl(agent, 'p1', { characters: analysis.characters.slice(0, 1), shots: [] })
    const lin = result.get('林川')!
    expect(lin.faceImagePath).toBeUndefined()
    expect(lin.bodySheetPath).toMatch(/_body\.png$/)
    expect(lin.refImagePath).toBe(lin.bodySheetPath)
    expect(lin.description).toBe('黑色大衣') // 未标记失败
    const logs = agent.states.get('p1')!.logs
    expect(logs.some((l) => l.message.includes('面部定妆失败'))).toBe(true)
  })

  it('面部+三视图全失败：description 标记失败、阶段 error', async () => {
    const { agent, image } = makeAgent()
    image.generate.mockRejectedValue(new Error('all boom'))
    const result = await buildCharactersImpl(agent, 'p1', { characters: analysis.characters.slice(0, 1), shots: [] })
    expect(result.get('林川')!.description).toBe('黑色大衣（定妆资产生成失败）')
    expect(agent.states.get('p1')!.stages.casting.status).toBe('error')
  })

  it('取消：ImageGenerateCancelled 透传', async () => {
    const { agent, image } = makeAgent()
    image.generate.mockRejectedValue(new ImageGenerateCancelled())
    await expect(
      buildCharactersImpl(agent, 'p1', { characters: analysis.characters.slice(0, 1), shots: [] }),
    ).rejects.toBeInstanceOf(ImageGenerateCancelled)
  })
})

// ===== buildPropAssetsImpl =====

describe('buildPropAssetsImpl', () => {
  const prop = (): { id: string; zh: string; en: string; description: string; imagePath?: string } => ({
    id: 'umbrella',
    zh: '雨伞',
    en: 'black umbrella',
    description: 'folded',
  })

  it('无 props 提前返回', async () => {
    const { agent, image, store } = makeAgent()
    await buildPropAssetsImpl(agent, 'p1', { characters: [], shots: [], props: [] })
    expect(image.generate).not.toHaveBeenCalled()
    expect(store.save).not.toHaveBeenCalled()
  })

  it('全部生成成功：imagePath 回填 + 保存 + 完成日志', async () => {
    const { agent, image, store } = makeAgent()
    const p = prop()
    await buildPropAssetsImpl(agent, 'p1', { characters: [], shots: [], props: [p] })
    expect(image.generate).toHaveBeenCalledTimes(1)
    expect(p.imagePath).toBe('projects/p1/props/umbrella.png')
    expect(store.save.mock.calls[0]?.[0]?.props?.[0]?.imagePath).toBe('projects/p1/props/umbrella.png')
    const logs = agent.states.get('p1')!.logs
    expect(logs.some((l) => l.message.includes('道具定妆图 1/1 生成完成'))).toBe(true)
  })

  it('普通失败：记 warning、不中断、无完成日志', async () => {
    const { agent, image } = makeAgent()
    image.generate.mockRejectedValue(new Error('comfy down'))
    const p = prop()
    await buildPropAssetsImpl(agent, 'p1', { characters: [], shots: [], props: [p] })
    expect(p.imagePath).toBeUndefined()
    const logs = agent.states.get('p1')!.logs
    expect(logs.some((l) => l.message.includes('道具「雨伞」定妆图生成失败'))).toBe(true)
    expect(logs.some((l) => l.message.includes('生成完成'))).toBe(false)
  })

  it('取消透传：ImageGenerateCancelled / CANCELLED 文案均重抛', async () => {
    const { agent, image } = makeAgent()
    image.generate.mockRejectedValueOnce(new ImageGenerateCancelled())
    await expect(
      buildPropAssetsImpl(agent, 'p1', { characters: [], shots: [], props: [prop()] }),
    ).rejects.toBeInstanceOf(ImageGenerateCancelled)
    image.generate.mockRejectedValueOnce(new Error('CANCELLED: user abort'))
    await expect(buildPropAssetsImpl(agent, 'p1', { characters: [], shots: [], props: [prop()] })).rejects.toThrow(
      'CANCELLED',
    )
  })

  it('保存失败静默吞掉', async () => {
    const { agent, store } = makeAgent()
    store.save.mockRejectedValueOnce(new Error('disk full'))
    await expect(
      buildPropAssetsImpl(agent, 'p1', { characters: [], shots: [], props: [prop()] }),
    ).resolves.toBeUndefined()
  })
})

// ===== tryReuseSceneBoardImpl =====

describe('tryReuseSceneBoardImpl', () => {
  const board = mkBoard()
  const fbProject = mkProject({
    id: 'fb1',
    genre: '悬疑',
    sceneBoards: [mkBoard({ id: 'fb_b', key: '雨夜天台', emptyPlatePath: 'projects/fb1/scenes/x_plate.png' })],
  })

  it('settings.get 抛错 / 无 fallbackProjectId → undefined', async () => {
    const { agent } = makeAgent()
    agent.settings.get.mockRejectedValueOnce(new Error('settings down'))
    expect(await tryReuseSceneBoardImpl(agent, 'p1', board, 0)).toBeUndefined()
    expect(await tryReuseSceneBoardImpl(agent, 'p1', board, 0)).toBeUndefined()
  })

  it('资产库项目读取失败 / 当前项目读取失败 → undefined', async () => {
    const { agent } = makeAgent()
    agent.settings.get.mockImplementation(async () => mkSettings({ render: { assetFallbackProjectId: 'fb1' } }))
    agent.store.get.mockRejectedValueOnce(new Error('fb missing'))
    expect(await tryReuseSceneBoardImpl(agent, 'p1', board, 0)).toBeUndefined()
    agent.store.get.mockRejectedValueOnce(new Error('cur missing'))
    expect(await tryReuseSceneBoardImpl(agent, 'p1', board, 0)).toBeUndefined()
  })

  it('题材不一致：跨题材复用被拒绝', async () => {
    const { agent } = makeAgent()
    agent.settings.get.mockImplementation(async () => mkSettings({ render: { assetFallbackProjectId: 'fb1' } }))
    agent.store.get.mockImplementation(async (id) =>
      id === 'fb1'
        ? mkProject({
            id: 'fb1',
            genre: '古装',
            ...(fbProject.sceneBoards !== undefined ? { sceneBoards: fbProject.sceneBoards } : {}),
          })
        : mkProject(),
    )
    expect(await tryReuseSceneBoardImpl(agent, 'p1', board, 0)).toBeUndefined()
    const logs = agent.states.get('p1')!.logs
    expect(logs.some((l) => l.message.includes('禁止跨题材复用场景板'))).toBe(true)
  })

  it('题材一致但资产库无场景板 → undefined', async () => {
    const { agent } = makeAgent()
    agent.settings.get.mockImplementation(async () => mkSettings({ render: { assetFallbackProjectId: 'fb1' } }))
    agent.store.get.mockImplementation(async (id) =>
      id === 'fb1' ? mkProject({ id: 'fb1', genre: '悬疑', sceneBoards: [mkBoard()] }) : mkProject(),
    )
    expect(await tryReuseSceneBoardImpl(agent, 'p1', board, 0)).toBeUndefined()
  })

  it('复用成功：复制到本剧 scenes、回填 emptyPlatePath/panoViews、返回 fbId', async () => {
    const { agent } = makeAgent()
    agent.settings.get.mockImplementation(async () => mkSettings({ render: { assetFallbackProjectId: 'fb1' } }))
    agent.store.get.mockImplementation(async (id) => (id === 'fb1' ? fbProject : mkProject()))
    expect(await tryReuseSceneBoardImpl(agent, 'p1', board, 0)).toBe('fb1')
    expect(board.emptyPlatePath).toBe('projects/p1/scenes/sb1_plate.png')
    expect(board.panoViews).toEqual(['projects/p1/scenes/sb1_plate.png'])
    const mk = state.fsCalls.find((c) => c.fn === 'mkdir')
    const cp = state.fsCalls.find((c) => c.fn === 'copyFile')
    expect(mk).toBeDefined()
    expect(cp).toBeDefined()
  })

  it('复制失败 → undefined', async () => {
    const { agent } = makeAgent()
    agent.settings.get.mockImplementation(async () => mkSettings({ render: { assetFallbackProjectId: 'fb1' } }))
    agent.store.get.mockImplementation(async (id) => (id === 'fb1' ? fbProject : mkProject()))
    state.copyFileFail = true
    expect(await tryReuseSceneBoardImpl(agent, 'p1', board, 0)).toBeUndefined()
  })
})

// ===== ensureSceneEnImpl =====

describe('ensureSceneEnImpl', () => {
  const LONG_EN =
    'a quiet study room at dusk, bookshelves along the wall, a desk with papers, warm desk lamp, dust in the air'
  /** 覆盖 mkShot 默认场景短语：显式构造「缺 sceneEn」的分镜 */
  const noSceneEn = (over: Parameters<typeof mkShot>[0] = {}) => {
    const s = mkShot(over)
    delete s.sceneEn
    return s
  }

  it('全部 ≥8 词：不调 LLM', async () => {
    const { agent, llm } = makeAgent()
    const scenes = [{ key: '书房', name: '书房', sceneEn: LONG_EN }]
    await ensureSceneEnImpl(agent, 'p1', scenes, { characters: [], shots: [mkShot()] })
    expect(llm.fillPromptField).not.toHaveBeenCalled()
  })

  it('缺短语：LLM 补写并回写同场景分镜', async () => {
    const { agent, llm } = makeAgent()
    llm.fillPromptField.mockResolvedValue(LONG_EN)
    const scenes = [{ key: '书房', name: '书房', sceneEn: 'short' }]
    const shots = [noSceneEn({ scene: '书房' }), noSceneEn({ scene: '天台' })]
    await ensureSceneEnImpl(agent, 'p1', scenes, { characters: [], shots })
    expect(llm.fillPromptField).toHaveBeenCalledTimes(1)
    expect(llm.fillPromptField.mock.calls[0]?.[1]).toEqual({
      scene: '书房',
      action: expect.any(String),
      currentText: 'short',
    })
    expect(scenes[0]?.sceneEn).toBe(LONG_EN)
    expect(shots[0]?.sceneEn).toBe(LONG_EN)
    expect(shots[1]?.sceneEn).toBeUndefined()
  })

  it('LLM 失败：记 warning、保持中文名、不回写', async () => {
    const { agent, llm } = makeAgent()
    llm.fillPromptField.mockRejectedValue(new Error('llm down'))
    const scenes = [{ key: '书房', name: '书房', sceneEn: 'short' }]
    const shots = [noSceneEn({ scene: '书房' })]
    await ensureSceneEnImpl(agent, 'p1', scenes, { characters: [], shots })
    expect(scenes[0]?.sceneEn).toBe('short')
    expect(shots[0]?.sceneEn).toBe('short') // 已有（短）短语仍回写，仅 LLM 补写失败
    const logs = agent.states.get('p1')!.logs
    expect(logs.some((l) => l.message.includes('英文环境短语补写失败'))).toBe(true)
  })
})

// ===== generateShotFirstFrameImpl =====

describe('generateShotFirstFrameImpl', () => {
  const sc = { frameWidth: 768, frameHeight: 1152 }
  const neverAbort = () => false

  it('单图定妆融合成功：直接落 firstFramePath，不再降级', async () => {
    const { agent, image } = makeAgent()
    const d = mkFrameD()
    await generateShotFirstFrameImpl(agent, 'p1', d, sc, neverAbort, ['林川'])
    expect(d.firstFramePath).toBe('projects/p1/shots/shot_x_first.png')
    expect(image.generate).toHaveBeenCalledTimes(1)
    expect(image.generate.mock.calls[0]?.[2].workflowName).toBe('qwen2511_i2i_edit')
    expect(image.generate.mock.calls[0]?.[2].referenceImagePath).toContain('c1_face.png')
  })

  it('单图失败 → 全景双图融合成功（camera=left 命中方位图）', async () => {
    const { agent, image } = makeAgent()
    image.generate.mockRejectedValueOnce(new Error('i2i edit down'))
    const d = mkFrameD({
      board: mkBoard({
        panoViews: [
          'projects/p1/scenes/v0.png',
          'projects/p1/scenes/v1.png',
          'projects/p1/scenes/v2.png',
          'projects/p1/scenes/v3.png',
        ],
      }),
      as: mkShot({ camera: 'left side, medium eye level' }),
    })
    await generateShotFirstFrameImpl(agent, 'p1', d, sc, neverAbort, ['林川'])
    expect(d.firstFramePath).toBe('projects/p1/shots/shot_x_first.png')
    expect(image.generate).toHaveBeenCalledTimes(2)
    const second = image.generate.mock.calls[1]
    expect(second?.[2].workflowName).toBe('qwen2511_i2i_two')
    expect(second?.[2].referenceImagePaths).toEqual([
      path.join(baseDir, 'projects/p1/scenes/v3.png'),
      path.join(baseDir, 'projects/p1/characters/c1_face.png'),
    ])
    const logs = agent.states.get('p1')!.logs
    expect(logs.some((l) => l.message.includes('尝试全景双图融合'))).toBe(true)
  })

  it('两级融合均失败且 fusionFallback=block：throw halt', async () => {
    const { agent, image } = makeAgent()
    image.generate.mockRejectedValue(new Error('all fusion down'))
    const d = mkFrameD({ board: mkBoard({ panoViews: [] }) })
    await expect(generateShotFirstFrameImpl(agent, 'p1', d, sc, neverAbort, ['林川'])).rejects.toThrow(
      /已 halt（fusionFallback=block）/,
    )
  })

  it('两级失败 + fusionFallback=allow：文生兜底 + face restore + 自检降级跳过', async () => {
    const { agent, image } = makeAgent()
    agent.settings.get.mockImplementation(async () => mkSettings({ render: { fusionFallback: 'allow' } }))
    image.generate.mockRejectedValueOnce(new Error('fusion down')).mockResolvedValueOnce(undefined)
    const d = mkFrameD()
    await generateShotFirstFrameImpl(agent, 'p1', d, sc, neverAbort, ['林川'])
    expect(d.firstFramePath).toBe('projects/p1/shots/shot_x_first.png')
    expect(image.generate).toHaveBeenCalledTimes(2)
    expect(image.generate.mock.calls[1]?.[2].workflowName).toBe('klein_t2i_clean')
    expect(image.restoreFace).toHaveBeenCalledTimes(1)
    expect(state.fsCalls.some((c) => c.fn === 'rename')).toBe(true)
  })

  it('无定妆图（faceAbs 空）：跳过融合直达文生兜底，无可恢复参照故不做 face restore', async () => {
    const { agent, image } = makeAgent()
    const d = mkFrameD({ character: mkChar('林川', { faceImagePath: '' }) })
    await generateShotFirstFrameImpl(agent, 'p1', d, sc, neverAbort, ['林川'])
    expect(d.firstFramePath).toBe('projects/p1/shots/shot_x_first.png')
    expect(image.generate).toHaveBeenCalledTimes(1)
    expect(image.generate.mock.calls[0]?.[2].workflowName).toBe('klein_t2i_clean')
    expect(image.restoreFace).not.toHaveBeenCalled()
  })

  it('文生兜底也失败且有定妆图：copyFile 定妆图作首帧', async () => {
    const { agent, image } = makeAgent()
    agent.settings.get.mockImplementation(async () => mkSettings({ render: { fusionFallback: 'allow' } }))
    image.generate.mockRejectedValueOnce(new Error('fusion down')).mockRejectedValueOnce(new Error('t2i down'))
    const d = mkFrameD()
    await generateShotFirstFrameImpl(agent, 'p1', d, sc, neverAbort, ['林川'])
    expect(d.firstFramePath).toBe('projects/p1/shots/shot_x_first.png')
    const cp = state.fsCalls.find((c) => c.fn === 'copyFile')
    expect(cp).toBeDefined()
    expect(cp!.args[0]).toContain('c1_face.png')
    expect(cp!.args[1]).toContain('shot_x_first.png')
  })

  it('restoreFace 失败不阻塞首帧', async () => {
    const { agent, image } = makeAgent()
    agent.settings.get.mockImplementation(async () => mkSettings({ render: { fusionFallback: 'allow' } }))
    image.generate.mockRejectedValueOnce(new Error('fusion down')).mockResolvedValueOnce(undefined)
    image.restoreFace.mockRejectedValueOnce(new Error('codeformer down'))
    const d = mkFrameD()
    await expect(generateShotFirstFrameImpl(agent, 'p1', d, sc, neverAbort, ['林川'])).resolves.toBeUndefined()
    expect(d.firstFramePath).toBe('projects/p1/shots/shot_x_first.png')
  })

  it('取消透传：融合期 ImageGenerateCancelled 直接抛出', async () => {
    const { agent, image } = makeAgent()
    image.generate.mockRejectedValue(new ImageGenerateCancelled())
    const d = mkFrameD()
    await expect(generateShotFirstFrameImpl(agent, 'p1', d, sc, neverAbort, ['林川'])).rejects.toBeInstanceOf(
      ImageGenerateCancelled,
    )
  })

  it('其他角色名与 escort 从句被 mask', async () => {
    const { agent, image } = makeAgent()
    const d = mkFrameD({ as: mkShot({ action: 'Lin escorts Su Wan to the door, the escort team follows' }) })
    await generateShotFirstFrameImpl(agent, 'p1', d, sc, neverAbort, ['林川', '苏晚'])
    const prompt = image.generate.mock.calls[0]?.[0] as string
    expect(prompt).not.toContain('Su Wan')
    expect(prompt).toContain('distant background silhouettes of the convoy') // escort 从句被替换
    // 全景双图/文生兜底未触发
    expect(image.generate).toHaveBeenCalledTimes(1)
  })

  // —— P1-2 多角色同框逐角色参考图 ——
  it('多角色同框：走 qwen2511_i2i_multi，场景板+每位角色各一张定妆', async () => {
    const { agent, image } = makeAgent()
    const d = mkFrameD({
      characters: [
        mkChar('林川', { id: 'c1', faceImagePath: 'projects/p1/characters/c1_face.png' }),
        mkChar('苏晚', { id: 'c2', faceImagePath: 'projects/p1/characters/c2_face.png' }),
      ],
      board: mkBoard({
        panoViews: [
          'projects/p1/scenes/v0.png',
          'projects/p1/scenes/v1.png',
          'projects/p1/scenes/v2.png',
          'projects/p1/scenes/v3.png',
        ],
      }),
      as: mkShot({ camera: 'left side, medium eye level' }),
    })
    await generateShotFirstFrameImpl(agent, 'p1', d, sc, neverAbort, ['林川', '苏晚'])
    expect(d.firstFramePath).toBe('projects/p1/shots/shot_x_first.png')
    expect(image.generate).toHaveBeenCalledTimes(1)
    expect(image.generate.mock.calls[0]?.[2].workflowName).toBe('qwen2511_i2i_multi')
    expect(image.generate.mock.calls[0]?.[2].referenceImagePaths).toEqual([
      path.join(baseDir, 'projects/p1/scenes/v3.png'),
      path.join(baseDir, 'projects/p1/characters/c1_face.png'),
      path.join(baseDir, 'projects/p1/characters/c2_face.png'),
    ])
    // 图1=场景板，人物在图2、图3
    expect(image.generate.mock.calls[0]?.[0]).toContain('图2、图3')
    expect(image.generate.mock.calls[0]?.[0]).toContain('放进图1的场景')
  })

  it('无场景板的多角色：图1、图2 直接取两位定妆图', async () => {
    const { agent, image } = makeAgent()
    const d = mkFrameD({
      characters: [
        mkChar('林川', { id: 'c1', faceImagePath: 'projects/p1/characters/c1_face.png' }),
        mkChar('苏晚', { id: 'c2', faceImagePath: 'projects/p1/characters/c2_face.png' }),
      ],
      board: mkBoard({ panoViews: [] }),
    })
    await generateShotFirstFrameImpl(agent, 'p1', d, sc, neverAbort, ['林川', '苏晚'])
    expect(image.generate.mock.calls[0]?.[2].referenceImagePaths).toEqual([
      path.join(baseDir, 'projects/p1/characters/c1_face.png'),
      path.join(baseDir, 'projects/p1/characters/c2_face.png'),
    ])
    expect(image.generate.mock.calls[0]?.[0]).toContain('把图1、图2中的 2 位人物一起放在场景')
  })

  it('多角色融合失败 → 回退单角色融合', async () => {
    const { agent, image } = makeAgent()
    image.generate.mockRejectedValueOnce(new Error('multi down')).mockResolvedValueOnce(undefined)
    const d = mkFrameD({
      characters: [
        mkChar('林川', { id: 'c1', faceImagePath: 'projects/p1/characters/c1_face.png' }),
        mkChar('苏晚', { id: 'c2', faceImagePath: 'projects/p1/characters/c2_face.png' }),
      ],
    })
    await generateShotFirstFrameImpl(agent, 'p1', d, sc, neverAbort, ['林川', '苏晚'])
    expect(d.firstFramePath).toBe('projects/p1/shots/shot_x_first.png')
    expect(image.generate).toHaveBeenCalledTimes(2)
    expect(image.generate.mock.calls[1]?.[2].workflowName).toBe('qwen2511_i2i_edit')
  })

  // —— P1-1 首帧人脸相似度自检 + 自动重抽 ——
  it('相似度达标：只记录 info，不重抽', async () => {
    const { agent, image } = makeAgent({
      queue: { compareImages: vi.fn(async () => ({ score: 0.9, method: 'face' })) },
    })
    const d = mkFrameD()
    await generateShotFirstFrameImpl(agent, 'p1', d, sc, neverAbort, ['林川'])
    expect(image.generate).toHaveBeenCalledTimes(1)
    expect(agent.states.get('p1')!.logs.some((l) => l.message.includes('首帧人脸相似度 0.900'))).toBe(true)
  })

  it('相似度偏低：自动重抽 1 次，恢复达标记录 info', async () => {
    const { agent, image } = makeAgent()
    const compareImages = vi
      .fn()
      .mockResolvedValueOnce({ score: 0.45, method: 'face' })
      .mockResolvedValueOnce({ score: 0.82, method: 'face' })
    ;(agent as unknown as { queue: unknown }).queue = { compareImages }
    const d = mkFrameD()
    await generateShotFirstFrameImpl(agent, 'p1', d, sc, neverAbort, ['林川'])
    expect(image.generate).toHaveBeenCalledTimes(2)
    expect(d.firstFramePath).toBe('projects/p1/shots/shot_x_first.png')
    const logs = agent.states.get('p1')!.logs
    expect(logs.some((l) => l.message.includes('自动重抽 1 次'))).toBe(true)
    expect(logs.some((l) => l.message.includes('重抽后相似度 0.820'))).toBe(true)
  })

  it('重抽后仍偏低：只告警放行，不再重抽', async () => {
    const { agent, image } = makeAgent()
    const compareImages = vi.fn(async () => ({ score: 0.5, method: 'face' }))
    ;(agent as unknown as { queue: unknown }).queue = { compareImages }
    const d = mkFrameD()
    await generateShotFirstFrameImpl(agent, 'p1', d, sc, neverAbort, ['林川'])
    expect(image.generate).toHaveBeenCalledTimes(2)
    expect(compareImages).toHaveBeenCalledTimes(2)
    expect(agent.states.get('p1')!.logs.some((l) => l.message.includes('重抽后相似度仍偏低'))).toBe(true)
  })

  it('相似度依赖不可用（返回 null）：静默跳过，不重抽', async () => {
    const { agent, image } = makeAgent()
    ;(agent as unknown as { queue: unknown }).queue = { compareImages: vi.fn(async () => null) }
    const d = mkFrameD()
    await generateShotFirstFrameImpl(agent, 'p1', d, sc, neverAbort, ['林川'])
    expect(image.generate).toHaveBeenCalledTimes(1)
  })

  it('多人同框取最低相似度作为判定分', async () => {
    const { agent, image } = makeAgent()
    const compareImages = vi
      .fn()
      .mockResolvedValueOnce({ score: 0.9, method: 'face' })
      .mockResolvedValueOnce({ score: 0.4, method: 'face' })
      .mockResolvedValueOnce({ score: 0.9, method: 'face' })
      .mockResolvedValueOnce({ score: 0.9, method: 'face' })
    ;(agent as unknown as { queue: unknown }).queue = { compareImages }
    const d = mkFrameD({
      characters: [
        mkChar('林川', { id: 'c1', faceImagePath: 'projects/p1/characters/c1_face.png' }),
        mkChar('苏晚', { id: 'c2', faceImagePath: 'projects/p1/characters/c2_face.png' }),
      ],
    })
    await generateShotFirstFrameImpl(agent, 'p1', d, sc, neverAbort, ['林川', '苏晚'])
    // 第一轮最低 0.4 → 重抽；第二轮 0.9 → 放行
    expect(image.generate).toHaveBeenCalledTimes(2)
    expect(compareImages).toHaveBeenCalledTimes(4)
  })
})

// ===== buildShotsImpl =====

describe('buildShotsImpl', () => {
  const char = mkChar('林川', { faceImagePath: 'projects/p1/characters/c1_face.png' })
  const charMap = new Map<string, Character>([['林川', char]])
  /** 覆盖 mkShot 默认主角名：显式构造「无 characterName」的空镜 */
  const noCharacterName = (over: Parameters<typeof mkShot>[0] = {}) => {
    const s = mkShot(over)
    delete s.characterName
    return s
  }

  it('pano 全景板 + i2v 融合首帧 + 尾帧串行：全部落盘', async () => {
    const { agent, image, ffmpeg, store } = makeAgent()
    agent.store.get.mockImplementation(async () => mkProject({ characters: [char] }))
    const analysis: AnalyzeResult = { characters: [], shots: [mkShot()] }
    await buildShotsImpl(agent, 'p1', analysis, charMap)
    // 1) pano 全景板
    expect(image.generate.mock.calls[0]?.[2].workflowName).toBe('klein_t2i_clean')
    expect(ffmpeg.cropPanoramaViews).toHaveBeenCalledTimes(1)
    expect(ffmpeg.tileImages).toHaveBeenCalledTimes(1)
    // 2) i2v 融合首帧（qwen2511_i2i_edit）
    expect(image.generate.mock.calls[1]?.[2].workflowName).toBe('qwen2511_i2i_edit')
    // 3) 尾帧
    expect(image.generate).toHaveBeenCalledTimes(3)
    expect(image.generate.mock.calls[2]?.[0]).toContain('end')
    const saved = store.save.mock.calls[store.save.mock.calls.length - 1]?.[0] as Project
    expect(saved.shots).toHaveLength(1)
    expect(saved.shots[0]?.type).toBe('i2v')
    expect(saved.shots[0]?.status).toBe('pending')
    expect(saved.shots[0]?.shotSize).toBe('medium')
    expect(saved.shots[0]?.firstFramePath).toMatch(/_first\.png$/)
    expect(saved.shots[0]?.lastFramePath).toMatch(/_last\.png$/)
    expect(saved.sceneBoards?.[0]?.emptyPlatePath).toMatch(/v\d\.png$/)
    expect(agent.states.get('p1')!.totalShots).toBe(1)
    expect(agent.states.get('p1')!.stages.scenes.status).toBe('done')
  })

  it('panorama=false + candidates=1：单张场景板，t2v 空镜复用板', async () => {
    const { agent, image, store } = makeAgent()
    agent.settings.get.mockImplementation(async () =>
      mkSettings({
        creation: { scene: { panorama: false, candidates: 1 } },
      }),
    )
    agent.store.get.mockImplementation(async () => mkProject({ characters: [char] }))
    const t2vShot = noCharacterName({ type: 't2v', characters: [] })
    const analysis: AnalyzeResult = { characters: [], shots: [t2vShot] }
    await buildShotsImpl(agent, 'p1', analysis, charMap)
    expect(image.generate).toHaveBeenCalledTimes(1) // 场景板；t2v 复用板、无尾帧
    expect(image.generate.mock.calls[0]?.[2].workflowName).toBe('klein_t2i_clean')
    const saved = store.save.mock.calls[store.save.mock.calls.length - 1]?.[0] as Project
    expect(saved.shots[0]?.type).toBe('t2v')
    expect(saved.shots[0]?.sceneImagePath).toBe(saved.sceneBoards?.[0]?.emptyPlatePath)
    expect(saved.sceneBoards?.[0]?.emptyPlatePath).toMatch(/_plate\.png$/)
  })

  it('场景板失败 → 资产库复用成功（题材一致），t2v 空镜复用复用板', async () => {
    const { agent, image, store } = makeAgent()
    agent.settings.get.mockImplementation(async () =>
      mkSettings({
        render: { assetFallbackProjectId: 'fb1' },
      }),
    )
    const fb = mkProject({
      id: 'fb1',
      genre: '悬疑',
      sceneBoards: [mkBoard({ id: 'fb_b', emptyPlatePath: 'projects/fb1/scenes/old_plate.png' })],
    })
    agent.store.get.mockImplementation(async (id) => (id === 'fb1' ? fb : mkProject({ characters: [char] })))
    image.generate.mockRejectedValueOnce(new Error('pano down')) // 场景板失败
    const t2vShot = noCharacterName({ type: 't2v', characters: [] })
    await buildShotsImpl(agent, 'p1', { characters: [], shots: [t2vShot] }, charMap)
    const saved = store.save.mock.calls[store.save.mock.calls.length - 1]?.[0] as Project
    expect(saved.sceneBoards?.[0]?.emptyPlatePath).toBe(
      'projects/p1/scenes/' + saved.sceneBoards?.[0]?.id + '_plate.png',
    )
    expect(saved.shots[0]?.sceneImagePath).toBe(saved.sceneBoards?.[0]?.emptyPlatePath)
    const logs = agent.states.get('p1')!.logs
    expect(logs.some((l) => l.message.includes('已从资产库项目 fb1 复用场景板'))).toBe(true)
  })

  it('尾帧生成失败：frameFailed 计数并回退，阶段仍 done', async () => {
    const { agent, image, store } = makeAgent()
    agent.store.get.mockImplementation(async () => mkProject({ characters: [char] }))
    // 场景板(i2v 无 fusion 需 2 次)……简化：pano 板 1 次、首帧 fusion 1 次、尾帧失败
    image.generate
      .mockResolvedValueOnce(undefined) // pano 板
      .mockResolvedValueOnce(undefined) // 首帧 fusion
      .mockRejectedValueOnce(new Error('tail boom')) // 尾帧
    await buildShotsImpl(agent, 'p1', { characters: [], shots: [mkShot()] }, charMap)
    const saved = store.save.mock.calls[store.save.mock.calls.length - 1]?.[0] as Project
    expect(saved.shots[0]?.lastFramePath).toBeUndefined()
    expect(agent.states.get('p1')!.stages.scenes.status).toBe('done')
    const logs = agent.states.get('p1')!.logs
    expect(logs.some((l) => l.message.includes('尾帧失败'))).toBe(true)
    expect(logs.some((l) => l.message.includes('1 镜帧失败已回退'))).toBe(true)
  })

  it('取消：buildShots 拒绝 CANCELLED', async () => {
    const { agent } = makeAgent()
    agent.cancelled.add('p1')
    await expect(buildShotsImpl(agent, 'p1', { characters: [], shots: [mkShot()] }, charMap)).rejects.toThrow(
      'CANCELLED',
    )
  })
})
