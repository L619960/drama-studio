import {
  IpcChannels,
  type Project,
  type PromptAssistInput,
  type PromptBulkFillInput,
  type PromptBulkFillFieldResult,
  type PromptBulkFillResult,
  type PromptBulkFillProgress
} from '../../shared/ipcTypes'
import { applyAutoFixes, auditProjectPrompts, fillableFieldsOf, assignField } from '../../shared/promptAudit'
import { handleIpc, sendToWindow } from './shared'
import type { ProjectStore } from '../core/projectStore'
import type { LLMService, FillPromptContext } from '../core/llmService'

export interface PromptIpcCtx {
  projectStore: ProjectStore
  llmService: LLMService
}

/** 读取项目：参数非法/项目不存在时抛业务可读错误。
 *  直接 get() 会抛 ENOENT 并把数据根绝对路径透传到渲染层，这里统一兜住。 */
async function loadProjectOrThrow(projectStore: ProjectStore, projectId: unknown): Promise<Project> {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('非法项目标识')
  try {
    const project = await projectStore.get(projectId)
    if (project) return project
  } catch {
    // project.json 不存在或不可读：一律按「项目不存在」处理
  }
  throw new Error('项目不存在或已被删除，请刷新项目列表后重试')
}

export function registerPromptIpc(ctx: PromptIpcCtx): void {
  // 提示词智能辅助：AI 专业化优化 / 中英互译（输入框右上角/右下角图标触发）
  handleIpc(IpcChannels.promptAssist, async (_, input: PromptAssistInput) => {
    const text = input.text?.trim()
    if (!text) throw new Error('请输入内容后再使用辅助功能')
    const out = input.action === 'optimize'
      ? await ctx.llmService.optimizePrompt(text, input.kind || 'positive')
      : await ctx.llmService.translateText(text)
    return { text: out.trim() }
  })

  // 提示词批量体检：遍历项目全部文生图/文生视频任务，校验正向+负向提示词
  // （完整性/格式规范/敏感内容）。纯本地确定性校验，不调 LLM、不触网、不改项目数据。
  handleIpc(IpcChannels.promptAudit, async (_, payload: { projectId: string }) => {
    const project = await loadProjectOrThrow(ctx.projectStore, payload?.projectId)
    return auditProjectPrompts(project)
  })

  // 提示词一键修正：只修可确定性修复的文本项（中文残留/多余空白/星号/套话/声场词/
  // 时代隔离缺失/服装正负向冲突）；语义类问题（缺失、串戏、敏感内容）一律留给人工跳转编辑。
  // 只写提示词字段，不动镜头状态与已生成产物。
  handleIpc(IpcChannels.promptFix, async (_, payload: { projectId: string; taskIds?: string[] }) => {
    const project = await loadProjectOrThrow(ctx.projectStore, payload?.projectId)
    const { project: fixed, applied } = applyAutoFixes(project, { taskIds: payload?.taskIds })
    if (applied > 0) await ctx.projectStore.save(fixed)
    return { applied, report: auditProjectPrompts(fixed) }
  })

  // 批量 AI 补写：对体检报告中标「缺失/过短/串戏」的字段逐个调用 LLM 重写，
  // 严格对齐 llmService 分镜字数铁律；单字段失败隔离，不影响其他字段；
  // 进度逐字段通过 prompt:bulkFillProgress 推送。
  handleIpc(IpcChannels.promptBulkFill, async (_, payload: PromptBulkFillInput) => {
    const project = await loadProjectOrThrow(ctx.projectStore, payload?.projectId)
    const concurrency = Math.max(1, Math.min(4, payload?.concurrency || 1))
    // 用当前 project 做体检，得到带问题码的任务列表
    const report = auditProjectPrompts(project)
    const taskIds = payload?.taskIds
    const tasks = report.tasks.filter(t => !taskIds || taskIds.includes(t.id))

    // 1. 构建补写计划：{task, guide, current}
    type PlanItem = {
      task: typeof tasks[number]
      guide: ReturnType<typeof fillableFieldsOf>[number]['guide']
      current: string
    }
    const plan: PlanItem[] = []
    for (const task of tasks) {
      const items = fillableFieldsOf(task, project)
      for (const it of items) plan.push({ task, guide: it.guide, current: it.current })
    }

    const total = plan.length
    const results: PromptBulkFillFieldResult[] = []
    let done = 0
    let filled = 0
    let failed = 0
    // 写回用的克隆体
    const fixed = structuredClone(project)

    // 构造本镜上下文（防止串戏/脑补）
    const buildCtx = (task: typeof tasks[number], current: string, issue: string): FillPromptContext => {
      const c: FillPromptContext = { currentText: current, issue }
      if (task.scope === 'shot') {
        const shot = (fixed.shots || []).find(s => s.id === task.id)
        if (shot) {
          c.scene = shot.scene
          c.sceneEn = shot.sceneEn
          c.action = shot.action
          c.shotSize = shot.shotSize
          c.type = shot.type
          // 角色定妆锁：取本镜出场角色（取首个）的 appearanceLock 作为身份锚
          if (shot.characterIds?.length) {
            const ch = (fixed.characters || []).find(c => c.id === shot.characterIds[0])
            if (ch) {
              c.characterName = ch.name
              c.characterLocks = ch.appearanceLock || ch.description
            }
          }
          if (shot.props?.length) {
            c.props = shot.props.filter(Boolean).join(', ')
          }
        }
      } else if (task.scope === 'character') {
        const ch = (fixed.characters || []).find(c => c.id === task.id)
        if (ch) c.characterName = ch.name
      } else if (task.scope === 'sceneBoard') {
        const b = (fixed.sceneBoards || []).find(s => s.id === task.id)
        if (b) c.scene = b.name
      } else if (task.scope === 'prop') {
        const p = (fixed.props || []).find(x => x.id === task.id)
        if (p) c.characterName = p.zh || p.en
      }
      c.era = fixed.genre
      return c
    }

    const emitProgress = (currentTaskId?: string, currentField?: string, lastResult?: PromptBulkFillFieldResult) => {
      sendToWindow(IpcChannels.promptBulkFillProgress, {
        projectId: payload?.projectId, done, total, currentTaskId, currentField, lastResult
      } satisfies PromptBulkFillProgress)
    }

    // 2. 并发池执行
    let cursor = 0
    const workers: Promise<void>[] = []
    for (let i = 0; i < concurrency; i++) {
      workers.push((async () => {
        while (cursor < plan.length) {
          const idx = cursor++
          const { task, guide, current } = plan[idx]
          const issue = task.issues.find(is => is.field === guide.field)?.message || ''
          const c = buildCtx(task, current, issue)
          let status: PromptBulkFillFieldResult['status']
          let after: string | undefined
          let error: string | undefined
          try {
            const text = await ctx.llmService.fillPromptField(guide, c)
            after = text
            if (text === current.trim()) {
              status = 'unchanged'
            } else {
              const ok = assignField(fixed, task, guide.field, text)
              status = ok ? 'filled' : 'failed'
              if (!ok) error = '写回项目失败'
              else filled++
            }
          } catch (e) {
            failed++
            error = e instanceof Error ? e.message : String(e)
            status = 'failed'
          }
          done++
          const r: PromptBulkFillFieldResult = {
            taskId: task.id, field: guide.field, status, before: current, after, error
          }
          results.push(r)
          emitProgress(task.id, guide.field, r)
        }
      })())
    }
    await Promise.all(workers)

    // 3. 落盘（只要有字段被填就存）
    if (filled > 0) await ctx.projectStore.save(fixed)

    return {
      filled,
      skipped: total - filled - failed,
      failed,
      results,
      report: auditProjectPrompts(fixed)
    } satisfies PromptBulkFillResult
  })
}
