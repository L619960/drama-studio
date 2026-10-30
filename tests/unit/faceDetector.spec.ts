/**
 * FaceDetector 单测（不发网络、不启 onnxruntime/onnx/子进程）：
 * - fs/promises：同步 fs mock（ttsService 风格），避免 fake timers + 真实异步 IO 竞态
 * - axios.get：返回假 ArrayBuffer；网络异常时抛错
 * - child_process.spawn：返回可控 EventEmitter 假子进程，事件用 setTimeout 0 触发
 *   （避免同步 emit 在 spawn mock 尚未返回就触发 close 导致状态错乱）
 * - node:module createRequire：返回带 resolve() 方法的函数对象
 * - 覆盖：available 成功/失败降级、ensure 已就绪短路、ensure 模型已存在/需下载、
 *   recognitionAvailable 已缓存/首次下载/下载失败、detectPair 成功/子进程失败兜底、
 *   runWorker 返回非法 JSON/缺少 RESULT= 行/超时/kill、embedPair 成功/临时文件清理、
 *   fail permanentFail 分支与一次性 initFailed 永久降级、spawn 入参正确性
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'
import * as nodeOs from 'node:os'
import { EventEmitter } from 'node:events'

// ============================================================ hoisted 状态
const state = vi.hoisted(() => ({
  fsCalls: [] as Array<{ fn: string; args: unknown[] }>,
  accessBehavior: null as null | ((p: string) => unknown),
  spawnBehaviors: [] as Array<(cp: FakeChildProcess, args: string[]) => void>,
  spawnCalls: [] as Array<{ file: string; args: string[]; opts: unknown }>,
  axiosBehavior: null as null | ((url: string) => { data: ArrayBuffer } | never),
  axiosCalls: [] as string[],
  requireResolve: 'C:/fake/onnxruntime-node/index.js'
}))

class FakeChildProcess extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  killed = false
  constructor() {
    super()
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
  }
  kill() { this.killed = true }
}

// ============================================================ mocks

vi.mock('node:fs/promises', async () => {
  const { default: fs } = await import('node:fs')
  const SYNC_MAP: Record<string, string> = {
    mkdir: 'mkdirSync',
    writeFile: 'writeFileSync',
    access: 'accessSync',
    unlink: 'unlinkSync',
    stat: 'statSync',
    rename: 'renameSync',
    rm: 'rmSync'
  }
  const wrap = (name: string) => (...args: unknown[]) => {
    state.fsCalls.push({ fn: name, args })
    if (name === 'access' && state.accessBehavior) {
      try { state.accessBehavior(args[0] as string); return Promise.resolve(undefined) }
      catch (e) { return Promise.reject(e) }
    }
    try {
      return Promise.resolve((fs as unknown as Record<string, (...a: unknown[]) => unknown>)[SYNC_MAP[name]](...args))
    } catch (e) {
      return Promise.reject(e)
    }
  }
  const out: Record<string, unknown> = {}
  for (const n of Object.keys(SYNC_MAP)) out[n] = wrap(n)
  out.default = out
  return out
})

vi.mock('node:child_process', () => ({
  spawn: (file: string, args: string[], opts?: unknown) => {
    state.spawnCalls.push({ file, args, opts })
    const cp = new FakeChildProcess()
    const behavior = state.spawnBehaviors.shift()
    if (behavior) {
      // 用 microtask 调度，确保 spawn 返回后再触发事件
      queueMicrotask(() => behavior(cp, args))
    }
    return cp
  }
}))

vi.mock('node:module', () => ({
  createRequire: () => {
    const req = (_spec: string) => null
    req.resolve = () => {
      if (state.requireResolve === '__THROW__') throw new Error('ort resolve failed')
      return state.requireResolve
    }
    return req
  }
}))

vi.mock('axios', () => ({
  default: {
    get: async (url: string) => {
      state.axiosCalls.push(url)
      if (state.axiosBehavior) return state.axiosBehavior(url)
      return { data: new ArrayBuffer(16) }
    }
  }
}))

vi.mock('../../src/main/core/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { FaceDetector, FACE_INPUT_SIZE, FACE_REC_SIZE } from '../../src/main/core/faceDetector'

// ============================================================ 工具
let baseDir = ''
let modelDir = ''

const accessOk = () => { state.accessBehavior = () => undefined }
function accessMissing(...paths: string[]) {
  state.accessBehavior = (p: string) => {
    if (paths.some(x => String(p).includes(x))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return undefined
  }
}
const makeDetector = () => new FaceDetector(modelDir)

/** 等待子进程事件触发 */
function waitForSpawn(ms = 10) {
  return new Promise(res => setTimeout(res, ms))
}

beforeEach(() => {
  baseDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'face-spec-'))
  modelDir = nodePath.join(baseDir, 'models')
  state.fsCalls.length = 0
  state.spawnCalls.length = 0
  state.spawnBehaviors.length = 0
  state.accessBehavior = null
  state.axiosBehavior = null
  state.axiosCalls.length = 0
  state.requireResolve = 'C:/fake/onnxruntime-node/index.js'
})

afterEach(() => {
  try { nodeFs.rmSync(baseDir, { recursive: true, force: true }) } catch {}
})

// ============================================================ describe
describe('FaceDetector', () => {

  it('常量导出：FACE_INPUT_SIZE=640 / FACE_REC_SIZE=112', () => {
    expect(FACE_INPUT_SIZE).toBe(640)
    expect(FACE_REC_SIZE).toBe(112)
  })

  describe('ensure 与 available', () => {
    it('首次 available 成功：mkdir → parse ort → 写 worker；二次短路', async () => {
      accessOk()
      const fd = makeDetector()
      await expect(fd.available()).resolves.toBe(true)
      await expect(fd.available()).resolves.toBe(true)
      expect(state.fsCalls.some(c => c.fn === 'mkdir')).toBe(true)
      expect(state.fsCalls.some(c => c.fn === 'writeFile' && String(c.args[0]).includes('face-detect-worker'))).toBe(true)
    })

    it('ensure 的 access 抛 EACCES（非 ENOENT）→ 也触发下载路径（catch 吞掉任何错误），可用', async () => {
      state.accessBehavior = (p: string) => {
        if (String(p).includes('yunet.onnx')) throw Object.assign(new Error('EACCES model'), { code: 'EACCES' })
        return undefined
      }
      state.axiosBehavior = () => ({ data: new ArrayBuffer(1024) })
      const fd = makeDetector()
      await expect(fd.available()).resolves.toBe(true)
      // access 任何失败 → 都尝试 axios 下载
      expect(state.axiosCalls.some(u => u.includes('yunet'))).toBe(true)
    })

    it('ensure 的 createRequire.resolve 抛错 → ensure throw → available false，永久降级', async () => {
      state.requireResolve = '__THROW__'
      accessOk()
      const fd = makeDetector()
      await expect(fd.available()).resolves.toBe(false)
      await expect(fd.available()).resolves.toBe(false)
    })
  })

  describe('ensure 模型下载', () => {
    it('YuNet 模型缺失 → axios.get 下载 + writeFile', async () => {
      accessMissing('yunet.onnx')
      state.axiosBehavior = () => ({ data: new ArrayBuffer(4096) })
      const fd = makeDetector()
      await expect(fd.available()).resolves.toBe(true)
      expect(state.axiosCalls.some(u => u.includes('yunet'))).toBe(true)
      expect(state.fsCalls.some(c => c.fn === 'writeFile' && String(c.args[0]).includes('yunet.onnx'))).toBe(true)
    })

    it('YuNet 下载失败 → available false，二次仍 false', async () => {
      accessMissing('yunet.onnx')
      state.axiosBehavior = () => { throw new Error('network down') }
      const fd = makeDetector()
      await expect(fd.available()).resolves.toBe(false)
      await expect(fd.available()).resolves.toBe(false)
    })
  })

  describe('recognitionAvailable', () => {
    it('依赖 available()：检测模型不可用 → 直接 false', async () => {
      state.requireResolve = '__THROW__'
      accessOk()
      const fd = makeDetector()
      await expect(fd.recognitionAvailable()).resolves.toBe(false)
      expect(state.axiosCalls.filter(u => u.includes('w600k'))).toHaveLength(0)
    })

    it('rec 模型已缓存 → 不下载，直接 true', async () => {
      accessOk()
      const fd = makeDetector()
      await expect(fd.recognitionAvailable()).resolves.toBe(true)
      expect(state.axiosCalls.filter(u => u.includes('w600k'))).toHaveLength(0)
    })

    it('rec 模型缺失 → 下载成功；仅首次下载（recAttempted 锁）', async () => {
      state.accessBehavior = (p: string) => {
        if (String(p).includes('w600k')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return undefined
      }
      state.axiosBehavior = (u) => {
        if (u.includes('w600k')) return { data: new ArrayBuffer(16_000_000) }
        return { data: new ArrayBuffer(16) }
      }
      const fd = makeDetector()
      await expect(fd.recognitionAvailable()).resolves.toBe(true)
      expect(state.axiosCalls.filter(u => u.includes('w600k'))).toHaveLength(1)
      await expect(fd.recognitionAvailable()).resolves.toBe(true)
      expect(state.axiosCalls.filter(u => u.includes('w600k'))).toHaveLength(1)
    })

    it('rec 模型下载失败 → recognitionAvailable=false（不影响 detect）', async () => {
      state.accessBehavior = (p: string) => {
        if (String(p).includes('w600k')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return undefined
      }
      state.axiosBehavior = (u) => {
        if (u.includes('w600k')) throw new Error('rec network fail')
        return { data: new ArrayBuffer(16) }
      }
      const fd = makeDetector()
      await expect(fd.recognitionAvailable()).resolves.toBe(false)
      await expect(fd.available()).resolves.toBe(true)
    })
  })

  describe('runWorker（detectPair）', () => {
    beforeEach(() => { accessOk() })

    it('正常返回 RESULT= → 解析成功', async () => {
      const boxes = [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4, score: 0.85, lm: [1,2,3,4,5,6,7,8,9,10] }]
      state.spawnBehaviors.push((cp) => {
        cp.stdout.emit('data', 'RESULT=' + JSON.stringify({ a: boxes, b: [] }))
        cp.emit('close', 0)
      })
      const fd = makeDetector()
      const p = fd.detectPair('a.rgb', 'b.rgb')
      await waitForSpawn()
      await expect(p).resolves.toEqual({ a: boxes, b: [] })
    })

    it('exit 0 但 stdout 无 RESULT= → null', async () => {
      state.spawnBehaviors.push((cp) => {
        cp.stderr.emit('data', 'some warning')
        cp.stdout.emit('data', 'random log line')
        cp.emit('close', 0)
      })
      const fd = makeDetector()
      const p = fd.detectPair('a.rgb', 'b.rgb')
      await waitForSpawn()
      await expect(p).resolves.toBeNull()
    })

    it('RESULT= 后 JSON 非法 → null', async () => {
      state.spawnBehaviors.push((cp) => {
        cp.stdout.emit('data', 'RESULT=not-json')
        cp.emit('close', 0)
      })
      const fd = makeDetector()
      const p = fd.detectPair('a.rgb', 'b.rgb')
      await waitForSpawn()
      await expect(p).resolves.toBeNull()
    })

    it('exit code ≠ 0 → null', async () => {
      state.spawnBehaviors.push((cp) => {
        cp.stderr.emit('data', 'onnxruntime error: ' + 'x'.repeat(320))
        cp.emit('close', 1)
      })
      const fd = makeDetector()
      const p = fd.detectPair('a.rgb', 'b.rgb')
      await waitForSpawn()
      await expect(p).resolves.toBeNull()
    })

    it('子进程 error 事件 → null', async () => {
      state.spawnBehaviors.push((cp) => {
        cp.emit('error', new Error('spawn ENOENT'))
      })
      const fd = makeDetector()
      const p = fd.detectPair('a.rgb', 'b.rgb')
      await waitForSpawn()
      await expect(p).resolves.toBeNull()
    })

    it('close 行包含多余换行（split + pop 选最后一行）→ 正确解析', async () => {
      const boxes = [{ x: 0.5, y: 0.5, w: 0.2, h: 0.2, score: 0.9, lm: Array(10).fill(0) }]
      state.spawnBehaviors.push((cp) => {
        cp.stdout.emit('data', '\n  some log \n  RESULT=' + JSON.stringify({ a: boxes, b: [] }) + '\n')
        cp.emit('close', 0)
      })
      const fd = makeDetector()
      const p = fd.detectPair('a.rgb', 'b.rgb')
      await waitForSpawn()
      await expect(p).resolves.toEqual({ a: boxes, b: [] })
    })
  })

  describe('detectPair permanentFail=true 降级', () => {
    beforeEach(() => { accessOk() })

    it('子进程失败 → initFailed 永久置真，后续 available 永远 false', async () => {
      state.spawnBehaviors.push((cp) => { cp.emit('close', 1) })
      const fd = makeDetector()
      const p = fd.detectPair('a.rgb', 'b.rgb')
      await waitForSpawn()
      await expect(p).resolves.toBeNull()
      await expect(fd.available()).resolves.toBe(false)
    })
  })

  describe('embedPair', () => {
    beforeEach(() => { accessOk() })

    it('正常流程：写临时 rgb → 跑子进程 → finally 清理 unlink', async () => {
      state.spawnBehaviors.push((cp) => {
        cp.stdout.emit('data', 'RESULT=' + JSON.stringify({ a: Array(512).fill(0.1), b: Array(512).fill(-0.1) }))
        cp.emit('close', 0)
      })
      const fd = makeDetector()
      const p = fd.embedPair(new Uint8Array(112 * 112 * 3), new Uint8Array(112 * 112 * 3))
      await waitForSpawn()
      const r = await p
      expect(r).toBeDefined()
      expect(r!.a).toHaveLength(512)
      // writeFile = ensure 写 worker 1 + embedPair 写 pA/pB 2 = 3
      expect(state.fsCalls.filter(c => c.fn === 'writeFile')).toHaveLength(3)
      expect(state.fsCalls.filter(c => c.fn === 'unlink')).toHaveLength(2)
    })

    it('子进程失败 → 临时文件仍清理；permanentFail=false 不永久降级', async () => {
      state.spawnBehaviors.push((cp) => { cp.emit('close', 2) })
      const fd = makeDetector()
      const p = fd.embedPair(new Uint8Array(112 * 112 * 3), new Uint8Array(112 * 112 * 3))
      await waitForSpawn()
      await expect(p).resolves.toBeNull()
      expect(state.fsCalls.filter(c => c.fn === 'unlink')).toHaveLength(2)
      await expect(fd.available()).resolves.toBe(true)
    })
  })

  describe('子进程 spawn 入参', () => {
    beforeEach(() => { accessOk() })

    it('detectPair：process.execPath + worker + ortEntry + yunet.onnx + 两个 rgb', async () => {
      state.spawnBehaviors.push((cp) => {
        cp.stdout.emit('data', 'RESULT=' + JSON.stringify({ a: [], b: [] }))
        cp.emit('close', 0)
      })
      const fd = makeDetector()
      const p = fd.detectPair('x.rgb', 'y.rgb')
      await waitForSpawn()
      await p
      const call = state.spawnCalls[0]
      expect(call.file).toBe(process.execPath)
      expect(call.args).toHaveLength(5)
      expect(call.args[0]).toContain('face-detect-worker')
      expect(call.args[1]).toBe('C:/fake/onnxruntime-node/index.js')
      expect(call.args[2]).toContain('yunet.onnx')
      expect(call.args[3]).toBe('x.rgb')
      expect(call.args[4]).toBe('y.rgb')
    })

    it('embedPair：多 embed 标记 + rec 模型', async () => {
      accessOk()
      const fd = makeDetector()
      await fd.available()
      state.spawnCalls.length = 0
      state.spawnBehaviors.push((cp) => {
        cp.stdout.emit('data', 'RESULT=' + JSON.stringify({ a: [0.1], b: [0.2] }))
        cp.emit('close', 0)
      })
      const p = fd.embedPair(new Uint8Array(112 * 112 * 3), new Uint8Array(112 * 112 * 3))
      await waitForSpawn()
      await p
      const call = state.spawnCalls[0]
      expect(call.args[2]).toBe('embed')
      expect(call.args[3]).toContain('w600k_mbf')
    })
  })

  describe('构造器 workerPath', () => {
    it('基于传入 modelDir 拼接 face-detect-worker.cjs', () => {
      const fd = makeDetector()
      const priv = fd as unknown as { workerPath: string }
      expect(priv.workerPath).toBe(nodePath.join(modelDir, 'face-detect-worker.cjs'))
    })
  })
})
