import { describe, it, expect, vi, beforeEach } from 'vitest'

// conversationToolDispatcher import 链里会触发：
//   comfyMcpService → @modelcontextprotocol/sdk
//   conversationService → electron
// 先屏蔽这些
vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() }
}))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn()
}))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
  getDefaultEnvironment: vi.fn()
}))

import { executeToolImpl } from '../../src/main/core/conversationToolDispatcher'

function mkAgent(overrides: Record<string, any> = {}): any {
  return {
    comfyMcp: undefined,
    workflowLibrary: undefined,
    workflowExists: vi.fn(async () => false),
    resolvePid: vi.fn(async (pid: string | undefined) => pid ?? 'pid'),
    tStart: vi.fn(),
    tSimple: vi.fn(),
    tStatus: vi.fn(),
    tListShots: vi.fn(),
    tRerender: vi.fn(),
    tRenderSample: vi.fn(),
    tMakeTrailer: vi.fn(),
    tRebuildFrames: vi.fn(),
    director: { rebuildShotFirstFrames: vi.fn(), rerunCasting: vi.fn() },
    comfy: { healthCheck: vi.fn() },
    workflows: { list: vi.fn(), createWorkflow: vi.fn(), getMeta: vi.fn(), getEditableParams: vi.fn(), updateParam: vi.fn() },
    settings: { get: vi.fn() },
    projects: { get: vi.fn() },
    queue: { quickRender: vi.fn() },
    tListMemories: vi.fn(),
    tSaveMemory: vi.fn(),
    tGetSettings: vi.fn(),
    tSetSettings: vi.fn(),
    tListCharacters: vi.fn(),
    tUpdateCharacter: vi.fn(),
    tUpdateShot: vi.fn(),
    tAddShot: vi.fn(),
    tDeleteShot: vi.fn(),
    tMoveShot: vi.fn(),
    tListProjects: vi.fn(),
    tOpenProject: vi.fn(),
    tSetProjectBgm: vi.fn(),
    tListProjectFiles: vi.fn(),
    tOpenFile: vi.fn(),
    tWebSearch: vi.fn(),
    tFetchUrl: vi.fn(),
    tCreateSkill: vi.fn(),
    tListSkills: vi.fn(),
    tUpdateSkill: vi.fn(),
    runCustomSkill: vi.fn(),
    tChooseWorkflow: vi.fn(),
    tGetWorkflowParams: vi.fn(),
    tUpdateWorkflowParam: vi.fn(),
    tCreateWorkflow: vi.fn(),
    ...overrides
  }
}

describe('conversationToolDispatcher · executeToolImpl（前置分支 + 路由）', () => {
  it('argsJson 不是合法 JSON → ok=false', async () => {
    const r = await executeToolImpl(mkAgent(), 'global', 'list_projects', 'not-json')
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/不是合法 JSON/)
  })

  it('空字符串 argsJson → args={} 正常解析', async () => {
    const agent = mkAgent({ tListProjects: vi.fn(async () => ({ ok: true, text: '[]' })) })
    const r = await executeToolImpl(agent, 'global', 'list_projects', '')
    expect(r.ok).toBe(true)
  })

  it('signal.aborted → 返回 ok=false 不执行', async () => {
    const signal = new AbortController().signal
    // AbortController signal 初始状态是 aborted=false，手动触发
    const ctrl = new AbortController()
    ctrl.abort()
    const agent = mkAgent({ tListProjects: vi.fn(async () => ({ ok: true, text: '[]' })) })
    const r = await executeToolImpl(agent, 'global', 'list_projects', '{}', ctrl.signal)
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/已停止/)
    // 确认 tListProjects 没有被调用
    expect(agent.tListProjects).not.toHaveBeenCalled()
  })

  it('未知工具名 → default 分支 ok=false', async () => {
    const r = await executeToolImpl(mkAgent(), 'global', 'totally_unknown_tool', '{}')
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/未知工具/)
  })

  it('COMFY_MCP_PREFIX 开头但 agent.comfyMcp 未启用 → ok=false', async () => {
    const r = await executeToolImpl(mkAgent({ comfyMcp: undefined }), 'global', 'mcp_comfy__foo', '{}')
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/未启用或未安装/)
  })

  it('COMFY_MCP_PREFIX 正常路由到 agent.comfyMcp.callTool', async () => {
    const callTool = vi.fn(async () => ({ ok: true, text: 'mcp-ok' }))
    const agent = mkAgent({
      comfyMcp: { callTool }
    })
    const r = await executeToolImpl(agent, 'pid1', 'mcp_comfy__test', '{"x":1}')
    expect(callTool).toHaveBeenCalledWith('mcp_comfy__test', { x: 1 }, undefined)
    expect(r.ok).toBe(true)
  })

  it('custom_ 前缀 → runCustomSkill', async () => {
    const runCustomSkill = vi.fn(async () => ({ ok: true, text: 'skill-ok' }))
    const agent = mkAgent({ runCustomSkill })
    const r = await executeToolImpl(agent, 'pid1', 'custom_my_skill', '{"user_text":"hi"}')
    expect(r.ok).toBe(true)
    expect(runCustomSkill).toHaveBeenCalledWith('custom_my_skill', { user_text: 'hi' }, undefined)
  })

  it('scope=global 时 pid 为 undefined', async () => {
    const agent = mkAgent({
      tListCharacters: vi.fn(async () => ({ ok: true, text: '[]' })),
      resolvePid: vi.fn(async (pid: string | undefined) => pid ?? 'resolved')
    })
    await executeToolImpl(agent, 'global', 'list_characters', '{}')
    expect(agent.resolvePid).toHaveBeenCalledWith(undefined)
  })

  it('scope=pid1 时 scope 作为 pid 传给 agent', async () => {
    const agent = mkAgent({
      resolvePid: vi.fn(async (pid: string | undefined) => pid ?? 'resolved'),
      tListCharacters: vi.fn(async () => ({ ok: true, text: '[]' }))
    })
    await executeToolImpl(agent, 'pid1', 'list_characters', '{}')
    expect(agent.resolvePid).toHaveBeenCalledWith('pid1')
  })

  // ---- switch case 校验分支 ----

  it('rebuild_frames：shot_indexes 为空 → ok=false', async () => {
    const r = await executeToolImpl(mkAgent(), 'pid1', 'rebuild_frames', '{}')
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/shot_indexes/)
  })

  it('rebuild_frames：shot_indexes 有效 → 调用 director.rebuildShotFirstFrames', async () => {
    const rebuild = vi.fn(async () => ({ ok: true, text: 'done' }))
    const agent = mkAgent({ director: { rebuildShotFirstFrames: rebuild, rerunCasting: vi.fn() } })
    const r = await executeToolImpl(agent, 'pid1', 'rebuild_frames', '{"shot_indexes":[1,2]}')
    expect(rebuild).toHaveBeenCalledWith('pid1', [1, 2])
  })

  it('import_library_workflow：path 为空 → ok=false', async () => {
    const r = await executeToolImpl(mkAgent(), 'pid1', 'import_library_workflow', '{}')
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/缺少 path/)
  })

  it('import_library_workflow：workflowLibrary 未配置 → ok=false', async () => {
    const r = await executeToolImpl(mkAgent({ workflowLibrary: undefined }), 'pid1', 'import_library_workflow', '{"path":"x"}')
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/未配置/)
  })

  it('render_quick：缺 workflow_name → ok=false', async () => {
    const r = await executeToolImpl(mkAgent(), 'pid1', 'render_quick', '{"prompt":"hi"}')
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/缺少 workflow_name\/prompt/)
  })

  it('render_quick：缺 prompt → ok=false', async () => {
    const r = await executeToolImpl(mkAgent(), 'pid1', 'render_quick', '{"workflow_name":"wf"}')
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/缺少 workflow_name\/prompt/)
  })

  it('render_quick：queue.quickRender 抛错 → catch 返回 ok=false', async () => {
    const queue = { quickRender: vi.fn(async () => { throw new Error('boom') }) }
    const agent = mkAgent({ queue })
    const r = await executeToolImpl(agent, 'pid1', 'render_quick', '{"workflow_name":"wf","prompt":"hi"}')
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/生成失败/)
  })

  it('render_quick：成功路径 → ok=true', async () => {
    const queue = { quickRender: vi.fn(async () => ({ outputAbs: '/tmp/x.mp4', promptId: 'p1' })) }
    const agent = mkAgent({ queue })
    const r = await executeToolImpl(agent, 'pid1', 'render_quick', '{"workflow_name":"wf","prompt":"hi"}')
    expect(r.ok).toBe(true)
  })

  it('get_comfyui_status：ok=true 且返回 online 状态', async () => {
    const comfy = { healthCheck: vi.fn(async () => true) }
    const agent = mkAgent({ comfy })
    const r = await executeToolImpl(agent, 'pid1', 'get_comfyui_status', '{}')
    expect(r.ok).toBe(true)
    expect(JSON.parse(r.text)).toEqual({ online: true })
  })

  it('get_workflow_params：缺 workflow_name → ok=false', async () => {
    const r = await executeToolImpl(mkAgent(), 'pid1', 'get_workflow_params', '{}')
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/缺少 workflow_name/)
  })

  it('get_workflow_params：workflow 不存在 → ok=false', async () => {
    const agent = mkAgent({ workflowExists: vi.fn(async () => false) })
    const r = await executeToolImpl(agent, 'pid1', 'get_workflow_params', '{"workflow_name":"nope"}')
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/工作流不存在/)
  })

  it('update_workflow_param：缺 name/node_id/key → ok=false', async () => {
    const r = await executeToolImpl(mkAgent(), 'pid1', 'update_workflow_param', '{}')
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/缺少 workflow_name\/node_id\/key/)
  })

  it('update_workflow_param：value 类型不对 → ok=false', async () => {
    const agent = mkAgent({ workflowExists: vi.fn(async () => true) })
    const r = await executeToolImpl(agent, 'pid1', 'update_workflow_param',
      '{"workflow_name":"w","node_id":"n","key":"k","value":[1,2,3]}')
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/必须是字符串\/数字\/布尔/)
  })

  it('update_workflow_param：成功路径', async () => {
    const updateParam = vi.fn(async () => {})
    const agent = mkAgent({
      workflowExists: vi.fn(async () => true),
      workflows: { updateParam, list: vi.fn(), createWorkflow: vi.fn(), getMeta: vi.fn(), getEditableParams: vi.fn() }
    })
    const r = await executeToolImpl(agent, 'pid1', 'update_workflow_param',
      '{"workflow_name":"w","node_id":"n","key":"k","value":"v"}')
    expect(r.ok).toBe(true)
    expect(updateParam).toHaveBeenCalledWith('w', 'n', 'k', 'v')
  })

  it('create_workflow：缺 name/content → ok=false', async () => {
    const r = await executeToolImpl(mkAgent(), 'pid1', 'create_workflow', '{}')
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/缺少 name\/content/)
  })

  it('create_workflow：成功路径', async () => {
    const createWf = vi.fn(async () => 'final_name')
    const agent = mkAgent({
      workflows: { createWorkflow: createWf, list: vi.fn(), getMeta: vi.fn(), getEditableParams: vi.fn(), updateParam: vi.fn() }
    })
    const r = await executeToolImpl(agent, 'pid1', 'create_workflow', '{"name":"n","content":"{}"}')
    expect(r.ok).toBe(true)
    expect(createWf).toHaveBeenCalledWith('n', '{}')
  })

  it('list_workflows：agent.workflowLibrary 不存在 → library=null', async () => {
    const agent = mkAgent({
      workflowLibrary: undefined,
      workflows: { list: vi.fn(async () => [{ name: 'w', placeholders: [], capability: '', hasImageInput: false }]), createWorkflow: vi.fn(), getMeta: vi.fn(), getEditableParams: vi.fn(), updateParam: vi.fn() },
      settings: { get: vi.fn(async () => ({ workflow: { default: 'wf1' } })) },
      projects: { get: vi.fn(async () => ({ defaultWorkflow: 'w2' })) }
    })
    const r = await executeToolImpl(agent, 'pid1', 'list_workflows', '{}')
    expect(r.ok).toBe(true)
    const parsed = JSON.parse(r.text)
    expect(parsed.library).toBeNull()
    expect(parsed.globalDefault).toBe('wf1')
    expect(parsed.projectDefault).toBe('w2')
  })

  it('list_workflows：agent.workflowLibrary 存在 → library 有分类', async () => {
    const agent = mkAgent({
      workflowLibrary: {
        list: vi.fn(async () => [
          { category: 'cat1', format: 'ui', relPath: 'a.json' },
          { category: 'cat1', format: 'api', relPath: 'b.json' },
          { category: 'cat2', format: 'ui', relPath: 'c.json' }
        ])
      },
      workflows: { list: vi.fn(async () => []), createWorkflow: vi.fn(), getMeta: vi.fn(), getEditableParams: vi.fn(), updateParam: vi.fn() },
      settings: { get: vi.fn(async () => ({ workflow: { default: 'wf1' } })) },
      projects: { get: vi.fn(async () => null) }
    })
    const r = await executeToolImpl(agent, 'pid1', 'list_workflows', '{}')
    expect(r.ok).toBe(true)
    const parsed = JSON.parse(r.text)
    expect(parsed.library.total).toBe(3)
    expect(parsed.library.uiCount).toBe(2)
    expect(parsed.library.apiCount).toBe(1)
    expect(parsed.library.categories).toHaveLength(2)
  })

  it('import_library_workflow：成功路径', async () => {
    const wfLib = {
      list: vi.fn(async () => []),
      convertToApi: vi.fn(() => ({ graph: {}, nodeCount: 5, unknownNodeTypes: [] }))
    }
    const comfy = { healthCheck: vi.fn(), getObjectInfo: vi.fn(async () => ({})) }
    const createWf = vi.fn(async () => 'imported_name')
    const getMeta = vi.fn(async () => ({ placeholders: [], capability: '', unknownNodeTypes: [] }))
    const agent = mkAgent({
      workflowLibrary: wfLib,
      comfy,
      workflows: { createWorkflow: createWf, getMeta, list: vi.fn(), getEditableParams: vi.fn(), updateParam: vi.fn() }
    })
    const r = await executeToolImpl(agent, 'pid1', 'import_library_workflow', '{"path":"foo/bar.json"}')
    expect(r.ok).toBe(true)
    // baseName 应该是 'bar'
    expect(createWf).toHaveBeenCalledWith('bar', expect.any(String))
  })

  it('import_library_workflow：convertToApi 抛错 → catch 返回 ok=false', async () => {
    const wfLib = {
      list: vi.fn(async () => []),
      convertToApi: vi.fn(() => { throw new Error('bad path') })
    }
    const agent = mkAgent({
      workflowLibrary: wfLib,
      comfy: { healthCheck: vi.fn(), getObjectInfo: vi.fn(async () => ({})) }
    })
    const r = await executeToolImpl(agent, 'pid1', 'import_library_workflow', '{"path":"foo.json"}')
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/导入失败.*bad path/)
  })

  it('executor 外层 catch 捕获意外异常', async () => {
    // 让 resolvePid 抛错，触发外层 catch
    const agent = mkAgent({
      resolvePid: vi.fn(async () => { throw new Error('unexpected') }),
      tSimple: vi.fn()
    })
    const r = await executeToolImpl(agent, 'pid1', 'pause_director', '{}')
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/执行失败.*unexpected/)
  })
})
