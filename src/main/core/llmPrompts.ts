/**
 * 【2026-10-25 标注：re-export 枢纽当前 0 消费（全 src grep 无 from './llmPrompts'）——
 * llmService.ts:15 直接 import './llmPromptsAnalyze'，其余提示词模块（Script/Ops）为
 * 拆分期产物，live 提示词以内联/单文件为准。保留文件仅为出口稳定；勿在此新增导出，
 * 新增提示词直接落在 llmService.ts 或对应单文件。】
 *
 * LLM 提示词构建器统一出口（re-export 枢纽，原实现按用途分片）：
 * - llmPromptsAnalyze：剧本统筹巨型 system（analyzeSystemPrompt）+ 提示词字数整改（enforceFixPrompts）
 * - llmPromptsScript：写剧本/视频抽帧写剧本/剧本医生/拆分镜
 * - llmPromptsOps：多候选抽卡/分镜翻译/提示词优化/字段补写/中英互译/成片复审/故障诊断/视觉审核
 */
export { analyzeSystemPrompt, enforceFixPrompts } from './llmPromptsAnalyze'
export {
  writeScriptPrompts,
  writeScriptFromFramesSystem,
  reviewScriptSystem,
  splitScriptSystem
} from './llmPromptsScript'
export {
  pickCandidateSystem,
  translatePromptPrompts,
  optimizePromptSystem,
  fillPromptPrompts,
  translateTextSystem,
  reviewStorySystem,
  diagnoseFailureSystem,
  auditImageSystem,
  auditImageUser
} from './llmPromptsOps'
