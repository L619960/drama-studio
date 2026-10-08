import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels, type IpcApi, type ProgressEvent } from '../shared/ipcTypes'

/**
 * 跨 IPC 传输前把 Vue 响应式 Proxy 转为纯对象快照。
 * IPC 结构化克隆无法克隆 Proxy（报 "An object could not be cloned"）。
 * 本项目所有 IPC 参数契约均为 JSON 可序列化数据。
 */
function snapshot<T>(v: T): T {
  if (typeof v === 'object' && v !== null) {
    return JSON.parse(JSON.stringify(v)) as T
  }
  return v
}

const invoke = (channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(channel, ...args.map(snapshot))

const api: IpcApi = {
  project: {
    list: () => invoke(IpcChannels.projectList),
    create: (title, genre) => invoke(IpcChannels.projectCreate, { title, genre }),
    get: (id) => invoke(IpcChannels.projectGet, id),
    save: (project) => invoke(IpcChannels.projectSave, project),
    delete: (id) => invoke(IpcChannels.projectDelete, id),
    duplicate: (id) => invoke(IpcChannels.projectDuplicate, id),
    importBgm: (projectId) => invoke(IpcChannels.projectImportBgm, projectId)
  },
  character: {
    importImage: (projectId) => invoke(IpcChannels.characterImport, projectId)
  },
  render: {
    start: (projectId, shotIds) => invoke(IpcChannels.renderStart, { projectId, shotIds }),
    cancel: (projectId, shotId) => invoke(IpcChannels.renderCancel, { projectId, shotId })
  },
  comfyui: {
    healthCheck: () => invoke(IpcChannels.comfyuiHealth),
    getSystemStats: () => invoke(IpcChannels.comfySystemStats),
    getObjectNodeNames: () => invoke(IpcChannels.comfyObjectNodes),
    validateWorkflows: () => invoke(IpcChannels.comfyValidate)
  },
  memory: {
    list: (kind?) => invoke(IpcChannels.memoryList, kind),
    create: (input) => invoke(IpcChannels.memoryCreate, input),
    update: (id, patch) => invoke(IpcChannels.memoryUpdate, id, patch),
    remove: (id) => invoke(IpcChannels.memoryDelete, id)
  },
  ffmpeg: {
    concat: (segmentPaths, outputPath) => invoke(IpcChannels.ffmpegConcat, { segmentPaths, outputPath }),
    mergeVideoAudio: (videoPath, audioPath, outputPath) => invoke(IpcChannels.ffmpegMerge, { videoPath, audioPath, outputPath }),
    getDuration: (filePath) => invoke(IpcChannels.ffmpegDuration, filePath),
    burnSubtitles: (videoPath, srtPath, outputPath) => invoke(IpcChannels.ffmpegBurnSubtitles, { videoPath, srtPath, outputPath }),
    mixBgm: (videoPath, bgmPath, outputPath, bgmVolume) => invoke(IpcChannels.ffmpegMixBgm, { videoPath, bgmPath, outputPath, bgmVolume })
  },
  llm: {
    test: () => invoke(IpcChannels.llmTest),
    translatePrompt: (input) => invoke(IpcChannels.llmTranslate, input),
    splitScript: (script, genre) => invoke(IpcChannels.llmSplitScript, script, genre)
  },
  shot: {
    importSceneImage: (projectId) => invoke(IpcChannels.shotImportSceneImage, projectId)
  },
  subtitle: {
    generate: (projectId) => invoke(IpcChannels.subtitleGenerate, projectId)
  },
  file: {
    exists: (relativePath) => invoke(IpcChannels.fileExists, relativePath),
    getSize: (relativePath) => invoke(IpcChannels.fileSize, relativePath),
    copy: (relativePath, absoluteTarget) => invoke(IpcChannels.fileCopy, { relativePath, absoluteTarget }),
    delete: (relativePath) => invoke(IpcChannels.fileDelete, relativePath),
    resolvePath: (relativePath) => invoke(IpcChannels.fileResolvePath, relativePath)
  },
  shell: {
    showItem: (relativePath) => invoke(IpcChannels.shellShowItem, relativePath)
  },
  tts: {
    preview: (voice) => invoke(IpcChannels.ttsPreview, voice)
  },
  workflow: {
    list: () => invoke(IpcChannels.workflowList),
    getMeta: (name) => invoke(IpcChannels.workflowMeta, name),
    import: (absolutePath) => invoke(IpcChannels.workflowImport, absolutePath),
    getParams: (name) => invoke(IpcChannels.workflowGetParams, name),
    updateParam: (name, nodeId, key, value) => invoke(IpcChannels.workflowUpdateParam, name, nodeId, key, value)
  },
  image: {
    generate: (prompt, relativeOutput, workflowName) =>
      invoke(IpcChannels.imageGenerate, { prompt, relativeOutput, workflowName }),
    checkpoints: () => invoke(IpcChannels.imageCheckpoints)
  },
  director: {
    start: (input) => invoke(IpcChannels.directorStart, input),
    cancel: (projectId) => invoke(IpcChannels.directorCancel, projectId),
    pause: (projectId) => invoke(IpcChannels.directorPause, projectId),
    resume: (projectId) => invoke(IpcChannels.directorResume, projectId),
    getState: (projectId) => invoke(IpcChannels.directorGetState, projectId),
    onProgress: (cb) => {
      const listener = (_: unknown, e: unknown) => cb(e as Parameters<typeof cb>[0])
      ipcRenderer.on(IpcChannels.directorProgress, listener)
      return () => ipcRenderer.removeListener(IpcChannels.directorProgress, listener)
    },
    onLog: (cb) => {
      const listener = (_: unknown, e: unknown) => cb(e as Parameters<typeof cb>[0])
      ipcRenderer.on(IpcChannels.directorLog, listener)
      return () => ipcRenderer.removeListener(IpcChannels.directorLog, listener)
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
    onToolEvent: (cb) => {
      const listener = (_: unknown, e: unknown) => cb(e as Parameters<typeof cb>[0])
      ipcRenderer.on(IpcChannels.conversationTool, listener)
      return () => ipcRenderer.removeListener(IpcChannels.conversationTool, listener)
    }
  },
  settings: {
    get: () => invoke(IpcChannels.settingsGet),
    save: (settings) => invoke(IpcChannels.settingsSave, settings)
  },
  dialog: {
    selectDirectory: () => invoke(IpcChannels.dialogSelectDirectory),
    selectFile: () => invoke(IpcChannels.dialogSelectFile),
    selectAudio: () => invoke(IpcChannels.dialogSelectAudio),
    saveFile: (defaultName) => invoke(IpcChannels.dialogSaveFile, defaultName)
  },
  onProgress: (cb) => {
    const listener = (_: unknown, e: ProgressEvent) => cb(e)
    ipcRenderer.on(IpcChannels.progress, listener)
    return () => ipcRenderer.removeListener(IpcChannels.progress, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
