import { dialog } from 'electron'
import * as fs from 'node:fs/promises'
import { IpcChannels } from '../../shared/ipcTypes'
import { handleIpc, assertScope, getMainWindow } from './shared'
import type { ConversationService } from '../core/conversationService'

export interface ConversationIpcCtx {
  conversationService: ConversationService
}

export function registerConversationIpc(ctx: ConversationIpcCtx): void {
  // 导演对话（scope 经白名单校验后才进服务层，I-13）
  handleIpc(IpcChannels.conversationList, (_, scope: string) => {
    assertScope(scope)
    return ctx.conversationService.list(scope)
  })
  handleIpc(IpcChannels.conversationSend, (_, scope: string, text: string) => {
    assertScope(scope)
    return ctx.conversationService.send(scope, text)
  })
  handleIpc(IpcChannels.conversationClear, (_, scope: string) => {
    assertScope(scope)
    return ctx.conversationService.clear(scope)
  })
  handleIpc(IpcChannels.conversationSending, (_, scope: string) => ctx.conversationService.isSending(scope))

  handleIpc(IpcChannels.conversationStop, (_, scope: string) => {
    assertScope(scope)
    return ctx.conversationService.stop(scope)
  })
  handleIpc(IpcChannels.conversationRollback, (_, scope: string, messageId: string) => {
    assertScope(scope)
    return ctx.conversationService.rollback(scope, messageId)
  })
  // 对话上传：选择常见文本文件读取内容（超长截断），由渲染层拼进消息发送
  handleIpc(IpcChannels.conversationUpload, async (): Promise<{ name: string; content: string; truncated: boolean } | null> => {
    const result = await dialog.showOpenDialog(getMainWindow()!, {
      properties: ['openFile'],
      filters: [
        { name: '文档与数据', extensions: ['txt', 'md', 'json', 'csv', 'srt', 'vtt', 'log', 'yaml', 'yml', 'xml', 'html', 'js', 'ts', 'py', 'css'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    const stat = await fs.stat(filePath).catch(() => null)
    if (!stat) throw new Error('文件无法读取')
    if (stat.size > 2 * 1024 * 1024) throw new Error('文件超过 2MB，请拆分后再上传')
    const raw = await fs.readFile(filePath, 'utf-8')
    // 二进制嗅探（I-9）：文本解码后残留 NUL 说明是改了扩展名的二进制文件，拒绝注入对话
    if (raw.includes('\0')) throw new Error('检测到二进制文件，仅支持文本内容')
    const MAX_CHARS = 60000
    return {
      name: filePath.split(/[\\/]/).pop() || 'file',
      content: raw.length > MAX_CHARS ? raw.slice(0, MAX_CHARS) : raw,
      truncated: raw.length > MAX_CHARS
    }
  })
}
