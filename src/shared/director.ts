import type { AnalyzeResult } from './project'

// ===== AI 导演：流水线状态 =====
export type DirectorStage =
  | 'analyze' | 'casting' | 'scenes' | 'render'
  | 'combine' | 'subtitle' | 'review' | 'bgm' | 'done'

/** 单镜审批/复审问题 */
export interface ReviewIssue {
  shotId?: string
  message: string
}

export type StageStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped' | 'paused'

export interface StageState {
  status: StageStatus
  message: string
  percent: number
}

/** 执行日志单条（中文时间线） */
export interface DirectorLogEntry {
  id: number
  stage: DirectorStage
  level: 'info' | 'success' | 'warn' | 'error'
  message: string
  timestamp: number
}

export interface DirectorState {
  projectId: string
  title: string
  running: boolean
  cancelled: boolean
  /** 是否停在阶段间确认点，等待用户继续 */
  paused: boolean
  /** 本次任务配置的阶段门：在这些阶段结束后暂停等待确认 */
  gateStages: DirectorStage[]
  stages: Record<DirectorStage, StageState>
  totalShots: number
  doneShots: number
  failedShotIds: string[]
  /** 成片复审问题清单（review 阶段产出） */
  reviewIssues?: string[]
  /** AI 自愈诊断：阶段失败时 LLM 诊断结论与修复建议（UI 在对应阶段卡片展示） */
  heal?: { stage: DirectorStage; diagnosis: string; suggestion: string }
  finalPath?: string
  /** 断点续跑输入快照（含原始剧本/BGM 路径），随状态持久化 */
  input?: DirectorStartInput
  /** 剧本分析结果快照：从 casting/scenes 续跑时复用，避免二次 LLM 拆镜 */
  analysis?: AnalyzeResult | null
  startedAt: number
  finishedAt?: number
  /** 最近 300 条中文执行日志（环形截断） */
  logs: DirectorLogEntry[]
}

export interface DirectorProgressEvent {
  type: 'director:progress'
  projectId: string
  state: DirectorState
}

export interface DirectorLogEvent {
  type: 'director:log'
  projectId: string
  entry: DirectorLogEntry
}

export interface DirectorStartInput {
  title: string
  genre: string
  script: string
  bgmAbsolutePath?: string
  /** 阶段间确认点：列出的阶段结束后暂停，等待用户点"继续" */
  gateStages?: DirectorStage[]
}

