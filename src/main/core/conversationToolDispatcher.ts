/**
 * 工具分发器：按工具名路由到对应的 t* 处理器（保留在 ConversationService 上），
 * 并处理 comfy-mcp 动态工具与自定义技能（custom_）前缀。
 * 从 conversationService.ts 抽出，行为不变。
 */
import { COMFY_MCP_PREFIX } from './comfyMcpService'
import type { LibraryWorkflowItem } from './workflowLibrary'
import type { MemoryKind } from '../../shared/ipcTypes'
import { RESULT_LIMIT } from './conversationConstants'
import type { ConversationService } from './conversationService'

export async function executeToolImpl(agent: ConversationService, scope: string, name: string, argsJson: string, signal?: AbortSignal): Promise<{ ok: boolean; text: string }> {
  let args: Record<string, unknown> = {}
  try {
    args = argsJson ? JSON.parse(argsJson) as Record<string, unknown> : {}
  } catch {
    return { ok: false, text: `参数不是合法 JSON：${argsJson}` }
  }
  // C4：工具执行前置取消检查——长耗时工具（自定义技能 LLM 调用等）透传 signal
  if (signal?.aborted) return { ok: false, text: '（本轮已停止，工具未执行）' }
  const pid = scope === 'global' ? undefined : scope
  try {
    if (name.startsWith(COMFY_MCP_PREFIX)) {
      if (!agent.comfyMcp) return { ok: false, text: 'ComfyUI-MCP 技能未启用或未安装' }
      return await agent.comfyMcp.callTool(name, args, signal)
    }
    if (name.startsWith('custom_')) return await agent.runCustomSkill(name, args, signal)
    switch (name) {
      case 'start_director': return await agent.tStart(pid, args)
      case 'pause_director': return await agent.tSimple(await agent.resolvePid(pid), 'pause')
      case 'resume_director': return await agent.tSimple(await agent.resolvePid(pid), 'resume')
      case 'cancel_director': return await agent.tSimple(await agent.resolvePid(pid), 'cancel')
      case 'get_director_status': return await agent.tStatus(await agent.resolvePid(pid))
      case 'list_shots': return await agent.tListShots(await agent.resolvePid(pid))
      case 'rerender_shots': return await agent.tRerender(await agent.resolvePid(pid), args)
      case 'rebuild_frames': {
        const pid2 = await agent.resolvePid(pid)
        const shotIndexes = Array.isArray(args.shot_indexes) ? (args.shot_indexes as number[]).map(Number) : []
        if (!shotIndexes.length) return { ok: false, text: '未指定镜号（shot_indexes）' }
        return await agent.director.rebuildShotFirstFrames(pid2, shotIndexes)
      }
      case 'rerun_casting': return await agent.director.rerunCasting(await agent.resolvePid(pid))
      case 'render_sample': return await agent.tRenderSample(await agent.resolvePid(pid), args)
      case 'make_trailer': return await agent.tMakeTrailer(await agent.resolvePid(pid), args)
      case 'get_comfyui_status': {
        const ok = await agent.comfy.healthCheck()
        return { ok: true, text: JSON.stringify({ online: ok }) }
      }
      case 'list_workflows': {
        const list = await agent.workflows.list()
        const s = await agent.settings.get()
        const p = pid ? await agent.projects.get(pid).catch(() => null) : null
        let library: unknown = null
        if (agent.workflowLibrary) {
          const items = await agent.workflowLibrary.list()
          const byCat = new Map<string, LibraryWorkflowItem[]>()
          for (const it of items) {
            const arr = byCat.get(it.category) ?? []
            arr.push(it)
            byCat.set(it.category, arr)
          }
          library = {
            total: items.length,
            uiCount: items.filter(i => i.format === 'ui').length,
            apiCount: items.filter(i => i.format === 'api').length,
            categories: [...byCat.entries()].map(([category, list]) => ({
              category,
              count: list.length,
              files: list.map(it => it.relPath)
            }))
          }
        }
        return { ok: true, text: JSON.stringify({
          globalDefault: s.workflow.default,
          projectDefault: p?.defaultWorkflow || null,
          available: list.map(w => ({ name: w.name, placeholders: w.placeholders, capability: w.capability, hasImageInput: w.hasImageInput })),
          // 工作流库（用户收集的 ComfyUI 工作流全集，多为 UI 格式）：
          // 需用 import_library_workflow 转换导入后才能跑
          library
        }) }
      }
      case 'import_library_workflow': {
        const rel = String(args.path || '').trim()
        if (!rel) return { ok: false, text: '缺少 path（工作流库内相对路径，先用 list_workflows 查看 library）' }
        if (!agent.workflowLibrary) return { ok: false, text: '工作流库未配置（settings.comfyui.workflowLibraryDir）' }
        try {
          const objectInfo = await agent.comfy.getObjectInfo()
          const conv = agent.workflowLibrary.convertToApi(rel, objectInfo)
          const baseName = rel.split(/[\\/]/).pop()!.replace(/\.json$/i, '').replace(/[^\w一-龥-]/g, '_') || 'library_workflow'
          const finalName = await agent.workflows.createWorkflow(baseName, JSON.stringify(conv.graph))
          const meta = await agent.workflows.getMeta(finalName)
          return { ok: true, text: JSON.stringify({
            imported: finalName,
            nodeCount: conv.nodeCount,
            placeholders: meta.placeholders,
            capability: meta.capability,
            // 缺节点/缺模型请用 validate_workflows 校验；提示词/种子/参考图等动态字段用 get_workflow_params 查后 update_workflow_param 改
            unknownNodeTypes: conv.unknownNodeTypes,
            note: '已从工作流库导入为应用模板，可直接在渲染中使用；动态字段建议换成 $PROMPT$/$SEED$/$REF_IMAGE$ 占位符以复用流水线变量'
          }) }
        } catch (e) {
          return { ok: false, text: `导入失败：${e instanceof Error ? e.message : String(e)}` }
        }
      }
      case 'render_quick': {
        // 快速生成入口：导演按用户意图自动选择工作流（t2v/i2v/flf2v/t2i/i2i）
        // 用户给参考图 → 选 i2v/i2i 并把 ref_image 传绝对路径；纯文字 → t2v/t2i 不传图
        const workflowName = String(args.workflow_name || '')
        const prompt = String(args.prompt || '')
        if (!workflowName || !prompt) return { ok: false, text: '缺少 workflow_name/prompt' }
        try {
          const out = await agent.queue.quickRender({
            workflowName,
            prompt,
            refImageAbs: args.ref_image ? String(args.ref_image) : undefined,
            endImageAbs: args.end_image ? String(args.end_image) : undefined,
            seed: typeof args.seed === 'number' ? args.seed : undefined,
            durationSec: typeof args.duration_sec === 'number' ? args.duration_sec : undefined,
            width: typeof args.width === 'number' ? args.width : undefined,
            height: typeof args.height === 'number' ? args.height : undefined
          })
          return { ok: true, text: JSON.stringify({
            workflow: workflowName,
            output: out.outputAbs,
            promptId: out.promptId,
            note: '产物已保存，可直接打开观看；要改提示词/换参考图再生成就说「换个提示词再来一条」'
          }) }
        } catch (e) {
          return { ok: false, text: `生成失败：${e instanceof Error ? e.message : String(e)}` }
        }
      }
      case 'choose_workflow': return await agent.tChooseWorkflow(pid, args)
      case 'get_workflow_params': {
        const name = String(args.workflow_name || '')
        if (!name) return { ok: false, text: '缺少 workflow_name' }
        // 工具层二次校验：load() 的名称白名单挡路径穿越，这里挡"不存在的名称"
        //（否则底层 ENOENT 会以原始英文报错直透 LLM）（M-9）
        if (!await agent.workflowExists(name)) return { ok: false, text: `工作流不存在：${name}` }
        const params = await agent.workflows.getEditableParams(name)
        return { ok: true, text: JSON.stringify(params.slice(0, 80)).slice(0, RESULT_LIMIT) }
      }
      case 'update_workflow_param': {
        const name = String(args.workflow_name || '')
        const nodeId = String(args.node_id || '')
        const key = String(args.key || '')
        if (!name || !nodeId || !key) return { ok: false, text: '缺少 workflow_name/node_id/key' }
        if (!await agent.workflowExists(name)) return { ok: false, text: `工作流不存在：${name}` }
        const v = args.value
        if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
          return { ok: false, text: 'value 必须是字符串/数字/布尔' }
        }
        await agent.workflows.updateParam(name, nodeId, key, v)
        return { ok: true, text: `已更新 ${name} 节点 ${nodeId} 的 ${key}` }
      }
      case 'create_workflow': {
        const name = String(args.name || '')
        const content = String(args.content || '')
        if (!name || !content) return { ok: false, text: '缺少 name/content' }
        const finalName = await agent.workflows.createWorkflow(name, content)
        return { ok: true, text: `工作流已创建：${finalName}（可在设置→工作流中查看）` }
      }
      case 'list_memories':
        return await agent.tListMemories(args.kind as MemoryKind | undefined)
      case 'save_memory':
        return await agent.tSaveMemory(args)
      case 'list_characters': return await agent.tListCharacters(await agent.resolvePid(pid))
      case 'update_character': return await agent.tUpdateCharacter(await agent.resolvePid(pid), args)
      case 'update_shot': return await agent.tUpdateShot(await agent.resolvePid(pid), args)
      case 'add_shot': return await agent.tAddShot(await agent.resolvePid(pid), args)
      case 'delete_shot': return await agent.tDeleteShot(await agent.resolvePid(pid), args)
      case 'move_shot': return await agent.tMoveShot(await agent.resolvePid(pid), args)
      case 'list_projects': return await agent.tListProjects()
      case 'open_project': return await agent.tOpenProject(args)
      case 'get_settings': return await agent.tGetSettings()
      case 'set_settings': return await agent.tSetSettings(args)
      case 'set_project_bgm': return await agent.tSetProjectBgm(await agent.resolvePid(pid), args)
      case 'list_project_files': return await agent.tListProjectFiles(await agent.resolvePid(pid))
      case 'open_file': return await agent.tOpenFile(args)
      case 'web_search': return await agent.tWebSearch(args)
      case 'fetch_url': return await agent.tFetchUrl(args)
      case 'create_skill': return await agent.tCreateSkill(args)
      case 'list_skills': return await agent.tListSkills()
      case 'update_skill': return await agent.tUpdateSkill(args)
      default:
        return { ok: false, text: `未知工具：${name}` }
    }
  } catch (e) {
    return { ok: false, text: `执行失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

export async function runCustomSkillImpl(agent: ConversationService, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: boolean; text: string }> {
  const skillId = name.replace(/^custom_/, '')
  const all = await agent.skills.list()
  const skill = all.find(s => s.id === skillId)
  if (!skill || !skill.enabled) return { ok: false, text: '技能不存在或已停用' }
  const userText = String(args.user_text || '')
  const system = (skill.promptTemplate || '').replace(/\{\{\s*input\s*\}\}/g, () => userText) || userText
  const reply = await agent.llm.chatCompletion(
    [
      { role: 'system', content: system },
      { role: 'user', content: userText || '请按技能说明执行' }
    ],
    { temperature: 0.7, signal }
  )
  return { ok: true, text: reply.content }
}
