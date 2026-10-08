import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { LLMService, type ChatMessage, type ToolSpec } from './llmService'
import { SkillService, BUILTIN_TOOL_SPECS, customToolSpec } from './skillService'
import type { MemoryStore } from './memoryStore'
import type { DirectorAgent } from './directorAgent'
import type { TaskQueue } from './taskQueue'
import type { ProjectStore } from './projectStore'
import type { ComfyUIClient } from './comfyuiClient'
import type { WorkflowLoader } from './workflowLoader'
import type { FFmpegService } from './ffmpegService'
import type { SettingsStore } from './settingsStore'
import type {
  ConversationMessage, ConversationToolEvent, DirectorStage,
  MemoryKind, Project, Shot, Skill, ToolCallRecord
} from '../../shared/ipcTypes'

const MAX_TOOL_ROUNDS = 5
const HISTORY_LIMIT = 40 // 只携带最近 40 条，控制 token
const RESULT_LIMIT = 6000

function mid(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

/**
 * 导演对话服务：
 * - 会话按 scope（'global' 或 projectId）持久化
 * - 注入项目快照与流水线实时状态，LLM 通过已启用技能（工具）操作真实功能
 * - 工具执行过程以事件推给面板，最终返回完整消息列表
 */
export class ConversationService extends EventEmitter {
  /** 全局对话里最近操作过的项目（开拍后自动绑定，后续项目类工具默认作用于它） */
  private lastProjectId?: string

  constructor(
    private baseDir: string,
    private llm: LLMService,
    private skills: SkillService,
    private director: DirectorAgent,
    private queue: TaskQueue,
    private projects: ProjectStore,
    private comfy: ComfyUIClient,
    private workflows: WorkflowLoader,
    private memory: MemoryStore,
    private ffmpeg: FFmpegService,
    private settings: SettingsStore
  ) {
    super()
  }

  private scopeFile(scope: string): string {
    const safe = /^[a-zA-Z0-9_-]+$/.test(scope) ? scope : 'global'
    return path.join(this.baseDir, 'conversations', `${safe}.json`)
  }

  async list(scope: string): Promise<ConversationMessage[]> {
    try {
      return JSON.parse(await fs.readFile(this.scopeFile(scope), 'utf8')) as ConversationMessage[]
    } catch {
      return []
    }
  }

  async clear(scope: string): Promise<void> {
    await fs.rm(this.scopeFile(scope), { force: true })
  }

  private async save(scope: string, msgs: ConversationMessage[]): Promise<void> {
    const file = this.scopeFile(scope)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(msgs.slice(-200), null, 2))
  }

  /** 发送一条用户消息，执行工具调用循环，返回更新后的完整消息列表 */
  /** 每个对话 scope 一条 Promise 链：并发 send 串行执行，避免历史读-改-写互相覆盖 */
  private sendChains = new Map<string, Promise<unknown>>()

  async send(scope: string, text: string): Promise<ConversationMessage[]> {
    const prev = this.sendChains.get(scope) ?? Promise.resolve()
    const next = prev.then(() => this.doSend(scope, text))
    this.sendChains.set(scope, next.catch(() => { /* 保证链不断 */ }))
    return next
  }

  private async doSend(scope: string, text: string): Promise<ConversationMessage[]> {
    const history = await this.list(scope)
    history.push({ id: mid(), role: 'user', content: text, ts: Date.now() })
    await this.save(scope, history)

    const system = await this.buildSystemPrompt(scope)
    const allSkills = await this.skills.list()
    const enabled = allSkills.filter(s => s.enabled)
    const tools: ToolSpec[] = [
      ...enabled.filter(s => s.kind === 'tool' && s.tool).map(s => BUILTIN_TOOL_SPECS[s.tool!]),
      ...enabled.filter(s => s.kind === 'prompt').map(customToolSpec)
    ]

    // 工作消息序列：system + 历史重建（assistant 工具调用与其结果严格配对）
    const working: ChatMessage[] = [
      { role: 'system', content: system },
      ...this.toLlmMessages(history.slice(-HISTORY_LIMIT))
    ]

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const reply = await this.llm.chatCompletion(working, { tools, temperature: 0.5 })

        if (!reply.tool_calls?.length) {
          history.push({
            id: mid(), role: 'assistant',
            content: reply.content || '（导演没有返回内容，请重试）',
            ts: Date.now()
          })
          await this.save(scope, history)
          return history
        }

        // API 原始 assistant 消息直接进工作序列（保留原始 call id 与 arguments）
        working.push(reply)

        // 面板展示用的工具调用记录
        const records: ToolCallRecord[] = reply.tool_calls.map(c => ({
          id: c.id,
          name: c.function.name,
          label: this.toolLabel(c.function.name, enabled),
          argsText: this.prettyArgs(c.function.arguments),
          argsJson: c.function.arguments,
          status: 'running'
        }))
        const assistantMsg: ConversationMessage = {
          id: mid(), role: 'assistant',
          content: reply.content || '',
          toolCalls: records,
          ts: Date.now()
        }
        history.push(assistantMsg)
        await this.save(scope, history)

        for (let i = 0; i < reply.tool_calls.length; i++) {
          const call = reply.tool_calls[i]
          this.emitTool(scope, assistantMsg.id, records[i])
          const result = await this.executeTool(scope, call.function.name, call.function.arguments)
          const updated: ToolCallRecord = {
            ...records[i],
            status: result.ok ? 'done' : 'error',
            result: result.text
          }
          assistantMsg.toolCalls![i] = updated
          this.emitTool(scope, assistantMsg.id, updated)
          await this.save(scope, history)
          working.push({
            role: 'tool',
            tool_call_id: call.id,
            content: result.text.slice(0, RESULT_LIMIT)
          })
        }
      }
      // 达到工具轮数上限仍未给最终答复
      history.push({
        id: mid(), role: 'assistant',
        content: '操作步骤较多，我先执行到这里。你可以让我「继续」，或直接问我当前结果。',
        ts: Date.now()
      })
    } catch (e) {
      history.push({
        id: mid(), role: 'assistant',
        content: `出错了：${e instanceof Error ? e.message : String(e)}`,
        ts: Date.now(), error: true
      })
    }
    await this.save(scope, history)
    return history
  }

  private emitTool(scope: string, messageId: string, toolCall: ToolCallRecord): void {
    const e: ConversationToolEvent = { type: 'conversation:tool', scope, messageId, toolCall }
    this.emit('tool', e)
  }

  private toolLabel(name: string, skills: Skill[]): string {
    if (name.startsWith('custom_')) {
      return skills.find(s => `custom_${s.id}` === name)?.name || '自定义技能'
    }
    return skills.find(s => s.tool === name)?.name || name
  }

  private prettyArgs(raw: string): string {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>
      return Object.entries(obj)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('，')
    } catch {
      return raw
    }
  }

  /**
   * 持久化消息 → OpenAI 消息序列。
   * 含工具调用的 assistant 消息后，严格按顺序补配对的 role=tool 结果消息。
   */
  private toLlmMessages(history: ConversationMessage[]): ChatMessage[] {
    const out: ChatMessage[] = []
    for (const m of history) {
      if (m.role === 'user') {
        out.push({ role: 'user', content: m.content })
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        out.push({
          role: 'assistant',
          content: m.content || '',
          tool_calls: m.toolCalls.map(c => ({
            id: c.id,
            type: 'function' as const,
            function: { name: c.name, arguments: c.argsJson || '{}' }
          }))
        })
        for (const c of m.toolCalls) {
          out.push({
            role: 'tool',
            tool_call_id: c.id,
            content: (c.status === 'running' ? '工具未执行完成' : c.result) || '（无返回）'
          })
        }
      } else if (m.role === 'assistant') {
        out.push({ role: 'assistant', content: m.content })
      }
    }
    return out
  }

  // ===== 工具执行 =====

  private async executeTool(scope: string, name: string, argsJson: string): Promise<{ ok: boolean; text: string }> {
    let args: Record<string, unknown> = {}
    try {
      args = argsJson ? JSON.parse(argsJson) as Record<string, unknown> : {}
    } catch {
      return { ok: false, text: `参数不是合法 JSON：${argsJson}` }
    }
    const pid = scope === 'global' ? undefined : scope
    try {
      if (name.startsWith('custom_')) return await this.runCustomSkill(name, args)
      switch (name) {
        case 'start_director': return await this.tStart(pid, args)
        case 'pause_director': return await this.tSimple(await this.resolvePid(pid), 'pause')
        case 'resume_director': return await this.tSimple(await this.resolvePid(pid), 'resume')
        case 'cancel_director': return await this.tSimple(await this.resolvePid(pid), 'cancel')
        case 'get_director_status': return await this.tStatus(await this.resolvePid(pid))
        case 'list_shots': return await this.tListShots(await this.resolvePid(pid))
        case 'rerender_shots': return await this.tRerender(await this.resolvePid(pid), args)
        case 'render_sample': return await this.tRenderSample(await this.resolvePid(pid), args)
        case 'make_trailer': return await this.tMakeTrailer(await this.resolvePid(pid), args)
        case 'get_comfyui_status': {
          const ok = await this.comfy.healthCheck()
          return { ok: true, text: JSON.stringify({ online: ok }) }
        }
        case 'list_workflows': {
          const list = await this.workflows.list()
          const s = await this.settings.get()
          const p = pid ? await this.projects.get(pid).catch(() => null) : null
          return { ok: true, text: JSON.stringify({
            globalDefault: s.workflow.default,
            projectDefault: p?.defaultWorkflow || null,
            available: list.map(w => ({ name: w.name, placeholders: w.placeholders }))
          }) }
        }
        case 'choose_workflow': return await this.tChooseWorkflow(pid, args)
        case 'get_workflow_params': {
          const name = String(args.workflow_name || '')
          if (!name) return { ok: false, text: '缺少 workflow_name' }
          const params = await this.workflows.getEditableParams(name)
          return { ok: true, text: JSON.stringify(params.slice(0, 80)).slice(0, RESULT_LIMIT) }
        }
        case 'update_workflow_param': {
          const name = String(args.workflow_name || '')
          const nodeId = String(args.node_id || '')
          const key = String(args.key || '')
          if (!name || !nodeId || !key) return { ok: false, text: '缺少 workflow_name/node_id/key' }
          const v = args.value
          if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
            return { ok: false, text: 'value 必须是字符串/数字/布尔' }
          }
          await this.workflows.updateParam(name, nodeId, key, v)
          return { ok: true, text: `已更新 ${name} 节点 ${nodeId} 的 ${key}` }
        }
        case 'create_workflow': {
          const name = String(args.name || '')
          const content = String(args.content || '')
          if (!name || !content) return { ok: false, text: '缺少 name/content' }
          const finalName = await this.workflows.createWorkflow(name, content)
          return { ok: true, text: `工作流已创建：${finalName}（可在设置→工作流中查看）` }
        }
        case 'list_memories':
          return await this.tListMemories(args.kind as MemoryKind | undefined)
        case 'save_memory':
          return await this.tSaveMemory(args)
        default:
          return { ok: false, text: `未知工具：${name}` }
      }
    } catch (e) {
      return { ok: false, text: `执行失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }

  private async runCustomSkill(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    const skillId = name.replace(/^custom_/, '')
    const all = await this.skills.list()
    const skill = all.find(s => s.id === skillId)
    if (!skill || !skill.enabled) return { ok: false, text: '技能不存在或已停用' }
    const userText = String(args.user_text || '')
    const system = (skill.promptTemplate || '').replace(/\{\{\s*input\s*\}\}/g, userText) || userText
    const reply = await this.llm.chatCompletion(
      [
        { role: 'system', content: system },
        { role: 'user', content: userText || '请按技能说明执行' }
      ],
      { temperature: 0.7 }
    )
    return { ok: true, text: reply.content }
  }

  /** 解析项目 ID：优先用传入的；全局对话回退到最近操作的项目；再回退到最近更新的项目 */
  private async resolvePid(pid: string | undefined): Promise<string | undefined> {
    if (pid) { this.lastProjectId = pid; return pid }
    if (this.lastProjectId) return this.lastProjectId
    const list = await this.projects.list()
    const latest = [...list].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (latest) this.lastProjectId = latest.id
    return latest?.id
  }

  private async tStart(pid: string | undefined, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    const title = String(args.title || '').trim()
    const genre = String(args.genre || '').trim()
    const script = String(args.script || '').trim()
    if (!title || !genre || !script) {
      return { ok: false, text: '缺少片名/题材/剧本，不能开拍' }
    }
    if (pid) {
      const st = this.director.getState(pid)
      if (st?.running) return { ok: false, text: `当前项目《${st.title}》已有任务在执行，请先暂停或取消` }
    }
    const gateStages = Array.isArray(args.gate_stages)
      ? (args.gate_stages as string[]).filter(g => typeof g === 'string')
      : ['analyze', 'render']
    const newId = await this.director.start({
      title, genre, script,
      gateStages: gateStages as DirectorStage[]
    })
    this.lastProjectId = newId
    return { ok: true, text: JSON.stringify({ started: true, projectId: newId, title, gateStages }) }
  }

  private async tSimple(pid: string | undefined, action: 'pause' | 'resume' | 'cancel'): Promise<{ ok: boolean; text: string }> {
    if (!pid) return { ok: false, text: '当前没有打开的项目，无法执行该操作' }
    const st = this.director.getState(pid)
    if (!st) return { ok: false, text: '当前项目没有任务记录' }
    if (action === 'pause') {
      if (!st.running || st.paused) return { ok: false, text: '任务当前不在执行中（可能已暂停或已结束）' }
      await this.director.pause(pid)
    } else if (action === 'resume') {
      if (!st.paused) return { ok: false, text: '任务没有停在确认点，无需继续' }
      await this.director.resume(pid)
    } else {
      await this.director.cancel(pid)
    }
    const p = await this.projects.get(pid)
    return { ok: true, text: JSON.stringify({ action, accepted: true, projectId: pid, projectTitle: p.title }) }
  }

  private async tStatus(pid: string | undefined): Promise<{ ok: boolean; text: string }> {
    if (!pid) return { ok: false, text: '当前没有打开的项目' }
    const st = this.director.getState(pid)
    if (!st) return { ok: true, text: JSON.stringify({ hasTask: false, projectId: pid }) }
    return {
      ok: true,
      text: JSON.stringify({
        hasTask: true,
        projectId: pid,
        title: st.title,
        running: st.running,
        paused: st.paused,
        cancelled: st.cancelled,
        totalShots: st.totalShots,
        doneShots: st.doneShots,
        failedShotIds: st.failedShotIds,
        reviewIssues: st.reviewIssues || [],
        finalPath: st.finalPath || null,
        stages: Object.fromEntries(
          Object.entries(st.stages).map(([k, v]) => [k, { status: v.status, message: v.message, percent: v.percent }])
        )
      })
    }
  }

  private async tListShots(pid: string | undefined): Promise<{ ok: boolean; text: string }> {
    if (!pid) return { ok: false, text: '当前没有打开的项目' }
    const p = await this.projects.get(pid)
    const shots = p.shots.slice(0, 60).map(s => ({
      index: s.index,
      type: s.type,
      shotSize: s.shotSize || null,
      character: s.characterIds.length
        ? (p.characters.find(c => c.id === s.characterIds[0])?.name || '')
        : '',
      scene: s.scene,
      dialogue: s.dialogue || '',
      status: s.status
    }))
    return {
      ok: true,
      text: JSON.stringify({
        projectId: pid,
        title: p.title,
        genre: p.genre,
        total: p.shots.length,
        characters: p.characters.map(c => `${c.name}(${c.voice})`),
        shots
      }).slice(0, RESULT_LIMIT)
    }
  }

  private async tRerender(pid: string | undefined, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    if (!pid) return { ok: false, text: '当前没有打开的项目' }
    const indexes = Array.isArray(args.shot_indexes) ? (args.shot_indexes as number[]).map(Number) : []
    if (!indexes.length) return { ok: false, text: '未指定镜号' }
    const p = await this.projects.get(pid)
    const ids = p.shots.filter(s => indexes.includes(s.index)).map(s => s.id)
    if (!ids.length) return { ok: false, text: `没有找到镜号：${indexes.join('、')}` }
    await this.queue.start(pid, ids)
    return { ok: true, text: JSON.stringify({ queued: true, projectId: pid, shotIndexes: indexes, count: ids.length }) }
  }

  // ---------------------------------------------------------------- 工作流选择
  /**
   * 为项目选择工作流（全局/项目/单镜头三级策略）：
   * - scope='global' → 改设置里的默认工作流
   * - scope='project' → 改 project.defaultWorkflow 并 save
   * - scope='shot' → 改指定分镜的 workflow 字段并 save
   */
  private async tChooseWorkflow(pid: string | undefined, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    const scope = String(args.scope || 'project')
    const workflowName = String(args.workflow_name || '')
    if (!workflowName) return { ok: false, text: '缺少 workflow_name' }
    const list = await this.workflows.list()
    if (!list.some(w => w.name === workflowName)) {
      return { ok: false, text: `工作流 ${workflowName} 不存在` }
    }
    if (scope === 'global') {
      const s = await this.settings.get()
      s.workflow.default = workflowName
      await this.settings.save(s)
      return { ok: true, text: `全局默认工作流已设为：${workflowName}` }
    }
    if (scope === 'shot') {
      if (!pid) return { ok: false, text: '当前没有打开的项目' }
      const shotIndex = typeof args.shot_index === 'number' ? args.shot_index : Number(args.shot_index || 0)
      if (!shotIndex) return { ok: false, text: '单镜头模式需要 shot_index（1-based）' }
      const p = await this.projects.get(pid)
      const shot = p.shots.find(s => s.index === shotIndex)
      if (!shot) return { ok: false, text: `项目中不存在第 ${shotIndex} 个分镜` }
      shot.workflow = workflowName
      await this.projects.save(p)
      return { ok: true, text: `分镜 ${shotIndex} 已指定工作流：${workflowName}` }
    }
    // project（默认）
    if (!pid) return { ok: false, text: '当前没有打开的项目' }
    const p = await this.projects.get(pid)
    p.defaultWorkflow = workflowName
    await this.projects.save(p)
    return { ok: true, text: `项目默认工作流已设为：${workflowName}。新增镜头和没有单独指定工作流的镜头将使用此引擎。` }
  }

  // ---------------------------------------------------------------- 试片与预告片
  private async tRenderSample(pid: string | undefined, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    if (!pid) return { ok: false, text: '当前没有打开的项目' }
    const p = await this.projects.get(pid)
    const hasRendered = p.shots.some(s => s.segmentPath)
    if (!hasRendered) {
      // 没有已渲染镜头：挑 2-3 个待渲染镜头走 taskQueue 渲染，然后拼接
      let indexes: number[] = []
      if (Array.isArray(args.shot_indexes)) {
        indexes = (args.shot_indexes as number[]).map(Number).filter(i => i > 0 && i <= p.shots.length)
      }
      if (!indexes.length) {
        // 自动挑选：不同场景 + 至少一个有人物 + 景别有变化
        const candidates = p.shots
          .filter(s => s.status === 'pending' || s.status === 'failed')
          .slice(0, 15)
        const scenes = [...new Set(candidates.map(s => s.scene).filter(Boolean))]
        const picked: Shot[] = []
        for (const sc of scenes) {
          if (picked.length >= 3) break
          const shot = candidates.find(s => s.scene === sc && s.characterIds?.length)
          if (shot && !picked.includes(shot)) picked.push(shot)
        }
        if (picked.length < 2) {
          for (const s of candidates) {
            if (picked.length >= 2) break
            if (!picked.includes(s)) picked.push(s)
          }
        }
        indexes = picked.map(s => s.index)
      }
      if (!indexes.length) return { ok: false, text: '没有可渲染的镜头，请确保项目已有分镜' }
      const ids = p.shots.filter(s => indexes.includes(s.index)).map(s => s.id)
      await this.queue.start(pid, ids)
      return {
        ok: true,
        text: JSON.stringify({
          queued: true, projectId: pid, title: p.title,
          shotIndexes: indexes, message: `已提交试片 ${indexes.length} 镜渲染，请等待完成后再生成样片`
        })
      }
    }
    // 已有渲染成果：直接拼样片（优先用用户指定的）
    let indexes: number[] = []
    if (Array.isArray(args.shot_indexes)) {
      indexes = (args.shot_indexes as number[]).map(Number).filter(i => i > 0 && i <= p.shots.length)
    }
    let sources = p.shots.filter(s => s.segmentPath)
    if (indexes.length) {
      sources = sources.filter(s => indexes.includes(s.index))
    }
    if (!sources.length) return { ok: false, text: '指定的镜头尚未渲染完成' }
    if (sources.length > 4) sources = sources.slice(0, 4)
    const samplePath = path.join(this.baseDir, `projects/${pid}/sample.mp4`)
    await this.ffmpeg.concatSegments(
      sources.map(s => path.join(this.baseDir, s.segmentPath!)),
      samplePath
    )
    return {
      ok: true,
      text: JSON.stringify({
        sampleReady: true, projectId: pid, title: p.title,
        usedShots: sources.map(s => s.index),
        samplePath,
        message: `试片已生成：${sources.length} 镜拼接，路径 ${samplePath}`
      })
    }
  }

  private async tMakeTrailer(pid: string | undefined, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    if (!pid) return { ok: false, text: '当前没有打开的项目' }
    const p = await this.projects.get(pid)
    const rendered = p.shots.filter(s => s.segmentPath)
    if (!rendered.length) return { ok: false, text: '当前项目还没有已渲染的镜头，无法制作预告片' }

    let indexes: number[] = []
    if (Array.isArray(args.shot_indexes)) {
      indexes = (args.shot_indexes as number[]).map(Number).filter(i => i > 0 && i <= p.shots.length)
    }
    let sources = rendered
    if (indexes.length) {
      sources = rendered.filter(s => indexes.includes(s.index))
    }
    if (!sources.length) return { ok: false, text: '指定的镜头尚未渲染完成' }
    if (sources.length > 10) sources = sources.slice(0, 10)

    const clipSec = Math.max(0.5, Math.min(3, Number(args.clip_seconds || 1.5)))
    const withBgm = args.with_bgm !== false
    const clipsDir = path.join(this.baseDir, `projects/${pid}/trailer_clips`)
    const trailerPath = path.join(this.baseDir, `projects/${pid}/trailer.mp4`)

    const clips: string[] = []
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i]
      const full = path.join(this.baseDir, s.segmentPath!)
      const duration = await this.ffmpeg.getDuration(full)
      const start = Math.max(0, (duration - clipSec) / 2) // 取中段高光
      const clip = path.join(clipsDir, `c${i}.mp4`)
      await this.ffmpeg.trimClip(full, start, clipSec, clip)
      clips.push(clip)
    }

    // 拼接高光片段
    await this.ffmpeg.concatSegments(clips, trailerPath)

    // 可选混 BGM
    if (withBgm && p.bgmPath) {
      const bgmFull = path.join(this.baseDir, p.bgmPath)
      const mixed = trailerPath + '.bgm.mp4'
      await this.ffmpeg.mixBgm(trailerPath, bgmFull, mixed, p.bgmVolume ?? 35)
      // 清理纯视频，保留混音版
      await fs.unlink(trailerPath).catch(() => undefined)
      await fs.rename(mixed, trailerPath).catch(() => undefined)
    }

    // 清理临时片段
    for (const c of clips) { await fs.unlink(c).catch(() => undefined) }

    return {
      ok: true,
      text: JSON.stringify({
        trailerReady: true, projectId: pid, title: p.title,
        usedShots: sources.map(s => s.index),
        clipSeconds: clipSec,
        withBgm,
        trailerPath,
        message: `预告片已生成：${sources.length} 段 × ${clipSec}s 快剪，路径 ${trailerPath}`
      })
    }
  }

  private async tListMemories(kind?: MemoryKind): Promise<{ ok: boolean; text: string }> {
    const valid: MemoryKind[] = ['preference', 'rule', 'lesson']
    const filter = kind && valid.includes(kind) ? kind : undefined
    const items = await this.memory.list(filter)
    if (!items.length) return { ok: true, text: JSON.stringify({ empty: true, message: '记忆库暂无内容' }) }
    return {
      ok: true,
      text: JSON.stringify(items.slice(0, 50).map(m => ({
        id: m.id, kind: m.kind, title: m.title, content: m.content
      })))
    }
  }

  private async tSaveMemory(args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    const kind = String(args.kind || '') as MemoryKind
    const title = String(args.title || '').trim()
    const content = String(args.content || '').trim()
    if (!['preference', 'rule', 'lesson'].includes(kind)) {
      return { ok: false, text: 'kind 必须是 preference/rule/lesson 之一' }
    }
    if (!title || !content) return { ok: false, text: 'title 与 content 不能为空' }
    const item = await this.memory.create({ kind, title, content })
    return { ok: true, text: JSON.stringify({ saved: true, id: item.id, kind, title }) }
  }

  // ===== 上下文组装 =====

  private async buildSystemPrompt(scope: string): Promise<string> {
    const lines: string[] = [
      '你是「短剧工坊」的 AI 导演助理，代号导演。你通过已授权的技能工具直接操作本应用：开拍、暂停/继续/取消任务、查看分镜与进度、重渲镜头、检查 ComfyUI、渲染试片、生成预告片、选择/调参/自建工作流。',
      '行为规则：',
      '1. 全部使用简体中文回复，语气专业、简洁、像真正的导演/制片，不啰嗦不客套。',
      '2. 开拍必须有完整剧本、片名、题材；信息不足时先追问，绝不能编造剧本。',
      '3. 取消任务属于破坏性操作，用户语气不明确时先确认再调用。',
      '4. 工具返回的是 JSON 数据，你要用自然语言总结给用户，不要原样抛 JSON。',
      '5. 需要查看信息才能回答时，先调用对应工具，不要凭记忆猜测项目状态。',
      '6. 每次工具调用后根据返回结果继续，直到能给出明确结论；最多连续 5 轮。'
    ]
    if (scope !== 'global') {
      try {
        const p = await this.projects.get(scope)
        lines.push('', '【当前项目快照】',
          `片名：${p.title}；题材：${p.genre}；角色：${p.characters.map(c => c.name).join('、') || '无'}`,
          `分镜数：${p.shots.length}`)
      } catch {
        lines.push('', '【当前项目快照】项目尚未建档。')
      }
      const st = this.director.getState(scope)
      if (st) {
        lines.push('【流水线实时状态】',
          `运行中：${st.running}；暂停等待：${st.paused}；镜头 ${st.doneShots}/${st.totalShots}；失败：${st.failedShotIds.length}`,
          `阶段确认点：${st.gateStages.join('、') || '无'}`,
          `成片：${st.finalPath || '未产出'}`)
      }
    } else {
      lines.push('', '【当前为全局对话】没有打开具体项目。用户给剧本要求开拍时可直接调用开拍技能（会自动创建项目并绑定为当前项目）；之后查询状态、分镜、暂停/继续/取消、重渲等项目类操作会自动作用于最近的项目，无需用户手动进入。')
    }
    const memory = await this.memory.summary()
    if (memory) {
      lines.push(
        '',
        '【导演长期记忆（跨项目沉淀，其中偏好与规则必须在创作和操作中遵守；与本次用户明确指令冲突时以本次指令为准）】',
        memory
      )
    }
    return lines.join('\n')
  }
}
