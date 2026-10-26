import * as fs from 'fs/promises'
import * as path from 'node:path'
import { FFmpegService } from './ffmpegService'
import { SHOT_TIMING, type Project } from '../../shared/ipcTypes'

/**
 * 字幕服务：按分镜顺序生成 SRT 文件。
 * 优先使用 segment 实际时长；未渲染时按 frames 估算（16fps）。
 */
export class SubtitleService {
  constructor(private ffmpeg: FFmpegService, private baseDir: string) {}

  async generate(project: Project, includedShotIds?: string[]): Promise<string> {
    let currentTime = 0
    const entries: { index: number; start: number; end: number; text: string }[] = []

    // AI 导演模式：失败镜头已被排除出成片，字幕时间轴只按实际参与拼接的镜头累计
    const shots = includedShotIds
      ? includedShotIds
          .map(id => project.shots.find(s => s.id === id))
          .filter((s): s is Project['shots'][number] => Boolean(s))
      : project.shots

    for (const shot of shots) {
      if (isPlaceholderDialogue(shot.dialogue)) {
        // 无台词也要推进时间，否则后续字幕错位
        const dur = await this.estimateDuration(shot)
        currentTime += dur
        continue
      }
      const dur = await this.estimateDuration(shot)
      // 台词在段落内被整体延迟 audioLeadSec 开口（先入画再说话），字幕跟随真实出声时刻；
      // 字幕长度只覆盖纯语音（取原始 TTS 时长，不含留白），探测失败则回退整段
      let start = currentTime
      let end = currentTime + dur
      if (shot.audioPath) {
        try {
          const speechDur = await this.ffmpeg.getDuration(path.join(this.baseDir, shot.audioPath))
          start = currentTime + SHOT_TIMING.audioLeadSec
          end = Math.min(currentTime + dur, start + speechDur)
        } catch {
          // 探测失败沿用整段时长
        }
      }
      entries.push({
        index: entries.length + 1,
        start,
        end,
        text: shot.dialogue.trim()
      })
      currentTime += dur
    }

    // 无任何台词条目：不写空 SRT（ffmpeg/libass 对空轨/异常路径更脆），由调用方跳过烧录
    if (entries.length === 0) {
      return ''
    }

    const srtContent = entries
      .map(e => `${e.index}\n${this.fmt(e.start)} --> ${this.fmt(e.end)}\n${e.text}\n`)
      .join('\n')

    const srtPath = path.join(this.baseDir, 'projects', project.id, 'subtitles.srt')
    await fs.mkdir(path.dirname(srtPath), { recursive: true })
    // UTF-8 BOM：Windows 版 libass 对无 BOM 中文 SRT 偶发打不开
    await fs.writeFile(srtPath, `\uFEFF${srtContent}`, 'utf-8')
    return `projects/${project.id}/subtitles.srt`
  }

  private async estimateDuration(shot: { segmentPath?: string; frames: number }): Promise<number> {
    if (shot.segmentPath) {
      try {
        return await this.ffmpeg.getDuration(path.join(this.baseDir, shot.segmentPath))
      } catch {
        // fallthrough
      }
    }
    return (shot.frames - 1) / 16
  }

  private fmt(s: number): string {
    // 先取整毫秒再拆分：若秒/毫秒分别取整，0.9997s 会产出 ",1000" 的非法时间码（M-12）
    const totalMs = Math.round(s * 1000)
    const h = Math.floor(totalMs / 3600000)
    const m = Math.floor((totalMs % 3600000) / 60000)
    const sec = Math.floor((totalMs % 60000) / 1000)
    const ms = totalMs % 1000
    return `${pad(h)}:${pad(m)}:${pad(sec)},${String(ms).padStart(3, '0')}`
  }
}

function pad(n: number): string { return String(n).padStart(2, '0') }

/**
 * 占位台词判定：分镜里常见「（无台词）」「（无对白）」「none」等占位写法。
 * 这些不是台词——写进 SRT 会在成片烧出「（无台词）」字样（实测 5 处），
 * 也不能当作有台词去驱动口型/字幕时间轴。
 */
const PLACEHOLDER_DIALOGUE_RE = /^[（(\[【]\s*(无台词|无对白|无|暂无|none|n\/?a)\s*[）)\]】]$/i
function isPlaceholderDialogue(text: string): boolean {
  const t = (text || '').trim()
  if (!t) return true
  if (PLACEHOLDER_DIALOGUE_RE.test(t)) return true
  return /^(无台词|无对白|none|n\/?a)$/i.test(t)
}

/** 供 TaskQueue/音频链路复用：占位台词不生成 TTS、不做口型 */
export function isPlaceholderDialogueText(text: string): boolean {
  return isPlaceholderDialogue(text)
}
