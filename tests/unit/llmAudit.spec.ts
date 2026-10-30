/**
 * llmAudit 三个 async op 单元测试（2026-10-30）：
 * mock llmHttp（httpChat）、axios（auditImageOp 直接 post）、node:fs/promises（读图）、
 * creationSettings/narrativeBeats，不发真实网络请求、不读真实配置。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/main/core/llmHttp', () => ({
  httpChat: vi.fn()
}))
vi.mock('axios', () => ({ default: { post: vi.fn() } }))
vi.mock('../../src/shared/creationSettings', () => ({
  resolveCreation: vi.fn(() => ({
    storyboard: { enforcePropLock: true, enforceReactionBeats: false, enforceBoardingChain: true }
  }))
}))
vi.mock('../../src/shared/narrativeBeats', () => ({
  validateNarrativeContinuity: vi.fn(() => [] as string[])
}))
vi.mock('node:fs/promises', () => {
  const readFile = vi.fn()
  return { readFile, default: { readFile } }
})

import axios from 'axios'
import { readFile } from 'node:fs/promises'
import { httpChat } from '../../src/main/core/llmHttp'
import { validateNarrativeContinuity } from '../../src/shared/narrativeBeats'
import type { AppSettings } from '../../src/shared/ipcTypes'
import { reviewStoryOp, diagnoseFailureOp, auditImageOp } from '../../src/main/core/llmAudit'

type Mock = ReturnType<typeof vi.fn>
const chat = httpChat as unknown as Mock
const post = axios.post as unknown as Mock
const readFileMock = readFile as unknown as Mock
const narrativeMock = validateNarrativeContinuity as unknown as Mock

const getSettings = vi.fn(async () =>
  ({ llm: { model: 'ds-vision', apiKey: 'sk-audit', baseUrl: 'https://api.test/' } }) as unknown as AppSettings
)

const baseShots = [
  { index: 1, scene: '雨夜天台', character: '林澈', dialogue: '你终于来了', durationSec: 4, action: '撑伞走近', type: 'i2v' as const, shotSize: '中景' },
  { index: 2, scene: '街道', character: '', dialogue: '', durationSec: 3 },
  { index: 3, scene: '车内', character: '苏念', dialogue: '走吧', durationSec: 2, type: 't2v' as const }
]

beforeEach(() => {
  chat.mockClear().mockResolvedValue('OK')
  post.mockClear().mockResolvedValue({ data: { choices: [{ message: { content: '{}' } }] } })
  readFileMock.mockReset().mockResolvedValue(Buffer.from('img-bytes'))
  narrativeMock.mockClear().mockReturnValue([])
  getSettings.mockClear()
})

// ---------------------------------------------------------------- reviewStoryOp

describe('reviewStoryOp · 成片叙事复审', () => {
  const input = { title: '伞下', logline: '一把伞串起重逢', genre: '都市', shots: baseShots }

  it('正常 JSON 且本地无问题 → passed=true，summary 去空白', async () => {
    chat.mockResolvedValue('{"passed":true,"issues":["节奏可再紧凑"],"summary":"  整体流畅  "}')
    const out = await reviewStoryOp(getSettings, input)
    expect(out).toEqual({ passed: true, issues: ['节奏可再紧凑'], summary: '整体流畅' })
  })

  it('httpChat 以低温 0.2/120s 调用，提示词含审查维度与分镜清单（缺省字段占位）', async () => {
    chat.mockResolvedValue('{"passed":true,"issues":[],"summary":"ok"}')
    await reviewStoryOp(getSettings, { ...input, logline: '' })
    expect(chat).toHaveBeenCalledWith(
      getSettings,
      expect.stringContaining('成片审片导演'),
      expect.stringContaining('梗概:（未提供）'),
      0.2,
      120000
    )
    const user = chat.mock.calls[0][2] as string
    expect(user).toContain('第1镜 [4s] 雨夜天台｜i2v｜中景｜角色:林澈｜台词:你终于来了｜action:撑伞走近')
    expect(user).toContain('第2镜 [3s] 街道｜?｜-｜角色:空镜｜台词:（无）｜action:（无）')
  })

  it('markdown 围栏 JSON 也能解析', async () => {
    chat.mockResolvedValue('```json\n{"passed":true,"issues":[],"summary":"过"}\n```')
    const out = await reviewStoryOp(getSettings, input)
    expect(out).toEqual({ passed: true, issues: [], summary: '过' })
  })

  it('输出无 JSON 大括号 → 跳过模型项并保留本地规则结论', async () => {
    narrativeMock.mockReturnValue(['本地问题A'])
    chat.mockResolvedValue('模型拒绝回答')
    const out = await reviewStoryOp(getSettings, input)
    expect(out.passed).toBe(false)
    expect(out.issues).toEqual(['本地问题A', '剧情复审模型输出异常，已跳过模型剧情项（本地叙事规则仍有效）'])
    expect(out.summary).toBe('剧情复审部分跳过')
  })

  it('}{ 顺序颠倒（end<=start）同样走输出异常分支', async () => {
    chat.mockResolvedValue('}{')
    const out = await reviewStoryOp(getSettings, input)
    expect(out.summary).toBe('剧情复审部分跳过')
    expect(out.issues[0]).toContain('输出异常')
  })

  it('大括号内非法 JSON → 解析失败分支', async () => {
    chat.mockResolvedValue('{passed: oops}')
    const out = await reviewStoryOp(getSettings, input)
    expect(out.passed).toBe(true)
    expect(out.issues[0]).toContain('解析失败')
    expect(out.summary).toBe('剧情复审部分跳过')
  })

  it('本地问题与模型问题去重合并，且总数截断为 12', async () => {
    narrativeMock.mockReturnValue(['道具伞在第3镜失踪了', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'])
    chat.mockResolvedValue(
      '{"passed":false,"issues":["道具伞在第3镜失踪了，建议补特写","第5镜台词与画面矛盾"],"summary":"不行"}'
    )
    const out = await reviewStoryOp(getSettings, input)
    expect(out.passed).toBe(false)
    // 重复项被跳过、新项追加、截断 12
    expect(out.issues).toHaveLength(11)
    expect(out.issues).toContain('第5镜台词与画面矛盾')
    expect(out.issues.filter(i => i.includes('道具伞在第3镜失踪了'))).toHaveLength(1)
  })

  it('模型问题为本地问题前缀时同样判重跳过', async () => {
    narrativeMock.mockReturnValue(['第7镜缺少入画反应镜，建议补一个无台词反应'])
    chat.mockResolvedValue('{"passed":true,"issues":["第7镜缺少入画反应镜"],"summary":"ok"}')
    const out = await reviewStoryOp(getSettings, input)
    expect(out.issues).toHaveLength(1)
  })

  it('issues 非数组按空处理；passed 缺失视为通过；summary 缺失为空串', async () => {
    chat.mockResolvedValue('{"issues":"不是数组"}')
    const out = await reviewStoryOp(getSettings, input)
    expect(out).toEqual({ passed: true, issues: [], summary: '' })
  })

  it('模型 passed=false 一票否决（即使本地无问题）', async () => {
    chat.mockResolvedValue('{"passed":false,"issues":["剧情断裂"],"summary":"不通过"}')
    const out = await reviewStoryOp(getSettings, input)
    expect(out.passed).toBe(false)
    expect(out.issues).toEqual(['剧情断裂'])
  })

  it('本地硬规则入参：scriptHint 缺省为空串，type 按角色有无回退 i2v/t2v，开关透传', async () => {
    await reviewStoryOp(getSettings, input)
    const [title, logline, hint, shots, flags] = narrativeMock.mock.calls[0] as [
      string, string, string, Array<Record<string, unknown>>, Record<string, boolean>
    ]
    expect(title).toBe('伞下')
    expect(logline).toBe('一把伞串起重逢')
    expect(hint).toBe('')
    expect(shots[1].type).toBe('t2v') // 无角色 → t2v
    expect(shots[0].type).toBe('i2v')
    expect(shots[2].type).toBe('t2v') // 显式 t2v 保留
    expect(shots[1].characterName).toBeUndefined()
    expect(flags).toEqual({ enforcePropLock: true, enforceReactionBeats: false, enforceBoardingChain: true })
  })
})

// ---------------------------------------------------------------- diagnoseFailureOp

describe('diagnoseFailureOp · 流水线故障自诊断', () => {
  const input = { stageLabel: '渲染', errors: ['CUDA out of memory', 'node missing'] }

  it('正常 JSON → 返回三字段，低温 0.2/60s，user 含编号错误样本', async () => {
    chat.mockResolvedValue('{"canAutoFix":true,"diagnosis":"显存不足","suggestion":"降低分辨率"}')
    const out = await diagnoseFailureOp(getSettings, { ...input, context: '第4镜 1080p' })
    expect(out).toEqual({ canAutoFix: true, diagnosis: '显存不足', suggestion: '降低分辨率' })
    expect(chat).toHaveBeenCalledWith(getSettings, expect.stringContaining('故障诊断专家'), expect.any(String), 0.2, 60000)
    const user = chat.mock.calls[0][2] as string
    expect(user).toContain('失败阶段：渲染')
    expect(user).toContain('上下文：第4镜 1080p')
    expect(user).toContain('1. CUDA out of memory')
    expect(user).toContain('2. node missing')
  })

  it('无 context → user 不含「上下文」行；围栏 JSON 可解析', async () => {
    chat.mockResolvedValue('```json\n{"canAutoFix":false,"diagnosis":"缺节点","suggestion":"安装节点"}\n```')
    const out = await diagnoseFailureOp(getSettings, input)
    expect(out.canAutoFix).toBe(false)
    expect(chat.mock.calls[0][2]).not.toContain('上下文')
  })

  it('canAutoFix 非 true（缺失/字符串）→ false', async () => {
    chat.mockResolvedValue('{"diagnosis":"d","suggestion":"s"}')
    expect((await diagnoseFailureOp(getSettings, input)).canAutoFix).toBe(false)
    chat.mockResolvedValue('{"canAutoFix":"true","diagnosis":"d","suggestion":"s"}')
    expect((await diagnoseFailureOp(getSettings, input)).canAutoFix).toBe(false)
  })

  it('diagnosis 或 suggestion 为空 → 抛「诊断内容不完整」', async () => {
    chat.mockResolvedValue('{"canAutoFix":true,"diagnosis":"  ","suggestion":"s"}')
    await expect(diagnoseFailureOp(getSettings, input)).rejects.toThrow('诊断内容不完整')
    chat.mockResolvedValue('{"canAutoFix":true,"diagnosis":"d"}')
    await expect(diagnoseFailureOp(getSettings, input)).rejects.toThrow('诊断内容不完整')
  })

  it('无大括号 → 抛「诊断输出格式异常」', async () => {
    chat.mockResolvedValue('抱歉，无法诊断')
    await expect(diagnoseFailureOp(getSettings, input)).rejects.toThrow('诊断输出格式异常')
  })

  it('大括号内非法 JSON → JSON.parse 异常直接上抛（调用方降级）', async () => {
    chat.mockResolvedValue('{invalid json}')
    await expect(diagnoseFailureOp(getSettings, input)).rejects.toBeInstanceOf(SyntaxError)
  })
})

// ---------------------------------------------------------------- auditImageOp

describe('auditImageOp · 逐镜视觉审核', () => {
  const auditInput = {
    imagePath: 'C:/out/shot1.jpg',
    kind: 'video' as const,
    checklist: [
      { id: 'face', label: '人脸一致', check: '与定妆比对', severity: 'block' as const },
      { id: 'light', label: '光线自然', check: '无过曝', severity: 'warn' as const }
    ],
    context: { index: 1, scene: '天台', character: '林澈', action: '撑伞', shotSize: '近景', camera: '正面', lookEn: 'black coat' }
  }

  const jsonResp = (content: string | undefined, reasoning?: string) => ({
    data: { choices: [{ message: { content, reasoning_content: reasoning } }] }
  })

  it('未配置 apiKey → 直接 visionUnavailable，不读图不发请求', async () => {
    const noKey = vi.fn(async () => ({ llm: { apiKey: '', model: 'm' } }) as unknown as AppSettings)
    const out = await auditImageOp(noKey, auditInput)
    expect(out).toEqual({ visionUnavailable: true, passed: true, blockedProblems: [], fixHint: '' })
    expect(readFileMock).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('读图失败 → dataUrl 为空 → visionUnavailable，不发请求', async () => {
    readFileMock.mockRejectedValue(new Error('ENOENT'))
    const out = await auditImageOp(getSettings, auditInput)
    expect(out.visionUnavailable).toBe(true)
    expect(post).not.toHaveBeenCalled()
  })

  it('成功路径：jpg→image/jpeg、URL 去尾斜杠、Bearer 头、90s 超时、多模态 body 与清单提示词', async () => {
    post.mockResolvedValue(jsonResp('{"passed":false,"blockedProblems":["人脸身份与定妆不一致"],"fixHint":"keep face identity"}'))
    const out = await auditImageOp(getSettings, auditInput)
    expect(out).toEqual({ visionUnavailable: false, passed: false, blockedProblems: ['人脸身份与定妆不一致'], fixHint: 'keep face identity' })
    expect(post).toHaveBeenCalledTimes(1)
    const [url, body, cfg] = post.mock.calls[0]
    expect(url).toBe('https://api.test/chat/completions')
    expect(cfg).toEqual({ headers: { Authorization: 'Bearer sk-audit' }, timeout: 90000 })
    expect(body.model).toBe('ds-vision')
    expect(body.effort).toBe('low')
    expect(body.max_tokens).toBe(2000)
    expect(body.temperature).toBe(0.2)
    expect(body.messages[1].content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/)
    expect(body.messages[0].content).toContain('1. 人脸一致：与定妆比对（不过必须重渲）')
    expect(body.messages[0].content).toContain('2. 光线自然：无过曝（不过仅告警）')
    expect(body.messages[1].content[0].text).toContain('第1镜 视频抽帧审核｜景别:近景｜机位:正面')
    expect(body.messages[1].content[0].text).toContain('外观锁定:black coat')
  })

  it('无扩展名按 png、baseUrl 缺省用 deepseek、kind=keyframe 且无 lookEn 的提示词分支', async () => {
    const settings = vi.fn(async () => ({ llm: { apiKey: 'sk-a', model: 'm1', baseUrl: '' } }) as unknown as AppSettings)
    const out1 = await auditImageOp(settings, { ...auditInput, imagePath: 'C:/out/frame', kind: 'keyframe', context: { ...auditInput.context, lookEn: undefined } })
    expect(out1.visionUnavailable).toBe(false)
    expect(post.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions')
    expect(post.mock.calls[0][1].messages[1].content[1].image_url.url).toMatch(/^data:image\/png;base64,/)
    expect(post.mock.calls[0][1].messages[1].content[0].text).toContain('关键帧审核')
    expect(post.mock.calls[0][1].messages[1].content[0].text).not.toContain('外观锁定')
  })

  it('content 空但有 reasoning → 加大配额重试一次后成功', async () => {
    post
      .mockResolvedValueOnce(jsonResp('', '让我仔细看看这张图'))
      .mockResolvedValueOnce(jsonResp('{"passed":true,"blockedProblems":[],"fixHint":""}'))
    const out = await auditImageOp(getSettings, auditInput)
    expect(out).toEqual({ visionUnavailable: false, passed: true, blockedProblems: [], fixHint: '' })
    expect(post).toHaveBeenCalledTimes(2)
    // 同一 body 对象原地改配额后重发（首次发出时 max_tokens=2000，重试前被改为 4000）
    expect(post.mock.calls[0][1]).toBe(post.mock.calls[1][1])
    expect(post.mock.calls[1][1].max_tokens).toBe(4000)
  })

  it('content 空且无 reasoning → visionUnavailable，只请求一次', async () => {
    post.mockResolvedValue(jsonResp('   '))
    const out = await auditImageOp(getSettings, auditInput)
    expect(out.visionUnavailable).toBe(true)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('模型声称看不到图（中英文）→ visionUnavailable 降级', async () => {
    post.mockResolvedValue(jsonResp('抱歉，我没有图片可以审核'))
    expect((await auditImageOp(getSettings, auditInput)).visionUnavailable).toBe(true)
    post.mockResolvedValue(jsonResp('I cannot see any image here'))
    expect((await auditImageOp(getSettings, auditInput)).visionUnavailable).toBe(true)
  })

  it('有 content 但无大括号 → 非视觉不可用、放行（passed=true）', async () => {
    post.mockResolvedValue(jsonResp('画面整体没有问题'))
    const out = await auditImageOp(getSettings, auditInput)
    expect(out).toEqual({ visionUnavailable: false, passed: true, blockedProblems: [], fixHint: '' })
  })

  it('大括号内非法 JSON → catch 分支放行', async () => {
    post.mockResolvedValue(jsonResp('{oops}'))
    const out = await auditImageOp(getSettings, auditInput)
    expect(out).toEqual({ visionUnavailable: false, passed: true, blockedProblems: [], fixHint: '' })
  })

  it('字段归一：passed 缺失视为通过；blockedProblems 非数组→[]、含空串过滤并截断 6；fixHint 截断 300', async () => {
    const long = 'x'.repeat(350)
    post.mockResolvedValue(jsonResp(JSON.stringify({
      blockedProblems: ['p1', '', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'],
      fixHint: `  ${long}  `
    })))
    const out = await auditImageOp(getSettings, auditInput)
    expect(out.passed).toBe(true)
    expect(out.blockedProblems).toEqual(['p1', 'p3', 'p4', 'p5', 'p6', 'p7'])
    expect(out.fixHint).toHaveLength(300)
    post.mockResolvedValue(jsonResp('{"passed":false,"blockedProblems":"不是数组","fixHint":null}'))
    const out2 = await auditImageOp(getSettings, auditInput)
    expect(out2).toEqual({ visionUnavailable: false, passed: false, blockedProblems: [], fixHint: '' })
  })

  it('响应结构缺失（choices 空）→ 等价 content 空 → visionUnavailable', async () => {
    post.mockResolvedValue({ data: {} })
    const out = await auditImageOp(getSettings, auditInput)
    expect(out.visionUnavailable).toBe(true)
  })
})
