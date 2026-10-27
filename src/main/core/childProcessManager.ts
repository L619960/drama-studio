/**
 * 子进程统一管理器：集中登记 / 超时 kill / 退出前诊断 / 日志落盘。
 *
 * 背景：ffmpeg / TTS / faceDetector / ComfyUI 各自 spawn 子进程，
 * 超时与 kill 逻辑分散，崩溃后孤儿进程无法追溯。本模块提供：
 * - spawn(bin, args, options)：自动登记到 Map、按 options.timeout 自动 kill、stdout/stderr 落盘
 * - execFile(bin, args, options)：Promise 化封装，行为对齐 node:child_process.execFile
 * - killAll(reason)：退出前批量 kill（用于 before-quit 兜底）
 * - getActiveHandles()：诊断用，列出当前活跃子进程
 *
 * ComfyUI 自身的 spawn（detached + taskkill /T /F）保留原样——它有独立的生命周期管理，
 * 不纳入本管理器（避免误 kill 正在跑渲染的 ComfyUI 主进程）。
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createLogger } from './logger'

const log = createLogger('ChildProc')

export interface ChildHandle {
  pid: number
  bin: string
  args: string[]
  startTime: number
  timeoutMs?: number
  logFile?: string
  reason?: string
}

export interface SpawnOptions {
  /** 毫秒；超时后自动 child.kill()（Windows 默认 SIGTERM，任务管理器可见） */
  timeout?: number
  /** 传给 node child_process.spawn 的其他选项 */
  cwd?: string
  env?: NodeJS.ProcessEnv
  windowsHide?: boolean
  detached?: boolean
  /** 标签：写日志/诊断时区分用途（如 'ffmpeg-concat' / 'tts-sapi'） */
  label?: string
}

export interface ExecFileResult {
  stdout: string
  stderr: string
}

interface RegisteredChild extends ChildHandle {
  proc: ChildProcess
  timer: NodeJS.Timeout | null
  logFd?: fs.FileHandle
}

function defaultLogDir(): string {
  const base = process.env.APPDATA || process.env.TMP || ''
  return path.join(base, 'drama-studio', 'logs')
}

export class ChildProcessManager {
  private children = new Map<number, RegisteredChild>()
  private logDir: string = defaultLogDir()

  /** 测试/注入用：覆盖日志目录 */
  setLogDir(dir: string): void {
    this.logDir = dir
  }

  /**
   * spawn 一个子进程并登记。返回的 ChildProcess 与 node 原生一致，
   * 额外保证：
   * - options.timeout 到期自动 kill
   * - stdout/stderr 追加写到 child-process-{pid}.log
   * - 进程退出时自动从登记 Map 移除
   */
  spawn(bin: string, args: string[], options: SpawnOptions = {}): ChildProcess {
    const proc = nodeSpawn(bin, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: options.windowsHide ?? true,
      detached: options.detached,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const pid = proc.pid ?? -1
    const handle: RegisteredChild = {
      pid,
      bin,
      args,
      startTime: Date.now(),
      timeoutMs: options.timeout,
      proc,
      timer: null,
      reason: options.label
    }

    // 日志落盘（best-effort：打不开不影响子进程运行）
    if (pid > 0) {
      void this.openLogFile(handle).catch(() => undefined)
    }

    // 超时自动 kill
    if (options.timeout && pid > 0) {
      handle.timer = setTimeout(() => {
        log.warn(`子进程超时（${options.timeout}ms）自动 kill: pid=${pid} ${bin}`)
        try { proc.kill() } catch { /* 进程可能已退出 */ }
      }, options.timeout)
      // unref 避免定时器阻止进程退出
      handle.timer.unref?.()
    }

    if (pid > 0) {
      this.children.set(pid, handle)
    }

    const cleanup = (): void => {
      if (handle.timer) clearTimeout(handle.timer)
      if (handle.logFd) void handle.logFd.close().catch(() => undefined)
      if (pid > 0) this.children.delete(pid)
    }
    proc.once('close', cleanup)
    proc.once('error', cleanup)

    return proc
  }

  /**
   * Promise 化 execFile：跑完 resolve，非零退出 reject。
   * 自动登记 + 超时 + 日志，与 spawn 同一套生命周期。
   */
  execFile(bin: string, args: string[], options: SpawnOptions = {}): Promise<ExecFileResult> {
    return new Promise((resolve, reject) => {
      const proc = this.spawn(bin, args, options)
      let stdout = ''
      let stderr = ''
      const MAX_CAPTURE = 64 * 1024 // 64KB 上限，防止 ffmpeg 长输出撑爆内存
      proc.stdout?.on('data', (d: Buffer) => {
        stdout = (stdout + d.toString()).slice(-MAX_CAPTURE)
      })
      proc.stderr?.on('data', (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-MAX_CAPTURE)
      })
      proc.once('error', (err) => {
        reject(new Error(`子进程启动失败: ${err.message}`))
      })
      proc.once('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr })
        } else {
          const tail = stderr.slice(-500)
          const err = new Error(`子进程退出码 ${code}: ${bin} ${args.slice(0, 6).join(' ')}${tail ? `\n--- stderr ---\n${tail}` : ''}`) as Error & { stdout?: string; stderr?: string; code?: number }
          err.stdout = stdout
          err.stderr = stderr
          err.code = code ?? undefined
          reject(err)
        }
      })
    })
  }

  /** 批量 kill 所有登记的子进程。返回成功 kill 的数量。 */
  killAll(reason: string): number {
    let killed = 0
    for (const [pid, child] of [...this.children.entries()]) {
      try {
        child.proc.kill()
        killed++
        log.info(`killAll(${reason}): pid=${pid} ${child.bin}`)
      } catch (e) {
        log.warn(`killAll: pid=${pid} kill 失败: ${(e as Error).message}`)
      }
    }
    this.children.clear()
    return killed
  }

  /** 诊断：当前活跃子进程快照 */
  getActiveHandles(): ChildHandle[] {
    return [...this.children.values()].map(c => ({
      pid: c.pid,
      bin: c.bin,
      args: c.args,
      startTime: c.startTime,
      timeoutMs: c.timeoutMs,
      logFile: c.logFile,
      reason: c.reason
    }))
  }

  private async openLogFile(handle: RegisteredChild): Promise<void> {
    await fs.mkdir(this.logDir, { recursive: true }).catch(() => undefined)
    const file = path.join(this.logDir, `child-process-${handle.pid}.log`)
    const fd = await fs.open(file, 'a')
    handle.logFd = fd
    handle.logFile = file
    const header = `\n=== ${new Date().toISOString()} pid=${handle.pid} bin=${handle.bin} args=${handle.args.join(' ')} ===\n`
    await fd.writeFile(header).catch(() => undefined)
    handle.proc.stdout?.on('data', (d: Buffer) => fd.writeFile(d).catch(() => undefined))
    handle.proc.stderr?.on('data', (d: Buffer) => fd.writeFile(d).catch(() => undefined))
  }
}

/** 全局单例：主进程只有一个子进程登记处 */
export const childProcessManager = new ChildProcessManager()
