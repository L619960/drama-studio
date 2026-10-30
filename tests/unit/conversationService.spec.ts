import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ConversationService } from '../../src/main/core/conversationService'

/**
 * 对话服务（ConversationService）单测：
 * 并发发送串行化、取消句柄、回退截断、每周自动学习去重、系统提示词上下文组装。
 * 仅覆盖类自身的编排逻辑，工具分片与 agent loop 已有各自 spec。
 */
const tmpDirs: string[] = []
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-conv-'))
  tmpDirs.push(dir)
  return dir
}

function makeService(opts: Record<string, any> = {}): ConversationService {
  return new ConversationService(
    opts.baseDir || '/tmp/nowhere',
    {} as any,
    {} as any,
    opts.director || ({ getState: vi.fn(() => null) } as any),
    {} as any,
    opts.projects || ({ get: vi.fn(async () => ({ title: '测试剧' })) } as any),
    {} as any,
    {} as any,
    opts.memory || ({ summary: vi.fn(async () => '') } as any),
    {} as any,
    opts.settings || ({ get: vi.fn(async () => ({ general: { autoLearn: false } })) } as any),
    opts.skillLibrary
  )
}

describe('send 串行化与取消', () => {
  it('同一 scope 的两次发送按顺序串行执行', async () => {
    const svc = makeService()
    const order: string[] = []
    let release: () => void = () => undefined
    svc.doSend = vi.fn(async (_scope: string, text: string) => {
      order.push(`start:${text}`)
      if (text === 'a') await new Promise<void>(r => { release = r })
      order.push(`end:${text}`)
      return []
    })

    const p1 = svc.send('s1', 'a')
    const p2 = svc.send('s1', 'b')
    await Promise.resolve()
    expect(order).toEqual(['start:a'])

    release()
    await p1
    await p2
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b'])
  })

  it('不同 scope 相互独立并行', async () => {
    const svc = makeService()
    let release: () => void = () => undefined
    const gate = new Promise<void>(r => { release = r })
    svc.doSend = vi.fn(async () => { await gate; return [] })

    const p1 = svc.send('a', 'x')
    const p2 = svc.send('b', 'y')
    await Promise.resolve()
    await Promise.resolve()
    expect(svc.doSend).toHaveBeenCalledTimes(2)
    release()
    await Promise.all([p1, p2])
  })

  it('isSending 反映在册发送；stop 中止全部控制器', async () => {
    const svc = makeService()
    const aborted: AbortController[] = []
    svc.doSend = vi.fn(async (scope: string, _text: string, controller: AbortController) => {
      aborted.push(controller)
      await new Promise<void>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
      return []
    })

    const p = svc.send('s1', 'hello')
    expect(svc.isSending('s1')).toBe(true)
    expect(svc.isSending('s2')).toBe(false)
    // 等 doSend 真正启动并注册 abort 监听（排队链是微任务）
    await Promise.resolve()
    await Promise.resolve()

    expect(await svc.stop('s1')).toBe(true)
    await expect(p).rejects.toThrow('aborted')
    expect(aborted).toHaveLength(1)
    expect(aborted[0].signal.aborted).toBe(true)

    // 无在册发送时 stop 返回 false
    svc.aborts.delete('s1')
    expect(await svc.stop('s1')).toBe(false)
  })
})

describe('rollback', () => {
  it('截断到指定消息之前并落盘', async () => {
    const svc = makeService()
    const history = [
      { id: 'm1', role: 'user', text: 'a' },
      { id: 'm2', role: 'assistant', text: 'b' },
      { id: 'm3', role: 'user', text: 'c' }
    ] as any[]
    svc.stop = vi.fn(async () => true)
    svc.list = vi.fn(async () => history)
    svc.save = vi.fn(async () => undefined)

    const kept = await svc.rollback('s1', 'm2')

    expect(kept).toEqual([{ id: 'm1', role: 'user', text: 'a' }])
    expect(svc.save).toHaveBeenCalledWith('s1', kept)
  })

  it('消息不存在时原样返回且不写盘', async () => {
    const svc = makeService()
    const history = [{ id: 'm1' }] as any[]
    svc.stop = vi.fn(async () => true)
    svc.list = vi.fn(async () => history)
    svc.save = vi.fn(async () => undefined)

    const kept = await svc.rollback('s1', 'missing')

    expect(kept).toBe(history)
    expect(svc.save).not.toHaveBeenCalled()
  })
})

describe('ensureDailyAutoLearn', () => {
  it('自动学习关闭时直接返回 false', async () => {
    const baseDir = await makeTmpDir()
    const svc = makeService({ baseDir })
    expect(await svc.ensureDailyAutoLearn()).toBe(false)
  })

  it('开启后首次触发并写入本周标记，同周再次调用跳过', async () => {
    const baseDir = await makeTmpDir()
    const svc = makeService({
      baseDir,
      settings: { get: vi.fn(async () => ({ general: { autoLearn: true } })) }
    })
    const send = vi.fn(async () => [])
    svc.send = send as any

    expect(await svc.ensureDailyAutoLearn()).toBe(true)
    expect(send).toHaveBeenCalledWith('global', expect.any(String))
    const state = JSON.parse(await fs.readFile(path.join(baseDir, 'learnState.json'), 'utf8'))
    expect(state.lastLearnWeek).toMatch(/^\d{4}-W\d{2}$/)

    expect(await svc.ensureDailyAutoLearn()).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('buildSystemPrompt', () => {
  it('全局对话：声明无项目并注入长期记忆与方法论规则', async () => {
    const svc = makeService({
      memory: { summary: vi.fn(async () => '用户偏好悬疑短剧') },
      skillLibrary: { load: vi.fn(async () => ({ methodRules: ['短镜化', '身份铁律'] })) }
    })

    const prompt = await svc.buildSystemPrompt('global')

    expect(prompt).toContain('【当前为全局对话】')
    expect(prompt).toContain('【导演方法论')
    expect(prompt).toContain('1. 短镜化')
    expect(prompt).toContain('2. 身份铁律')
    expect(prompt).toContain('【导演长期记忆')
    expect(prompt).toContain('用户偏好悬疑短剧')
  })

  it('项目对话：注入项目快照与流水线实时状态', async () => {
    const svc = makeService({
      projects: {
        get: vi.fn(async () => ({
          title: '伞', genre: '悬疑',
          characters: [{ name: '林夏' }], shots: [{}, {}]
        }))
      },
      director: {
        getState: vi.fn(() => ({
          running: true, paused: false, doneShots: 1, totalShots: 2,
          failedShotIds: ['s2'], gateStages: ['render'], finalPath: ''
        }))
      },
      memory: { summary: vi.fn(async () => '') }
    })

    const prompt = await svc.buildSystemPrompt('p1')

    expect(prompt).toContain('【当前项目快照】')
    expect(prompt).toContain('片名：伞；题材：悬疑；角色：林夏')
    expect(prompt).toContain('分镜数：2')
    expect(prompt).toContain('【流水线实时状态】')
    expect(prompt).toContain('镜头 1/2；失败：1')
    expect(prompt).toContain('阶段确认点：render')
    expect(prompt).toContain('成片：未产出')
    expect(prompt).not.toContain('【导演长期记忆')
  })

  it('项目不存在时提示尚未建档', async () => {
    const svc = makeService({
      projects: { get: vi.fn(async () => { throw new Error('not found') }) },
      memory: { summary: vi.fn(async () => '') }
    })

    const prompt = await svc.buildSystemPrompt('p1')

    expect(prompt).toContain('【当前项目快照】项目尚未建档。')
  })
})
