/**
 * 对话工具·文件/BGM 域：项目产物文件列表、资源管理器定位、项目 BGM 导入。
 * 从 conversationTools.ts 按域拆分外移，行为不变。
 */
import * as fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import * as path from 'node:path'
import { shell } from 'electron'
import type { ConversationToolsHost, ToolResult } from './conversationTools'
import { RESULT_LIMIT } from './conversationConstants'

export async function tSetProjectBgm(host: ConversationToolsHost, pid: string | undefined, args: Record<string, unknown>): Promise<ToolResult> {
  if (!pid) return { ok: false, text: '当前没有打开的项目' }
  const abs = String(args.absolute_path || '').trim()
  if (!abs) return { ok: false, text: '缺少 absolute_path（BGM 音频在本机的绝对路径）' }
  const ext = path.extname(abs).toLowerCase()
  if (!['.mp3', '.wav', '.m4a', '.aac', '.ogg'].includes(ext)) {
    return { ok: false, text: `不支持的音频格式 ${ext}，可用：mp3/wav/m4a/aac/ogg` }
  }
  if (!(await fs.stat(abs).then(() => true).catch(() => false))) {
    return { ok: false, text: `文件不存在：${abs}` }
  }
  const rel = `projects/${pid}/bgm${ext}`
  await fs.copyFile(abs, path.join(host.baseDir, rel))
  const volume = Math.max(0, Math.min(100, Number(args.volume ?? 35)))
  await host.projects.update(pid, p => { p.bgmPath = rel; p.bgmVolume = volume })
  return { ok: true, text: `BGM 已导入项目并设音量 ${volume}%：${rel}（可在生成预告片或 BGM 混音时使用）` }
}

export async function tListProjectFiles(host: ConversationToolsHost, pid: string | undefined): Promise<ToolResult> {
  if (!pid) return { ok: false, text: '当前没有打开的项目' }
  const root = path.join(host.baseDir, 'projects', pid)
  const files: Array<{ path: string; sizeKB: number }> = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3 || files.length >= 120) return
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { await walk(full, depth + 1); continue }
      const stat = await fs.stat(full).catch(() => null)
      if (!stat) continue
      files.push({
        path: path.relative(host.baseDir, full).replace(/\\/g, '/'),
        sizeKB: Math.round(stat.size / 1024)
      })
      if (files.length >= 120) return
    }
  }
  await walk(root, 0)
  if (!files.length) return { ok: true, text: JSON.stringify({ empty: true, message: '项目目录还没有产物文件' }) }
  return { ok: true, text: JSON.stringify({ projectId: pid, files }).slice(0, RESULT_LIMIT) }
}

export async function tOpenFile(host: ConversationToolsHost, args: Record<string, unknown>): Promise<ToolResult> {
  const rel = String(args.relative_path || '').trim()
  if (!rel) return { ok: false, text: '缺少 relative_path' }
  const abs = path.resolve(host.baseDir, rel)
  const rootResolved = path.resolve(host.baseDir)
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    return { ok: false, text: '只允许打开数据目录内的文件' }
  }
  if (!(await fs.stat(abs).then(() => true).catch(() => false))) {
    return { ok: false, text: `文件不存在：${rel}` }
  }
  shell.showItemInFolder(abs)
  return { ok: true, text: `已在资源管理器中定位：${rel}` }
}
