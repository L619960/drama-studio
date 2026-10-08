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
      if (!shot.dialogue.trim()) {
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

    const srtContent = entries
      .map(e => `${e.index}\n${this.fmt(e.start)} --> ${this.fmt(e.end)}\n${e.text}\n`)
      .join('\n')

    const srtPath = path.join(this.baseDir, 'projects', project.id, 'subtitles.srt')
    await fs.mkdir(path.dirname(srtPath), { recursive: true })
    await fs.writeFile(srtPath, srtContent, 'utf-8')
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
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = Math.floor(s % 60)
    const ms = Math.round((s % 1) * 1000)
    return `${pad(h)}:${pad(m)}:${pad(sec)},${String(ms).padStart(3, '0')}`
  }
}

function pad(n: number): string { return String(n).padStart(2, '0') }
