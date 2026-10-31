import { describe, it, expect } from 'vitest'
import { tStart } from '../../src/main/core/conversationToolsDirector'

/**
 * 回归：项目对话里调 start_director 必须复用当前 pid，不能再新建项目。
 * 之前 director.start() 硬编码 store.create()，导致项目对话里开拍会另建一个
 * 空项目，而 resolvePid(pid) 又把上下文打回原项目，导演陷入"切项目→查不到→再切"死循环。
 */
describe('tStart 复用当前项目 pid（回归：导演开拍死循环修复）', () => {
  function makeHost(opts: { existingProjectId?: string; alreadyRunning?: boolean }) {
    const calls: Array<Record<string, unknown>> = []
    const host: any = {
      director: {
        getState: (pid: string) => {
          if (opts.alreadyRunning && pid === opts.existingProjectId) {
            return { running: true, title: '在跑的剧' }
          }
          return undefined
        },
        start: async (input: Record<string, unknown>) => {
          calls.push(input)
          // 模拟 director.start 行为：有 existingProjectId 就用它，否则生成新 id
          return (input.existingProjectId as string) || 'p_new_auto_created'
        },
      },
      lastProjectId: undefined as string | undefined,
    }
    return { host, calls }
  }

  it('在项目对话里开拍（pid 存在）应把 pid 作为 existingProjectId 传入，不另建项目', async () => {
    const { host, calls } = makeHost({ existingProjectId: 'p_current' })
    const r = await tStart(host, 'p_current', {
      title: '雨夜对峙',
      genre: '都市情感',
      script: '雨夜天台。',
    })
    expect(r.ok).toBe(true)
    // 关键：传给 director.start 的 input 必须带 existingProjectId=p_current
    expect(calls[0]?.existingProjectId).toBe('p_current')
    // 返回的 projectId 必须等于当前 pid，不能是自动新建的
    expect(r.text).toContain('"projectId":"p_current"')
    // host.lastProjectId 必须落到当前 pid
    expect(host.lastProjectId).toBe('p_current')
  })

  it('全局对话里开拍（pid 为空）不传 existingProjectId，仍走自动新建', async () => {
    const { host, calls } = makeHost({})
    const r = await tStart(host, undefined, {
      title: '新剧',
      genre: '悬疑',
      script: '...',
    })
    expect(r.ok).toBe(true)
    expect(calls[0]?.existingProjectId).toBeUndefined()
    expect(r.text).toContain('"projectId":"p_new_auto_created"')
  })

  it('当前项目已有任务在跑时拒绝二次开拍', async () => {
    const { host } = makeHost({ existingProjectId: 'p_busy', alreadyRunning: true })
    const r = await tStart(host, 'p_busy', {
      title: '新剧',
      genre: '悬疑',
      script: '...',
    })
    expect(r.ok).toBe(false)
    expect(r.text).toContain('已有任务在执行')
  })

  it('缺 title/genre/script 时拒绝', async () => {
    const { host } = makeHost({ existingProjectId: 'p_x' })
    const r = await tStart(host, 'p_x', { title: '', genre: '', script: '' })
    expect(r.ok).toBe(false)
  })
})
