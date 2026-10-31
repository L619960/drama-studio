/**
 * LLMService（门面层）单元测试：验证全部公开方法正确转发参数到 op 函数 / httpChatCompletion。
 * llmService.ts 自 P2 重构起就是纯 facade——所有实现已下沉到 llmHttp / llmScriptOps / llmAudit，
 * 这里确保转发签名丝毫不差、错误原样透传。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// —— 全部下游依赖 mock ——
vi.mock('../../src/main/core/llmHttp', () => ({
  httpChatCompletion: vi.fn(),
  httpTest: vi.fn(),
}))

vi.mock('../../src/main/core/llmScriptOps', () => ({
  pickCandidateOp: vi.fn(),
  translatePromptOp: vi.fn(),
  optimizePromptOp: vi.fn(),
  fillPromptFieldOp: vi.fn(),
  translateTextOp: vi.fn(),
  writeScriptOp: vi.fn(),
  writeScriptFromFramesOp: vi.fn(),
  reviewScriptOp: vi.fn(),
  splitScriptOp: vi.fn(),
  analyzeOp: vi.fn(),
}))

vi.mock('../../src/main/core/llmAudit', () => ({
  reviewStoryOp: vi.fn(),
  diagnoseFailureOp: vi.fn(),
  auditImageOp: vi.fn(),
}))

import { LLMService } from '../../src/main/core/llmService'
import { httpChatCompletion, httpTest } from '../../src/main/core/llmHttp'
import * as scriptOps from '../../src/main/core/llmScriptOps'
import * as auditOps from '../../src/main/core/llmAudit'
import type { AppSettings, GenreTemplate } from '../../src/shared/ipcTypes'

type Fn = ReturnType<typeof vi.fn>
const hcc = httpChatCompletion as unknown as Fn
const ht = httpTest as unknown as Fn
const pick = scriptOps.pickCandidateOp as unknown as Fn
const tPrompt = scriptOps.translatePromptOp as unknown as Fn
const oPrompt = scriptOps.optimizePromptOp as unknown as Fn
const fillField = scriptOps.fillPromptFieldOp as unknown as Fn
const tText = scriptOps.translateTextOp as unknown as Fn
const wScript = scriptOps.writeScriptOp as unknown as Fn
const wFrames = scriptOps.writeScriptFromFramesOp as unknown as Fn
const rScript = scriptOps.reviewScriptOp as unknown as Fn
const sScript = scriptOps.splitScriptOp as unknown as Fn
const aOp = scriptOps.analyzeOp as unknown as Fn
const rStory = auditOps.reviewStoryOp as unknown as Fn
const dFail = auditOps.diagnoseFailureOp as unknown as Fn
const aImg = auditOps.auditImageOp as unknown as Fn

const getSettings = vi.fn(
  async () => ({ llm: { model: 'test', apiKey: 'sk', baseUrl: 'https://x/' } }) as unknown as AppSettings,
)
const GT: GenreTemplate[] = [{ key: 'wuxia', label: '武侠', promptStyle: 'wuxia tone' }]

beforeEach(() => {
  vi.clearAllMocks()
  for (const m of [
    hcc,
    ht,
    pick,
    tPrompt,
    oPrompt,
    fillField,
    tText,
    wScript,
    wFrames,
    rScript,
    sScript,
    aOp,
    rStory,
    dFail,
    aImg,
  ]) {
    m.mockReset()
    m.mockResolvedValue({})
  }
  getSettings.mockClear()
})

const svc = new LLMService(getSettings, GT)

// ---------------------------------------------------------------- chatCompletion / test

describe('LLMService · HTTP 层门面', () => {
  it('chatCompletion 把 messages + opts 原样转发到 httpChatCompletion', async () => {
    const messages = [{ role: 'user' as const, content: 'hi' }]
    hcc.mockResolvedValue({ role: 'assistant', content: 'yo' })
    const r = await svc.chatCompletion(messages, {
      temperature: 0.2,
      timeoutMs: 30_000,
      tools: [],
      signal: undefined,
      effort: 'high',
    })
    expect(hcc).toHaveBeenCalledWith(getSettings, messages, {
      temperature: 0.2,
      timeoutMs: 30_000,
      tools: [],
      signal: undefined,
      effort: 'high',
    })
    expect(r).toEqual({ role: 'assistant', content: 'yo' })
  })

  it('chatCompletion 默认 opts 为空对象', async () => {
    hcc.mockResolvedValue({ role: 'assistant', content: 'x' })
    await svc.chatCompletion([{ role: 'user', content: 'a' }])
    expect(hcc.mock.calls[0]?.[2]).toEqual({})
  })

  it('test 转发到 httpTest 并返回模型名字符串', async () => {
    ht.mockResolvedValue('deepseek-v3')
    expect(await svc.test()).toBe('deepseek-v3')
    expect(ht).toHaveBeenCalledWith(getSettings)
  })

  it('chatCompletion 错误透传（下游 http 400 → 抛出）', async () => {
    hcc.mockRejectedValue(new Error('HTTP 400 bad request'))
    await expect(svc.chatCompletion([{ role: 'user', content: 'x' }])).rejects.toThrow('HTTP 400 bad request')
  })

  it('test 错误透传（无 API Key → 抛出）', async () => {
    ht.mockRejectedValue(new Error('请先配置 API Key'))
    await expect(svc.test()).rejects.toThrow('请先配置 API Key')
  })
})

// ---------------------------------------------------------------- 剧本操作层（llmScriptOps）

describe('LLMService · 剧本操作层门面', () => {
  it('pickCandidate / translatePrompt / optimizePrompt / fillPromptField / translateText 正确透传', async () => {
    pick.mockResolvedValue({ index: 2, reason: '最优' })
    expect(await svc.pickCandidate({ kind: 'character', brief: '', candidates: [] })).toEqual({
      index: 2,
      reason: '最优',
    })
    expect(pick.mock.calls[0]?.[0]).toBe(getSettings)

    tPrompt.mockResolvedValue('professional prompt')
    await svc.translatePrompt({ scene: '巷', action: '跑', dialogue: '走', genre: 'wuxia' })
    expect(tPrompt).toHaveBeenCalledWith(getSettings, GT, { scene: '巷', action: '跑', dialogue: '走', genre: 'wuxia' })

    oPrompt.mockResolvedValue('opt-neg')
    await svc.optimizePrompt('raw', 'negative')
    expect(oPrompt).toHaveBeenCalledWith(getSettings, 'raw', 'negative')

    oPrompt.mockResolvedValue('opt-pos')
    await svc.optimizePrompt('raw')
    expect(oPrompt.mock.calls[1]).toEqual([getSettings, 'raw', 'positive'])

    fillField.mockResolvedValue('filled')
    await svc.fillPromptField({} as never, { shot: undefined } as never)
    expect(fillField).toHaveBeenCalledTimes(1)

    tText.mockResolvedValue('你好')
    await svc.translateText('hello')
    expect(tText).toHaveBeenCalledWith(getSettings, 'hello')
  })

  it('writeScript / writeScriptFromFrames / reviewScript / splitScript / analyze 带 genreTemplates 转发', async () => {
    wScript.mockResolvedValue('完整剧本')
    await svc.writeScript('idea', 'wuxia', '标题')
    expect(wScript).toHaveBeenCalledWith(getSettings, GT, 'idea', 'wuxia', '标题')

    wFrames.mockResolvedValue('帧剧本')
    await svc.writeScriptFromFrames(['f1.jpg'], '都市')
    expect(wFrames).toHaveBeenCalledWith(getSettings, GT, ['f1.jpg'], '都市')

    const rRes = { issues: [], revisedScript: '改稿' }
    rScript.mockResolvedValue(rRes)
    expect(await svc.reviewScript('剧本体', 'wuxia')).toBe(rRes)
    expect(rScript).toHaveBeenCalledWith(getSettings, GT, '剧本体', 'wuxia', undefined)

    sScript.mockResolvedValue([{ id: 's1' }])
    await svc.splitScript('剧本体', 'wuxia')
    expect(sScript).toHaveBeenCalledWith(getSettings, GT, '剧本体', 'wuxia')

    aOp.mockResolvedValue({ characters: [], shots: [] })
    await svc.analyze('剧本体', 'wuxia', { title: 't', extraRules: ['加检查项'] })
    expect(aOp).toHaveBeenCalledWith(getSettings, GT, '剧本体', 'wuxia', { title: 't', extraRules: ['加检查项'] })
  })

  it('analyze 省略 opts → 下游收到 undefined', async () => {
    aOp.mockResolvedValue({ characters: [], shots: [] })
    await svc.analyze('s', 'wuxia')
    expect(aOp.mock.calls[0]?.[4]).toBeUndefined()
  })

  it('剧本操作层错误原样透传', async () => {
    aOp.mockRejectedValue(new Error('模型拒绝分析'))
    await expect(svc.analyze('s', 'wuxia')).rejects.toThrow('模型拒绝分析')
  })
})

// ---------------------------------------------------------------- 审核层（llmAudit）

describe('LLMService · 审核层门面', () => {
  const base = { title: '伞下', logline: '', genre: '都市', shots: [] }
  const diag = { stageLabel: '渲染', errors: ['CUDA OOM'] }
  const audit = {
    imagePath: 'C:/out/shot1.jpg',
    kind: 'video' as const,
    checklist: [],
    context: { index: 1, scene: '', character: '', action: '', shotSize: '', camera: '' },
  }

  it('reviewStory / diagnoseFailure / auditImage 正确透传输入对象', async () => {
    rStory.mockResolvedValue({ passed: true, issues: [], summary: 'ok' })
    await svc.reviewStory(base)
    expect(rStory).toHaveBeenCalledWith(getSettings, base)

    dFail.mockResolvedValue({ canAutoFix: false, diagnosis: '显存', suggestion: '降分辨率' })
    await svc.diagnoseFailure(diag)
    expect(dFail).toHaveBeenCalledWith(getSettings, diag)

    aImg.mockResolvedValue({ visionUnavailable: false, passed: true, blockedProblems: [], fixHint: '' })
    await svc.auditImage(audit)
    expect(aImg).toHaveBeenCalledWith(getSettings, audit)
  })

  it('审核层错误透传（auditImage 抛 visionUnavailable 外的业务错误）', async () => {
    rStory.mockRejectedValue(new Error('网络超时'))
    await expect(svc.reviewStory(base)).rejects.toThrow('网络超时')
  })
})
