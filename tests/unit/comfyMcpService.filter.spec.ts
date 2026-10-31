import { describe, expect, it } from 'vitest'
import { filterMcpTools, isManagedMcpTool } from '../../src/main/core/comfyMcpService'

/**
 * comfy-mcp 实测工具名清单（v0.10.0，D:\ComfyUI-V20\comfy-mcp-venv，
 * 来源：comfy_mcp/server.py 全部 39 个 @mcp.tool() 注册函数名）。
 * 这些名字是 listToolSpecs 过滤的输入全集。
 */
const ALL_COMFY_MCP_TOOLS = [
  'server_info',
  'auth_status',
  'auth_login',
  'run_workflow',
  'generate_image',
  'list_partner_models',
  'partner_model_schema',
  'partner_generate',
  'emit_partner_workflow',
  'run_template',
  'job',
  'system_stats',
  'free_memory',
  'fetch_outputs',
  'launch_comfyui',
  'stop_comfyui',
  'restart_comfyui',
  'update_comfyui',
  'switch_comfyui_version',
  'install_node',
  'get_logs',
  'discover',
  'which',
  'project',
  'search_templates',
  'get_template',
  'fetch_template',
  'nodes',
  'node_dependencies',
  'workflow_deps',
  'search_models',
  'download_model',
  'download',
  'upload_file',
  'validate_workflow',
  'list_workflow_slots',
  'list_workflow_notes',
  'set_workflow_slot',
  'vary_workflow',
]

/** 确认要过滤的管理类（生命周期/安装/破坏性变更） */
const MANAGED_TOOLS = [
  'auth_login',
  'launch_comfyui',
  'stop_comfyui',
  'restart_comfyui',
  'update_comfyui',
  'switch_comfyui_version',
  'install_node',
]

/** 必须保留的渲染/查询/提交类（导演对话合法链路） */
const RENDER_QUERY_TOOLS = [
  'run_workflow',
  'generate_image',
  'run_template',
  'partner_generate',
  'job',
  'system_stats',
  'fetch_outputs',
  'upload_file',
  'get_logs',
  'nodes',
  'node_dependencies',
  'workflow_deps',
  'search_models',
  'search_templates',
  'get_template',
  'fetch_template',
  'discover',
  'which',
  'server_info',
  'auth_status',
  'project',
  'validate_workflow',
  'list_workflow_slots',
  'list_workflow_notes',
  'set_workflow_slot',
  'vary_workflow',
  'free_memory',
  'download_model',
  'download',
  'list_partner_models',
  'partner_model_schema',
  'emit_partner_workflow',
]

describe('comfyMcpService 管理类工具过滤', () => {
  it('管理类工具被识别为应过滤', () => {
    for (const name of MANAGED_TOOLS) {
      expect(isManagedMcpTool(name), `应过滤管理类工具: ${name}`).toBe(true)
    }
  })

  it('渲染/查询/提交类保留（不误伤导演对话合法链路）', () => {
    for (const name of RENDER_QUERY_TOOLS) {
      expect(isManagedMcpTool(name), `不应过滤渲染/查询类工具: ${name}`).toBe(false)
    }
  })

  it('实测 39 个工具全集：恰好过滤 7 个管理类，保留 32 个', () => {
    const kept = filterMcpTools(ALL_COMFY_MCP_TOOLS.map((name) => ({ name })))
    const keptNames = kept.map((t) => t.name)
    expect(keptNames).toHaveLength(39 - MANAGED_TOOLS.length)
    for (const name of MANAGED_TOOLS) {
      expect(keptNames, `管理类工具不应出现: ${name}`).not.toContain(name)
    }
    for (const name of RENDER_QUERY_TOOLS) {
      expect(keptNames, `渲染/查询类工具被误伤: ${name}`).toContain(name)
    }
  })

  it('关键字模式兜底：未来新增的同类管理工具自动命中', () => {
    for (const name of [
      'start_comfyui',
      'shutdown_comfyui', // 生命周期别名
      'uninstall_node',
      'reinstall_comfyui', // 安装/重装变体
      'delete_model',
      'remove_node_pack', // 删除/移除变体
      'upgrade_comfyui', // 升级变体
    ]) {
      expect(isManagedMcpTool(name), `模式兜底应过滤: ${name}`).toBe(true)
    }
  })

  it('未知普通工具默认放行（动态展开不误伤）', () => {
    for (const name of [
      'queue_prompt',
      'get_history',
      'get_queue',
      'get_object_info',
      'interrupt', // 常见 comfy 查询/控制类
      'foo_bar',
      'list_something',
      'my_query_tool',
      'node_info', // 完全未知的新工具
    ]) {
      expect(isManagedMcpTool(name), `未知工具应默认放行: ${name}`).toBe(false)
    }
  })

  it('空列表与异常输入安全', () => {
    expect(filterMcpTools([])).toEqual([])
    expect(isManagedMcpTool('')).toBe(false)
    expect(isManagedMcpTool(undefined as unknown as string)).toBe(false)
  })

  it('过滤保持原顺序且不破坏其它字段', () => {
    const tools = [
      { name: 'run_workflow', description: 'a' },
      { name: 'install_node', description: 'b' },
      { name: 'job', description: 'c' },
    ]
    const kept = filterMcpTools(tools)
    expect(kept.map((t) => t.name)).toEqual(['run_workflow', 'job'])
    expect(kept[0]?.description).toBe('a')
  })
})
