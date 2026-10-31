/**
 * ComfyUI-MCP 桥接服务：以 stdio 子进程方式接入 Comfy 官方开源 comfy-mcp（40+ 工具），
 * 把 MCP 工具桥接为导演对话 agent 的 LLM function-calling 工具。
 *
 * 设计约束：
 * - 懒启动：首个 comfy 工具被调用时才拉起子进程；进程退出后下次调用自动重启；
 * - 不污染主进程：子进程 stderr 收 ring buffer（末 20 行），仅出错时进日志；
 * - 工具名加 mcp_comfy__ 前缀防与内置工具冲突（OpenAI function name 上限 64 字符）；
 * - comfy-mcp 本体在独立 venv（由设置里的 ComfyUI 启动命令推导），不碰 ComfyUI 内嵌 Python。
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { SettingsStore } from './settingsStore'
import type { ToolSpec } from './llmService'

export type McpStatus = 'not_installed' | 'idle' | 'running' | 'error'

/** LLM 侧看到的工具名前缀（executeTool 按此前缀路由回本服务） */
export const COMFY_MCP_PREFIX = 'mcp_comfy__'

const CALL_TIMEOUT_MS = 60000
const STDERR_KEEP = 20

/**
 * 管理类工具过滤（denylist 策略）：
 * comfy-mcp（comfy_cli 包装，实测 v0.10.0 共 39 个工具）里，渲染/查询/提交类
 * （run_workflow、run_template、job、system_stats、fetch_outputs、upload_file 等）
 * 是导演对话的合法链路；而 ComfyUI 环境生命周期/安装/破坏性变更类工具一旦被 LLM
 * 自主发起，会中断进行中的渲染、改动本地 ComfyUI 安装甚至执行第三方节点代码，
 * 故默认从暴露给 LLM 的工具清单中过滤掉。
 *
 * 选 denylist 而非 allowlist：comfy-mcp 工具随版本动态增长（且导演对话依赖其动态
 * 展开能力），allowlist 会误伤未来新增的渲染/查询工具；denylist 只在明确命中管理
 * 语义时才过滤，未知工具一律放行。
 */

/** 当前 comfy-mcp 版本里确认的管理类工具名（精确名单，源：comfy_mcp/server.py 的 @mcp.tool 注册） */
const MANAGED_TOOL_NAMES = new Set([
  'auth_login',             // 发起 Comfy Cloud OAuth 登录流程（环境认证）
  'launch_comfyui',         // 启动本地 ComfyUI server
  'stop_comfyui',           // 停止本地 ComfyUI server
  'restart_comfyui',        // 重启 server，中断进行中的渲染
  'update_comfyui',         // git pull + 重装依赖，改动本地安装
  'switch_comfyui_version', // 切版本，源码 docstring 标注 DESTRUCTIVE
  'install_node'            // 安装第三方自定义节点包（运行第三方代码）
])

/** 关键字兜底模式：未来 comfy-mcp 新增同类工具时自动命中，不依赖精确名单穷举 */
const MANAGED_TOOL_PATTERNS: RegExp[] = [
  /^(launch|start|stop|restart|shutdown)_comfyui/i,                        // server 生命周期
  /^(install|uninstall|reinstall|update|upgrade|remove|delete|switch)_/i   // 安装/更新/删除/切换版本
]

/** 判定单个 MCP 工具是否属于"环境管理类"（应从 LLM 工具清单隐藏）；纯函数，可单测 */
export function isManagedMcpTool(name: string): boolean {
  if (!name) return false
  if (MANAGED_TOOL_NAMES.has(name)) return true
  return MANAGED_TOOL_PATTERNS.some(re => re.test(name))
}

/** 从 MCP listTools 结果中剔除管理类工具；保持原顺序，纯函数，可单测 */
export function filterMcpTools<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter(t => !isManagedMcpTool(t.name))
}

/** 与 comfyuiClient 同款：解析带引号路径的命令行 */
function parseCommandLine(cmd: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cmd)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3])
  }
  return out
}

export class ComfyMcpService {
  private client: Client | null = null
  private transport: StdioClientTransport | null = null
  private starting: Promise<Client> | null = null
  private status: McpStatus = 'idle'
  private lastError = ''
  private toolSpecs: ToolSpec[] | null = null
  private stderrBuf: string[] = []

  constructor(private settings: SettingsStore) {}

  /** venv 目录：优先使用显式配置 mcpVenvDir；否则从设置里的 ComfyUI 启动命令解析 python.exe，venv 放在其祖父目录。 */
  private venvDir(startCommand: string, mcpVenvDir?: string): string {
    if (mcpVenvDir?.trim()) {
      const exe = path.join(mcpVenvDir, 'Scripts', 'comfy-mcp.exe')
      if (existsSync(exe)) return mcpVenvDir
    }
    const argv = parseCommandLine(startCommand)
    const pythonExe = argv[0] || ''
    if (pythonExe.toLowerCase().endsWith('python.exe')) {
      return path.join(path.dirname(path.dirname(pythonExe)), 'comfy-mcp-venv')
    }
    return ''
  }

  private installHint(startCommand: string, venv: string): string {
    const argv = parseCommandLine(startCommand)
    const pythonExe = argv[0]?.toLowerCase().endsWith('python.exe') ? argv[0] : ''
    const comfyMain = argv.find(a => a.toLowerCase().endsWith('main.py')) || ''
    const comfyRoot = comfyMain ? path.dirname(comfyMain) : ''
    if (!pythonExe || !venv || !comfyRoot) {
      return 'ComfyUI-MCP 未安装，且设置中的 ComfyUI 启动命令无法解析 python.exe 与 main.py。请先在设置里填写启动命令。'
    }
    const venvPython = path.join(venv, 'Scripts', 'python.exe')
    const comfyExe = path.join(venv, 'Scripts', 'comfy.exe')
    return [
      'ComfyUI-MCP 未安装（独立 venv 缺失）。请在终端执行：',
      `"${pythonExe}" -m venv "${venv}"`,
      `"${venvPython}" -m pip install comfy-mcp "comfy-cli>=1.14.0"`,
      `"${comfyExe}" set-default "${comfyRoot}"`
    ].join('\n')
  }

  private pushStderr(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.trim()) continue
      this.stderrBuf.push(line)
      if (this.stderrBuf.length > STDERR_KEEP) this.stderrBuf.shift()
    }
  }

  /** 懒启动：首个调用拉起 stdio 子进程并完成 MCP 握手；并发调用共享同一次启动 */
  private async ensureClient(): Promise<Client> {
    if (this.client) return this.client
    if (this.starting) return this.starting
    this.starting = (async (): Promise<Client> => {
      const s = await this.settings.get()
      const startCommand = s.comfyui.startCommand || ''
      const venv = this.venvDir(startCommand, s.comfyui.mcpVenvDir)
      const exe = venv ? path.join(venv, 'Scripts', 'comfy-mcp.exe') : ''
      if (!exe || !existsSync(exe)) {
        this.status = 'not_installed'
        throw new Error(this.installHint(startCommand, venv))
      }
      const transport = new StdioClientTransport({
        command: exe,
        args: [],
        env: {
          ...getDefaultEnvironment(),
          COMFY_BIN: path.join(venv, 'Scripts', 'comfy.exe'),
          COMFYUI_URL: s.comfyui.baseUrl || 'http://127.0.0.1:8188'
        },
        stderr: 'pipe'
      })
      transport.stderr?.on('data', (d: Buffer) => this.pushStderr(d.toString('utf8')))
      const client = new Client({ name: 'drama-studio', version: '1.0.0' })
      transport.onclose = () => {
        // 进程退出：清缓存，下次调用自动重启
        this.client = null
        this.transport = null
        this.toolSpecs = null
        if (this.status === 'running') this.status = 'idle'
      }
      transport.onerror = (e: Error) => {
        this.status = 'error'
        this.lastError = `${e.message}${this.stderrBuf.length ? `\n[stderr]\n${this.stderrBuf.join('\n')}` : ''}`
      }
      await client.connect(transport)
      this.client = client
      this.transport = transport
      this.status = 'running'
      this.lastError = ''
      return client
    })()
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  /** 工具清单 → LLM ToolSpec（加前缀、schema 透传；进程未启动则先拉起） */
  async listToolSpecs(): Promise<ToolSpec[]> {
    if (this.toolSpecs) return this.toolSpecs
    const client = await this.ensureClient()
    const res = await client.listTools()
    // 管理类工具（生命周期/安装/破坏性变更）不暴露给 LLM，见 isManagedMcpTool 注释
    const kept = filterMcpTools(res.tools)
    const specs: ToolSpec[] = []
    for (const t of kept) {
      const name = COMFY_MCP_PREFIX + t.name
      if (name.length > 64) continue // OpenAI function name 上限
      specs.push({
        type: 'function',
        function: {
          name,
          description: `[ComfyUI-MCP] ${t.description || t.name}`,
          parameters: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>
        }
      })
    }
    this.toolSpecs = specs
    return specs
  }

  /** 执行 MCP 工具：剥前缀 → callTool → 拼接文本结果 */
  async callTool(
    prefixedName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ ok: boolean; text: string }> {
    const name = prefixedName.startsWith(COMFY_MCP_PREFIX) ? prefixedName.slice(COMFY_MCP_PREFIX.length) : prefixedName
    try {
      const client = await this.ensureClient()
      if (signal?.aborted) return { ok: false, text: '（本轮已停止，工具未执行）' }
      const res = await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: CALL_TIMEOUT_MS, signal }
      )
      const content = (res.content ?? []) as Array<{ type?: string; text?: string }>
      const text = content
        .filter(c => c.type === 'text' && typeof c.text === 'string')
        .map(c => c.text as string)
        .join('\n')
      const isError = (res as { isError?: boolean }).isError === true
      return { ok: !isError, text: text || (isError ? '（comfy-mcp 返回错误但无文本内容）' : '（工具执行成功，无文本输出）') }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 安装缺失时把安装指引直接给 LLM，让用户拿到可执行的下一步
      if (this.status === 'not_installed') return { ok: false, text: msg }
      this.status = this.client ? this.status : 'error'
      this.lastError = msg
      return { ok: false, text: `comfy-mcp 调用失败：${msg}` }
    }
  }

  getStatus(): { status: McpStatus; lastError: string } {
    return { status: this.status, lastError: this.lastError }
  }

  /** app 退出时关闭子进程 */
  async dispose(): Promise<void> {
    const t = this.transport
    const pid = t?.pid
    this.client = null
    this.transport = null
    this.toolSpecs = null
    if (t) await t.close().catch(() => undefined)
    // P2-6：comfy-mcp 会再派生 comfy CLI 子进程，close 只结束直接子进程；
    // Windows 上用 taskkill /T 强杀整棵进程树，避免退出后残留孤儿进程占端口。
    if (pid && process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 3000 })
      } catch { /* 进程可能已退出 */ }
    }
  }
}
