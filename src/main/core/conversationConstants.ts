/** 工具循环不设业务步数上限（重渲 20 镜需 60+ 轮）；此值仅为防失控的绝对保险，正常任务远达不到 */
export const MAX_TOOL_ROUNDS = 1000
/** 连续多轮完全相同的工具调用（同工具+同参数）判定死循环，强制收尾总结 */
export const SAME_CALL_LIMIT = 20
export const HISTORY_LIMIT = 80 // 只携带最近 80 条，控制 token
export const RESULT_LIMIT = 24000 // 工具结果截断阈值（保证 20+ 镜项目信息不被腰斩）
/** token 优化：重建历史时仅最近 N 条工具结果保留全文，更早的压缩为短摘要（LLM 已消费过其内容，关键结论在后续 assistant 消息里） */
export const FULL_TOOL_RESULTS = 16
export const OLD_RESULT_KEEP = 320
/** token 优化：工作上下文（不含 system/工具描述）字符预算，超出按「消息组」从最旧丢弃，防长任务平方级膨胀。
 *  40K → 80K（2026-10 放宽 agent 自由度：长任务多镜改造要求跨更长历史的连贯记忆，
 *  预算 80K 字符 ≈ 6 万 tokens/轮，覆盖最近 16 条工具结果全文 + 更长的对话上下文） */
export const CONTEXT_CHAR_BUDGET = 80000

export function mid(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}
