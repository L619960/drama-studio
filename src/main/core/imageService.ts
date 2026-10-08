import type { ComfyUIClient } from './comfyuiClient'
import type { WorkflowLoader } from './workflowLoader'

/**
 * T2I 图片生成服务：把提示词提交给 ComfyUI 文生图工作流，产物落到指定绝对路径。
 * - 自动从 ComfyUI 获取可用 Checkpoint 填充 ckpt_name
 * - 可选 width/height：覆盖 EmptyLatentImage 节点（定妆图横版 768x512）
 */
export class ImageService {
  constructor(
    private comfyui: ComfyUIClient,
    private workflow: WorkflowLoader
  ) {}

  async generate(
    prompt: string,
    absOutput: string,
    options?: { workflowName?: string; width?: number; height?: number }
  ): Promise<void> {
    const name = options?.workflowName || 'builtin_t2i'
    const seed = Math.floor(Math.random() * 0xffffffff)

    const checkpoints = await this.comfyui.getCheckpoints()
    if (checkpoints.length === 0) {
      throw new Error('ComfyUI 无可用 Checkpoint 模型，请先加载模型')
    }

    const graph = await this.workflow.buildGraph(name, { PROMPT: prompt, SEED: seed })

    // 填充空 ckpt_name；按需覆盖空 latent 尺寸
    const graphObj = graph as Record<
      string,
      { class_type?: string; inputs?: Record<string, unknown> }
    >
    for (const nodeId of Object.keys(graphObj)) {
      const node = graphObj[nodeId]
      if (!node.inputs) continue
      if ('ckpt_name' in node.inputs && !node.inputs.ckpt_name) {
        node.inputs.ckpt_name = checkpoints[0]
      }
      if (
        node.class_type === 'EmptyLatentImage' &&
        options?.width && options?.height
      ) {
        node.inputs.width = options.width
        node.inputs.height = options.height
      }
    }

    const { promptId } = await this.comfyui.submit(graph)
    const output = await this.comfyui.waitForCompletion(promptId)

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
}
