// P2 导演控制台冒烟：技能框架 CRUD + 对话 function-calling 工具循环
// 真实 LLM（读真实 settings.json），不触发任何渲染；数据隔离在 test/.e2e-data
import { join } from 'node:path'
import * as fs from 'node:fs/promises'
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
import { SkillService } from '../src/main/core/skillService'
import { ConversationService } from '../src/main/core/conversationService'
import { MemoryStore } from '../src/main/core/memoryStore'
import { GENRE_TEMPLATES, type ConversationToolEvent } from '../src/shared/ipcTypes'

const DATA_ROOT = join(process.cwd(), 'test', '.e2e-data')
const SCOPE = `smoke_${Date.now()}`

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true } catch { return false }
}

async function main(): Promise<void> {
  const failures: string[] = []
  const check = (name: string, cond: boolean, detail = ''): void => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
    if (!cond) failures.push(name)
  }

  console.log('=== 0. 环境自检 ===')
  const settings = new SettingsStore()
  const base = await settings.get()
  console.log(`LLM: ${base.llm.baseUrl} / ${base.llm.model} / key ${base.llm.apiKey ? '已配置' : '缺失'}`)
  if (!base.llm.apiKey) { console.error('缺少 LLM key，终止'); process.exit(1) }

  const projectStore = new ProjectStore(join(DATA_ROOT, 'projects'))
  const ttsService = new TTSService(DATA_ROOT)
  const ffmpegService = new FFmpegService()
  const workflowLoader = new WorkflowLoader(join(process.cwd(), 'workflows'))
  const comfyuiClient = new ComfyUIClient({ baseUrl: base.comfyui.baseUrl, clientId: 'conv-smoke' })
  const taskQueue = new TaskQueue(DATA_ROOT, comfyuiClient, workflowLoader, ttsService, ffmpegService, projectStore, settings)
  const llmService = new LLMService(() => settings.get(), GENRE_TEMPLATES)
  const subtitleService = new SubtitleService(ffmpegService, DATA_ROOT)
  const imageService = new ImageService(comfyuiClient, workflowLoader)
  const director = new DirectorAgent(
    DATA_ROOT, projectStore, llmService, imageService,
    taskQueue, ffmpegService, subtitleService, settings
  )
  const skillService = new SkillService(DATA_ROOT)
  const memoryStore = new MemoryStore(DATA_ROOT)
  const conversation = new ConversationService(
    DATA_ROOT, llmService, skillService, director,
    taskQueue, projectStore, comfyuiClient, workflowLoader, memoryStore, ffmpegService, settings
  )

  await conversation.clear(SCOPE)
  const toolEvents: ConversationToolEvent[] = []
  conversation.on('tool', (e: ConversationToolEvent) => {
    toolEvents.push(e)
    console.log(`  >> 工具事件 [${e.toolCall.status}] ${e.toolCall.label} ${e.toolCall.status === 'running' ? e.toolCall.argsText : ''}`)
  })

  console.log('\n=== 1. 技能框架 CRUD ===')
  const builtin = await skillService.list()
  check('内置技能 17 个', builtin.filter(s => s.builtin).length === 17, `${builtin.filter(s => s.builtin).length} 个`)
  check('内置技能默认启用', builtin.filter(s => s.builtin && s.enabled).length === 17)
  check('含 6 个创作型 prompt 技能', builtin.filter(s => s.builtin && s.kind === 'prompt').length === 6)
  check('skills.json 持久化', await exists(join(DATA_ROOT, 'skills.json')))

  let threwOnBuiltin = false
  try { await skillService.remove(builtin[0].id) } catch { threwOnBuiltin = true }
  check('内置技能不可删除', threwOnBuiltin)

  const created = await skillService.create({
    name: '古风润色师',
    description: '当用户要求把现代台词改写成古风、半文言风格时使用。',
    promptTemplate: '你是资深古风编剧，请把用户给出的台词改写为半文言风格，保留原意，只输出改写结果。台词：{{input}}'
  })
  check('自定义技能创建', created.kind === 'prompt' && !created.builtin && created.enabled)

  await skillService.update(created.id, { description: '改写后的描述' })
  const afterUpdate = (await skillService.list()).find(s => s.id === created.id)!
  check('自定义技能更新', afterUpdate.description === '改写后的描述')

  await skillService.toggle(created.id, false)
  check('技能可停用', !(await skillService.list()).find(s => s.id === created.id)!.enabled)
  await skillService.toggle(created.id, true)

  console.log('\n=== 2. 对话 A：工具调用（检查 ComfyUI）===')
  const t0 = Date.now()
  let msgs = await conversation.send(SCOPE, '请调用检查 ComfyUI 的工具，确认本地服务在不在线，然后用中文告诉我结果。')
  console.log(`  耗时 ${Math.round((Date.now() - t0) / 1000)}s，消息 ${msgs.length} 条，工具事件 ${toolEvents.length} 个`)
  const comfyEvents = toolEvents.filter(e => e.toolCall.name === 'get_comfyui_status')
  const comfyCall = comfyEvents[comfyEvents.length - 1]
  check('触发 get_comfyui_status 工具', comfyEvents.length > 0, `${comfyEvents.length} 个事件`)
  check('工具执行成功', comfyCall?.toolCall.status === 'done', comfyCall?.toolCall.result?.slice(0, 60) || '')
  const finalA = [...msgs].reverse().find(m => m.role === 'assistant' && m.content && !m.toolCalls?.length)
  check('有中文最终回复', !!finalA && finalA.content.length > 0, finalA?.content.slice(0, 60) || '')
  check('对话已持久化', (await conversation.list(SCOPE)).length === msgs.length)

  console.log('\n=== 3. 对话 B：纯聊天不调工具 ===')
  const beforeB = toolEvents.length
  msgs = await conversation.send(SCOPE, '用一句话介绍你能帮我做什么，不要调用任何工具。')
  const finalB = [...msgs].reverse().find(m => m.role === 'assistant' && m.content)
  const newCalls = toolEvents.length - beforeB
  console.log(`  回复：${finalB?.content.slice(0, 100)}`)
  check('本轮未调工具', newCalls === 0, `${newCalls} 次`)
  check('有回复内容', !!finalB && finalB.content.length > 0)

  console.log('\n=== 4. 对话 C：无项目时危险操作必须安全失败 ===')
  msgs = await conversation.send(SCOPE, '帮我把当前任务取消掉')
  const cancelCalls = toolEvents.filter(e => e.toolCall.name === 'cancel_director')
  if (cancelCalls.length) {
    const last = cancelCalls[cancelCalls.length - 1].toolCall
    const safe = last.status === 'error' && (last.result?.includes('没有打开的项目') ?? false)
    check('取消操作安全拦截', safe, last.result?.slice(0, 80) || '')
  } else {
    console.log('  （模型选择先追问而未调工具，安全语义同样满足）')
    check('取消操作安全拦截', true, '未调用')
  }

  console.log('\n=== 5. 对话 D：沉淀长期记忆并注入上下文 ===')
  const beforeD = toolEvents.length
  msgs = await conversation.send(SCOPE, '请记住一条用户偏好：台词风格要口语化，避免书面腔和成语堆砌。用沉淀记忆的工具保存。')
  const saveCalls = toolEvents.slice(beforeD).filter(e => e.toolCall.name === 'save_memory' && e.toolCall.status === 'done')
  check('触发 save_memory 工具', saveCalls.length > 0, `${toolEvents.length - beforeD} 个工具事件`)
  const mems = await memoryStore.list('preference')
  const hit = mems.find(m => m.content.includes('口语化'))
  check('记忆已落盘', !!hit, hit?.title || '')
  const summary = await memoryStore.summary()
  check('记忆摘要可注入 system prompt', summary.includes('口语化'))
  if (hit) await memoryStore.remove(hit.id)

  console.log('\n=== 6. 自定义技能清理 ===')
  await skillService.remove(created.id)
  check('自定义技能可删除', !(await skillService.list()).some(s => s.id === created.id))
  await conversation.clear(SCOPE)
  check('会话可清空', (await conversation.list(SCOPE)).length === 0)

  console.log('\n===== 汇总 =====')
  if (failures.length === 0) {
    console.log('全部通过 ✅')
    process.exit(0)
  } else {
    console.log(`失败 ${failures.length} 项 ❌\n` + failures.map(f => `  - ${f}`).join('\n'))
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('smoke 脚本异常:', e)
  process.exit(1)
})
