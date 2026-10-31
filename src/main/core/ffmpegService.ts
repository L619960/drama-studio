import * as fs from 'fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import ffmpeg from 'fluent-ffmpeg'
import type { FfmpegCommand, FfprobeData } from 'fluent-ffmpeg'
import ffmpegBinary from 'ffmpeg-static'
import ffprobePackage from 'ffprobe-static'
import { childProcessManager } from './childProcessManager'

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
      await childProcessManager.execFile(bin, args, { timeout: 10000, windowsHide: true, label: 'ffmpeg-canrun' })
      return true
    } catch (e) {
      const out = e as { stdout?: string; stderr?: string }
      return Boolean(out.stdout || out.stderr)
    }
  }

  private extraComfyRoots: string[] = []

  /** 设置里的 Comfy 安装根，用于查找内置 ffmpeg。 */
  addComfyRoot(root: string): void {
    const trimmed = root.trim()
    if (!trimmed || this.extraComfyRoots.includes(trimmed)) return
    this.extraComfyRoots.unshift(trimmed)
  }

  /** 搜索常见 ComfyUI 目录下的 imageio_ffmpeg */
  private async findImageioFfmpeg(): Promise<string | null> {
    const roots = [
      ...this.extraComfyRoots,
      process.env.COMFYUI_ROOT,
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

  // ---------------------------------------------------------------- 全景方位图
  /**
   * 把 2:1 全景场景图水平均分成 N 张竖版方位图（青橙Lab「全景固定场景」方案）。
   * - 每段宽度 = 全景宽 / N（90° 视角当 N=4），scale 到 (outW×outH) 竖构图
   * - 返回生成的输出文件绝对路径数组（顺序=前视 0° 起逆时针）
   */
  async cropPanoramaViews(
    panoAbs: string,
    outDir: string,
    opts: { count: number; outW: number; outH: number; prefix?: string }
  ): Promise<string[]> {
    const count = Math.max(2, Math.min(6, Math.floor(opts.count) || 4))
    const outW = Math.max(64, Math.floor(opts.outW))
    const outH = Math.max(64, Math.floor(opts.outH))
    // 必须按场景板加前缀：多个场景板共用 pano_view_${i}.png 时，后生成的会覆盖先前，
    // 全部镜头都指向最后一张全景的裁图（实测 5 个场景全变成同一间房）。
    const prefix = (opts.prefix || 'pano').replace(/[^\w-]/g, '')
    const outPaths: string[] = []
    for (let i = 0; i < count; i++) {
      const out = path.join(outDir, `${prefix}_view_${i}.png`)
      await this.runFfmpeg([
        '-y', '-i', panoAbs,
        '-vf',
        `crop=iw/${count}:iw/${count}*${outH}/${outW}:iw*${i}/${count}:0,scale=${outW}:${outH}:flags=lanczos`,
        out
      ])
      outPaths.push(out)
    }
    return outPaths
  }

  /** 执行单条 ffmpeg 命令（等待完成）；10 分钟硬超时防进程挂死（任务 9b） */
  private async runFfmpeg(args: string[]): Promise<void> {
    const bin = this.ffmpegPath || 'ffmpeg'
    await childProcessManager.execFile(bin, args, { timeout: 600_000, windowsHide: true, label: 'ffmpeg-run' })
  }

  /**
   * 视频拆解：均匀抽 N 帧关键帧（封面/中段/结尾覆盖），供多模态 LLM 看图写剧本。
   * 返回实际抽帧的绝对路径数组。
   */
  async extractFrames(inputPath: string, outDir: string, count: number): Promise<string[]> {
    const n = Math.max(2, Math.min(12, Math.floor(count) || 6))
    await fs.mkdir(outDir, { recursive: true })
    const probeArgs = ['-hide_banner', '-i', inputPath]
    let duration = 0
    try {
      const { stdout } = await childProcessManager.execFile(
        this.ffmpegPath || 'ffmpeg',
        [...probeArgs, '-f', 'null', '-'],
        { windowsHide: true, label: 'ffmpeg-probe' }
      )
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stdout)
      if (m) duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
    } catch {
      // 探测失败则按 10 秒估算，抽帧仍可继续
      duration = 10
    }
    const out = path.join(outDir, `frame_%02d.jpg`)
    // 均匀采样：用 fps=1/duration*n 保证全片铺开，避免只在片头取样
    const interval = Math.max(0.5, duration / n)
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', inputPath,
      '-vf', `fps=1/${interval.toFixed(3)},scale=-2:480`,
      '-frames:v', String(n),
      '-q:v', '4',
      '-y', out
    ]
    await this.runFfmpeg(args)
    const files = (await fs.readdir(outDir)).filter(f => /^frame_\d+\.jpg$/.test(f)).sort()
    return files.map(f => path.join(outDir, f)).slice(0, n)
  }

  /**
   * 抽取指定时间点的单帧（人物一致性 R2V 锚点 / 预览用），输出 jpg。
   * 用于"参考驱动镜"以视频第 0 帧为身份锚：定妆大头照 vs 特写帧存在光照/表情/
   * 景别系统性差异，会压低 ArcFace 分数造成误标（lowConsistency 剔除）。
   */
  async extractFrameAt(inputPath: string, outAbs: string, timeSec: number): Promise<void> {
    await fs.mkdir(path.dirname(outAbs), { recursive: true })
    const t = Math.max(0.02, Number(timeSec) || 0.06)
    await this.runFfmpeg([
      '-hide_banner', '-loglevel', 'error',
      '-ss', t.toFixed(3),
      '-i', inputPath,
      '-frames:v', '1',
      '-q:v', '3',
      '-y', outAbs
    ])
  }

  /**
   * 宫格拼图（导演台看板）：把 N 张图按 cols 列拼成宫格。
   * 例：4 张方位图 → 2×2 宫格方位图（青橙Lab「宫格方位图」本地落地）。
   */
  async tileImages(
    images: string[],
    outPath: string,
    opts: { cols: number; cellW: number; cellH: number }
  ): Promise<void> {
    if (!images.length) throw new Error('tileImages: 无输入图片')
    const cols = Math.max(1, Math.floor(opts.cols))
    const cellW = Math.max(32, Math.floor(opts.cellW))
    const cellH = Math.max(32, Math.floor(opts.cellH))

    // [i:v]scale=W:H[a_i]; … ; [a0][a1]...[aN-1]xstack=inputs=N:layout=c0*W_r0*H|c1*W_r1*H|…[out]
    const parts: string[] = []
    const labels: string[] = []
    for (let i = 0; i < images.length; i++) {
      parts.push(`[${i}:v]scale=${cellW}:${cellH}:flags=lanczos[a${i}]`)
      labels.push(`a${i}`)
    }
    const layout = images
      .map((_, i) => `${(i % cols) * cellW}_${Math.floor(i / cols) * cellH}`)
      .join('|')
    const outLabel = `[${labels.join('][')}]xstack=inputs=${images.length}:layout=${layout}[out]`
    await this.runFfmpeg([
      '-y', ...images.flatMap(p => ['-i', p]),
      '-filter_complex', [...parts, outLabel].join(';'),
      '-map', '[out]',
      outPath
    ])
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
  /** 居中裁成目标画幅再缩放，不拉伸。I2V 的参考图必须和视频同一比例。 */
  async fitCover(src: string, dest: string, width: number, height: number): Promise<string> {
    await fs.mkdir(path.dirname(dest), { recursive: true })
    const tmpOut = dest + '.part.png'
    await this.runFfmpeg([
      '-y', '-i', src,
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
      '-frames:v', '1',
      tmpOut
    ])
    await fs.rename(tmpOut, dest)
    return dest
  }

  private async videoSize(filePath: string): Promise<{ width: number; height: number } | null> {
    if (!this.ffprobePath) return null
    return new Promise((resolve) => {
      ffmpeg.ffprobe(filePath, (err, metadata: FfprobeData) => {
        if (err) { resolve(null); return }
        const v = (metadata.streams || []).find(s => s.codec_type === 'video')
        const width = Number(v?.width) || 0
        const height = Number(v?.height) || 0
        resolve(width > 0 && height > 0 ? { width, height } : null)
      })
    })
  }

  /** 成片拼接前把各镜收成同一画幅。比例不同时居中裁切，不按第一镜拉伸。 */
  private async unifySegmentSizes(segmentPaths: string[], tmpDir: string): Promise<string[]> {
    const sizes = await Promise.all(segmentPaths.map(p => this.videoSize(p)))
    const known = sizes.filter((s): s is { width: number; height: number } => Boolean(s))
    if (known.length < 2) return segmentPaths
    const counts = new Map<string, { width: number; height: number; n: number }>()
    for (const s of known) {
      const key = `${s.width}x${s.height}`
      const cur = counts.get(key)
      if (cur) cur.n += 1
      else counts.set(key, { ...s, n: 1 })
    }
    const target = [...counts.values()].sort((a, b) => b.n - a.n || b.height - a.height)[0]
    if (!target || counts.size < 2) return segmentPaths
    const out: string[] = []
    for (let i = 0; i < segmentPaths.length; i++) {
      const s = sizes[i]
      if (s && s.width === target.width && s.height === target.height) {
        out.push(segmentPaths[i])
        continue
      }
      const fitted = path.join(tmpDir, `unify_${i}.mp4`)
      await this.runFfmpeg([
        '-y', '-i', segmentPaths[i],
        '-vf', `scale=${target.width}:${target.height}:force_original_aspect_ratio=increase,crop=${target.width}:${target.height},setsar=1`,
        '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
        fitted
      ])
      out.push(fitted)
    }
    return out
  }

  async concatSegments(segmentPaths: string[], outputPath: string): Promise<string> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    const unifyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'concatfit_'))
    const fittedPaths = await this.unifySegmentSizes(segmentPaths, unifyDir)
    const tmpOut = outputPath + '.part.mp4'
    const listPath = path.join(os.tmpdir(), `concat_${Date.now()}.txt`)
    const listContent = fittedPaths
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
      // 回退：concat filter 重编码。
      // 用独立的临时文件：上一条命令失败时其 error 处理器会异步 unlink tmpOut，
      // 若两条命令复用同一个 tmp 路径，Linux 上清理可能晚于重编码写盘，把新文件删掉导致 rename ENOENT。
      const n = fittedPaths.length
      const labels = fittedPaths.map((_, i) => `[${i}:v][${i}:a]`).join('')
      const cmd = ffmpeg()
      for (const p of fittedPaths) cmd.input(p)
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
        outputPath + '.reencode.part.mp4',
        outputPath
      )
    } finally {
      await fs.unlink(listPath).catch(() => undefined)
      await fs.rm(unifyDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  // ---------------------------------------------------------------- 智能拼接（专业剪辑）
  /**
   * 智能拼接成片（替代硬接 concat）：
   * 1) 每镜音频驱动裁剪——有台词：保语音+前后余韵，裁掉片头 lead 残影与尾部静默；
   *    无台词：裁片头 0.2s（残影区）+ 尾部 0.3s（静默）。
   * 2) 默认全部硬切（流拷贝分块，保持节奏）；仅分镜显式 transition='dissolve' 的边界
   *    执行 0.3s 交叉叠化（xfade），hard/smash/未指定均不叠化。
   */
  async smartConcatSegments(
    segments: Array<{ path: string; scene?: string; hasDialogue?: boolean; transition?: 'hard' | 'dissolve' | 'smash'; trimStart?: number; trimEnd?: number; skipped?: boolean }>,
    outputPath: string
  ): Promise<string> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartconcat_'))

    try {
      // 1) 逐镜裁剪（剪辑台标记 skipped 的镜直接跳过，不进成片）
      const trimmed: Array<{ path: string; scene?: string; transition?: 'hard' | 'dissolve' | 'smash' }> = []
      for (const seg of segments) {
        if (seg.skipped) continue
        const cut = await this.trimShotSmart(seg.path, seg.hasDialogue ?? false, tmpDir, { trimStart: seg.trimStart, trimEnd: seg.trimEnd })
        if (cut) trimmed.push({ path: cut, scene: seg.scene, transition: seg.transition })
      }
      if (trimmed.length === 0) throw new Error('智能拼接：全部镜头裁剪失败，无可拼接素材')
      const unified = await this.unifySegmentSizes(trimmed.map(t => t.path), tmpDir)
      trimmed.forEach((t, i) => { t.path = unified[i] })

      // 2) 叠化边界：仅分镜显式 transition=dissolve 才交叉叠化；hard/smash/未指定一律硬切。
      //    旧规则「未指定且场景不同就自动叠化」在画面/运镜/光色差异大的镜头间会产生
      //    双场景半透明鬼影（实测雨夜街巷→便利店门口 0.3s 叠化=转场漂移），转场决定权
      //    必须归分镜 transition 字段，合成端不自行猜测。
      const fadeAt = (i: number): boolean => {
        return trimmed[i].transition === 'dissolve'
      }
      const blocks: Array<{ path: string }> = []
      let group: string[] = []
      const flush = async (): Promise<void> => {
        if (!group.length) return
        if (group.length === 1) {
          blocks.push({ path: group[0] })
        } else {
          const blockPath = path.join(tmpDir, `block_${blocks.length}.mp4`)
          await this.concatSegments(group, blockPath)
          blocks.push({ path: blockPath })
        }
        group = []
      }
      for (let i = 0; i < trimmed.length; i++) {
        if (i > 0 && fadeAt(i)) await flush()
        group.push(trimmed[i].path)
      }
      await flush()

      // 3) 块间叠化（xfade + acrossfade），单块直接拷贝
      if (blocks.length === 1) {
        await this.concatSegments([blocks[0].path], outputPath)
        return outputPath
      }

      const inputs = blocks.map(b => b.path)
      const durs: number[] = []
      for (const b of blocks) durs.push(await this.getDuration(b.path))
      const xfadeDur = 0.3
      const vParts: string[] = []
      const aParts: string[] = []
      let acc = 0
      for (let i = 0; i < blocks.length - 1; i++) {
        acc += durs[i]
        const offset = acc - xfadeDur * (i + 1)
        const vi = i === 0 ? '[0:v][1:v]' : `[v${i}][${i + 1}:v]`
        const ai = i === 0 ? '[0:a][1:a]' : `[a${i}][${i + 1}:a]`
        vParts.push(`${vi}xfade=transition=fade:duration=${xfadeDur}:offset=${offset.toFixed(3)}[v${i + 1}]`)
        aParts.push(`${ai}acrossfade=d=${xfadeDur}[a${i + 1}]`)
      }
      const finalV = `[v${blocks.length - 1}]`
      const finalA = `[a${blocks.length - 1}]`
      await this.runFfmpeg([
        '-y',
        ...inputs.flatMap(p => ['-i', p]),
        '-filter_complex', [...vParts, ...aParts].join(';'),
        '-map', finalV,
        '-map', finalA,
        '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
        '-movflags', '+faststart',
        outputPath
      ])
      return outputPath
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * 单镜智能裁剪：silencedetect 定位语音区间。
   * 有台词：保留 [voiceStart-0.25, voiceEnd+0.35]（至少 2.2s）；
   * 无台词：裁片头 0.2s + 尾部 0.3s（至少 2.5s）。
   * 返回裁剪后临时文件路径；检测失败时原样返回 null（调用方跳过该镜裁剪）。
   */
  private async trimShotSmart(
    inputPath: string,
    hasDialogue: boolean,
    tmpDir: string,
    opts: { trimStart?: number; trimEnd?: number } = {}
  ): Promise<string | null> {
    try {
      const dur = await this.getDuration(inputPath)
      const minKeep = hasDialogue ? 2.2 : 2.5
      // 手动裁剪覆盖（剪辑台入点/出点）：直接按给定区间裁，不做自动检测
      if (opts.trimStart !== undefined || opts.trimEnd !== undefined) {
        let start = opts.trimStart !== undefined ? Math.max(0, opts.trimStart) : 0
        let end = opts.trimEnd !== undefined ? Math.min(dur, opts.trimEnd) : dur
        if (end - start < 1) {
          // 手动区间非法：回退整镜
          start = 0
          end = dur
        }
        const out = path.join(tmpDir, `shot_${path.basename(inputPath)}`)
        await this.trimClip(inputPath, start, end - start, out)
        return out
      }
      let start = 0
      let end = dur

      if (hasDialogue) {
        const v = await this.detectVoiceRange(inputPath)
        if (v) {
          start = Math.max(0, v.start - 0.25)
          end = Math.min(dur, v.end + 0.35)
        }
      } else {
        start = 0.2
        end = Math.max(minKeep, dur - 0.3)
      }
      if (end - start < minKeep) {
        // 语音太短/检测异常：保底中段，避免把台词切没
        const center = (start + end) / 2
        start = Math.max(0, center - minKeep / 2)
        end = Math.min(dur, start + minKeep)
      }
      const out = path.join(tmpDir, `shot_${path.basename(inputPath)}`)
      await this.trimClip(inputPath, start, end - start, out)
      return out
    } catch {
      return null
    }
  }

  /** silencedetect：返回首个语音起点与最后语音终点（秒）；检测失败返回 null */
  private async detectVoiceRange(inputPath: string): Promise<{ start: number; end: number } | null> {
    const bin = this.ffmpegPath || 'ffmpeg'
    try {
      const { stdout } = await childProcessManager.execFile(bin, [
        '-i', inputPath,
        '-af', 'silencedetect=n=-35dB:d=0.3',
        '-f', 'null', '-'
      ], { windowsHide: true, label: 'ffmpeg-silencedetect' })
      const out = stdout + ''
      const silenceStarts = [...out.matchAll(/silence_start:\s*([\d.]+)/g)].map(m => parseFloat(m[1]))
      const silenceEnds = [...out.matchAll(/silence_end:\s*([\d.]+)/g)].map(m => parseFloat(m[1]))
      if (!silenceEnds.length && !silenceStarts.length) return null
      const dur = await this.getDuration(inputPath)
      // 语音起点 = 第一段静音结束（片头 lead 结束处）；若无开篇静音则从 0 开始
      const start = silenceEnds.length && silenceEnds[0] < dur / 2 ? silenceEnds[0] : 0
      // 语音终点 = 最后一段静音起点（尾部 tail 开始处）；若无结尾静音则到片尾
      const lastSilenceStart = silenceStarts.length ? silenceStarts[silenceStarts.length - 1] : -1
      const end = lastSilenceStart > dur / 2 ? lastSilenceStart : dur
      if (end <= start + 0.3) return null
      return { start, end }
    } catch {
      return null
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
  async burnSubtitles(
    videoPath: string,
    srtPath: string,
    outputPath: string,
    style?: { fontSize?: number; marginV?: number }
  ): Promise<string> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    const tmpOut = outputPath + '.part.mp4'
    // 分辨率决定字幕画布：直接烧 SRT 时 libass 按默认 384x288 布局，
    // 竖屏成片（480x864）会按高度等比放大文字，横向超出画面被裁掉。
    // 因此先把 SRT 转成 PlayRes=视频实际尺寸的 ASS（含左右边距 + 自动换行）。
    let vw = 0
    let vh = 0
    try {
      const info = await this.getVideoInfo(videoPath)
      vw = info.width
      vh = info.height
    } catch {
      // 探测失败用竖屏默认值
    }
    if (!vw || !vh) {
      vw = 480
      vh = 864
    }
    const baseFont = Math.max(10, Math.min(48, Math.round(style?.fontSize ?? 14)))
    const baseMarginV = Math.max(0, Math.min(120, Math.round(style?.marginV ?? 18)))
    const withBom = await fs.readFile(srtPath, 'utf-8')
    const assPath = path.join(
      os.tmpdir(),
      `ds_sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.ass`
    )
    await fs.writeFile(
      assPath,
      this.srtToAss(withBom.replace(/^\uFEFF/, ''), {
        width: vw,
        height: vh,
        fontSize: Math.round(baseFont * vh / 288),
        marginV: Math.round(baseMarginV * vh / 288)
      }),
      'utf-8'
    )
    const escaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
    try {
      return await this.run(
        ffmpeg()
          .input(videoPath)
          .outputOptions([
            `-vf subtitles='${escaped}'`,
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
    } finally {
      await fs.unlink(assPath).catch(() => undefined)
    }
  }

  /** SRT → ASS（PlayRes 对齐视频实际尺寸，左右留安全边距，WrapStyle=0 智能换行） */
  private srtToAss(
    srt: string,
    opts: { width: number; height: number; fontSize: number; marginV: number }
  ): string {
    const fmt = (sec: number): string => {
      const cs = Math.max(0, Math.round(sec * 100))
      const h = Math.floor(cs / 360000)
      const m = Math.floor((cs % 360000) / 6000)
      const s = Math.floor((cs % 6000) / 100)
      return `${h}:${pad2(m)}:${pad2(s)}.${pad2(cs % 100)}`
    }
    const marginL = Math.max(8, Math.round(opts.width * 0.06))
    const marginR = marginL
    const baseFont = Math.max(14, Math.min(96, opts.fontSize))
    const marginV = Math.max(0, Math.min(240, opts.marginV))
    // 中文换行：libass 在无 ICU 的构建下不会自动折行，长台词会单行溢出被裁切
    // （实测「你的三步套路…」整句左右两头都被切掉）。这里按可用宽度显式插入 \N，
    // 并对超长台词按「最多 3 行」反算字号，避免 5~6 行糊满屏幕。
    const usableW = Math.max(1, opts.width - marginL - marginR)
    const MAX_LINES = 3
    const MIN_FONT = 16
    const CJK_BREAKABLE = /[。！？…，、；：,.!?;:」』）】]/
    const layout = (text: string): { text: string; font: number } => {
      const chars = Array.from(text)
      let font = baseFont
      let perLine = Math.max(6, Math.floor(usableW / font))
      if (chars.length > perLine * MAX_LINES) {
        const need = Math.ceil(chars.length / MAX_LINES)
        font = Math.max(MIN_FONT, Math.min(baseFont, Math.floor(usableW / need)))
        perLine = Math.max(6, Math.floor(usableW / font))
      }
      const lines: string[] = []
      let cur: string[] = []
      for (let i = 0; i < chars.length; i++) {
        cur.push(chars[i])
        if (cur.length >= perLine) {
          // 收尾标点跟随上一行，避免下一行以「、」「。」开头
          while (i + 1 < chars.length && CJK_BREAKABLE.test(chars[i + 1]) && cur.length < perLine + 1) {
            cur.push(chars[++i])
          }
          lines.push(cur.join(''))
          cur = []
        }
      }
      if (cur.length) lines.push(cur.join(''))
      return { text: lines.join('\\N'), font }
    }
    const events: string[] = []
    for (const block of srt.trim().split(/\r?\n\r?\n/)) {
      const lines = block.split(/\r?\n/).filter(l => l.trim() !== '')
      if (lines.length < 2) continue
      const timing = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/.exec(lines[1])
      if (!timing) continue
      const start = Number(timing[1]) * 3600 + Number(timing[2]) * 60 + Number(timing[3]) + fracSec(timing[4])
      const end = Number(timing[5]) * 3600 + Number(timing[6]) * 60 + Number(timing[7]) + fracSec(timing[8])
      const raw = lines.slice(2).join('').replace(/<[^>]+>/g, '').replace(/[{}]/g, '')
      const trimmed = raw.trim()
      if (!trimmed) continue
      const { text, font } = layout(trimmed)
      // 逐条字号覆盖（长台词自动缩小），样式里的字号作为基准
      const prefix = font !== baseFont ? `{\\fs${font}}` : ''
      events.push(`Dialogue: 0,${fmt(start)},${fmt(end)},Default,,0,0,0,,${prefix}${text}`)
    }
    return [
      '[Script Info]',
      'ScriptType: v4.00+',
      `PlayResX: ${opts.width}`,
      `PlayResY: ${opts.height}`,
      'WrapStyle: 0',
      'ScaledBorderAndShadow: yes',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      `Style: Default,Microsoft YaHei,${baseFont},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,${marginL},${marginR},${marginV},1`,
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      ...events,
      ''
    ].join('\n')
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
          // 清掉半截临时文件，避免渲染目录残留垃圾（M-13）
          void fs.unlink(tmpOut).catch(() => undefined)
          const tail = stderrChunks.slice(-12).join('\n')
          reject(new Error(`${err.message}${tail ? `\n--- ffmpeg 日志 ---\n${tail}` : ''}`))
        })
        .save(tmpOut)
    })
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** SRT 小数位 → 秒：标准是 3 位毫秒（",503"），个别工具用 2 位厘秒（",50"）。 */
function fracSec(frac: string): number {
  const digits = String(frac || '0').slice(0, 3)
  const ms = Number(digits.padEnd(3, '0'))
  return (Number.isFinite(ms) ? ms : 0) / 1000
}
