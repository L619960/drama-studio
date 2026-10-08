// 无界面单镜流水线验证：TTS → 上传参考图 → wan22_i2v 渲染 → 下载原片 → ffmpeg 合成分段 → 缩略图
// 产物全部写入 test/.e2e-data（可随时整目录删除）
import { join } from 'node:path'
import * as fs from 'node:fs/promises'
import { ProjectStore } from '../src/main/core/projectStore'
import { ComfyUIClient } from '../src/main/core/comfyuiClient'
import { TaskQueue } from '../src/main/core/taskQueue'
import { TTSService } from '../src/main/core/ttsService'
import { FFmpegService } from '../src/main/core/ffmpegService'
import { WorkflowLoader } from '../src/main/core/workflowLoader'
import { SettingsStore } from '../src/main/core/settingsStore'
import type { ProgressEvent } from '../src/shared/ipcTypes'

const DATA_ROOT = join(process.cwd(), 'test', '.e2e-data')
const COMFY_URL = 'http://127.0.0.1:8188'
const WORKFLOW = 'wan22_i2v'

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function sizeMb(p: string): Promise<number> {
  const s = await fs.stat(p)
  return Math.round((s.size / 1024 / 1024) * 100) / 100
}

async function main(): Promise<void> {
  const failures: string[] = []
  const check = (name: string, cond: boolean, detail = ''): void => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
    if (!cond) failures.push(name)
  }

  console.log('=== 0. 环境自检 ===')
  const projectStore = new ProjectStore(join(DATA_ROOT, 'projects'))
  const settingsStore = new SettingsStore()
  const ttsService = new TTSService(DATA_ROOT)
  const ffmpegService = new FFmpegService()
  const workflowLoader = new WorkflowLoader(join(process.cwd(), 'workflows'))
  const comfyuiClient = new ComfyUIClient({ baseUrl: COMFY_URL, clientId: 'drama-studio-e2e' })
  const taskQueue = new TaskQueue(
    DATA_ROOT, comfyuiClient, workflowLoader, ttsService, ffmpegService, projectStore, settingsStore
  )

  await ffmpegService.ready()
  console.log('ffmpeg 二进制就绪')

  const healthy = await comfyuiClient.healthCheck()
  check('ComfyUI 在线', healthy, COMFY_URL)
  if (!healthy) {
    console.error('ComfyUI 不在线，终止验证')
    process.exit(1)
  }

  const metas = await workflowLoader.list()
  const meta = metas.find(m => m.name === WORKFLOW)
  check('wan22_i2v 模板存在', Boolean(meta), meta ? `占位符: ${meta.placeholders.join(',')}` : '缺失')

  // === 1. 构造测试项目（1 个角色 + 1 个带台词的 i2v 镜头，17 帧 → DURATION=1s，最快出片）===
  console.log('\n=== 1. 构造测试数据 ===')
  const project = await projectStore.create('无界面流水线验证', '霸总')
  const charId = `char_e2e_${Date.now()}`
  const charExt = '.png'
  const charImgRel = `projects/${project.id}/characters/${charId}${charExt}`
  await fs.copyFile(join(process.cwd(), 'workflows', 'test.png'), join(DATA_ROOT, charImgRel))
  project.characters.push({
    id: charId,
    name: '测试女主',
    refImagePath: charImgRel,
    description: '年轻女性，白色连衣裙',
    voice: 'zh-CN-XiaoxiaoNeural'
  })
  const shotId = `shot_e2e_${Date.now()}`
  project.shots.push({
    id: shotId,
    index: 1,
    scene: '总裁办公室，落地窗，午后阳光',
    action: 'a young woman in white dress turns around and smiles gently at the camera, cinematic medium shot, soft window light',
    dialogue: '你好，这是流水线测试。',
    characterIds: [charId],
    type: 'i2v',
    width: 720,
    height: 480,
    frames: 17, // DURATION = round((17-1)/16) = 1 秒
    seed: 20261007,
    status: 'pending'
  })
  await projectStore.save(project)
  console.log(`projectId=${project.id} shotId=${shotId}`)

  // buildGraph 预检查：占位符全部替换（提前暴露模板/加载器问题，不占用 GPU）
  const graph = await workflowLoader.buildGraph(WORKFLOW, {
    PROMPT: 'test prompt',
    REF_IMAGE: 'test.png',
    SEED: 20261007,
    DURATION: 1
  }) as Record<string, { inputs: Record<string, unknown> }>
  const graphStr = JSON.stringify(graph)
  check('buildGraph 无残留占位符', !/\$[A-Z_]+\$/.test(graphStr))
  const intNode = graph['27']
  check('DURATION 已注入节点#27', String(intNode?.inputs.value) === '1', `value=${JSON.stringify(intNode?.inputs.value)}`)
  check('REF_IMAGE 已注入 LoadImage', graphStr.includes('"image":"test.png"'))

  // === 2. 启动渲染队列 ===
  console.log('\n=== 2. 启动 TaskQueue（TTS→上传→渲染→合成）===')
  const stepTimes: Record<string, number> = {}
  taskQueue.on('progress', (e: ProgressEvent) => {
    const now = Date.now()
    if (!(e.step in stepTimes)) stepTimes[e.step] = now
    console.log(`[${e.shotId}] ${e.step.padEnd(8)} ${String(e.percent).padStart(3)}%  ${e.message}`)
  })

  const startedAt = Date.now()
  await taskQueue.start(project.id, [shotId])
  await taskQueue.waitForFinish(project.id)
  const elapsed = Math.round((Date.now() - startedAt) / 1000)
  console.log(`\n队列结束，总耗时 ${elapsed}s`)

  // === 3. 结果核验 ===
  console.log('\n=== 3. 产物核验 ===')
  const done = await projectStore.get(project.id)
  const shot = done.shots.find(s => s.id === shotId)!
  check('镜头状态 done', shot.status === 'done', shot.error || '')

  const audioAbs = join(DATA_ROOT, 'projects', project.id, 'audio', `${shotId}.mp3`)
  const rawAbs = join(DATA_ROOT, 'projects', project.id, 'raw', `${shotId}.mp4`)
  const segAbs = join(DATA_ROOT, 'projects', project.id, 'segments', `${shotId}.mp4`)
  const thumbAbs = join(DATA_ROOT, 'projects', project.id, 'thumbnail.jpg')

  if (await exists(audioAbs)) check('TTS 音频存在', true, `${await sizeMb(audioAbs)}MB`)
  else check('TTS 音频存在', false)

  if (await exists(rawAbs)) check('ComfyUI 原片存在', true, `${await sizeMb(rawAbs)}MB`)
  else check('ComfyUI 原片存在', false)

  if (await exists(segAbs)) {
    const mb = await sizeMb(segAbs)
    check('合成分段存在且非空', mb > 0.01, `${mb}MB`)
    try {
      const info = await ffmpegService.getVideoInfo(segAbs)
      check('分段含视频轨', info.width > 0 && info.height > 0, `${info.width}x${info.height}`)
      check('分段含音频轨', info.hasAudio)
      const audioDur = await ffmpegService.getDuration(audioAbs)
      check('分段时长覆盖台词', info.durationSec + 0.4 >= audioDur, `视频${info.durationSec.toFixed(2)}s / 音频${audioDur.toFixed(2)}s`)
      const blank = await ffmpegService.looksLikeBlankVideo(segAbs)
      check('分段非黑帧/纯色', !blank)
    } catch (e) {
      check('ffprobe 解析分段', false, (e as Error).message)
    }
  } else {
    check('合成分段存在且非空', false)
  }

  check('项目缩略图存在', await exists(thumbAbs))
  check('项目状态 done', done.status === 'done', `status=${done.status}`)

  console.log('\n===== 验证汇总 =====')
  if (failures.length === 0) {
    console.log(`全部通过 ✅  数据目录: ${DATA_ROOT}`)
    process.exit(0)
  } else {
    console.log(`失败 ${failures.length} 项 ❌:`)
    failures.forEach(f => console.log(`  - ${f}`))
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('验证脚本异常:', e)
  process.exit(1)
})
