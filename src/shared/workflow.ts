// ===== 工作流元数据 =====
/** 工作流能力标签：供导演按用户意图自动匹配工作流（文生视频/图生视频/首尾帧/文生图/图生图/音频） */
export type WorkflowCapability =
  | 't2v' | 'i2v' | 'flf2v'   // 视频：文生/图生/首尾帧
  | 't2i' | 'i2i'             // 图片：文生/图生
  | 'audio'                   // 音频/TTS/音乐
  | 'other'

export interface WorkflowMeta {
  name: string
  placeholders: string[]
  hasImageInput: boolean
  hasDuration: boolean
  /** 双图首尾帧（$END_IMAGE$） */
  hasEndFrame?: boolean
  /** 自动推断的能力标签（t2v/i2v/flf2v/t2i/i2i/audio/other），导演自动选流依据 */
  capability?: WorkflowCapability
}

/** 工作流中可编辑的参数项 */
export interface WorkflowParam {
  nodeId: string
  nodeTitle: string
  classType: string
  key: string
  value: string | number | boolean
  type: 'string' | 'number' | 'boolean'
  isPlaceholder: boolean  // 值为 $XXX$ 占位符（只读）
  isConnection: boolean   // 值为节点连接引用数组（只读）
}

// ===== 工作流环境自检报告 =====
export interface WorkflowCheckIssue {
  kind: 'missing-node' | 'missing-model' | 'unknown'
  nodeId: string
  classType: string
  /** missing-node：缺失的节点类名；missing-model：缺失的模型文件名；附带的输入键名写在 inputKey */
  message: string
  inputKey?: string
}

export interface WorkflowCheckReport {
  workflow: string
  ok: boolean
  issues: WorkflowCheckIssue[]
}

