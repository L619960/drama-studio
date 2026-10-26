import { dialog } from 'electron'
import * as fs from 'node:fs/promises'
import { extname } from 'node:path'
import { IpcChannels, type Project } from '../../shared/ipcTypes'
import { handleIpc, resolveInsideRoot, getMainWindow } from './shared'
import type { ProjectStore } from '../core/projectStore'
import type { ConversationService } from '../core/conversationService'
import type { SubtitleService } from '../core/subtitleService'

export interface ProjectIpcCtx {
  projectStore: ProjectStore
  conversationService: ConversationService
  subtitleService: SubtitleService
}

export function registerProjectIpc(ctx: ProjectIpcCtx): void {
  // Project
  handleIpc(IpcChannels.projectList, () => ctx.projectStore.list())
  handleIpc(IpcChannels.projectCreate, (_, { title, genre }: { title: string; genre: string }) => ctx.projectStore.create(title, genre))
  handleIpc(IpcChannels.projectGet, (_, id: string) => ctx.projectStore.get(id))
  handleIpc(IpcChannels.projectSave, (_, project: Project) => ctx.projectStore.save(project))
  handleIpc(IpcChannels.projectDelete, async (_, id: string) => {
    await ctx.projectStore.delete(id)
    ctx.conversationService.forgetProject(id) // 清理主进程内存指针，防幽灵项目
  })
  handleIpc(IpcChannels.projectDuplicate, (_, id: string) => ctx.projectStore.duplicate(id))
  handleIpc(IpcChannels.projectImportBgm, (_, projectId: string) => ctx.projectStore.importBgm(projectId))

  // Character
  handleIpc(IpcChannels.characterImport, (_, projectId: string) => ctx.projectStore.importCharacterImage(projectId))

  // Shot（场景参考图导入）
  handleIpc(IpcChannels.shotImportSceneImage, async (_, projectId: string) => {
    // 项目存在性前置校验（I-12）：防止把图片写进伪造的 projects/<id>/ 目录
    await ctx.projectStore.get(projectId)
    const result = await dialog.showOpenDialog(getMainWindow()!, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    if (result.canceled || result.filePaths.length === 0) throw new Error('User cancelled')
    const sourcePath = result.filePaths[0]
    const ext = extname(sourcePath) || '.png'
    const relPath = `projects/${projectId}/scene_${Date.now()}${ext}`
    await fs.copyFile(sourcePath, resolveInsideRoot(relPath))
    return relPath
  })

  // 道具上传本地图片：选择文件并复制到项目 props 目录（与 AI 生成同路径，便于预览/渲染复用）
  handleIpc(IpcChannels.projectImportPropImage, async (_, input: { projectId: string; propId: string }) => {
    const project = await ctx.projectStore.get(input.projectId)
    if (!project.props?.some(p => p.id === input.propId)) throw new Error('道具不存在')
    const result = await dialog.showOpenDialog(getMainWindow()!, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    if (result.canceled || result.filePaths.length === 0) throw new Error('User cancelled')
    const sourcePath = result.filePaths[0]
    const ext = extname(sourcePath) || '.png'
    const relPath = `projects/${input.projectId}/props/${input.propId}${ext}`
    await fs.copyFile(sourcePath, resolveInsideRoot(relPath))
    return relPath
  })

  // Subtitle
  handleIpc(IpcChannels.subtitleGenerate, async (_, projectId: string) => {
    const project = await ctx.projectStore.get(projectId)
    return ctx.subtitleService.generate(project)
  })
}
