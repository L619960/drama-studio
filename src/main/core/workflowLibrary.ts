import * as fs from 'fs/promises'
import * as path from 'node:path'
import { readFileSync } from 'node:fs'
import type { ObjectNodeInfo } from './workflowLoader'

/**
 * ComfyUI 工作流库（用户收集的 UI 格式工作流全集）接入层。
 *
 * 背景：ComfyUI 网页「保存」的工作流是 UI 格式（顶层 nodes[] + links[]），
 * 而应用渲染链路（WorkflowLoader.buildGraph）与 /prompt 提交需要 API 格式
 * （顶层数字键 → { class_type, inputs }）。本服务负责：
 * 1. 递归扫描工作流库目录，按目录分类列出全部工作流（含格式识别）；
 * 2. 把单个 UI 工作流转换为 API 格式（widgets_values 按节点 required 顺序填入、
 *    links 接成 [from_node, from_slot] 连接），供导入为应用模板后直接可跑。
 */

interface UiNode {
  id: number
  type: string
  title?: string
  inputs?: Array<{ name: string; type: string; link: number | null }>
  widgets_values?: unknown[]
}

interface UiWorkflow {
  nodes?: UiNode[]
  links?: Array<[number, number, number, number, number, string]>
}

export interface LibraryWorkflowItem {
  /** 库内相对路径（含分类目录），如 02.Qwen图片工作流/3.Qwen2511多图参考 */
  relPath: string
  /** 顶层分类目录名（无子目录时为「未分类」） */
  category: string
  fileName: string
  format: 'ui' | 'api'
  nodeCount: number
  /** 是否含图像输入节点（LoadImage 等），用于快速判断用途 */
  hasImageInput: boolean
  /** 扫描阶段发现的格式异常（不影响列出） */
  error?: string
}

export interface ConvertResult {
  graph: Record<string, unknown>
  nodeCount: number
  /** 转换过程中未在 object_info 找到定义的节点类型（提交时会缺节点，需先装插件） */
  unknownNodeTypes: string[]
}

const IMAGE_INPUT_NODE_RE = /^(LoadImage|LoadImageMask|VHS_LoadImagePath|VHS_LoadImages)$/

export class WorkflowLibrary {
  private libDir: string

  constructor(libDir: string) {
    this.libDir = libDir
  }

  /** 运行时切换库目录（设置保存后调用） */
  setLibDir(dir: string): void {
    this.libDir = dir
  }

  /** 递归扫描工作流库：相对路径即「分类/文件名」，文件名去 .json 后缀 */
  async list(): Promise<LibraryWorkflowItem[]> {
    if (!this.libDir.trim()) return []
    const items: LibraryWorkflowItem[] = []
    try {
      await this.walk(this.libDir, '', items)
    } catch {
      return []
    }
    items.sort((a, b) => a.relPath.localeCompare(b.relPath, 'zh-CN'))
    return items
  }

  private async walk(dir: string, rel: string, out: LibraryWorkflowItem[]): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        await this.walk(full, rel ? `${rel}/${e.name}` : e.name, out)
      } else if (e.isFile() && /\.json$/i.test(e.name)) {
        const relPath = rel ? `${rel}/${e.name}` : e.name
        try {
          const content = await fs.readFile(full, 'utf-8')
          const parsed = JSON.parse(content)
          const item = this.describe(relPath, parsed)
          out.push(item)
        } catch (_err) {
          out.push({
            relPath,
            category: rel || '未分类',
            fileName: e.name.replace(/\.json$/i, ''),
            format: 'ui',
            nodeCount: 0,
            hasImageInput: false,
            error: '无法解析 JSON'
          })
        }
      }
    }
  }

  private describe(relPath: string, parsed: unknown): LibraryWorkflowItem {
    const isApi = parsed !== null && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && Object.keys(parsed as Record<string, unknown>).every(k => /^\d+$/.test(k))
      && !('nodes' in (parsed as Record<string, unknown>))
    const nodes = (parsed as UiWorkflow)?.nodes
    const nodeCount = Array.isArray(nodes) ? nodes.length : isApi ? Object.keys(parsed as Record<string, unknown>).length : 0
    const hasImageInput = Array.isArray(nodes)
      ? nodes.some(n => IMAGE_INPUT_NODE_RE.test(n.type))
      : isApi
        ? Object.values(parsed as Record<string, { class_type?: string }>).some(n => IMAGE_INPUT_NODE_RE.test(n?.class_type ?? ''))
        : false
    const parts = relPath.split('/')
    return {
      relPath,
      category: parts.length > 1 ? parts[0] : '未分类',
      fileName: parts[parts.length - 1].replace(/\.json$/i, ''),
      format: isApi ? 'api' : 'ui',
      nodeCount,
      hasImageInput
    }
  }

  /**
   * UI → API 转换（ComfyUI 官方前端同款算法）：
   * 1. 每个节点生成 { class_type, inputs:{} }；
   * 2. 连接的输入（node.inputs[].link）按 links 表接成 [from_node_id, from_slot]；
   * 3. 未连接的 widget 值按节点定义的 required 输入顺序填入（跳过已连接键）。
   * 未知节点类型保留 class_type（提交时报缺节点，validateTemplate 可查），不静默丢弃。
   */
  convertToApi(relPath: string, objectInfo: Record<string, ObjectNodeInfo>): ConvertResult {
    const rel = relPath.replace(/\\/g, '/')
    // 防路径穿越（与 conversationService tOpenFile 的 baseDir 前缀校验同范式）：
    // resolve 后必须仍在 libDir 内，阻断 ../、..\ 以及跨盘符/同盘绝对路径读取库外 JSON
    const abs = path.resolve(this.libDir, rel)
    const root = path.resolve(this.libDir)
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error('工作流库路径越界：仅允许读取库目录内的文件')
    }
    const filePath = path.join(this.libDir, ...rel.split('/'))
    const content = readFileSync(filePath, 'utf-8')
    const ui = JSON.parse(content) as UiWorkflow
    const nodes = ui.nodes ?? []
    const links = ui.links ?? []

    // 判断已是 API 格式：直接返回
    const keys = Object.keys(ui)
    if (keys.length && keys.every(k => /^\d+$/.test(k)) && !('nodes' in ui)) {
      return {
        graph: ui as unknown as Record<string, unknown>,
        nodeCount: keys.length,
        unknownNodeTypes: []
      }
    }

    const graph: Record<string, unknown> = {}
    const unknownNodeTypes: string[] = []

    // 第一遍：class_type + 连接
    for (const node of nodes) {
      const apiNode: { class_type: string; inputs: Record<string, unknown> } = {
        class_type: node.type,
        inputs: {}
      }
      graph[String(node.id)] = apiNode
      if (!objectInfo[node.type]) unknownNodeTypes.push(node.type)
    }
    for (const node of nodes) {
      const target = graph[String(node.id)] as { inputs: Record<string, unknown> }
      const connected = new Set<string>()
      for (const input of node.inputs ?? []) {
        if (input.link == null) continue
        const link = links.find(l => l[0] === input.link)
        if (!link) continue
        target.inputs[input.name] = [String(link[1]), link[2]]
        connected.add(input.name)
      }
      // widget 值 → required 输入顺序
      const info = objectInfo[node.type]
      const requiredKeys = info?.input?.required ? Object.keys(info.input.required) : []
      const values = node.widgets_values ?? []
      let vi = 0
      for (const key of requiredKeys) {
        if (connected.has(key) || (key in target.inputs)) continue
        if (vi >= values.length) break
        target.inputs[key] = values[vi]
        vi++
      }
    }
    return { graph, nodeCount: nodes.length, unknownNodeTypes }
  }
}
