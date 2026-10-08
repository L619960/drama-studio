// MiniMax H3 全链路 smoke：首帧生成 → TTS → H3渲染(i2v/r2v) → 合成 → 字幕 → BGM
// 与 Wan 版差异：渲染走 workflows/minimax_h3_*.json，原生音频（不后合 TTS），
// 低步数(10)+小分辨率(512x896) 压缩验证时长；固定 4 镜覆盖 t2v空镜/i2v无台词/r2v双音色
import { join } from 'node:path'
import * as fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffmpegBinary from 'ffmpeg-static'
import { ComfyUIClient } from '../src/main/core/comfyuiClient'
import { TTSService } from '../src/main/core/ttsService'
import { FFmpegService } from '../src/main/core/ffmpegService'
import { WorkflowLoader } from '../src/main/core/workflowLoader'
import { SettingsStore } from '../src/main/core/settingsStore'
import { SubtitleService } from '../src/main/core/subtitleService'
import { ImageService } from '../src/main/core/imageService'
import { SHOT_TIMING, type Project, type Shot } from '../src/shared/ipcTypes'

const execFileP = promisify(execFile)
const DATA_ROOT = join(process.cwd(), 'test', '.e2e-data')
const PID = `h3smoke_${Date.now()}`
const W = 512
const H = 896
const STEPS = 10
const LENGTH = 124 // 24fps ≈ 5.17s，覆盖 0.4s留白+3.4s台词+1.2s反应
const COMFY_INPUT = 'D:\\ComfyUI-V20\\ComfyUI\\input' // LoadAudio 只认此目录，失败时回退直接复制

interface SmokeShot extends Shot { h3prompt: string; h3audioRel?: string }

async function main(): Promise<void> {
  console.log('=== H3 全链路 smoke ===')
  const settings = await new SettingsStore().get()
  const ffmpeg = new FFmpegService()
  await ffmpeg.ready()
  const comfy = new ComfyUIClient({ baseUrl: settings.comfyui.baseUrl, clientId: 'drama-studio-h3smoke' })
  if (!(await comfy.healthCheck())) { console.error('ComfyUI 不在线'); process.exit(1) }
  const tts = new TTSService(DATA_ROOT)
  const workflow = new WorkflowLoader(join(process.cwd(), 'workflows'))
  const images = new ImageService(comfy, workflow)
  const subtitles = new SubtitleService(ffmpeg, DATA_ROOT)

  // 固定 4 镜（跳过 LLM 拆镜，直验渲染链路）
  const mkShot = (id: string, type: 't2v' | 'i2v', dialogue: string, framePrompt: string, h3prompt: string): SmokeShot => ({
    id, type, dialogue, action: framePrompt, h3prompt,
    frames: LENGTH, seed: Math.floor(Math.random() * 0xffffffff),
    characterIds: [], status: 'pending', sceneId: 's1', episode: 1, order: 0
  } as unknown as SmokeShot)

  const shots: SmokeShot[] = [
    mkShot('shot1_scene', 't2v', '',
      'cinematic vertical film still, rainy night street outside a convenience store, empty scene, no people, neon signs reflecting on wet pavement, cool blue tones, photorealistic',
      'integrated_multimodal_description: [Shot 1] Live-action, cinematic. The empty rainy night street outside the convenience store shown in <Picture 1>, scene fully preserved. The camera pushes in slowly with small amplitude. Rain falls steadily, neon reflections shimmer on the wet pavement. overall_soundscape: steady rain, distant city traffic. non_diegetic_music: N/A'),
    mkShot('shot2_girl', 'i2v', '',
      'cinematic vertical film still, young East Asian woman with long dark hair in white hoodie standing under convenience store awning in the rain at night, looking up at the dark sky, medium shot, single person only, no other faces, photorealistic',
      'integrated_multimodal_description: [Shot 1] Live-action, cinematic. The young East Asian woman shown in <Picture 1> stands under the awning in the rain, her appearance and clothing fully preserved. She slowly looks up at the dark rainy sky. Static camera. overall_soundscape: rain pattering on the awning, distant traffic. non_diegetic_music: N/A'),
    mkShot('shot3_girl_line', 'i2v', '你怎么来了？',
      'cinematic vertical film still, close-up of a young East Asian woman with long dark hair in white hoodie, surprised expression, rainy night bokeh lights, single person only, no other faces, photorealistic',
      'integrated_multimodal_description: [Shot 1] Live-action, cinematic, a close-up at night. The young East Asian woman shown in <Picture 1>, her appearance and clothing fully preserved. At 0.4 seconds, the surprised young woman with a soft clear Mandarin female voice (S1) says: <d>[Chinese] 你怎么来了？</d> Her lips move naturally in sync with the Mandarin speech, matching the voice and timing of the reference audio. Static camera, shallow depth of field. overall_soundscape: light rain, distant city hum. non_diegetic_music: N/A'),
    mkShot('shot4_boy_line', 'i2v', '雨这么大，我来接你。',
      'cinematic vertical film still, medium close-up of a young East Asian man with short black hair in a dark jacket, holding a black umbrella in the rain at night, gentle sincere expression, single person only, no other faces, photorealistic',
      'integrated_multimodal_description: [Shot 1] Live-action, cinematic, a medium close-up at night. The young East Asian man shown in <Picture 1> holding a black umbrella in the rain, his appearance and clothing fully preserved. At 0.4 seconds, the gentle young man with a low warm Mandarin male voice (S1) says: <d>[Chinese] 雨这么大，我来接你。</d> His lips move naturally in sync with the Mandarin speech, matching the voice and timing of the reference audio. Static camera, shallow depth of field. overall_soundscape: steady rain on the umbrella, distant traffic. non_diegetic_music: N/A')
  ]
  shots[2].characterIds = ['c_girl']
  shots[3].characterIds = ['c_boy']

  const project = {
    id: PID,
    title: 'H3链路验证',
    genre: '霸总',
    characters: [
      { id: 'c_girl', name: '苏晓', voice: 'zh-CN-XiaoxiaoNeural' },
      { id: 'c_boy', name: '陆沉', voice: 'zh-CN-YunjianNeural' }
    ],
    shots: shots as unknown as Shot[]
  } as unknown as Project

  const pdir = join(DATA_ROOT, 'projects', PID)
  const t0 = Date.now()
  const elapsed = (): string => `${((Date.now() - t0) / 60000).toFixed(1)}min`

  // 1. 首帧图（4 张，Z-Image 竖版 512x896）
  console.log('\n[1/6] 生成首帧图...')
  for (const shot of shots) {
    const frameAbs = join(pdir, 'shots', `${shot.id}_frame.png`)
    await images.generate(shot.action, frameAbs, { width: W, height: H })
    shot.firstFramePath = `projects/${PID}/shots/${shot.id}_frame.png`
    console.log(`  ${shot.id} 首帧 OK (${elapsed()})`)
  }

  // 2. TTS + 开口留白（台词镜）
  console.log('\n[2/6] TTS...')
  for (const shot of shots) {
    if (!shot.dialogue) continue
    const voice = project.characters.find(c => c.id === shot.characterIds[0])!.voice!
    const rel = `projects/${PID}/audio/${shot.id}.mp3`
    await tts.generate(shot.dialogue, voice, rel, '+0%', '+0%')
    shot.audioPath = rel
    const leadedRel = `projects/${PID}/audio/${shot.id}_leaded.mp3`
    await ffmpeg.padAudioLead(join(DATA_ROOT, rel), join(DATA_ROOT, leadedRel), SHOT_TIMING.audioLeadSec)
    shot.h3audioRel = leadedRel
    const dur = await ffmpeg.getDuration(join(DATA_ROOT, leadedRel))
    console.log(`  ${shot.id} TTS+留白 ${dur.toFixed(2)}s (${elapsed()})`)
  }

  // 3. H3 渲染（10步/512x896/124帧）
  console.log('\n[3/6] H3 渲染...')
  for (const shot of shots) {
    const frameAbs = join(DATA_ROOT, shot.firstFramePath!)
    const imageName = await comfy.uploadImage(frameAbs)

    let audioName: string | undefined
    if (shot.h3audioRel) {
      // LoadAudio 读 input 目录：先试 /upload/image，失败回退直接复制
      const src = join(DATA_ROOT, shot.h3audioRel)
      const baseName = `${shot.id}_leaded.mp3`
      let uploaded: string | undefined
      try {
        const form = new FormData()
        form.append('image', new Blob([await fs.readFile(src)]), baseName)
        form.append('overwrite', 'true')
        const up = await (await fetch(`${settings.comfyui.baseUrl}/upload/image`, { method: 'POST', body: form })).json()
        if (!up.name) throw new Error('upload rejected')
        uploaded = up.name
      } catch {
        await fs.copyFile(src, join(COMFY_INPUT, baseName))
        uploaded = baseName
      }
      audioName = uploaded
    }

    const useR2V = Boolean(shot.dialogue)
    let tpl = await fs.readFile(join(process.cwd(), 'workflows', useR2V ? 'minimax_h3_r2v.json' : 'minimax_h3_i2v.json'), 'utf8')
    tpl = tpl.replace(/^\s*"_comment"\s*:\s*"[^"]*",?\r?\n/m, '')
    tpl = tpl.replace('"$PROMPT$"', JSON.stringify(shot.h3prompt))
    tpl = tpl.replace('"$REF_IMAGE$"', JSON.stringify(imageName))
    tpl = tpl.replace('"$PREFIX$"', JSON.stringify(`h3smoke/${PID}`))
    tpl = tpl.replace('$WIDTH$', String(W)).replace('$HEIGHT$', String(H))
    tpl = tpl.replace('$LENGTH$', String(LENGTH))
    tpl = tpl.replace('$SEED$', String(shot.seed))
    if (useR2V) tpl = tpl.replace('"$AUDIO$"', JSON.stringify(audioName!))
    const graph = JSON.parse(tpl)
    graph['42'].inputs.steps = STEPS

    const { promptId } = await comfy.submit(graph)
    console.log(`  ${shot.id} [${useR2V ? 'r2v' : 'i2v'}] 提交 ${promptId.slice(0, 8)}... (${elapsed()})`)
    const output = await comfy.waitForCompletion(promptId)
    const video = comfy.findVideoOutput(output)
    if (!video) throw new Error(`${shot.id} 无视频输出`)
    const rawAbs = join(pdir, 'raw', `${shot.id}.mp4`)
    await comfy.download(video.filename, video.subfolder, video.type, rawAbs)
    shot.rawVideoPath = `projects/${PID}/raw/${shot.id}.mp4`
    console.log(`  ${shot.id} 渲染完成 (${elapsed()})`)
  }

  // 4. 分段归一化（H3 原生音轨保留：统一 24fps/H264/AAC48k，供 concat 流拷贝）
  console.log('\n[4/6] 分段归一化...')
  const ffmpegBin = ffmpegBinary as unknown as string
  const segPaths: string[] = []
  for (const shot of shots) {
    const rawAbs = join(DATA_ROOT, shot.rawVideoPath!)
    const segAbs = join(pdir, 'segments', `${shot.id}.mp4`)
    await fs.mkdir(join(pdir, 'segments'), { recursive: true })
    await execFileP(ffmpegBin, [
      '-y', '-i', rawAbs,
      '-vf', `scale=${W}:${H}:flags=lanczos,fps=24`,
      '-c:v', 'libx264', '-crf', '23', '-preset', 'medium', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', segAbs
    ])
    shot.segmentPath = `projects/${PID}/segments/${shot.id}.mp4`
    segPaths.push(segAbs)
    console.log(`  ${shot.id} 分段 OK (${elapsed()})`)
  }

  // 5. 合成 + 字幕 + BGM
  console.log('\n[5/6] 合成/字幕/BGM...')
  const finalAbs = join(pdir, 'final.mp4')
  await ffmpeg.concatSegments(segPaths, finalAbs)
  console.log(`  concat OK (${elapsed()})`)

  const srtRel = await subtitles.generate(project)
  const subAbs = join(pdir, 'final_subtitled.mp4')
  await ffmpeg.burnSubtitles(finalAbs, join(DATA_ROOT, srtRel), subAbs)
  console.log(`  字幕 OK (${elapsed()})`)

  const bgmAbs = join(pdir, 'final_bgm.mp4')
  await ffmpeg.mixBgm(subAbs, join(process.cwd(), 'test', 'bgm_test.mp3'), bgmAbs, 30)
  console.log(`  BGM OK (${elapsed()})`)

  // 6. 核验
  console.log('\n[6/6] 产物核验')
  let fail = 0
  const check = (name: string, ok: boolean, detail = ''): void => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
    if (!ok) fail++
  }
  const info = await ffmpeg.getVideoInfo(bgmAbs)
  check('成片含视频轨', info.width === W && info.height === H, `${info.width}x${info.height}`)
  check('成片含音频轨', info.hasAudio, `${info.durationSec.toFixed(1)}s`)
  check('成片时长 ≈ 4镜x5.17s', Math.abs(info.durationSec - 20.7) < 1.5, `${info.durationSec.toFixed(1)}s`)
  for (const shot of shots) {
    const v = await ffmpeg.getVideoInfo(join(DATA_ROOT, shot.segmentPath!))
    check(`${shot.id} 分段有音频`, v.hasAudio, `${v.durationSec.toFixed(2)}s`)
  }

  console.log(`\n===== ${fail === 0 ? '全部通过 ✅' : `失败 ${fail} 项 ❌`}  总耗时 ${elapsed()} =====`)
  console.log(`成片: ${bgmAbs}`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error('smoke 异常:', e); process.exit(1) })
