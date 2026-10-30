import * as fs from 'fs/promises'
import * as path from 'node:path'
import type { WorkflowMeta, WorkflowParam, WorkflowCheckIssue, WorkflowCapability } from '../../shared/ipcTypes'

type WorkflowGraph = Record<string, { class_type?: string; _meta?: { title?: string }; inputs?: Record<string, unknown> }>

/** ComfyUI /object_info 中单个节点的最小结构（只取校验需要的部分） */
export interface ObjectNodeInfo {
  input?: {
    required?: Record<string, unknown[]>
    optional?: Record<string, unknown[]>
  }
}

/** 锚定占位符（$KEY$，KEY 可含数字）：供 getEditableParams/updateParam/deepReplace 的精确判定；
 *  带捕获组供 deepReplace 提取键名，.test() 用法不受影响 */
const PLACEHOLDER_RE = /^\$([A-Z_][A-Z0-9_]*)\$$/

/** 全局占位符提取（带捕获组、global）：供 getMeta/buildGraph 扫描工作流全文 */
const PLACEHOLDER_GLOBAL_RE = /\$([A-Z_][A-Z0-9_]*)\$/g

/** 工作流名白名单（与 createWorkflow/importWorkflow 的命名净化字符集一致）：
 *  阻断路径穿越，防止 load/updateParam/buildGraph 等入口以恶意 name 读写 workflowsDir 之外的 JSON */
const WORKFLOW_NAME_RE = /^[\w一-龥-]+$/

/** 图像输入节点（有任意一个 → 图生类） */
const LOAD_IMAGE_NODES = new Set([
  'LoadImage', 'LoadImageMask', 'VHS_LoadImagePath', 'VHS_LoadImages'
])

/** 视频输出节点（有任意一个 → 视频类；T2V 需同时无图像输入） */
const VIDEO_OUT_NODES = new Set(['VHS_VideoCombine'])

/** 音频输出节点（TTS/音乐/配音类） */
const AUDIO_OUT_NODES = new Set(['SaveAudio', 'VHS_SaveAudio'])

/** 依据占位符与节点结构推断工作流能力标签（导演自动选流依据） */
function inferCapability(info: {
  placeholders: string[]
  classTypes: Set<string>
  hasImageInput: boolean
  hasEndFrame: boolean
}): WorkflowCapability {
  const hasVideo = [...info.classTypes].some(t => VIDEO_OUT_NODES.has(t))
  const hasAudio = [...info.classTypes].some(t => AUDIO_OUT_NODES.has(t))
  if (hasAudio && !hasVideo && !info.hasImageInput) return 'audio'
  if (hasVideo) {
    if (info.hasEndFrame) return 'flf2v'
    if (info.hasImageInput) return 'i2v'
    return 't2v'
  }
  if (info.hasImageInput) return 'i2i'
  if (info.placeholders.includes('PROMPT')) return 't2i'
  return 'other'
}

export class WorkflowLoader {
  private workflowsDir: string
  /** D-05：按工作流文件串行化「读-改-写」，防 UI 连续保存竞态丢更新/写坏 JSON */
  private writeQueues = new Map<string, Promise<void>>()

  constructor(workflowsDir: string) {
    this.workflowsDir = workflowsDir
  }

  /** D-05：同一工作流的读改写串行执行（前一个失败也继续跑后续，不阻塞队列） */
  private enqueueWrite(name: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.writeQueues.get(name) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.writeQueues.set(name, next.catch(() => undefined))
    return next
  }

  /** 从 JSON 文本直接创建工作流（导演 agent 自建工作流用），返回工作流名称 */
  async createWorkflow(name: string, content: string): Promise<string> {
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      throw new Error('不是合法的 JSON')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('不是有效的 ComfyUI 工作流格式')
    }
    const keys = Object.keys(parsed).filter(k => k !== '_comment')
    if (keys.length === 0 || !keys.every((k) => /^\d+$/.test(k))) {
      throw new Error('工作流节点结构不合法（应为数字键）')
    }
    const baseName = name.replace(/\.json$/i, '').replace(/[^\w一-龥-]/g, '_') || 'workflow'
    let finalName = baseName
    let counter = 1
    while (await this.fileExists(finalName)) {
      finalName = `${baseName}_${counter++}`
    }
    await fs.writeFile(path.join(this.workflowsDir, `${finalName}.json`), content, 'utf-8')
    return finalName
  }

  /** 导入外部工作流 JSON 到工作流目录，返回工作流名称 */
  async importWorkflow(absolutePath: string): Promise<string> {
    let content: string
    try {
      content = await fs.readFile(absolutePath, 'utf-8')
    } catch {
      throw new Error('无法读取文件')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      throw new Error('文件不是合法的 JSON')
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('不是有效的 ComfyUI 工作流格式')
    }
    const keys = Object.keys(parsed)
    if (keys.length === 0 || !keys.every((k) => /^\d+$/.test(k))) {
      throw new Error('工作流节点结构不合法（应为数字键）')
    }

    const baseName = path.basename(absolutePath, '.json').replace(/[^\w一-龥-]/g, '_') || 'workflow'
    let name = baseName
    let counter = 1
    while (await this.fileExists(name)) {
      name = `${baseName}_${counter++}`
    }
    await fs.writeFile(path.join(this.workflowsDir, `${name}.json`), content, 'utf-8')
    return name
  }

  private async fileExists(name: string): Promise<boolean> {
    try {
      await fs.access(path.join(this.workflowsDir, `${name}.json`))
      return true
    } catch {
      return false
    }
  }

  /** 列出所有可用工作流（扫描目录下的 *.json） */
  async list(): Promise<WorkflowMeta[]> {
    let files: string[]
    try {
      files = await fs.readdir(this.workflowsDir)
    } catch {
      return []
    }

    const metas: WorkflowMeta[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const name = f.slice(0, -5)
      try {
        metas.push(await this.getMeta(name))
      } catch {
        // 跳过无法解析的 JSON
      }
    }
    return metas.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 提取工作流元信息：占位符列表、是否有图输入、是否有时长、能力标签 */
  async getMeta(name: string): Promise<WorkflowMeta> {
    const workflow = await this.load(name)
    const jsonStr = JSON.stringify(workflow)
    const matches = jsonStr.match(PLACEHOLDER_GLOBAL_RE) || []
    const placeholders = [...new Set(matches.map((m) => m.slice(1, -1)))]

    // 节点结构扫描（占位符缺失时也能推断：动态字段写死的库模板）
    const classTypes = new Set<string>()
    const loadImages = new Set<string>()
    for (const [, node] of Object.entries(workflow)) {
      const ct = node.class_type
      if (!ct) continue
      classTypes.add(ct)
      if (LOAD_IMAGE_NODES.has(ct)) loadImages.add(ct)
    }

    const hasImageInput = placeholders.includes('REF_IMAGE') || loadImages.size > 0
    const hasDuration = placeholders.includes('DURATION')
    const hasEndFrame = placeholders.includes('END_IMAGE')
    const capability = inferCapability({
      placeholders, classTypes, hasImageInput, hasEndFrame
    })

    return {
      name,
      placeholders,
      hasImageInput,
      hasDuration,
      hasEndFrame,
      capability
    }
  }

  /** 获取工作流所有可编辑参数（按节点分组的标量输入） */
  async getEditableParams(name: string): Promise<WorkflowParam[]> {
    const workflow = await this.load(name)
    const params: WorkflowParam[] = []

    for (const [nodeId, node] of Object.entries(workflow)) {
      const inputs = node.inputs
      if (!inputs) continue
      const nodeTitle = node._meta?.title || node.class_type || nodeId
      const classType = node.class_type || 'unknown'

      for (const [key, rawValue] of Object.entries(inputs)) {
        if (Array.isArray(rawValue)) {
          params.push({
            nodeId,
            nodeTitle,
            classType,
            key,
            value: JSON.stringify(rawValue),
            type: 'string',
            isPlaceholder: false,
            isConnection: true
          })
          continue
        }
        if (typeof rawValue === 'string' && PLACEHOLDER_RE.test(rawValue)) {
          params.push({
            nodeId,
            nodeTitle,
            classType,
            key,
            value: rawValue,
            type: 'string',
            isPlaceholder: true,
            isConnection: false
          })
          continue
        }
        const type: WorkflowParam['type'] =
          typeof rawValue === 'number' ? 'number'
          : typeof rawValue === 'boolean' ? 'boolean'
          : 'string'
        params.push({
          nodeId,
          nodeTitle,
          classType,
          key,
          value: rawValue as string | number | boolean,
          type,
          isPlaceholder: false,
          isConnection: false
        })
      }
    }
    return params
  }

  /** 更新工作流中某个节点的参数值并保存 */
  async updateParam(
    name: string,
    nodeId: string,
    key: string,
    value: string | number | boolean
  ): Promise<void> {
    await this.enqueueWrite(name, async () => {
      const workflow = await this.load(name)
      const node = workflow[nodeId]
      if (!node || !node.inputs) {
        throw new Error(`节点 ${nodeId} 不存在`)
      }
      const current = node.inputs[key]
      if (Array.isArray(current)) {
        throw new Error('连接引用不可修改')
      }
      if (typeof current === 'string' && PLACEHOLDER_RE.test(current)) {
        throw new Error('占位符不可直接修改')
      }
      node.inputs[key] = value
      await fs.writeFile(
        path.join(this.workflowsDir, `${name}.json`),
        JSON.stringify(workflow, null, 2),
        'utf-8'
      )
    })
  }

  private async load(name: string): Promise<WorkflowGraph> {
    if (!WORKFLOW_NAME_RE.test(name)) {
      throw new Error(`非法工作流名称: ${name}`)
    }
    const filePath = path.join(this.workflowsDir, `${name}.json`)
    const content = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(content)
  }

  /** 替换占位符：$PROMPT$, $REF_IMAGE$, $SEED$, $DURATION$ 等。
   *  递归遍历对象，完全匹配 $KEY$ 时保持 vars 的原始类型（数字/字符串/布尔）；
   *  嵌入在其他字符串中的占位符做文本替换。
   */
  async buildGraph(name: string, vars: Record<string, string | number | boolean>): Promise<Record<string, unknown>> {
    const workflow = await this.load(name)
    const graph = this.deepReplace(workflow, vars) as Record<string, unknown>
    // _comment 是文档字段不是节点：部分 ComfyUI 插件的 on_prompt_handler 会遍历顶层键并对字符串调用 .get() 导致 500
    delete graph._comment
    // 兼容第三方导入模板：连接数组 [节点id, 输出索引] 的节点 id 必须为字符串
    // （UI 格式转换时可能残留整型 id，ComfyUI 校验 prompt[节点id] 会 KeyError 整单拒收）
    const nodeIds = new Set(Object.keys(graph).filter(k => k !== '_comment'))
    for (const node of Object.values(graph) as Array<Record<string, unknown>>) {
      if (!node || typeof node !== 'object' || !node.inputs) continue
      for (const [key, value] of Object.entries(node.inputs as Record<string, unknown>)) {
        if (
          Array.isArray(value) &&
          value.length === 2 &&
          typeof value[0] === 'number' &&
          nodeIds.has(String(value[0]))
        ) {
          ;(node.inputs as Record<string, unknown>)[key] = [String(value[0]), value[1]]
        }
      }
    }
    const remaining = JSON.stringify(graph).match(PLACEHOLDER_GLOBAL_RE)
    if (remaining) {
      throw new Error(`工作流 ${name} 存在未替换占位符: ${[...new Set(remaining)].join(', ')}`)
    }
    return graph as Record<string, unknown>
  }

  private deepReplace(node: unknown, vars: Record<string, string | number | boolean>): unknown {
    if (typeof node === 'string') {
      const m = node.match(PLACEHOLDER_RE)
      if (m && m[1] in vars) return vars[m[1]]
      // 嵌入模式：纯文本替换
      let s = node
      for (const [key, value] of Object.entries(vars)) {
        s = s.split(`$${key}$`).join(String(value))
      }
      return s
    }
    if (Array.isArray(node)) return node.map(v => this.deepReplace(v, vars))
    if (typeof node === 'object' && node !== null) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = this.deepReplace(v, vars)
      }
      return out
    }
    return node
  }

  /** 获取工作流节点列表（用于调试） */
  async getNodeInfo(name: string): Promise<Array<{ id: string; type: string; title: string }>> {
    const workflow = await this.load(name)
    return Object.entries(workflow).map(([id, node]) => ({
      id,
      type: node.class_type || 'unknown',
      title: node._meta?.title || ''
    }))
  }

  /**
   * 模板级自检（占位符未替换也能用）：
   * - 节点 class_type 在当前 ComfyUI 不存在 → 缺自定义节点
   * - 非占位符的枚举型输入值不在可选列表 → 缺模型/资源文件
   */
  async validateTemplate(
    name: string,
    objectInfo: Record<string, ObjectNodeInfo>
  ): Promise<WorkflowCheckIssue[]> {
    const workflow = await this.load(name)
    return this.inspect(workflow, objectInfo)
  }

  /** 运行级自检（buildGraph 产出、提交前调用）：全量校验，含模型文件名 */
  validateBuiltGraph(
    workflowName: string,
    graph: Record<string, unknown>,
    objectInfo: Record<string, ObjectNodeInfo>
  ): WorkflowCheckIssue[] {
    return this.inspect(graph as WorkflowGraph, objectInfo, workflowName)
  }

  private inspect(
    graph: WorkflowGraph,
    objectInfo: Record<string, ObjectNodeInfo>,
    _workflowName = ''
  ): WorkflowCheckIssue[] {
    const issues: WorkflowCheckIssue[] = []
    for (const [nodeId, node] of Object.entries(graph)) {
      if (nodeId === '_comment') continue
      // 只校验数字键节点；其他顶层键（groups/版本信息等）不是节点
      if (!/^\d+$/.test(nodeId)) continue
      const classType = node.class_type
      // 无 class_type 的数字键节点是 ComfyUI Reroute 透传节点（提交时由服务端处理），跳过
      if (!classType) continue
      const info = objectInfo[classType]
      if (!info) {
        issues.push({
          kind: 'missing-node', nodeId, classType,
          message: `缺少节点「${classType}」（请在 ComfyUI 安装对应的自定义节点包后重启）`
        })
        continue
      }
      // 枚举型输入校验（ckpt_name / unet_name / vae_name / lora_name 等模型文件）
      // LoadImage/LoadAudio 的文件名枚举随上传变化，运行时已 upload，不做「模型缺失」误报
      const DYNAMIC_MEDIA_NODES = new Set([
        'LoadImage', 'LoadImageMask', 'LoadAudio', 'VHS_LoadImagePath', 'VHS_LoadImages'
      ])
      if (DYNAMIC_MEDIA_NODES.has(classType)) continue
      const defs = { ...info.input?.required, ...info.input?.optional }
      if (!node.inputs) continue
      for (const [key, value] of Object.entries(node.inputs)) {
        // 占位符与空值跳过（空值由 ComfyUI/用户运行时填写，不属于环境缺失）
        if (typeof value !== 'string' || value === '' || PLACEHOLDER_RE.test(value)) continue
        const def = defs[key]
        if (!Array.isArray(def)) continue
        const enumValues = def[0]
        // 区分「枚举值数组」与「类型声明数组 ["STRING", {...}]」
        const TYPE_NAMES = new Set(['STRING', 'INT', 'FLOAT', 'BOOLEAN'])
        if (Array.isArray(enumValues) && enumValues.length > 0
          && enumValues.every(v => typeof v === 'string')
          && !TYPE_NAMES.has(String(enumValues[0]))) {
          if (!(enumValues as string[]).includes(value)) {
            issues.push({
              kind: 'missing-model', nodeId, classType, inputKey: key,
              message: `节点「${classType}」需要资源 ${key}="${value}"，但 ComfyUI 中不存在（请放入对应 models 目录后刷新）`
            })
          }
        }
      }
    }
    return issues
  }
}
