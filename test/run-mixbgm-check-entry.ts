// BGM 混音阶段定向验证：用编排已产出的 final_subtitled.mp4 + bgm_test.mp3
// 验证 DirectorAgent 第⑦步的 ffmpeg.mixBgm 代码路径（stream_loop + amix）
import { join } from 'node:path'
import * as fs from 'node:fs/promises'
import { FFmpegService } from '../src/main/core/ffmpegService'

const DATA_ROOT = join(process.cwd(), 'test', '.e2e-data')

async function findLatestProject(): Promise<string | null> {
  const dir = join(DATA_ROOT, 'projects')
  const entries = await fs.readdir(dir, { withFileTypes: true })
  let latest: { id: string; mtime: number } | null = null
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const sub = join(dir, e.name, 'final_subtitled.mp4')
    try {
      const st = await fs.stat(sub)
      if (!latest || st.mtimeMs > latest.mtime) latest = { id: e.name, mtime: st.mtimeMs }
    } catch {
      // 无字幕成片的项目跳过
    }
  }
  return latest?.id || null
}

async function main(): Promise<void> {
  const projectId = await findLatestProject()
  if (!projectId) {
    console.error('未找到含 final_subtitled.mp4 的项目，请先运行 run-director-smoke')
    process.exit(1)
  }
  const video = join(DATA_ROOT, 'projects', projectId, 'final_subtitled.mp4')
  const bgm = join(process.cwd(), 'test', 'bgm_test.mp3')
  const out = join(DATA_ROOT, 'projects', projectId, 'final_master_check.mp4')

  const svc = new FFmpegService()
  await svc.ready()
  const before = await svc.getVideoInfo(video)
  console.log(`项目 ${projectId}`)
  console.log(`输入成片: ${before.width}x${before.height} ${before.durationSec.toFixed(1)}s hasAudio=${before.hasAudio}`)
  console.log('执行 mixBgm（BGM 循环铺满 + amix 混音，音量 20%）...')

  await svc.mixBgm(video, bgm, out, 20)

  const after = await svc.getVideoInfo(out)
  const stat = await fs.stat(out)
  const ok = after.hasAudio && Math.abs(after.durationSec - before.durationSec) < 1
  console.log(`输出: ${after.width}x${after.height} ${after.durationSec.toFixed(1)}s hasAudio=${after.hasAudio} ${(stat.size / 1024).toFixed(0)}KB`)
  console.log(ok ? 'PASS  BGM 混音阶段验证通过 ✅' : 'FAIL  混音后时长/音轨异常 ❌')
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error('BGM 验证异常:', e)
  process.exit(1)
})
