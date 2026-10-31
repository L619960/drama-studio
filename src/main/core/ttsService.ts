import * as fs from 'fs/promises'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import type { ComfyUIClient } from './comfyuiClient'
import type { WorkflowLoader } from './workflowLoader'
import { createLogger } from './logger'
import { childProcessManager } from './childProcessManager'

const log = createLogger('tts')

/** Windows SAPI 中文语音名（秋叶整合包系统自带） */
const SAPI_ZH_VOICE = 'Microsoft Huihui Desktop'
/** SAPI 参考样本固定文本（作为 Qwen3 音色克隆的参考音，可缓存复用） */
const SAPI_REF_TEXT = '你好，我是今天的试音。请记住我的声音，接下来由我为您讲述这个故事。'
const FFMPEG_STATIC = path.join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')

export interface SynthesizeOptions {
  text: string
  voice: string
  outputPath: string
  rate?: string | undefined
  volume?: string | undefined
  /** 取消探测：轮询循环每轮调用，返回 true 则中断 Qwen 克隆等待（对齐 generateClone） */
  shouldAbort?: (() => boolean) | undefined
}

export interface CloneOptions {
  /** 参考音频转录文本（提升克隆相似度，可省略） */
  refText?: string | undefined
  /** 固定种子；未传随机 */
  seed?: number | undefined
  /** 克隆模型：0.6B / 1.7B（默认 1.7B，音色更像） */
  model?: '0.6B' | '1.7B' | undefined
  /** 取消探测 */
  shouldAbort?: (() => boolean) | undefined
  /** Comfy 等待超时（毫秒），默认 600s */
  timeoutMs?: number | undefined
}

/** Edge TTS 风控限流（403/429）：调用方应降级而非整体失败 */
export class TTSRateLimitedError extends Error {}

export class TTSService {
  private baseDir: string
  private lastCallTime = 0
  private readonly MIN_INTERVAL = 5000 // 5 秒间隔，避免被微软限流

  constructor(
    baseDir: string,
    private comfyui?: ComfyUIClient,
    private workflow?: WorkflowLoader,
  ) {
    this.baseDir = baseDir
  }

  /**
   * 高层接口：输入文本、音色、相对路径，写入 baseDir，返回相对路径。
   * 供 TaskQueue 调用。
   */
  async generate(
    text: string,
    voice: string,
    relativePath: string,
    rate?: string,
    volume?: string,
    shouldAbort?: () => boolean,
  ): Promise<string> {
    const outputPath = path.join(this.baseDir, relativePath)
    await this.synthesize({ text, voice, rate, volume, outputPath, shouldAbort })
    return relativePath
  }

  /**
   * 四级降级链（口型链路的前提，必须保证台词声音能出来）：
   * ① msedge-tts（微软 Edge，403 风控时快速失败）
   * ② 本机 ComfyUI Qwen3-TTS 克隆（SAPI 合成参考样本驱动音色，无风控、音质自然）
   * ③ Windows SAPI 直出（Huihui 中文女声，零依赖最后兜底）
   * ④ 仍失败抛 TTSRateLimitedError → taskQueue 静音降级（不阻塞视频渲染）
   */
  async synthesize(options: SynthesizeOptions): Promise<void> {
    if (!options.text.trim()) {
      throw new Error('TTS text is empty')
    }

    await this.enforceRateLimit()

    // ① msedge-tts：403 是微软风控（短时请求频率过高/出口 IP 被标记），
    // 秒级重试无效，必须 15s×3≈45s 长退避等待风控窗口；普通错误 2.5s×3
    let lastErr: unknown
    const isRateLimited = (e: unknown): boolean => e instanceof Error && /403|429|rate.limit|limited/i.test(e.message)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.synthesizeOnce(options)
        return
      } catch (e) {
        lastErr = e
        if (attempt < 2) {
          const backoff = isRateLimited(e) ? 15000 : 2500
          await new Promise((r) => setTimeout(r, backoff))
        }
      }
    }
    log.warn(
      `Edge TTS 不可用（${lastErr instanceof Error ? lastErr.message.slice(0, 120) : String(lastErr).slice(0, 120)}），切本机 TTS`,
    )

    // ② 本机 ComfyUI Qwen3-TTS 克隆：SAPI 合成音色样本 → 克隆合成（无风控、更自然）
    try {
      await this.synthesizeViaQwenClone(options)
      return
    } catch (localErr) {
      log.warn(
        `本机 Qwen3-TTS 克隆失败：${localErr instanceof Error ? localErr.message.slice(0, 120) : String(localErr)}`,
      )
    }

    // ③ Windows SAPI 直出（最后兜底，零依赖）
    try {
      await this.synthesizeViaSapi(options)
      return
    } catch (sapiErr) {
      log.warn(`Windows SAPI 合成失败：${sapiErr instanceof Error ? sapiErr.message.slice(0, 120) : String(sapiErr)}`)
      lastErr = sapiErr
    }

    // ④ 三层都失败 → 抛风控错误，taskQueue 据此静音降级
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr)
    throw new TTSRateLimitedError(`TTS 全部通道失败（Edge + Qwen3 + SAPI）：${msg.slice(0, 100)}`)
  }

  /**
   * ② 本机 ComfyUI Qwen3-TTS 克隆：
   * 无用户参考音频时，先用 Windows SAPI 合成固定样本（每角色缓存一份）作为音色参考，
   * 再走 FB_Qwen3TTSVoiceClone x-vector 克隆合成台词。voice 名 hash 派生固定 seed，音色稳定。
   */
  private async synthesizeViaQwenClone(options: SynthesizeOptions): Promise<void> {
    if (!this.comfyui || !this.workflow) {
      throw new Error('本机 TTS 克隆不可用：未注入 ComfyUI/工作流服务')
    }
    const nodeOk = await this.comfyui.hasNode('FB_Qwen3TTSVoiceClone')
    if (!nodeOk) throw new Error('本机 ComfyUI 未安装 FB_Qwen3TTSVoiceClone 节点')
    const listed = await this.workflow.list()
    if (!listed.some((w) => w.name === 'tts_clone')) {
      throw new Error('工作流 tts_clone 不存在')
    }

    // SAPI 参考样本（缓存复用：同 voice 只合成一次）
    const refDir = path.join(this.baseDir, 'tts_ref')
    const sampleWav = path.join(refDir, `${sanitizeVoice(options.voice)}.wav`)
    if (!(await fileExists(sampleWav))) {
      await this.sapiSpeak(SAPI_REF_TEXT, sampleWav)
      await fs.mkdir(refDir, { recursive: true }).catch(() => undefined)
    }

    const seed = crypto.createHash('md5').update(options.voice).digest().readUInt32BE(0)
    const audioName = await this.comfyui.uploadAudio(sampleWav)
    const graph = await this.workflow.buildGraph('tts_clone', {
      PROMPT: options.text,
      REF_AUDIO: audioName,
      REF_TEXT: '',
      SEED: seed,
      X_VECTOR: true,
    })
    const { promptId } = await this.comfyui.submit(graph)
    const deadline = Date.now() + 600_000
    let output: { filename: string; subfolder: string; type: string } | null = null
    while (Date.now() < deadline) {
      if (options.shouldAbort?.()) throw new Error('TTS 已取消')
      await new Promise((r) => setTimeout(r, 1500))
      const history = await this.comfyui.getHistory(promptId)
      if (!history) continue
      for (const items of Object.values(history)) {
        for (const it of items as Array<{ filename?: string; subfolder?: string; type?: string }>) {
          if (it?.filename && /\.mp3$/i.test(it.filename)) {
            output = { filename: it.filename, subfolder: it.subfolder || '', type: it.type || 'output' }
            break
          }
        }
        if (output) break
      }
      if (output) break
    }
    if (!output) throw new Error(`本机 TTS 超时（600s 内未产出 mp3）`)
    await this.comfyui.download(output.filename, output.subfolder, output.type, options.outputPath)
  }

  /** ③ Windows SAPI 直出：System.Speech 合成 → ffmpeg 转 mp3（零依赖兜底） */
  private async synthesizeViaSapi(options: SynthesizeOptions): Promise<void> {
    const tmpWav = options.outputPath.replace(/\.mp3$/i, '.wav')
    await this.sapiSpeak(options.text, tmpWav)
    await this.wavToMp3(tmpWav, options.outputPath)
    await fs.unlink(tmpWav).catch(() => undefined)
  }

  /** System.Speech 合成 wav（文本经 base64 传参避免中文/引号转义） */
  private async sapiSpeak(text: string, outWavAbs: string): Promise<void> {
    await fs.mkdir(path.dirname(outWavAbs), { recursive: true })
    const b64 = Buffer.from(text, 'utf8').toString('base64')
    const ps = [
      'Add-Type -AssemblyName System.Speech;',
      `$t = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'));`,
      `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;`,
      `$s.SelectVoice('${SAPI_ZH_VOICE}');`,
      `$s.SetOutputToWaveFile('${outWavAbs.replace(/'/g, "''")}');`,
      `$s.Speak($t);`,
      `$s.Dispose()`,
    ].join(' ')
    await new Promise<void>((resolve, reject) => {
      childProcessManager
        .execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
          windowsHide: true,
          timeout: 60_000,
          label: 'tts-sapi',
        })
        .then(() => resolve())
        .catch((err) => reject(new Error(`SAPI 合成失败：${String(err.message).slice(0, 120)}`)))
    })
    const st = await fs.stat(outWavAbs).catch(() => null)
    if (!st || st.size < 1000) throw new Error('SAPI 未产出有效音频')
  }

  /** ffmpeg-static wav → mp3 */
  private async wavToMp3(wavAbs: string, mp3Abs: string): Promise<void> {
    await fs.mkdir(path.dirname(mp3Abs), { recursive: true })
    try {
      await childProcessManager.execFile(
        FFMPEG_STATIC,
        ['-y', '-i', wavAbs, '-codec:a', 'libmp3lame', '-q:a', '4', mp3Abs],
        { windowsHide: true, timeout: 60_000, label: 'tts-wav2mp3' },
      )
    } catch (e) {
      throw new Error(`wav→mp3 转换失败：${String(e instanceof Error ? e.message : e).slice(0, 120)}`, { cause: e })
    }
  }

  /**
   * 本机 ComfyUI Qwen3-TTS 固定音色（无参考音频，x-vector 模式）：
   * 已废弃——FB_Qwen3TTSVoiceClone 实际强制要求 ref_audio 或 voice_clone_prompt，
   * 无参考音频时无法出音；改由 synthesizeViaQwenClone（SAPI 样本驱动）承担该层。
   */
  private async generateLocal(text: string, voice: string, outputAbsPath: string): Promise<void> {
    if (!this.comfyui || !this.workflow) {
      throw new Error('本机 TTS 兜底不可用：未注入 ComfyUI/工作流服务')
    }
    if (!text.trim()) throw new Error('TTS text is empty')
    const nodeOk = await this.comfyui.hasNode('FB_Qwen3TTSVoiceClone')
    if (!nodeOk) throw new Error('本机 ComfyUI 未安装 FB_Qwen3TTSVoiceClone 节点，无法本地合成')

    const listed = await this.workflow.list()
    if (!listed.some((w) => w.name === 'tts_plain')) {
      throw new Error('工作流 tts_plain 不存在，无法本地合成')
    }

    const seed = crypto.createHash('md5').update(voice).digest().readUInt32BE(0)
    const graph = await this.workflow.buildGraph('tts_plain', {
      PROMPT: text,
      SEED: seed,
    })

    const { promptId } = await this.comfyui.submit(graph)
    const deadline = Date.now() + 600_000
    let output: { filename: string; subfolder: string; type: string } | null = null
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500))
      const history = await this.comfyui.getHistory(promptId)
      if (!history) continue
      for (const items of Object.values(history)) {
        for (const it of items as Array<{ filename?: string; subfolder?: string; type?: string }>) {
          if (it?.filename && /\.mp3$/i.test(it.filename)) {
            output = { filename: it.filename, subfolder: it.subfolder || '', type: it.type || 'output' }
            break
          }
        }
        if (output) break
      }
      if (output) break
    }
    if (!output) throw new Error(`本机 TTS 超时（600s 内未产出 mp3）`)

    await this.comfyui.download(output.filename, output.subfolder, output.type, outputAbsPath)
    await fs.mkdir(path.dirname(outputAbsPath), { recursive: true }).catch(() => undefined)
  }

  private async synthesizeOnce(options: SynthesizeOptions): Promise<void> {
    const tts = new MsEdgeTTS()
    const format = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3
    await tts.setMetadata(options.voice, format)

    try {
      const { audioStream } = tts.toStream(options.text, {
        rate: options.rate || '+0%',
        volume: options.volume || '+0%',
      })
      await fs.mkdir(path.dirname(options.outputPath), { recursive: true })
      const chunks: Buffer[] = []
      for await (const chunk of audioStream) {
        chunks.push(chunk as Buffer)
      }
      if (chunks.length === 0) {
        throw new Error('TTS produced no audio (可能触发限流或网络异常)')
      }
      await fs.writeFile(options.outputPath, Buffer.concat(chunks))
    } finally {
      tts.close()
    }
  }

  /**
   * Qwen3-TTS 语音克隆（本机 ComfyUI FB_Qwen3TTSVoiceClone）：
   * 参考一段音色样本（refAudioAbs），生成指定文本的克隆语音。
   * - 前置：ComfyUI 已装 FB_Qwen3TTSVoiceClone 节点、workflows/tts_clone.json 模板存在
   * - 未满足前置时抛错，调用方回退 msedge 固定音色
   */
  async generateClone(text: string, refAudioAbs: string, relativePath: string, opts?: CloneOptions): Promise<string> {
    if (!this.comfyui || !this.workflow) {
      throw new Error('TTS 克隆不可用：未注入 ComfyUI/工作流服务')
    }
    if (!text.trim()) throw new Error('TTS text is empty')
    const nodeOk = await this.comfyui.hasNode('FB_Qwen3TTSVoiceClone')
    if (!nodeOk) throw new Error('本机 ComfyUI 未安装 FB_Qwen3TTSVoiceClone 节点，无法克隆')

    const listed = await this.workflow.list()
    if (!listed.some((w) => w.name === 'tts_clone')) {
      throw new Error('工作流 tts_clone 不存在，无法克隆')
    }

    const audioName = await this.comfyui.uploadAudio(refAudioAbs)
    const seed = opts?.seed ?? Math.floor(Math.random() * 0xffffffff)
    // 无 ref_text 时走 x-vector 模式（FB_Qwen3TTSVoiceClone 的 ICL 模式强制要求 ref_text）
    const graph = await this.workflow.buildGraph('tts_clone', {
      PROMPT: text,
      REF_AUDIO: audioName,
      REF_TEXT: opts?.refText ?? '',
      SEED: seed,
      X_VECTOR: !opts?.refText,
    })

    const { promptId } = await this.comfyui.submit(graph)
    const deadline = Date.now() + (opts?.timeoutMs ?? 600_000)
    let output: { filename: string; subfolder: string; type: string } | null = null
    while (Date.now() < deadline) {
      if (opts?.shouldAbort?.()) throw new Error('TTS 克隆已取消')
      await new Promise((r) => setTimeout(r, 1500))
      const history = await this.comfyui.getHistory(promptId)
      if (!history) continue
      // SaveAudioMP3 输出在 gifs/audio 键（filename/subfolder/type）
      for (const items of Object.values(history)) {
        for (const it of items as Array<{ filename?: string; subfolder?: string; type?: string }>) {
          if (it?.filename && /\.mp3$/i.test(it.filename)) {
            output = { filename: it.filename, subfolder: it.subfolder || '', type: it.type || 'output' }
            break
          }
        }
        if (output) break
      }
      if (output) break
    }
    if (!output) throw new Error(`TTS 克隆超时（${Math.round((deadline - Date.now()) / 1000)}s 内未产出）`)

    const outputAbs = path.join(this.baseDir, relativePath)
    await this.comfyui.download(output.filename, output.subfolder, output.type, outputAbs)
    return relativePath
  }

  private async enforceRateLimit(): Promise<void> {
    const now = Date.now()
    const elapsed = now - this.lastCallTime
    if (elapsed < this.MIN_INTERVAL) {
      await new Promise((r) => setTimeout(r, this.MIN_INTERVAL - elapsed))
    }
    this.lastCallTime = Date.now()
  }

  getCacheKey(text: string, voice: string, rate?: string): string {
    return crypto
      .createHash('md5')
      .update(`${text}|${voice}|${rate || '+0%'}`)
      .digest('hex')
  }
}

/** voice 名 → 安全文件名（SAPI 参考样本缓存用） */
function sanitizeVoice(voice: string): string {
  return voice.replace(/[^\w-]/g, '_')
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
