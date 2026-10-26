import { createHash } from 'node:crypto'
import { IpcChannels } from '../../shared/ipcTypes'
import { handleIpc } from './shared'
import { hasDialogSession, dialogSavedFiles } from './dialogSessions'
import type { TTSService } from '../core/ttsService'

export interface TtsIpcCtx {
  ttsService: TTSService
}

export function registerTtsIpc(ctx: TtsIpcCtx): void {
  // TTS 音色试听：生成固定试听句，返回相对路径
  handleIpc(IpcChannels.ttsPreview, async (_, voice: string) => {
    // 音色名可能含任意字符（中文音色 strip 后为空串 → 所有音色共用同一文件互相覆盖），
    // 改用内容哈希命名（I-14）
    const hash = createHash('md5').update(voice).digest('hex').slice(0, 12)
    const relativePath = `tmp/tts_preview_${hash}.mp3`
    await ctx.ttsService.generate('你好，这是音色试听。', voice, relativePath)
    return relativePath
  })

  // TTS 语音克隆：参考音频样本 → 克隆文本语音（本机 Qwen3-TTS）
  handleIpc(IpcChannels.ttsClone, async (_, { text, refAudioPath, relativeOutput, refText, seed }: {
    text: string
    refAudioPath: string
    relativeOutput: string
    refText?: string
    seed?: number
  }) => {
    // S-02：音色克隆参考音频必须是对话框会话选中的导入源
    if (!hasDialogSession(dialogSavedFiles, refAudioPath)) throw new Error('参考音频路径未通过文件选择会话校验，请重新选择音频')
    await ctx.ttsService.generateClone(text, refAudioPath, relativeOutput, { refText, seed })
    return relativeOutput
  })
}
