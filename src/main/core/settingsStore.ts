import { app, safeStorage } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'node:path'
import type { AppSettings, CreationSettings } from '../../shared/ipcTypes'
import { DEFAULT_CREATION, resolveCreation, DEFAULT_STORYBOARD, DEFAULT_CHARACTER, DEFAULT_SCENE, DEFAULT_EDIT } from '../../shared/creationSettings'
import { atomicWriteJson } from './fsUtil'

// ===== apiKey safeStorage 加密（任务 9c）=====
// 落盘 apiKey 用系统密钥环（Windows DPAPI）加密，避免 settings.json 明文泄漏。
// 读取时解密回内存明文（LLM 服务要明文发请求）；旧明文配置在 get() 时自动迁移加密。
// safeStorage 在 app ready 后才可用——所有调用点均为运行时惰性触发，try/catch 兜底降级明文。
const APIKEY_ENC_PREFIX = 'enc:v1:'

function apikeyEncryptionAvailable(): boolean {
  try {
    return Boolean(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable())
  } catch {
    return false
  }
}

function encryptApiKey(raw: string): string {
  if (!raw || !apikeyEncryptionAvailable()) return raw
  try {
    return APIKEY_ENC_PREFIX + safeStorage.encryptString(raw).toString('base64')
  } catch {
    return raw
  }
}

function decryptApiKey(stored: unknown): string {
  if (typeof stored !== 'string' || !stored) return ''
  if (!stored.startsWith(APIKEY_ENC_PREFIX)) return stored // 旧明文：直接使用
  if (!apikeyEncryptionAvailable()) return '' // 加密环境丢失，无法解开
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(APIKEY_ENC_PREFIX.length), 'base64'))
  } catch {
    return ''
  }
}

const DEFAULT_SETTINGS: AppSettings = {
  general: {
    autoSave: true,
    autoLearn: false
  },
  render: {
    defaultWidth: 720,
    defaultHeight: 480,
    defaultFrames: 81,
    timeout: 600,
    lipSync: true,
    lipSyncMode: 'auto',
    oomRetry: true,
    consistencyMode: 'warn',
    resolutionTier: 'auto',
    shotReviewGate: 'block',
    reviewGate: 'block',
    finalReviewGate: 'block',
    assetConcurrency: 2,
    perShotAudit: true,
    // MiniMax H3 turbo LoRA 加速：i2v 用 fl2v_turbo_8step（8步）、r2v 用 ref2v_turbo_4step（4步）
    // 官方低步数 LoRA，比无 LoRA 的 8 步画质更高且更稳；默认开（渲染慢的主要缓解）
    turboH3: true,
    assetFallbackProjectId: '',
    // 首帧融合两级失败后默认硬阻断：不允许带病回退文生（身份参考丢失→画面漂移）
    fusionFallback: 'block'
  },
  creation: structuredClone(DEFAULT_CREATION),
  comfyui: {
    baseUrl: 'http://127.0.0.1:8188',
    inputDir: '',
    modelsDir: '',
    startCommand: '',
    workflowLibraryDir: '',
    mcpVenvDir: ''
  },
  tts: {
    defaultVoice: 'zh-CN-XiaoxiaoNeural',
    // 短剧对白略慢：100=+0%，88≈-12%，更利情感与口型
    rate: 88,
    volume: 100
  },
  workflow: {
    default: 'wan22_i2v'
  },
  llm: {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat'
  },
  appearance: {
    theme: 'dark'
  }
}

export class SettingsStore {
  private settingsPath: string

  constructor() {
    this.settingsPath = path.join(app.getPath('userData'), 'settings.json')
  }

  async get(): Promise<AppSettings> {
    try {
      const content = await fs.readFile(this.settingsPath, 'utf-8')
      // 容错：剥离 UTF-8 BOM（用户手工编辑或外部工具写入可能带 BOM）
      const saved = JSON.parse(content.replace(/^\uFEFF/, ''))
      // 9c：apiKey 落盘加密——读取时解密回内存明文；旧明文配置自动迁移为加密格式
      if (saved?.llm && typeof saved.llm.apiKey === 'string') {
        const rawStored = saved.llm.apiKey
        saved.llm.apiKey = decryptApiKey(rawStored)
        if (rawStored && !rawStored.startsWith(APIKEY_ENC_PREFIX) && apikeyEncryptionAvailable()) {
          void this.migrateApiKeyToEncrypted().catch(() => undefined)
        }
      }
      // 旧配置迁移（merge 会用默认值填满字段，迁移必须在 merge 前做）：
      // 无 finalReviewGate 字段时继承旧 render.reviewGate 取值
      if (saved?.render && typeof saved.render === 'object' && !('finalReviewGate' in saved.render)
        && typeof saved.render.reviewGate === 'string') {
        saved.render.finalReviewGate = saved.render.reviewGate
      }
      // 深合并，确保新字段有默认值
      return this.normalize(this.merge(DEFAULT_SETTINGS, saved))
    } catch {
      return this.normalize(structuredClone(DEFAULT_SETTINGS))
    }
  }

  /** 9c：旧明文 apiKey 自动迁移为 safeStorage 加密格式（写盘一次，不打断读取） */
  private async migrateApiKeyToEncrypted(): Promise<void> {
    try {
      const content = await fs.readFile(this.settingsPath, 'utf-8')
      const raw = JSON.parse(content.replace(/^\uFEFF/, ''))
      if (!raw?.llm || typeof raw.llm.apiKey !== 'string' || !raw.llm.apiKey || raw.llm.apiKey.startsWith(APIKEY_ENC_PREFIX)) return
      raw.llm.apiKey = encryptApiKey(raw.llm.apiKey)
      await fs.mkdir(path.dirname(this.settingsPath), { recursive: true })
      await atomicWriteJson(this.settingsPath, raw)
    } catch { /* 迁移失败下次读取再试 */ }
  }

  async save(settings: AppSettings): Promise<void> {
    // LLM 接口地址下拉记忆：去重置顶，最多保留 12 条（UI 保存与对话内 llm_baseUrl 修改均走此入口）
    if (settings.llm) {
      const base = (settings.llm.baseUrl || '').trim()
      const hist = Array.isArray(settings.llm.baseUrlHistory)
        ? settings.llm.baseUrlHistory.filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
        : []
      // 切换地址时把旧文件里的原地址也补进记忆，避免用户用过的地址丢失
      let prevBase = ''
      try {
        const old = JSON.parse((await fs.readFile(this.settingsPath, 'utf-8')).replace(/^\uFEFF/, ''))
        prevBase = String(old?.llm?.baseUrl || '').trim()
      } catch { /* 首次保存或文件不存在 */ }
      if (prevBase && prevBase !== base && !hist.includes(prevBase)) hist.push(prevBase)
      if (base && !hist.includes(base)) hist.unshift(base)
      settings.llm = { ...settings.llm, baseUrlHistory: hist.slice(0, 12) }
    }
    await fs.mkdir(path.dirname(this.settingsPath), { recursive: true })
    const normalized = this.normalize(settings)
    // 9c：落盘前加密 apiKey（normalize 不改 apiKey；内存对象仍保留明文供本次调用方使用）
    if (normalized.llm?.apiKey) {
      normalized.llm = { ...normalized.llm, apiKey: encryptApiKey(normalized.llm.apiKey) }
    }
    await atomicWriteJson(this.settingsPath, normalized)
  }

  private merge(defaults: AppSettings, saved: Partial<AppSettings>): AppSettings {
    const result = { ...defaults }
    for (const key of Object.keys(defaults) as Array<keyof AppSettings>) {
      if (saved[key] == null) continue
      if (key === 'creation') {
        const sc = saved.creation as Partial<CreationSettings>
        result.creation = {
          storyboard: { ...defaults.creation.storyboard, ...sc.storyboard },
          character: { ...defaults.creation.character, ...sc.character },
          scene: { ...defaults.creation.scene, ...sc.scene },
          edit: { ...defaults.creation.edit, ...sc.edit },
          presets: Array.isArray(sc.presets) ? sc.presets : defaults.creation.presets
        }
        continue
      }
      if (typeof defaults[key] === 'object' && defaults[key] !== null && !Array.isArray(defaults[key])) {
        result[key] = { ...(defaults[key] as object), ...(saved[key] as object) } as never
      } else {
        result[key] = saved[key] as never
      }
    }
    return result
  }

  /**
   * - Wan 帧数钳到 16n+1
   * - 资产并发 1~3
   * - creation ↔ render/tts 双向镜像，保证旧 UI/旧代码仍可读
   * - S-03 加固（2026-10-20）：所有数值/枚举/字符串字段在主进程侧做类型与范围归一，
   *   渲染层可写任意值（settings:save 全量透传），非法类型不得把 NaN/畸形枚举落盘。
   */
  private normalize(s: AppSettings): AppSettings {
    if (!s.creation || typeof s.creation !== 'object') s.creation = structuredClone(DEFAULT_CREATION)
    const creation = resolveCreation(s)

    // 旧 render/tts → creation.edit（仅当 creation.edit 某字段仍是默认且 render 不同时已由 resolve 处理）
    // creation.edit → 写回 render/tts，保持单源一致
    const frames = this.clampFrames(creation.edit.defaultFrames)
    creation.edit.defaultFrames = frames
    creation.storyboard.minShots = this.num(creation.storyboard.minShots, DEFAULT_STORYBOARD.minShots, 4, 30)
    creation.storyboard.maxShots = Math.max(
      creation.storyboard.minShots,
      this.num(creation.storyboard.maxShots, DEFAULT_STORYBOARD.maxShots, creation.storyboard.minShots, 30)
    )
    creation.storyboard.temperature = this.num(creation.storyboard.temperature, DEFAULT_STORYBOARD.temperature, 0, 1)
    creation.storyboard.maxCharacters = this.num(creation.storyboard.maxCharacters, DEFAULT_STORYBOARD.maxCharacters, 2, 12)
    creation.edit.comfyTimeoutSec = this.num(creation.edit.comfyTimeoutSec, DEFAULT_EDIT.comfyTimeoutSec, 60, 3600)
    creation.edit.defaultBgmVolume = this.num(creation.edit.defaultBgmVolume, DEFAULT_EDIT.defaultBgmVolume, 0, 100)
    creation.edit.subtitleFontSize = this.num(creation.edit.subtitleFontSize, DEFAULT_EDIT.subtitleFontSize, 10, 48)
    creation.edit.subtitleMarginV = this.num(creation.edit.subtitleMarginV, DEFAULT_EDIT.subtitleMarginV, 0, 120)
    creation.edit.ttsRate = this.num(creation.edit.ttsRate, DEFAULT_EDIT.ttsRate, 50, 200)
    creation.edit.ttsVolume = this.num(creation.edit.ttsVolume, DEFAULT_EDIT.ttsVolume, 0, 100)
    creation.character.candidates = this.num(creation.character.candidates, DEFAULT_CHARACTER.candidates, 1, 4)
    creation.scene.candidates = this.num(creation.scene.candidates, DEFAULT_SCENE.candidates, 1, 4)
    creation.edit.renderCandidates = this.num(creation.edit.renderCandidates, DEFAULT_EDIT.renderCandidates, 1, 3)
    // S-03：枚举白名单
    creation.edit.lipSyncMode = this.enumOf(creation.edit.lipSyncMode, ['auto', 'latentsync', 'h3-native'], DEFAULT_EDIT.lipSyncMode)
    creation.edit.reviewGate = this.enumOf(creation.edit.reviewGate, ['off', 'warn', 'block'], DEFAULT_EDIT.reviewGate)

    const conc = this.num(s.render?.assetConcurrency, 2, 1, 3)

    return {
      ...s,
      creation,
      render: {
        ...s.render,
        defaultWidth: creation.edit.defaultWidth,
        defaultHeight: creation.edit.defaultHeight,
        defaultFrames: frames,
        timeout: creation.edit.comfyTimeoutSec,
        lipSync: creation.edit.lipSync === true,
        lipSyncMode: this.enumOf(s.render?.lipSyncMode, ['auto', 'latentsync', 'h3-native'], creation.edit.lipSyncMode),
        shotReviewGate: this.enumOf(s.render?.shotReviewGate, ['off', 'warn', 'block'], 'block'),
        // 旧镜像已删：render.reviewGate 不再被 creation.edit.reviewGate 覆盖（S-01 双字段解耦）。
        // 成片复审门读 finalReviewGate；旧配置无 finalReviewGate 时由 get() 在 merge 前迁移旧 reviewGate 取值。
        reviewGate: this.enumOf(s.render?.reviewGate, ['off', 'warn', 'block'], 'block'),
        finalReviewGate: this.enumOf(s.render?.finalReviewGate, ['off', 'warn', 'block'], 'block'),
        consistencyMode: this.enumOf(s.render?.consistencyMode, ['off', 'warn', 'rerender'], 'warn'),
        resolutionTier: this.enumOf(s.render?.resolutionTier, ['auto', 'low', 'mid', 'standard', 'high', 'ultra'], 'auto'),
        oomRetry: s.render?.oomRetry !== false,
        turboH3: s.render?.turboH3 === true,
        assetConcurrency: conc,
        perShotAudit: s.render?.perShotAudit ?? true,
        fusionFallback: this.enumOf<'block' | 'allow'>(s.render?.fusionFallback, ['block', 'allow'], 'block')
      },
      tts: {
        ...s.tts,
        defaultVoice: this.str(s.tts?.defaultVoice, DEFAULT_SETTINGS.tts.defaultVoice),
        rate: creation.edit.ttsRate,
        volume: creation.edit.ttsVolume
      },
      comfyui: {
        ...s.comfyui,
        baseUrl: this.str(s.comfyui?.baseUrl, DEFAULT_SETTINGS.comfyui.baseUrl),
        inputDir: this.str(s.comfyui?.inputDir, DEFAULT_SETTINGS.comfyui.inputDir),
        modelsDir: this.str(s.comfyui?.modelsDir, DEFAULT_SETTINGS.comfyui.modelsDir),
        startCommand: this.str(s.comfyui?.startCommand, DEFAULT_SETTINGS.comfyui.startCommand),
        workflowLibraryDir: this.str(s.comfyui?.workflowLibraryDir, DEFAULT_SETTINGS.comfyui.workflowLibraryDir),
        mcpVenvDir: this.str(s.comfyui?.mcpVenvDir, DEFAULT_SETTINGS.comfyui.mcpVenvDir)
      },
      llm: {
        ...s.llm,
        apiKey: this.str(s.llm?.apiKey, DEFAULT_SETTINGS.llm.apiKey),
        baseUrl: this.str(s.llm?.baseUrl, DEFAULT_SETTINGS.llm.baseUrl),
        model: this.str(s.llm?.model, DEFAULT_SETTINGS.llm.model)
      },
      workflow: {
        default: this.str(s.workflow?.default, DEFAULT_SETTINGS.workflow.default)
      },
      general: {
        ...s.general,
        autoSave: s.general?.autoSave !== false,
        // S-05：自动学习默认关闭（每轮学习 15~30 万 tokens 纯自动开销），用户在设置页显式开启
        autoLearn: s.general?.autoLearn === true
      }
    }
  }

  /** S-03：数值归一（非法类型/越界回退默认，防 NaN 落盘） */
  private num(v: unknown, fallback: number, min: number, max: number): number {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
    return Math.max(min, Math.min(max, Math.round(n)))
  }

  /** S-03：枚举白名单（非法值回退默认） */
  private enumOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
    return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
  }

  /** S-03：字符串类型守卫 */
  private str(v: unknown, fallback: string | undefined): string {
    return typeof v === 'string' ? v : (fallback ?? '')
  }

  private clampFrames(frames: number): number {
    if (typeof frames !== 'number' || (frames < 17 || (frames - 1) % 16 !== 0)) {
      const n = Math.max(1, Math.round((frames - 1) / 16))
      return n * 16 + 1
    }
    return frames
  }
}
