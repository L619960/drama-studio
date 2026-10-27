import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { ChildProcessManager } from '../../src/main/core/childProcessManager'

describe('ChildProcessManager', () => {
  let mgr: ChildProcessManager
  let logDir: string

  beforeEach(async () => {
    mgr = new ChildProcessManager()
    logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpm-test-'))
    mgr.setLogDir(logDir)
  })

  afterEach(async () => {
    await fs.rm(logDir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('execFile 成功时返回 stdout/stderr', async () => {
    const sh = process.platform === 'win32'
    const bin = sh ? process.execPath : process.execPath
    const { stdout } = await mgr.execFile(bin, ['-e', 'process.stdout.write("hello")'], { timeout: 10000 })
    expect(stdout).toContain('hello')
  })

  it('execFile 非零退出时 reject 并携带 stdout/stderr', async () => {
    const bin = process.execPath
    const err = await mgr.execFile(bin, ['-e', 'process.stderr.write("boom"); process.exit(2)'], { timeout: 10000 })
      .then(() => null, (e: Error & { stderr?: string; code?: number }) => e)
    expect(err).not.toBeNull()
    expect(err!.code).toBe(2)
    expect(err!.stderr).toContain('boom')
  })

  it('超时自动 kill 子进程', async () => {
    const bin = process.execPath
    const start = Date.now()
    const err = await mgr.execFile(bin, ['-e', 'setTimeout(()=>{}, 60000)'], { timeout: 1500 })
      .then(() => null, (e: Error) => e)
    expect(err).not.toBeNull()
    expect(Date.now() - start).toBeLessThan(5000)
  })

  it('getActiveHandles 返回登记项，退出后移除', async () => {
    const bin = process.execPath
    expect(mgr.getActiveHandles().length).toBe(0)
    await mgr.execFile(bin, ['-e', 'process.exit(0)'], { timeout: 5000 })
    expect(mgr.getActiveHandles().length).toBe(0)
  })

  it('killAll 批量 kill 活跃子进程', async () => {
    const bin = process.execPath
    const proc = mgr.spawn(bin, ['-e', 'setTimeout(()=>{}, 60000)'], { timeout: 60000, label: 'test-long' })
    // 等进程登记
    await new Promise(r => setTimeout(r, 200))
    const active = mgr.getActiveHandles()
    expect(active.length).toBeGreaterThanOrEqual(1)
    const killed = mgr.killAll('test')
    expect(killed).toBeGreaterThanOrEqual(1)
    await new Promise(r => proc.once('close', r))
    expect(mgr.getActiveHandles().length).toBe(0)
  })
})
