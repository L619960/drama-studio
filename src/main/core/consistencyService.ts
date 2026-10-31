/**
 * 人物一致性校验（可选增强，全程可降级）：
 * - face 模式：YuNet 检测人脸（子进程 onnxruntime-node 1.20，隔离 transformers 内嵌的 1.14）
 *   → 五点关键点 ArcFace 模板对齐 → w600k_mbf 提取 512 维人脸向量比余弦，对换人敏感
 * - full 模式：至少一侧无人脸或人脸模型不可用时，用 @huggingface/transformers 的 CLIP-B/32
 *   跑全图图像向量（模型约 90MB，首次从 hf-mirror 下载）
 * - 图像解码不依赖 sharp（其原生库常装不全）：由调用方用 ffmpeg 喂入 RGB24 裸帧
 * - 模型体积：YuNet 约 0.2MB、w600k_mbf 约 13.6MB，均惰性下载到数据目录便于清理
 * - 任一依赖/模型不可用：available()=false 或自动回退，调用方静默跳过，绝不阻塞渲染
 */
import { FaceDetector, FACE_INPUT_SIZE } from './faceDetector'
import { createLogger } from './logger'

const log = createLogger('Consistency')

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
  [70.7299, 92.3655],
]

/** 定长 4 元向量 / 4×4 矩阵：把「长度必然为 4」表达进类型，避免索引退化出 undefined */
type Vec4 = readonly [number, number, number, number]
type Mat4 = readonly [Vec4, Vec4, Vec4, Vec4]

/**
 * 定长数值缓冲的受检读取。
 * 高斯消元、双线性重采样的下标由算法保证落在 [0, len) 内，但编译器无法静态推断；
 * 越界时显式报错，把「不变量被破坏」暴露出来，而不是用 `!` 或默认值掩盖。
 */
function at(v: ArrayLike<number>, i: number): number {
  const x = v[i]
  if (x === undefined) throw new RangeError(`数值下标越界: ${i} / ${v.length}`)
  return x
}

/** 4×4 线性方程组高斯消元（相似变换法方程，对称正定，无需主元选取也稳定） */
function solve4(Ain: Mat4, bin: Vec4): Vec4 {
  // 拷贝成行主序定长缓冲，避免原地改写调用方传入的矩阵
  const A = new Float64Array(16)
  const b = new Float64Array(bin)
  Ain.forEach((row, r) => {
    row.forEach((v, c) => {
      A[r * 4 + c] = v
    })
  })
  for (let col = 0; col < 4; col++) {
    let piv = col
    for (let r = col + 1; r < 4; r++) {
      if (Math.abs(at(A, r * 4 + col)) > Math.abs(at(A, piv * 4 + col))) piv = r
    }
    if (piv !== col) {
      for (let c = 0; c < 4; c++) {
        const t = at(A, col * 4 + c)
        A[col * 4 + c] = at(A, piv * 4 + c)
        A[piv * 4 + c] = t
      }
      const tv = at(b, col)
      b[col] = at(b, piv)
      b[piv] = tv
    }
    for (let r = col + 1; r < 4; r++) {
      const f = at(A, r * 4 + col) / at(A, col * 4 + col)
      for (let c = col; c < 4; c++) A[r * 4 + c] = at(A, r * 4 + c) - f * at(A, col * 4 + c)
      b[r] = at(b, r) - f * at(b, col)
    }
  }
  const x = new Float64Array(4)
  for (let r = 3; r >= 0; r--) {
    let s = at(b, r)
    for (let c = r + 1; c < 4; c++) s -= at(A, r * 4 + c) * at(x, c)
    x[r] = s / at(A, r * 4 + r)
  }
  return [at(x, 0), at(x, 1), at(x, 2), at(x, 3)]
}

/**
 * 两套阈值（各自口径不同，不可混用），低于阈值视为人物/画面漂移，默认 warn 只告警不阻塞：
 * - FACE_CONSISTENCY_THRESHOLD：w600k_mbf ArcFace 512 维人脸向量余弦。
 *   2026-10 实测定标（同镜定妆照 vs 视频帧，构图/姿态接近，这是生产真实场景）：
 *   同人 0.558；换人 最高 0.200（同画风正脸跨性别），其余 -0.07~0.04。
 *   2026-10-11 修正：阈值由间隙中值 0.35 提到 0.5——实拍发现 0.35~0.5 区间大量
 *   漂移/换脸镜（穿帮）被静默放行，宁可把姿态差异大的同人镜误伤为告警/剔除，
 *   也不让漂移画面混入成片。跨镜头极端姿态差异（大仰角侧脸 vs 正脸特写）同人
 *   仍可能低至 0.20，此场景只告警不阻断。
 * - CONSISTENCY_THRESHOLD：CLIP-B/32 全图向量余弦（无人脸回退路径）。
 */
export const FACE_CONSISTENCY_THRESHOLD = 0.5
export const CONSISTENCY_THRESHOLD = 0.7
/**
 * 首帧 vs 定妆照的相似度阈值（P1-1）。
 * 需求文档给定 0.7：首帧由定妆照直接 i2i 生成，构图/姿态接近，同人分数应显著高于
 * 视频末帧口径（实测同人 0.558）。低于该值自动用同参数重抽 1 次，仍低只告警不阻塞。
 */
export const FIRST_FRAME_FACE_THRESHOLD = 0.7
/**
 * H3 引擎身份漂移严重阈值：分数低于此值时，同引擎换 seed 重渲大概率仍是漂移，
 * 直接自动切换 Wan i2v 重渲（Wan 用首帧做物理起点图，身份锁定远强于 H3 r2v）。
 * 2026-10 实测：该镜 H3 r2v 人脸相似度 0.26~0.30（夸张大笑+脸型变形），
 * 切 Wan i2v 后回升至 0.65。
 */
export const H3_WAN_FALLBACK_THRESHOLD = 0.3

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
  /** 方法判定命中记录（诊断用，渲染日志可见） */
  lastMethodTrace = ''

  constructor(
    private modelDir: string,
    private loadRawImage: RawImageLoader,
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
      // ENG-06：从停维护的 @xenova/transformers 迁到官方 @huggingface/transformers。
      // 注意：transformers 3.8.1 精确锁 onnxruntime-node 1.21.0，与顶层 1.31.1 并存为嵌套副本
      // （双份原生库，约 501MB）；收敛需等 transformers 4.x，electron-builder.yml 已同步解包嵌套路径。
      const transformers = await import('@huggingface/transformers')
      transformers.env.remoteHost = 'https://hf-mirror.com'
      transformers.env.allowLocalModels = false
      transformers.env.cacheDir = this.modelDir
      this.RawImageCtor = transformers.RawImage as unknown as RawImageConstructor
      const pipe = await transformers.pipeline('image-feature-extraction', MODEL_ID, {
        // v3 用 dtype 指定量化档位（q8 = 旧的 quantized: true）
        dtype: 'q8',
      })
      this.extractor = pipe as unknown as ExtractorPipeline
      return this.extractor
    } catch (e) {
      this.initFailed = true
      log.warn(`一致性校验已禁用（依赖或模型不可用）: ${(e as Error).message}`)
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
        const detOk = await this.faceDetector.available()
        if (detOk) {
          const pair = await this.faceDetector.detectPair(ref.filePath, frame.filePath)
          this.lastMethodTrace = `facesA=${pair?.a?.length ?? -1},facesB=${pair?.b?.length ?? -1}`
          if (pair) {
            pair.a.sort((x, y) => y.score - x.score)
            pair.b.sort((x, y) => y.score - x.score)
          }
          const fa = pair?.a[0]
          const fb = pair?.b[0]
          if (fa && fb && (await this.faceDetector.recognitionAvailable())) {
            // 小脸门控：640 画布上人脸框 <35px（中远景/过肩镜常见）时五点对齐出的
            // 112 人脸是放大噪点，ArcFace 向量接近随机（实测同人低至 0.08~0.2），
            // 此类帧必须回退全图 CLIP，不能把垃圾低分当作漂移证据
            const MIN_FACE = 0.055
            this.lastMethodTrace += `,topA=${fa.w.toFixed(3)}x${fa.h.toFixed(3)},topB=${fb.w.toFixed(3)}x${fb.h.toFixed(3)}`
            if (fa.w >= MIN_FACE && fa.h >= MIN_FACE && fb.w >= MIN_FACE && fb.h >= MIN_FACE) {
              const refFace = this.alignFace(ref, fa.lm, REC_SIZE, FACE_TEMPLATE_112)
              const frameFace = this.alignFace(frame, fb.lm, REC_SIZE, FACE_TEMPLATE_112)
              const emb = await this.faceDetector.embedPair(refFace.data, frameFace.data)
              if (emb) return { score: this.cosine(emb.a, emb.b), method: 'face' }
              this.lastMethodTrace += ',embed=null'
            } else {
              this.lastMethodTrace += ',MIN_FACE 门控拦截'
            }
          } else {
            this.lastMethodTrace += ',rec不可用或单侧无脸'
          }
        } else {
          this.lastMethodTrace = 'detector不可用'
        }
      } catch (e) {
        log.warn(`人脸比对失败，回退全图 CLIP: ${(e as Error).message}`)
      }

      // 全图 CLIP 回退（至少一侧无人脸 / 模型不可用）
      const extractor = await this.ensure()
      const Ctor = this.RawImageCtor!
      const refImg = new Ctor(ref.data, ref.width, ref.height, 3)
      const frameImg = new Ctor(frame.data, frame.width, frame.height, 3)
      const out = await extractor([refImg, frameImg], { pooling: 'mean', normalize: true })
      const vectors = this.toVectors(out)
      const [v0, v1] = vectors
      if (!v0 || !v1) throw new Error('特征提取结果异常')
      return { score: this.cosine(v0, v1), method: 'full' }
    } finally {
      await Promise.all([ref.dispose(), frame.dispose()])
    }
  }

  /**
   * 多帧平均一致性：对视频按 frameTimes 逐帧比对参考图，取分数平均。
   * 解决"单帧 90% 处抽样"漏掉中间段漂移的问题；method 取各帧中任一命中人脸即 face。
   * 任一帧失败自动跳过；全部失败回退单帧（首帧时间点）。
   */
  async compareFrames(
    referenceImagePath: string,
    targetPath: string,
    frameTimes: number[],
  ): Promise<ConsistencyResult> {
    if (!Array.isArray(frameTimes) || frameTimes.length === 0) {
      return this.compare(referenceImagePath, targetPath)
    }
    const results: ConsistencyResult[] = []
    for (const t of frameTimes) {
      try {
        results.push(await this.compare(referenceImagePath, targetPath, t))
      } catch (e) {
        log.warn(`帧 ${t.toFixed(2)}s 比对失败已跳过: ${(e as Error).message}`)
      }
    }
    if (results.length === 0) {
      return this.compare(referenceImagePath, targetPath, frameTimes[0])
    }
    // 分方法聚合（2026-10-17 修复）：face（ArcFace 0.5 阈值口径）与 full（CLIP 0.7 阈值口径）
    // 是两套不同量表，混算平均后对标单一阈值会双向误判——CLIP 高分稀释 face 低分会放行真漂移，
    // face 低分拉低 CLIP 平均会误杀同人。人脸帧存在时只信人脸帧均分（对换人最敏感）；
    // 全部无人脸（小脸/背身被门控回退）时用全图均分。
    const faceScores = results.filter((r) => r.method === 'face').map((r) => r.score)
    const fullScores = results.filter((r) => r.method === 'full').map((r) => r.score)
    const avg = (v: number[]): number => v.reduce((s, x) => s + x, 0) / v.length
    if (faceScores.length > 0) {
      return { score: Math.round(avg(faceScores) * 1000) / 1000, method: 'face' }
    }
    return { score: Math.round(avg(fullScores) * 1000) / 1000, method: 'full' }
  }

  /**
   * 五点关键点相似变换对齐（ArcFace 标准模板，消除仰头/侧脸姿态差异），
   * 从 640 letterbox 画布双线性变换到 size×size；越界取黑。
   * lm 为归一化扁平 [x0,y0,...]（右眼,左眼,鼻尖,右嘴角,左嘴角）。
   */
  private alignFace(
    src: RawRgbImage,
    lm: readonly number[],
    size: number,
    template: ReadonlyArray<readonly [number, number]>,
  ): RawRgbImage {
    const n = src.width
    // 源点（画布像素）与模板逐点配对，避免对关键点数组做动态下标访问
    const pairs = template.map(([tx, ty], k) => {
      const x = lm[2 * k]
      const y = lm[2 * k + 1]
      if (x === undefined || y === undefined) throw new Error('人脸关键点数据不完整')
      return { sx: x * n, sy: y * n, tx, ty }
    })
    const count = pairs.length
    // 最小二乘拟合 x' = a*x - b*y + tx，y' = b*x + a*y + ty（旋转+等比缩放+平移）
    let sumSx = 0
    let sumSy = 0
    let sumSq = 0
    let ba = 0
    let bb = 0
    let btx = 0
    let bty = 0
    for (const p of pairs) {
      sumSx += p.sx
      sumSy += p.sy
      sumSq += p.sx * p.sx + p.sy * p.sy
      ba += p.tx * p.sx + p.ty * p.sy
      bb += p.ty * p.sx - p.tx * p.sy
      btx += p.tx
      bty += p.ty
    }
    const A: Mat4 = [
      [sumSq, 0, sumSx, sumSy],
      [0, sumSq, -sumSy, sumSx],
      [sumSx, -sumSy, count, 0],
      [sumSy, sumSx, 0, count],
    ]
    const [a, b, tx, ty] = solve4(A, [ba, bb, btx, bty])
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
          const v00 = at(src.data, (y0 * n + x0) * 3 + ch)
          const v01 = at(src.data, (y0 * n + x1) * 3 + ch)
          const v10 = at(src.data, (y1 * n + x0) * 3 + ch)
          const v11 = at(src.data, (y1 * n + x1) * 3 + ch)
          dst[di + ch] = Math.round(
            v00 * (1 - wx) * (1 - wy) + v01 * wx * (1 - wy) + v10 * (1 - wx) * wy + v11 * wx * wy,
          )
        }
      }
    }
    return { data: dst, width: size, height: size, channels: 3 }
  }

  /** pipeline 可能返回单张量 [batch,dim] 或张量数组，统一拆成向量列表 */
  private toVectors(out: FeatureTensor | FeatureTensor[]): Vector[] {
    if (Array.isArray(out)) return out.map((t) => t.data)
    if (out.dims && out.dims.length === 2) {
      const n = out.dims[0]
      const dim = out.dims[1]
      if (n === undefined || dim === undefined) return [out.data]
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
    for (let i = 0; i < len; i++) {
      const av = at(a, i)
      const bv = at(b, i)
      dot += av * bv
      na += av * av
      nb += bv * bv
    }
    if (na === 0 || nb === 0) return 0
    return dot / (Math.sqrt(na) * Math.sqrt(nb))
  }
}
