/**
 * 火山方舟（Ark）LLM 服务 facade：OpenAI 兼容 chat/completions 接口。
 *
 * 本文件自 P2 重构起仅保留对外门面（facade）：
 * - HTTP client 层         → ./llmHttp         （chatCompletion/chat/chatRaw/test、429/5xx 重试、AbortSignal、timeout）
 * - 剧本操作层             → ./llmScriptOps     （writeScript/splitScript/reviewScript/analyze/translatePrompt/optimizePrompt/fillPromptField/cleanLlmOutput）
 * - analyze 后处理层      → ./llmPostProcess  （enforcePromptLengths/backfillMissingProps/foldName/escapeRegExp）
 * - 多模态与审核层         → ./llmAudit       （reviewStory/diagnoseFailure/auditImage）
 *
 * 导出签名保持不变：`new LLMService(getSettings, genreTemplates)` 及全部公开方法。
 * directorAgent / conversationService / index.ts 等调用方无需改动。
 */
import type { AppSettings, GeneratedShot, GenreTemplate, AnalyzeResult } from '../../shared/ipcTypes'
import type { FieldFillGuide } from '../../shared/promptAudit'
import { httpChatCompletion, httpTest, type ChatMessage, type ToolSpec } from './llmHttp'
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
  analyzeOp,
  type FillPromptContext
} from './llmScriptOps'
import { reviewStoryOp, diagnoseFailureOp, auditImageOp } from './llmAudit'

export type { ChatMessage, ToolSpec, FillPromptContext }

/**
 * 火山方舟（Ark）LLM 服务：OpenAI 兼容 chat/completions 接口。
 * - 提示词翻译：中文分镜描述 → 英文专业视频提示词
 * - AI 拆分镜：一段剧本 → 结构化分镜列表
 * - 导演对话：多轮消息 + 工具调用
 */
export class LLMService {
  constructor(
    private getSettings: () => Promise<AppSettings>,
    private genreTemplates: GenreTemplate[]
  ) {}

  /** 通用多轮对话，支持 function-calling。返回 assistant 消息（可能携带 tool_calls）。 */
  chatCompletion(
    messages: ChatMessage[],
    opts: { temperature?: number; timeoutMs?: number; tools?: ToolSpec[]; signal?: AbortSignal; effort?: string } = {}
  ): Promise<ChatMessage> {
    return httpChatCompletion(this.getSettings, messages, opts)
  }

  /** 连通性测试：发送最小请求，返回模型名 */
  test(): Promise<string> {
    return httpTest(this.getSettings)
  }

  /**
   * 多候选抽卡：依据简报 + 本地分数/备注选出最佳序号（1-based）。
   */
  pickCandidate(input: {
    kind: 'character' | 'scene' | 'render'
    brief: string
    candidates: Array<{ index: number; seed: number; score?: number; note: string }>
  }): Promise<{ index: number; reason: string }> {
    return pickCandidateOp(this.getSettings, input)
  }

  /** 中文分镜描述 → 英文专业提示词。只写动作与镜头语言，不写外貌；带题材风格前缀。 */
  translatePrompt(input: { scene: string; action: string; dialogue: string; genre: string }): Promise<string> {
    return translatePromptOp(this.getSettings, this.genreTemplates, input)
  }

  /** 提示词专业化优化（kind: positive 正向 / negative 负面压制项） */
  optimizePrompt(text: string, kind: 'positive' | 'negative' = 'positive'): Promise<string> {
    return optimizePromptOp(this.getSettings, text, kind)
  }

  /** 批量 AI 补写·字段级补写器：按字段指南 + 镜头上下文调用 LLM 重写 */
  fillPromptField(guide: FieldFillGuide, ctx: FillPromptContext): Promise<string> {
    return fillPromptFieldOp(this.getSettings, guide, ctx)
  }

  /** 中英互译：自动检测输入语种，中文→英文、英文→中文 */
  translateText(text: string): Promise<string> {
    return translateTextOp(this.getSettings, text)
  }

  /** 想法扩写成完整短剧剧本 */
  writeScript(idea: string, genre: string, title?: string): Promise<string> {
    return writeScriptOp(this.getSettings, this.genreTemplates, idea, genre, title)
  }

  /** 有视频入口：多模态 LLM 看图写短剧剧本 */
  writeScriptFromFrames(framePaths: string[], genre: string): Promise<string> {
    return writeScriptFromFramesOp(this.getSettings, this.genreTemplates, framePaths, genre)
  }

  /** AI 剧本医生：专业剧本审查，输出问题清单 + 修改后的完整剧本 */
  reviewScript(script: string, genre: string, title?: string): Promise<{
    issues: Array<{ severity: 'block' | 'warn'; scene: string; problem: string; suggestion: string }>
    revisedScript: string
  }> {
    return reviewScriptOp(this.getSettings, this.genreTemplates, script, genre, title)
  }

  /** AI 拆分镜：剧本 → 分镜 JSON 数组 */
  splitScript(script: string, genre: string): Promise<GeneratedShot[]> {
    return splitScriptOp(this.getSettings, this.genreTemplates, script, genre)
  }

  /** AI 导演·剧本分析：一次调用同时产出角色清单与分镜列表 */
  analyze(script: string, genre: string, opts?: { title?: string; extraRules?: string[] }): Promise<AnalyzeResult> {
    return analyzeOp(this.getSettings, this.genreTemplates, script, genre, opts)
  }

  /** AI 导演·成片复审：以剧本统筹视角审查分镜叙事的完整性与音频匹配 */
  reviewStory(input: {
    title: string
    logline: string
    genre: string
    scriptHint?: string
    shots: Array<{
      index: number
      scene: string
      character: string
      dialogue: string
      durationSec: number
      action?: string
      type?: 'i2v' | 't2v'
      shotSize?: string
    }>
  }): Promise<{ passed: boolean; issues: string[]; summary: string }> {
    return reviewStoryOp(this.getSettings, input)
  }

  /** 流水线故障自诊断：阶段失败时把错误样本交回 LLM 判定根因与自愈策略 */
  diagnoseFailure(input: {
    stageLabel: string
    errors: string[]
    context?: string
  }): Promise<{ canAutoFix: boolean; diagnosis: string; suggestion: string }> {
    return diagnoseFailureOp(this.getSettings, input)
  }

  /** 逐镜视觉审核：把渲染产物交给 LLM 看图，按审核清单判定并给修正指令 */
  auditImage(input: {
    imagePath: string
    kind: 'keyframe' | 'video'
    checklist: Array<{ id: string; label: string; check: string; severity: 'block' | 'warn' }>
    context: {
      index: number
      scene: string
      character: string
      action: string
      shotSize: string
      camera: string
      lookEn?: string
    }
  }): Promise<{
    visionUnavailable: boolean
    passed: boolean
    blockedProblems: string[]
    fixHint: string
  }> {
    return auditImageOp(this.getSettings, input)
  }
}
