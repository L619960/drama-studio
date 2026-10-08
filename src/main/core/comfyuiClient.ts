import axios from 'axios'
import * as fs from 'fs/promises'
import * as path from 'node:path'
import type WebSocket from 'ws'
import type { ComfyWSMessage, ComfyUIHistoryOutput, ComfyUIOutputItem } from '../../shared/ipcTypes'
import type { ObjectNodeInfo as ObjectInfoLike } from './workflowLoader'
import { createLogger } from './logger'

const log = createLogger('ComfyUI')

export interface ComfyUIClientConfig {
  baseUrl: string
  clientId: string
}

export interface SubmitResult {
  promptId: string
  number: number
}

/**
 * 显存档位（按 ComfyUI /system_stats 的 vram_total 自动判定）：
 * 竖屏 9:16、宽高均为 32 的倍数（适配 VAE 空间压缩）；maxFrames 为 H3 帧数(17k+5)上限。
 * 档位只决定「初始分辨率/时长上限」，OOM 自动退避仍在其基础上继续降档。
 */
export type VramTierName = 'low' | 'mid' | 'standard' | 'high' | 'ultra'

export interface VramTier {
  name: VramTierName
  label: string
  /** H3 竖屏渲染宽高 */
  width: number
  height: number
  /** H3 帧数上限（17k+5 网格值） */
  maxFrames: number
  /** Wan 单镜时长上限（秒） */
  maxWanSec: number
}

export const VRAM_TIERS: Record<VramTierName, VramTier> = {
  // <8GB：480p 以下，单镜不超过 ~4.5s
  low: { name: 'low', label: '8GB 以下', width: 448, height: 800, maxFrames: 107, maxWanSec: 4 },
  // 8~12GB：480p
  mid: { name: 'mid', label: '8–12GB', width: 480, height: 864, maxFrames: 124, maxWanSec: 5 },
  // 12~18GB：当前验证过的基准档（512x896，单镜最长 ~9.3s）
  standard: { name: 'standard', label: '12–18GB', width: 512, height: 896, maxFrames: 158, maxWanSec: 5 },
  // 18~24GB：准高清竖屏
  high: { name: 'high', label: '18–24GB', width: 640, height: 1136, maxFrames: 158, maxWanSec: 5 },
  // >=24GB：H3 官方 768p
  ultra: { name: 'ultra', label: '24GB 以上', width: 768, height: 1344, maxFrames: 175, maxWanSec: 6 }
}

const GIB = 1024 ** 3

interface PendingPrompt {
  resolve: (output: ComfyUIHistoryOutput) => void
  reject: (error: Error) => void
  onProgress?: (percent: number, currentNode: string | null) => void
  timer: NodeJS.Timeout
  pollTimer?: NodeJS.Timeout
}

export class ComfyUIClient {
  private baseUrl: string
  private clientId: string
  private ws: WebSocket | null = null
  private pendingPrompts = new Map<string, PendingPrompt>()
  private reconnectTimer: NodeJS.Timeout | null = null
  private connected = false
  private connecting = false
  /** 显存档位探测缓存（5 分钟）：{ 档位, 探测时间戳 }，探测失败也缓存 standard 避免每镜重复请求 */
  private vramTierCache: { tier: VramTier; at: number } | null = null

  constructor(config: ComfyUIClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.clientId = config.clientId
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await axios.get(`${this.baseUrl}/system_stats`, { timeout: 5000 })
      return res.status === 200
    } catch {
      return false
    }
  }

  /** 系统/GPU 状态（控制面板用） */
  async getSystemStats(): Promise<import('../../shared/ipcTypes').ComfySystemStats | null> {
    try {
      const res = await axios.get(`${this.baseUrl}/system_stats`, { timeout: 8000 })
      const d = res.data
      const devices = Array.isArray(d?.devices) ? d.devices : []
      return {
        online: true,
        version: String(d?.system?.comfyui_version ?? ''),
        pythonVersion: String(d?.system?.python_version ?? ''),
        devices: devices.map((dev: Record<string, unknown>) => ({
          name: String(dev.name ?? ''),
          type: String(dev.type ?? ''),
          vramTotal: Number(dev.vram_total ?? 0),
          vramFree: Number(dev.vram_free ?? 0)
        }))
      }
    } catch {
      return null
    }
  }

  /**
   * 探测显存档位（5 分钟缓存）。优先取 CUDA 设备 vram_total；
   * ComfyUI 离线/取不到时回退 standard（历史验证档位），不阻塞渲染。
   */
  async getVramTier(): Promise<VramTier> {
    const now = Date.now()
    if (this.vramTierCache && now - this.vramTierCache.at < 5 * 60 * 1000) {
      return this.vramTierCache.tier
    }
    let tier: VramTier = VRAM_TIERS.standard
    try {
      const stats = await this.getSystemStats()
      const gpu = stats?.devices.find(d => /cuda/i.test(d.type))
      const vramBytes = gpu?.vramTotal ?? 0
      if (vramBytes > 0) {
        if (vramBytes < 8 * GIB) tier = VRAM_TIERS.low
        else if (vramBytes < 12 * GIB) tier = VRAM_TIERS.mid
        else if (vramBytes < 18 * GIB) tier = VRAM_TIERS.standard
        else if (vramBytes < 24 * GIB) tier = VRAM_TIERS.high
        else tier = VRAM_TIERS.ultra
        log.info(`显存 ${(vramBytes / GIB).toFixed(1)} GiB → 档位 ${tier.name}（${tier.width}x${tier.height}，H3≤${tier.maxFrames}帧）`)
      }
    } catch {
      // 探测失败用 standard
    }
    this.vramTierCache = { tier, at: now }
    return tier
  }

  /** 已安装节点类名全集（主进程侧只回传 key，避免 MB 级负载进 IPC） */
  async getObjectNodeNames(): Promise<string[]> {
    try {
      const res = await axios.get(`${this.baseUrl}/object_info`, { timeout: 30000 })
      return Object.keys(res.data || {}).sort()
    } catch {
      return []
    }
  }

  /** 全量 /object_info（含节点输入定义，用于工作流环境自检），5 分钟缓存 */
  private objectInfoCache: { data: Record<string, unknown>; at: number } | null = null

  async getObjectInfo(): Promise<Record<string, ObjectInfoLike>> {
    const now = Date.now()
    if (this.objectInfoCache && now - this.objectInfoCache.at < 5 * 60 * 1000) {
      return this.objectInfoCache.data as Record<string, ObjectInfoLike>
    }
    const res = await axios.get(`${this.baseUrl}/object_info`, { timeout: 30000 })
    const data = (res.data || {}) as Record<string, unknown>
    this.objectInfoCache = { data, at: now }
    return data as Record<string, ObjectInfoLike>
  }

  async uploadImage(localPath: string): Promise<string> {
    const formData = new FormData()
    const buffer = await fs.readFile(localPath)
    const blob = new Blob([buffer], { type: 'image/png' })
    formData.append('image', blob, path.basename(localPath))
    const res = await axios.post(`${this.baseUrl}/upload/image`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 30000
    })
    return res.data.name
  }

  /**
   * 上传音频供 LoadAudio 节点使用。
   * ComfyUI 的 /upload/image 端点实际接受任意文件到 input 目录；
   * 失败时回退：直接复制到 settings 里配置的 inputDir。
   */
  async uploadAudio(localPath: string, inputDir?: string): Promise<string> {
    const baseName = path.basename(localPath)
    try {
      const formData = new FormData()
      const buffer = await fs.readFile(localPath)
      formData.append('image', new Blob([buffer]), baseName)
      formData.append('overwrite', 'true')
      const res = await fetch(`${this.baseUrl}/upload/image`, { method: 'POST', body: formData })
      const data = await res.json() as { name?: string }
      if (!data.name) throw new Error('upload rejected')
      return data.name
    } catch (e) {
      if (!inputDir) throw new Error(`音频上传失败且未配置 ComfyUI input 目录: ${(e as Error).message}`)
      await fs.copyFile(localPath, path.join(inputDir, baseName))
      return baseName
    }
  }

  async submit(graph: Record<string, unknown>): Promise<SubmitResult> {
    const res = await axios.post(`${this.baseUrl}/prompt`, {
      prompt: graph,
      client_id: this.clientId
    }, { timeout: 30000 })

    if (res.data.error) {
      throw new Error(res.data.error)
    }
    return {
      promptId: res.data.prompt_id,
      number: res.data.number
    }
  }

  /** 获取可用 Checkpoint 模型列表（CheckpointLoaderSimple） */
  async getCheckpoints(): Promise<string[]> {
    try {
      const res = await axios.get(`${this.baseUrl}/object_info/CheckpointLoaderSimple`, { timeout: 10000 })
      const ckpts = res.data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]
      return Array.isArray(ckpts) ? ckpts : []
    } catch {
      return []
    }
  }

  /** 查询某自定义节点类是否已安装（如 LatentSyncNode），结果短时缓存 */
  private nodeCache = new Map<string, { ok: boolean; at: number }>()

  async hasNode(classType: string): Promise<boolean> {
    const cached = this.nodeCache.get(classType)
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.ok
    try {
      const res = await axios.get(`${this.baseUrl}/object_info/${classType}`, { timeout: 10000 })
      const ok = Boolean(res.data?.[classType])
      this.nodeCache.set(classType, { ok, at: Date.now() })
      return ok
    } catch {
      return false
    }
  }

  /** 中断 ComfyUI 当前正在执行的任务（POST /interrupt），释放显卡 */
  async interrupt(): Promise<void> {
    try {
      await axios.post(`${this.baseUrl}/interrupt`, {}, { timeout: 5000 })
    } catch {
      // 忽略中断请求失败
    }
  }

  async getHistory(promptId: string): Promise<ComfyUIHistoryOutput | null> {
    try {
      const res = await axios.get(`${this.baseUrl}/history/${promptId}`, { timeout: 10000 })
      const history = res.data[promptId]
      if (!history?.outputs) return null

      const output: ComfyUIHistoryOutput = {}
      for (const nodeId of Object.keys(history.outputs)) {
        const nodeOutput = history.outputs[nodeId] as Record<string, unknown>
        for (const [key, value] of Object.entries(nodeOutput)) {
          if (Array.isArray(value) && value.length > 0 && (value[0] as { filename?: string })?.filename) {
            output[key] = value as ComfyUIOutputItem[]
          }
        }
      }
      return output
    } catch {
      return null
    }
  }

  async download(filename: string, subfolder: string, type: string, outputPath: string): Promise<void> {
    const res = await axios.get(`${this.baseUrl}/view`, {
      params: { filename, subfolder, type },
      responseType: 'arraybuffer',
      timeout: 60000
    })
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, Buffer.from(res.data))
  }

  /** 从 fullpath 直接读取（本地 ComfyUI 更快） */
  async downloadFromFullPath(fullpath: string, outputPath: string): Promise<void> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.copyFile(fullpath, outputPath)
  }

  async connect(): Promise<void> {
    if (this.connected || this.connecting) return
    this.connecting = true

    const WS = (await import('ws')).default
    const ws = new WS(`ws://${this.baseUrl.replace(/^https?:\/\//, '')}/ws?clientId=${this.clientId}`)

    ws.on('open', () => {
      this.connecting = false
      this.connected = true
      log.info('WebSocket connected')
    })

    ws.on('message', (data) => {
      this.handleMessage(data)
    })

    ws.on('close', () => {
      this.connecting = false
      this.connected = false
      log.info('WebSocket closed, reconnecting...')
      this.scheduleReconnect()
    })

    ws.on('error', (err: Error) => {
      console.error('[ComfyUI] WebSocket error:', err.message)
    })

    this.ws = ws as unknown as WebSocket
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.connected = false
    this.connecting = false
    // 断开时拒绝所有挂起的等待，避免调用方挂到超时
    for (const [promptId, pending] of this.pendingPrompts) {
      this.settlePrompt(promptId, pending)
      pending.reject(new Error('ComfyUI WebSocket disconnected'))
    }
    this.pendingPrompts.clear()
  }

  /**
   * 运行时切换 ComfyUI 服务地址（设置页修改后调用）。
   * 先断开旧 WS，再用新地址重连。
   */
  async setBaseUrl(url: string): Promise<void> {
    const newUrl = url.replace(/\/$/, '')
    if (newUrl === this.baseUrl) return
    this.disconnect()
    this.baseUrl = newUrl
    await this.connect()
  }

  async waitForCompletion(
    promptId: string,
    onProgress?: (percent: number, currentNode: string | null) => void,
    timeoutMs = 30 * 60 * 1000
  ): Promise<ComfyUIHistoryOutput> {
    return new Promise((resolve, reject) => {
      const pending: PendingPrompt = { resolve, reject, onProgress, timer: undefined as unknown as NodeJS.Timeout }
      pending.timer = setTimeout(() => {
        this.settlePrompt(promptId, pending)
        reject(new Error(`Prompt ${promptId} timeout after ${timeoutMs / 1000}s`))
      }, timeoutMs)

      // WS 消息可能丢失，每 5s 轮询 history 兜底
      pending.pollTimer = setInterval(async () => {
        const output = await this.getHistory(promptId)
        if (output) {
          this.settlePrompt(promptId, pending)
          resolve(output)
        }
      }, 5000)

      this.pendingPrompts.set(promptId, pending)
    })
  }

  /** 统一清理 pending 的两个定时器并从 Map 移除（所有结束路径都走这里） */
  private settlePrompt(promptId: string, pending: PendingPrompt): void {
    clearTimeout(pending.timer)
    if (pending.pollTimer) clearInterval(pending.pollTimer)
    this.pendingPrompts.delete(promptId)
  }

  private handleMessage(data: unknown): void {
    // ws 库的 message data 是 Buffer，必须先转字符串
    const text = typeof data === 'string' ? data : (data as Buffer).toString?.() ?? ''

    let msg: ComfyWSMessage
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }

    const promptId = 'prompt_id' in msg.data ? msg.data.prompt_id : null
    if (!promptId) return

    const pending = this.pendingPrompts.get(promptId)
    if (!pending) return

    switch (msg.type) {
      case 'executing':
        if (msg.data.node !== null) {
          pending.onProgress?.(0, msg.data.node)
        }
        break

      case 'progress':
        pending.onProgress?.(Math.round((msg.data.value / msg.data.max) * 100), msg.data.node)
        break

      case 'execution_success':
        this.settlePrompt(promptId, pending)
        void this.getHistory(promptId).then(output => {
          if (output) pending.resolve(output)
          else pending.reject(new Error('No output found in history'))
        })
        break

      case 'execution_error':
        this.settlePrompt(promptId, pending)
        pending.reject(new Error(msg.data.exception_message))
        break
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 5000)
  }

  /** 辅助方法：从输出中找到视频文件 */
  findVideoOutput(output: ComfyUIHistoryOutput): ComfyUIOutputItem | null {
    for (const key of ['gifs', 'videos', 'images'] as const) {
      const items = output[key]
      if (items && items.length > 0) {
        return items[0]
      }
    }
    for (const items of Object.values(output)) {
      if (items && items.length > 0 && items[0].filename?.endsWith('.mp4')) {
        return items[0]
      }
    }
    return null
  }
}
