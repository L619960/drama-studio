import { IpcChannels } from '../../shared/ipcTypes'
import { handleIpc } from './shared'
import { hasDialogSession, dialogSavedFiles } from './dialogSessions'
import type { WorkflowLoader } from '../core/workflowLoader'

export interface WorkflowIpcCtx {
  workflowLoader: WorkflowLoader
}

export function registerWorkflowIpc(ctx: WorkflowIpcCtx): void {
  // Workflow
  handleIpc(IpcChannels.workflowList, () => ctx.workflowLoader.list())
  handleIpc(IpcChannels.workflowMeta, (_, name: string) => ctx.workflowLoader.getMeta(name))
  handleIpc(IpcChannels.workflowImport, async (_, absolutePath: string) => {
    // 仅接受用户刚在文件对话框中选中的路径，防止渲染层伪造路径读取磁盘任意文件进应用目录
    if (!hasDialogSession(dialogSavedFiles, absolutePath)) {
      throw new Error('仅允许导入通过文件对话框选择的文件')
    }
    return ctx.workflowLoader.importWorkflow(absolutePath)
  })
  handleIpc(IpcChannels.workflowGetParams, (_, name: string) => ctx.workflowLoader.getEditableParams(name))
  handleIpc(IpcChannels.workflowUpdateParam, (_, name: string, nodeId: string, key: string, value: string | number | boolean) =>
    ctx.workflowLoader.updateParam(name, nodeId, key, value)
  )
}
