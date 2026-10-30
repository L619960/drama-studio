import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels, type IpcApi, type ProgressEvent } from '../shared/ipcTypes'

/**
 * 跨 IPC 传输前把 Vue 响应式 Proxy 转为纯对象快照。
 * IPC 结构化克隆无法克隆 Proxy（报 "An object could not be cloned"）。
 *
 * 契约约束（I-15）：仅对「JSON 可序列化」数据成立——所有 IPC 参数/返回值
 * 必须是纯数据（plain object / array / string / number / boolean / null）。
 * 传 Date、Map、Set、函数、类实例都会被静默降级或抛错，禁止扩约。
 */
function snapshot<T>(v: T): T {
  if (typeof v === 'object' && v !== null) {
    return JSON.parse(JSON.stringify(v)) as T
  }
  return v
}

// 泛型化（I-11）：返回类型由 IpcApi 契约逐通道约束，
// 渲染层拿到的不再是 unknown/any，改契约即编译期报错
const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args.map(snapshot)).catch((e: unknown) => {
    // Electron 序列化错误带 "Error invoking remote method 'x': Error:" 前缀，
    // 渲染层 toast 直接展示冗长难读——统一剥掉，只留业务可读部分
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(msg.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, ''))
  }) as Promise<T>

const api: IpcApi = {
  project: {
    list: () => invoke(IpcChannels.projectList),
    create: (title, genre) => invoke(IpcChannels.projectCreate, { title, genre }),
    get: (id) => invoke(IpcChannels.projectGet, id),
    save: (project) => invoke(IpcChannels.projectSave, project),
    delete: (id) => invoke(IpcChannels.projectDelete, id),
    duplicate: (id) => invoke(IpcChannels.projectDuplicate, id),
    importBgm: (projectId) => invoke(IpcChannels.projectImportBgm, projectId),
    importPropImage: (projectId, propId) => invoke(IpcChannels.projectImportPropImage, { projectId, propId })
  },
  character: {
    importImage: (projectId) => invoke(IpcChannels.characterImport, projectId),
    casting: (projectId, characterId) => invoke(IpcChannels.characterCasting, { projectId, characterId })
  },
  render: {
    start: (projectId, shotIds, forceRebuildFirstFrame) => invoke(IpcChannels.renderStart, { projectId, shotIds, forceRebuildFirstFrame }),
    cancel: (projectId, shotId) => invoke(IpcChannels.renderCancel, { projectId, shotId }),
    list: () => invoke(IpcChannels.queueList)
  },
  comfyui: {
    healthCheck: () => invoke(IpcChannels.comfyuiHealth),
    getSystemStats: () => invoke(IpcChannels.comfySystemStats),
    getObjectNodeNames: () => invoke(IpcChannels.comfyObjectNodes),
    validateWorkflows: () => invoke(IpcChannels.comfyValidate),
    getModelsDir: () => invoke(IpcChannels.comfyModelsDir),
    start: () => invoke(IpcChannels.comfyStart),
    stop: () => invoke(IpcChannels.comfyStop)
  },
  memory: {
    list: (kind?) => invoke(IpcChannels.memoryList, kind),
    create: (input) => invoke(IpcChannels.memoryCreate, input),
    update: (id, patch) => invoke(IpcChannels.memoryUpdate, id, patch),
    remove: (id) => invoke(IpcChannels.memoryDelete, id)
  },
  ffmpeg: {
    concat: (segmentPaths, outputPath) => invoke(IpcChannels.ffmpegConcat, { segmentPaths, outputPath }),
    smartConcat: (segments, outputPath) => invoke(IpcChannels.ffmpegSmartConcat, { segments, outputPath }),
    mergeVideoAudio: (videoPath, audioPath, outputPath) => invoke(IpcChannels.ffmpegMerge, { videoPath, audioPath, outputPath }),
    getDuration: (filePath) => invoke(IpcChannels.ffmpegDuration, filePath),
    burnSubtitles: (videoPath, srtPath, outputPath) => invoke(IpcChannels.ffmpegBurnSubtitles, { videoPath, srtPath, outputPath }),
    mixBgm: (videoPath, bgmPath, outputPath, bgmVolume) => invoke(IpcChannels.ffmpegMixBgm, { videoPath, bgmPath, outputPath, bgmVolume }),
    extractFrames: (videoPath, outDir, count) => invoke(IpcChannels.ffmpegExtractFrames, { videoPath, outDir, count })
  },
  llm: {
    test: () => invoke(IpcChannels.llmTest),
    translatePrompt: (input) => invoke(IpcChannels.llmTranslate, input),
    splitScript: (script, genre) => invoke(IpcChannels.llmSplitScript, script, genre),
    writeScript: (idea, genre, title) => invoke(IpcChannels.llmWriteScript, idea, genre, title),
    reviewScript: (script, genre, title) => invoke(IpcChannels.llmReviewScript, { script, genre, title }),
    writeScriptFromVideo: (videoPath, genre) => invoke(IpcChannels.llmWriteScriptFromVideo, { videoPath, genre })
  },
  shot: {
    importSceneImage: (projectId) => invoke(IpcChannels.shotImportSceneImage, projectId)
  },
  scene: {
    regeneratePano: (projectId, boardId) =>
      invoke(IpcChannels.sceneRegeneratePano, { projectId, boardId })
  },
  asset: {
    regenerate: (input) => invoke(IpcChannels.assetRegenerate, input),
    rollback: (input) => invoke(IpcChannels.assetRollback, input)
  },
  prompt: {
    assist: (input) => invoke(IpcChannels.promptAssist, input),
    auditPrompts: (projectId) => invoke(IpcChannels.promptAudit, { projectId }),
    fixPrompts: (input) => invoke(IpcChannels.promptFix, input),
    bulkFillPrompts: (input) => invoke(IpcChannels.promptBulkFill, input),
    onBulkFillProgress: (cb) => {
      const listener = (_: unknown, e: unknown) => cb(e as Parameters<typeof cb>[0])
      ipcRenderer.on(IpcChannels.promptBulkFillProgress, listener)
      return () => ipcRenderer.removeListener(IpcChannels.promptBulkFillProgress, listener)
    }
  },
  subtitle: {
    generate: (projectId) => invoke(IpcChannels.subtitleGenerate, projectId)
  },
  file: {
    exists: (relativePath) => invoke(IpcChannels.fileExists, relativePath),
    getSize: (relativePath) => invoke(IpcChannels.fileSize, relativePath),
    copy: (relativePath, absoluteTarget) => invoke(IpcChannels.fileCopy, { relativePath, absoluteTarget }),
    delete: (relativePath) => invoke(IpcChannels.fileDelete, relativePath),
    resolvePath: (relativePath) => invoke(IpcChannels.fileResolvePath, relativePath),
    mediaUrl: (relativePath) => invoke(IpcChannels.fileMediaUrl, relativePath)
  },
  shell: {
    showItem: (relativePath) => invoke(IpcChannels.shellShowItem, relativePath),
    openPath: (absolutePath) => invoke(IpcChannels.shellOpenPath, absolutePath)
  },
  tts: {
    preview: (voice) => invoke(IpcChannels.ttsPreview, voice),
    clone: (text, refAudioPath, relativeOutput, opts) =>
      invoke(IpcChannels.ttsClone, { text, refAudioPath, relativeOutput, ...opts })
  },
  workflow: {
    list: () => invoke(IpcChannels.workflowList),
    getMeta: (name) => invoke(IpcChannels.workflowMeta, name),
    import: (absolutePath) => invoke(IpcChannels.workflowImport, absolutePath),
    getParams: (name) => invoke(IpcChannels.workflowGetParams, name),
    updateParam: (name, nodeId, key, value) => invoke(IpcChannels.workflowUpdateParam, name, nodeId, key, value)
  },
  image: {
    generate: (prompt, relativeOutput, workflowNameOrOpts) => {
      const opts = typeof workflowNameOrOpts === 'string'
        ? { workflowName: workflowNameOrOpts }
        : (workflowNameOrOpts || {})
      return invoke(IpcChannels.imageGenerate, { prompt, relativeOutput, ...opts })
    },
    checkpoints: () => invoke(IpcChannels.imageCheckpoints)
  },
  director: {
    start: (input) => invoke(IpcChannels.directorStart, input),
    cancel: (projectId) => invoke(IpcChannels.directorCancel, projectId),
    pause: (projectId) => invoke(IpcChannels.directorPause, projectId),
    resume: (projectId) => invoke(IpcChannels.directorResume, projectId),
    resumeFrom: (projectId, stage) => invoke(IpcChannels.directorResumeFrom, { projectId, stage }),
    recheckConsistency: (projectId) => invoke(IpcChannels.directorRecheckConsistency, { projectId }),
    reanalyze: (projectId) => invoke(IpcChannels.directorReanalyze, projectId),
    getState: (projectId) => invoke(IpcChannels.directorGetState, projectId),
    clearState: (projectId) => invoke(IpcChannels.directorClearState, projectId),
    getLatestState: () => invoke(IpcChannels.directorLatestState),
    getActiveStates: () => invoke(IpcChannels.directorActiveStates),
    listInterrupted: () => invoke(IpcChannels.directorListInterrupted),
    onProgress: (cb) => {
      const listener = (_: unknown, e: unknown) => cb(e as Parameters<typeof cb>[0])
      ipcRenderer.on(IpcChannels.directorProgress, listener)
      return () => ipcRenderer.removeListener(IpcChannels.directorProgress, listener)
    },
    onLog: (cb) => {
      const listener = (_: unknown, e: unknown) => cb(e as Parameters<typeof cb>[0])
      ipcRenderer.on(IpcChannels.directorLog, listener)
      return () => ipcRenderer.removeListener(IpcChannels.directorLog, listener)
    },
    onProjectUpdated: (cb) => {
      const listener = (_: unknown, e: unknown) => cb(e as Parameters<typeof cb>[0])
      ipcRenderer.on(IpcChannels.directorProjectUpdated, listener)
      return () => ipcRenderer.removeListener(IpcChannels.directorProjectUpdated, listener)
    }
  },
  skills: {
    list: () => invoke(IpcChannels.skillList),
    create: (input) => invoke(IpcChannels.skillCreate, input),
    update: (id, patch) => invoke(IpcChannels.skillUpdate, id, patch),
    remove: (id) => invoke(IpcChannels.skillDelete, id),
    toggle: (id, enabled) => invoke(IpcChannels.skillUpdate, id, { enabled })
  },
  conversation: {
    list: (scope) => invoke(IpcChannels.conversationList, scope),
    send: (scope, text) => invoke(IpcChannels.conversationSend, scope, text),
    clear: (scope) => invoke(IpcChannels.conversationClear, scope),
    stop: (scope) => invoke(IpcChannels.conversationStop, scope),
    isSending: (scope) => invoke(IpcChannels.conversationSending, scope),
    rollback: (scope, messageId) => invoke(IpcChannels.conversationRollback, scope, messageId),
    uploadFile: () => invoke(IpcChannels.conversationUpload),
    onToolEvent: (cb) => {
      const listener = (_: unknown, e: unknown) => cb(e as Parameters<typeof cb>[0])
      ipcRenderer.on(IpcChannels.conversationTool, listener)
      return () => ipcRenderer.removeListener(IpcChannels.conversationTool, listener)
    }
  },
  system: {
    selfcheck: () => invoke(IpcChannels.systemSelfcheck)
  },
  settings: {
    get: () => invoke(IpcChannels.settingsGet),
    save: (settings) => invoke(IpcChannels.settingsSave, settings),
    previewAsset: (input) => invoke(IpcChannels.settingsPreviewAsset, input)
  },
  dialog: {
    selectDirectory: () => invoke(IpcChannels.dialogSelectDirectory),
    selectFile: () => invoke(IpcChannels.dialogSelectFile),
    selectAudio: () => invoke(IpcChannels.dialogSelectAudio),
    selectVideo: () => invoke(IpcChannels.dialogSelectVideo),
    saveFile: (defaultName) => invoke(IpcChannels.dialogSaveFile, defaultName)
  },
  onProgress: (cb) => {
    const listener = (_: unknown, e: ProgressEvent) => cb(e)
    ipcRenderer.on(IpcChannels.progress, listener)
    return () => ipcRenderer.removeListener(IpcChannels.progress, listener)
  }
}

/**
 * 自动化点验钩子（仅 DRAMA_TEST_HOOKS=1 环境变量启动时生效，正常启动不暴露）。
 * 以纯数据方式覆盖个别 IPC 行为，供 CDP 自动化构造运行态/失败场景：
 *   __test.setFakeState(projectId, stateOrNull)  — director.getState 返回伪造状态
 *   __test.setResumeMode('ok' | 'fail' | null)   — director.resume 成功/失败/真实
 */
if (process.env.DRAMA_TEST_HOOKS === '1') {
  type GetStateResult = Awaited<ReturnType<typeof api.director.getState>>
  const fakeStates = new Map<string, GetStateResult>()
  let resumeMode: 'ok' | 'fail' | null = null
  const origGetState = api.director.getState
  const origResume = api.director.resume
  api.director.getState = (projectId: string) =>
    fakeStates.has(projectId)
      ? Promise.resolve(fakeStates.get(projectId) as GetStateResult)
      : origGetState(projectId)
  api.director.resume = (projectId: string) => {
    if (resumeMode === 'ok') return Promise.resolve() as ReturnType<typeof origResume>
    if (resumeMode === 'fail') return Promise.reject(new Error('模拟：继续失败')) as ReturnType<typeof origResume>
    return origResume(projectId)
  }
  contextBridge.exposeInMainWorld('__test', {
    setFakeState: (projectId: string, state: unknown) => {
      if (state == null) fakeStates.delete(projectId)
      else fakeStates.set(projectId, state as GetStateResult)
    },
    setResumeMode: (mode: 'ok' | 'fail' | null) => { resumeMode = mode }
  })
}

contextBridge.exposeInMainWorld('api', api)
