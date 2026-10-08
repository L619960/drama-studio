// 独立编排：驱动 DirectorAgent 跑完整流水线（analyze→casting→scenes→render·审批→combine→subtitle→review→bgm）
import { join } from 'node:path'
import { ProjectStore } from '../src/main/core/projectStore'
import { ComfyUIClient } from '../src/main/core/comfyuiClient'
import { TaskQueue } from '../src/main/core/taskQueue'
import { TTSService } from '../src/main/core/ttsService'
import { FFmpegService } from '../src/main/core/ffmpegService'
import { WorkflowLoader } from '../src/main/core/workflowLoader'
import { SettingsStore } from '../src/main/core/settingsStore'
import { LLMService } from '../src/main/core/llmService'
import { SubtitleService } from '../src/main/core/subtitleService'
import { ImageService } from '../src/main/core/imageService'
import { DirectorAgent } from '../src/main/core/directorAgent'
import { GENRE_TEMPLATES } from '../src/shared/ipcTypes'

// 与应用一致：DATA_ROOT = userData/drama-studio（stub 中 getPath 已指向 userData）
const USER_DATA = 'C:/Users/蒋奎/AppData/Roaming/drama-studio'
const DATA_ROOT = join(USER_DATA, 'drama-studio')

const SCRIPT = `《错嫁》
顾氏集团总裁办。顾晏辰（30岁，黑色西装，眉眼冷峻）坐在办公桌后，目光紧锁面前的女孩。
林薇薇（24岁，米色连衣裙，长发披肩）攥着背包带，低着头不敢看他。
顾总将一份合同推到她面前："签了它，你就是顾太太。"
薇薇猛地抬头："你凭什么觉得我会答应？"
他起身走近，居高临下地看着她："就凭你外婆的命，在我手里。"
女孩脸色一白，颤抖着拿起笔。他却按住合同，低声道："我改变主意了——先同居，再签字。"
她气极，挥起包砸向他，转身就跑。
那个男人没有追，只是望着她的背影，嘴角微微上扬。
当晚，一辆黑色迈巴赫停在薇薇出租屋楼下。司机恭敬地拉开车门，前台小姐窃窃私语。
她被"请"进了顾家别墅。男人在玄关等她，手里递来一杯温水。
薇薇别过脸，他却捏住她的下巴逼她看向自己："林薇薇，别想着逃。"
她含泪瞪着他，他的心莫名一软，伸手将她拥入怀中。`

async function main(): Promise<void> {
  const projectStore = new ProjectStore(join(DATA_ROOT, 'projects'))
  const settingsStore = new SettingsStore()
  const ttsService = new TTSService(DATA_ROOT)
  const ffmpegService = new FFmpegService()
  const workflowLoader = new WorkflowLoader(join(process.cwd(), 'workflows'))
  const comfyuiClient = new ComfyUIClient({ baseUrl: 'http://127.0.0.1:8188', clientId: 'drama-studio' })
  const taskQueue = new TaskQueue(DATA_ROOT, comfyuiClient, workflowLoader, ttsService, ffmpegService, projectStore, settingsStore)
  const llmService = new LLMService(() => settingsStore.get(), GENRE_TEMPLATES)
  const subtitleService = new SubtitleService(ffmpegService, DATA_ROOT)
  const imageService = new ImageService(comfyuiClient, workflowLoader)
  const director = new DirectorAgent(
    DATA_ROOT, projectStore, llmService, imageService,
    taskQueue, ffmpegService, subtitleService, settingsStore
  )

  director.on('progress', (e: { state: { stages: Record<string, { status: string; message: string; percent: number }> } }) => {
    const running = Object.entries(e.state.stages).filter(([, s]) => s.status === 'running')
    for (const [key, s] of running) {
      console.log(`[阶段][${key}] ${s.message} ${s.percent}%`)
    }
  })

  console.log('=== 启动 AI 导演完整流水线（含逐镜审批 + 成片复审）===')
  const projectId = await director.start({
    title: '错嫁',
    genre: '霸总',
    script: SCRIPT,
    bgmAbsolutePath: join(process.cwd(), 'test', 'bgm_test.mp3')
  })

  while (director.getState(projectId)?.running) {
    await new Promise(r => setTimeout(r, 3000))
  }

  const st = director.getState(projectId)!
  console.log('\n===== 流水线结果 =====')
  for (const [key, s] of Object.entries(st.stages)) {
    console.log(`${key.padEnd(9)}: ${s.status.padEnd(8)} ${s.message}`)
  }
  if (st.reviewIssues?.length) {
    console.log('复审意见:')
    st.reviewIssues.forEach(x => console.log(`  - ${x}`))
  }
  console.log('failedShotIds:', st.failedShotIds.join(',') || '无')
  console.log('finalPath:', st.finalPath || '未产出')
  process.exit(0)
}

main().catch((e) => {
  console.error('编排失败:', e)
  process.exit(1)
})
