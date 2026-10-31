import { describe, it, expect } from 'vitest'
import { BUILTIN_TOOL_SPECS } from '../../src/main/core/builtinToolSpecs'
import { BUILTIN_SKILLS } from '../../src/main/core/builtinSkills'

/**
 * 内置工具 Schema 单测（builtinToolSpecs 首个 spec）：
 * 键与函数名一致、参数结构完整、关键工具字段约束、
 * 工具描述来自技能表、技能声明的工具都有对应 Schema。
 */
describe('BUILTIN_TOOL_SPECS', () => {
  const entries = Object.entries(BUILTIN_TOOL_SPECS)

  it('数量与键名/函数名一一对应', () => {
    expect(entries.length).toBeGreaterThan(30)
    for (const [key, spec] of entries) {
      expect(spec.type).toBe('function')
      expect(spec.function.name).toBe(key)
      expect(spec.function.description.trim()).not.toBe('')
    }
  })

  it('每个工具的 parameters 都是 object 结构', () => {
    for (const [, spec] of entries) {
      expect(spec.function.parameters.type).toBe('object')
      expect(spec.function.parameters.properties).toBeTypeOf('object')
    }
  })

  it('start_director：必填片名/题材/剧本，阶段确认点限定可选值', () => {
    const spec = BUILTIN_TOOL_SPECS.start_director
    if (!spec) throw new Error('测试夹具缺少 start_director schema')
    expect(spec.function.parameters.required).toEqual(['title', 'genre', 'script'])
    const gate = (spec.function.parameters.properties as Record<string, any>).gate_stages as {
      items?: { enum?: string[] }
    }
    expect(gate.items?.enum).toEqual(['analyze', 'casting', 'scenes', 'render', 'combine', 'subtitle', 'review'])
  })

  it('rerender_shots 必填镜号列表且元素为整数', () => {
    const spec = BUILTIN_TOOL_SPECS.rerender_shots
    if (!spec) throw new Error('测试夹具缺少 rerender_shots schema')
    expect(spec.function.parameters.required).toEqual(['shot_indexes'])
    const props = spec.function.parameters.properties as Record<string, any>
    expect(props.shot_indexes.items).toMatchObject({ type: 'integer' })
  })

  it('工具描述取自技能表描述', () => {
    const start = BUILTIN_SKILLS.find((s) => s.id === 'builtin-start')!
    const startSpec = BUILTIN_TOOL_SPECS.start_director
    if (!startSpec) throw new Error('测试夹具缺少 start_director schema')
    expect(startSpec.function.description).toBe(start.description)
  })

  it('每个启用工具类技能声明的工具都有 Schema（MCP 工具集除外）', () => {
    const tools = BUILTIN_SKILLS.filter((s) => s.kind === 'tool' && s.id !== 'builtin-comfy-mcp').map((s) => s.tool!)
    for (const tool of tools) {
      expect(BUILTIN_TOOL_SPECS).toHaveProperty(tool)
    }
  })
})
