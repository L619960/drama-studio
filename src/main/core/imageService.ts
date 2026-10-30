import type { ComfyUIClient } from './comfyuiClient'
import type { WorkflowLoader } from './workflowLoader'
import { REALISM_NEGATIVE, CINEMATIC_QUALITY_BLOCK } from '../../shared/imagePrompts'
import { isTransientError } from './errorClassify'
import path from 'node:path'

export class ImageGenerateCancelled extends Error {
  constructor() {
    super('IMAGE_GENERATE_CANCELLED')
    this.name = 'ImageGenerateCancelled'
  }
}

export interface ImageGenerateOptions {
  workflowName?: string
  width?: number
  height?: number
  negative?: string
  /** 固定种子；未传则随机 */
  seed?: number
  /** 图生图参考图（定妆图等）：模板含 $REF_IMAGE$ 占位符时自动上传并注入 */
  referenceImagePath?: string
  /** 多参考图（全景方位图×定妆图等）：依次注入 $REF_IMAGE$, $REF_IMAGE2$, $REF_IMAGE3$。
   *  传入时优先于 referenceImagePath（referenceImagePath 兼容旧调用）。 */
  referenceImagePaths?: string[]
  /** 严格工作流：workflowName 模板不存在时直接报错（不降级到 builtin_t2i 文生）。
   *  用于双图融合等「必须用指定模板」的场景，失败由调用方回退其他路径。 */
  strictWorkflow?: boolean
  /** 瞬时故障重试次数（不含首次），默认 2 */
  retries?: number
  /** 取消探测：返回 true 时中断等待 */
  shouldAbort?: () => boolean
  /** Comfy 等待超时（毫秒）；未传则客户端默认 */
  timeoutMs?: number
}

/**
 * T2I 图片生成服务：把提示词提交给 ComfyUI 文生图工作流，产物落到指定绝对路径。
 * - 默认 qwen_t2i_hq（缺文件回退 builtin_t2i）
 * - 始终注入写实负向，压制油光塑料美颜
 * - 瞬时故障自动退避重试；OOM 时降一档分辨率再试一次
 */
export class ImageService {
  /** 技能库电影级质量条款（index.ts 启动时注入）；为空时回退代码层精简条款 */
  qualityBlock = CINEMATIC_QUALITY_BLOCK

  constructor(
    private comfyui: ComfyUIClient,
    private workflow: WorkflowLoader
  ) {}

  async generate(
    prompt: string,
    absOutput: string,
    options?: ImageGenerateOptions
  ): Promise<void> {
    const retries = options?.retries ?? 2
    let width = options?.width ?? 768
    let height = options?.height ?? 1152
    let oomUsed = false
    let lastErr: unknown

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (options?.shouldAbort?.()) throw new ImageGenerateCancelled()
      try {
        // 电影级条款统一注入（技能库增强版优先，代码常量兜底）：
        // 提示词已含代码版条款（如 shotFramePrompt 自带 CINEMATIC_QUALITY_BLOCK）则跳过，
        // 避免同套条款重复出现拖长提示词
        // D-04（2026-10-20）：改整块常量匹配——此前用 'cinematic vfx discipline' 单句嗅探，
        // 用户 prompt 恰好含该字样时会误跳过整块质量条款
        const finalPrompt = prompt.includes(CINEMATIC_QUALITY_BLOCK)
          ? prompt
          : `${prompt}, ${this.qualityBlock}`
        await this.runOnce(finalPrompt, absOutput, {
          ...options,
          width,
          height
        })
        return
      } catch (e) {
        lastErr = e
        if (e instanceof ImageGenerateCancelled) throw e
        if (options?.shouldAbort?.()) throw new ImageGenerateCancelled()

        const oom = this.isOom(e)
        if (oom && !oomUsed) {
          oomUsed = true
          width = Math.max(448, Math.round((width * 0.85) / 32) * 32)
          height = Math.max(768, Math.round((height * 0.85) / 32) * 32)
          await this.comfyui.interrupt().catch(() => undefined)
          continue
        }

        if (attempt < retries && isTransientError(e)) {
          const delay = 2000 * (attempt + 1)
          await this.sleep(delay, options?.shouldAbort)
          continue
        }
        throw e
      }
    }
    throw lastErr
  }

  private async runOnce(
    prompt: string,
    absOutput: string,
    options?: ImageGenerateOptions
  ): Promise<void> {
    const listed = await this.workflow.list()
    const preferred = options?.workflowName || 'qwen_t2i_hq'
    let name = preferred
    if (!listed.some((w) => w.name === preferred)) {
      if (options?.strictWorkflow) {
        throw new Error(`工作流 ${preferred} 不存在（strictWorkflow）`)
      }
      name = listed.some((w) => w.name === 'builtin_t2i') ? 'builtin_t2i' : preferred
    }
    const seed =
      typeof options?.seed === 'number' && Number.isFinite(options.seed)
        ? Math.floor(options.seed) >>> 0
        : Math.floor(Math.random() * 0xffffffff)
    const negative = options?.negative || REALISM_NEGATIVE
    console.log(`[ImageService] wf=${name} seed=${seed} ${options?.width}x${options?.height} out=${path.basename(absOutput)}`)

    const checkpoints = await this.comfyui.getCheckpoints()
    if (checkpoints.length === 0) {
      throw new Error('ComfyUI 无可用 Checkpoint 模型，请先加载模型')
    }

    const meta = listed.find((w) => w.name === name)
    const vars: Record<string, string | number> = {
      PROMPT: prompt,
      SEED: seed,
      NEGATIVE: negative
    }
    if (meta?.placeholders.includes('WIDTH')) vars.WIDTH = options?.width ?? 768
    if (meta?.placeholders.includes('HEIGHT')) vars.HEIGHT = options?.height ?? 1152
    const refs = options?.referenceImagePaths?.length
      ? options.referenceImagePaths
      : options?.referenceImagePath
        ? [options.referenceImagePath]
        : []
    const refTokens = ['REF_IMAGE', 'REF_IMAGE2', 'REF_IMAGE3'] as const
    for (let i = 0; i < refTokens.length; i++) {
      const token = refTokens[i]
      if (!meta?.placeholders.includes(token)) continue
      const abs = refs[i]
      if (!abs) {
        throw new Error(`工作流 ${name} 需要图生图参考图 ${token}，但未提供第 ${i + 1} 张参考图`)
      }
      vars[token] = await this.comfyui.uploadImage(abs)
    }
    // 兼容旧模板：$REF_IMAGE$ 存在但走 referenceImagePaths 时已由上方覆盖；此处仅兜底未命中 token 的旧调用
    if (!refs.length && meta?.placeholders.includes('REF_IMAGE')) {
      throw new Error(`工作流 ${name} 需要图生图参考图，但未提供参考图`)
    }
    const graph = await this.workflow.buildGraph(name, vars)

    const graphObj = graph as Record<
      string,
      { class_type?: string; inputs?: Record<string, unknown> }
    >
    for (const node of Object.values(graphObj)) {
      if (!node.inputs) continue
      if ('ckpt_name' in node.inputs && !node.inputs.ckpt_name) {
        node.inputs.ckpt_name = checkpoints[0]
      }
      if (
        (node.class_type === 'EmptyLatentImage' || node.class_type === 'EmptySD3LatentImage') &&
        options?.width && options?.height
      ) {
        node.inputs.width = options.width
        node.inputs.height = options.height
      }
      if (
        !meta?.placeholders.includes('NEGATIVE') &&
        node.class_type === 'CLIPTextEncode' &&
        typeof node.inputs.text === 'string'
      ) {
        const t = node.inputs.text
        if (t !== prompt && (t.length === 0 || t.length < 80 || /plastic|blurry|anime|low quality/i.test(t))) {
          node.inputs.text = negative
        }
      }
    }

    if (options?.shouldAbort?.()) throw new ImageGenerateCancelled()
    const { promptId } = await this.comfyui.submit(graph)
    const output = await this.raceAbort(
      this.comfyui.waitForCompletion(promptId, undefined, options?.timeoutMs),
      options?.shouldAbort
    )

    const images = output.images
    if (!images || images.length === 0) {
      throw new Error('ComfyUI 未输出图片')
    }
    const img = images[0]
    if (img.fullpath) {
      await this.comfyui.downloadFromFullPath(img.fullpath, absOutput)
    } else {
      await this.comfyui.download(img.filename, img.subfolder, img.type, absOutput)
    }
  }

  private isOom(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err)
    return /out of memory|\boom\b|cuda error|alloc.*(memory|failed)|insufficient.*vram|vram.*(insufficient|exceed|alloc)|hbm|显存不足|内存不足/i.test(msg)
  }

  private async raceAbort<T>(
    promise: Promise<T>,
    shouldAbort?: () => boolean
  ): Promise<T> {
    if (!shouldAbort) return promise
    return new Promise<T>((resolve, reject) => {
      const timer = setInterval(() => {
        if (shouldAbort()) {
          clearInterval(timer)
          this.comfyui.interrupt().catch(() => undefined)
          reject(new ImageGenerateCancelled())
        }
      }, 800)
      promise.then(
        (v) => { clearInterval(timer); resolve(v) },
        (e) => { clearInterval(timer); reject(e) }
      )
    })
  }

  private sleep(ms: number, shouldAbort?: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      if (!shouldAbort) return
      const poll = setInterval(() => {
        if (shouldAbort()) {
          clearTimeout(timer)
          clearInterval(poll)
          reject(new ImageGenerateCancelled())
        }
      }, 400)
      setTimeout(() => clearInterval(poll), ms + 50)
    })
  }
}
