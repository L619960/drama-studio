// ===== 创作四模块设置 =====
export interface StoryboardModuleSettings {
  /** 最少镜头数 */
  minShots: number
  /** 最多镜头数 */
  maxShots: number
  /** 拆镜 LLM 温度 0~1 */
  temperature: number
  /** 角色上限 */
  maxCharacters: number
  /** 强制关键道具落幅校验 */
  enforcePropLock: boolean
  /** 强制入画后反应镜校验 */
  enforceReactionBeats: boolean
  /** 强制上车链/驶离结局校验 */
  enforceBoardingChain: boolean
}

export interface CharacterModuleSettings {
  faceWidth: number
  faceHeight: number
  bodyWidth: number
  bodyHeight: number
  /** 写实锁强度：strong 加强负向与身份复读 */
  realismLock: 'standard' | 'strong'
  seedMode: 'random' | 'fixed'
  seed: number
  /** 空=使用 ImageService 默认工作流 */
  t2iWorkflow: string
  /** 定妆候选张数 1–4；>1 时多 seed 抽卡 */
  candidates: number
  /** 多候选时由 LLM 结合分数挑最优 */
  llmPick: boolean
}

export interface SceneModuleSettings {
  plateWidth: number
  plateHeight: number
  frameWidth: number
  frameHeight: number
  /** 空场景板严禁出现人物 */
  emptyStrict: boolean
  weatherHint: 'auto' | 'rainy' | 'clear'
  /** 场景板文生图工作流覆盖（未设用默认） */
  t2iWorkflow?: string
  /** 场景板候选张数 1–4 */
  candidates: number
  /** 全景固定场景：每个场景生成 2:1 全景图并裁 N 张方位图，各镜首帧从方位图取景（场景不漂移）。
   *  默认开；关闭时回退旧版单张竖版场景板。 */
  panorama: boolean
  /** 全景方位图数量（水平均分 90° 间隔）：2 / 4 / 6 */
  panoViewsCount: number
  llmPick: boolean
}

export interface EditModuleSettings {
  defaultWidth: number
  defaultHeight: number
  defaultFrames: number
  /** Comfy 等待超时（秒） */
  comfyTimeoutSec: number
  lipSync: boolean
  lipSyncMode: 'auto' | 'latentsync' | 'h3-native'
  reviewGate: 'off' | 'warn' | 'block'
  defaultBgmVolume: number
  subtitleFontSize: number
  subtitleMarginV: number
  ttsRate: number
  ttsVolume: number
  /** 单镜渲染候选条数 1–3（多 seed）；>1 时抽卡留最优 */
  renderCandidates: number
  /** 多候选渲染时 LLM 介入挑选 */
  llmPick: boolean
}

export interface CreationPreset {
  id: string
  name: string
  updatedAt: number
  modules: {
    storyboard: StoryboardModuleSettings
    character: CharacterModuleSettings
    scene: SceneModuleSettings
    edit: EditModuleSettings
  }
}

export interface CreationSettings {
  storyboard: StoryboardModuleSettings
  character: CharacterModuleSettings
  scene: SceneModuleSettings
  edit: EditModuleSettings
  presets: CreationPreset[]
}

export interface PreviewAssetInput {
  kind: 'character' | 'scene'
  /** character: lookEn；scene: 场景描述 */
  promptHint: string
}

export interface PreviewAssetResult {
  relativePath: string
  mediaUrl: string
}

// ===== 设置数据模型 =====
export interface AppSettings {
  general: {
    autoSave: boolean
    /** 启动后自动触发导演「自主学习」（每周一轮，联网搜索+技能沉淀，约 15~30 万 tokens/次）；
     *  关=仅聊天区手动触发（S-05 整改，2026-10-20） */
    autoLearn: boolean
  }
  render: {
    defaultWidth: number
    defaultHeight: number
    defaultFrames: number
    timeout: number
    lipSync: boolean  // 有台词镜头渲染后做音频驱动口型同步（需 ComfyUI 装 LatentSync 节点）
    /** 口型技术路线：auto=按引擎自动(H3原生口型, Wan走LatentSync)；latentsync=强制LatentSync；h3-native=仅H3原生口型不回退 */
    lipSyncMode: 'auto' | 'latentsync' | 'h3-native'
    /** 显存不足(OOM)时自动降帧数/步数重试一次 */
    oomRetry: boolean
    /** 人物一致性校验：off=关闭；warn=低相似度仅告警；rerender=低相似度换seed自动重渲一次 */
    consistencyMode: 'off' | 'warn' | 'rerender'
    /** 显存档位：auto=按 ComfyUI 显存自动定分辨率/帧长上限；其余为手动强制档位 */
    resolutionTier: 'auto' | 'low' | 'mid' | 'standard' | 'high' | 'ultra'
    /**
     * 分镜首帧审核门控（开渲前）：
     * off=不检查；warn=未核对仍入队并返回 warnedShots；block=未核对直接拒绝入队
     */
    shotReviewGate: 'off' | 'warn' | 'block'
    /**
     * 成片复审门控（配 BGM 前，与分镜审核独立）：
     * off=只记录；warn=技术/剧情问题告警后放行；block=技术硬伤阻断 BGM，剧情问题仍告警放行
     */
    reviewGate: 'off' | 'warn' | 'block'
    /** 定妆/场景板客户端并发（Comfy 侧仍排队）；1~3，默认 2 */
    assetConcurrency: number
    /** 逐镜即时审核（看守）：每渲染完一镜立即技术+LLM视觉审核，不过就注入修正指令重渲，过审才进下一镜；关=旧批量渲染后统一审批 */
    perShotAudit: boolean
    /** MiniMax H3 turbo LoRA 加速：i2v 挂 fl2v_turbo_8step(8步)、r2v 挂 ref2v_turbo_4step(4步)；默认开 */
    turboH3: boolean
  }
  /** 创作四模块：分镜 / 人物 / 场景 / 剪辑（与 render/tts 双向镜像兼容） */
  creation: CreationSettings
  comfyui: {
    baseUrl: string
    /** ComfyUI input 目录绝对路径：H3 参考音频上传失败时回退直接复制到此目录 */
    inputDir?: string
    /** ComfyUI models 目录绝对路径：缺模型问题卡「打开 models 目录」用，空则自动从 inputDir 推断 */
    modelsDir?: string
    /**
     * 一键启动命令（完整命令行，路径用英文引号包裹）。空=用内置默认
     * `"<秋叶整合包>\python\python.exe" "<整合包>\ComfyUI\main.py" --listen 127.0.0.1 --port 8188`
     */
    startCommand?: string
    /**
     * ComfyUI 工作流库目录（用户收集的 UI 格式工作流全集，扫描+转换导入用）。
     * 空=本机秋叶整合包默认库路径
     */
    workflowLibraryDir?: string
    /**
     * ComfyUI-MCP 独立 venv 目录（含 Scripts\comfy-mcp.exe）。显式配置优先；
     * 空则按旧逻辑从 startCommand 的 python.exe 祖父目录推导 <祖父>\comfy-mcp-venv
     */
    mcpVenvDir?: string
  }
  tts: {
    defaultVoice: string
    rate: number
    volume: number
  }
  workflow: {
    default: string  // 全局默认工作流名称
  }
  llm: {
    apiKey: string   // 火山方舟 API Key
    baseUrl: string  // OpenAI 兼容端点，默认 https://ark.cn-beijing.volces.com/api/v3
    model: string    // 推理接入点 / 模型 ID，如 ark-code-latest
    /** 接口地址下拉记忆：用户保存过的 baseUrl 历史（去重置顶，最多 12 条） */
    baseUrlHistory?: string[]
  }
  appearance: {
    /** 主题：dark 深色（默认）｜ light 浅色 ｜ studio 深空导演棚 ｜ warm 暖色剪辑台 */
    theme: 'dark' | 'light' | 'studio' | 'warm'
  }
}

