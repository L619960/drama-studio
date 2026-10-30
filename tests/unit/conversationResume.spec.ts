/**
 * P0-2：导演对话「继续 / resume_director」的 fallback 行为。
 *
 * 真实 ConversationService 构造依赖较重，这里用 `prototype.tSimple.call(fakeThis)` 直测方法体：
 * tSimple 只触达 this.director / this.projects，mock 这两个即可，不碰 Electron / ComfyUI / 网络。
 */
import { describe, it, expect, vi } from 'vitest'

// 屏蔽 conversationService import 链上的 electron / MCP SDK
vi.mock('electron', () => ({ shell: { showItemInFolder: vi.fn() } }))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioTransport: vi.fn(),
  StdioClientTransport: vi.fn(),
  getDefaultEnvironment: vi.fn()
}))

import { ConversationService } from '../../src/main/core/conversationService'
import { STAGE_ORDER } from '../../src/main/core/directorConstants'
import type { DirectorState, DirectorStage, StageState } from '../../src/shared/ipcTypes'

function makeState(patch: Partial<DirectorState> = {}): DirectorState {
  const stages = {} as Record<DirectorStage, StageState>
  for (const s of STAGE_ORDER) stages[s] = { status: 'pending', message: '', percent: 0 }
  return {
    projectId: 'p1',
    title: '测试片',
    running: false,
    cancelled: false,
    paused: false,
    gateStages: [],
    stages,
    totalShots: 0,
    doneShots: 0,
    failedShotIds: [],
    startedAt: Date.now(),
    logs: [],
    ...patch
  }
}

function mkHost(state: DirectorState | null) {
  return {
    director: {
      getState: vi.fn(() => state),
      resume: vi.fn(async () => undefined),
      resumeFromStage: vi.fn(async () => undefined)
    },
    projects: { get: vi.fn(async () => ({ id: 'p1', title: '测试片' })) }
  } as unknown as ConversationService
}

/** 调用真实 tSimple 方法体 */
function callSimple(host: ConversationService, action: 'pause' | 'resume' | 'cancel') {
  return ConversationService.prototype.tSimple.call(host, 'p1', action)
}

describe('tSimple · resume（P0-2 中断态 fallback）', () => {
  it('停在确认点（paused=true）→ 走原有 resume，不断点续跑', async () => {
    const host = mkHost(makeState({ running: true, paused: true }))
    const r = await callSimple(host, 'resume')
    expect(r.ok).toBe(true)
    expect(host.director.resume).toHaveBeenCalledWith('p1')
    expect(host.director.resumeFromStage).not.toHaveBeenCalled()
  })

  it('应用重启中断态（interrupted）→ 自动从中断阶段断点续跑，不再回「无需继续」', async () => {
    const st = makeState({ interrupted: true, interruptedStage: 'render' })
    st.stages.render = { status: 'error', message: '应用重启导致该阶段中断', percent: 40 }
    const host = mkHost(st)
    const r = await callSimple(host, 'resume')
    expect(r.ok).toBe(true)
    expect(host.director.resumeFromStage).toHaveBeenCalledWith('p1', 'render')
  })

  it('阶段失败无中断标记 → 取流水线顺序第一个未完成阶段（渲染出错 → render）', async () => {
    const st = makeState()
    st.stages.analyze = { status: 'done', message: '', percent: 100 }
    st.stages.casting = { status: 'done', message: '', percent: 100 }
    st.stages.scenes = { status: 'done', message: '', percent: 100 }
    st.stages.render = { status: 'error', message: 'ComfyUI 不可达', percent: 0 }
    const host = mkHost(st)
    const r = await callSimple(host, 'resume')
    expect(r.ok).toBe(true)
    expect(host.director.resumeFromStage).toHaveBeenCalledWith('p1', 'render')
  })

  it('已跳过阶段不参与兜底定位（skipped 视为已完成）', async () => {
    const st = makeState()
    st.stages.analyze = { status: 'done', message: '', percent: 100 }
    st.stages.casting = { status: 'skipped', message: '', percent: 0 }
    st.stages.scenes = { status: 'error', message: '', percent: 0 }
    const host = mkHost(st)
    const r = await callSimple(host, 'resume')
    expect(host.director.resumeFromStage).toHaveBeenCalledWith('p1', 'scenes')
  })

  it('全部阶段完成 → 明确告知无需继续', async () => {
    const st = makeState()
    for (const s of STAGE_ORDER) st.stages[s] = { status: 'done', message: '', percent: 100 }
    const host = mkHost(st)
    const r = await callSimple(host, 'resume')
    expect(r.ok).toBe(false)
    expect(r.text).toContain('所有阶段均已完成')
    expect(host.director.resumeFromStage).not.toHaveBeenCalled()
  })

  it('运行中 → 提示无需继续，不触发续跑', async () => {
    const host = mkHost(makeState({ running: true }))
    const r = await callSimple(host, 'resume')
    expect(r.ok).toBe(false)
    expect(r.text).toContain('正在运行')
    expect(host.director.resumeFromStage).not.toHaveBeenCalled()
  })

  it('已取消 → 提示需指明阶段，不擅自重启', async () => {
    const host = mkHost(makeState({ cancelled: true }))
    const r = await callSimple(host, 'resume')
    expect(r.ok).toBe(false)
    expect(r.text).toContain('已被取消')
    expect(host.director.resumeFromStage).not.toHaveBeenCalled()
  })

  it('断点续跑前置校验失败 → 透传失败原因（如缺拼接产物）', async () => {
    const st = makeState()
    st.stages.analyze = { status: 'done', message: '', percent: 100 }
    st.stages.casting = { status: 'done', message: '', percent: 100 }
    st.stages.scenes = { status: 'done', message: '', percent: 100 }
    st.stages.render = { status: 'done', message: '', percent: 100 }
    st.stages.combine = { status: 'error', message: '', percent: 0 }
    const host = mkHost(st)
    host.director.resumeFromStage = vi.fn(async () => {
      throw new Error('没有已渲染完成的镜头分段，无法拼接（请先从「逐镜渲染」重跑）')
    })
    const r = await callSimple(host, 'resume')
    expect(r.ok).toBe(false)
    expect(r.text).toContain('无法继续')
    expect(r.text).toContain('无法拼接')
  })
})
