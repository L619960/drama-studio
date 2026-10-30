/**
 * conversationTools 子模块的 host mock + 分支烟雾测试。
 * conversationTools 系列（Tools/Director/Memory/Network/Project/Workflow/File）
 * 覆盖从 0% 拉起来，触发它们的 if/else 分支。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { workflowExists, tChooseWorkflow } from '../../src/main/core/conversationToolsWorkflow'
import { isBlockedFetchHost } from '../../src/main/core/conversationToolsNetwork'

// ------ Mock host ------
const mkHost = () => ({
  workflows: {
    list: vi.fn(async () => [
      { name: 'h3-r2v' },
      { name: 'wan22_remix_flf2v' }
    ]),
    chooseForShot: vi.fn(async () => ({ ok: true, text: 'ok' })),
    chooseForProject: vi.fn(async () => ({ ok: true, text: 'ok' }))
  },
  settings: {
    get: vi.fn(async () => ({ llm: { apiKey: '', baseUrl: '' }, workflow: { default: 'old' } })),
    save: vi.fn(async () => ({ ok: true })),
    set: vi.fn(async () => ({ ok: true }))
  },
  projects: {
    get: vi.fn(async () => ({
      defaultWorkflow: 'old',
      shots: [
        { index: 1, workflow: 'wf1' },
        { index: 3, workflow: 'wf3' }
      ]
    })),
    save: vi.fn(async () => ({ ok: true }))
  }
}) as any

describe('conversationToolsWorkflow · 工作流域（host mock 触发分支）', () => {
  beforeEach(() => { vi.clearAllMocks() })

  describe('workflowExists', () => {
    it('存在 → true', async () => {
      const h = mkHost()
      expect(await workflowExists(h, 'h3-r2v')).toBe(true)
    })
    it('不存在 → false', async () => {
      const h = mkHost()
      expect(await workflowExists(h, 'no-such-wf')).toBe(false)
    })
  })

  describe('tChooseWorkflow', () => {
    it('缺 workflow_name → 拒绝', async () => {
      const h = mkHost()
      const r = await tChooseWorkflow(h, 'pid', {})
      expect(r.ok).toBe(false)
      expect(r.text).toContain('缺少')
    })

    it('工作流不存在 → 拒绝', async () => {
      const h = mkHost()
      const r = await tChooseWorkflow(h, 'pid', { workflow_name: 'ghost' })
      expect(r.ok).toBe(false)
      expect(r.text).toContain('不存在')
    })

    it('scope = shot + shot_index → 成功', async () => {
      const h = mkHost()
      const r = await tChooseWorkflow(h, 'pid', {
        workflow_name: 'h3-r2v',
        scope: 'shot',
        shot_index: 3
      })
      expect(r.ok).toBe(true)
      expect(h.projects.get).toHaveBeenCalledWith('pid')
      expect(h.projects.save).toHaveBeenCalled()
    })

    it('scope = project + pid → 成功', async () => {
      const h = mkHost()
      const r = await tChooseWorkflow(h, 'pid-1', {
        workflow_name: 'h3-r2v',
        scope: 'project'
      })
      expect(r.ok).toBe(true)
      expect(h.projects.get).toHaveBeenCalledWith('pid-1')
      expect(h.projects.save).toHaveBeenCalled()
    })

    it('scope = project + 无 pid → 拒绝', async () => {
      const h = mkHost()
      const r = await tChooseWorkflow(h, undefined, {
        workflow_name: 'h3-r2v',
        scope: 'project'
      })
      expect(r.ok).toBe(false)
    })

    it('scope = global → 改默认工作流', async () => {
      const h = mkHost()
      const r = await tChooseWorkflow(h, 'pid', {
        workflow_name: 'h3-r2v',
        scope: 'global'
      })
      expect(r.ok).toBe(true)
      expect(h.settings.get).toHaveBeenCalled()
      expect(h.settings.save).toHaveBeenCalled()
    })

    it('默认 scope（无 scope 参数）→ project 分支', async () => {
      const h = mkHost()
      const r = await tChooseWorkflow(h, 'pid', { workflow_name: 'h3-r2v' })
      expect(r.ok).toBe(true)
      expect(h.projects.get).toHaveBeenCalledWith('pid')
    })
  })
})

describe('conversationToolsNetwork · 网络域（isBlockedFetchHost + tWebSearch/tFetchUrl）', () => {
  describe('isBlockedFetchHost', () => {
    it('localhost → blocked', () => { expect(isBlockedFetchHost('localhost')).toBe(true) })
    it('127.0.0.1 → blocked', () => { expect(isBlockedFetchHost('127.0.0.1')).toBe(true) })
    it('169.254.169.254 → blocked（云元数据）', () => { expect(isBlockedFetchHost('169.254.169.254')).toBe(true) })
    it('0.0.0.0 → blocked', () => { expect(isBlockedFetchHost('0.0.0.0')).toBe(true) })
    it('example.com → not blocked', () => { expect(isBlockedFetchHost('example.com')).toBe(false) })
    it('www.baidu.com → not blocked', () => { expect(isBlockedFetchHost('www.baidu.com')).toBe(false) })
    it('空串 → not blocked', () => { expect(isBlockedFetchHost('')).toBe(false) })
  })
})
