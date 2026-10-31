import { app, dialog } from 'electron'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { IpcChannels, type ArchiveProgressEvent } from '../../shared/ipcTypes'
import { handleIpc, getMainWindow, sendToWindow } from './shared'
import { exportProjectPackage, importProjectPackage } from '../core/projectArchive'
import type { ProjectStore } from '../core/projectStore'

export interface ProjectExportIpcCtx {
  projectStore: ProjectStore
  /** DATA_ROOT：项目目录与导入目标都以它为准 */
  dataRoot: string
}

const PROGRESS_MIN_INTERVAL = 150

function safeFileName(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名项目'
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10)
}

export function registerProjectExportIpc(ctx: ProjectExportIpcCtx): void {
  // REQ-20 ①：导出项目包（zip），落盘到用户选择位置
  handleIpc(
    IpcChannels.projectExportPackage,
    async (_, input: { projectId: string; includeDirectorState?: boolean }) => {
      const project = await ctx.projectStore.get(input.projectId)
      const defaultName = `${safeFileName(project.title)}-${stamp()}.dspzip`
      const picked = await dialog.showSaveDialog(getMainWindow()!, {
        title: '导出项目包',
        defaultPath: join(app.getPath('documents'), defaultName),
        filters: [{ name: '短剧工坊项目包', extensions: ['dspzip'] }],
      })
      if (picked.canceled || !picked.filePath) return null

      let lastSent = 0
      let lastAt = 0
      const emit = (percent: number, message: string): void => {
        const now = Date.now()
        if (percent < 100 && percent - lastSent < 5 && now - lastAt < PROGRESS_MIN_INTERVAL) return
        lastSent = percent
        lastAt = now
        const event: ArchiveProgressEvent = {
          projectId: project.id,
          direction: 'export',
          percent,
          message,
        }
        sendToWindow(IpcChannels.projectArchiveProgress, event)
      }

      await exportProjectPackage({
        projectDir: join(ctx.dataRoot, 'projects', project.id),
        targetPath: picked.filePath,
        includeDirectorState: Boolean(input.includeDirectorState),
        onProgress: (p) => emit(p.percent, p.message),
      })
      return picked.filePath
    },
  )

  // REQ-20 ②：导入项目包，冲突标题自动加「-副本」
  handleIpc(IpcChannels.projectImportPackage, async () => {
    const picked = await dialog.showOpenDialog(getMainWindow()!, {
      title: '导入项目包',
      properties: ['openFile'],
      filters: [{ name: '短剧工坊项目包', extensions: ['dspzip', 'zip'] }],
    })
    if (picked.canceled || picked.filePaths.length === 0) return null

    const zipPath = picked.filePaths[0]
    if (!zipPath) return null
    const zipBuffer = await fs.readFile(zipPath)
    const existingTitles = (await ctx.projectStore.list()).map((p) => p.title)

    let lastSent = 0
    let lastAt = 0
    const emit = (percent: number, message: string): void => {
      const now = Date.now()
      if (percent < 100 && percent - lastSent < 5 && now - lastAt < PROGRESS_MIN_INTERVAL) return
      lastSent = percent
      lastAt = now
      const event: ArchiveProgressEvent = {
        projectId: '',
        direction: 'import',
        percent,
        message,
      }
      sendToWindow(IpcChannels.projectArchiveProgress, event)
    }

    const { project } = await importProjectPackage({
      dataRoot: ctx.dataRoot,
      zipBuffer,
      existingTitles,
      onProgress: (p) => emit(p.percent, p.message),
    })
    return project
  })
}
