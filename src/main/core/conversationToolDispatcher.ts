/**
 * 工具分发器：按工具名路由到对应处理器（实现集中在 conversationTools* 分片，本文件只做路由），
 * 并处理 comfy-mcp 动态工具与自定义技能（custom_）前缀。
 */
import { COMFY_MCP_PREFIX } from './comfyMcpService'
import type { MemoryKind } from '../../shared/ipcTypes'
import {
  tRebuildFrames, tGetComfyuiStatus, tListWorkflows,
  tImportLibraryWorkflow, tRenderQuick, tGetWorkflowParams,
  tUpdateWorkflowParam, tCreateWorkflow
} from './conversationTools'
import type { ConversationService } from './conversationService'

export async function executeToolImpl(agent: ConversationService, scope: string, name: string, argsJson: string, signal?: AbortSignal): Promise<{ ok: boolean; text: string }> {
  let args: Record<string, unknown>
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
      case 'rebuild_frames': return await tRebuildFrames(agent, await agent.resolvePid(pid), args)
      case 'rerun_casting': return await agent.director.rerunCasting(await agent.resolvePid(pid))
      case 'render_sample': return await agent.tRenderSample(await agent.resolvePid(pid), args)
      case 'make_trailer': return await agent.tMakeTrailer(await agent.resolvePid(pid), args)
      case 'get_comfyui_status': return await tGetComfyuiStatus(agent)
      case 'list_workflows': return await tListWorkflows(agent, pid)
      case 'import_library_workflow': return await tImportLibraryWorkflow(agent, args)
      case 'render_quick': return await tRenderQuick(agent, args)
      case 'choose_workflow': return await agent.tChooseWorkflow(pid, args)
      case 'get_workflow_params': return await tGetWorkflowParams(agent, args)
      case 'update_workflow_param': return await tUpdateWorkflowParam(agent, args)
      case 'create_workflow': return await tCreateWorkflow(agent, args)
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

