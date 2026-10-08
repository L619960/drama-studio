import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Skill } from '../../shared/ipcTypes'
import type { ToolSpec } from './llmService'

/**
 * 导演技能框架：
 * - 内置技能（builtin, kind=tool）绑定对话工具，对应真实操作
 * - 自定义技能（kind=prompt）是用户可编辑的提示词模板，调用时按模板走一次 LLM
 * - 启用状态持久化 dataRoot/skills.json，升级时补齐新增内置技能
 */

const SAVE_FILE = 'skills.json'

export const BUILTIN_SKILLS: Skill[] = [
  {
    id: 'builtin-start', name: '开拍新任务', enabled: true, builtin: true, kind: 'tool',
    tool: 'start_director', createdAt: 0,
    description: '在用户提供完整剧本并确认片名、题材、阶段确认点后，启动导演全自动流水线（拆镜→渲染→成片）。缺少剧本或关键字段时必须先向用户追问，严禁自行编造剧本。'
  },
  {
    id: 'builtin-pause', name: '暂停任务', enabled: true, builtin: true, kind: 'tool',
    tool: 'pause_director', createdAt: 0,
    description: '请求暂停正在执行的导演任务：当前阶段安全结束后挂起，不中断进行中的渲染。用户说"暂停/先停下/等一下"时使用。'
  },
  {
    id: 'builtin-resume', name: '继续任务', enabled: true, builtin: true, kind: 'tool',
    tool: 'resume_director', createdAt: 0,
    description: '让停在阶段确认点的任务继续执行下一阶段。用户说"继续/接着跑/没问题继续"时使用。'
  },
  {
    id: 'builtin-cancel', name: '取消任务', enabled: true, builtin: true, kind: 'tool',
    tool: 'cancel_director', createdAt: 0,
    description: '终止当前导演任务。属于破坏性操作：只有用户明确表达取消/不要了时才能调用，语气模糊时先追问确认。'
  },
  {
    id: 'builtin-status', name: '查询任务状态', enabled: true, builtin: true, kind: 'tool',
    tool: 'get_director_status', createdAt: 0,
    description: '查询当前项目的导演流水线状态：各阶段进度、镜头完成数、失败镜头、暂停状态、复审问题与成片路径。用户问进度/到哪了/什么情况时使用。'
  },
  {
    id: 'builtin-shots', name: '查看分镜', enabled: true, builtin: true, kind: 'tool',
    tool: 'list_shots', createdAt: 0,
    description: '读取当前项目的分镜清单：镜号、类型（空镜/人物镜）、景别、台词、状态与失败原因。用户讨论镜头、台词、要改戏时使用。'
  },
  {
    id: 'builtin-rerender', name: '重新渲染镜头', enabled: true, builtin: true, kind: 'tool',
    tool: 'rerender_shots', createdAt: 0,
    description: '对当前项目指定镜号重新渲染（可多个）。用户说"重渲第X镜/这一镜再来一条/换一条"时使用；不指定镜号时先追问。'
  },
  {
    id: 'builtin-sample', name: '试片渲染', enabled: true, builtin: true, kind: 'tool',
    tool: 'render_sample', createdAt: 0,
    description: '低成本验证：挑 2-3 个代表镜头渲染并拼成 sample.mp4，先看风格一致性再决定全片开拍。用户说"先试一版/渲染试片/看看效果"时使用。'
  },
  {
    id: 'builtin-trailer', name: '生成预告片', enabled: true, builtin: true, kind: 'tool',
    tool: 'make_trailer', createdAt: 0,
    description: '高潮快剪：从已渲染镜头里挑 6-10 个高光片段，各截 1.5 秒拼接成 trailer.mp4 并混 BGM。正片渲染完成后用户说"生成预告片/剪个预告"时使用。'
  },
  {
    id: 'builtin-comfyui', name: '检查 ComfyUI', enabled: true, builtin: true, kind: 'tool',
    tool: 'get_comfyui_status', createdAt: 0,
    description: '检查本地 ComfyUI 服务是否在线。渲染报错、连接异常或用户询问环境状态时使用。'
  },
  {
    id: 'builtin-workflows', name: '查看工作流', enabled: true, builtin: true, kind: 'tool',
    tool: 'list_workflows', createdAt: 0,
    description: '列出 ComfyUI 工作流模板（如 Wan/H3 渲染模板、首帧文生图模板）及占位参数，并显示当前全局/项目默认引擎。用户问用什么模型/工作流时使用。'
  },
  {
    id: 'builtin-choose-workflow', name: '选择工作流', enabled: true, builtin: true, kind: 'tool',
    tool: 'choose_workflow', createdAt: 0,
    description: '切换渲染工作流引擎：可为全局默认、当前项目默认、或指定单个分镜选择工作流（如 Wan2.2 快、H3 原生音画质量好）。用户说"这个项目用 H3/把第3镜换成 Wan/全局默认改 H3"时使用。切换前先 list_workflows 确认名称存在。'
  },
  {
    id: 'builtin-workflow-params', name: '查看工作流参数', enabled: true, builtin: true, kind: 'tool',
    tool: 'get_workflow_params', createdAt: 0,
    description: '查看指定工作流模板的全部可编辑节点参数（节点 ID、类型、当前值）。调参前先调用它拿到节点 ID 和参数名。'
  },
  {
    id: 'builtin-workflow-tune', name: '调整工作流参数', enabled: true, builtin: true, kind: 'tool',
    tool: 'update_workflow_param', createdAt: 0,
    description: '修改工作流模板中某个节点的参数值（如采样步数、分辨率、CFG）。属于影响后续所有渲染的调参操作，用户明确要求时使用，改完简述改动。'
  },
  {
    id: 'builtin-workflow-create', name: '自建工作流', enabled: true, builtin: true, kind: 'tool',
    tool: 'create_workflow', createdAt: 0,
    description: '从 ComfyUI 导出的 API 格式 JSON 新建工作流模板。用户粘贴工作流 JSON 要求接入时使用。动态字段（提示词/种子/参考图/尺寸/帧数/前缀）必须用 $PROMPT$ $SEED$ $REF_IMAGE$ $WIDTH$ $HEIGHT$ $LENGTH$ $PREFIX$ 这类大写占位符标出，数值占位符写成字符串形式（如 "$WIDTH$"）。'
  },
  {
    id: 'builtin-memory-list', name: '查阅记忆库', enabled: true, builtin: true, kind: 'tool',
    tool: 'list_memories', createdAt: 0,
    description: '查阅导演跨项目长期记忆：用户偏好、制作规则、过往经验教训。用户问"你还记得什么/按我之前说的/我的习惯"或需要依据既往约定创作时使用。'
  },
  {
    id: 'builtin-memory-save', name: '沉淀记忆', enabled: true, builtin: true, kind: 'tool',
    tool: 'save_memory', createdAt: 0,
    description: '把值得跨项目保留的信息写入长期记忆：用户明确表达的偏好（如台词风格、节奏喜好）、制作规则（如拆镜要求）、踩坑后的经验教训。一次性任务参数不要记。'
  },
  // ===== 创作型技能（prompt 类，来自行业实践提炼）=====
  {
    id: 'builtin-script-doctor', name: '剧本医生', enabled: true, builtin: true, kind: 'prompt', createdAt: 0,
    description: '开拍前给剧本做体检：找出因果断裂、前情缺失、动机不足、节奏拖沓等问题并给出修改建议。用户贴出剧本求评估、或复审被驳回后需要定位剧本层面原因时使用。',
    promptTemplate: `你是经验丰富的剧本医生。请审读以下剧本，重点排查短剧最常见的四类致命伤：
1. 因果断裂：台词或道具暗示了前情（电话、约定、旧恩怨），但前文没有任何铺垫
2. 动机缺失：角色行为转折（改变主意、接受邀约、突然发怒）缺乏支撑
3. 节奏拖沓：连续两个以上无台词纯情绪镜头，或同一拍子承担多个叙事任务
4. 信息迟到：观众需要的信息出现得太晚，造成理解障碍
对每个问题给出：镜号/行号定位、问题定性、一句可操作的修改建议。没有问题就说没有，不要硬凑。
剧本/素材：{{input}}`
  },
  {
    id: 'builtin-dialogue-polish', name: '台词打磨', enabled: true, builtin: true, kind: 'prompt', createdAt: 0,
    description: '把台词改得更像人话：口语化、符合人物身份、有潜台词。用户觉得台词生硬、书面腔、AI 味重时使用。',
    promptTemplate: `你是台词指导。按以下标准改写台词：
- 口语短句为主，删掉书面腔和成语堆砌
- 每句台词要符合说话人的身份、情绪、与听话人的关系
- 能用潜台词就不用大白话；能用动作交代的情绪就不写进台词
- 保持原意与剧情功能不变，只动表达
输出格式：原句 → 改后（一句一行），最后附不超过 3 行的整体说明。
台词素材：{{input}}`
  },
  {
    id: 'builtin-beat-check', name: '拆镜质检', enabled: true, builtin: true, kind: 'prompt', createdAt: 0,
    description: '检查分镜表质量：一镜一任务、景别节奏、轴线与连续性。分镜拆完后、开渲前自查，或用户质疑分镜合理性时使用。',
    promptTemplate: `你是分镜质检员。对照以下原则检查分镜表：
1. 一镜一任务：每个镜头只承担一个叙事任务（建立/推进/揭示/收束），拒绝一镜多职
2. 景别呼吸感：景别有变化节奏，不连续堆同景别
3. 连续性：角色服装、道具、位置、光线前后一致；跨镜动作有承接
4. 时长合理：无台词空镜不连续出现两个；单镜信息密度匹配时长
逐镜指出问题并给修改建议（合镜/拆镜/补过渡镜）。
分镜表或问题描述：{{input}}`
  },
  {
    id: 'builtin-review-precheck', name: '复审预检', enabled: true, builtin: true, kind: 'prompt', createdAt: 0,
    description: '模拟成片复审官：按因果、节奏、台词、连续性四个维度预判哪些镜会被复审驳回。进入拼接/复审阶段前自查，或上次复审被拒后逐条核对修复效果时使用。',
    promptTemplate: `你是苛刻的成片复审官。按四个维度逐项审：因果链完整（无前情缺失/因果断裂）、节奏（无连续拖沓空镜）、台词（口语化、有潜台词）、连续性（服化道/动作/光线跨镜一致）。
对每一项给出：通过/不通过、定位（镜号）、理由、修复建议。最后给一句话结论：放行 或 驳回（附驳回条数）。
待审材料：{{input}}`
  },
  {
    id: 'builtin-pitch', name: '题材策划', enabled: true, builtin: true, kind: 'prompt', createdAt: 0,
    description: '快速产出短剧创意提案：题材定位、三幕钩子、主角人设、核心爽点。用户说"想拍个XX题材的"但没剧本、或要头脑风暴选题时使用。',
    promptTemplate: `你是短剧策划。基于用户想法产出一份可直接开拍的提案：
1. 一句话钩子（前 3 秒抓住观众）
2. 题材与目标受众
3. 主角人设（欲望/缺陷/弧光，各一句）
4. 三幕结构：开场钩子 → 中段升级 → 结尾反转或爽点
5. 视觉基调建议（影调/参考风格）
控制在一屏以内，直接可用。用户想法：{{input}}`
  },
  {
    id: 'builtin-failure-postmortem', name: '复盘归档', enabled: true, builtin: true, kind: 'prompt', createdAt: 0,
    description: '把一次失败/复审驳回/渲染事故整理成结构化的经验教训，提炼成可复用的规则。出问题时用户说"总结一下教训/以后别再犯"时使用，产出适合沉淀进记忆库的内容。',
    promptTemplate: `你是复盘教练。把用户描述的这次问题整理成：
1. 现象（一句话）
2. 根因（定位到具体环节：剧本/拆镜/渲染/复审/工具）
3. 可执行的防范规则（祈使句，未来任务中可直接遵守，如"开拍前先跑剧本医生体检"）
4. 建议沉淀的记忆分类（用户偏好/制作规则/经验教训）与标题
输出后提醒用户：可以让我用「沉淀记忆」技能保存这条规则。
问题描述：{{input}}`
  }
]

const STR_PROP = (desc: string): Record<string, unknown> => ({ type: 'string', description: desc })
/** 按技能 id 取描述（避免数组下标随插入漂移） */
const SKILL_DESC = (id: string): string => BUILTIN_SKILLS.find(s => s.id === id)!.description

export const BUILTIN_TOOL_SPECS: Record<string, ToolSpec> = {
  start_director: {
    type: 'function',
    function: {
      name: 'start_director',
      description: SKILL_DESC('builtin-start'),
      parameters: {
        type: 'object',
        properties: {
          title: STR_PROP('片名'),
          genre: { type: 'string', description: '题材：霸总/重生/悬疑', enum: ['霸总', '重生', '悬疑'] },
          script: STR_PROP('完整剧本正文'),
          gate_stages: {
            type: 'array',
            description: '阶段确认点（这些阶段结束后暂停等用户确认）；用户未指定时给 ["analyze","render"]',
            items: {
              type: 'string',
              enum: ['analyze', 'casting', 'scenes', 'render', 'combine', 'subtitle', 'review']
            }
          }
        },
        required: ['title', 'genre', 'script']
      }
    }
  },
  pause_director: { type: 'function', function: { name: 'pause_director', description: SKILL_DESC('builtin-pause'), parameters: { type: 'object', properties: {} } } },
  resume_director: { type: 'function', function: { name: 'resume_director', description: SKILL_DESC('builtin-resume'), parameters: { type: 'object', properties: {} } } },
  cancel_director: { type: 'function', function: { name: 'cancel_director', description: SKILL_DESC('builtin-cancel'), parameters: { type: 'object', properties: {} } } },
  get_director_status: { type: 'function', function: { name: 'get_director_status', description: SKILL_DESC('builtin-status'), parameters: { type: 'object', properties: {} } } },
  list_shots: { type: 'function', function: { name: 'list_shots', description: SKILL_DESC('builtin-shots'), parameters: { type: 'object', properties: {} } } },
  rerender_shots: {
    type: 'function',
    function: {
      name: 'rerender_shots',
      description: SKILL_DESC('builtin-rerender'),
      parameters: {
        type: 'object',
        properties: {
          shot_indexes: { type: 'array', items: { type: 'integer' }, description: '要重新渲染的镜号列表（分镜 index，从 1 开始）' }
        },
        required: ['shot_indexes']
      }
    }
  },
  render_sample: {
    type: 'function',
    function: {
      name: 'render_sample',
      description: SKILL_DESC('builtin-sample'),
      parameters: {
        type: 'object',
        properties: {
          shot_indexes: {
            type: 'array',
            items: { type: 'integer' },
            description: '可选：指定试片镜号（2-3 个）。不给则自动挑选不同景别/场景的代表镜头。建议先调用 list_shots 查看分镜再决定。'
          }
        }
      }
    }
  },
  make_trailer: {
    type: 'function',
    function: {
      name: 'make_trailer',
      description: SKILL_DESC('builtin-trailer'),
      parameters: {
        type: 'object',
        properties: {
          shot_indexes: {
            type: 'array',
            items: { type: 'integer' },
            description: '可选：指定高潮镜号（6-10 个）。不给则自动挑选台词情绪强/动作戏的高光镜头。建议先调用 list_shots 查看分镜再决定。'
          },
          clip_seconds: { type: 'number', description: '可选：每段截取秒数，默认 1.5' },
          with_bgm: { type: 'boolean', description: '可选：是否混 BGM，默认 true' }
        }
      }
    }
  },
  get_comfyui_status: { type: 'function', function: { name: 'get_comfyui_status', description: SKILL_DESC('builtin-comfyui'), parameters: { type: 'object', properties: {} } } },
  list_workflows: { type: 'function', function: { name: 'list_workflows', description: SKILL_DESC('builtin-workflows'), parameters: { type: 'object', properties: {} } } },
  choose_workflow: {
    type: 'function',
    function: {
      name: 'choose_workflow',
      description: SKILL_DESC('builtin-choose-workflow'),
      parameters: {
        type: 'object',
        properties: {
          workflow_name: STR_PROP('工作流名称，须与 list_workflows 返回一致'),
          scope: { type: 'string', description: '作用范围：global 全局默认 / project 当前项目默认 / shot 单个分镜', enum: ['global', 'project', 'shot'] },
          shot_index: { type: 'number', description: 'scope=shot 时的分镜镜号（1 起）' }
        },
        required: ['workflow_name']
      }
    }
  },
  get_workflow_params: {
    type: 'function',
    function: {
      name: 'get_workflow_params',
      description: SKILL_DESC('builtin-workflow-params'),
      parameters: {
        type: 'object',
        properties: { workflow_name: STR_PROP('工作流名称') },
        required: ['workflow_name']
      }
    }
  },
  update_workflow_param: {
    type: 'function',
    function: {
      name: 'update_workflow_param',
      description: SKILL_DESC('builtin-workflow-tune'),
      parameters: {
        type: 'object',
        properties: {
          workflow_name: STR_PROP('工作流名称'),
          node_id: STR_PROP('节点 ID'),
          key: STR_PROP('参数名'),
          value: { description: '新值（字符串/数字/布尔，类型与原值一致）' }
        },
        required: ['workflow_name', 'node_id', 'key', 'value']
      }
    }
  },
  create_workflow: {
    type: 'function',
    function: {
      name: 'create_workflow',
      description: SKILL_DESC('builtin-workflow-create'),
      parameters: {
        type: 'object',
        properties: {
          name: STR_PROP('工作流名称（英文或中文，不含扩展名）'),
          content: STR_PROP('ComfyUI API 格式的完整工作流 JSON 文本')
        },
        required: ['name', 'content']
      }
    }
  },
  list_memories: {
    type: 'function',
    function: {
      name: 'list_memories',
      description: SKILL_DESC('builtin-memory-list'),
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: '可选分类筛选', enum: ['preference', 'rule', 'lesson'] }
        }
      }
    }
  },
  save_memory: {
    type: 'function',
    function: {
      name: 'save_memory',
      description: SKILL_DESC('builtin-memory-save'),
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: 'preference=用户偏好，rule=制作规则，lesson=经验教训', enum: ['preference', 'rule', 'lesson'] },
          title: STR_PROP('一句话标题（便于检索，如"台词偏口语化"）'),
          content: STR_PROP('记忆正文，具体、可执行')
        },
        required: ['kind', 'title', 'content']
      }
    }
  }
}

/** 自定义提示词技能的统一工具 schema（运行时按技能生成） */
export function customToolSpec(skill: Skill): ToolSpec {
  return {
    type: 'function',
    function: {
      name: `custom_${skill.id}`,
      description: skill.description,
      parameters: {
        type: 'object',
        properties: { user_text: STR_PROP('用户针对该技能的具体要求或素材') },
        required: ['user_text']
      }
    }
  }
}

export class SkillService {
  private cache: Skill[] | null = null

  constructor(private baseDir: string) {}

  private get file(): string {
    return path.join(this.baseDir, SAVE_FILE)
  }

  /** 读取全部技能；首次运行或升级时补齐内置种子 */
  async list(): Promise<Skill[]> {
    if (this.cache) return this.cache
    let saved: Skill[] = []
    try {
      saved = JSON.parse(await fs.readFile(this.file, 'utf8')) as Skill[]
    } catch {
      saved = []
    }
    const savedMap = new Map(saved.map(s => [s.id, s]))
    // 内置以代码为准（描述升级生效），启用状态沿用用户配置
    const merged: Skill[] = BUILTIN_SKILLS.map(b => {
      const old = savedMap.get(b.id)
      return old ? { ...b, enabled: old.enabled } : b
    })
    // 用户自定义技能追加在后
    for (const s of saved) {
      if (!s.builtin) merged.push(s)
    }
    this.cache = merged
    await this.persist()
    return merged
  }

  async create(input: { name: string; description: string; promptTemplate: string }): Promise<Skill> {
    const all = await this.list()
    const skill: Skill = {
      id: `sk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name: input.name.trim(),
      description: input.description.trim(),
      enabled: true,
      builtin: false,
      kind: 'prompt',
      promptTemplate: input.promptTemplate,
      createdAt: Date.now()
    }
    all.push(skill)
    this.cache = all
    await this.persist()
    return skill
  }

  async update(
    id: string,
    patch: Partial<Pick<Skill, 'name' | 'description' | 'enabled' | 'promptTemplate'>>
  ): Promise<void> {
    const all = await this.list()
    const idx = all.findIndex(s => s.id === id)
    if (idx < 0) throw new Error('技能不存在')
    all[idx] = { ...all[idx], ...patch }
    this.cache = all
    await this.persist()
  }

  async remove(id: string): Promise<void> {
    const all = await this.list()
    const target = all.find(s => s.id === id)
    if (!target) return
    if (target.builtin) throw new Error('内置技能不可删除')
    this.cache = all.filter(s => s.id !== id)
    await this.persist()
  }

  async toggle(id: string, enabled: boolean): Promise<void> {
    await this.update(id, { enabled })
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(this.file, JSON.stringify(this.cache || [], null, 2))
  }
}

