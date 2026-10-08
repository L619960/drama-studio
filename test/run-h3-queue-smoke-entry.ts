/**
 * H3 主流水线冒烟：通过 TaskQueue（非独立脚本）验证 H3 引擎集成
 * 覆盖：模板列表可见 → buildGraph 类型化注入 → r2v 参考音频上传 → steps=10 → normalizeSegment 归一化
 * 镜头：1 个 r2v 台词镜（人物）+ 1 个 i2v 空镜（场景），验证自动分流
 * 运行：npx tsx test/run-h3-queue-smoke-entry.ts
 */
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { ComfyUIClient } from '../src/main/core/comfyuiClient'
import { WorkflowLoader } from '../src/main/core/workflowLoader'
import { TTSService } from '../src/main/core/ttsService'
import { FFmpegService } from '../src/main/core/ffmpegService'
import { ProjectStore } from '../src/main/core/projectStore'
import { SettingsStore } from '../src/main/core/settingsStore'
import { TaskQueue } from '../src/main/core/taskQueue'
import { GENRE_TEMPLATES } from '../src/shared/ipcTypes'
import type { Project } from '../src/shared/ipcTypes'

const DATA_ROOT = path.resolve(process.cwd(), 'test', '.e2e-data')
const COMFY = 'http://127.0.0.1:8188'
const WORKFLOWS = path.resolve(process.cwd(), 'workflows')
const ASSET_FRAMES = path.join(DATA_ROOT, 'projects', 'h3smoke_1791380281272', 'frames')

let passed = 0, failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`) }
  else { failed++; console.log(`  ❌ ${name} ${detail}`) }
}

async function main(): Promise<void> {
  console.log('===== H3 主流水线冒烟（taskQueue 集成）=====')
  const settings = new SettingsStore()
  const s = await settings.get()
  const origDefaultWorkflow = s.workflow.default
  // 全局默认切到 H3，验证 taskQueue 的引擎选择链路（结束后还原）
  s.workflow.default = 'minimax_h3_i2v'
  s.comfyui.baseUrl = COMFY
  await settings.save(s)

  const comfy = new ComfyUIClient({ baseUrl: COMFY, clientId: 'drama-studio-h3queue' })
  const workflow = new WorkflowLoader(WORKFLOWS)
  const tts = new TTSService(DATA_ROOT)
  const ffmpeg = new FFmpegService()
  const store = new ProjectStore(path.join(DATA_ROOT, 'projects'))

  console.log('--- 0. 前置：工作流列表含 H3 模板 ---')
  const list = await workflow.list()
  const names = list.map(w => w.name)
  check('list 包含 minimax_h3_i2v', names.includes('minimax_h3_i2v'))
  check('list 包含 minimax_h3_r2v', names.includes('minimax_h3_r2v'))

  console.log('--- 1. buildGraph 类型化注入 ---')
  const g = await workflow.buildGraph('minimax_h3_r2v', {
    PROMPT: 'test <d>[Chinese] 你好"世界"</d>', REF_IMAGE: 'a.png', AUDIO: 'a.mp3',
    SEED: 42, WIDTH: 512, HEIGHT: 896, LENGTH: 56, PREFIX: 'drama/test'
  }) as Record<string, { inputs: Record<string, unknown> }>
  const n30 = g['30'].inputs
  check('width 为数字 512', n30.width === 512, `实际 ${JSON.stringify(n30.width)}`)
  check('length 为数字 56', n30.length === 56, `实际 ${JSON.stringify(n30.length)}`)
  check('prompt 含中文引号未炸', String(n30.prompt).includes('你好"世界"'))
  check('seed 为数字 42', (g['40'].inputs.noise_seed as number) === 42)

  console.log('--- 2. 造测试项目（1 台词人物镜 + 1 空镜）---')
  const pid = `h3queue_${Date.now()}`
  const pdir = path.join(DATA_ROOT, 'projects', pid)
  await fs.mkdir(path.join(pdir, 'refs'), { recursive: true })
  await fs.copyFile(path.join(ASSET_FRAMES, 'contact.jpg'), path.join(pdir, 'refs', 'lead.jpg'))
  await fs.copyFile(path.join(ASSET_FRAMES, 's2_5.png'), path.join(pdir, 'refs', 'scene.png'))
  const project: Project = {
    id: pid, title: 'H3队列冒烟', genre: GENRE_TEMPLATES[0].key, episode: 1,
    status: 'draft', fps: 25, createdAt: Date.now(), updatedAt: Date.now(),
    characters: [{
      id: 'c1', name: '林晚', refImagePath: `projects/${pid}/refs/lead.jpg`,
      description: '女，28岁，冷艳医生', voice: 'zh-CN-XiaoxiaoNeural'
    }],
    shots: [
      {
        id: 's1', index: 1, scene: '手术室', type: 'i2v', characterIds: ['c1'],
        action: 'She turns around sharply, eyes cold.', dialogue: '手术刀放下，你没资格碰他。',
        width: 512, height: 896, frames: 81, seed: 42, status: 'pending', shotSize: 'closeup'
      },
      {
        id: 's2', index: 2, scene: '医院走廊', type: 't2v', characterIds: [],
        action: 'Empty hospital corridor, fluorescent lights flickering.',
        dialogue: '', width: 512, height: 896, frames: 49, seed: 42, status: 'pending',
        sceneImagePath: `projects/${pid}/refs/scene.png`, shotSize: 'wide'
      }
    ]
  }
  await fs.writeFile(path.join(pdir, 'project.json'), JSON.stringify(project, null, 2))

  const queue = new TaskQueue(DATA_ROOT, comfy, workflow, tts, ffmpeg, store, settings)
  queue.on('progress', e => {
    const p = e as { step: string; percent: number; message: string; shotId: string }
    console.log(`  >> [${p.shotId}] ${p.step} ${p.percent}% ${p.message}`)
  })

  console.log('--- 3. 真实渲染 2 镜（r2v + i2v 自动分流）---')
  await queue.start(pid)
  await queue.waitForFinish(pid)

  const after = await store.get(pid)
  const sh1 = after.shots.find(x => x.id === 's1')!
  const sh2 = after.shots.find(x => x.id === 's2')!
  check('s1(r2v 台词镜) 渲染完成', sh1.status === 'done', sh1.status)
  check('s1 有分段', Boolean(sh1.segmentPath))
  check('s1 有 TTS 音频', Boolean(sh1.audioPath))
  check('s2(i2v 空镜) 渲染完成', sh2.status === 'done', sh2.status)
  check('s2 有分段', Boolean(sh2.segmentPath))

  if (sh1.segmentPath) {
    const segAbs = path.join(DATA_ROOT, sh1.segmentPath)
    const st = await fs.stat(segAbs)
    check('s1 分段大小 > 500KB', st.size > 500 * 1024, `${(st.size / 1024).toFixed(0)}KB`)
    const dur = await ffmpeg.getDuration(segAbs)
    check('s1 分段时长 3~8s', dur > 3 && dur < 8, `${dur.toFixed(2)}s`)
  }

  console.log(`\n===== 结果: ${passed} 通过, ${failed} 失败 =====`)
  // 还原全局默认工作流
  const restore = await settings.get()
  restore.workflow.default = origDefaultWorkflow
  await settings.save(restore)
  if (failed > 0) process.exit(1)
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
