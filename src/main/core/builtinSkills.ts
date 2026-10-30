import type { Skill } from '../../shared/ipcTypes'

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
    description: '让任务继续执行。停在阶段确认点时直接继续下一阶段；若任务因应用重启/崩溃中断或某阶段失败（并非停在确认点），会从中断/失败阶段断点续跑，此前已完成的阶段不会重跑。用户说"继续/接着跑/没问题继续"时使用。'
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
    description: '对当前项目指定镜号重新渲染（可多个）。重渲人物镜（i2v）时系统会自动先重建首帧（单图定妆锁定）再渲染。用户说"重渲第X镜/这一镜再来一条/换一条"时使用；不指定镜号时先追问。'
  },
  {
    id: 'builtin-rerun-casting', name: '重跑角色定妆', enabled: true, builtin: true, kind: 'tool',
    tool: 'rerun_casting', createdAt: 0,
    description: '重新生成当前项目全部角色的定妆资产（面部头肩图 + 三视图，纯灰底干净背景）。定妆图背景不干净、角色外貌需要重出时使用。重出后需重建首帧并重渲才在视频中生效。'
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
    id: 'builtin-library-import', name: '导入工作流库', enabled: true, builtin: true, kind: 'tool',
    tool: 'import_library_workflow', createdAt: 0,
    description: '把用户收集的 ComfyUI 工作流库（100+ 个：图片编辑/换脸换装/多视角/数字人对口型/歌曲生成/高清修复/动作迁移等，UI 格式）里的某个工作流转换导入为应用模板，导入后即可在渲染中使用。用户说"用工作流库里的XX/把我那个换脸工作流用上/导入XX工作流"时使用。先用 list_workflows 查看 library 里的完整清单（path 形如 分类/文件名），再调用本工具导入。'
  },
  {
    id: 'builtin-quick-render', name: '快速生成', enabled: true, builtin: true, kind: 'tool',
    tool: 'render_quick', createdAt: 0,
    description: '直接生成一个视频或图片（不走分镜流水线）。用户说"帮我做个15秒的视频/用这张图按提示词生成视频/生成一张XX图/做个首尾帧转场"时使用。自动按用户意图选工作流：给了参考图→选图生视频或图生图（i2v/i2i）并把图传 ref_image；只给文字没有图→选文生视频或文生图（t2v/t2i）；要求首尾帧（起止两张图）→选 flf2v。先用 list_workflows 看 available 里的 capability 标签挑最匹配的；如果模板里没有对应能力的工作流，先 import_library_workflow 从库导入（如 Wan REMIX 文生视频），再 render_quick。'
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
  },
  // ===== 全功能操作技能（权限：完整访问应用所有功能模块）=====
  {
    id: 'builtin-characters', name: '查看角色库', enabled: true, builtin: true, kind: 'tool',
    tool: 'list_characters', createdAt: 0,
    description: '读取当前项目的角色库：姓名、音色、语速、中文简介与外观锁定短语。讨论选角、配音或要改角色信息前先调用。'
  },
  {
    id: 'builtin-update-character', name: '修改角色', enabled: true, builtin: true, kind: 'tool',
    tool: 'update_character', createdAt: 0,
    description: '修改当前项目某个角色的姓名、简介、TTS 音色或语速。用户说"把XX的音色换成男声/改角色名"时使用；改动前先 list_characters 确认角色存在。'
  },
  {
    id: 'builtin-update-shot', name: '修改分镜', enabled: true, builtin: true, kind: 'tool',
    tool: 'update_shot', createdAt: 0,
    description: '修改当前项目指定镜号的分镜字段：场景、动作提示词、台词、镜头类型（i2v/t2v）、景别、运镜、情绪、帧数。用户说"把第X镜台词改成…"时使用；改前先 list_shots 核对镜号。'
  },
  {
    id: 'builtin-add-shot', name: '新增分镜', enabled: true, builtin: true, kind: 'tool',
    tool: 'add_shot', createdAt: 0,
    description: '在当前项目指定位置插入一个新分镜（场景/动作/台词/类型/景别）。用户说"在后面加一个空镜/补一个反应镜头"时使用。'
  },
  {
    id: 'builtin-delete-shot', name: '删除分镜', enabled: true, builtin: true, kind: 'tool',
    tool: 'delete_shot', createdAt: 0,
    description: '删除当前项目指定镜号的分镜（其余镜头自动重新编号）。属于破坏性操作，用户表达不明确时先确认。'
  },
  {
    id: 'builtin-move-shot', name: '调整镜序', enabled: true, builtin: true, kind: 'tool',
    tool: 'move_shot', createdAt: 0,
    description: '把当前项目某个镜头移动到新位置（其余镜头自动重新编号）。用户说"把第5镜挪到开头"时使用。'
  },
  {
    id: 'builtin-projects', name: '查看项目库', enabled: true, builtin: true, kind: 'tool',
    tool: 'list_projects', createdAt: 0,
    description: '列出全部项目：片名、题材、状态、镜头完成数、最近更新时间。用户问"我有哪些项目/打开哪个"时使用。'
  },
  {
    id: 'builtin-open-project', name: '切换项目', enabled: true, builtin: true, kind: 'tool',
    tool: 'open_project', createdAt: 0,
    description: '把导演的操作上下文切换到指定项目（之后的分镜/角色/渲染操作都作用于它）。用户说"切换到《XX》/操作另一个项目"时使用；需先用 list_projects 拿到项目名。'
  },
  {
    id: 'builtin-settings', name: '查看应用设置', enabled: true, builtin: true, kind: 'tool',
    tool: 'get_settings', createdAt: 0,
    description: '读取应用配置摘要：LLM 模型、ComfyUI 地址、默认渲染参数、默认工作流、TTS 音色（不包含 API Key 明文）。用户问"现在用的什么模型/分辨率"时使用。'
  },
  {
    id: 'builtin-update-settings', name: '修改应用设置', enabled: true, builtin: true, kind: 'tool',
    tool: 'set_settings', createdAt: 0,
    description: '修改应用配置并立即保存生效：默认工作流、渲染参数（分辨率/帧数/口型/一致性/显存档位）、ComfyUI 地址、TTS 音色语速、LLM 模型与 API 地址。自检发现问题需要修复、或用户要求调整配置时使用；只传需要修改的字段，其余保持不变。'
  },
  {
    id: 'builtin-set-bgm', name: '设置项目 BGM', enabled: true, builtin: true, kind: 'tool',
    tool: 'set_project_bgm', createdAt: 0,
    description: '为本项目配置 BGM 音频（用户提供本机 mp3/wav 绝对路径，复制进项目目录）与混音音量。用户说"用这首曲子做BGM"时使用。'
  },
  {
    id: 'builtin-files', name: '查看项目产物', enabled: true, builtin: true, kind: 'tool',
    tool: 'list_project_files', createdAt: 0,
    description: '列出当前项目目录内的产物文件（成片、分段视频、音频、图片）与大小。用户问"片子/素材在哪儿"时使用；配合 open_file 可在资源管理器中定位。'
  },
  {
    id: 'builtin-open-file', name: '打开文件位置', enabled: true, builtin: true, kind: 'tool',
    tool: 'open_file', createdAt: 0,
    description: '在系统资源管理器中定位并选中项目内的某个文件（成片、样片、分段、音频等）。用户说"打开成片文件夹/给我看看文件"时使用。'
  },
  // ===== 网络自主学习技能 =====
  {
    id: 'builtin-web-search', name: '网络搜索', enabled: true, builtin: true, kind: 'tool',
    tool: 'web_search', createdAt: 0,
    description: '搜索互联网获取最新知识（短剧行业动态、AI 视频新技术、拍摄手法等）。遇到超出既有知识的问题、用户要求查资料、或想学习新技能时使用。'
  },
  {
    id: 'builtin-fetch-url', name: '阅读网页', enabled: true, builtin: true, kind: 'tool',
    tool: 'fetch_url', createdAt: 0,
    description: '抓取指定网址的正文文本。通常在 web_search 拿到结果后，挑选最相关的链接深入阅读。'
  },
  {
    id: 'builtin-create-skill', name: '沉淀新技能', enabled: true, builtin: true, kind: 'tool',
    tool: 'create_skill', createdAt: 0,
    description: '把学到的方法论沉淀为可复用的自定义技能（提示词模板，含 {{input}} 占位符），之后可在对话中直接调用。网络学习到新知识、用户总结出新流程时使用；学会后要主动告知用户新增了什么技能。'
  },
  {
    id: 'builtin-list-skills', name: '查看已沉淀技能', enabled: true, builtin: true, kind: 'tool',
    tool: 'list_skills', createdAt: 0,
    description: '列出所有已沉淀的自定义技能（名称、用途、更新时间）。自主学习开始前先调用以避免重复沉淀；用户问"你都会哪些技能/学到了什么"时使用。'
  },
  {
    id: 'builtin-update-skill', name: '更新已有技能', enabled: true, builtin: true, kind: 'tool',
    tool: 'update_skill', createdAt: 0,
    description: '按技能 id 更新已沉淀技能的名称/用途/提示词模板。自主学习发现旧技能有更好的做法、或用户要求改进某个技能时使用；更新后主动告知用户改了什么。'
  },
  {
    id: 'builtin-comfy-mcp', name: 'ComfyUI-MCP 工具集', enabled: false, builtin: true, kind: 'tool',
    tool: 'comfy_mcp', createdAt: 0,
    description: '通过 MCP 协议调用 ComfyUI 官方开源 comfy-mcp 的 40+ 工具：运行工作流、提交/等待/取消任务、取回生成结果、搜索节点/模型/模板、校验工作流、管理 ComfyUI 进程等。启用前需完成 comfy-mcp venv 安装（缺失时会返回安装指引）。注意：其进程管理类工具（stop/restart）与项目 ComfyUI 面板并行使用时面板状态会滞后，下次 healthCheck 自愈。'
  }
]
