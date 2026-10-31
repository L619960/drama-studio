import * as fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import * as path from 'node:path'
import type { Project } from '../../shared/ipcTypes'
import { createZip, readZip, type ZipEntryInput } from '../../shared/zipArchive'
import { isArchiveIgnored, rewriteProjectIdPaths, uniqueProjectTitle } from '../../shared/projectArchive'
import { atomicWriteJson } from './fsUtil'

/**
 * REQ-20：项目包导出/导入（zip 由 shared/zipArchive 读写，无第三方依赖）。
 * 导出只打包项目目录内文件，临时产物与 director-state.json 默认排除；
 * 导入总是分配新项目 id 并改写 project.json 内资源路径，重名标题自动加「-副本」。
 */

export interface ArchiveProgress {
  percent: number
  message: string
}

export interface ExportProjectPackageInput {
  /** 磁盘上的项目目录（DATA_ROOT/projects/<id>） */
  projectDir: string
  targetPath: string
  includeDirectorState?: boolean
  onProgress?: (p: ArchiveProgress) => void
}

export interface ExportProjectPackageResult {
  files: number
  bytes: number
}

export interface ImportProjectPackageInput {
  /** DATA_ROOT；项目写入 DATA_ROOT/projects/<newId> */
  dataRoot: string
  zipBuffer: Buffer
  /** 当前数据根内已有项目标题：重名自动加「-副本」 */
  existingTitles: readonly string[]
  onProgress?: (p: ArchiveProgress) => void
}

async function collectFiles(
  dir: string,
  relBase: string,
  includeDirectorState: boolean,
  out: Array<{ abs: string; rel: string; size: number }>
): Promise<void> {
  let items: Dirent[]
  try {
    items = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const item of items) {
    const rel = relBase ? `${relBase}/${item.name}` : item.name
    const abs = path.join(dir, item.name)
    if (item.isDirectory()) {
      if (isArchiveIgnored(rel, { includeDirectorState })) continue
      await collectFiles(abs, rel, includeDirectorState, out)
      continue
    }
    if (!item.isFile()) continue
    if (isArchiveIgnored(rel, { includeDirectorState })) continue
    try {
      const stat = await fs.stat(abs)
      out.push({ abs, rel, size: stat.size })
    } catch {
      /* 单文件读取失败跳过，不阻断整包导出 */
    }
  }
}

/** 打包项目目录为 zip，写入 targetPath；返回文件数与原始字节数 */
export async function exportProjectPackage(
  input: ExportProjectPackageInput
): Promise<ExportProjectPackageResult> {
  const includeDirectorState = Boolean(input.includeDirectorState)
  const files: Array<{ abs: string; rel: string; size: number }> = []
  await collectFiles(input.projectDir, '', includeDirectorState, files)
  files.sort((a, b) => a.rel.localeCompare(b.rel))

  const total = files.length
  const totalBytes = files.reduce((n, f) => n + f.size, 0)
  let doneBytes = 0
  const entries: ZipEntryInput[] = []

  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    const data = await fs.readFile(f.abs)
    entries.push({ path: f.rel, data })
    doneBytes += f.size
    const percent = total > 0 ? Math.min(99, Math.round((doneBytes / Math.max(1, totalBytes)) * 100)) : 99
    input.onProgress?.({
      percent,
      message: `正在打包项目文件 ${i + 1}/${total}（${percent}%）`
    })
    // 让出事件循环：大项目导出期间保持 UI 响应
    await new Promise(resolve => setImmediate(resolve))
  }

  const zip = createZip(entries)
  const targetDir = path.dirname(input.targetPath)
  await fs.mkdir(targetDir, { recursive: true })
  const tmp = `${input.targetPath}.part`
  await fs.writeFile(tmp, zip)
  await fs.rename(tmp, input.targetPath)
  input.onProgress?.({ percent: 100, message: `已导出 ${total} 个文件` })
  return { files: total, bytes: totalBytes }
}

async function allocateProjectId(dataRoot: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    try {
      await fs.access(path.join(dataRoot, 'projects', id))
    } catch {
      return id
    }
  }
  throw new Error('无法分配新的项目目录，请稍后重试')
}

/** 解压项目包到 DATA_ROOT；返回导入后的项目（id 与标题已按冲突规则重写） */
export async function importProjectPackage(
  input: ImportProjectPackageInput
): Promise<{ project: Project; files: number }> {
  const entries = readZip(input.zipBuffer)
  const projectEntry = entries.find(e => e.path === 'project.json')
  if (!projectEntry) throw new Error('项目包缺少 project.json，无法导入')

  let parsed: Project
  try {
    parsed = JSON.parse(projectEntry.data.toString('utf8')) as Project
  } catch {
    throw new Error('项目包内 project.json 已损坏')
  }
  if (!parsed || typeof parsed.id !== 'string' || !Array.isArray(parsed.shots)) {
    throw new Error('项目包内 project.json 结构不合法')
  }

  const oldId = parsed.id
  const newId = await allocateProjectId(input.dataRoot)
  const project = rewriteProjectIdPaths(parsed, oldId, newId)
  project.id = newId
  project.title = uniqueProjectTitle(parsed.title || '', input.existingTitles)

  const targetDir = path.join(input.dataRoot, 'projects', newId)
  await fs.mkdir(targetDir, { recursive: true })

  try {
    const payload = entries.filter(e => e.path !== 'project.json')
    for (let i = 0; i < payload.length; i++) {
      const e = payload[i]
      const dest = path.join(targetDir, e.path)
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.writeFile(dest, e.data)
      const percent = Math.min(99, Math.round(((i + 1) / Math.max(1, payload.length)) * 100))
      input.onProgress?.({
        percent,
        message: `正在导入项目文件 ${i + 1}/${payload.length}（${percent}%）`
      })
      await new Promise(resolve => setImmediate(resolve))
    }
    await atomicWriteJson(path.join(targetDir, 'project.json'), project)
    input.onProgress?.({ percent: 100, message: '项目包导入完成' })
    return { project, files: payload.length }
  } catch (e) {
    await fs.rm(targetDir, { recursive: true, force: true }).catch(() => undefined)
    throw e
  }
}
