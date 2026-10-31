import { nativeImage, shell } from 'electron'
import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve, dirname, extname, relative, sep } from 'node:path'
import { IpcChannels } from '../../shared/ipcTypes'
import { handleIpc, resolveInsideRoot, toAppFileUrl, DATA_ROOT, DATA_ROOT_RESOLVED } from './shared'
import { hasDialogSession, dialogSavedFiles, dialogSelectedDirs } from './dialogSessions'
import { assertProjectId } from '../core/projectStore'
import { resolveComfyModelsDir } from './comfy'
import type { FFmpegService } from '../core/ffmpegService'
import type { SettingsStore } from '../core/settingsStore'

/**
 * 可删除的目录白名单（SEC-02）：仅限主进程渲染链路产出的派生文件目录。
 * 角色/场景/道具图属于用户资产，project.json/settings 属于项目元数据，一律不可删。
 */
const DELETABLE_DIRS = new Set(['audio', 'raw', 'segments', 'frames', 'shots'])
/** 项目根下可删除的产物文件（成片、缩略图、字幕） */
const DELETABLE_ROOT_FILES = new Set([
  'final.mp4',
  'final_subtitled.mp4',
  'final_master.mp4',
  'thumbnail.jpg',
  'subtitles.srt',
])

/**
 * P2-13：长列表缩略图降采样。按「源文件绝对路径 + mtime + size」命名缓存，
 * 源图更新即换 key 自动失效；缓存目录独立于 projects/，不影响项目归档。
 */
const THUMB_CACHE_DIR = join(DATA_ROOT, 'thumb-cache')
const THUMB_MAX_EDGE = 160
const THUMB_CACHE_LIMIT = 500
const THUMB_CACHE_KEEP = 400

/** 缓存条目超限时按 mtime 淘汰最旧的一批，避免长跑无限占盘 */
async function pruneThumbCache(): Promise<void> {
  const entries = await fs.readdir(THUMB_CACHE_DIR, { withFileTypes: true }).catch(() => [])
  const files = entries.filter((e) => e.isFile())
  if (files.length <= THUMB_CACHE_LIMIT) return
  const stamped = await Promise.all(
    files.map(async (e) => {
      const p = join(THUMB_CACHE_DIR, e.name)
      const st = await fs.stat(p).catch(() => null)
      return { path: p, at: st?.mtimeMs ?? 0 }
    }),
  )
  stamped.sort((a, b) => a.at - b.at)
  for (const item of stamped.slice(0, files.length - THUMB_CACHE_KEEP)) {
    await fs.rm(item.path, { force: true }).catch(() => {})
  }
}

/** 生成最长边 160px 的 JPEG：优先系统缩略图接口（不整图解码），失败再回退 nativeImage 缩放 */
async function buildThumbnail(abs: string): Promise<Buffer> {
  const shellThumb = await nativeImage
    .createThumbnailFromPath(abs, { width: THUMB_MAX_EDGE, height: THUMB_MAX_EDGE })
    .catch(() => nativeImage.createEmpty())
  if (!shellThumb.isEmpty()) return shellThumb.toJPEG(78)
  const full = nativeImage.createFromPath(abs)
  if (full.isEmpty()) throw new Error('缩略图生成失败：文件不是可识别的图片')
  const { width, height } = full.getSize()
  const edge = Math.max(width, height)
  if (edge <= THUMB_MAX_EDGE) return full.toJPEG(78)
  const scale = THUMB_MAX_EDGE / edge
  return full
    .resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' })
    .toJPEG(78)
}

/** 校验待删除路径确实落在「项目产物」白名单内，否则抛错（SEC-02） */
function assertDeletableArtifact(inputPath: string): string {
  const abs = resolveInsideRoot(inputPath)
  // 统一成相对数据根的正斜杠路径，消除绝对/相对、大小写与分隔符差异
  const rel = relative(DATA_ROOT_RESOLVED, abs).split(sep).join('/')
  const m = /^projects\/([^/]+)\/(.+)$/.exec(rel)
  if (!m) throw new Error('仅允许删除项目产物文件')
  const projectId = m[1]
  const target = m[2]
  if (!projectId || !target) throw new Error('仅允许删除项目产物文件')
  assertProjectId(projectId, '项目标识')
  const parts = target.split('/')
  const head = parts[0] ?? ''
  if (parts.length === 1) {
    if (!DELETABLE_ROOT_FILES.has(head.toLowerCase())) {
      throw new Error('该路径不属于可清理的渲染产物')
    }
  } else if (parts.length === 2) {
    if (!DELETABLE_DIRS.has(head.toLowerCase())) {
      throw new Error('该路径不属于可清理的渲染产物')
    }
  } else {
    throw new Error('仅允许删除项目产物文件')
  }
  return abs
}

export interface FileShellIpcCtx {
  ffmpegService: FFmpegService
  settingsStore: SettingsStore
}

export function registerFileShellIpc(ctx: FileShellIpcCtx): void {
  // File
  handleIpc(IpcChannels.fileExists, async (_, relativePath: string) => {
    return ctx.ffmpegService.fileExists(resolveInsideRoot(relativePath))
  })
  handleIpc(IpcChannels.fileSize, async (_, relativePath: string) => {
    return ctx.ffmpegService.getFileSize(resolveInsideRoot(relativePath))
  })
  handleIpc(
    IpcChannels.fileCopy,
    async (_, { relativePath, absoluteTarget }: { relativePath: string; absoluteTarget: string }) => {
      // absoluteTarget 必须来自用户在原生对话框中的显式选择：
      // - 保存对话框选中的文件路径（单文件导出）；或
      // - 目录选择对话框选中目录内的 .mp4（批量导出）。
      // 其余一律拒绝，防止渲染层伪造目标把文件写到系统任意位置
      const inDirSession = hasDialogSession(dialogSelectedDirs, dirname(absoluteTarget))
      if (!hasDialogSession(dialogSavedFiles, absoluteTarget) && !inDirSession) {
        throw new Error('导出目标必须来自系统保存对话框')
      }
      if (
        inDirSession &&
        !hasDialogSession(dialogSavedFiles, absoluteTarget) &&
        extname(absoluteTarget).toLowerCase() !== '.mp4'
      ) {
        throw new Error('目录导出仅支持 .mp4 文件')
      }
      await fs.copyFile(resolveInsideRoot(relativePath), absoluteTarget)
    },
  )
  handleIpc(IpcChannels.fileDelete, async (_, relativePath: string) => {
    const abs = assertDeletableArtifact(relativePath)
    // 目录一律拒绝（白名单已排除，这里再按文件类型兜底一次）
    const st = await fs.lstat(abs).catch(() => null)
    if (!st) return // 已不存在：删除幂等
    if (!st.isFile()) throw new Error('仅允许删除项目产物文件')
    await fs.rm(abs, { force: true })
  })
  handleIpc(IpcChannels.fileResolvePath, (_, relativePath: string) => {
    return resolveInsideRoot(relativePath)
  })
  handleIpc(IpcChannels.fileMediaUrl, async (_, relativePath: string) => {
    // 校验在数据根内且存在，再返回 Electron 原生 app-file URL（窗口内 <video> 播放）
    // 带文件 mtime 查询参数：同名文件更新后 URL 变化，浏览器/视频强制刷新缓存
    const abs = resolveInsideRoot(relativePath)
    const st = await fs.stat(abs)
    return `${toAppFileUrl(relativePath)}?t=${Math.floor(st.mtimeMs)}`
  })
  handleIpc(IpcChannels.fileThumbUrl, async (_, relativePath: string) => {
    // P2-13：列表只拿 160px JPEG，百镜不再同时解码原图（原图仍可按需走 mediaUrl）
    const abs = resolveInsideRoot(relativePath)
    const st = await fs.stat(abs).catch(() => null)
    if (!st?.isFile()) throw new Error('文件不存在或已被移动')
    const key = createHash('sha1').update(`${abs}|${st.mtimeMs}|${st.size}`).digest('hex')
    const rel = `thumb-cache/${key}.jpg`
    const outAbs = join(DATA_ROOT, rel)
    const cached = await fs.stat(outAbs).catch(() => null)
    if (cached?.isFile() && cached.size > 0) {
      return `${toAppFileUrl(rel)}?t=${Math.floor(cached.mtimeMs)}`
    }
    const jpeg = await buildThumbnail(abs)
    await fs.mkdir(THUMB_CACHE_DIR, { recursive: true })
    await fs.writeFile(outAbs, jpeg)
    void pruneThumbCache()
    return `${toAppFileUrl(rel)}?t=${Math.floor(st.mtimeMs)}`
  })

  // Shell：在系统文件管理器中定位文件（文件已删除/移动时抛错，由渲染进程给出引导提示）
  handleIpc(IpcChannels.shellShowItem, async (_, relativePath: string) => {
    const abs = resolveInsideRoot(relativePath)
    try {
      await fs.stat(abs)
    } catch {
      throw new Error('文件不存在或已被移动')
    }
    shell.showItemInFolder(abs)
  })

  // Shell：仅允许打开已解析的 ComfyUI models 目录（防任意路径打开）
  handleIpc(IpcChannels.shellOpenPath, async (_, absolutePath: string) => {
    const allowed = await resolveComfyModelsDir(ctx.settingsStore)
    if (!allowed) throw new Error('未配置或未找到 ComfyUI models 目录')
    const norm = (p: string) => resolve(p).toLowerCase()
    if (norm(absolutePath) !== norm(allowed)) {
      throw new Error('仅允许打开已配置的 ComfyUI models 目录')
    }
    await fs.access(allowed)
    const err = await shell.openPath(allowed)
    if (err) throw new Error(`无法打开：${err}`)
  })
}
