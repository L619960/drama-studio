import { app } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'node:path'
import type { AppSettings } from '../../shared/ipcTypes'

const DEFAULT_SETTINGS: AppSettings = {
  general: {
    dataDir: '',
    autoSave: true
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
    resolutionTier: 'auto'
  },
  comfyui: {
    baseUrl: 'http://127.0.0.1:8188',
    workflowDir: '',
    inputDir: ''
  },
  tts: {
    defaultVoice: 'zh-CN-XiaoxiaoNeural',
    rate: 100,
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
      const saved = JSON.parse(content.replace(/^﻿/, ''))
      // 深合并，确保新字段有默认值
      return this.merge(DEFAULT_SETTINGS, saved)
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  async save(settings: AppSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.settingsPath), { recursive: true })
    // 原子写：先写临时文件再 rename，避免崩溃截断 settings.json
    const tmp = this.settingsPath + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(settings, null, 2))
    await fs.rename(tmp, this.settingsPath)
  }

  private merge(defaults: AppSettings, saved: Partial<AppSettings>): AppSettings {
    const result = { ...defaults }
    for (const key of Object.keys(defaults) as Array<keyof AppSettings>) {
      if (saved[key]) {
        result[key] = { ...defaults[key], ...saved[key] } as never
      }
    }
    return result
  }
}
