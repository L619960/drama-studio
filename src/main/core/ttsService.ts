import * as fs from 'fs/promises'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'

export interface SynthesizeOptions {
  text: string
  voice: string
  outputPath: string
  rate?: string
  volume?: string
}

export class TTSService {
  private baseDir: string
  private lastCallTime = 0
  private readonly MIN_INTERVAL = 5000 // 5 秒间隔，避免被微软限流

  constructor(baseDir: string) {
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
    volume?: string
  ): Promise<string> {
    const outputPath = path.join(this.baseDir, relativePath)
    await this.synthesize({ text, voice, rate, volume, outputPath })
    return relativePath
  }

  async synthesize(options: SynthesizeOptions): Promise<void> {
    if (!options.text.trim()) {
      throw new Error('TTS text is empty')
    }

    await this.enforceRateLimit()

    const tts = new MsEdgeTTS()
    const format = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3
    await tts.setMetadata(options.voice, format)

    try {
      const { audioStream } = tts.toStream(options.text, {
        rate: options.rate || '+0%',
        volume: options.volume || '+0%'
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

  private async enforceRateLimit(): Promise<void> {
    const now = Date.now()
    const elapsed = now - this.lastCallTime
    if (elapsed < this.MIN_INTERVAL) {
      await new Promise((r) => setTimeout(r, this.MIN_INTERVAL - elapsed))
    }
    this.lastCallTime = Date.now()
  }

  getCacheKey(text: string, voice: string, rate?: string): string {
    return crypto.createHash('md5').update(`${text}|${voice}|${rate || '+0%'}`).digest('hex')
  }
}
