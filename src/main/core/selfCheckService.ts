import * as fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import * as path from 'node:path'
import type { SelfCheckItem } from '../../shared/ipcTypes'
import type { ProjectStore } from './projectStore'
import type { SkillService } from './skillService'
import type { WorkflowLoader } from './workflowLoader'
import type { FFmpegService } from './ffmpegService'
import type { ComfyUIClient } from './comfyuiClient'
import type { SettingsStore } from './settingsStore'
import {
  PROMPT_QA_MARKERS,
  REALISM_POSITIVE,
  identityLockBlock,
  faceCastingPrompt,
  bodySheetPrompt,
  scenePlatePrompt,
  shotFramePrompt,
  videoMotionPrompt
} from '../../shared/imagePrompts'
import { propLockFromAction, validateNarrativeContinuity } from '../../shared/narrativeBeats'

/**
 * 应用环境与功能自检（启动时/手动触发）：
 * - 文件系统类问题（缺失目录、损坏会话档案）自动修复并标记 fixed
 * - 环境类问题（ffmpeg/ComfyUI/LLM 配置）只报告不阻塞
 */
export class SelfCheckService {
  constructor(
    private baseDir: string,
    private projects: ProjectStore,
    private skills: SkillService,
    private workflows: WorkflowLoader,
    private ffmpeg: FFmpegService,
    private comfy: ComfyUIClient,
    private settings: SettingsStore
  ) {}

  async run(): Promise<SelfCheckItem[]> {
    const items: SelfCheckItem[] = []
    items.push(await this.checkDirs())
    items.push(await this.checkConversations())
    items.push(await this.checkProjects())
    items.push(await this.checkSkills())
    items.push(await this.checkWorkflows())
    items.push(await this.checkPromptQa())
    items.push(await this.checkSettings())
    items.push(await this.checkFfmpeg())
    items.push(await this.checkComfy())
    return items
  }

  /** 数据目录齐备：缺失自动创建 */
  private async checkDirs(): Promise<SelfCheckItem> {
    const dirs = ['projects', 'conversations', 'uploads', 'tmp']
    const created: string[] = []
    for (const d of dirs) {
      const full = path.join(this.baseDir, d)
      try {
        await fs.access(full)
      } catch {
        await fs.mkdir(full, { recursive: true })
        created.push(d)
      }
    }
    return {
      name: '数据目录',
      ok: true,
      fixed: created.length > 0,
      detail: created.length ? `已自动创建缺失目录：${created.join('、')}` : '目录结构完整（projects/conversations/uploads/tmp）'
    }
  }

  /** 会话档案：JSON 损坏的自动备份隔离，避免对话页崩溃 */
  private async checkConversations(): Promise<SelfCheckItem> {
    const dir = path.join(this.baseDir, 'conversations')
    let broken = 0
    const names: string[] = []
    let entries: Dirent[] = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return { name: '对话记录', ok: true, detail: '暂无对话记录' }
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue
      const full = path.join(dir, e.name)
      try {
        const parsed = JSON.parse(await fs.readFile(full, 'utf-8'))
        if (!Array.isArray(parsed)) throw new Error('not array')
      } catch {
        broken++
        names.push(e.name)
        await fs.rename(full, `${full}.bak_${Date.now()}`).catch(() => undefined)
      }
    }
    return {
      name: '对话记录',
      ok: true,
      fixed: broken > 0,
      detail: broken
        ? `${broken} 个损坏会话已备份隔离（${names.join('、')}），不影响其他对话`
        : `${entries.filter(e => e.isFile() && e.name.endsWith('.json')).length} 个会话档案均正常`
    }
  }

  /** 项目档案：损坏的 project.json 报告（含用户数据，不做自动删除） */
  private async checkProjects(): Promise<SelfCheckItem> {
    const root = path.join(this.baseDir, 'projects')
    let broken = 0
    const names: string[] = []
    let orphanRendering = 0
    let total = 0
    let entries: Dirent[] = []
    try {
      entries = await fs.readdir(root, { withFileTypes: true })
    } catch {
      return { name: '项目档案', ok: true, detail: '暂无项目' }
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const jsonPath = path.join(root, e.name, 'project.json')
      let raw: string
      try {
        raw = await fs.readFile(jsonPath, 'utf-8')
      } catch {
        continue // 空目录（可能是崩溃残留），不视为损坏
      }
      total++
      try {
        const p = JSON.parse(raw) as { id?: string; title?: string; shots?: Array<{ status?: string }> }
        if (!p.id || !Array.isArray(p.shots)) throw new Error('bad shape')
        orphanRendering += p.shots.filter(s => s.status === 'rendering').length
      } catch {
        broken++
        names.push(`${e.name}/project.json`)
      }
    }
    if (broken > 0) {
      return {
        name: '项目档案', ok: false,
        detail: `${broken} 个项目档案损坏无法解析：${names.join('、')}。文件已保留，可在设置的数据目录中手工排查`
      }
    }
    return {
      name: '项目档案', ok: true,
      detail: `${total} 个项目档案正常` +
        (orphanRendering > 0 ? `；${orphanRendering} 个镜头处于渲染中断状态（应用启动时已自动恢复为待渲染）` : '')
    }
  }

  /** 技能库：内置技能随版本自动补齐 */
  private async checkSkills(): Promise<SelfCheckItem> {
    const all = await this.skills.list()
    const builtin = all.filter(s => s.builtin).length
    const custom = all.length - builtin
    const enabledTools = all.filter(s => s.enabled && s.kind === 'tool').length
    return {
      name: '技能库', ok: true,
      detail: `内置 ${builtin} 项 / 自定义 ${custom} 项；对话可用工具技能 ${enabledTools} 项`
    }
  }

  /** 工作流模板：可读性与占位符静态校验（不依赖 ComfyUI 在线） */
  private async checkWorkflows(): Promise<SelfCheckItem> {
    try {
      const metas = await this.workflows.list()
      if (!metas.length) {
        return { name: '工作流模板', ok: false, detail: '未找到任何工作流模板，渲染不可用（resources/workflows 目录）' }
      }
      return { name: '工作流模板', ok: true, detail: `${metas.length} 个模板解析正常：${metas.map(m => m.name).join('、')}` }
    } catch (e) {
      return { name: '工作流模板', ok: false, detail: `模板目录读取失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }

  /** 电影工业级提示词模块：锚点与导出完整性（静态导入，避免打包后动态 import 失效） */
  private async checkPromptQa(): Promise<SelfCheckItem> {
    try {
      const look = 'chinese woman, white hanfu robe'
      const blob = [
        REALISM_POSITIVE,
        identityLockBlock(look),
        faceCastingPrompt(look),
        scenePlatePrompt('ancient courtyard'),
        videoMotionPrompt({ action: 'stands still', lookEn: look, scene: 'wooden pavilion' })
      ].join('\n')
      const missing = PROMPT_QA_MARKERS.filter((m) => !blob.includes(m))
      const samples = [
        faceCastingPrompt(look),
        bodySheetPrompt(look),
        scenePlatePrompt('mountain path'),
        shotFramePrompt({
          phase: 'start',
          lookEn: look,
          scene: 'wooden pavilion',
          action: 'holds sword'
        }),
        videoMotionPrompt({ action: 'turns slightly', lookEn: look })
      ]
      const tooShort = samples.filter(s => s.length < 80).length
      const umbrellaLock = propLockFromAction('hands exchanging black umbrella handle')
      const umbrellaFrame = shotFramePrompt({
        phase: 'start',
        lookEn: look,
        scene: 'rainy street',
        action: 'hands exchanging black umbrella handle, still holding umbrella'
      })
      const propOk =
        /KEY PROP ON SCREEN/.test(umbrellaLock) &&
        /KEY PROP ON SCREEN/.test(umbrellaFrame) &&
        /umbrella/.test(umbrellaFrame)
      const badShots = [
        { index: 1, action: 'rainy ancient courtyard, warm torch reflections', dialogue: '', type: 't2v' as const },
        { index: 2, action: 'figure with lantern approaches across wet stone pavement', dialogue: '', type: 't2v' as const },
        {
          index: 3,
          action: 'dialogue performance, speaking toward off-screen',
          dialogue: '你不是说加班到很晚？',
          type: 'i2v' as const,
          shotSize: 'medium'
        },
        { index: 4, action: 'opens the car door beside black sedan', dialogue: '', type: 'i2v' as const, shotSize: 'medium' },
        { index: 5, action: 'sits in passenger seat looking ahead', dialogue: '', type: 'i2v' as const, shotSize: 'medium' },
        { index: 6, action: 'empty rainy street tungsten haze', dialogue: '', type: 't2v' as const }
      ]
      const narr = validateNarrativeContinuity(
        '伞递给了谁',
        '接过沈川递来的伞后驱车离开',
        '沈川递伞，林夏接伞，两人上车驶离',
        badShots
      )
      const narrOk =
        narr.some(w => /伞/.test(w)) &&
        narr.some(w => /反应/.test(w)) &&
        narr.some(w => /驶离|车辆/.test(w))
      if (missing.length || tooShort || !propOk || !narrOk) {
        return {
          name: '提示词工业标准',
          ok: false,
          detail: [
            missing.length ? `缺失锚点：${missing.join(', ')}` : '',
            tooShort ? `${tooShort} 条提示词过短` : '',
            !propOk ? '关键道具锁定未注入首帧/视频提示' : '',
            !narrOk ? `叙事连续性校验未命中预期（${narr.join('；') || '空'}）` : ''
          ].filter(Boolean).join('；')
        }
      }
      return {
        name: '提示词工业标准',
        ok: true,
        detail: `电影工业级锚点齐全（${PROMPT_QA_MARKERS.length}）；定妆/场景/首帧/视频提示词可用；道具锁与叙事节拍校验 OK`
      }
    } catch (e) {
      return {
        name: '提示词工业标准',
        ok: false,
        detail: `提示词模块校验失败：${e instanceof Error ? e.message : String(e)}`
      }
    }
  }

  /** 关键配置：LLM Key 未配置会直接影响 AI 拆镜/对话；非法帧数自动钳回 16n+1 */
  private async checkSettings(): Promise<SelfCheckItem> {
    let s = await this.settings.get()
    const problems: string[] = []
    const fixedBits: string[] = []

    // settingsStore.get 已 normalize；若磁盘仍是脏值，写回一次
    const rawFrames = s.render.defaultFrames
    if (rawFrames < 17 || (rawFrames - 1) % 16 !== 0) {
      const n = Math.max(1, Math.round((rawFrames - 1) / 16))
      const fixed = n * 16 + 1
      s = { ...s, render: { ...s.render, defaultFrames: fixed } }
      await this.settings.save(s)
      fixedBits.push(`默认帧数 ${rawFrames}→${fixed}（已对齐 16n+1）`)
    }

    if (!s.llm.apiKey) problems.push('LLM API Key 未配置（设置 → LLM，AI 拆镜/导演对话不可用）')
    if (!s.comfyui.baseUrl) problems.push('ComfyUI 地址为空')
    const conc = s.render.assetConcurrency ?? 2
    if (conc < 1 || conc > 3) problems.push(`资产并发 ${conc} 超出 1~3`)

    const c = s.creation
    if (!c?.storyboard || !c?.character || !c?.scene || !c?.edit) {
      problems.push('创作四模块 settings.creation 缺失')
    } else {
      if (c.storyboard.minShots > c.storyboard.maxShots) problems.push('分镜最少镜头大于最多镜头')
      if ((c.edit.defaultFrames - 1) % 16 !== 0) problems.push('剪辑默认帧数非 16n+1')
      if (c.character.candidates < 1 || c.character.candidates > 4) problems.push('人物抽卡张数非法')
      if (c.scene.candidates < 1 || c.scene.candidates > 4) problems.push('场景抽卡张数非法')
      if (c.edit.renderCandidates < 1 || c.edit.renderCandidates > 3) problems.push('渲染抽卡条数非法')
      if (c.edit.comfyTimeoutSec < 60) problems.push('Comfy 超时过短')
    }

    const ok = problems.length === 0
    const base = ok
      ? `LLM: ${s.llm.model}；ComfyUI: ${s.comfyui.baseUrl}；工作流: ${s.workflow.default}；帧数: ${s.render.defaultFrames}；复审: ${c?.edit?.reviewGate || s.render.reviewGate}；抽卡 人${c?.character?.candidates}/景${c?.scene?.candidates}/渲${c?.edit?.renderCandidates}；并发: ${conc}`
      : problems.join('；')
    return {
      name: '关键配置',
      ok,
      fixed: fixedBits.length > 0,
      detail: fixedBits.length ? `${base}；已自动修复：${fixedBits.join('、')}` : base
    }
  }

  /** ffmpeg/ffprobe 可执行性（打包内置优先） */
  private async checkFfmpeg(): Promise<SelfCheckItem> {
    try {
      await this.ffmpeg.ready()
      return { name: 'FFmpeg', ok: true, detail: 'ffmpeg/ffprobe 检测通过，音视频合成可用' }
    } catch (e) {
      return { name: 'FFmpeg', ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
  }

  /** ComfyUI 在线状态：离线只提示，不算故障（用户可能后启动） */
  private async checkComfy(): Promise<SelfCheckItem> {
    const online = await this.comfy.healthCheck().catch(() => false)
    const s = await this.settings.get()
    return {
      name: 'ComfyUI',
      ok: true,
      warn: !online,
      detail: online
        ? `在线（${s.comfyui.baseUrl}），渲染引擎就绪`
        : `离线（${s.comfyui.baseUrl}）。请先启动 ComfyUI，否则无法渲染`
    }
  }
}
