/**
 * ConversationService 的工具处理器集合（barrel）。
 * 按工具域拆分为多个分片：
 * - conversationToolsMemory.ts   记忆/技能/设置/自定义技能/项目上下文解析
 * - conversationToolsDirector.ts 导演任务控制（开拍/暂停/状态/重渲/试片/预告片）
 * - conversationToolsProject.ts  项目库/角色/分镜编辑
 * - conversationToolsWorkflow.ts 工作流库/快速渲染/工作流参数
 * - conversationToolsNetwork.ts 网络搜索/网页抓取（含 SSRF 受限防护）
 * - conversationToolsFile.ts     项目文件浏览/定位/BGM 导入
 * 每个函数首位参数 host 接收 ConversationService 持有的运行时依赖快照。
 */
import type { LLMService } from './llmService'
import type { SkillService } from './skillService'
import type { ComfyMcpService } from './comfyMcpService'
import type { MemoryStore } from './memoryStore'
import type { DirectorAgent } from './directorAgent'
import type { TaskQueue } from './taskQueue'
import type { ProjectStore } from './projectStore'
import type { ComfyUIClient } from './comfyuiClient'
import type { WorkflowLoader } from './workflowLoader'
import type { WorkflowLibrary } from './workflowLibrary'
import type { SkillLibrary } from './skillLibrary'
import type { FFmpegService } from './ffmpegService'
import type { SettingsStore } from './settingsStore'

/** ConversationService 运行时依赖适配器（服务引用均为构造期注入、永不重绑；lastProjectId 为可变会话状态，需读写透传） */
export interface ConversationToolsHost {
  baseDir: string
  llm: LLMService
  skills: SkillService
  director: DirectorAgent
  queue: TaskQueue
  projects: ProjectStore
  comfy: ComfyUIClient
  workflows: WorkflowLoader
  memory: MemoryStore
  ffmpeg: FFmpegService
  settings: SettingsStore
  skillLibrary?: SkillLibrary
  workflowLibrary?: WorkflowLibrary
  comfyMcp?: ComfyMcpService
  lastProjectId: string | undefined
}

export type ToolResult = { ok: boolean; text: string }

export {
  runCustomSkill, resolvePid,
  tListMemories, tSaveMemory, tGetSettings, tSetSettings,
  tCreateSkill, tListSkills, tUpdateSkill
} from './conversationToolsMemory'

export {
  tStart, tSimple, tStatus, tListShots, tRerender,
  tRenderSample, tMakeTrailer, tRebuildFrames
} from './conversationToolsDirector'

export {
  tListProjects, tOpenProject,
  tListCharacters, tUpdateCharacter,
  renumberShots, validateFrames, recalcProjectStatus,
  tUpdateShot, tAddShot, tDeleteShot, tMoveShot
} from './conversationToolsProject'

export {
  workflowExists, tChooseWorkflow, tGetComfyuiStatus,
  tListWorkflows, tImportLibraryWorkflow, tRenderQuick,
  tGetWorkflowParams, tUpdateWorkflowParam, tCreateWorkflow
} from './conversationToolsWorkflow'

export {
  tWebSearch, tFetchUrl, isBlockedFetchHost
} from './conversationToolsNetwork'

export {
  tSetProjectBgm, tListProjectFiles, tOpenFile
} from './conversationToolsFile'
