import { describe, it, expect, vi } from 'vitest'
import { lockPromptsAndWorkflow } from '../../src/main/core/directorStageAssets'

/**
 * 出视频前提示词/工作流锁定单测（directorStageAssets 首个 spec）：
 * 串戏英文名与肢体接触句压成单人动作、按项目/全局默认选择工作流、无变化不告警。
 */
function makeRt(project: Record<string, any>, settings: Record<string, any> = {}) {
  const rt: any = {
    store: {
      get: vi.fn(async () => project),
      save: vi.fn(async () => undefined),
    },
    settings: { get: vi.fn(async () => settings) },
    log: vi.fn(),
    states: new Map(),
    gates: new Map(),
    healBudget: new Map(),
    visionWarned: new Set(),
  }
  return rt
}

function makeProject(over: Record<string, any> = {}) {
  return {
    id: 'p1',
    characters: [{ id: 'c1', name: '林夏', appearanceLock: 'long black hair' }],
    defaultWorkflow: undefined,
    shots: [
      {
        id: 's1',
        index: 1,
        characterIds: ['c1'],
        action: 'steps forward',
        promptEn: 'Su Wan and Lin Chuan embrace by the window',
        workflow: '',
        frames: 81,
        dialogue: '',
      },
      {
        id: 's2',
        index: 2,
        characterIds: [],
        action: '',
        dialogue: '走吧',
        promptEn: 'wide shot of rooftop',
        workflow: 'pinned_wf',
        frames: 81,
      },
    ],
    ...over,
  }
}

describe('lockPromptsAndWorkflow', () => {
  it('串戏描述被压成单人动作句，缺工作流的镜头按规则补齐', async () => {
    const project = makeProject()
    const rt = makeRt(project, { workflow: { default: 'minimax_h3_i2v' } })

    await lockPromptsAndWorkflow(rt, 'p1')

    const s1 = project.shots[0]
    if (!s1) throw new Error('测试夹具缺少 shots[0]')
    expect(s1.promptEn).not.toContain('Lin Chuan')
    expect(s1.promptEn).toContain('the same person from the reference image')
    expect(s1.workflow).toBe('minimax_h3_i2v')
    // 已指定工作流的镜头不覆盖
    expect(project.shots[1]?.workflow).toBe('pinned_wf')
    expect(rt.store.save).toHaveBeenCalledTimes(1)
    expect(rt.log).toHaveBeenCalledWith('p1', 'render', 'warn', expect.stringContaining('出视频前核对'))
  })

  it('项目默认工作流优先于全局默认；有台词走口型工作流', async () => {
    const project = makeProject({
      defaultWorkflow: 'project_wf',
      shots: [
        { id: 's1', index: 1, characterIds: [], action: '', dialogue: '', promptEn: 'a quiet room', workflow: '' },
        {
          id: 's2',
          index: 2,
          characterIds: [],
          action: '',
          dialogue: '你好',
          promptEn: 'two people talking',
          workflow: '',
        },
      ],
    })
    const rt = makeRt(project, { workflow: { default: 'global_wf' } })

    await lockPromptsAndWorkflow(rt, 'p1')

    expect(project.shots[0]?.workflow).toBe('project_wf')
    expect(project.shots[1]?.workflow).toBe('minimax_h3_r2v')
  })

  it('无任何改动时不写告警日志，但仍落盘', async () => {
    const project = makeProject({
      shots: [
        {
          id: 's1',
          index: 1,
          characterIds: [],
          action: '',
          dialogue: '',
          promptEn: 'wide shot of rooftop',
          workflow: 'minimax_h3_i2v',
          frames: 81,
        },
      ],
    })
    const rt = makeRt(project, { workflow: { default: 'minimax_h3_i2v' } })

    await lockPromptsAndWorkflow(rt, 'p1')

    expect(rt.log).not.toHaveBeenCalled()
    expect(rt.store.save).toHaveBeenCalledTimes(1)
  })
})
