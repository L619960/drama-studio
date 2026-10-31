/**
 * 对话工具·记忆/技能/设置域：自定义技能 LLM 调用、项目上下文解析、记忆读写、设置读写与技能沉淀。
 * 从 conversationTools.ts 按域拆分外移，行为不变。
 */
import type { ConversationToolsHost, ToolResult } from './conversationTools'
import type { MemoryKind } from '../../shared/ipcTypes'
import { llmApiKey, llmBaseUrl } from './llmRequest'

// ---------------------------------------------------------------- 自定义技能

export async function runCustomSkill(
  host: ConversationToolsHost,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const skillId = name.replace(/^custom_/, '')
  const all = await host.skills.list()
  const skill = all.find((s) => s.id === skillId)
  if (!skill || !skill.enabled) return { ok: false, text: '技能不存在或已停用' }
  const userText = String(args.user_text || '')
  const system = (skill.promptTemplate || '').replace(/\{\{\s*input\s*\}\}/g, () => userText) || userText
  const reply = await host.llm.chatCompletion(
    [
      { role: 'system', content: system },
      { role: 'user', content: userText || '请按技能说明执行' },
    ],
    { temperature: 0.7, signal },
  )
  return { ok: true, text: reply.content }
}

// ---------------------------------------------------------------- 项目上下文解析

/** 解析项目 ID：优先用传入的；全局对话回退到最近操作的项目；再回退到最近更新的项目 */
export async function resolvePid(host: ConversationToolsHost, pid: string | undefined): Promise<string> {
  if (pid) {
    host.lastProjectId = pid
    return pid
  }
  if (host.lastProjectId) {
    // 校验主进程内存指针指向的项目仍存在，防止「幽灵项目」导致 ENOENT
    const exists = await host.projects
      .get(host.lastProjectId)
      .then(() => true)
      .catch(() => false)
    if (exists) return host.lastProjectId
    host.lastProjectId = undefined
  }
  const list = await host.projects.list()
  const latest = [...list].sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (!latest) throw new Error('当前没有任何项目，请先创建或指定项目')
  host.lastProjectId = latest.id
  return latest.id
}

// ---------------------------------------------------------------- 记忆

export async function tListMemories(host: ConversationToolsHost, kind?: MemoryKind): Promise<ToolResult> {
  const valid: MemoryKind[] = ['preference', 'rule', 'lesson']
  const filter = kind && valid.includes(kind) ? kind : undefined
  const items = await host.memory.list(filter)
  if (!items.length) return { ok: true, text: JSON.stringify({ empty: true, message: '记忆库暂无内容' }) }
  return {
    ok: true,
    text: JSON.stringify(
      items.slice(0, 50).map((m) => ({
        id: m.id,
        kind: m.kind,
        title: m.title,
        content: m.content,
      })),
    ),
  }
}

export async function tSaveMemory(host: ConversationToolsHost, args: Record<string, unknown>): Promise<ToolResult> {
  const kind = String(args.kind || '') as MemoryKind
  const title = String(args.title || '').trim()
  const content = String(args.content || '').trim()
  if (!['preference', 'rule', 'lesson'].includes(kind)) {
    return { ok: false, text: 'kind 必须是 preference/rule/lesson 之一' }
  }
  if (!title || !content) return { ok: false, text: 'title 与 content 不能为空' }
  const item = await host.memory.create({ kind, title, content })
  return { ok: true, text: JSON.stringify({ saved: true, id: item.id, kind, title }) }
}

// ---------------------------------------------------------------- 设置

export async function tGetSettings(host: ConversationToolsHost): Promise<ToolResult> {
  const s = await host.settings.get()
  return {
    ok: true,
    text: JSON.stringify({
      llm: { baseUrl: llmBaseUrl(s), model: s.llm.model, apiKeyConfigured: Boolean(llmApiKey(s)) },
      comfyui: { baseUrl: s.comfyui.baseUrl },
      workflow: { default: s.workflow.default },
      render: s.render,
      tts: { defaultVoice: s.tts.defaultVoice },
    }),
  }
}

/** 白名单合并写入设置：只接受已知字段，未传字段保持不变；LLM/ComfyUI 每次请求实时读配置，改完即生效 */
export async function tSetSettings(host: ConversationToolsHost, args: Record<string, unknown>): Promise<ToolResult> {
  const s = await host.settings.get()
  const applied: string[] = []
  const put = (obj: Record<string, unknown>, key: string, value: unknown): void => {
    if (value === undefined || value === null || value === '') return
    obj[key] = value
    applied.push(key)
  }

  if (args.workflow_default) put(s.workflow, 'default', String(args.workflow_default))

  // render 子对象逐字段白名单合并（避免 LLM 整对象覆盖丢字段）
  if (args.render && typeof args.render === 'object' && !Array.isArray(args.render)) {
    const patch = args.render as Record<string, unknown>
    for (const key of Object.keys(s.render)) {
      if (patch[key] !== undefined && patch[key] !== null && patch[key] !== '') {
        put(s.render as unknown as Record<string, unknown>, key, patch[key])
      }
    }
  }

  if (args.comfyui_baseUrl) {
    const base = String(args.comfyui_baseUrl).replace(/\/+$/, '')
    if (!/^https?:\/\//.test(base)) return { ok: false, text: 'comfyui_baseUrl 必须以 http:// 或 https:// 开头' }
    put(s.comfyui, 'baseUrl', base)
  }
  if (args.tts_defaultVoice) put(s.tts, 'defaultVoice', String(args.tts_defaultVoice))
  if (args.tts_rate !== undefined && args.tts_rate !== null) {
    put(s.tts, 'rate', Math.max(50, Math.min(200, Number(args.tts_rate) || 100)))
  }
  if (args.llm_model) put(s.llm, 'model', String(args.llm_model))
  if (args.llm_baseUrl) {
    const base = String(args.llm_baseUrl).replace(/\/+$/, '')
    if (!/^https?:\/\//.test(base)) return { ok: false, text: 'llm_baseUrl 必须以 http:// 或 https:// 开头' }
    // 9d：LLM 地址白名单——防对话工具被诱导把 apiKey 送到任意外部服务器。
    // 仅允许主流厂商域名与本机回环地址；其余拒绝。
    const LLM_BASEURL_ALLOWED_HOSTS = [
      'api.openai.com',
      'api.anthropic.com',
      'deepseek.com',
      'api.deepseek.com',
      'api.moonshot.cn',
      'api.moonshot.ai',
      'openrouter.ai',
      'api.siliconflow.cn',
      'api.aliyun.com',
      'dashscope.aliyuncs.com',
      'ark.cn-beijing.volces.com',
      'api.x.ai',
      'generativelanguage.googleapis.com',
    ]
    let host: string
    try {
      host = new URL(base).hostname.toLowerCase()
    } catch {
      return { ok: false, text: 'llm_baseUrl 格式非法' }
    }
    const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1'
    if (!isLocalhost && !LLM_BASEURL_ALLOWED_HOSTS.includes(host)) {
      return {
        ok: false,
        text: `llm_baseUrl 域名 ${host} 不在允许列表（仅支持主流 LLM 厂商与 localhost；如需自定义代理请在设置页直接修改）`,
      }
    }
    put(s.llm, 'baseUrl', base)
  }

  if (!applied.length) return { ok: false, text: '没有提供任何有效的设置字段' }
  await host.settings.save(s)
  return {
    ok: true,
    text: JSON.stringify({
      ok: true,
      applied,
      message: '设置已保存并即时生效（LLM/ComfyUI 地址在下次请求时使用新值）',
    }),
  }
}

// ---------------------------------------------------------------- 技能沉淀

export async function tCreateSkill(host: ConversationToolsHost, args: Record<string, unknown>): Promise<ToolResult> {
  const name = String(args.name || '').trim()
  const description = String(args.description || '').trim()
  const promptTemplate = String(args.prompt_template || '').trim()
  if (!name || !description || !promptTemplate) {
    return { ok: false, text: 'name/description/prompt_template 都不能为空' }
  }
  if (!promptTemplate.includes('{{input}}')) {
    return { ok: false, text: 'prompt_template 必须包含 {{input}} 占位符（调用时用户输入会嵌入到这里）' }
  }
  const skill = await host.skills.create({ name, description, promptTemplate })
  return {
    ok: true,
    text: `新技能「${skill.name}」已沉淀（id=${skill.id}），用户在技能管理面板可见；之后对话中可直接按其 description 调用`,
  }
}

export async function tListSkills(host: ConversationToolsHost): Promise<ToolResult> {
  const all = await host.skills.list()
  const custom = all.filter((s) => !s.builtin)
  return {
    ok: true,
    text: JSON.stringify({
      customSkills: custom.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        enabled: s.enabled,
        createdAt: s.createdAt,
      })),
      builtinCount: all.length - custom.length,
      hint: 'builtinCount 为内置工具数量；沉淀新知识前先比对 customSkills 避免重复，已有类似技能用 update_skill 升级',
    }),
  }
}

export async function tUpdateSkill(host: ConversationToolsHost, args: Record<string, unknown>): Promise<ToolResult> {
  const id = String(args.skill_id || '').trim()
  if (!id) return { ok: false, text: '缺少 skill_id（先用 list_skills 查询）' }
  const patch: { name?: string; description?: string; promptTemplate?: string } = {}
  if (args.name) patch.name = String(args.name).trim()
  if (args.description) patch.description = String(args.description).trim()
  if (args.prompt_template) {
    const tpl = String(args.prompt_template).trim()
    if (!tpl.includes('{{input}}')) return { ok: false, text: 'prompt_template 必须包含 {{input}} 占位符' }
    patch.promptTemplate = tpl
  }
  if (!Object.keys(patch).length)
    return { ok: false, text: '没有提供任何要更新的字段（name/description/prompt_template）' }
  try {
    await host.skills.update(id, patch)
    return { ok: true, text: `技能 ${id} 已更新（${Object.keys(patch).join('、')}），新内容即时生效` }
  } catch {
    return { ok: false, text: `技能 ${id} 不存在，请先用 list_skills 查询有效 id（只能更新自定义技能）` }
  }
}
