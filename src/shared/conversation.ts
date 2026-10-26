// ===== 导演对话 =====

/** 自主学习指令：渲染层「自主学习」按钮与主进程每日自动学习共用同一条文案 */
export const SELF_LEARN_PROMPT =
  '【自主学习】请执行一轮网络技能学习：先用工具查看已有技能避免重复，再搜索 AI 短剧制作与 AI 视频生成的最新技巧/行业动态，深入阅读最有价值的内容，把新知识沉淀为新技能或更新已有技能（没有值得沉淀的就直接说明，不要硬凑），最后汇报学到了什么、沉淀到了哪里、对后续创作有什么用。'

export type ToolCallStatus = 'running' | 'done' | 'error'

export interface ToolCallRecord {
  id: string
  /** 工具名（内置）或 custom_<skillId>（自定义提示词技能） */
  name: string
  /** 中文展示名（技能名） */
  label: string
  argsText: string
  /** 原始参数 JSON（跨轮重建 API 消息用，不展示） */
  argsJson?: string
  status: ToolCallStatus
  /** 执行结果/错误摘要 */
  result?: string
}

export interface ConversationMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  ts: number
  error?: boolean
  toolCalls?: ToolCallRecord[]
}

export interface ConversationToolEvent {
  type: 'conversation:tool'
  scope: string
  messageId: string
  toolCall: ToolCallRecord
}

/** 对话上传文件：文本内容（超长截断） */
export interface UploadedFilePayload {
  name: string
  content: string
  truncated: boolean
}

