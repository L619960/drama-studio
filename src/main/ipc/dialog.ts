import { dialog } from 'electron'
import { IpcChannels } from '../../shared/ipcTypes'
import { handleIpc, getMainWindow } from './shared'
import { registerDialogPath, dialogSavedFiles, dialogSelectedDirs } from './dialogSessions'

export function registerDialogIpc(): void {
  // Dialog
  handleIpc(IpcChannels.dialogSelectDirectory, async () => {
    const result = await dialog.showOpenDialog(getMainWindow()!, {
      properties: ['openDirectory']
    })
    const dir = result.canceled ? null : result.filePaths[0]
    if (dir) registerDialogPath(dialogSelectedDirs, dir)
    return dir
  })
  handleIpc(IpcChannels.dialogSelectFile, async () => {
    const result = await dialog.showOpenDialog(getMainWindow()!, {
      properties: ['openFile'],
      filters: [{ name: '工作流 JSON', extensions: ['json'] }]
    })
    const filePath = result.canceled ? null : result.filePaths[0]
    if (filePath) registerDialogPath(dialogSavedFiles, filePath)
    return filePath
  })
  handleIpc(IpcChannels.dialogSelectAudio, async () => {
    const result = await dialog.showOpenDialog(getMainWindow()!, {
      properties: ['openFile'],
      filters: [{ name: '音频', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] }]
    })
    const p = result.canceled ? null : result.filePaths[0]
    // S-02：音频导入源注册会话（TTS 克隆等消费方必须校验）
    if (p) registerDialogPath(dialogSavedFiles, p)
    return p
  })
  handleIpc(IpcChannels.dialogSelectVideo, async () => {
    const result = await dialog.showOpenDialog(getMainWindow()!, {
      properties: ['openFile'],
      filters: [{ name: '视频', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi'] }]
    })
    const p = result.canceled ? null : result.filePaths[0]
    // S-01：视频导入源注册会话（抽帧写剧本等消费方必须校验）
    if (p) registerDialogPath(dialogSavedFiles, p)
    return p
  })
  handleIpc(IpcChannels.dialogSaveFile, async (_, defaultName: string) => {
    const result = await dialog.showSaveDialog(getMainWindow()!, {
      defaultPath: defaultName,
      filters: [{ name: '视频', extensions: ['mp4'] }]
    })
    const filePath = result.canceled ? null : result.filePath
    if (filePath) registerDialogPath(dialogSavedFiles, filePath)
    return filePath
  })
}
