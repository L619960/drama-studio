import { describe, it, expect, vi } from 'vitest'

// 与已有 spec 相同：屏蔽 import 链上的 electron / MCP SDK（不碰真实网络与 ComfyUI）
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
import type { ConversationService } from '../../src/main/core/conversationService'

type Ret = { ok: boolean; text: string }
const ok = (text = 'ok'): Ret => ({ ok: true, text })

function mkAgent(overrides: Record<string, unknown> = {}) {
  const agent: Record<string, unknown> = {
    comfyMcp: undefined,
    workflowLibrary: undefined,
    workflowExists: vi.fn(async () => true),
    resolvePid: vi.fn(async (pid?: string) => pid ?? 'resolved-pid'),
    tStart: vi.fn(async () => ok('tStart')),
    tSimple: vi.fn(async () => ok('tSimple')),
    tStatus: vi.fn(async () => ok('tStatus')),
    tListShots: vi.fn(async () => ok('tListShots')),
    tRerender: vi.fn(async () => ok('tRerender')),
    tRenderSample: vi.fn(async () => ok('tRenderSample')),
    tMakeTrailer: vi.fn(async () => ok('tMakeTrailer')),
    director: { rebuildShotFirstFrames: vi.fn(), rerunCasting: vi.fn(async () => ok('casting')) },
    comfy: { healthCheck: vi.fn(async () => true), getObjectInfo: vi.fn(async () => ({})) },
    workflows: {
      list: vi.fn(async () => []),
      createWorkflow: vi.fn(async () => 'wf'),
      getMeta: vi.fn(async () => ({ placeholders: [], capability: '' })),
      getEditableParams: vi.fn(async () => []),
      updateParam: vi.fn(async () => undefined)
    },
    settings: { get: vi.fn(async () => ({ workflow: { default: 'd' } })) },
    projects: { get: vi.fn(async () => null) },
    queue: { quickRender: vi.fn(async () => ({ outputAbs: '/out.mp4', promptId: 'p' })) },
    tListMemories: vi.fn(async () => ok('memories')),
    tSaveMemory: vi.fn(async () => ok('saved')),
    tGetSettings: vi.fn(async () => ok('settings')),
    tSetSettings: vi.fn(async () => ok('set')),
    tListCharacters: vi.fn(async () => ok('chars')),
    tUpdateCharacter: vi.fn(async () => ok('updChar')),
    tUpdateShot: vi.fn(async () => ok('updShot')),
    tAddShot: vi.fn(async () => ok('addShot')),
    tDeleteShot: vi.fn(async () => ok('delShot')),
    tMoveShot: vi.fn(async () => ok('mvShot')),
    tListProjects: vi.fn(async () => ok('projects')),
    tOpenProject: vi.fn(async () => ok('open')),
    tSetProjectBgm: vi.fn(async () => ok('bgm')),
    tListProjectFiles: vi.fn(async () => ok('files')),
    tOpenFile: vi.fn(async () => ok('file')),
    tWebSearch: vi.fn(async () => ok('search')),
    tFetchUrl: vi.fn(async () => ok('fetch')),
    tCreateSkill: vi.fn(async () => ok('createSkill')),
    tListSkills: vi.fn(async () => ok('skills')),
    tUpdateSkill: vi.fn(async () => ok('updSkill')),
    runCustomSkill: vi.fn(async () => ok('custom')),
    tChooseWorkflow: vi.fn(async () => ok('choose')),
    ...overrides
  }
  return agent as unknown as ConversationService & Record<string, any>
}

describe('conversationToolDispatcher · executeToolImpl 未覆盖 switch case（路由）', () => {
  it('start_director → tStart(pid, args)，global 时 pid=undefined', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'global', 'start_director', '{"eps":3}')
    expect(r).toEqual(ok('tStart'))
    expect(agent.tStart).toHaveBeenCalledWith(undefined, { eps: 3 })
  })

  it('pause_director → tSimple(resolvePid, "pause")', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'p1', 'pause_director', '{}')
    expect(r).toEqual(ok('tSimple'))
    expect(agent.resolvePid).toHaveBeenCalledWith('p1')
    expect(agent.tSimple).toHaveBeenCalledWith('p1', 'pause')
  })

  it('resume_director → tSimple(resolvePid, "resume")', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'p1', 'resume_director', '{}')
    expect(r).toEqual(ok('tSimple'))
    expect(agent.tSimple).toHaveBeenCalledWith('p1', 'resume')
  })

  it('cancel_director → tSimple(resolvePid, "cancel")', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'p1', 'cancel_director', '{}')
    expect(r).toEqual(ok('tSimple'))
    expect(agent.tSimple).toHaveBeenCalledWith('p1', 'cancel')
  })

  it('get_director_status → tStatus(resolvePid)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'p1', 'get_director_status', '{}')
    expect(r).toEqual(ok('tStatus'))
    expect(agent.tStatus).toHaveBeenCalledWith('p1')
  })

  it('list_shots → tListShots(resolvePid)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'p1', 'list_shots', '{}')
    expect(r).toEqual(ok('tListShots'))
    expect(agent.tListShots).toHaveBeenCalledWith('p1')
  })

  it('rerender_shots → tRerender(resolvePid, args)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'p1', 'rerender_shots', '{"shot_indexes":[1]}')
    expect(r).toEqual(ok('tRerender'))
    expect(agent.tRerender).toHaveBeenCalledWith('p1', { shot_indexes: [1] })
  })

  it('rerun_casting → director.rerunCasting(resolvePid)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'p1', 'rerun_casting', '{}')
    expect(r).toEqual(ok('casting'))
    expect(agent.director.rerunCasting).toHaveBeenCalledWith('p1')
  })

  it('render_sample → tRenderSample(resolvePid, args)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'p1', 'render_sample', '{"n":1}')
    expect(r).toEqual(ok('tRenderSample'))
    expect(agent.tRenderSample).toHaveBeenCalledWith('p1', { n: 1 })
  })

  it('make_trailer → tMakeTrailer(resolvePid, args)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'p1', 'make_trailer', '{"style":"x"}')
    expect(r).toEqual(ok('tMakeTrailer'))
    expect(agent.tMakeTrailer).toHaveBeenCalledWith('p1', { style: 'x' })
  })

  it('choose_workflow → tChooseWorkflow(原始 pid，不走 resolvePid)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'p1', 'choose_workflow', '{"workflow_name":"w"}')
    expect(r).toEqual(ok('choose'))
    expect(agent.tChooseWorkflow).toHaveBeenCalledWith('p1', { workflow_name: 'w' })
    expect(agent.resolvePid).not.toHaveBeenCalled()
  })

  it('list_memories：带 kind → tListMemories(kind)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'p1', 'list_memories', '{"kind":"style"}')
    expect(r).toEqual(ok('memories'))
    expect(agent.tListMemories).toHaveBeenCalledWith('style')
  })

  it('list_memories：不带 kind → tListMemories(undefined)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'p1', 'list_memories', '{}')
    expect(r).toEqual(ok('memories'))
    expect(agent.tListMemories).toHaveBeenCalledWith(undefined)
  })

  it('save_memory → tSaveMemory(args)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'p1', 'save_memory', '{"kind":"fact","content":"c"}')
    expect(r).toEqual(ok('saved'))
    expect(agent.tSaveMemory).toHaveBeenCalledWith({ kind: 'fact', content: 'c' })
  })

  it('list_characters → tListCharacters(resolvePid)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'p1', 'list_characters', '{}')
    expect(r).toEqual(ok('chars'))
    expect(agent.tListCharacters).toHaveBeenCalledWith('p1')
  })

  it('update_character → tUpdateCharacter(resolvePid, args)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'p1', 'update_character', '{"name":"A"}')
    expect(r).toEqual(ok('updChar'))
    expect(agent.tUpdateCharacter).toHaveBeenCalledWith('p1', { name: 'A' })
  })

  it('update_shot → tUpdateShot(resolvePid, args)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'p1', 'update_shot', '{"index":1}')
    expect(r).toEqual(ok('updShot'))
    expect(agent.tUpdateShot).toHaveBeenCalledWith('p1', { index: 1 })
  })

  it('add_shot → tAddShot(resolvePid, args)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'p1', 'add_shot', '{"after":2}')
    expect(r).toEqual(ok('addShot'))
    expect(agent.tAddShot).toHaveBeenCalledWith('p1', { after: 2 })
  })

  it('delete_shot → tDeleteShot(resolvePid, args)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'p1', 'delete_shot', '{"index":3}')
    expect(r).toEqual(ok('delShot'))
    expect(agent.tDeleteShot).toHaveBeenCalledWith('p1', { index: 3 })
  })

  it('move_shot → tMoveShot(resolvePid, args)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'p1', 'move_shot', '{"from":1,"to":4}')
    expect(r).toEqual(ok('mvShot'))
    expect(agent.tMoveShot).toHaveBeenCalledWith('p1', { from: 1, to: 4 })
  })

  it('list_projects → tListProjects()', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'global', 'list_projects', '{}')
    expect(r).toEqual(ok('projects'))
    expect(agent.tListProjects).toHaveBeenCalled()
  })

  it('open_project → tOpenProject(args)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'global', 'open_project', '{"name":"proj"}')
    expect(r).toEqual(ok('open'))
    expect(agent.tOpenProject).toHaveBeenCalledWith({ name: 'proj' })
  })

  it('get_settings → tGetSettings()', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'global', 'get_settings', '{}')
    expect(r).toEqual(ok('settings'))
    expect(agent.tGetSettings).toHaveBeenCalled()
  })

  it('set_settings → tSetSettings(args)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'global', 'set_settings', '{"theme":"dark"}')
    expect(r).toEqual(ok('set'))
    expect(agent.tSetSettings).toHaveBeenCalledWith({ theme: 'dark' })
  })

  it('set_project_bgm → tSetProjectBgm(resolvePid, args)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'p1', 'set_project_bgm', '{"path":"a.mp3"}')
    expect(r).toEqual(ok('bgm'))
    expect(agent.tSetProjectBgm).toHaveBeenCalledWith('p1', { path: 'a.mp3' })
  })

  it('list_project_files → tListProjectFiles(resolvePid)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'p1', 'list_project_files', '{}')
    expect(r).toEqual(ok('files'))
    expect(agent.tListProjectFiles).toHaveBeenCalledWith('p1')
  })

  it('open_file → tOpenFile(args)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'p1', 'open_file', '{"path":"/x"}')
    expect(r).toEqual(ok('file'))
    expect(agent.tOpenFile).toHaveBeenCalledWith({ path: '/x' })
  })

  it('web_search → tWebSearch(args)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'global', 'web_search', '{"query":"q"}')
    expect(r).toEqual(ok('search'))
    expect(agent.tWebSearch).toHaveBeenCalledWith({ query: 'q' })
  })

  it('fetch_url → tFetchUrl(args)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'global', 'fetch_url', '{"url":"http://x"}')
    expect(r).toEqual(ok('fetch'))
    expect(agent.tFetchUrl).toHaveBeenCalledWith({ url: 'http://x' })
  })

  it('create_skill → tCreateSkill(args)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'global', 'create_skill', '{"name":"s"}')
    expect(r).toEqual(ok('createSkill'))
    expect(agent.tCreateSkill).toHaveBeenCalledWith({ name: 's' })
  })

  it('list_skills → tListSkills()', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'global', 'list_skills', '{}')
    expect(r).toEqual(ok('skills'))
    expect(agent.tListSkills).toHaveBeenCalled()
  })

  it('update_skill → tUpdateSkill(args)', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'global', 'update_skill', '{"id":"s1"}')
    expect(r).toEqual(ok('updSkill'))
    expect(agent.tUpdateSkill).toHaveBeenCalledWith({ id: 's1' })
  })

  it('global scope + resolvePid 返回默认值分支（pid undefined → resolved）', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'global', 'list_shots', '{}')
    expect(r).toEqual(ok('tListShots'))
    expect(agent.tListShots).toHaveBeenCalledWith('resolved-pid')
  })
})

describe('conversationToolDispatcher · executeToolImpl 未覆盖 case 内分支', () => {
  it('get_comfyui_status：healthCheck=false → online:false', async () => {
    const agent = mkAgent({ comfy: { healthCheck: vi.fn(async () => false), getObjectInfo: vi.fn() } })
    const r = await executeToolImpl(agent, 'p1', 'get_comfyui_status', '{}')
    expect(r.ok).toBe(true)
    expect(JSON.parse(r.text)).toEqual({ online: false })
  })

  it('list_workflows：global scope → 不调用 projects.get，projectDefault=null', async () => {
    const agent = mkAgent()
    const r = await executeToolImpl(agent, 'global', 'list_workflows', '{}')
    expect(r.ok).toBe(true)
    const parsed = JSON.parse(r.text)
    expect(parsed.projectDefault).toBeNull()
    expect(parsed.globalDefault).toBe('d')
    expect(agent.projects.get).not.toHaveBeenCalled()
  })

  it('list_workflows：projects.get 抛错 → catch 吞掉，projectDefault=null', async () => {
    const agent = mkAgent({ projects: { get: vi.fn(async () => { throw new Error('no proj') }) } })
    const r = await executeToolImpl(agent, 'p1', 'list_workflows', '{}')
    expect(r.ok).toBe(true)
    expect(JSON.parse(r.text).projectDefault).toBeNull()
  })

  it('import_library_workflow：目录尾斜杠路径 → baseName 兜底 library_workflow', async () => {
    const createWf = vi.fn(async () => 'final')
    const agent = mkAgent({
      workflowLibrary: {
        list: vi.fn(async () => []),
        convertToApi: vi.fn(() => ({ graph: { a: 1 }, nodeCount: 1, unknownNodeTypes: [] }))
      },
      workflows: {
        list: vi.fn(async () => []),
        createWorkflow: createWf,
        getMeta: vi.fn(async () => ({ placeholders: ['$PROMPT$'], capability: 't2v' })),
        getEditableParams: vi.fn(async () => []),
        updateParam: vi.fn()
      }
    })
    const r = await executeToolImpl(agent, 'p1', 'import_library_workflow', '{"path":"foo/"}')
    expect(r.ok).toBe(true)
    expect(createWf).toHaveBeenCalledWith('library_workflow', JSON.stringify({ a: 1 }))
    const parsed = JSON.parse(r.text)
    expect(parsed.imported).toBe('final')
    expect(parsed.nodeCount).toBe(1)
    expect(parsed.placeholders).toEqual(['$PROMPT$'])
    expect(parsed.capability).toBe('t2v')
  })

  it('render_quick：全参数透传映射到 quickRender 入参', async () => {
    const quickRender = vi.fn(async () => ({ outputAbs: '/o.mp4', promptId: 'pid-1' }))
    const agent = mkAgent({ queue: { quickRender } })
    const r = await executeToolImpl(agent, 'p1', 'render_quick', JSON.stringify({
      workflow_name: 'wf', prompt: 'p', ref_image: '/ref.png', end_image: '/end.png',
      seed: 42, duration_sec: 5, width: 1024, height: 512
    }))
    expect(r.ok).toBe(true)
    expect(quickRender).toHaveBeenCalledWith({
      workflowName: 'wf', prompt: 'p', refImageAbs: '/ref.png', endImageAbs: '/end.png',
      seed: 42, durationSec: 5, width: 1024, height: 512
    })
    const parsed = JSON.parse(r.text)
    expect(parsed.workflow).toBe('wf')
    expect(parsed.output).toBe('/o.mp4')
    expect(parsed.promptId).toBe('pid-1')
  })

  it('render_quick：可选参数类型不对 → 映射为 undefined', async () => {
    const quickRender = vi.fn(async () => ({ outputAbs: '/o.mp4', promptId: 'p' }))
    const agent = mkAgent({ queue: { quickRender } })
    const r = await executeToolImpl(agent, 'p1', 'render_quick',
      '{"workflow_name":"wf","prompt":"p","seed":"str","width":"w"}')
    expect(r.ok).toBe(true)
    expect(quickRender).toHaveBeenCalledWith({
      workflowName: 'wf', prompt: 'p', refImageAbs: undefined, endImageAbs: undefined,
      seed: undefined, durationSec: undefined, width: undefined, height: undefined
    })
  })

  it('get_workflow_params：存在 → 返回可编辑参数 JSON', async () => {
    const agent = mkAgent({
      workflows: {
        list: vi.fn(async () => []),
        createWorkflow: vi.fn(),
        getMeta: vi.fn(),
        getEditableParams: vi.fn(async () => [{ node_id: '3', key: 'text' }]),
        updateParam: vi.fn()
      }
    })
    const r = await executeToolImpl(agent, 'p1', 'get_workflow_params', '{"workflow_name":"w"}')
    expect(r.ok).toBe(true)
    expect(JSON.parse(r.text)).toEqual([{ node_id: '3', key: 'text' }])
  })

  it('get_workflow_params：超过 80 条参数 → slice(0,80) 截断', async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ node_id: String(i), key: 'k' }))
    const agent = mkAgent({
      workflows: {
        list: vi.fn(async () => []),
        createWorkflow: vi.fn(),
        getMeta: vi.fn(),
        getEditableParams: vi.fn(async () => many),
        updateParam: vi.fn()
      }
    })
    const r = await executeToolImpl(agent, 'p1', 'get_workflow_params', '{"workflow_name":"w"}')
    expect(r.ok).toBe(true)
    expect(JSON.parse(r.text)).toHaveLength(80)
  })

  it('update_workflow_param：工作流不存在 → ok=false', async () => {
    const agent = mkAgent({ workflowExists: vi.fn(async () => false) })
    const r = await executeToolImpl(agent, 'p1', 'update_workflow_param',
      '{"workflow_name":"nope","node_id":"n","key":"k","value":1}')
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/工作流不存在/)
  })

  it('update_workflow_param：数字/布尔 value 合法', async () => {
    const updateParam = vi.fn(async () => undefined)
    const agent = mkAgent({
      workflows: {
        list: vi.fn(async () => []), createWorkflow: vi.fn(), getMeta: vi.fn(),
        getEditableParams: vi.fn(async () => []), updateParam
      }
    })
    const r1 = await executeToolImpl(agent, 'p1', 'update_workflow_param',
      '{"workflow_name":"w","node_id":"n","key":"k","value":7}')
    expect(r1.ok).toBe(true)
    expect(updateParam).toHaveBeenLastCalledWith('w', 'n', 'k', 7)
    const r2 = await executeToolImpl(agent, 'p1', 'update_workflow_param',
      '{"workflow_name":"w","node_id":"n","key":"k","value":true}')
    expect(r2.ok).toBe(true)
    expect(updateParam).toHaveBeenLastCalledWith('w', 'n', 'k', true)
    expect(r2.text).toBe('已更新 w 节点 n 的 k')
  })

  it('外层 catch：非 Error 抛出 → String(e) 分支', async () => {
    const agent = mkAgent({ tListProjects: vi.fn(async () => { throw 'plain-string-err' }) })
    const r = await executeToolImpl(agent, 'global', 'list_projects', '{}')
    expect(r.ok).toBe(false)
    expect(r.text).toBe('执行失败：plain-string-err')
  })
})
