/**
 * 对话工具·工作流域：ComfyUI 状态、工作流列表/库导入/快速渲染、工作流选择与参数读写、自建工作流。
 * 从 conversationTools.ts 按域拆分外移，行为不变。
 * 注意：import_library_workflow 的 convertToApi 路径穿越修复在 workflowLibrary.ts 内，本文件仅原样调用与错误透传。
 */
import type { ConversationToolsHost, ToolResult } from './conversationTools'
import type { LibraryWorkflowItem } from './workflowLibrary'
import { RESULT_LIMIT } from './conversationConstants'

/** 工具层工作流存在性校验（M-9）：名称白名单在 workflowLoader.load()，这里只挡不存在 */
export async function workflowExists(host: ConversationToolsHost, name: string): Promise<boolean> {
  return (await host.workflows.list()).some(w => w.name === name)
}

/**
 * 为项目选择工作流（全局/项目/单镜头三级策略）：
 * - scope='global' → 改设置里的默认工作流
 * - scope='project' → 改 project.defaultWorkflow 并 save
 * - scope='shot' → 改指定分镜的 workflow 字段并 save
 */
export async function tChooseWorkflow(host: ConversationToolsHost, pid: string | undefined, args: Record<string, unknown>): Promise<ToolResult> {
  const scope = String(args.scope || 'project')
  const workflowName = String(args.workflow_name || '')
  if (!workflowName) return { ok: false, text: '缺少 workflow_name' }
  const list = await host.workflows.list()
  if (!list.some(w => w.name === workflowName)) {
    return { ok: false, text: `工作流 ${workflowName} 不存在` }
  }
  if (scope === 'global') {
    const s = await host.settings.get()
    s.workflow.default = workflowName
    await host.settings.save(s)
    return { ok: true, text: `全局默认工作流已设为：${workflowName}` }
  }
  if (scope === 'shot') {
    if (!pid) return { ok: false, text: '当前没有打开的项目' }
    const shotIndex = typeof args.shot_index === 'number' ? args.shot_index : Number(args.shot_index || 0)
    if (!shotIndex) return { ok: false, text: '单镜头模式需要 shot_index（1-based）' }
    const p = await host.projects.get(pid)
    const shot = p.shots.find(s => s.index === shotIndex)
    if (!shot) return { ok: false, text: `项目中不存在第 ${shotIndex} 个分镜` }
    shot.workflow = workflowName
    await host.projects.save(p)
    return { ok: true, text: `分镜 ${shotIndex} 已指定工作流：${workflowName}` }
  }
  // project（默认）
  if (!pid) return { ok: false, text: '当前没有打开的项目' }
  const p = await host.projects.get(pid)
  p.defaultWorkflow = workflowName
  await host.projects.save(p)
  return { ok: true, text: `项目默认工作流已设为：${workflowName}。新增镜头和没有单独指定工作流的镜头将使用此引擎。` }
}

export async function tGetComfyuiStatus(host: ConversationToolsHost): Promise<ToolResult> {
  const ok = await host.comfy.healthCheck()
  return { ok: true, text: JSON.stringify({ online: ok }) }
}

export async function tListWorkflows(host: ConversationToolsHost, pid: string | undefined): Promise<ToolResult> {
  const list = await host.workflows.list()
  const s = await host.settings.get()
  const p = pid ? await host.projects.get(pid).catch(() => null) : null
  let library: unknown = null
  if (host.workflowLibrary) {
    const items = await host.workflowLibrary.list()
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

export async function tImportLibraryWorkflow(host: ConversationToolsHost, args: Record<string, unknown>): Promise<ToolResult> {
  const rel = String(args.path || '').trim()
  if (!rel) return { ok: false, text: '缺少 path（工作流库内相对路径，先用 list_workflows 查看 library）' }
  if (!host.workflowLibrary) return { ok: false, text: '工作流库未配置（settings.comfyui.workflowLibraryDir）' }
  try {
    const objectInfo = await host.comfy.getObjectInfo()
    const conv = host.workflowLibrary.convertToApi(rel, objectInfo)
    const baseName = rel.split(/[\\/]/).pop()!.replace(/\.json$/i, '').replace(/[^\w一-龥-]/g, '_') || 'library_workflow'
    const finalName = await host.workflows.createWorkflow(baseName, JSON.stringify(conv.graph))
    const meta = await host.workflows.getMeta(finalName)
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

export async function tRenderQuick(host: ConversationToolsHost, args: Record<string, unknown>): Promise<ToolResult> {
  // 快速生成入口：导演按用户意图自动选择工作流（t2v/i2v/flf2v/t2i/i2i）
  // 用户给参考图 → 选 i2v/i2i 并把 ref_image 传绝对路径；纯文字 → t2v/t2i 不传图
  const workflowName = String(args.workflow_name || '')
  const prompt = String(args.prompt || '')
  if (!workflowName || !prompt) return { ok: false, text: '缺少 workflow_name/prompt' }
  try {
    const out = await host.queue.quickRender({
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

export async function tGetWorkflowParams(host: ConversationToolsHost, args: Record<string, unknown>): Promise<ToolResult> {
  const name = String(args.workflow_name || '')
  if (!name) return { ok: false, text: '缺少 workflow_name' }
  // 工具层二次校验：load() 的名称白名单挡路径穿越，这里挡"不存在的名称"
  //（否则底层 ENOENT 会以原始英文报错直透 LLM）（M-9）
  if (!await workflowExists(host, name)) return { ok: false, text: `工作流不存在：${name}` }
  const params = await host.workflows.getEditableParams(name)
  return { ok: true, text: JSON.stringify(params.slice(0, 80)).slice(0, RESULT_LIMIT) }
}

export async function tUpdateWorkflowParam(host: ConversationToolsHost, args: Record<string, unknown>): Promise<ToolResult> {
  const name = String(args.workflow_name || '')
  const nodeId = String(args.node_id || '')
  const key = String(args.key || '')
  if (!name || !nodeId || !key) return { ok: false, text: '缺少 workflow_name/node_id/key' }
  if (!await workflowExists(host, name)) return { ok: false, text: `工作流不存在：${name}` }
  const v = args.value
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
    return { ok: false, text: 'value 必须是字符串/数字/布尔' }
  }
  await host.workflows.updateParam(name, nodeId, key, v)
  return { ok: true, text: `已更新 ${name} 节点 ${nodeId} 的 ${key}` }
}

export async function tCreateWorkflow(host: ConversationToolsHost, args: Record<string, unknown>): Promise<ToolResult> {
  const name = String(args.name || '')
  const content = String(args.content || '')
  if (!name || !content) return { ok: false, text: '缺少 name/content' }
  const finalName = await host.workflows.createWorkflow(name, content)
  return { ok: true, text: `工作流已创建：${finalName}（可在设置→工作流中查看）` }
}
