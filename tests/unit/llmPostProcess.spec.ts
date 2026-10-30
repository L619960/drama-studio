/**
 * llmPostProcess 覆盖率补充（2026-10-30）：
 * - foldName / escapeRegExp 逐分支
 * - enforcePromptLengths：全达标早退 / LLM 整改合并（shot/scene/char/别名/垃圾条目过滤）/
 *   无 JSON / JSON 解析失败 / 空 fixes / 调用抛错 / 2 轮仍超限确定性截断 /
 *   位移镜 transitionEn 兜底生成 / 非位移镜剥除尾帧转场 / 套话 / 串台禁词 /
 *   语义脱节 / 多镜批量 / fs 落盘与失败吞异常
 * - backfillMissingProps：已分配（props/action）/ i2v 注入 / 全 t2v 注入 / 无镜头警告 /
 *   en 空回退 zh / 保留原 warnings / 多道具
 * 不发真实网络请求：httpChat 与 node:fs 全 mock。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { appendFileSyncMock } = vi.hoisted(() => ({ appendFileSyncMock: vi.fn() }))

vi.mock('node:fs', () => {
  const m = { appendFileSync: (...args: unknown[]) => appendFileSyncMock(...args) }
  return { ...m, default: m }
})

vi.mock('../../src/main/core/llmHttp', () => ({
  httpChat: vi.fn()
}))

import { httpChat } from '../../src/main/core/llmHttp'
import type {
  AppSettings,
  AnalyzeResult,
  AnalyzeScene,
  AnalyzedCharacter,
  AnalyzedShot,
  PropAsset
} from '../../src/shared/ipcTypes'
import { foldName, escapeRegExp, enforcePromptLengths, backfillMissingProps } from '../../src/main/core/llmPostProcess'

const chat = httpChat as unknown as ReturnType<typeof vi.fn>
const getSettings = vi.fn(async (): Promise<AppSettings> => ({}) as AppSettings)

/** 生成 n 个英文词（L() 计数 = n；语义对齐 words() 归一后全部折叠为 prefix 一词，便于构造达标/脱节） */
const w = (n: number, prefix = 'word'): string =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ')

const wc = (t?: string): number => (t ? t.trim().split(/\s+/).length : 0)

/** 全字段达标的 i2v 镜（非位移 action，无 midFrameEn） */
const okShot = (o: Partial<AnalyzedShot> = {}): AnalyzedShot => ({
  scene: '客厅',
  action: 'The woman stands still.',
  dialogue: '',
  type: 'i2v',
  sceneEn: w(40),
  promptEn: w(70),
  negativeEn: '',
  firstFrameEn: w(25),
  ...o
})

const okScene = (name = 'S', o: Partial<AnalyzeScene> = {}): AnalyzeScene => ({ name, en: w(50), ...o })

const okChar = (name = '林川', o: Partial<AnalyzedCharacter> = {}): AnalyzedCharacter => ({
  name,
  gender: 'male',
  appearance: '',
  lookEn: w(35),
  ...o
})

const prop = (zh: string, en: string): PropAsset => ({ id: zh, zh, en })

beforeEach(() => {
  chat.mockReset()
  appendFileSyncMock.mockReset()
})

// ============ foldName ============
describe('foldName', () => {
  it('去首尾空白 + 小写 + 删除内部空白', () => {
    expect(foldName('  Ab Cd  ')).toBe('abcd')
  })
  it('制表/换行等空白一并删除', () => {
    expect(foldName('A\tB\nC')).toBe('abc')
  })
  it('中文不受大小写影响，仅去空白', () => {
    expect(foldName('林 川')).toBe('林川')
  })
  it('空串 → 空串', () => {
    expect(foldName('')).toBe('')
  })
})

// ============ escapeRegExp ============
describe('escapeRegExp', () => {
  it('转义全部正则特殊字符', () => {
    expect(escapeRegExp('a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o')).toBe(
      'a\\.b\\*c\\+d\\?e\\^f\\$g\\{h\\}i\\(j\\)k\\|l\\[m\\]n\\\\o'
    )
  })
  it('普通字符原样保留', () => {
    expect(escapeRegExp('paper bag 林川')).toBe('paper bag 林川')
  })
  it('转义后可作字面量正则匹配', () => {
    const re = new RegExp(escapeRegExp('a.b'))
    expect(re.test('a.b')).toBe(true)
    expect(re.test('axb')).toBe(false)
  })
})

// ============ enforcePromptLengths ============
describe('enforcePromptLengths', () => {
  let warnSpy: ReturnType<typeof vi.spyOn> | undefined
  afterEach(() => {
    warnSpy?.mockRestore()
    warnSpy = undefined
  })

  it('全部达标 → 原样早退，不调用 LLM', async () => {
    const scenes = [okScene()]
    const shots = [okShot()]
    const chars = [okChar()]
    const out = await enforcePromptLengths(getSettings, scenes, shots, chars)
    expect(out.scenes).toBe(scenes)
    expect(out.shots).toBe(shots)
    expect(out.characters).toBe(chars)
    expect(chat).not.toHaveBeenCalled()
  })

  it('超限触发整改：shot/scene/char 三类 fixes 合并回写，垃圾条目被过滤', async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const scenes = [okScene('S1', { en: w(10) })]
    const shots = [okShot({ promptEn: w(30) }), okShot()]
    const chars = [okChar('林川', { lookEn: w(5) })]
    chat.mockResolvedValue(JSON.stringify({
      fixes: [
        null,
        { shotIndex: 'bad' },
        { shotIndex: 1, promptEn: `  ${w(70)}  ` }
      ],
      sceneFixes: [
        { sceneName: 'S1', en: `  ${w(50)}  ` },
        { sceneName: 'X' },
        { en: 'y' }
      ],
      charFixes: [
        { name: '林川', lookEn: `  ${w(35)}  ` },
        { name: 123 }
      ]
    }))
    const out = await enforcePromptLengths(getSettings, scenes, shots, chars)
    expect(chat).toHaveBeenCalledTimes(1)
    // getSettings 透传 + 固定采样参数
    expect(chat.mock.calls[0][0]).toBe(getSettings)
    expect(chat.mock.calls[0][3]).toBe(0.4)
    expect(chat.mock.calls[0][4]).toBe(300000)
    expect(chat.mock.calls[0][5]).toBe(8192)
    // 整改清单文本
    const user = chat.mock.calls[0][2] as string
    expect(user).toContain('镜头1 的 promptEn 现 30 词，要求 60~110 词')
    expect(user).toContain('场景[S1] 的 en 现 10 词，要求 40~80 词')
    expect(user).toContain('角色[林川] 的 lookEn 现 5 词，要求 30~70 词')
    // 合并回写（trim 生效）
    expect(out.shots[0].promptEn).toBe(w(70))
    expect(out.scenes[0].en).toBe(w(50))
    expect(out.characters[0].lookEn).toBe(w(35))
    // 调试落盘执行
    expect(appendFileSyncMock).toHaveBeenCalledTimes(1)
    expect(String(appendFileSyncMock.mock.calls[0][0])).toContain('enforce-debug.log')
    expect(String(appendFileSyncMock.mock.calls[0][1])).toContain('i2v=2')
  })

  it('角色 fixes 按别名命中', async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const chars = [okChar('苏晚', { aliases: ['小晚'], lookEn: w(5) })]
    chat.mockResolvedValue(JSON.stringify({ charFixes: [{ name: '小晚', lookEn: w(40) }] }))
    const out = await enforcePromptLengths(getSettings, [], [], chars)
    expect(out.characters[0].lookEn).toBe(w(40))
  })

  it('raw 无 JSON 花括号 → break 保留原值', async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const shots = [okShot({ promptEn: w(30) })]
    chat.mockResolvedValue('sorry, I cannot help with that.')
    const out = await enforcePromptLengths(getSettings, [], shots, [])
    expect(chat).toHaveBeenCalledTimes(1)
    expect(out.shots[0].promptEn).toBe(w(30))
  })

  it('raw 是非法 JSON → 解析异常走 catch 保留原值并 warn', async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const shots = [okShot({ promptEn: w(30) })]
    chat.mockResolvedValue('{ this is not valid json }')
    const out = await enforcePromptLengths(getSettings, [], shots, [])
    expect(out.shots[0].promptEn).toBe(w(30))
    expect(warnSpy).toHaveBeenCalled()
    expect(String(warnSpy.mock.calls[0][0])).toContain('整改调用失败')
  })

  it('httpChat 抛错 → catch 保留原值，不阻塞', async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const shots = [okShot({ promptEn: w(30) })]
    chat.mockRejectedValue(new Error('network down'))
    const out = await enforcePromptLengths(getSettings, [], shots, [])
    expect(out.shots[0].promptEn).toBe(w(30))
    expect(String(warnSpy.mock.calls[0][0])).toContain('network down')
  })

  it('fixes 全空（三表 size=0）→ break 保留原值', async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const shots = [okShot({ promptEn: w(30) })]
    chat.mockResolvedValue('{"fixes":[]}')
    const out = await enforcePromptLengths(getSettings, [], shots, [])
    expect(chat).toHaveBeenCalledTimes(1)
    expect(out.shots[0].promptEn).toBe(w(30))
  })

  it('2 轮整改仍超限 → 确定性截断：promptEn 150 词补句点、negativeEn 35 词、场景 en 保留原句点', async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const en100 = [...Array.from({ length: 79 }, (_, i) => `word${i}`), 'end.',
      ...Array.from({ length: 20 }, (_, i) => `tail${i}`)].join(' ')
    const scenes = [okScene('S1', { en: en100 })]
    const shots = [okShot({ promptEn: w(200), negativeEn: w(50) })]
    chat.mockResolvedValue(JSON.stringify({
      fixes: [{ shotIndex: 1, promptEn: w(170), negativeEn: '   ' }]
    }))
    const out = await enforcePromptLengths(getSettings, scenes, shots, [])
    expect(chat).toHaveBeenCalledTimes(2)
    expect(wc(out.shots[0].promptEn)).toBe(150)
    expect(out.shots[0].promptEn!.endsWith('.')).toBe(true)
    // 空串 fix 被忽略（trim 检查）→ 原 50 词保留后被截到 35
    expect(wc(out.shots[0].negativeEn)).toBe(35)
    // 截断后第 80 词是 'end.' → 不再补句点
    expect(out.scenes[0].en!.endsWith('end.')).toBe(true)
    expect(wc(out.scenes[0].en)).toBe(80)
  })

  it('位移镜 LLM 两轮仍漏 transitionEn → buildTransition 兜底（含 camera/首中尾帧全字段）', async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const shots = [
      okShot({
        action: 'She walks.',
        frameSeconds: 4,
        camera: 'slow push in',
        midFrameEn: w(22),
        lastFrameEn: w(20),
        transitionEn: undefined
      })
    ]
    chat.mockResolvedValue(JSON.stringify({ fixes: [{ shotIndex: 1 }] }))
    const out = await enforcePromptLengths(getSettings, [], shots, [])
    expect(chat).toHaveBeenCalledTimes(2)
    const t = out.shots[0].transitionEn!
    expect(t).toContain('Transition over 4 seconds')
    expect(t).toContain('slow push in')
    expect(t).toContain('passing through')
    expect(out.shots[0].lastFrameEn).toBe(w(20))
  })

  it('位移镜无 camera/帧提示词、frameSeconds 缺省 → 兜底默认文案', async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const shots = [
      okShot({ action: 'He runs.', firstFrameEn: undefined, midFrameEn: undefined, lastFrameEn: undefined })
    ]
    chat.mockResolvedValue(JSON.stringify({
      fixes: [{ shotIndex: 1, firstFrameEn: w(25) }]
    }))
    const out = await enforcePromptLengths(getSettings, [], shots, [])
    const t = out.shots[0].transitionEn!
    expect(t).toContain('Transition over 5 seconds')
    expect(t).toContain('steady camera')
    expect(t).toContain('the closing state')
    expect(t).not.toContain('passing through')
    expect(out.shots[0].lastFrameEn).toBeUndefined()
  })

  it('非位移镜 LLM 多写的 lastFrameEn/transitionEn 被确定性剥除', async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const shots = [okShot({
      firstFrameEn: w(10),
      midFrameEn: w(10),
      lastFrameEn: w(22),
      transitionEn: w(70)
    })]
    chat.mockResolvedValue(JSON.stringify({
      fixes: [{ shotIndex: 1, firstFrameEn: w(25), midFrameEn: w(22) }]
    }))
    const out = await enforcePromptLengths(getSettings, [], shots, [])
    expect(chat).toHaveBeenCalledTimes(1)
    expect(out.shots[0].lastFrameEn).toBeUndefined()
    expect(out.shots[0].transitionEn).toBeUndefined()
    expect(out.shots[0].midFrameEn).toBe(w(22))
  })

  it('promptEn 含套话 clearly visible → 整改清单标注套话并重写', async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const shots = [okShot({ promptEn: `${w(65)} clearly visible` })]
    chat.mockResolvedValue(JSON.stringify({ fixes: [{ shotIndex: 1, promptEn: w(70) }] }))
    const out = await enforcePromptLengths(getSettings, [], shots, [])
    const user = chat.mock.calls[0][2] as string
    expect(user).toContain('含套话词 "clearly visible"')
    expect(out.shots[0].promptEn).toBe(w(70))
  })

  it('sceneEn 含串台禁词 barber → 整改清单标注串台词并重写', async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const shots = [okShot({ sceneEn: `${w(40)} barber` })]
    chat.mockResolvedValue(JSON.stringify({ fixes: [{ shotIndex: 1, sceneEn: w(40) }] }))
    const out = await enforcePromptLengths(getSettings, [], shots, [])
    const user = chat.mock.calls[0][2] as string
    expect(user).toContain('串台词 "barber"')
    expect(out.shots[0].sceneEn).toBe(w(40))
  })

  it('promptEn 与 action 剧情脱节（命中率 0%）→ 语义对齐防线触发重写', async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const shots = [okShot({ action: 'alpha bravo charlie delta echo', promptEn: w(70) })]
    chat.mockResolvedValue(JSON.stringify({
      fixes: [{ shotIndex: 1, promptEn: `${w(66)} alpha bravo charlie delta echo` }]
    }))
    const out = await enforcePromptLengths(getSettings, [], shots, [])
    const user = chat.mock.calls[0][2] as string
    expect(user).toContain('剧情脱节')
    expect(out.shots[0].promptEn).toContain('alpha')
  })

  it('多镜批量：t2v 镜走 80~130 区间，镜头 2/3 各自整改，镜头 1 不动', async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const shots = [
      okShot({ type: 't2v', promptEn: w(90) }),
      okShot({ sceneEn: w(10) }),
      okShot({ promptEn: w(30) })
    ]
    chat.mockResolvedValue(JSON.stringify({
      fixes: [
        { shotIndex: 2, sceneEn: w(40) },
        { shotIndex: 3, promptEn: w(70) }
      ]
    }))
    const out = await enforcePromptLengths(getSettings, [], shots, [])
    expect(chat).toHaveBeenCalledTimes(1)
    expect(out.shots[0].promptEn).toBe(w(90))
    expect(out.shots[1].sceneEn).toBe(w(40))
    expect(out.shots[2].promptEn).toBe(w(70))
    const user = chat.mock.calls[0][2] as string
    expect(user).toContain('镜头2 的 sceneEn 现 10 词，要求 30~60 词')
    expect(user).toContain('镜头3 的 promptEn 现 30 词，要求 60~110 词')
  })

  it('fs 落盘失败 → 吞异常不阻塞返回', async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    appendFileSyncMock.mockImplementation(() => { throw new Error('disk full') })
    const shots = [okShot({ promptEn: w(30) })]
    chat.mockResolvedValue(JSON.stringify({ fixes: [{ shotIndex: 1, promptEn: w(70) }] }))
    const out = await enforcePromptLengths(getSettings, [], shots, [])
    expect(out.shots[0].promptEn).toBe(w(70))
  })
})

// ============ backfillMissingProps ============
describe('backfillMissingProps', () => {
  const result = (o: Partial<AnalyzeResult>): AnalyzeResult => ({ characters: [], shots: [], ...o })
  const t2v = (o: Partial<AnalyzedShot> = {}): AnalyzedShot =>
    ({ scene: '街道', action: 'wind blows', dialogue: '', type: 't2v', ...o })
  const i2v = (o: Partial<AnalyzedShot> = {}): AnalyzedShot =>
    ({ scene: '客厅', action: 'The woman stands', dialogue: '', type: 'i2v', ...o })

  it('props 缺失/空数组 → 直接返回，不产生 warnings', () => {
    const r1 = result({ shots: [i2v()] })
    backfillMissingProps(r1)
    expect(r1.warnings).toBeUndefined()

    const r2 = result({ props: [], shots: [i2v()] })
    backfillMissingProps(r2)
    expect(r2.warnings).toBeUndefined()
  })

  it('道具已写入 props 数组（大小写不敏感 includes）→ 不注入', () => {
    const r = result({ props: [prop('纸袋', 'paper bag')], shots: [i2v({ props: ['Paper Bag'] })] })
    backfillMissingProps(r)
    expect(r.warnings).toBeUndefined()
    expect(r.shots[0].props).toEqual(['Paper Bag'])
  })

  it('道具已出现在 action（词边界）→ 不注入', () => {
    const r = result({ props: [prop('雨伞', 'umbrella')], shots: [i2v({ action: 'He opens an umbrella slowly' })] })
    backfillMissingProps(r)
    expect(r.warnings).toBeUndefined()
  })

  it('未分配 → 注入第一个 i2v 镜（跳过 t2v），action 尾部追加 holding 短语', () => {
    const r = result({
      props: [prop('纸袋', 'paper bag')],
      shots: [t2v(), i2v()]
    })
    backfillMissingProps(r)
    expect(r.shots[1].props).toEqual(['paper bag'])
    expect(r.shots[1].action).toBe('The woman stands, holding a paper bag')
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings![0]).toContain('已自动补入第 2 镜')
    expect(r.warnings![0]).toContain('道具「纸袋（paper bag）」')
  })

  it('全 t2v → 注入第一个镜头', () => {
    const r = result({ props: [prop('钥匙', 'key')], shots: [t2v({ action: 'rain falls.' }), t2v()] })
    backfillMissingProps(r)
    expect(r.shots[0].props).toEqual(['key'])
    // 原 action 尾部句号被剥掉再接追加短语
    expect(r.shots[0].action).toBe('rain falls, holding a key')
    expect(r.warnings![0]).toContain('第 1 镜')
  })

  it('无镜头 → 仅记录"无可注入镜头"警告', () => {
    const r = result({ props: [prop('刀', 'knife')], shots: [] })
    backfillMissingProps(r)
    expect(r.warnings).toEqual(['道具「刀」未写入任何镜头（无可注入镜头）'])
  })

  it('prop.en 为空 → 回退 zh 作注入词', () => {
    const r = result({ props: [prop('玉佩', '')], shots: [i2v()] })
    backfillMissingProps(r)
    expect(r.shots[0].props).toEqual(['玉佩'])
    expect(r.shots[0].action).toBe('The woman stands, holding a 玉佩')
    expect(r.warnings![0]).toContain('道具「玉佩（玉佩）」')
  })

  it('保留既有 warnings 并追加', () => {
    const r = result({ props: [prop('灯笼', 'lantern')], shots: [i2v()], warnings: ['old warning'] })
    backfillMissingProps(r)
    expect(r.warnings).toEqual([
      'old warning',
      expect.stringContaining('lantern')
    ])
  })

  it('多个缺失道具 → 注入同一目标镜，各记一条警告', () => {
    const r = result({ props: [prop('灯笼', 'lantern'), prop('铜镜', 'mirror')], shots: [i2v()] })
    backfillMissingProps(r)
    expect(r.shots[0].props).toEqual(['lantern', 'mirror'])
    expect(r.warnings).toHaveLength(2)
  })
})
