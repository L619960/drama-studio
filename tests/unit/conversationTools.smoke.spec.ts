/**
 * conversationTools barrel 烟雾测试：只触发 re-export 行覆盖（整个 barrel 之前 0%）。
 * 函数体不在此测试中调用——各子模块的函数级测试应放在各自的 spec 文件里。
 */
import { describe, it, expect, vi } from 'vitest'

// electron shell 在 node 环境不可用，mock 掉它让 conversationToolsFile 能 import
vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() }
}))

describe('conversationTools · barrel re-export 烟雾测试（2026-10-30 触发模块覆盖）', () => {
  it('barrel 可被 import 且导出所有预期符号', async () => {
    // 动态 import，确保 vi.mock 已就绪
    const ct = await import('../../src/main/core/conversationTools')

    // 接口/类型导出（运行时不可见，但 ConversationToolsHost 里有 lastProjectId 默认值检查的话会触发）
    expect(typeof ct).toBe('object')

    // 子模块的主要导出函数（只需验证存在，不调用——避免 host 依赖）
    const expectedFns = [
      'runCustomSkill', 'resolvePid',
      'tListMemories', 'tSaveMemory', 'tGetSettings', 'tSetSettings',
      'tCreateSkill', 'tListSkills', 'tUpdateSkill',
      'tStart', 'tSimple', 'tStatus', 'tListShots', 'tRerender',
      'tRenderSample', 'tMakeTrailer', 'tRebuildFrames',
      'tListProjects', 'tOpenProject',
      'tListCharacters', 'tUpdateCharacter',
      'renumberShots', 'validateFrames', 'recalcProjectStatus',
      'tUpdateShot', 'tAddShot', 'tDeleteShot', 'tMoveShot',
      'workflowExists', 'tChooseWorkflow', 'tGetComfyuiStatus',
      'tListWorkflows', 'tImportLibraryWorkflow', 'tRenderQuick',
      'tGetWorkflowParams', 'tUpdateWorkflowParam', 'tCreateWorkflow',
      'tWebSearch', 'tFetchUrl', 'isBlockedFetchHost',
      'tSetProjectBgm', 'tListProjectFiles', 'tOpenFile'
    ]
    for (const fn of expectedFns) {
      expect(typeof (ct as Record<string, unknown>)[fn]).toBe('function')
    }
  })

  it('子模块可独立 import（烟雾测试，确认模块图健康）', async () => {
    // 独立 import 每个子模块，确认它们的顶层代码能在 node 环境执行
    const m = await import('../../src/main/core/conversationConstants')
    expect(m.RESULT_LIMIT).toBe(24000)
    expect(typeof m.mid).toBe('function')
  })
})
