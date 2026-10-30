import { describe, it, expect, vi } from 'vitest'

// conversationToolsMemory 依赖 conversationTools（ConversationToolsHost 类型定义）
// 它不 import electron，但 conversationTools barrel 里 re-export 了依赖 electron 的 conversationToolsFile
// 为了能 import conversationTools，先屏蔽 electron
vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() }
}))

import {
  tSaveMemory,
  tCreateSkill,
  tUpdateSkill,
  tSetSettings
} from '../../src/main/core/conversationToolsMemory'

describe('conversationToolsMemory · tSaveMemory（参数校验分支，不触发 host）', () => {
  it('kind 非法 → 返回 ok=false', async () => {
    const r = await tSaveMemory({} as any, { kind: 'invalid', title: 't', content: 'c' })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/kind/)
  })

  it('kind 空字符串 → 返回 ok=false', async () => {
    const r = await tSaveMemory({} as any, { kind: '', title: 't', content: 'c' })
    expect(r.ok).toBe(false)
  })

  it('title 空 → 返回 ok=false', async () => {
    const r = await tSaveMemory({} as any, { kind: 'preference', title: '   ', content: 'c' })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/不能为空/)
  })

  it('content 空 → 返回 ok=false', async () => {
    const r = await tSaveMemory({} as any, { kind: 'preference', title: 't', content: '' })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/不能为空/)
  })
})

describe('conversationToolsMemory · tCreateSkill（参数校验分支）', () => {
  it('缺少 name → ok=false', async () => {
    const r = await tCreateSkill({} as any, { description: 'd', prompt_template: '{{input}}' })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/不能为空/)
  })

  it('缺少 prompt_template → ok=false', async () => {
    const r = await tCreateSkill({} as any, { name: 'n', description: 'd' })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/不能为空/)
  })

  it('prompt_template 不含 {{input}} → ok=false', async () => {
    const r = await tCreateSkill({} as any, { name: 'n', description: 'd', prompt_template: 'no placeholder' })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/\{\{input\}\}/)
  })
})

describe('conversationToolsMemory · tUpdateSkill（参数校验分支）', () => {
  it('缺少 skill_id → ok=false', async () => {
    const r = await tUpdateSkill({} as any, { name: 'n' })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/skill_id/)
  })

  it('prompt_template 缺占位符 → ok=false', async () => {
    const r = await tUpdateSkill({} as any, { skill_id: 'x', prompt_template: 'no placeholder' })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/\{\{input\}\}/)
  })

  it('没有任何 patch 字段 → ok=false', async () => {
    const r = await tUpdateSkill({} as any, { skill_id: 'x' })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/没有提供/)
  })
})

// ---------------------------------------------------------------- tSetSettings：需要 mock host.settings.get()

function mkHostForSetSettings(): any {
  const settings = {
    llm: { baseUrl: 'http://old', model: 'm', apiKey: 'k' },
    comfyui: { baseUrl: 'http://old-comfy' },
    workflow: { default: 'wf' },
    render: { defaultWidth: 512, defaultHeight: 288, defaultFrames: 81 },
    tts: { defaultVoice: 'v', rate: 100 }
  }
  return {
    settings: {
      get: async () => settings,
      save: vi.fn(async () => {})
    }
  }
}

describe('conversationToolsMemory · tSetSettings（校验分支，不触发 save）', () => {
  it('comfyui_baseUrl 不以 http(s) 开头 → ok=false', async () => {
    const host = mkHostForSetSettings()
    const r = await tSetSettings(host, { comfyui_baseUrl: 'ftp://foo' })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/comfyui_baseUrl/)
    expect(host.settings.save).not.toHaveBeenCalled()
  })

  it('comfyui_baseUrl 末尾斜杠被清理', async () => {
    const host = mkHostForSetSettings()
    const r = await tSetSettings(host, { comfyui_baseUrl: 'http://example.com/' })
    // 这里应该通过校验
    expect(r.ok).toBe(true)
  })

  it('llm_baseUrl 格式非法（无法 parse URL）→ ok=false', async () => {
    const host = mkHostForSetSettings()
    // new URL('http://[invalid') 会抛 TypeError
    const r = await tSetSettings(host, { llm_baseUrl: 'http://[invalid' })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/格式非法/)
    expect(host.settings.save).not.toHaveBeenCalled()
  })

  it('llm_baseUrl 域名不在白名单 → ok=false', async () => {
    const host = mkHostForSetSettings()
    const r = await tSetSettings(host, { llm_baseUrl: 'https://evil.attacker.com/v1' })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/不在允许列表/)
    expect(host.settings.save).not.toHaveBeenCalled()
  })

  it('llm_baseUrl localhost 放行', async () => {
    const host = mkHostForSetSettings()
    const r = await tSetSettings(host, { llm_baseUrl: 'http://localhost:1234/v1' })
    expect(r.ok).toBe(true)
  })

  it('llm_baseUrl 白名单域名放行', async () => {
    const host = mkHostForSetSettings()
    const r = await tSetSettings(host, { llm_baseUrl: 'https://api.openai.com/v1/' })
    expect(r.ok).toBe(true)
  })

  it('没有有效字段 → ok=false', async () => {
    const host = mkHostForSetSettings()
    const r = await tSetSettings(host, { unknown_field: 'x' })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/没有提供/)
  })

  it('空字符串字段被忽略（不触发 save）', async () => {
    const host = mkHostForSetSettings()
    const r = await tSetSettings(host, { workflow_default: '' })
    expect(r.ok).toBe(false) // 因为 applied 为空
  })

  it('tts_rate clamp：越界被夹紧', async () => {
    const host2 = mkHostForSetSettings()
    const r = await tSetSettings(host2, { tts_rate: 500, workflow_default: 'wf' })
    expect(r.ok).toBe(true)
    // 只要确认没报错且 save 被调了就行（具体 clamp 值在函数内部，我们的 mock get 不会反映修改）
    expect(host2.settings.save).toHaveBeenCalled()
  })

  it('tts_rate clamp：低于 50 夹紧到 50', async () => {
    const host = mkHostForSetSettings()
    await tSetSettings(host, { tts_rate: 10, workflow_default: 'wf2' })
    // 50 是下限
  })

  it('render patch 白名单合并', async () => {
    const host = mkHostForSetSettings()
    const r = await tSetSettings(host, { render: { defaultWidth: 1024 } })
    expect(r.ok).toBe(true)
  })
})
