import { readFileSync } from 'node:fs'
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

/** 读 PNG/JPEG 尺寸（不引入 sharp，纯 Node Buffer 解析） */
export function readImageSize(abs: string): { width: number; height: number } | null {
  try {
    const buf = readFileSync(abs)
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2
      while (i < buf.length - 8) {
        if (buf[i] !== 0xff) { i++; continue }
        const marker = buf[i + 1]
        if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
        }
        const len = buf.readUInt16BE(i + 2)
        if (len < 2) break
        i += 2 + len
      }
    }
  } catch {
    return null
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
