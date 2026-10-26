import { shell } from 'electron'
import * as fs from 'node:fs/promises'
import { resolve, dirname, extname } from 'node:path'
import { IpcChannels } from '../../shared/ipcTypes'
import { handleIpc, resolveInsideRoot, toAppFileUrl, DATA_ROOT_RESOLVED } from './shared'
import { hasDialogSession, dialogSavedFiles, dialogSelectedDirs } from './dialogSessions'
import { resolveComfyModelsDir } from './comfy'
import type { FFmpegService } from '../core/ffmpegService'
import type { SettingsStore } from '../core/settingsStore'

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
  handleIpc(IpcChannels.fileCopy, async (_, { relativePath, absoluteTarget }: { relativePath: string; absoluteTarget: string }) => {
    // absoluteTarget 必须来自用户在原生对话框中的显式选择：
    // - 保存对话框选中的文件路径（单文件导出）；或
    // - 目录选择对话框选中目录内的 .mp4（批量导出）。
    // 其余一律拒绝，防止渲染层伪造目标把文件写到系统任意位置
    const inDirSession = hasDialogSession(dialogSelectedDirs, dirname(absoluteTarget))
    if (!hasDialogSession(dialogSavedFiles, absoluteTarget) && !inDirSession) {
      throw new Error('导出目标必须来自系统保存对话框')
    }
    if (inDirSession && !hasDialogSession(dialogSavedFiles, absoluteTarget)
      && extname(absoluteTarget).toLowerCase() !== '.mp4') {
      throw new Error('目录导出仅支持 .mp4 文件')
    }
    await fs.copyFile(resolveInsideRoot(relativePath), absoluteTarget)
  })
  handleIpc(IpcChannels.fileDelete, async (_, relativePath: string) => {
    const abs = resolveInsideRoot(relativePath)
    if (abs === DATA_ROOT_RESOLVED) {
      throw new Error('禁止删除数据根目录')
    }
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
