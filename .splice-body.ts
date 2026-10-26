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
