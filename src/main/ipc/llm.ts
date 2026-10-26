import { app } from 'electron'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { IpcChannels } from '../../shared/ipcTypes'
import { handleIpc } from './shared'
import { hasDialogSession, dialogSavedFiles } from './dialogSessions'
import type { LLMService } from '../core/llmService'
import type { FFmpegService } from '../core/ffmpegService'

export interface LlmIpcCtx {
  llmService: LLMService
  ffmpegService: FFmpegService
}

export function registerLlmIpc(ctx: LlmIpcCtx): void {
  // LLM
  handleIpc(IpcChannels.llmTest, () => ctx.llmService.test())
  handleIpc(IpcChannels.llmTranslate, (_, input: { scene: string; action: string; dialogue: string; genre: string }) =>
    ctx.llmService.translatePrompt(input)
  )
  handleIpc(IpcChannels.llmSplitScript, (_, script: string, genre: string) =>
    ctx.llmService.splitScript(script, genre)
  )
  handleIpc(IpcChannels.llmWriteScript, (_, idea: string, genre: string, title?: string) =>
    ctx.llmService.writeScript(idea, genre, title)
  )
  handleIpc(IpcChannels.llmReviewScript, (_, { script, genre, title }: { script: string; genre: string; title?: string }) =>
    ctx.llmService.reviewScript(script, genre, title)
  )
  // 有视频入口：抽帧 → 多模态 LLM 看图写短剧剧本
  handleIpc(IpcChannels.llmWriteScriptFromVideo, async (_, { videoPath, genre }: { videoPath: string; genre: string }) => {
    // S-01：视频抽帧→远程 LLM 属「导入源」路径，必须来自对话框会话（防渲染层失陷后任意文件读取+帧数据外发）
    if (!hasDialogSession(dialogSavedFiles, videoPath)) throw new Error('视频路径未通过文件选择会话校验，请重新选择视频')
    const tmpDir = join(app.getPath('temp'), 'drama-studio-frames', `vid_${Date.now()}`)
    try {
      const frames = await ctx.ffmpegService.extractFrames(videoPath, tmpDir, 6)
      return await ctx.llmService.writeScriptFromFrames(frames, genre)
    } finally {
      // R-01：临时帧目录用完即清，防磁盘累积
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
}
