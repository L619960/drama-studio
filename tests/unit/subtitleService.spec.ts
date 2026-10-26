import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SubtitleService } from '../../src/main/core/subtitleService'
import type { Project } from '../../src/shared/ipcTypes'

/** 桩 FFmpegService：getDuration 按路径返回固定时长 */
function stubFfmpeg(duration = 2.0) {
  return {
    getDuration: async () => duration
  } as unknown as ConstructorParameters<typeof SubtitleService>[0]
}

function fixtureProject(): Project {
  return {
    id: 'p1',
    title: '测试项目',
    shots: [
      { id: 's1', index: 1, frames: 33, dialogue: '你好', audioPath: 'projects/p1/audio/s1.mp3' },
      { id: 's2', index: 2, frames: 33, dialogue: '' },
      { id: 's3', index: 3, frames: 65, dialogue: '再见' }
    ]
  } as unknown as Project
}

describe('SubtitleService.generate', () => {
  let baseDir: string
  let svc: SubtitleService

  beforeAll(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-sub-'))
    svc = new SubtitleService(stubFfmpeg(), baseDir)
  })

  afterAll(async () => {
    await fs.rm(baseDir, { recursive: true, force: true })
  })

  it('按分镜顺序生成时间轴：台词开口按 audioLeadSec 延迟，无台词镜头也推进时间', async () => {
    const rel = await svc.generate(fixtureProject())
    expect(rel).toBe('projects/p1/subtitles.srt')
    const content = await fs.readFile(path.join(baseDir, rel), 'utf-8')
    // UTF-8 BOM（Windows libass 兼容）
    expect(content.charCodeAt(0)).toBe(0xfeff)
    const srt = content.replace(/^\uFEFF/, '')
    // s1: 33帧→2s，start=0.4（audioLeadSec），end=min(2, 0.4+2)=2
    expect(srt).toContain('00:00:00,400 --> 00:00:02,000\n你好')
    // s2 无台词：时间推进 2s → 4
    // s3: 65帧→4s，start=4，end=8
    expect(srt).toContain('00:00:04,000 --> 00:00:08,000\n再见')
    // 序号连续
    expect(srt).toMatch(/^1\n/m)
    expect(srt).toMatch(/^2\n/m)
  })

  it('全部无台词时不写空 SRT（返回空串）', async () => {
    const proj = fixtureProject()
    proj.shots = proj.shots.map((s, i) => ({ ...s, dialogue: '', id: `n${i}` })) as Project['shots']
    const rel = await svc.generate(proj)
    expect(rel).toBe('')
  })

  it('includedShotIds 只统计参与拼接的镜头（失败镜头排除）', async () => {
    const rel = await svc.generate(fixtureProject(), ['s3'])
    const content = (await fs.readFile(path.join(baseDir, rel), 'utf-8')).replace(/^\uFEFF/, '')
    expect(content).toContain('再见')
    expect(content).not.toContain('你好')
    expect(content).toMatch(/^1\n/m)
  })
})
