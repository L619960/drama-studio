/**
 * 导演技能库自动加载器（看守机制核心）。
 * 流水线任务开始即自动读取 skills/director/rules.json：
 * - cinematicQuality：电影级质量条款（图/视频生成注入）
 * - auditChecklist：逐镜审核清单（LLM 视觉审核提示词）
 * - methodRules：方法论（剧本分析/分镜 LLM 系统提示词注入）
 * 技能库缺失/损坏时静默降级（返回 null），不阻断流水线——代码层有默认条款兜底。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createLogger } from './logger'

const log = createLogger('SkillLibrary')

export interface AuditCheckItem {
  id: string
  label: string
  check: string
  severity: 'block' | 'warn'
}

export interface DirectorRules {
  name: string
  version: number
  cinematicQuality: {
    quality: string[]
    camera: string[]
    lighting: string[]
    fx: string[]
    scene: string[]
  }
  auditChecklist: AuditCheckItem[]
  methodRules: string[]
}

export class SkillLibrary {
  private rules: DirectorRules | null = null
  private loadError = ''

  constructor(private skillsDir: string) {}

  /** 加载技能库（幂等；force=true 时强制重读磁盘，兑现「编辑 rules.json 后下次流水线自动生效」） */
  async load(force = false): Promise<DirectorRules | null> {
    if (!force && this.rules) return this.rules
    try {
      const content = await fs.readFile(path.join(this.skillsDir, 'director', 'rules.json'), 'utf-8')
      const parsed = JSON.parse(content) as DirectorRules
      if (
        !parsed?.cinematicQuality || !Array.isArray(parsed.auditChecklist) ||
        !Array.isArray(parsed.methodRules)
      ) {
        throw new Error('rules.json 结构不完整')
      }
      this.rules = parsed
      log.info(`技能库已加载：director v${parsed.version}，审核项 ${parsed.auditChecklist.length}，方法论 ${parsed.methodRules.length} 条`)
      return parsed
    } catch (e) {
      this.loadError = e instanceof Error ? e.message : String(e)
      log.warn(`技能库加载失败（降级为代码层默认条款）：${this.loadError}`)
      return null
    }
  }

  /** 电影级质量条款块（英文，注入图/视频生成提示词末尾；无技能库返回空串） */
  async qualityBlock(): Promise<string> {
    const r = await this.load()
    if (!r) return ''
    return [
      ...r.cinematicQuality.quality,
      ...r.cinematicQuality.camera,
      ...r.cinematicQuality.lighting,
      ...r.cinematicQuality.fx,
      ...r.cinematicQuality.scene
    ].join(', ')
  }

  /** 审核清单（LLM 视觉审核提示词用） */
  async auditChecklist(): Promise<AuditCheckItem[]> {
    const r = await this.load()
    return r ? r.auditChecklist : []
  }

  /** 方法论规则（注入剧本分析/分镜系统提示词） */
  async methodRules(): Promise<string[]> {
    const r = await this.load()
    return r ? r.methodRules : []
  }

  /** 技能库路径（设置面板/调试展示用） */
  dir(): string {
    return path.join(this.skillsDir, 'director')
  }

  loadErrorHint(): string {
    return this.loadError
  }
}
