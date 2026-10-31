import * as fs from 'node:fs/promises'

/** 队列任务项（项目/镜头复合键由 TaskQueue.shotKey 生成） */
export interface QueuedTask {
  projectId: string
  shotId: string
}

/** 取消信号错误（同步检查点与 watcher 共用） */
export const CANCEL_ERROR = '__CANCELLED__'

/** MiniMax H3 turbo LoRA（本机已验证存在）：低步数官方加速，画质高于同步数无 LoRA */
export const LORA_T2V_TURBO = 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors'
export const LORA_R2V_TURBO = 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors'

/**
 * 读 PNG/JPEG 尺寸（不引入 sharp，纯 Node Buffer 解析）。
 * CORE-12：只异步读文件头部（128KB 上限），避免渲染热路径每镜同步读整张图
 * （4K 首帧可达数 MB）；JPEG 的 SOF 段通常在头部，超出窗口时返回 null 由调用方回退默认画幅。
 */
export async function readImageSize(abs: string): Promise<{ width: number; height: number } | null> {
  const HEAD_SIZE = 128 * 1024
  let fh: fs.FileHandle | undefined
  try {
    fh = await fs.open(abs, 'r')
    const stat = await fh.stat()
    const len = Math.min(HEAD_SIZE, stat.size)
    if (len <= 0) return null
    const raw = Buffer.alloc(len)
    const { bytesRead } = await fh.read(raw, 0, len, 0)
    const buf = raw.subarray(0, bytesRead)
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2
      while (i < buf.length - 8) {
        if (buf[i] !== 0xff) {
          i++
          continue
        }
        const marker = buf[i + 1]
        if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
        }
        const lenSeg = buf.readUInt16BE(i + 2)
        if (lenSeg < 2) break
        i += 2 + lenSeg
      }
    }
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => undefined)
  }
  return null
}

/** 文件是否存在（TTS 音频复用判定） */
export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * 设置页数字(50-200 / 0-100)转 msedge-tts 百分比字符串。
 * 100 → '+0%'，150 → '+50%'，50 → '-50%'
 */
export function toPercent(value: number): string {
  const v = Math.round(value) - 100
  return `${v >= 0 ? '+' : ''}${v}%`
}
