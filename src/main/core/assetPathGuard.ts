/**
 * 素材路径守卫（S-06 / P1-5）：外部传入的参考图、尾帧、BGM 路径在交给
 * ComfyUI uploadImage / 项目复制之前统一校验，阻断「提示词注入 → 把本机敏感文件
 * 当作素材上传到 ComfyUI input 目录」的链路。
 *
 * 口径（2026-10-30 用户确认）：白名单校验——允许数据根之外的绝对路径，
 * 但扩展名必须属于图片/音频/视频白名单；不强制存在性（存在性由调用方按需检查，
 * 部分内部流程的产物路径在调用时尚未落盘）。
 */
import { extname, isAbsolute } from 'node:path'

export type MediaKind = 'image' | 'audio' | 'video'

const ALLOWED_EXTS: Record<MediaKind, string[]> = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.bmp'],
  audio: ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'],
  video: ['.mp4', '.mov', '.mkv', '.webm', '.avi']
}

/** Windows 盘符路径在非 Windows 运行时也可识别（CI/测试环境） */
const DRIVE_ABS = /^[A-Za-z]:[\\/]/

/**
 * 校验并返回规范化后的素材路径。
 * @param opts.requireAbsolute LLM 可控入口（render_quick / set_project_bgm）传 true；
 *                             内部 UI 入口可传 false（相对路径由上层 resolveInsideRoot 约束）。
 */
export function assertMediaPath(
  raw: string,
  kind: MediaKind,
  field = '素材',
  opts: { requireAbsolute?: boolean } = {}
): string {
  const value = raw.trim()
  if (!value) throw new Error(`${field}路径为空`)
  if (/[\0\r\n]/.test(value)) throw new Error(`${field}路径含非法控制字符`)
  if (opts.requireAbsolute && !isAbsolute(value) && !DRIVE_ABS.test(value)) {
    throw new Error(`${field}必须是绝对路径：${value}`)
  }
  const ext = extname(value).toLowerCase()
  const allowed = ALLOWED_EXTS[kind]
  if (!allowed.includes(ext)) {
    throw new Error(`${field}格式不支持：${ext || '(无扩展名)'}，可用：${allowed.join(' / ')}`)
  }
  return value
}
