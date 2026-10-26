/**
 * 提示词批量体检：遍历当前项目全部「文生图 / 文生视频」任务（分镜视频、角色定妆、场景板、道具定妆），
 * 逐条校验正向 + 负向提示词的**完整性 / 格式规范性 / 敏感内容**，并给出问题类型说明与可一键修正标记。
 *
 * 设计约束（与需求对齐）：
 * - 纯函数、零副作用、不触网、不调 LLM：同一份数据任何时候结果一致，任意任务数量/任意内容下行为稳定；
 * - 只读诊断：auditProjectPrompts 不改动传入的 project；
 * - 一键修正只改提示词文本字段，**不动镜头状态、不动已生成产物**（applyAutoFixes 返回克隆对象）；
 * - 每个任务的体检独立 try/catch 兜底：单条数据异常只跳过该条，绝不中断整场体检或抛错到渲染层。
 *
 * 规则口径与渲染链路一致：字数区间对齐 llmService 分镜字段铁律，负向词对齐 imagePrompts 清单，
 * 位移判定复用 imagePrompts.DISPLACEMENT_ACTION_RE（与 taskQueue flf2v 路由同一把尺）。
 */

// 纯重构：本文件仅保留为 re-export 枢纽，实现按内容域拆分到同目录三个模块：
// - promptAuditRules.ts   规则常量（问题码标签/正则/敏感词表/字段规格）与纯辅助函数
// - promptAuditEngine.ts  审计执行引擎（按任务类型构建问题列表并汇总报告）
// - promptAuditFixes.ts   一键修正器与批量 AI 补写指南组装
export { AUDIT_CODE_LABELS, AI_FILLABLE_CODES } from './promptAuditRules'
export { auditProjectPrompts } from './promptAuditEngine'
export type { FieldFillGuide } from './promptAuditFixes'
export { assignField, applyAutoFixes, fillGuidesFor, fillableFieldsOf } from './promptAuditFixes'
