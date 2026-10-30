import { describe, it, expect } from 'vitest'
import { BUILTIN_SKILLS } from '../../src/main/core/builtinSkills'

/**
 * 内置技能表单测（builtinSkills 首个 spec）：
 * id 唯一、工具/创作两类技能字段完整、模板占位符可渲染、默认启用状态。
 */
describe('BUILTIN_SKILLS', () => {
  it('id 全局唯一且全部标记为内置', () => {
    const ids = BUILTIN_SKILLS.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(BUILTIN_SKILLS.every(s => s.builtin)).toBe(true)
    expect(BUILTIN_SKILLS.every(s => s.createdAt === 0)).toBe(true)
  })

  it('名称/描述非空，kind 只有 tool 与 prompt 两种', () => {
    for (const s of BUILTIN_SKILLS) {
      expect(s.name.trim()).not.toBe('')
      expect(s.description.trim()).not.toBe('')
      expect(['tool', 'prompt']).toContain(s.kind)
    }
  })

  it('tool 类技能都声明了工具名，且工具名唯一', () => {
    const toolSkills = BUILTIN_SKILLS.filter(s => s.kind === 'tool')
    expect(toolSkills.length).toBeGreaterThan(0)
    for (const s of toolSkills) expect(s.tool?.trim()).toBeTruthy()
    const names = toolSkills.map(s => s.tool)
    expect(new Set(names).size).toBe(names.length)
  })

  it('prompt 类技能的模板包含 {{input}} 占位符', () => {
    const promptSkills = BUILTIN_SKILLS.filter(s => s.kind === 'prompt')
    expect(promptSkills.length).toBeGreaterThan(0)
    for (const s of promptSkills) expect(s.promptTemplate).toContain('{{input}}')
  })

  it('默认启用内置技能，仅 ComfyUI-MCP 工具集默认关闭', () => {
    const disabled = BUILTIN_SKILLS.filter(s => !s.enabled)
    expect(disabled.map(s => s.id)).toEqual(['builtin-comfy-mcp'])
  })
})
