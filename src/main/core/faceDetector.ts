/**
 * YuNet 人脸检测（OpenCV 官方 face_detection_yunet 2023mar）——子进程实现。
 *
 * 为什么必须开子进程：项目里 @xenova/transformers 内嵌 onnxruntime-node 1.14（CLIP 用），
 * 人脸检测需要 1.20+（1.14 跑 YuNet 会原生崩溃）。同一进程先后加载两个大版本的
 * onnxruntime.dll 会触发 ERR_DLOPEN_FAILED（"The operating system cannot run %1"）。
 * 独立 Node 子进程只加载 1.20，天然隔离；单次推理约 1 秒，相对 18 分钟级渲染可忽略。
 *
 * 预处理/后处理必须与 OpenCV face_detect.cpp 一致（2026-10 实测，JS 解码框与 cv2 基准一致）：
 * 原始像素(0~255) BGR、640x640 letterbox 画布（调用方等比缩放+黑边）；
 * cls/obj sqrt 相乘阈值 0.6；cx=(c+bbox)*stride、w=exp(bbox)*stride；NMS 0.3。
 *
 * 全程可降级：onnxruntime 缺失、模型下载失败、子进程异常 → 调用方回退全图 CLIP 比对。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import axios from 'axios'
import { createLogger } from './logger'

const log = createLogger('FaceDetector')

const MODEL_URL = 'https://hf-mirror.com/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx'
const MODEL_FILE = 'yunet.onnx'
/** ArcFace MobileFaceNet（insightface w600k，约 13.6MB，512 维人脸向量，换人敏感度远高于 CLIP） */
const REC_URL = 'https://hf-mirror.com/WePrompt/buffalo_sc/resolve/main/w600k_mbf.onnx'
const REC_FILE = 'w600k_mbf.onnx'
const WORKER_FILE = 'face-detect-worker.cjs'
export const FACE_INPUT_SIZE = 640
export const FACE_REC_SIZE = 112
const CHILD_TIMEOUT_MS = 30000

export interface FaceBox {
  /** 相对 640 画布归一化坐标 0~1 */
  x: number
  y: number
  w: number
  h: number
  score: number
  /** 5 个关键点归一化坐标（右眼,左眼,鼻尖,右嘴角,左嘴角），扁平 [x0,y0,...]，用于人脸对齐 */
  lm: number[]
}

/**
 * 子进程工作脚本（纯 CJS，运行时写入 modelDir）两种模式：
 * 检测: worker.cjs <onnxruntime 入口> <yunet.onnx> <a640.rgb> <b640.rgb> → {a:[box],b:[box]}
 * 识别: worker.cjs <onnxruntime 入口> embed <arcface.onnx> <a112.rgb> <b112.rgb> → {a:[512],b:[512]}
 * stdout 输出一行 RESULT=<json>
 */
const WORKER_SOURCE = `'use strict'
const fs = require('node:fs')
const ort = require(process.argv[2])
const N = 640
const STRIDES = [8, 16, 32]
function nms(boxes, threshold) {
  boxes.sort((a, b) => b.score - a.score)
  const keep = []
  const used = new Array(boxes.length).fill(false)
  for (let i = 0; i < boxes.length; i++) {
    if (used[i]) continue
    keep.push(boxes[i])
    for (let j = i + 1; j < boxes.length; j++) {
      if (used[j]) continue
      const a = boxes[i], b = boxes[j]
      const xx1 = Math.max(a.x, b.x), yy1 = Math.max(a.y, b.y)
      const xx2 = Math.min(a.x + a.w, b.x + b.w), yy2 = Math.min(a.y + a.h, b.y + b.h)
      const ow = Math.max(0, xx2 - xx1), oh = Math.max(0, yy2 - yy1)
      const inter = ow * oh, union = a.w * a.h + b.w * b.h - inter
      if (union > 0 && inter / union > threshold) used[j] = true
    }
  }
  return keep
}
async function detect(sess, rgb) {
  const plane = N * N
  const blob = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    blob[i] = rgb[i * 3 + 2]
    blob[plane + i] = rgb[i * 3 + 1]
    blob[2 * plane + i] = rgb[i * 3]
  }
  const outs = await sess.run({ input: new ort.Tensor('float32', blob, [1, 3, N, N]) })
  const boxes = []
  for (const stride of STRIDES) {
    const cols = N / stride, rows = N / stride
    const cls = outs['cls_' + stride].data
    const obj = outs['obj_' + stride].data
    const bbox = outs['bbox_' + stride].data
    const kps = outs['kps_' + stride].data
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c
        const cs = Math.min(1, Math.max(0, cls[idx]))
        const os = Math.min(1, Math.max(0, obj[idx]))
        const score = Math.sqrt(cs * os)
        if (score < 0.6) continue
        const cx = (c + bbox[idx * 4]) * stride
        const cy = (r + bbox[idx * 4 + 1]) * stride
        const w = Math.exp(bbox[idx * 4 + 2]) * stride
        const h = Math.exp(bbox[idx * 4 + 3]) * stride
        const lm = []
        for (let k = 0; k < 5; k++) lm.push((kps[idx * 10 + 2 * k] + c) * stride / N, (kps[idx * 10 + 2 * k + 1] + r) * stride / N)
        boxes.push({ x: (cx - w / 2) / N, y: (cy - h / 2) / N, w: w / N, h: h / N, score, lm })
      }
    }
  }
  return nms(boxes, 0.3)
}
function embed(sess, rgb) {
  const S = 112, plane = S * S
  const blob = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    blob[i] = (rgb[i * 3] - 127.5) / 127.5
    blob[plane + i] = (rgb[i * 3 + 1] - 127.5) / 127.5
    blob[2 * plane + i] = (rgb[i * 3 + 2] - 127.5) / 127.5
  }
  return sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', blob, [1, 3, S, S]) }).then(outs => {
    const vec = Array.from(outs[sess.outputNames[0]].data)
    let norm = 0
    for (const v of vec) norm += v * v
    norm = Math.sqrt(norm) || 1
    return vec.map(v => v / norm)
  })
}
;(async () => {
  // argv: worker <ort入口> [embed <识别模型> a112.rgb b112.rgb] | <检测模型> a640.rgb b640.rgb
  let out
  if (process.argv[3] === 'embed') {
    const sess = await ort.InferenceSession.create(process.argv[4], { executionProviders: ['cpu'] })
    const a = fs.readFileSync(process.argv[5])
    const b = fs.readFileSync(process.argv[6])
    out = { a: await embed(sess, a), b: await embed(sess, b) }
  } else {
    const sess = await ort.InferenceSession.create(process.argv[3], { executionProviders: ['cpu'] })
    const a = fs.readFileSync(process.argv[4])
    const b = fs.readFileSync(process.argv[5])
    out = { a: await detect(sess, a), b: await detect(sess, b) }
  }
  process.stdout.write('RESULT=' + JSON.stringify(out))
  process.exit(0)
})().catch(e => { process.stderr.write(String(e && e.stack || e)); process.exit(1) })
`

export class FaceDetector {
  private modelReady = false
  private initAttempted = false
  private initFailed = false
  private recAttempted = false
  private recAvailable = false
  private workerPath: string
  private ortEntry: string | null = null

  constructor(private modelDir: string) {
    this.workerPath = path.join(modelDir, WORKER_FILE)
  }

  /** 检测模型/工作脚本是否可用（失败永久降级） */
  async available(): Promise<boolean> {
    if (this.initFailed) return false
    try {
      await this.ensure()
      return true
    } catch {
      return false
    }
  }

  /** ArcFace 识别模型是否可用（惰性下载；失败只影响人脸比对，自动回退全图 CLIP） */
  async recognitionAvailable(): Promise<boolean> {
    if (!await this.available()) return false
    if (!this.recAttempted) {
      this.recAttempted = true
      try {
        const recPath = path.join(this.modelDir, REC_FILE)
        try {
          await fs.access(recPath)
        } catch {
          const res = await axios.get<ArrayBuffer>(REC_URL, { responseType: 'arraybuffer', timeout: 180000 })
          await fs.writeFile(recPath, Buffer.from(res.data))
          log.info('ArcFace 识别模型已下载（约 13.6MB）')
        }
        this.recAvailable = true
      } catch (e) {
        console.warn('[FaceDetector] ArcFace 不可用，人脸比对回退全图 CLIP:', (e as Error).message)
      }
    }
    return this.recAvailable
  }

  private async ensure(): Promise<void> {
    if (this.modelReady) return
    if (this.initAttempted) throw new Error('face detector unavailable')
    this.initAttempted = true
    await fs.mkdir(this.modelDir, { recursive: true })

    // 1. YuNet 模型（约 0.2MB）
    const modelPath = path.join(this.modelDir, MODEL_FILE)
    try {
      await fs.access(modelPath)
    } catch {
      const res = await axios.get<ArrayBuffer>(MODEL_URL, { responseType: 'arraybuffer', timeout: 120000 })
      await fs.writeFile(modelPath, Buffer.from(res.data))
      log.info('YuNet 模型已下载（约 0.2MB）')
    }

    // 2. 解析 onnxruntime-node 入口（打包后在 app.asar.unpacked 内也可解析）
    const require = createRequire(import.meta.url)
    this.ortEntry = require.resolve('onnxruntime-node')

    // 3. 落地子进程脚本
    await fs.writeFile(this.workerPath, WORKER_SOURCE, 'utf8')

    this.modelReady = true
  }

  /**
   * 一次性检测两张 640x640 RGB24 图（等比 letterbox 后的裸数据文件）。
   * 任一失败返回 null（调用方回退全图比对）；成功返回两图的人脸框数组。
   */
  async detectPair(rgbPathA: string, rgbPathB: string): Promise<{ a: FaceBox[]; b: FaceBox[] } | null> {
    await this.ensure()
    return this.runWorker<{ a: FaceBox[]; b: FaceBox[] }>(
      [path.join(this.modelDir, MODEL_FILE), rgbPathA, rgbPathB], true
    )
  }

  /**
   * 两张已对齐的 112x112 RGB24 人脸图 → L2 归一化 512 维 ArcFace 向量。
   * 失败返回 null（调用方回退全图 CLIP）。
   */
  async embedPair(rgbA: Uint8Array, rgbB: Uint8Array): Promise<{ a: number[]; b: number[] } | null> {
    await this.ensure()
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const pA = path.join(this.modelDir, `.rec-in-a_${suffix}.rgb`)
    const pB = path.join(this.modelDir, `.rec-in-b_${suffix}.rgb`)
    try {
      await Promise.all([fs.writeFile(pA, rgbA), fs.writeFile(pB, rgbB)])
      return await this.runWorker<{ a: number[]; b: number[] }>(
        ['embed', path.join(this.modelDir, REC_FILE), pA, pB], false
      )
    } finally {
      await Promise.all([
        fs.unlink(pA).catch(() => undefined),
        fs.unlink(pB).catch(() => undefined)
      ])
    }
  }

  private runWorker<T>(extraArgs: string[], permanentFail: boolean): Promise<T | null> {
    return new Promise(resolve => {
      const child = spawn(
        process.execPath,
        [this.workerPath, this.ortEntry!, ...extraArgs],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        }
      )
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill()
        console.warn('[FaceDetector] 子进程超时')
        resolve(null)
      }, CHILD_TIMEOUT_MS)
      child.stdout.on('data', d => { stdout += d.toString() })
      child.stderr.on('data', d => { stderr += d.toString() })
      child.on('error', e => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.fail(permanentFail, e.message)
        resolve(null)
      })
      child.on('close', code => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code !== 0) {
          this.fail(permanentFail, stderr.slice(-300))
          resolve(null)
          return
        }
        const line = stdout.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('RESULT=')).pop()
        if (!line) {
          this.fail(permanentFail, 'no result')
          resolve(null)
          return
        }
        try {
          resolve(JSON.parse(line.slice('RESULT='.length)) as T)
        } catch (e) {
          this.fail(permanentFail, (e as Error).message)
          resolve(null)
        }
      })
    })
  }

  private fail(permanent: boolean, reason: string): void {
    if (permanent) {
      this.initFailed = true
      console.warn('[FaceDetector] 人脸检测已禁用（回退全图比对）:', reason)
    } else {
      console.warn('[FaceDetector] 本次人脸识别失败（回退全图比对）:', reason)
    }
  }
}
