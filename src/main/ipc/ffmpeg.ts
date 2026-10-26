import { IpcChannels } from '../../shared/ipcTypes'
import { handleIpc, resolveInsideRoot } from './shared'
import { hasDialogSession, dialogSavedFiles } from './dialogSessions'
import type { FFmpegService } from '../core/ffmpegService'
import type { SettingsStore } from '../core/settingsStore'

export interface FfmpegIpcCtx {
  ffmpegService: FFmpegService
  settingsStore: SettingsStore
}

export function registerFfmpegIpc(ctx: FfmpegIpcCtx): void {
  // FFmpeg（入参/返回均为相对 DATA_ROOT 的相对路径）
  handleIpc(IpcChannels.ffmpegConcat, async (_, { segmentPaths, outputPath }: { segmentPaths: string[]; outputPath: string }) => {
    const fullSegments = segmentPaths.map(p => resolveInsideRoot(p))
    const fullOutputPath = resolveInsideRoot(outputPath)
    await ctx.ffmpegService.concatSegments(fullSegments, fullOutputPath)
    return outputPath
  })
  handleIpc(IpcChannels.ffmpegSmartConcat, async (_, { segments, outputPath }: { segments: Array<{ path: string; scene?: string; hasDialogue?: boolean; transition?: 'hard' | 'dissolve' | 'smash'; trimStart?: number; trimEnd?: number }>; outputPath: string }) => {
    const fullOutputPath = resolveInsideRoot(outputPath)
    await ctx.ffmpegService.smartConcatSegments(
      segments.map(s => ({ ...s, path: resolveInsideRoot(s.path) })),
      fullOutputPath
    )
    return outputPath
  })
  handleIpc(IpcChannels.ffmpegMerge, async (_, { videoPath, audioPath, outputPath }: { videoPath: string; audioPath: string; outputPath: string }) => {    const fullOutputPath = resolveInsideRoot(outputPath)
    await ctx.ffmpegService.mergeVideoAudio(resolveInsideRoot(videoPath), resolveInsideRoot(audioPath), fullOutputPath)
    return outputPath
  })
  handleIpc(IpcChannels.ffmpegExtractFrames, async (_, { videoPath, outDir, count }: { videoPath: string; outDir: string; count: number }) => {
    // S-01：外部视频抽帧属「导入源」，必须来自对话框会话（防渲染层失陷后任意文件读取+帧外发）
    if (!hasDialogSession(dialogSavedFiles, videoPath)) throw new Error('视频路径未通过文件选择会话校验，请重新选择视频')
    const fullOutDir = resolveInsideRoot(outDir)
    await ctx.ffmpegService.extractFrames(videoPath, fullOutDir, count)
    return fullOutDir
  })
  handleIpc(IpcChannels.ffmpegDuration, async (_, relativePath: string) => {
    return ctx.ffmpegService.getDuration(resolveInsideRoot(relativePath))
  })
  handleIpc(IpcChannels.ffmpegBurnSubtitles, async (_, { videoPath, srtPath, outputPath }: { videoPath: string; srtPath: string; outputPath: string }) => {
    const edit = (await ctx.settingsStore.get()).creation?.edit
    return ctx.ffmpegService.burnSubtitles(
      resolveInsideRoot(videoPath),
      resolveInsideRoot(srtPath),
      resolveInsideRoot(outputPath),
      { fontSize: edit?.subtitleFontSize, marginV: edit?.subtitleMarginV }
    )
  })
  handleIpc(IpcChannels.ffmpegMixBgm, async (_, { videoPath, bgmPath, outputPath, bgmVolume }: { videoPath: string; bgmPath: string; outputPath: string; bgmVolume: number }) => {
    return ctx.ffmpegService.mixBgm(resolveInsideRoot(videoPath), resolveInsideRoot(bgmPath), resolveInsideRoot(outputPath), bgmVolume)
  })
}
