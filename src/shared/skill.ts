// ===== 导演技能（可配置技能框架）=====
/** tool=绑定内置工具；prompt=自定义提示词技能（调用时按模板走一次 LLM） */
export type SkillKind = 'tool' | 'prompt'

export interface Skill {
  id: string
  /** 中文名（同时作为对话工具展示名） */
  name: string
  /** 给 LLM 的能力说明（决定何时调用） */
  description: string
  enabled: boolean
  builtin: boolean
  kind: SkillKind
  /** kind=tool：内置工具名 */
  tool?: string
  /** kind=prompt：提示词模板，{{input}} 为用户输入 */
  promptTemplate?: string
  createdAt: number
}

