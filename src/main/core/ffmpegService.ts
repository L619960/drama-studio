import * as fs from 'fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffmpeg from 'fluent-ffmpeg'
import type { FfmpegCommand, FfprobeData } from 'fluent-ffmpeg'
import ffmpegBinary from 'ffmpeg-static'
import ffprobePackage from 'ffprobe-static'

const execFileAsync = promisify(execFile)

export interface SegmentProgress {
  (percent: number): void
}

export interface VideoInfo {
  durationSec: number
  width: number
  height: number
  hasAudio: boolean
}

export class FFmpegService {
  private ffmpegPath: string | null = null
  private ffprobePath: string | null = null
  private readyPromise: Promise<void>

  constructor() {
    this.readyPromise = this.detectBinaries()
  }

  /** 等待二进制检测完成 */
  ready(): Promise<void> {
    return this.readyPromise
  }

  private async detectBinaries(): Promise<void> {
    // 1) 应用打包内置的 ffmpeg-static / ffprobe-static
    const bundledFfmpeg = this.unpackedPath(ffmpegBinary || (ffmpegBinary as unknown as { default?: string })?.default)
    const bundledFfprobe = this.unpackedPath(ffprobePackage?.path)

    if (bundledFfmpeg && await this.canRun(bundledFfmpeg, ['-version'])) {
      this.ffmpegPath = bundledFfmpeg
      ffmpeg.setFfmpegPath(bundledFfmpeg)
    }
    if (bundledFfprobe && await this.canRun(bundledFfprobe, ['-version'])) {
      this.ffprobePath = bundledFfprobe
      ffmpeg.setFfprobePath(bundledFfprobe)
    }

    // 2) ComfyUI 整合包内置的 imageio-ffmpeg
    if (!this.ffmpegPath) {
      const imageio = await this.findImageioFfmpeg()
      if (imageio && await this.canRun(imageio, ['-version'])) {
        this.ffmpegPath = imageio
        ffmpeg.setFfmpegPath(imageio)
      }
    }

    // 3) 系统 PATH
    if (await this.canRun('ffmpeg', ['-version']) && !this.ffmpegPath) {
      this.ffmpegPath = 'ffmpeg'
    }
    if (await this.canRun('ffprobe', ['-version']) && !this.ffprobePath) {
      this.ffprobePath = 'ffprobe'
    }

    if (!this.ffmpegPath) {
      throw new Error('未找到 ffmpeg，音视频合成不可用')
    }
  }

  /** asar 内路径不可执行，映射到 app.asar.unpacked */
  private unpackedPath(p?: string | null): string | null {
    if (!p || typeof p !== 'string') return null
    return p.includes('app.asar') && !p.includes('app.asar.unpacked')
      ? p.replace('app.asar', 'app.asar.unpacked')
      : p
  }

  private async canRun(bin: string, args: string[]): Promise<boolean> {
    try {
      await execFileAsync(bin, args, { timeout: 10000, windowsHide: true })
      return true
    } catch (e) {
      const out = e as { stdout?: string; stderr?: string }
      return Boolean(out.stdout || out.stderr)
    }
  }

  /** 搜索常见 ComfyUI 目录下的 imageio_ffmpeg */
  private async findImageioFfmpeg(): Promise<string | null> {
    const roots = [
      process.env.COMFYUI_ROOT,
      'D:\\ComfyUI-V20',
      'D:\\ComfyUI',
      'C:\\ComfyUI',
      path.join(os.homedir(), 'ComfyUI')
    ].filter((v): v is string => Boolean(v))

    for (const root of roots) {
      const dir = path.join(root, 'python', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries')
      try {
        const files = await fs.readdir(dir)
        const hit = files.find((f) => /^ffmpeg.*\.exe$/i.test(f))
        if (hit) return path.join(dir, hit)
      } catch {
        // 继续尝试下一个候选目录
      }
    }
    return null
  }

  // ---------------------------------------------------------------- 时长探测
  async getDuration(filePath: string): Promise<number> {
    if (this.ffprobePath) {
      return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata: FfprobeData) => {
          if (err) reject(err)
          else resolve(Number(metadata.format?.duration) || 0)
        })
      })
    }

    return new Promise((resolve, reject) => {
      const nullTarget = process.platform === 'win32' ? 'NUL' : '/dev/null'
      ffmpeg()
        .input(filePath)
        .outputOptions('-f null')
        .on('end', () => resolve(0))
        .on('error', (err: Error) => {
          const m = err.message.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/)
          if (m) {
            resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]))
          } else {
            reject(err)
          }
        })
        .save(nullTarget)
    })
  }

  // ---------------------------------------------------------------- 分段制作
  /**
   * 制作统一规格分段（所有分镜都走这里，保证可被 concat -c copy）。
   * - 有音频：智能对齐（音频长则定格尾帧，视频长则补静音），台词永不截断
   * - leadSec>0 时把台词整体推迟开口（先入画再说话）；也可直接传已前置静音的音频并留 0
   * - 无音频：补一条静音 AAC 音轨
   */
  async prepareSegment(
    videoPath: string,
    audioPath: string | undefined,
    outputPath: string,
    onProgress?: SegmentProgress,
    leadSec = 0
  ): Promise<string> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    const tmpOut = outputPath + '.part.mp4'

    if (!audioPath) {
      return this.runSegmentWithSilence(videoPath, tmpOut, outputPath, onProgress)
    }

    const [videoDur, audioDur] = await Promise.all([
      this.getDuration(videoPath),
      this.getDuration(audioPath)
    ])
    const TOLERANCE = 0.3
    // 音频被延迟 leadSec 秒后，其实际结束时刻：
    const audioEnd = audioDur + leadSec
    const target = Math.max(videoDur, audioEnd)
    const pad2 = Math.max(0, audioEnd - videoDur) + TOLERANCE
    const delayFilter = leadSec > 0 ? `,adelay=${Math.round(leadSec * 1000)}:all=1` : ''

    return this.run(
      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .complexFilter([
          `[0:v]fps=25,tpad=stop_mode=clone:stop_duration=${pad2.toFixed(3)}[v]`,
          `[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${delayFilter},apad[a]`
        ])
        .outputOptions([
          '-map [v]',
          '-map [a]',
          '-t', target.toFixed(3),
          '-c:v libx264',
          '-crf 23',
          '-preset medium',
          '-pix_fmt yuv420p',
          '-c:a aac',
          '-b:a 192k',
          '-ar 48000',
          '-movflags +faststart'
        ])
        .on('progress', (p) => onProgress?.(this.clampPercent(p.percent))),
      tmpOut,
      outputPath
    )
  }

  /** 无台词镜头：视频 + anullsrc 静音轨 */
  private runSegmentWithSilence(
    videoPath: string,
    tmpOut: string,
    outputPath: string,
    onProgress?: SegmentProgress
  ): Promise<string> {
    return this.run(
      ffmpeg()
        .input(videoPath)
        .input('anullsrc=channel_layout=stereo:sample_rate=48000')
        .inputOptions('-f lavfi')
        .complexFilter(['[0:v]fps=25[v]'])
        .outputOptions([
          '-map [v]',
          '-map 1:a',
          '-c:v libx264',
          '-crf 23',
          '-preset medium',
          '-pix_fmt yuv420p',
          '-c:a aac',
          '-b:a 192k',
          '-ar 48000',
          '-shortest',
          '-movflags +faststart'
        ])
        .on('progress', (p) => onProgress?.(this.clampPercent(p.percent))),
      tmpOut,
      outputPath
    )
  }

  /** IPC 兼容：有音频的音画合并 */
  async mergeVideoAudio(videoPath: string, audioPath: string, outputPath: string): Promise<string> {
    return this.prepareSegment(videoPath, audioPath, outputPath)
  }

  // ---------------------------------------------------------------- H3 分段归一化
  /**
   * H3 原生音轨分段归一化：不重合音频（H3 已原生生成音轨），
   * 统一为 25fps/H264/AAC48k 立体声，与 Wan 分段同规格，可直接 concat 混排。
   */
  async normalizeSegment(videoPath: string, outputPath: string, onProgress?: SegmentProgress): Promise<string> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    const tmpOut = outputPath + '.part.mp4'
    return this.run(
      ffmpeg()
        .input(videoPath)
        .outputOptions([
          '-vf fps=25',
          '-c:v libx264',
          '-crf 23',
          '-preset medium',
          '-pix_fmt yuv420p',
          '-c:a aac',
          '-b:a 192k',
          '-ar 48000',
          '-ac 2',
          '-movflags +faststart'
        ])
        .on('progress', (p) => onProgress?.(this.clampPercent(p.percent))),
      tmpOut,
      outputPath
    )
  }

  /**
   * 音频前置留白：在语音开头补 leadSec 秒静音，输出到同格式 mp3。
   * 用于「先入画再开口」，且 LatentSync 与最终合轨必须共用同一条延迟后的音频，
   * 否则口型按未延迟音频驱动、合轨再延迟会产生音画错位。
   */
  async padAudioLead(srcPath: string, destPath: string, leadSec: number): Promise<string> {
    await fs.mkdir(path.dirname(destPath), { recursive: true })
    const tmpOut = destPath + '.part.mp3'
    return this.run(
      ffmpeg()
        .input(srcPath)
        .audioFilter(`adelay=${Math.round(leadSec * 1000)}:all=1`)
        .outputOptions([
          '-c:a', 'libmp3lame',
          '-q:a', '2'
        ]),
      tmpOut,
      destPath
    )
  }

  /**
   * LatentSync 预处理：把渲染原片统一转成 25fps 无音轨视频。
   * LatentSync 输出帧数=输入帧数且按 25fps 写出（wan 原片为 16fps，
   * 不转帧率会导致输出变短、语音超出画面）。音轨由外部 TTS 重新合入。
   */
  async convertForLipSync(videoPath: string, outputPath: string): Promise<string> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    const tmpOut = outputPath + '.part.mp4'
    return this.run(
      ffmpeg()
        .input(videoPath)
        .complexFilter(['[0:v]fps=25,format=yuv420p[v]'])
        .outputOptions([
          '-map [v]',
          '-an',
          '-c:v libx264',
          '-crf 20',
          '-preset medium',
          '-movflags +faststart'
        ]),
      tmpOut,
      outputPath
    )
  }

  // ---------------------------------------------------------------- 拼接
  /**
   * 拼接分段：优先 concat demuxer 流拷贝（快、无损）；
   * 因规格/时间基不兼容失败时，自动回退到 concat filter 重编码。
   */
  async concatSegments(segmentPaths: string[], outputPath: string): Promise<string> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    const tmpOut = outputPath + '.part.mp4'
    const listPath = path.join(os.tmpdir(), `concat_${Date.now()}.txt`)
    const listContent = segmentPaths
      .map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
      .join('\n')
    await fs.writeFile(listPath, listContent, 'utf-8')

    try {
      return await this.run(
        ffmpeg()
          .input(listPath)
          .inputOptions(['-f concat', '-safe 0'])
          .outputOptions(['-c copy', '-movflags +faststart', '-fflags +genpts']),
        tmpOut,
        outputPath
      )
    } catch {
      // 回退：concat filter 重编码
      const n = segmentPaths.length
      const labels = segmentPaths.map((_, i) => `[${i}:v][${i}:a]`).join('')
      const cmd = ffmpeg()
      for (const p of segmentPaths) cmd.input(p)
      return this.run(
        cmd
          .complexFilter([`${labels}concat=n=${n}:v=1:a=1[v][a]`])
          .outputOptions([
            '-map [v]',
            '-map [a]',
            '-c:v libx264',
            '-crf 23',
            '-pix_fmt yuv420p',
            '-c:a aac',
            '-b:a 192k',
            '-ar 48000',
            '-movflags +faststart'
          ]),
        tmpOut,
        outputPath
      )
    } finally {
      await fs.unlink(listPath).catch(() => undefined)
    }
  }

  // ---------------------------------------------------------------- 片段截取（预告片快剪）
  /** 截取视频片段：重编码保证帧精确，输出参数与正片一致，便于后续 concat */
  async trimClip(inputPath: string, startSec: number, durationSec: number, outputPath: string): Promise<string> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    const tmpOut = outputPath + '.part.mp4'
    return this.run(
      ffmpeg()
        .input(inputPath)
        .inputOptions([`-ss ${Math.max(0, startSec).toFixed(2)}`])
        .outputOptions([
          `-t ${Math.max(0.1, durationSec).toFixed(2)}`,
          '-c:v libx264',
          '-preset veryfast',
          '-crf 20',
          '-pix_fmt yuv420p',
          '-c:a aac',
          '-b:a 192k',
          '-ar 48000',
          '-movflags +faststart'
        ]),
      tmpOut,
      outputPath
    )
  }

  // ---------------------------------------------------------------- 字幕烧录 / BGM 混音
  /**
   * 字幕烧录：把 SRT 硬字幕烧进视频（重编码视频轨，音频流拷贝）。
   * subtitles 滤镜的 Windows 路径需转义：\ → /，盘符冒号 → \:，单引号 → \'
   */
  async burnSubtitles(videoPath: string, srtPath: string, outputPath: string): Promise<string> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    const tmpOut = outputPath + '.part.mp4'
    const escaped = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
    return this.run(
      ffmpeg()
        .input(videoPath)
        .outputOptions([
          `-vf subtitles='${escaped}':force_style='FontSize=14,Outline=1,Shadow=0,MarginV=18'`,
          '-c:v libx264',
          '-crf 23',
          '-preset medium',
          '-pix_fmt yuv420p',
          '-c:a copy',
          '-movflags +faststart'
        ]),
      tmpOut,
      outputPath
    )
  }

  /**
   * BGM 混音：BGM 循环铺满视频长度并降低音量，与原音轨 amix 混合。
   * @param bgmVolume 0-100（100 = 与原声同响度）
   */
  async mixBgm(
    videoPath: string,
    bgmPath: string,
    outputPath: string,
    bgmVolume: number
  ): Promise<string> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    const tmpOut = outputPath + '.part.mp4'
    const vol = Math.max(0, Math.min(100, bgmVolume)) / 100
    return this.run(
      ffmpeg()
        .input(videoPath)
        .input(bgmPath)
        .inputOptions(['-stream_loop -1'])
        .complexFilter([
          `[1:a]volume=${vol.toFixed(2)}[bgm]`,
          '[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=2[a]'
        ])
        .outputOptions([
          '-map 0:v',
          '-map [a]',
          '-c:v copy',
          '-c:a aac',
          '-b:a 192k',
          '-ar 48000',
          '-movflags +faststart'
        ]),
      tmpOut,
      outputPath
    )
  }

  // ---------------------------------------------------------------- 缩略图
  /** 提取视频第一帧为 JPG 缩略图，用于项目列表页展示 */
  async extractFirstFrame(videoPath: string, outputPath: string): Promise<void> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await new Promise<void>((resolve, reject) => {
      ffmpeg(videoPath)
        .frames(1)
        .outputOptions(['-q:v 5', '-vf scale=320:-1'])
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .save(outputPath)
    })
  }

  /**
   * 抽帧并解码为 size×size RGB24 裸数据（输出字节固定 size*size*3，
   * 供 transformers.js 直接构造 RawImage，绕过 sharp 原生依赖）。
   * 等比缩放 + 居中黑边 letterbox（不拉伸变形）——人脸检测对变形敏感，
   * 且参考图(2:3)与视频帧(9:16)宽高比不同，letterbox 保证两侧人脸几何一致。
   */
  async dumpRgb24(
    inputPath: string,
    outputPath: string,
    size = 224,
    timeSec?: number
  ): Promise<void> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    const vf = `scale=${size}:${size}:force_original_aspect_ratio=decrease,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=black`
    await new Promise<void>((resolve, reject) => {
      const cmd = ffmpeg(inputPath)
      if (timeSec !== undefined) cmd.seekInput(Math.max(0, timeSec))
      cmd
        .frames(1)
        .outputOptions(['-pix_fmt', 'rgb24', '-f', 'rawvideo', '-vf', vf])
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .save(outputPath)
    })
  }

  // ---------------------------------------------------------------- 工具
  async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  }

  async getFileSize(filePath: string): Promise<number> {
    try {
      const stats = await fs.stat(filePath)
      return Math.round((stats.size / 1024 / 1024) * 100) / 100
    } catch {
      return 0
    }
  }

  // ---------------------------------------------------------------- 质检
  /** 视频技术信息：时长/分辨率/是否有音轨，用于逐镜审批与成片复审 */
  async getVideoInfo(filePath: string): Promise<VideoInfo> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata: FfprobeData) => {
        if (err) {
          reject(err)
          return
        }
        const v = metadata.streams?.find((s) => s.codec_type === 'video')
        const a = metadata.streams?.find((s) => s.codec_type === 'audio')
        resolve({
          durationSec: Number(metadata.format?.duration) || 0,
          width: Number(v?.width) || 0,
          height: Number(v?.height) || 0,
          hasAudio: Boolean(a)
        })
      })
    })
  }

  /**
   * 疑似黑帧/纯色帧检测：抽取中点帧存 PNG，文件极小说明画面无细节。
   * 阈值 8KB（320 宽正常帧通常 >15KB，纯色/全黑帧 <3KB）。
   */
  async looksLikeBlankVideo(videoPath: string): Promise<boolean> {
    const tmp = path.join(os.tmpdir(), `qc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`)
    try {
      await new Promise<void>((resolve, reject) => {
        ffmpeg(videoPath)
          .frames(1)
          .outputOptions(['-q:v 5', '-vf scale=320:-1'])
          .seekInput(0.5)
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .save(tmp)
      })
      const stat = await fs.stat(tmp)
      return stat.size < 8 * 1024
    } catch {
      return false
    } finally {
      await fs.unlink(tmp).catch(() => undefined)
    }
  }

  private clampPercent(p?: number | null): number {
    return Math.min(100, Math.max(0, Math.round(p || 0)))
  }

  /**
   * 统一执行：输出到临时文件 → 成功后原子替换；
   * 采集 stderr，失败时附带末尾日志，便于定位。
   */
  private run(command: FfmpegCommand, tmpOut: string, finalOut: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const stderrChunks: string[] = []
      command
        .on('stderr', (line: string) => {
          stderrChunks.push(line)
          if (stderrChunks.length > 200) stderrChunks.shift()
        })
        .on('end', async () => {
          try {
            await fs.unlink(finalOut).catch(() => undefined)
            await fs.rename(tmpOut, finalOut)
            resolve(finalOut)
          } catch (e) {
            reject(new Error(`写入最终文件失败: ${(e as Error).message}`))
          }
        })
        .on('error', (err: Error) => {
          const tail = stderrChunks.slice(-12).join('\n')
          reject(new Error(`${err.message}${tail ? `\n--- ffmpeg 日志 ---\n${tail}` : ''}`))
        })
        .save(tmpOut)
    })
  }
}
