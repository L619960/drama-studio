import { app, BrowserWindow, ipcMain, dialog, shell, protocol } from 'electron'
import { join, resolve, sep, isAbsolute, extname, dirname } from 'node:path'
import * as fs from 'node:fs/promises'
import { realpathSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  IpcChannels,
  type Project,
  type ProgressEvent,
  type AppSettings,
  type DirectorProgressEvent,
  type DirectorStage,
  type DirectorLogEvent,
  type DirectorStartInput,
  type ConversationToolEvent,
  type Skill,
  type MemoryItem,
  type MemoryKind,
  type AssetRegenerateInput,
  type PromptAssistInput,
  type PromptBulkFillInput,
  type PromptBulkFillFieldResult,
  type PromptBulkFillResult,
  type PromptBulkFillProgress
} from '../shared/ipcTypes'
import { ProjectStore } from './core/projectStore'
import { reviewedIsValid } from '../shared/pipelineGuards'
import { handleIpc } from './ipc/shared'
import { registerProjectIpc } from './ipc/project'
import { registerRenderIpc } from './ipc/render'
import { registerComfyIpc, validateWorkflowTemplates } from './ipc/comfy'
import { registerFfmpegIpc } from './ipc/ffmpeg'
import { registerFileShellIpc } from './ipc/fileShell'
import { registerTtsIpc } from './ipc/tts'
import { registerAssetIpc } from './ipc/asset'
import { registerPromptIpc } from './ipc/prompt'
import { registerSkillIpc } from './ipc/skill'
import { registerConversationIpc } from './ipc/conversation'
import { registerSystemIpc } from './ipc/system'
import { registerWorkflowIpc } from './ipc/workflow'
import { registerSettingsIpc } from './ipc/settings'
import { registerLlmIpc } from './ipc/llm'
import { registerDialogIpc } from './ipc/dialog'
import { ComfyUIClient } from './core/comfyuiClient'
import { TaskQueue } from './core/taskQueue'
import { TTSService } from './core/ttsService'
import { FFmpegService } from './core/ffmpegService'
import { WorkflowLoader } from './core/workflowLoader'
import { WorkflowLibrary } from './core/workflowLibrary'
import { SettingsStore } from './core/settingsStore'
import { LLMService, type FillPromptContext } from './core/llmService'
import { SubtitleService } from './core/subtitleService'
import { ImageService } from './core/imageService'
import { CandidatePickService } from './core/candidatePickService'
import { DirectorAgent } from './core/directorAgent'
import { SkillService } from './core/skillService'
import { SkillLibrary } from './core/skillLibrary'
import { ConversationService } from './core/conversationService'
import { ComfyMcpService } from './core/comfyMcpService'
import { MemoryStore } from './core/memoryStore'
import { SelfCheckService } from './core/selfCheckService'
import { GENRE_TEMPLATES, normalizeSceneKey } from '../shared/ipcTypes'
import {
  faceCastingPrompt,
  bodySheetPrompt,
  scenePlatePrompt,
  shotFramePrompt,
  shotSizeCueFor,
  sceneNegativeFor,
  mergeNegative, REALISM_NEGATIVE,
  stripDialogueDirections
} from '../shared/imagePrompts'
import { resolveCreation } from '../shared/creationSettings'
import { applyAutoFixes, auditProjectPrompts, fillableFieldsOf, assignField } from '../shared/promptAudit'
import { installGlobalErrorHandlers } from './core/errorHandler'
import { childProcessManager } from './core/childProcessManager'

// ===== 全局异常兜底：未捕获的 Promise rejection / 同步异常落盘，防主进程静默崩溃 =====
// 实现抽离到 ./core/errorHandler.ts（便于单测）；这里只负责接入 userData/logs 目录。
installGlobalErrorHandlers(join(app.getPath('userData'), 'logs'))

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
// 开发态开启 CDP 调试口，便于自动化测试工具（Playwright 等）连接操作窗口。
// 2026-10-25 修复（专家D P2）：优先尊重命令行传入的 --remote-debugging-port
// （restart-app.ps1 传 9225）——此前 appendSwitch 无条件用 9222 覆盖命令行参数，
// 脚本每次启动都白等 9225 打 WARN（端口实为 9222 就绪）。优先级：CLI 参数 > DS_CDP_PORT > 9222
if (isDev) {
  const cliPort = app.commandLine.getSwitchValue('remote-debugging-port')
  app.commandLine.appendSwitch('remote-debugging-port', cliPort || process.env.DS_CDP_PORT || '9222')
}

/**
 * 单实例锁：杜绝多个实例同时运行。
 * 多实例会争抢 ComfyUI/调试端口，并互相覆盖 settings.json 与项目数据（曾导致
 * 调试端口失效、项目被错误实例覆盖）。拿不到锁的后续实例直接退出；
 * 已运行的实例收到 second-instance 时聚焦已有窗口。
 */
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
}
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

/**
 * Electron 原生本地媒体协议（必须在 app ready 之前注册）。
 * stream:true 才能给 <video> 做 Range 拖动；bypassCSP 避免开发态 http 源拦截。
 * URL：app-file://local/projects/<id>/final_master.mp4
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true
    }
  }
])

/** 相对 DATA_ROOT 路径 → 窗口内 <video> 用的 app-file URL */
function toAppFileUrl(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  const pathPart = normalized.split('/').map(encodeURIComponent).join('/')
  return `app-file://local/${pathPart}`
}

// 统一数据根目录：userData/drama-studio
// ProjectStore 的 projects 目录 = DATA_ROOT/projects
// 相对路径（如 projects/<id>/segments/x.mp4）一律相对 DATA_ROOT 解析
const DATA_ROOT = join(app.getPath('userData'), 'drama-studio')
const DATA_ROOT_RESOLVED = resolve(DATA_ROOT)
// 真实根路径：DATA_ROOT 若在磁盘上是 symlink/junction，词法比对会被绕过（I-8）
const DATA_ROOT_REAL = (() => {
  try {
    return resolve(realpathSync(DATA_ROOT_RESOLVED))
  } catch {
    return DATA_ROOT_RESOLVED
  }
})()

const normPath = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)

/**
 * 安全路径解析：相对路径相对 DATA_ROOT；绝对路径（旧数据兼容）也必须位于
 * DATA_ROOT 之内。防止目录穿越访问数据目录之外的文件。
 * I-8：已存在的路径用 realpath 比对识别符号链接逃逸（不存在则词法比对）；
 * Windows 下大小写不敏感。
 */
function resolveInsideRoot(inputPath: string): string {
  const abs = resolve(
    isAbsolute(inputPath) ? inputPath : join(DATA_ROOT, inputPath)
  )
  let real = abs
  try {
    real = resolve(realpathSync(abs))
  } catch {
    // 目标尚不存在（待创建的输出文件）：按词法路径校验
  }
  const target = normPath(real)
  const root = normPath(DATA_ROOT_REAL)
  const rootPrefix = root.endsWith(sep) ? root : root + sep
  if (target !== root && !target.startsWith(rootPrefix)) {
    throw new Error('非法路径：已拒绝数据根目录之外的访问')
  }
  return abs
}

/** 会话标识白名单：scope 直接拼文件名，主进程入口先挡一轮（I-13，服务层另有兜底） */
function assertScope(scope: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(scope)) {
    throw new Error('非法会话标识')
  }
}

let mainWindow: BrowserWindow | null = null

/** 进度/日志等事件统一经此转发：窗口已销毁时静默丢弃，避免对已销毁窗口调用 send 抛错中断渲染任务 */
function sendToWindow(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

const rawIpcHandle = ipcMain.handle.bind(ipcMain)

/**
 * IPC 统一包装见 ./ipc/shared.handleIpc（2026-10-25 合并：此处本地副本已删除，
 * 避免与 shared.ts:84 双份维护——专家A P2-4）。
 */

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload 仅使用 contextBridge/ipcRenderer，满足沙箱约束（I-5）
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // 关闭后置空引用，配合 sendToWindow 防止对已销毁窗口发事件
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    return { action: 'deny' }
  })

  // 导航锁定：阻止页面被引导跳转到外部站点（I-6）
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith('file://')
    if (!allowed) event.preventDefault()
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 初始化核心服务
const projectStore = new ProjectStore() // projects 目录 = DATA_ROOT/projects

/** 读取项目：参数非法/项目不存在时抛业务可读错误。
 *  直接 get() 会抛 ENOENT 并把数据根绝对路径透传到渲染层，这里统一兜住。 */
async function loadProjectOrThrow(projectId: unknown): Promise<Project> {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('非法项目标识')
  try {
    const project = await projectStore.get(projectId)
    if (project) return project
  } catch {
    // project.json 不存在或不可读：一律按「项目不存在」处理
  }
  throw new Error('项目不存在或已被删除，请刷新项目列表后重试')
}
const settingsStore = new SettingsStore()
// 资源目录（workflows/skills）：dev 下优先 app.getAppPath()（项目根，比 cwd 可靠），打包后优先 resources；
// 多候选按存在性兜底——单一路径判定失准会让工作流/技能库整体找不到，进而整条渲染链全量失败。
const resolveResourceDir = (sub: string): string => {
  const order = app.isPackaged
    ? [join(process.resourcesPath, sub), join(app.getAppPath(), sub), join(process.cwd(), sub)]
    : [join(app.getAppPath(), sub), join(process.cwd(), sub), join(process.resourcesPath, sub)]
  for (const dir of order) {
    if (existsSync(dir)) return dir
  }
  return order[0]
}
const workflowDir = resolveResourceDir('workflows')
const workflowLoader = new WorkflowLoader(workflowDir)
// ComfyUI 工作流库（用户收集的 UI 格式工作流全集）：目录可配置（settings.comfyui.workflowLibraryDir），
// 默认本机秋叶整合包工作流库路径；扫描不到时降级为空库（不影响其他功能）
const workflowLibrary = new WorkflowLibrary('D:\\ComfyUI-V20\\ComfyUI\\user\\default\\was-node-suite\\workflows')
// 从设置中读取 ComfyUI 地址（启动时异步加载，先默认后覆盖）
const comfyuiClient = new ComfyUIClient({ baseUrl: 'http://127.0.0.1:8188', clientId: 'drama-studio' })
// 仅初始化时序：原先下方两次 settingsStore.get() 各读一次 settings.json，合并为一次读取，
// 减少冷启动时的重复 fs 读；副作用与触发时机不变（都在 settings 异步就绪后各自应用）。
settingsStore.get().then(s => {
  if (s.comfyui?.workflowLibraryDir) workflowLibrary.setLibDir(s.comfyui.workflowLibraryDir)
  if (s.comfyui.baseUrl) comfyuiClient.setBaseUrl(s.comfyui.baseUrl).catch(() => {})
}).catch(() => {})
const ttsService = new TTSService(DATA_ROOT, comfyuiClient, workflowLoader)
const ffmpegService = new FFmpegService()

const llmService = new LLMService(() => settingsStore.get(), GENRE_TEMPLATES)
const skillLibrary = new SkillLibrary(resolveResourceDir('skills'))
const taskQueue = new TaskQueue(
  DATA_ROOT, comfyuiClient, workflowLoader, ttsService, ffmpegService, projectStore, settingsStore, llmService
)
const subtitleService = new SubtitleService(ffmpegService, DATA_ROOT)
const imageService = new ImageService(comfyuiClient, workflowLoader)
// 技能库电影级条款预热已后移至 app.whenReady 的首绘后延迟块（仅初始化时序）：
// 首绘不依赖 rules.json，渲染启动时 taskQueue 会强制重读；此处不再于模块顶层抢 fs。
const candidatePicker = new CandidatePickService(llmService)
const directorAgent = new DirectorAgent(
  DATA_ROOT, projectStore, llmService, imageService,
  taskQueue, ffmpegService, subtitleService, settingsStore, skillLibrary
)
const skillService = new SkillService(DATA_ROOT)
const memoryStore = new MemoryStore(DATA_ROOT)
const comfyMcpService = new ComfyMcpService(settingsStore)
const conversationService = new ConversationService(
  DATA_ROOT, llmService, skillService, directorAgent,
  taskQueue, projectStore, comfyuiClient, workflowLoader, memoryStore, ffmpegService, settingsStore,
  skillLibrary, workflowLibrary, comfyMcpService
)
const selfCheckService = new SelfCheckService(
  DATA_ROOT, projectStore, skillService, workflowLoader,
  ffmpegService, comfyuiClient, settingsStore
)

// IPC 注册：对话框会话登记（dialogSavedFiles/dialogSelectedDirs/hasDialogSession）
// 统一迁移到 ./ipc/dialogSessions.ts 模块单例，由 dialog.ts 写入、fileShell/workflow/
// ffmpeg/tts/llm/imageGenerate 等消费方读取，行为与内联版一致（10 分钟 TTL）。

function registerIpc(): void {
  // ===== IPC 模块接线（原死代码复活）：16 个 registerXxxIpc 统一注册，
  // 替代原 1100 行内联 handleIpc。ctx 直接复用上方装配好的服务实例，模块签名不做改动。
  registerProjectIpc({ projectStore, conversationService, subtitleService })
  registerRenderIpc({ projectStore, settingsStore, directorAgent, taskQueue, llmService })
  registerComfyIpc({ comfyuiClient, workflowLoader, settingsStore })
  registerFfmpegIpc({ ffmpegService, settingsStore })
  registerFileShellIpc({ ffmpegService, settingsStore })
  registerTtsIpc({ ttsService })
  registerAssetIpc({ projectStore, settingsStore, comfyuiClient, imageService, candidatePicker })
  registerPromptIpc({ projectStore, llmService })
  registerSkillIpc({ skillService, memoryStore })
  registerConversationIpc({ conversationService })
  registerSystemIpc({ selfCheckService })
  registerWorkflowIpc({ workflowLoader })
  registerSettingsIpc({ settingsStore, comfyuiClient, imageService })
  registerLlmIpc({ llmService, ffmpegService })
  registerDialogIpc()

  // directorClearState：前端切换/关闭项目时清理主进程残留状态，防幽灵流水线与监听器泄漏
  handleIpc(IpcChannels.directorClearState, (_, projectId: unknown) => {
    if (typeof projectId === 'string' && projectId.trim()) directorAgent.clearState(projectId)
  })

  taskQueue.on('progress', (event: ProgressEvent) => {
    sendToWindow(IpcChannels.progress, event)
  })

  // AI 导演进度事件转发
  directorAgent.on('progress', (event: DirectorProgressEvent) => {
    sendToWindow(IpcChannels.directorProgress, event)
  })
  directorAgent.on('log', (event: DirectorLogEvent) => {
    sendToWindow(IpcChannels.directorLog, event)
  })
  // 项目数据落盘（定妆/首帧/场景板/逐镜渲染）→ 通知前端刷新面板
  directorAgent.on('projectUpdated', (event: { projectId: string }) => {
    sendToWindow(IpcChannels.directorProjectUpdated, event)
  })
  conversationService.on('tool', (event: ConversationToolEvent) => {
    sendToWindow(IpcChannels.conversationTool, event)
  })
}

app.whenReady().then(() => {
  // Electron 原生文件协议：直接把本地 mp4 映射给渲染进程 <video>（含 Range）
  protocol.registerFileProtocol('app-file', (request, callback) => {
    try {
      const u = new URL(request.url)
      // app-file://local/projects/... → pathname=/projects/...
      let rel = decodeURIComponent(u.pathname || '')
      if (rel.startsWith('/')) rel = rel.slice(1)
      if (!rel) {
        callback({ error: -6 })
        return
      }
      callback({ path: resolveInsideRoot(rel) })
    } catch {
      callback({ error: -6 })
    }
  })

  registerIpc()
  createWindow()

  // 仅初始化时序：以下两项均与「首屏 hydration」抢主进程事件循环 / fs，故推迟到窗口首绘后再跑。
  //  - 断点续渲：store.list() 全量读 project.json，并对 rendering 项目 store.save() 写回；
  //    与渲染层首屏的项目拉取/对话历史 IPC 同时刻读盘会互相拖慢。
  //  - 技能库电影级条款预热：rules.json → taskQueue/imageService.qualityBlock；首屏不依赖，
  //    渲染启动时 taskQueue 会强制重读 rules.json。
  // 二者错误语义均不变（recoverStaleRenders 自身 try/catch 兜底；skillLibrary.load 永不 reject，
  // 失败降级为代码层默认条款）。
  let deferredStartupDone = false
  const runDeferredStartup = (): void => {
    if (deferredStartupDone) return
    deferredStartupDone = true
    // 断点续渲：恢复上次崩溃/退出时残留在 rendering 的孤儿镜头（不阻塞窗口与其他启动逻辑）
    // recoverStaleRenders 内部会先清 ComfyUI 残留任务（应用重启但 ComfyUI 未重启时，
    // 上次提交的旧任务可能仍在排队/运行——统一中断+清队，避免后台白渲旧镜头）
    void taskQueue.recoverStaleRenders()
    // 导演状态恢复：把 director-state.json 里残留 running=true 的项目降级为 error，
    // 避免 UI 永久转圈、断点续跑入口被锁死。不自动重启流水线（需 ComfyUI 在跑）。
    void directorAgent.recoverAll().catch(() => undefined)
    void skillLibrary.load().then((r) => {
      if (r) {
        const qb = [
          ...r.cinematicQuality.quality,
          ...r.cinematicQuality.camera,
          ...r.cinematicQuality.lighting,
          ...r.cinematicQuality.fx,
          ...r.cinematicQuality.scene
        ].join(', ')
        taskQueue.qualityBlock = qb
        imageService.qualityBlock = qb
      }
    })
  }
  if (mainWindow) {
    // ready-to-show → show 触发首绘后再跑后台扫描，让 hydration IPC 先拿到事件循环
    mainWindow.once('show', runDeferredStartup)
    // 兜底：极端情况下 ready-to-show 未触发，5s 后也执行，避免断点续渲/条款预热永远不跑
    setTimeout(runDeferredStartup, 5000)
  } else {
    runDeferredStartup()
  }

  // 每日一次的导演自主学习：延迟 45s 等 LLM/网络就绪，learnState.json 保证当天只学一轮
  setTimeout(() => {
    conversationService.ensureDailyAutoLearn().catch(() => undefined)
  }, 45_000)

  // 非阻塞连接 ComfyUI WebSocket；失败由 waitForCompletion 的轮询兜底
  comfyuiClient.connect().catch(() => {})

  // 启动后静默做一次工作流环境自检（等 ComfyUI 就绪），有缺失才在主进程日志告警
  setTimeout(() => {
    (async () => {
      if (!await comfyuiClient.healthCheck()) return
      try {
        const reports = await validateWorkflowTemplates(comfyuiClient, workflowLoader)
        for (const r of reports) {
          for (const issue of r.issues) {
            console.warn(`[环境自检] ${r.workflow}: ${issue.message}`)
          }
        }
      } catch {
        // 自检失败不打扰用户，可在控制台手动触发
      }
    })().catch(() => undefined)
  }, 15_000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let quitting = false
app.on('before-quit', async (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  try {
    // 优雅退出：先取消运行中的导演流水线与渲染队列（写盘状态落稳），
    // 再断 ComfyUI WebSocket，最后 MCP 子进程。5s 超时仍未收尾则强制退出——
    // 不能让渲染中断不干净把用户锁死在退出流程里。
    const latest = directorAgent.getLatestState()
    if (latest && latest.running) {
      await directorAgent.cancel(latest.projectId).catch(() => undefined)
    }
    await taskQueue.cancelAll().catch(() => undefined)
    comfyuiClient.disconnect()
    // 统一 kill 所有登记的子进程（ffmpeg/TTS SAPI/转换），防退出后孤儿进程残留
    childProcessManager.killAll('before-quit')
    await Promise.race([
      (async () => {
        await comfyMcpService.dispose().catch(() => undefined)
      })(),
      new Promise(resolve => setTimeout(resolve, 5000))
    ])
  } finally {
    app.exit(0)
  }
})
