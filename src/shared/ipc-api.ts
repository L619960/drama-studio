import type { Project, GeneratedShot, AssetRegenerateInput, ProgressEvent } from './project'
import type { DirectorStartInput, DirectorStage, DirectorState, DirectorProgressEvent, DirectorLogEvent } from './director'
import type { WorkflowMeta, WorkflowParam, WorkflowCheckReport } from './workflow'
import type { AppSettings, PreviewAssetInput, PreviewAssetResult } from './settings'
import type { ComfySystemStats, ComfyStartResult } from './comfy'
import type { PromptAssistInput, PromptAuditReport, PromptAuditFixInput, PromptAuditFixResult, PromptBulkFillInput, PromptBulkFillResult, PromptBulkFillProgress } from './prompt-audit'
import type { ConversationMessage, UploadedFilePayload, ConversationToolEvent } from './conversation'
import type { Skill } from './skill'
import type { MemoryKind, MemoryItem } from './memory'
import type { SelfCheckItem } from './system'

// ===== IPC API 契约 =====
export interface IpcApi {
  project: {
    list(): Promise<Project[]>
    create(title: string, genre: string): Promise<Project>
    get(id: string): Promise<Project>
    save(project: Project): Promise<void>
    delete(id: string): Promise<void>
    duplicate(id: string): Promise<Project>
    importBgm(projectId: string): Promise<string>  // 选择并复制 BGM 到项目目录，返回相对路径
    importPropImage(projectId: string, propId: string): Promise<string>  // 道具上传本地图片并复制到项目目录，返回相对路径
  }
  character: {
    importImage(projectId: string): Promise<string>
    casting(projectId: string, characterId: string): Promise<{ faceRel: string; bodyRel: string; pickNote?: string }>
  }
  render: {
    /**
     * 入队渲染。shotReviewGate=block 且人物镜未审会 reject。
     * forceRebuildFirstFrame：仅指定镜时重建首帧并作废 reviewed，重建后仍须再过门禁才会入队。
     */
    start(projectId: string, shotIds?: string[], opts?: { forceRebuildFirstFrame?: boolean }): Promise<{ warnedShots: number[] }>
    cancel(projectId: string, shotId?: string): Promise<void>
  }
  comfyui: {
    healthCheck(): Promise<boolean>
    getSystemStats(): Promise<ComfySystemStats | null>
    /** 已安装节点类名全集（GET /object_info 的 keys，主进程瘦身） */
    getObjectNodeNames(): Promise<string[]>
    /** 校验全部工作流模板：缺失节点/缺失模型 */
    validateWorkflows(): Promise<WorkflowCheckReport[]>
    /** ComfyUI models 目录绝对路径（设置 > inputDir 推断 > null），缺模型问题卡「打开目录」用 */
    getModelsDir(): Promise<string | null>
    /** 启动本机 ComfyUI（后台无窗口）。已在线返回 already；启动命令可配置 */
    start(): Promise<ComfyStartResult>
    /** 停止本机 ComfyUI：按「main.py + baseUrl 端口」定位进程并结束 */
    stop(): Promise<{ ok: boolean; killed: number; error?: string }>
  }
  memory: {
    list(kind?: MemoryKind): Promise<MemoryItem[]>
    create(input: { kind: MemoryKind; title: string; content: string }): Promise<MemoryItem>
    update(id: string, patch: Partial<Pick<MemoryItem, 'title' | 'content' | 'kind'>>): Promise<void>
    remove(id: string): Promise<void>
  }
  ffmpeg: {
    concat(segmentPaths: string[], outputPath: string): Promise<string>
    smartConcat(segments: Array<{ path: string; scene?: string; hasDialogue?: boolean; transition?: 'hard' | 'dissolve' | 'smash'; trimStart?: number; trimEnd?: number }>, outputPath: string): Promise<string>
    mergeVideoAudio(videoPath: string, audioPath: string, outputPath: string): Promise<string>
    getDuration(filePath: string): Promise<number>
    burnSubtitles(videoPath: string, srtPath: string, outputPath: string): Promise<string>
    mixBgm(videoPath: string, bgmPath: string, outputPath: string, bgmVolume?: number): Promise<string>
    extractFrames(videoPath: string, outDir: string, count?: number): Promise<string[]>
  }
  llm: {
    test(): Promise<string>
    translatePrompt(input: { scene: string; action: string; dialogue: string; genre: string }): Promise<string>
    splitScript(script: string, genre: string): Promise<GeneratedShot[]>
    writeScript(idea: string, genre: string, title?: string): Promise<string>
    /** AI 剧本医生：审查剧本逻辑 bug，返回问题清单 + 修改后完整剧本 */
    reviewScript(script: string, genre: string, title?: string): Promise<{ issues: Array<{ severity: 'block' | 'warn'; scene: string; problem: string; suggestion: string }>; revisedScript: string }>
    /** 视频拆解写剧本：抽帧后由多模态 LLM 看图扩写成短剧剧本 */
    writeScriptFromVideo(videoPath: string, genre: string): Promise<string>
  }
  shot: {
    importSceneImage(projectId: string): Promise<string>
  }
  subtitle: {
    generate(projectId: string): Promise<string>  // 生成 SRT，返回相对路径
  }
  /** 场景板：重建全景方位图 */
  scene: {
    regeneratePano(projectId: string, boardId: string): Promise<{ ok: boolean; text: string }>
  }
  /** 工作台产物重生成：按产物类型用指定工作流重新生成（单次生效，不改项目默认） */
  asset: {
    regenerate(input: AssetRegenerateInput): Promise<{ path: string; previousPath?: string }>
    /** 回滚到上一次生成前的旧产物（生成时主进程已备份） */
    rollback(input: AssetRegenerateInput): Promise<{ path: string }>
  }
  /** 提示词智能辅助：AI 专业优化 / 中英互译（走主进程 LLM 服务） */
  prompt: {
    assist(input: PromptAssistInput): Promise<{ text: string }>
    /** 批量体检：遍历当前项目全部文生图/文生视频任务，逐条校验正向+负向提示词（完整性/格式/敏感内容） */
    auditPrompts(projectId: string): Promise<PromptAuditReport>
    /** 一键修正可自动修复项（缺省=全部任务）；只改提示词文本，不动镜头状态与已生成产物 */
    fixPrompts(input: PromptAuditFixInput): Promise<PromptAuditFixResult>
    /** 批量 AI 补写：对缺失/过短/串戏等需语义补全的提示词字段调用 LLM 重写；
     *  taskIds 缺省=全部任务；concurrency 缺省=1（串行，避免 LLM 限流）。
     *  进度通过 prompt:bulkFillProgress 事件推送。 */
    bulkFillPrompts(input: PromptBulkFillInput): Promise<PromptBulkFillResult>
    /** 订阅批量 AI 补写进度事件，返回取消订阅函数 */
    onBulkFillProgress(cb: (evt: PromptBulkFillProgress) => void): () => void
  }
  file: {
    exists(relativePath: string): Promise<boolean>
    getSize(relativePath: string): Promise<number>
    copy(relativePath: string, absoluteTarget: string): Promise<void>
    delete(relativePath: string): Promise<void>
    resolvePath(relativePath: string): Promise<string>
    /** 本地媒体可播放 URL（本机 HTTP + Range，供 video/img src） */
    mediaUrl(relativePath: string): Promise<string>
  }
  shell: {
    showItem(relativePath: string): Promise<void>
    /** 打开本机任意已存在目录/文件（如 ComfyUI models 目录），不存在时抛错 */
    openPath(absolutePath: string): Promise<void>
  }
  tts: {
    preview(voice: string): Promise<string>
    /** Qwen3-TTS 语音克隆：参考音频 + 文本 → 克隆语音（相对路径） */
    clone(text: string, refAudioPath: string, relativeOutput: string, opts?: { refText?: string; seed?: number }): Promise<string>
  }
  workflow: {
    list(): Promise<WorkflowMeta[]>
    getMeta(name: string): Promise<WorkflowMeta>
    import(absolutePath: string): Promise<string>  // 导入工作流 JSON，返回工作流名称
    getParams(name: string): Promise<WorkflowParam[]>
    updateParam(name: string, nodeId: string, key: string, value: string | number | boolean): Promise<void>
  }
  image: {
    generate(
      prompt: string,
      relativeOutput: string,
      workflowNameOrOpts?: string | {
        workflowName?: string
        width?: number
        height?: number
        /** 参考图（i2i/融合工作流用），绝对或相对项目根路径 */
        referenceImagePath?: string
        referenceImagePaths?: string[]
        /** 严格按工作流参数渲染（禁用尺寸/seed 覆盖） */
        strictWorkflow?: boolean
        /** 分镜级负向提示词（并入视频/图像负向指令） */
        negative?: string
        seed?: number
        shouldAbort?: () => boolean
      }
    ): Promise<string>
    checkpoints(): Promise<string[]>
  }
  director: {
    start(input: DirectorStartInput): Promise<string>  // 返回 projectId
    cancel(projectId: string): Promise<void>
    /** 请求暂停：当前阶段结束后停在确认点（不中断进行中的渲染） */
    pause(projectId: string): Promise<void>
    /** 从确认点继续 */
    resume(projectId: string): Promise<void>
    /**
     * 断点续跑：从指定阶段重跑（该阶段及其后全部重新执行，此前已完成阶段跳过）。
     * 任务运行中/状态缺失/前置产物不满足时抛中文错误。
     */
    resumeFrom(projectId: string, stage: DirectorStage): Promise<void>
    /** 重跑项目全部 i2v 镜一致性校验（新逻辑摘帽误杀标记，不触发重渲），返回复评统计 */
    recheckConsistency(projectId: string): Promise<{ rechecked: number; cleared: number; stillLow: number; skipped: number }>
    /** 重拆镜：用当前剧本重新分析并替换分镜（保留资产），返回 {shots, characters, props} 计数 */
    reanalyze(projectId: string): Promise<{ shots: number; characters: number; props: number }>
    getState(projectId: string): Promise<DirectorState | null>
    /** 清空已结束任务的内存展示态（不删素材） */
    clearState(projectId: string): Promise<void>
    /** 最近活跃任务的状态（含影子渲染任务）：全局控制台未绑定项目时展示用 */
    getLatestState(): Promise<DirectorState | null>
    onProgress(cb: (e: DirectorProgressEvent) => void): () => void
    onLog(cb: (e: DirectorLogEvent) => void): () => void
    /** 后台流程（定妆/首帧/场景板/逐镜渲染）落盘后通知：前端面板收到即刷新项目数据 */
    onProjectUpdated(cb: (e: { projectId: string }) => void): () => void
  }
  skills: {
    list(): Promise<Skill[]>
    create(input: { name: string; description: string; promptTemplate: string }): Promise<Skill>
    update(id: string, patch: Partial<Pick<Skill, 'name' | 'description' | 'enabled' | 'promptTemplate'>>): Promise<void>
    remove(id: string): Promise<void>
    toggle(id: string, enabled: boolean): Promise<void>
  }
  conversation: {
    list(scope: string): Promise<ConversationMessage[]>
    send(scope: string, text: string): Promise<ConversationMessage[]>
    clear(scope: string): Promise<void>
    /** 中断当前正在进行的发送（LLM 请求与工具循环），返回是否确有任务被中断 */
    stop(scope: string): Promise<boolean>
    /** 查询指定作用域是否有正在进行的发送（路由切回后恢复发送态用） */
    isSending(scope: string): Promise<boolean>
    /** 回退到指定消息节点之前：删除该消息及其后的所有记录，返回回退后的消息列表 */
    rollback(scope: string, messageId: string): Promise<ConversationMessage[]>
    /** 弹出系统文件选择框，读取常见文本文件内容（超长截断），取消返回 null */
    uploadFile(): Promise<UploadedFilePayload | null>
    onToolEvent(cb: (e: ConversationToolEvent) => void): () => void
  }
  system: {
    /** 运行环境与功能自检，返回逐项结果 */
    selfcheck(): Promise<SelfCheckItem[]>
  }
  settings: {
    /** 主进程始终合并默认值后返回，不会是 null（I-11 修正：原契约误标 | null） */
    get(): Promise<AppSettings>
    save(settings: AppSettings): Promise<void>
    /** 人物/场景试生成预览（写入 preview/，不进项目） */
    previewAsset(input: PreviewAssetInput): Promise<PreviewAssetResult>
  }
  dialog: {
    selectDirectory(): Promise<string | null>
    selectFile(): Promise<string | null>
    selectAudio(): Promise<string | null>
    selectVideo(): Promise<string | null>
    saveFile(defaultName: string): Promise<string | null>
  }
  onProgress(cb: (e: ProgressEvent) => void): () => void
}

