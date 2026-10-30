/**
 * llmScriptOps 十个 async op 单元测试（2026-10-30）：
 * mock llmHttp（httpChat/httpChatRaw）与 llmRequest/llmPostProcess/llmParsers/
 * llmPromptsAnalyze/creationSettings/narrativeBeats/node:fs/node:fs/promises，
 * 不发真实网络请求、不读真实配置。cleanLlmOutput 已由 llmScriptOps.cleanLlmOutput.spec.ts 覆盖。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/main/core/llmHttp', () => ({
  httpChat: vi.fn(),
  httpChatRaw: vi.fn()
}))
vi.mock('../../src/main/core/llmRequest', () => ({
  logLlmError: vi.fn()
}))
vi.mock('../../src/main/core/llmPostProcess', () => ({
  enforcePromptLengths: vi.fn(async (_gs: unknown, scenes: unknown[], shots: unknown[], characters: unknown[]) => ({
    scenes,
    shots,
    characters
  })),
  backfillMissingProps: vi.fn()
}))
vi.mock('../../src/main/core/llmParsers', () => ({
  normalizeBindings: vi.fn((r: Record<string, unknown>) => ({ ...r }))
}))
vi.mock('../../src/main/core/llmPromptsAnalyze', () => ({
  analyzeSystemPrompt: vi.fn(() => 'SYSTEM_ANALYZE')
}))
vi.mock('../../src/shared/creationSettings', () => ({
  resolveCreation: vi.fn(() => ({
    storyboard: { temperature: 0.3, enforcePropLock: true, enforceReactionBeats: false, enforceBoardingChain: false }
  }))
}))
vi.mock('../../src/shared/narrativeBeats', () => ({
  validateNarrativeContinuity: vi.fn(() => [] as string[])
}))
vi.mock('node:fs', () => {
  const m = { mkdirSync: vi.fn(), writeFileSync: vi.fn() }
  return { ...m, default: m }
})
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  default: { readFile: vi.fn() }
}))

import fs from 'node:fs'
import { readFile } from 'node:fs/promises'
import { httpChat, httpChatRaw } from '../../src/main/core/llmHttp'
import { logLlmError } from '../../src/main/core/llmRequest'
import { enforcePromptLengths, backfillMissingProps } from '../../src/main/core/llmPostProcess'
import { normalizeBindings } from '../../src/main/core/llmParsers'
import { analyzeSystemPrompt } from '../../src/main/core/llmPromptsAnalyze'
import { validateNarrativeContinuity } from '../../src/shared/narrativeBeats'
import type { AppSettings, GenreTemplate } from '../../src/shared/ipcTypes'
import type { FieldFillGuide } from '../../src/shared/promptAudit'
import {
  pickCandidateOp,
  translatePromptOp,
  optimizePromptOp,
  fillPromptFieldOp,
  translateTextOp,
  writeScriptOp,
  writeScriptFromFramesOp,
  reviewScriptOp,
  splitScriptOp,
  analyzeOp
} from '../../src/main/core/llmScriptOps'

type Mock = ReturnType<typeof vi.fn>
const chat = httpChat as unknown as Mock
const chatRaw = httpChatRaw as unknown as Mock
const logErr = logLlmError as unknown as Mock
const fsMock = fs as unknown as { mkdirSync: Mock; writeFileSync: Mock }
const readFileMock = readFile as unknown as Mock
const enforceMock = enforcePromptLengths as unknown as Mock
const backfillMock = backfillMissingProps as unknown as Mock
const normalizeMock = normalizeBindings as unknown as Mock
const analyzePromptMock = analyzeSystemPrompt as unknown as Mock
const narrativeMock = validateNarrativeContinuity as unknown as Mock

const getSettings = vi.fn(async () =>
  ({ llm: { model: 'ds-chat', apiKey: 'sk-test', baseUrl: 'https://api.test' } }) as unknown as AppSettings
)

const ANCIENT: GenreTemplate = { key: 'ancient', label: '古装', promptStyle: '水墨古风' }
const TPLS: GenreTemplate[] = [ANCIENT]

beforeEach(() => {
  chat.mockClear().mockResolvedValue('OK')
  chatRaw.mockClear().mockResolvedValue('RAW_OK')
  logErr.mockClear()
  fsMock.mkdirSync.mockClear()
  fsMock.writeFileSync.mockClear()
  readFileMock.mockReset()
  enforceMock.mockClear()
  backfillMock.mockClear()
  normalizeMock.mockClear()
  analyzePromptMock.mockClear()
  narrativeMock.mockClear().mockReturnValue([])
  getSettings.mockClear()
})

// ---------------------------------------------------------------- pickCandidateOp

describe('pickCandidateOp · 多候选抽卡', () => {
  const candidates = [
    { index: 1, seed: 100, note: '' },
    { index: 2, seed: 200, score: 0.87, note: '表情自然' },
    { index: 3, seed: 300, score: 0.5, note: '模糊' }
  ]

  it('正常 JSON → 返回 index/reason；列表含 score=n/a 与（无）占位', async () => {
    chat.mockResolvedValueOnce('{"index":2,"reason":"人脸清晰"}')
    const out = await pickCandidateOp(getSettings, { kind: 'character', brief: '雨夜天台', candidates })
    expect(out).toEqual({ index: 2, reason: '人脸清晰' })
    expect(chat).toHaveBeenCalledWith(
      getSettings,
      expect.stringContaining('人物定妆'),
      expect.stringContaining('score=n/a'),
      0.2,
      60000
    )
    const user = chat.mock.calls[0][2] as string
    expect(user).toContain('note=（无）')
    expect(user).toContain('#2 seed=200 score=0.87 note=表情自然')
  })

  it('markdown 围栏 + 字符串数字 index 也能解析；kind=scene/render 标签切换', async () => {
    chat.mockResolvedValueOnce('```json\n{"index":"1","reason":""}\n```')
    const out = await pickCandidateOp(getSettings, { kind: 'scene', brief: 'b', candidates })
    expect(out).toEqual({ index: 1, reason: '选中 #1' })
    expect(chat.mock.calls[0][1]).toContain('场景板')
    chat.mockResolvedValueOnce('{"index":3,"reason":"动作匹配"}')
    await pickCandidateOp(getSettings, { kind: 'render', brief: 'b', candidates })
    expect(chat.mock.calls[1][1]).toContain('镜头成片')
  })

  it('无花括号 → 抽卡输出格式异常', async () => {
    chat.mockResolvedValueOnce('模型没有返回 JSON')
    await expect(pickCandidateOp(getSettings, { kind: 'character', brief: 'b', candidates }))
      .rejects.toThrow(/抽卡输出格式异常/)
  })

  it('只有 { 没有 } → 同样格式异常', async () => {
    chat.mockResolvedValueOnce('{"index":1')
    await expect(pickCandidateOp(getSettings, { kind: 'scene', brief: 'b', candidates }))
      .rejects.toThrow(/抽卡输出格式异常/)
  })

  it('index 越界/为 0/非数字 → 抽卡序号非法', async () => {
    chat.mockResolvedValueOnce('{"index":0,"reason":"x"}')
    await expect(pickCandidateOp(getSettings, { kind: 'character', brief: 'b', candidates }))
      .rejects.toThrow(/抽卡序号非法: 0/)
    chat.mockResolvedValueOnce('{"index":4,"reason":"x"}')
    await expect(pickCandidateOp(getSettings, { kind: 'character', brief: 'b', candidates }))
      .rejects.toThrow(/抽卡序号非法: 4/)
    chat.mockResolvedValueOnce('{"index":"abc"}')
    await expect(pickCandidateOp(getSettings, { kind: 'character', brief: 'b', candidates }))
      .rejects.toThrow(/抽卡序号非法: abc/)
  })

  it('花括号内非法 JSON → JSON.parse SyntaxError 原样抛出', async () => {
    chat.mockResolvedValueOnce('{bad json}')
    await expect(pickCandidateOp(getSettings, { kind: 'character', brief: 'b', candidates }))
      .rejects.toBeInstanceOf(SyntaxError)
  })
})

// ---------------------------------------------------------------- translatePromptOp

describe('translatePromptOp · 中文分镜→英文提示词', () => {
  it('命中题材模板 → system 带风格前缀；空 scene 用「未指定」；空 dialogue 行省略', async () => {
    const out = await translatePromptOp(getSettings, TPLS, { scene: '', action: 'A walks slowly', dialogue: '', genre: 'ancient' })
    expect(out).toBe('OK')
    expect(chat).toHaveBeenCalledWith(getSettings, expect.any(String), expect.any(String), 0.5)
    expect(chat.mock.calls[0][1]).toContain('Style prefix to weave in: 水墨古风')
    const user = chat.mock.calls[0][2] as string
    expect(user).toContain('场景: 未指定')
    expect(user).not.toContain('台词情绪参考')
  })

  it('未命中模板 → 无风格前缀；有 dialogue → 带台词情绪参考', async () => {
    await translatePromptOp(getSettings, TPLS, { scene: '天台', action: 'a', dialogue: '你终于来了', genre: 'modern' })
    expect(chat.mock.calls[0][1]).not.toContain('Style prefix')
    expect(chat.mock.calls[0][2]).toContain('台词情绪参考: 你终于来了')
  })
})

// ---------------------------------------------------------------- optimizePromptOp

describe('optimizePromptOp · 提示词优化', () => {
  it('positive（显式）→ 影像级工程师 system，用户消息带原始内容', async () => {
    const out = await optimizePromptOp(getSettings, '一个女孩在雨中', 'positive')
    expect(out).toBe('OK')
    expect(chat).toHaveBeenCalledWith(getSettings, expect.stringContaining('cinematic prompt engineer'), '原始内容: 一个女孩在雨中', 0.5)
  })

  it('negative → 负面压制 system', async () => {
    await optimizePromptOp(getSettings, 'blurry, extra fingers', 'negative')
    expect(chat.mock.calls[0][1]).toContain('negative prompt')
  })

  it('缺省 kind → 走 positive 分支', async () => {
    await optimizePromptOp(getSettings, 'x')
    expect(chat.mock.calls[0][1]).toContain('cinematic prompt engineer')
  })
})

// ---------------------------------------------------------------- fillPromptFieldOp

describe('fillPromptFieldOp · 字段级补写', () => {
  const enGuide = (min: number, max: number, mustAvoid?: string[]): FieldFillGuide =>
    ({ field: 'promptEn', label: '英文提示词', lang: 'en', range: [min, max], role: '画面动作', mustAvoid })
  const zhGuide = (min: number, max: number): FieldFillGuide =>
    ({ field: 'dialogue', label: '台词', lang: 'zh', range: [min, max], role: '中文台词' })

  it('首遍达标 → 直接返回；全量上下文注入 user；温度/超时/maxTokens 透传', async () => {
    chat.mockResolvedValueOnce('a slow gentle walk in the rain, soft light')
    const out = await fillPromptFieldOp(getSettings, enGuide(5, 10, ['禁止示例剧情']), {
      currentText: 'old text',
      scene: '雨夜天台',
      sceneEn: 'rooftop night rain',
      action: 'walks slowly',
      shotSize: 'closeup',
      type: 'i2v',
      characterName: '林澈',
      characterLocks: 'tall man in black coat',
      props: '雨伞',
      era: '现代',
      issue: 'promptEn 缺光源'
    })
    expect(out).toBe('a slow gentle walk in the rain, soft light')
    expect(chat).toHaveBeenCalledWith(getSettings, expect.any(String), expect.any(String), 0.6, 90000, 2048)
    const system = chat.mock.calls[0][1] as string
    expect(system).toContain('5~10 词')
    expect(system).toContain('英文')
    expect(system).toContain('- 禁止示例剧情')
    const user = chat.mock.calls[0][2] as string
    for (const frag of ['场景：雨夜天台', '已锁环境短语', '本镜动作', '景别：closeup', '镜头类型：i2v', '出场角色：林澈', '定妆外观锁', '本镜道具：雨伞', '时代：现代', '体检问题', '当前字段内容（可保留其中合理部分', 'old text']) {
      expect(user).toContain(frag)
    }
  })

  it('最小上下文（仅空 currentText）→「（空）」占位，可选行省略；maxW=0 无上限文案', async () => {
    chat.mockResolvedValueOnce('雨中漫步慢动作特写')
    const out = await fillPromptFieldOp(getSettings, zhGuide(5, 0), { currentText: '' })
    expect(out).toBe('雨中漫步慢动作特写')
    expect(chat.mock.calls[0][1]).toContain('≥5 词（无上限）')
    expect(chat.mock.calls[0][1]).not.toContain('【禁止项】')
    const user = chat.mock.calls[0][2] as string
    expect(user).toContain('当前字段内容（可保留其中合理部分，但必须满足字数与语义）：（空）')
    expect(user).not.toContain('- 场景：')
  })

  it('首遍字数不足 → 自动重试一次达标（重试 user 含失败原因与硬性重写要求）', async () => {
    chat
      .mockResolvedValueOnce('雨')
      .mockResolvedValueOnce('雨中漫步慢动作特写')
    const out = await fillPromptFieldOp(getSettings, zhGuide(5, 30), { currentText: '' })
    expect(out).toBe('雨中漫步慢动作特写')
    expect(chat).toHaveBeenCalledTimes(2)
    const retryUser = chat.mock.calls[1][2] as string
    expect(retryUser).toContain('【上一次输出不达标】')
    expect(retryUser).toContain('【硬性重写要求】')
    expect(retryUser).toContain('目标约 18 词')
    expect(retryUser).toContain('上一次输出（参考')
  })

  it('清洗后为空（非字数错误）→ 不重试直接抛', async () => {
    chat.mockResolvedValueOnce('   ')
    await expect(fillPromptFieldOp(getSettings, zhGuide(5, 30), { currentText: '' }))
      .rejects.toThrow(/LLM 返回为空/)
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('重试仍不达标 → 抛出区间错误', async () => {
    chat.mockResolvedValue('雨')
    await expect(fillPromptFieldOp(getSettings, zhGuide(5, 30), { currentText: '' }))
      .rejects.toThrow(/超出区间/)
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it('maxW=0 时不足 → 重试目标为 minW+10，区间文案 5~∞', async () => {
    chat.mockResolvedValueOnce('雨').mockResolvedValueOnce('雨中漫步慢动作特写')
    const out = await fillPromptFieldOp(getSettings, zhGuide(5, 0), { currentText: '' })
    expect(out).toBe('雨中漫步慢动作特写')
    expect(chat.mock.calls[1][2]).toContain('严格控制在 5~∞ 词，目标约 15 词')
  })
})

// ---------------------------------------------------------------- translateTextOp

describe('translateTextOp · 中英互译', () => {
  it('透传 httpChat 结果，温度 0.3', async () => {
    chat.mockResolvedValueOnce('a gentle rain, depth of field')
    const out = await translateTextOp(getSettings, '柔和的雨景，浅景深')
    expect(out).toBe('a gentle rain, depth of field')
    expect(chat).toHaveBeenCalledWith(getSettings, expect.stringContaining('professional translator'), '柔和的雨景，浅景深', 0.3)
  })

  it('底层请求失败 → 原样抛出', async () => {
    chat.mockRejectedValueOnce(new Error('网络超时'))
    await expect(translateTextOp(getSettings, 'x')).rejects.toThrow('网络超时')
  })
})

// ---------------------------------------------------------------- writeScriptOp

describe('writeScriptOp · 想法扩写剧本', () => {
  it('模板+片名+题材齐全 → system 带风格与钩子，user 带片名与题材 label', async () => {
    chat.mockResolvedValueOnce('【第1场 · 雨夜天台】...')
    const out = await writeScriptOp(getSettings, TPLS, '一个失散兄妹雨夜重逢', 'ancient', '雨夜')
    expect(out).toBe('【第1场 · 雨夜天台】...')
    expect(chat).toHaveBeenCalledWith(getSettings, expect.any(String), expect.any(String), 0.8, 300000)
    expect(chat.mock.calls[0][1]).toContain('题材风格：水墨古风，开篇 20 字内要有钩子')
    expect(chat.mock.calls[0][2]).toContain('片名：《雨夜》')
    expect(chat.mock.calls[0][2]).toContain('题材：古装')
  })

  it('无片名 + 题材未命中模板 → 片名行省略，题材回退 genre 原值', async () => {
    await writeScriptOp(getSettings, TPLS, '灵感', 'modern')
    const user = chat.mock.calls[0][2] as string
    expect(user).not.toContain('片名：')
    expect(user).toContain('题材：modern')
    expect(chat.mock.calls[0][1]).not.toContain('题材风格')
  })

  it('genre 为空 → 题材行整体省略', async () => {
    await writeScriptOp(getSettings, TPLS, '灵感', '')
    expect(chat.mock.calls[0][2]).not.toContain('题材：')
  })
})

// ---------------------------------------------------------------- writeScriptFromFramesOp

describe('writeScriptFromFramesOp · 关键帧多模态写剧本', () => {
  it('抽帧成功 → base64 data URL（jpg→jpeg、无扩展名→png 兜底），body 结构完整', async () => {
    readFileMock.mockResolvedValue(Buffer.from('imagedata'))
    const out = await writeScriptFromFramesOp(getSettings, TPLS, ['C:\\v\\f1.jpg', 'C:\\v\\f2.PNG', 'C:\\v\\f3'], 'ancient')
    expect(out).toBe('RAW_OK')
    expect(chatRaw).toHaveBeenCalledWith(getSettings, expect.any(Object), 180000)
    const body = chatRaw.mock.calls[0][1] as Record<string, any>
    expect(body.model).toBe('ds-chat')
    expect(body.temperature).toBe(0.7)
    expect(body.effort).toBe('low')
    expect(body.max_tokens).toBe(3000)
    expect(body.messages[0].content).toContain('题材风格：水墨古风')
    const content = body.messages[1].content as any[]
    expect(content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('3 帧关键画面') })
    expect(content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/)
    expect(content[2].image_url.url).toMatch(/^data:image\/png;base64,/)
    expect(content[3].image_url.url).toMatch(/^data:image\/png;base64,/)
  })

  it('部分帧读取失败 → 仅有效帧入参', async () => {
    readFileMock.mockImplementation(async (p: string) => {
      if (p.includes('bad')) throw new Error('ENOENT')
      return Buffer.from('d')
    })
    await writeScriptFromFramesOp(getSettings, TPLS, ['C:\\v\\good.png', 'C:\\v\\bad.png'], 'unknown-genre')
    const body = chatRaw.mock.calls[0][1] as Record<string, any>
    expect(body.messages[1].content[0].text).toContain('1 帧')
    expect(body.messages[0].content).not.toContain('题材风格')
  })

  it('全部帧读取失败 → 抛「视频抽帧读取失败」，不发请求', async () => {
    readFileMock.mockRejectedValue(new Error('ENOENT'))
    await expect(writeScriptFromFramesOp(getSettings, TPLS, ['a.png', 'b.png'], 'ancient'))
      .rejects.toThrow(/视频抽帧读取失败/)
    expect(chatRaw).not.toHaveBeenCalled()
  })

  it('空帧列表 → 同样抛错', async () => {
    await expect(writeScriptFromFramesOp(getSettings, TPLS, [], 'ancient')).rejects.toThrow(/视频抽帧读取失败/)
  })
})

// ---------------------------------------------------------------- reviewScriptOp

describe('reviewScriptOp · AI 剧本医生', () => {
  const validRaw = '```json\n' + JSON.stringify({
    issues: [
      { severity: 'block', scene: '第2场', problem: '道具凭空出现', suggestion: '第1场交代去向' },
      { severity: 'warn', scene: '', problem: '节奏偏慢', suggestion: '' },
      { problem: '', suggestion: '' },
      { severity: 'other', scene: ' 第3场 ', problem: ' p ', suggestion: ' s ' }
    ],
    revisedScript: '【第1场 · 天台】完整剧本'
  }) + '\n```'

  it('正常 JSON → issues 过滤+severity 归一+trim，revisedScript 返回', async () => {
    chat.mockResolvedValueOnce(validRaw)
    const out = await reviewScriptOp(getSettings, TPLS, '原剧本', 'ancient', '雨夜')
    expect(out.revisedScript).toBe('【第1场 · 天台】完整剧本')
    expect(out.issues).toEqual([
      { severity: 'block', scene: '第2场', problem: '道具凭空出现', suggestion: '第1场交代去向' },
      { severity: 'warn', scene: '', problem: '节奏偏慢', suggestion: '' },
      { severity: 'warn', scene: '第3场', problem: 'p', suggestion: 's' }
    ])
    expect(chat).toHaveBeenCalledWith(getSettings, expect.any(String), '原剧本', 0.4, 300000)
    const system = chat.mock.calls[0][1] as string
    expect(system).toContain('题材风格基调：水墨古风')
    expect(system).toContain('片名：《雨夜》')
    expect(logErr).not.toHaveBeenCalled()
  })

  it('无花括号 → 格式异常 + logLlmError(reviewScript.parse)', async () => {
    chat.mockResolvedValueOnce('剧本没有问题，无需修改')
    await expect(reviewScriptOp(getSettings, TPLS, 's', 'ancient')).rejects.toThrow(/剧本医生返回格式异常/)
    expect(logErr).toHaveBeenCalledWith('reviewScript.parse', expect.any(Error))
  })

  it('花括号内非法 JSON → JSON 解析失败 + logLlmError(reviewScript.jsonParse)', async () => {
    chat.mockResolvedValueOnce('{issues: [bad]}')
    await expect(reviewScriptOp(getSettings, TPLS, 's', 'ancient')).rejects.toThrow(/剧本医生 JSON 解析失败/)
    expect(logErr).toHaveBeenCalledWith('reviewScript.jsonParse', expect.any(Error))
  })

  it('revisedScript 为空 → 抛「未返回修改后的剧本」+ logLlmError', async () => {
    chat.mockResolvedValueOnce('{"issues":[],"revisedScript":"   "}')
    await expect(reviewScriptOp(getSettings, TPLS, 's', 'ancient')).rejects.toThrow(/未返回修改后的剧本/)
    expect(logErr).toHaveBeenCalledWith('reviewScript.emptyRevised', expect.any(Error))
  })

  it('issues 非数组 → 归一为空数组；无 title/模板时 system 省略对应行', async () => {
    chat.mockResolvedValueOnce('{"issues":"oops","revisedScript":"剧本"}')
    const out = await reviewScriptOp(getSettings, TPLS, 's', 'modern')
    expect(out.issues).toEqual([])
    expect(chat.mock.calls[0][1]).not.toContain('题材风格基调')
    expect(chat.mock.calls[0][1]).not.toContain('片名：')
  })
})

// ---------------------------------------------------------------- splitScriptOp

describe('splitScriptOp · AI 拆分镜', () => {
  it('正常数组 → 过滤无效项 + 字段兜底清洗（type 归一/camera 非串省略）', async () => {
    chat.mockResolvedValueOnce('```json\n[\n  {"scene":"雨夜","action":"walking slowly","dialogue":"","type":"t2v","camera":"static camera","emotion":"calm"},\n  {"action":"  sits down  ","type":"i2v"},\n  {"scene":"x","action":"   "},\n  {"action":123},\n  null\n]\n```')
    const out = await splitScriptOp(getSettings, TPLS, '剧本', 'ancient')
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      scene: '雨夜',
      action: 'walking slowly',
      dialogue: '',
      type: 't2v',
      camera: 'static camera',
      emotion: 'calm'
    })
    expect(out[1]).toEqual({ scene: '', action: 'sits down', dialogue: '', type: 'i2v', camera: undefined, emotion: undefined })
    expect(chat).toHaveBeenCalledWith(getSettings, expect.stringContaining('题材风格: 水墨古风'), '剧本', 0.7, 120000)
  })

  it('无方括号 → 抛「无法解析分镜列表」', async () => {
    chat.mockResolvedValueOnce('这不是 JSON')
    await expect(splitScriptOp(getSettings, TPLS, 's', 'ancient')).rejects.toThrow(/无法解析分镜列表/)
  })

  it('] 在 [ 之前（end<=start）→ 同样抛格式异常', async () => {
    chat.mockResolvedValueOnce('][')
    await expect(splitScriptOp(getSettings, TPLS, 's', 'ancient')).rejects.toThrow(/无法解析分镜列表/)
  })

  it('空数组 → 抛「未拆分出任何分镜」', async () => {
    chat.mockResolvedValueOnce('[]')
    await expect(splitScriptOp(getSettings, TPLS, 's', 'ancient')).rejects.toThrow(/未拆分出任何分镜/)
  })

  it('数组内非法 JSON → SyntaxError 原样抛出', async () => {
    chat.mockResolvedValueOnce('[bad]')
    await expect(splitScriptOp(getSettings, TPLS, 's', 'ancient')).rejects.toBeInstanceOf(SyntaxError)
  })

  it('题材未命中模板 → system 无风格行', async () => {
    chat.mockResolvedValueOnce('[{"action":"a"}]')
    await splitScriptOp(getSettings, TPLS, 's', 'modern')
    expect(chat.mock.calls[0][1]).not.toContain('题材风格')
  })
})

// ---------------------------------------------------------------- analyzeOp

const MIN_ANALYZE = JSON.stringify({
  characters: [{ name: '甲' }],
  shots: [{ action: 'walks slowly' }]
})

describe('analyzeOp · AI 导演剧本分析', () => {
  it('完整载荷 → 角色/分镜/道具/场景全字段归一并落盘 last-ok', async () => {
    const full = {
      logline: '雨夜寻亲',
      characters: [
        { name: ' 林澈 ', gender: 'male', age: 28, appearance: '高瘦', lookEn: 'tall man', aliases: ['林队', ''], confidence: 'high' },
        { name: '苏黎', gender: 'x', age: 0, appearance: '', lookEn: '', confidence: 'weird' },
        null,
        { nickname: '无名字' },
        { name: 123 }
      ],
      shots: [
        {
          scene: '雨夜天台', action: 'walks slowly', dialogue: '你来了', type: 'i2v', characterName: '林澈',
          shotSize: 'ECU', props: ['雨伞', ''], transition: 'dissolve', frameSeconds: 10,
          camera: 'slow push-in', emotion: 'tense', lighting: 'dim', facing: 'left', continuity: 'c1',
          promptEn: 'pe', negativeEn: 'ne', firstFrameEn: 'ff', midFrameEn: 'mf', lastFrameEn: 'lf',
          handoffToNext: 'h', transitionEn: 'te', sceneEn: 'rooftop night'
        },
        { action: 'empty street at dawn', type: 't2v', shotSize: 'wide', frameSeconds: 1 },
        { action: 'a man turns', type: 'other', shotSize: 'long shot' },
        { action: 'z', type: 'i2v', shotSize: 'garbage', transition: 'hard', frameSeconds: 0 },
        { action: 'x', type: 'i2v', shotSize: 'medium shot', frameSeconds: 4.5 },
        null,
        { noAction: 1 },
        { action: 5 }
      ],
      props: [
        { zh: '雨伞', en: 'umbrella', description: '黑色长柄' },
        { zh: '  ', en: 'x' },
        { en: 'no zh' },
        { zh: '怀表' }
      ],
      scenes: [{ name: '天台', en: 'rooftop' }, null, { nope: 1 }]
    }
    chat.mockResolvedValueOnce('```json\n' + JSON.stringify(full) + '\n```')
    const r = await analyzeOp(getSettings, TPLS, '剧本全文', 'ancient', { title: ' 雨夜 ', extraRules: ['r1'] })

    expect(analyzePromptMock).toHaveBeenCalledWith(expect.objectContaining({ titleHint: '雨夜', tpl: ANCIENT, extraRules: ['r1'] }))
    expect(chat).toHaveBeenCalledWith(getSettings, 'SYSTEM_ANALYZE', '剧本全文', 0.3, 1200000, 32768, undefined)
    expect(r.logline).toBe('雨夜寻亲')

    expect(r.characters).toHaveLength(2)
    expect(r.characters[0]).toMatchObject({ name: '林澈', gender: 'male', age: '28', aliases: ['林队'], confidence: 'high', lookEn: 'tall man' })
    expect(r.characters[1]).toMatchObject({ gender: 'female', age: undefined, lookEn: 'attractive person', aliases: undefined, confidence: undefined })

    expect(r.shots).toHaveLength(5)
    expect(r.shots[0]).toMatchObject({ shotSize: 'closeup', frameSeconds: 6, characters: ['林澈'], props: ['雨伞'], transition: 'dissolve', sceneEn: 'rooftop night', type: 'i2v' })
    expect(r.shots[1]).toMatchObject({ type: 't2v', shotSize: undefined, characterName: undefined, frameSeconds: 3 })
    expect(r.shots[2]).toMatchObject({ type: 'i2v', shotSize: 'wide' })
    expect(r.shots[3]).toMatchObject({ shotSize: 'medium', transition: 'hard', frameSeconds: undefined })
    expect(r.shots[4]).toMatchObject({ shotSize: 'medium', frameSeconds: 5 })

    expect(r.props).toHaveLength(2)
    expect(r.props![0]).toMatchObject({ zh: '雨伞', en: 'umbrella', description: '黑色长柄' })
    expect(r.props![0].id).toMatch(/^prop_/)
    expect(r.props![1]).toMatchObject({ zh: '怀表', en: '怀表', description: undefined })

    expect(r.scenes).toEqual([{ name: '天台', en: 'rooftop' }])
    expect(r.warnings).toBeUndefined()

    expect(fsMock.writeFileSync).toHaveBeenCalledWith(expect.stringContaining('analyze-last-ok.json'), expect.stringContaining('雨夜寻亲'), 'utf-8')
    expect(enforceMock).toHaveBeenCalledTimes(1)
    expect(normalizeMock).toHaveBeenCalledTimes(1)
    expect(backfillMock).toHaveBeenCalledTimes(1)
    expect(narrativeMock).toHaveBeenCalledWith(
      '雨夜',
      '雨夜寻亲',
      '剧本全文',
      expect.any(Array),
      { enforcePropLock: true, enforceReactionBeats: false, enforceBoardingChain: false }
    )
  })

  it('无花括号 → 抛「无法解析分析结果」', async () => {
    chat.mockResolvedValueOnce('分析失败')
    await expect(analyzeOp(getSettings, TPLS, 's', 'ancient')).rejects.toThrow(/无法解析分析结果/)
  })

  it('字符串含裸控制字符（\\u000b）→ 本地清洗后解析成功，不重发请求', async () => {
    chat.mockResolvedValueOnce('{"logline":"x","characters":[{"name":"甲"}],"shots":[{"action":"walk\u000bing"}]}')
    const r = await analyzeOp(getSettings, TPLS, 's', 'ancient')
    expect(r.shots[0].action).toBe('walk ing')
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('无控制字符的坏 JSON → 带修复指令重试一次成功', async () => {
    chat.mockResolvedValueOnce('{"oops}').mockResolvedValueOnce(MIN_ANALYZE)
    const r = await analyzeOp(getSettings, TPLS, 's', 'ancient')
    expect(r.characters[0].name).toBe('甲')
    expect(chat).toHaveBeenCalledTimes(2)
    expect(chat.mock.calls[1][1]).toContain('上次输出的 JSON 解析失败')
    expect(chat.mock.calls[1][1]).toContain('SYSTEM_ANALYZE')
  })

  it('修复重试输出仍非 JSON → 抛「修复输出仍非 JSON」', async () => {
    chat.mockResolvedValueOnce('{"oops}').mockResolvedValueOnce('仍然不是 JSON')
    await expect(analyzeOp(getSettings, TPLS, 's', 'ancient')).rejects.toThrow(/修复输出仍非 JSON/)
  })

  it('清洗后仍非法 → 两次解析失败，落盘 analyze-raw-dump.json', async () => {
    chat.mockResolvedValueOnce('{"shots":[{"action":"a\u000bb"},]}')
    await expect(analyzeOp(getSettings, TPLS, 's', 'ancient')).rejects.toThrow(/两次解析失败/)
    expect(fsMock.writeFileSync).toHaveBeenCalledWith(expect.stringContaining('analyze-raw-dump.json'), expect.any(String), 'utf-8')
  })

  it('characters 缺失/无 name → 抛「未识别出任何角色」', async () => {
    chat.mockResolvedValueOnce('{"shots":[{"action":"a"}]}')
    await expect(analyzeOp(getSettings, TPLS, 's', 'ancient')).rejects.toThrow(/未识别出任何角色/)
  })

  it('shots 为空数组 → 抛「未拆分出任何分镜」', async () => {
    chat.mockResolvedValueOnce('{"characters":[{"name":"甲"}],"shots":[]}')
    await expect(analyzeOp(getSettings, TPLS, 's', 'ancient')).rejects.toThrow(/未拆分出任何分镜/)
  })

  it('title 非字符串 → titleHint 归一为空串；缺 props/scenes → 结果为 undefined', async () => {
    chat.mockResolvedValueOnce(MIN_ANALYZE)
    const r = await analyzeOp(getSettings, TPLS, 's', 'modern', { title: { obj: 1 } as unknown as string })
    expect(r.logline).toBeUndefined()
    expect(r.props).toBeUndefined()
    expect(r.scenes).toBeUndefined()
    expect(narrativeMock.mock.calls[0][0]).toBe('')
    expect(analyzePromptMock.mock.calls[0][0]).toMatchObject({ titleHint: '', tpl: undefined })
  })

  it('诊断落盘抛错（只读目录）→ 不阻断主流程', async () => {
    chat.mockResolvedValueOnce(MIN_ANALYZE)
    fsMock.mkdirSync.mockImplementationOnce(() => { throw new Error('EROFS') })
    await expect(analyzeOp(getSettings, TPLS, 's', 'ancient')).resolves.toMatchObject({ logline: undefined })
  })

  it('叙事连续性返回警告 → 合并进 warnings', async () => {
    chat.mockResolvedValueOnce(MIN_ANALYZE)
    narrativeMock.mockReturnValueOnce(['警告：台词与动作矛盾'])
    const r = await analyzeOp(getSettings, TPLS, 's', 'ancient')
    expect(r.warnings).toEqual(['警告：台词与动作矛盾'])
  })

  // P1-2：长耗时分析支持取消 —— 显式传入的 AbortSignal 必须透传给 HTTP 层
  it('P1-2：opts.signal 透传给 httpChat（首次调用与 JSON 修复重试都带）', async () => {
    const ac = new AbortController()
    chat.mockResolvedValueOnce(MIN_ANALYZE)
    await analyzeOp(getSettings, TPLS, 's', 'ancient', { signal: ac.signal })
    expect(chat).toHaveBeenLastCalledWith(getSettings, 'SYSTEM_ANALYZE', 's', 0.3, 1200000, 32768, ac.signal)
  })
})
