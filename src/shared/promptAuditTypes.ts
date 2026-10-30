/** 提示词智能辅助输入：optimize=专业化改写，translate=中英互译 */
export interface PromptAssistInput {
  text: string
  action: 'optimize' | 'translate'
  /** optimize 用：正向/负向提示词语境 */
  kind?: 'positive' | 'negative'
}

// ===== 提示词批量体检（当前项目全部文生图 / 文生视频任务的正向+负向提示词）=====

/** 问题级别：error=必须处理（内容缺失/违规/串戏），warn=建议处理（字数/格式/风格） */
export type PromptAuditLevel = 'error' | 'warn'
/** 提示词极性：positive=正向，negative=负向 */
export type PromptAuditPolarity = 'positive' | 'negative'
/** 单条任务体检结论 */
export type PromptAuditStatus = 'ok' | 'warn' | 'error'
/** 任务归属：分镜（视频）/ 角色定妆 / 场景板 / 道具定妆（均为文生图） */
export type PromptAuditScope = 'shot' | 'character' | 'sceneBoard' | 'prop'
/** 任务类型：t2v=文生视频（空镜），i2v=图生视频（人物镜），t2i=文生图 */
export type PromptAuditTaskType = 't2v' | 'i2v' | 't2i'

/** 体检展示用字段（正向/负向提示词原文 + 统计） */
export interface PromptAuditField {
  /** 数据字段名（shot.promptEn / character.appearanceLock …），供跳转编辑定位 */
  field: string
  /** 中文标签（正向提示词 / 镜级负向提示词 …） */
  label: string
  polarity: PromptAuditPolarity
  text: string
  /** 英文词数（与渲染链路同口径：/[a-zA-Z'-]+/） */
  wordCount: number
  /** true=系统自动注入的负向（REALISM_NEGATIVE 等），只读展示，不参与一键修正 */
  system?: boolean
  /** 文本语言：en 走英文格式校验（中文残留/字数），zh 只校验非空 */
  lang: 'en' | 'zh'
}

/** 单条问题：类型说明 + 是否可一键修正（fixable=false 时走跳转编辑人工处理） */
export interface PromptAuditIssue {
  /** 机器码：missing / too-short / too-long / chinese-char / whitespace / markdown / slang /
   *  cross-project / sound-cue / era-missing / wardrobe-conflict / taboo-* / displacement-unexpected */
  code: string
  level: PromptAuditLevel
  field: string
  fieldLabel: string
  message: string
  fixable: boolean
}

export interface PromptAuditTask {
  /** 任务唯一 id = 实体 id（shot id / character id / sceneBoard id / prop id） */
  id: string
  scope: PromptAuditScope
  taskType: PromptAuditTaskType
  title: string
  shotIndex?: number
  shotId?: string
  characterId?: string
  sceneBoardId?: string
  propId?: string
  fields: PromptAuditField[]
  issues: PromptAuditIssue[]
  status: PromptAuditStatus
}

export interface PromptAuditReport {
  projectId: string
  auditedAt: number
  tasks: PromptAuditTask[]
  summary: {
    total: number
    ok: number
    warn: number
    error: number
    fieldTotal: number
    issueTotal: number
    /** 可一键修正的问题数 */
    fixableTotal: number
    /** 问题类型统计（按问题码聚合，供顶部筛选/概览） */
    byCode: Array<{ code: string; label: string; count: number }>
  }
}

export interface PromptAuditFixInput {
  projectId: string
  /** 限定任务 id（缺省=全部任务） */
  taskIds?: string[]
}

export interface PromptAuditFixResult {
  /** 实际改动字段数 */
  applied: number
  /** 修正后的最新体检报告 */
  report: PromptAuditReport
}

/** 批量 AI 补写入参：taskIds 缺省=全部任务；concurrency 缺省=1 */
export interface PromptBulkFillInput {
  projectId: string
  taskIds?: string[]
  concurrency?: number
}

/** 单个字段补写结果 */
export interface PromptBulkFillFieldResult {
  taskId: string
  field: string
  status: 'filled' | 'skipped' | 'failed' | 'unchanged'
  before: string
  after?: string
  error?: string
}

/** 批量 AI 补写进度事件（主进程逐字段推送，用于前端实时反馈） */
export interface PromptBulkFillProgress {
  projectId: string
  done: number
  total: number
  currentTaskId?: string
  currentField?: string
  lastResult?: PromptBulkFillFieldResult
}

/** 批量 AI 补写返回 */
export interface PromptBulkFillResult {
  /** 补写成功并写入的字段数 */
  filled: number
  /** 跳过的字段数（无可补写问题或非 AI 可处理） */
  skipped: number
  /** 失败的字段数 */
  failed: number
  /** 逐条结果（前端可展开查看） */
  results: PromptBulkFillFieldResult[]
  /** 补写后的最新体检报告 */
  report: PromptAuditReport
}

