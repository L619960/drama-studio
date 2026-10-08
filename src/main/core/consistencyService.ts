/**
 * 人物一致性校验（可选增强，全程可降级）：
 * - face 模式：YuNet 检测人脸（子进程 onnxruntime-node 1.20，隔离 transformers 内嵌的 1.14）
 *   → 五点关键点 ArcFace 模板对齐 → w600k_mbf 提取 512 维人脸向量比余弦，对换人敏感
 * - full 模式：至少一侧无人脸或人脸模型不可用时，用 @xenova/transformers 的 CLIP-B/32
 *   跑全图图像向量（模型约 90MB，首次从 hf-mirror 下载）
 * - 图像解码不依赖 sharp（其原生库常装不全）：由调用方用 ffmpeg 喂入 RGB24 裸帧
 * - 模型体积：YuNet 约 0.2MB、w600k_mbf 约 13.6MB，均惰性下载到数据目录便于清理
 * - 任一依赖/模型不可用：available()=false 或自动回退，调用方静默跳过，绝不阻塞渲染
 */
import { FaceDetector, FACE_INPUT_SIZE } from './faceDetector'

const MODEL_ID = 'Xenova/clip-vit-base-patch32'
const REC_SIZE = 112
/**
 * ArcFace 五点对齐模板：右眼、左眼、鼻尖、右嘴角、左嘴角。
 * 标准 112 模板（w600k 输入用）。
 */
const FACE_TEMPLATE_112: ReadonlyArray<readonly [number, number]> = [
  [38.2946, 51.6963],
  [73.5318, 51.6963],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.3655]
]

/** 4×4 线性方程组高斯消元（相似变换法方程，对称正定，无需主元选取也稳定） */
function solve4(Ain: number[][], bin: number[]): number[] {
  const A = Ain.map(row => row.slice())
  const b = bin.slice()
  for (let col = 0; col < 4; col++) {
    let piv = col
    for (let r = col + 1; r < 4; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r
    if (piv !== col) {
      const tr = A[col]; A[col] = A[piv]; A[piv] = tr
      const tv = b[col]; b[col] = b[piv]; b[piv] = tv
    }
    for (let r = col + 1; r < 4; r++) {
      const f = A[r][col] / A[col][col]
      for (let c = col; c < 4; c++) A[r][c] -= f * A[col][c]
      b[r] -= f * b[col]
    }
  }
  const x = [0, 0, 0, 0]
  for (let r = 3; r >= 0; r--) {
    let s = b[r]
    for (let c = r + 1; c < 4; c++) s -= A[r][c] * x[c]
    x[r] = s / A[r][r]
  }
  return x
}

/**
 * 两套阈值（各自口径不同，不可混用），低于阈值视为人物/画面漂移，默认 warn 只告警不阻塞：
 * - FACE_CONSISTENCY_THRESHOLD：w600k_mbf ArcFace 512 维人脸向量余弦。
 *   2026-10 实测定标（同镜定妆照 vs 视频帧，构图/姿态接近，这是生产真实场景）：
 *   同人 0.558；换人 最高 0.200（同画风正脸跨性别），其余 -0.07~0.04 → 阈值取间隙中值 0.35。
 *   注：跨镜头极端姿态差异（大仰角侧脸 vs 正脸特写）同人也可能低至 0.20，此场景只告警。
 * - CONSISTENCY_THRESHOLD：CLIP-B/32 全图向量余弦（无人脸回退路径）。
 */
export const FACE_CONSISTENCY_THRESHOLD = 0.35
export const CONSISTENCY_THRESHOLD = 0.7

export interface RawRgbImage {
  data: Uint8Array
  width: number
  height: number
  channels: 3
}

/** 图像解码句柄：内存 RGB + 背后的临时裸文件（供人脸检测子进程读取），用完必须 dispose */
export interface LoadedRgb extends RawRgbImage {
  filePath: string
  dispose(): Promise<void>
}

/** 调用方提供的图像解码：把图片/视频帧等比缩放 letterbox 为 size×size 的 RGB24（绕开 sharp） */
export type RawImageLoader = (srcPath: string, timeSec?: number, size?: number) => Promise<LoadedRgb>

export interface ConsistencyResult {
  /** 余弦相似度 0~1，越高越像 */
  score: number
  /** face=两图均裁人脸区后比对；full=至少一侧无人脸，全图比对 */
  method: 'face' | 'full'
}

type Vector = Float32Array | number[]

interface FeatureTensor {
  data: Vector
  dims?: number[]
}

interface ExtractorPipeline {
  (images: unknown[], options: { pooling: 'mean'; normalize: boolean }): Promise<FeatureTensor | FeatureTensor[]>
}

interface RawImageConstructor {
  new (data: Uint8Array, width: number, height: number, channels: 3): unknown
}

export class ConsistencyService {
  private extractor: ExtractorPipeline | null = null
  private RawImageCtor: RawImageConstructor | null = null
  private initAttempted = false
  private initFailed = false
  private faceDetector: FaceDetector

  constructor(
    private modelDir: string,
    private loadRawImage: RawImageLoader
  ) {
    this.faceDetector = new FaceDetector(modelDir)
  }

  /** 是否首次加载（会触发模型下载，调用方可给用户进度提示） */
  get needsDownload(): boolean {
    return !this.extractor && !this.initFailed
  }

  /** 能力探测：依赖/模型任一不可用即永久禁用本会话的该校验 */
  async available(): Promise<boolean> {
    try {
      await this.ensure()
      return true
    } catch {
      return false
    }
  }

  private async ensure(): Promise<ExtractorPipeline> {
    if (this.extractor) return this.extractor
    if (this.initAttempted && this.initFailed) {
      throw new Error('consistency check unavailable')
    }
    this.initAttempted = true
    try {
      // 动态依赖：未安装时 import 失败，功能自动关闭
      const transformers = await import('@xenova/transformers')
      transformers.env.remoteHost = 'https://hf-mirror.com'
      transformers.env.allowLocalModels = false
      transformers.env.cacheDir = this.modelDir
      this.RawImageCtor = transformers.RawImage as unknown as RawImageConstructor
      const pipe = await transformers.pipeline('image-feature-extraction', MODEL_ID, {
        quantized: true
      })
      this.extractor = pipe as unknown as ExtractorPipeline
      return this.extractor
    } catch (e) {
      this.initFailed = true
      console.warn('[Consistency] 一致性校验已禁用（依赖或模型不可用）:', (e as Error).message)
      throw e
    }
  }

  /**
   * 参考图与视频帧的人物相似度（0~1，越高越像）。
   * frameTimeSec 给定时从视频该时间点抽帧，否则把 targetPath 当图片读。
   * 两侧都有人脸 → ArcFace 人脸向量（method='face'）；否则/失败 → 全图 CLIP（method='full'）。
   */
  async compare(referenceImagePath: string, targetPath: string, frameTimeSec?: number): Promise<ConsistencyResult> {
    const ref = await this.loadRawImage(referenceImagePath, undefined, FACE_INPUT_SIZE)
    const frame = await this.loadRawImage(targetPath, frameTimeSec, FACE_INPUT_SIZE)
    try {
      // 两侧都有人脸且 ArcFace 可用：专用人脸向量比对；任何失败静默回退全图 CLIP
      try {
        if (await this.faceDetector.available()) {
          const pair = await this.faceDetector.detectPair(ref.filePath, frame.filePath)
          if (pair && pair.a.length > 0 && pair.b.length > 0 && await this.faceDetector.recognitionAvailable()) {
            pair.a.sort((x, y) => y.score - x.score)
            pair.b.sort((x, y) => y.score - x.score)
            const refFace = this.alignFace(ref, pair.a[0].lm, REC_SIZE, FACE_TEMPLATE_112)
            const frameFace = this.alignFace(frame, pair.b[0].lm, REC_SIZE, FACE_TEMPLATE_112)
            const emb = await this.faceDetector.embedPair(refFace.data, frameFace.data)
            if (emb) return { score: this.cosine(emb.a, emb.b), method: 'face' }
          }
        }
      } catch (e) {
        console.warn('[Consistency] 人脸比对失败，回退全图 CLIP:', (e as Error).message)
      }

      // 全图 CLIP 回退（至少一侧无人脸 / 模型不可用）
      const extractor = await this.ensure()
      const Ctor = this.RawImageCtor!
      const refImg = new Ctor(ref.data, ref.width, ref.height, 3)
      const frameImg = new Ctor(frame.data, frame.width, frame.height, 3)
      const out = await extractor([refImg, frameImg], { pooling: 'mean', normalize: true })
      const vectors = this.toVectors(out)
      if (vectors.length < 2) throw new Error('特征提取结果异常')
      return { score: this.cosine(vectors[0], vectors[1]), method: 'full' }
    } finally {
      await Promise.all([ref.dispose(), frame.dispose()])
    }
  }

  /**
   * 五点关键点相似变换对齐（ArcFace 标准模板，消除仰头/侧脸姿态差异），
   * 从 640 letterbox 画布双线性变换到 size×size；越界取黑。
   * lm 为归一化扁平 [x0,y0,...]（右眼,左眼,鼻尖,右嘴角,左嘴角）。
   */
  private alignFace(
    src: RawRgbImage,
    lm: number[],
    size: number,
    template: ReadonlyArray<readonly [number, number]>
  ): RawRgbImage {
    const n = src.width
    const t = template
    // 源点：画布像素坐标
    const sx = [lm[0] * n, lm[2] * n, lm[4] * n, lm[6] * n, lm[8] * n]
    const sy = [lm[1] * n, lm[3] * n, lm[5] * n, lm[7] * n, lm[9] * n]
    // 最小二乘拟合 x' = a*x - b*y + tx，y' = b*x + a*y + ty（旋转+等比缩放+平移）
    const A = [
      [this.sq(sx) + this.sq(sy), 0, this.sum(sx), this.sum(sy)],
      [0, this.sq(sx) + this.sq(sy), -this.sum(sy), this.sum(sx)],
      [this.sum(sx), -this.sum(sy), 5, 0],
      [this.sum(sy), this.sum(sx), 0, 5]
    ]
    let bvec: number[]
    {
      let ba = 0, bb = 0, btx = 0, bty = 0
      for (let i = 0; i < 5; i++) {
        ba += t[i][0] * sx[i] + t[i][1] * sy[i]
        bb += t[i][1] * sx[i] - t[i][0] * sy[i]
        btx += t[i][0]
        bty += t[i][1]
      }
      bvec = [ba, bb, btx, bty]
    }
    const [a, b, tx, ty] = solve4(A, bvec)
    const inv = 1 / (a * a + b * b)

    const dst = new Uint8Array(size * size * 3)
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        // 目标像素中心逆变换回源画布
        const qx = dx + 0.5 - tx
        const qy = dy + 0.5 - ty
        const fx = (a * qx + b * qy) * inv
        const fy = (-b * qx + a * qy) * inv
        const di = (dy * size + dx) * 3
        if (fx < 0 || fy < 0 || fx > n - 1 || fy > n - 1) continue // 越界黑
        const x0 = Math.floor(fx)
        const y0 = Math.floor(fy)
        const x1 = Math.min(n - 1, x0 + 1)
        const y1 = Math.min(n - 1, y0 + 1)
        const wx = fx - x0
        const wy = fy - y0
        for (let ch = 0; ch < 3; ch++) {
          const v00 = src.data[(y0 * n + x0) * 3 + ch]
          const v01 = src.data[(y0 * n + x1) * 3 + ch]
          const v10 = src.data[(y1 * n + x0) * 3 + ch]
          const v11 = src.data[(y1 * n + x1) * 3 + ch]
          dst[di + ch] = Math.round(
            v00 * (1 - wx) * (1 - wy) + v01 * wx * (1 - wy) + v10 * (1 - wx) * wy + v11 * wx * wy
          )
        }
      }
    }
    return { data: dst, width: size, height: size, channels: 3 }
  }

  private sum(v: number[]): number { let s = 0; for (const x of v) s += x; return s }
  private sq(v: number[]): number { let s = 0; for (const x of v) s += x * x; return s }

  /** pipeline 可能返回单张量 [batch,dim] 或张量数组，统一拆成向量列表 */
  private toVectors(out: FeatureTensor | FeatureTensor[]): Vector[] {
    if (Array.isArray(out)) return out.map(t => t.data)
    if (out.dims && out.dims.length === 2) {
      const [n, dim] = out.dims
      const result: Vector[] = []
      for (let i = 0; i < n; i++) {
        result.push(Array.prototype.slice.call(out.data, i * dim, (i + 1) * dim))
      }
      return result
    }
    return [out.data]
  }

  private cosine(a: Vector, b: Vector): number {
    const len = Math.min(a.length, b.length)
    let dot = 0
    let na = 0
    let nb = 0
    for (let i = 0;i < len; i++) {
      dot += a[i] * b[i]
      na += a[i] * a[i]
      nb += b[i] * b[i]
    }
    if (na === 0 || nb === 0) return 0
    return dot / (Math.sqrt(na) * Math.sqrt(nb))
  }

}
