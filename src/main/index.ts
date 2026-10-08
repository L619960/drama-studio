import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { join, resolve, sep, isAbsolute, extname } from 'node:path'
import * as fs from 'node:fs/promises'
import {
  IpcChannels,
  type Project,
  type ProgressEvent,
  type AppSettings,
  type DirectorProgressEvent,
  type DirectorLogEvent,
  type DirectorStartInput,
  type ConversationToolEvent,
  type Skill,
  type MemoryItem,
  type MemoryKind
} from '../shared/ipcTypes'
import { ProjectStore } from './core/projectStore'
import { ComfyUIClient } from './core/comfyuiClient'
import { TaskQueue } from './core/taskQueue'
import { TTSService } from './core/ttsService'
import { FFmpegService } from './core/ffmpegService'
import { WorkflowLoader } from './core/workflowLoader'
import { SettingsStore } from './core/settingsStore'
import { LLMService } from './core/llmService'
import { SubtitleService } from './core/subtitleService'
import { ImageService } from './core/imageService'
import { DirectorAgent } from './core/directorAgent'
import { SkillService } from './core/skillService'
import { ConversationService } from './core/conversationService'
import { MemoryStore } from './core/memoryStore'
import { GENRE_TEMPLATES } from '../shared/ipcTypes'

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

// 统一数据根目录：userData/drama-studio
// ProjectStore 的 projects 目录 = DATA_ROOT/projects
// 相对路径（如 projects/<id>/segments/x.mp4）一律相对 DATA_ROOT 解析
const DATA_ROOT = join(app.getPath('userData'), 'drama-studio')
const DATA_ROOT_RESOLVED = resolve(DATA_ROOT)

/**
 * 安全路径解析：相对路径相对 DATA_ROOT；绝对路径（旧数据兼容）也必须位于
 * DATA_ROOT 之内。防止目录穿越访问数据目录之外的文件。
 */
function resolveInsideRoot(inputPath: string): string {
  const abs = resolve(
    isAbsolute(inputPath) ? inputPath : join(DATA_ROOT, inputPath)
  )
  if (abs !== DATA_ROOT_RESOLVED && !abs.startsWith(DATA_ROOT_RESOLVED + sep)) {
    throw new Error('非法路径：已拒绝数据根目录之外的访问')
  }
  return abs
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    return { action: 'deny' }
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 初始化核心服务
const projectStore = new ProjectStore() // projects 目录 = DATA_ROOT/projects
const settingsStore = new SettingsStore()
const ttsService = new TTSService(DATA_ROOT)
const ffmpegService = new FFmpegService()
// 开发期工作流目录在项目根；打包后随 resources 分发
const workflowDir = app.isPackaged ? join(process.resourcesPath, 'workflows') : join(process.cwd(), 'workflows')
const workflowLoader = new WorkflowLoader(workflowDir)

// 从设置中读取 ComfyUI 地址（启动时异步加载，先默认后覆盖）
const comfyuiClient = new ComfyUIClient({ baseUrl: 'http://127.0.0.1:8188', clientId: 'drama-studio' })
settingsStore.get().then(s => {
  if (s.comfyui.baseUrl) comfyuiClient.setBaseUrl(s.comfyui.baseUrl).catch(() => {})
}).catch(() => {})

const taskQueue = new TaskQueue(DATA_ROOT, comfyuiClient, workflowLoader, ttsService, ffmpegService, projectStore, settingsStore)
const llmService = new LLMService(() => settingsStore.get(), GENRE_TEMPLATES)
const subtitleService = new SubtitleService(ffmpegService, DATA_ROOT)
const imageService = new ImageService(comfyuiClient, workflowLoader)
const directorAgent = new DirectorAgent(
  DATA_ROOT, projectStore, llmService, imageService,
  taskQueue, ffmpegService, subtitleService, settingsStore
)
const skillService = new SkillService(DATA_ROOT)
const memoryStore = new MemoryStore(DATA_ROOT)
const conversationService = new ConversationService(
  DATA_ROOT, llmService, skillService, directorAgent,
  taskQueue, projectStore, comfyuiClient, workflowLoader, memoryStore, ffmpegService, settingsStore
)

// IPC 注册
function registerIpc(): void {
  // Project
  ipcMain.handle(IpcChannels.projectList, () => projectStore.list())
  ipcMain.handle(IpcChannels.projectCreate, (_, { title, genre }: { title: string; genre: string }) => projectStore.create(title, genre))
  ipcMain.handle(IpcChannels.projectGet, (_, id: string) => projectStore.get(id))
  ipcMain.handle(IpcChannels.projectSave, (_, project: Project) => projectStore.save(project))
  ipcMain.handle(IpcChannels.projectDelete, (_, id: string) => projectStore.delete(id))
  ipcMain.handle(IpcChannels.projectDuplicate, (_, id: string) => projectStore.duplicate(id))
  ipcMain.handle(IpcChannels.projectImportBgm, (_, projectId: string) => projectStore.importBgm(projectId))

  // Character
  ipcMain.handle(IpcChannels.characterImport, (_, projectId: string) => projectStore.importCharacterImage(projectId))

  // Render
  ipcMain.handle(IpcChannels.renderStart, (_, { projectId, shotIds }: { projectId: string; shotIds?: string[] }) => taskQueue.start(projectId, shotIds))
  ipcMain.handle(IpcChannels.renderCancel, (_, { projectId, shotId }: { projectId: string; shotId?: string }) =>
    taskQueue.cancel(projectId, shotId)
  )

  // ComfyUI
  ipcMain.handle(IpcChannels.comfyuiHealth, () => comfyuiClient.healthCheck())

  // FFmpeg（入参/返回均为相对 DATA_ROOT 的相对路径）
  ipcMain.handle(IpcChannels.ffmpegConcat, async (_, { segmentPaths, outputPath }: { segmentPaths: string[]; outputPath: string }) => {
    const fullSegments = segmentPaths.map(p => resolveInsideRoot(p))
    const fullOutputPath = resolveInsideRoot(outputPath)
    await ffmpegService.concatSegments(fullSegments, fullOutputPath)
    return outputPath
  })
  ipcMain.handle(IpcChannels.ffmpegMerge, async (_, { videoPath, audioPath, outputPath }: { videoPath: string; audioPath: string; outputPath: string }) => {
    const fullOutputPath = resolveInsideRoot(outputPath)
    await ffmpegService.mergeVideoAudio(resolveInsideRoot(videoPath), resolveInsideRoot(audioPath), fullOutputPath)
    return outputPath
  })
  ipcMain.handle(IpcChannels.ffmpegDuration, async (_, relativePath: string) => {
    return ffmpegService.getDuration(resolveInsideRoot(relativePath))
  })
  ipcMain.handle(IpcChannels.ffmpegBurnSubtitles, async (_, { videoPath, srtPath, outputPath }: { videoPath: string; srtPath: string; outputPath: string }) => {
    return ffmpegService.burnSubtitles(resolveInsideRoot(videoPath), resolveInsideRoot(srtPath), resolveInsideRoot(outputPath))
  })
  ipcMain.handle(IpcChannels.ffmpegMixBgm, async (_, { videoPath, bgmPath, outputPath, bgmVolume }: { videoPath: string; bgmPath: string; outputPath: string; bgmVolume: number }) => {
    return ffmpegService.mixBgm(resolveInsideRoot(videoPath), resolveInsideRoot(bgmPath), resolveInsideRoot(outputPath), bgmVolume)
  })

  // File
  ipcMain.handle(IpcChannels.fileExists, async (_, relativePath: string) => {
    return ffmpegService.fileExists(resolveInsideRoot(relativePath))
  })
  ipcMain.handle(IpcChannels.fileSize, async (_, relativePath: string) => {
    return ffmpegService.getFileSize(resolveInsideRoot(relativePath))
  })
  ipcMain.handle(IpcChannels.fileCopy, async (_, { relativePath, absoluteTarget }: { relativePath: string; absoluteTarget: string }) => {
    // absoluteTarget 由系统保存对话框产生，是用户显式选择的导出位置
    await fs.copyFile(resolveInsideRoot(relativePath), absoluteTarget)
  })
  ipcMain.handle(IpcChannels.fileDelete, async (_, relativePath: string) => {
    const abs = resolveInsideRoot(relativePath)
    if (abs === DATA_ROOT_RESOLVED) {
      throw new Error('禁止删除数据根目录')
    }
    await fs.rm(abs, { force: true })
  })
  ipcMain.handle(IpcChannels.fileResolvePath, (_, relativePath: string) => {
    return resolveInsideRoot(relativePath)
  })

  // Shell：在系统文件管理器中定位文件
  ipcMain.handle(IpcChannels.shellShowItem, (_, relativePath: string) => {
    shell.showItemInFolder(resolveInsideRoot(relativePath))
  })

  // TTS 音色试听：生成固定试听句，返回相对路径
  ipcMain.handle(IpcChannels.ttsPreview, async (_, voice: string) => {
    const safeName = voice.replace(/[^a-zA-Z0-9_]/g, '')
    const relativePath = `tmp/tts_preview_${safeName}.mp3`
    await ttsService.generate('你好，这是音色试听。', voice, relativePath)
    return relativePath
  })

  // Image Generation（T2I：生成定妆图/场景图）
  ipcMain.handle(IpcChannels.imageGenerate, async (_, { prompt, relativeOutput, workflowName }: {
    prompt: string
    relativeOutput: string
    workflowName?: string
  }) => {
    await imageService.generate(
      prompt,
      resolveInsideRoot(relativeOutput),
      { workflowName, width: 768, height: 512 }
    )
    return relativeOutput
  })

  ipcMain.handle(IpcChannels.imageCheckpoints, () => comfyuiClient.getCheckpoints())

  // AI 导演
  ipcMain.handle(IpcChannels.directorStart, (_, input: DirectorStartInput) =>
    directorAgent.start(input)
  )
  ipcMain.handle(IpcChannels.directorCancel, (_, projectId: string) =>
    directorAgent.cancel(projectId)
  )
  ipcMain.handle(IpcChannels.directorPause, (_, projectId: string) =>
    directorAgent.pause(projectId)
  )
  ipcMain.handle(IpcChannels.directorResume, (_, projectId: string) =>
    directorAgent.resume(projectId)
  )
  ipcMain.handle(IpcChannels.directorGetState, async (_, projectId: string) =>
    directorAgent.getState(projectId) ?? await directorAgent.hydrate(projectId)
  )

  // 导演技能
  ipcMain.handle(IpcChannels.skillList, () => skillService.list())
  ipcMain.handle(IpcChannels.skillCreate, (_, input: { name: string; description: string; promptTemplate: string }) =>
    skillService.create(input)
  )
  ipcMain.handle(IpcChannels.skillUpdate, (_, id: string, patch: Partial<Pick<Skill, 'name' | 'description' | 'enabled' | 'promptTemplate'>>) =>
    skillService.update(id, patch)
  )
  ipcMain.handle(IpcChannels.skillDelete, (_, id: string) => skillService.remove(id))

  // ComfyUI 控制面板
  ipcMain.handle(IpcChannels.comfySystemStats, () => comfyuiClient.getSystemStats())
  ipcMain.handle(IpcChannels.comfyObjectNodes, () => comfyuiClient.getObjectNodeNames())
  // 工作流环境自检：缺自定义节点 / 缺模型文件
  ipcMain.handle(IpcChannels.comfyValidate, async () => {
    const objectInfo = await comfyuiClient.getObjectInfo()
    const metas = await workflowLoader.list()
    const reports = []
    for (const meta of metas) {
      const issues = await workflowLoader.validateTemplate(meta.name, objectInfo)
      reports.push({ workflow: meta.name, ok: issues.length === 0, issues })
    }
    return reports
  })

  // 导演记忆库
  ipcMain.handle(IpcChannels.memoryList, (_, kind?: MemoryKind) => memoryStore.list(kind))
  ipcMain.handle(IpcChannels.memoryCreate, (_, input: { kind: MemoryKind; title: string; content: string }) =>
    memoryStore.create(input)
  )
  ipcMain.handle(IpcChannels.memoryUpdate, (_, id: string, patch: Partial<Pick<MemoryItem, 'title' | 'content' | 'kind'>>) =>
    memoryStore.update(id, patch)
  )
  ipcMain.handle(IpcChannels.memoryDelete, (_, id: string) => memoryStore.remove(id))

  // 导演对话
  ipcMain.handle(IpcChannels.conversationList, (_, scope: string) =>
    conversationService.list(scope)
  )
  ipcMain.handle(IpcChannels.conversationSend, (_, scope: string, text: string) =>
    conversationService.send(scope, text)
  )
  ipcMain.handle(IpcChannels.conversationClear, (_, scope: string) =>
    conversationService.clear(scope)
  )

  // Workflow
  ipcMain.handle(IpcChannels.workflowList, () => workflowLoader.list())
  ipcMain.handle(IpcChannels.workflowMeta, (_, name: string) => workflowLoader.getMeta(name))
  ipcMain.handle(IpcChannels.workflowImport, async (_, absolutePath: string) => {
    return workflowLoader.importWorkflow(absolutePath)
  })
  ipcMain.handle(IpcChannels.workflowGetParams, (_, name: string) => workflowLoader.getEditableParams(name))
  ipcMain.handle(IpcChannels.workflowUpdateParam, (_, name: string, nodeId: string, key: string, value: string | number | boolean) =>
    workflowLoader.updateParam(name, nodeId, key, value)
  )

  // Settings
  ipcMain.handle(IpcChannels.settingsGet, () => settingsStore.get())
  ipcMain.handle(IpcChannels.settingsSave, async (_, settings: AppSettings) => {
    await settingsStore.save(settings)
    // ComfyUI 地址变更时运行时重连
    if (settings.comfyui?.baseUrl) {
      comfyuiClient.setBaseUrl(settings.comfyui.baseUrl).catch(() => {})
    }
  })

  // LLM
  ipcMain.handle(IpcChannels.llmTest, () => llmService.test())
  ipcMain.handle(IpcChannels.llmTranslate, (_, input: { scene: string; action: string; dialogue: string; genre: string }) =>
    llmService.translatePrompt(input)
  )
  ipcMain.handle(IpcChannels.llmSplitScript, (_, script: string, genre: string) =>
    llmService.splitScript(script, genre)
  )

  // Shot（场景参考图导入）
  ipcMain.handle(IpcChannels.shotImportSceneImage, async (_, projectId: string) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    if (result.canceled || result.filePaths.length === 0) throw new Error('User cancelled')
    const sourcePath = result.filePaths[0]
    const ext = extname(sourcePath) || '.png'
    const relPath = `projects/${projectId}/scene_${Date.now()}${ext}`
    await fs.copyFile(sourcePath, resolveInsideRoot(relPath))
    return relPath
  })

  // Subtitle
  ipcMain.handle(IpcChannels.subtitleGenerate, async (_, projectId: string) => {
    const project = await projectStore.get(projectId)
    return subtitleService.generate(project)
  })

  // Dialog
  ipcMain.handle(IpcChannels.dialogSelectDirectory, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle(IpcChannels.dialogSelectFile, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: [{ name: '工作流 JSON', extensions: ['json'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle(IpcChannels.dialogSelectAudio, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: [{ name: '音频', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle(IpcChannels.dialogSaveFile, async (_, defaultName: string) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: defaultName,
      filters: [{ name: '视频', extensions: ['mp4'] }]
    })
    return result.canceled ? null : result.filePath
  })

  // Progress 事件转发
  taskQueue.on('progress', (event: ProgressEvent) => {
    mainWindow?.webContents.send(IpcChannels.progress, event)
  })

  // AI 导演进度事件转发
  directorAgent.on('progress', (event: DirectorProgressEvent) => {
    mainWindow?.webContents.send(IpcChannels.directorProgress, event)
  })
  directorAgent.on('log', (event: DirectorLogEvent) => {
    mainWindow?.webContents.send(IpcChannels.directorLog, event)
  })
  conversationService.on('tool', (event: ConversationToolEvent) => {
    mainWindow?.webContents.send(IpcChannels.conversationTool, event)
  })
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  // 断点续渲：恢复上次崩溃/退出时残留在 rendering 的孤儿镜头（不阻塞窗口与其他启动逻辑）
  void taskQueue.recoverStaleRenders()

  // 非阻塞连接 ComfyUI WebSocket；失败由 waitForCompletion 的轮询兜底
  comfyuiClient.connect().catch(() => {})

  // 启动后静默做一次工作流环境自检（等 ComfyUI 就绪），有缺失才在主进程日志告警
  setTimeout(() => {
    (async () => {
      if (!await comfyuiClient.healthCheck()) return
      try {
        const objectInfo = await comfyuiClient.getObjectInfo()
        const metas = await workflowLoader.list()
        for (const meta of metas) {
          const issues = await workflowLoader.validateTemplate(meta.name, objectInfo)
          for (const issue of issues) {
            console.warn(`[环境自检] ${meta.name}: ${issue.message}`)
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
