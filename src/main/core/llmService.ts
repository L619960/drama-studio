import axios from 'axios'
import type { AppSettings, GeneratedShot, GenreTemplate, AnalyzeResult, AnalyzedCharacter, AnalyzedShot } from '../../shared/ipcTypes'

/** OpenAI 兼容对话消息（含 function calling） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

/** 工具规格（OpenAI function-calling JSON Schema） */
export interface ToolSpec {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/**
 * 火山方舟（Ark）LLM 服务：OpenAI 兼容 chat/completions 接口。
 * - 提示词翻译：中文分镜描述 → 英文专业视频提示词
 * - AI 拆分镜：一段剧本 → 结构化分镜列表
 * - 导演对话：多轮消息 + 工具调用
 */
export class LLMService {
  constructor(
    private getSettings: () => Promise<AppSettings>,
    private genreTemplates: GenreTemplate[]
  ) {}

  /** 通用多轮对话，支持 function-calling。返回 assistant 消息（可能携带 tool_calls） */
  async chatCompletion(
    messages: ChatMessage[],
    opts: { temperature?: number; timeoutMs?: number; tools?: ToolSpec[] } = {}
  ): Promise<ChatMessage> {
    const s = await this.getSettings()
    if (!s.llm.apiKey) {
      throw new Error('请先在 设置 → LLM 中配置 API Key')
    }
    const baseUrl = (s.llm.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')
    const body: Record<string, unknown> = {
      model: s.llm.model,
      messages,
      temperature: opts.temperature ?? 0.6
    }
    if (opts.tools?.length) {
      body.tools = opts.tools
      body.tool_choice = 'auto'
    }
    const resp = await axios.post(`${baseUrl}/chat/completions`, body, {
      headers: { Authorization: `Bearer ${s.llm.apiKey}` },
      timeout: opts.timeoutMs ?? 180000
    })
    const msg = resp.data?.choices?.[0]?.message
    if (!msg) throw new Error('LLM 返回为空')
    return {
      role: 'assistant',
      content: msg.content || '',
      tool_calls: Array.isArray(msg.tool_calls) ? msg.tool_calls : undefined
    }
  }

  private async chat(system: string, user: string, temperature = 0.7, timeoutMs = 60000): Promise<string> {
    const s = await this.getSettings()
    if (!s.llm.apiKey) {
      throw new Error('请先在 设置 → LLM 中配置 API Key')
    }
    const baseUrl = (s.llm.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')
    const resp = await axios.post(
      `${baseUrl}/chat/completions`,
      {
        model: s.llm.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        temperature
      },
      {
        headers: { Authorization: `Bearer ${s.llm.apiKey}` },
        timeout: timeoutMs
      }
    )
    const content: string = resp.data?.choices?.[0]?.message?.content?.trim() || ''
    if (!content) throw new Error('LLM 返回为空')
    return content
  }

  /** 连通性测试：发送最小请求，返回模型名 */
  async test(): Promise<string> {
    const s = await this.getSettings()
    await this.chat('You are a connectivity probe. Reply with exactly: ok', 'ping', 0)
    return s.llm.model
  }

  /**
   * 中文分镜描述 → 英文专业提示词。
   * 只写动作与镜头语言，不写外貌（避免角色漂移）；带题材风格前缀。
   */
  async translatePrompt(input: { scene: string; action: string; dialogue: string; genre: string }): Promise<string> {
    const tpl = this.genreTemplates.find(t => t.key === input.genre)
    const system = [
      'You are a professional cinematic prompt writer for AI video generation (image-to-video).',
      'Translate the Chinese shot description into ONE line of English prompt.',
      'Rules:',
      '- Describe ONLY actions, camera movement, lighting and atmosphere. Never describe character appearance/clothing (the reference image controls appearance).',
      '- Use slow, gentle motion verbs (slowly, gently, slightly) to avoid motion artifacts.',
      '- Comma-separated phrases, no sentences, no quotes, no explanations, 15~40 words.',
      tpl ? `- Style prefix to weave in: ${tpl.promptStyle}` : ''
    ].filter(Boolean).join('\n')

    const user = [
      `场景: ${input.scene || '未指定'}`,
      `动作: ${input.action}`,
      input.dialogue ? `台词情绪参考: ${input.dialogue}` : ''
    ].filter(Boolean).join('\n')

    return this.chat(system, user, 0.5)
  }

  /**
   * AI 拆分镜：剧本 → 分镜 JSON 数组。
   * 健壮解析：剥离 markdown 代码围栏，截取首个 [ 到末个 ]。
   */
  async splitScript(script: string, genre: string): Promise<GeneratedShot[]> {
    const tpl = this.genreTemplates.find(t => t.key === genre)
    const system = [
      'You are a short-drama director. Split the script into shots for AI video generation.',
      'Output ONLY a JSON array, no markdown fences, no explanations.',
      'Each element: {"scene": "中文场景名(4~8字)", "action": "英文动作提示词(15~40词,逗号分隔短语,只写动作/镜头/光影,不写人物外貌)", "dialogue": "中文台词(无台词则为空字符串)", "type": "i2v 或 t2v", "camera": "英文机位运镜短语(static camera/slow push-in 等)", "emotion": "英文情绪短语(1~3个形容词)"}',
      '- type=i2v：有人物出现的镜头；type=t2v：纯空镜（环境/物品/场景过渡）',
      '- 动作提示词使用缓慢动词（slowly/gently/slightly），镜头以静态或缓推为主',
      '- camera/emotion 为必填英文短语',
      tpl ? `- 题材风格: ${tpl.promptStyle}` : '',
      '- 8~20 个镜头，按剧情顺序排列'
    ].filter(Boolean).join('\n')

    const raw = await this.chat(system, script, 0.7, 120000)
    const cleaned = raw.replace(/```(?:json)?/g, '').trim()
    const start = cleaned.indexOf('[')
    const end = cleaned.lastIndexOf(']')
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('LLM 返回格式异常，无法解析分镜列表')
    }
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as GeneratedShot[]
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('LLM 未拆分出任何分镜')
    }
    // 字段兜底清洗
    return parsed
      .filter(s => s && typeof s.action === 'string' && s.action.trim())
      .map(s => ({
        scene: String(s.scene || '').trim(),
        action: String(s.action).trim(),
        dialogue: String(s.dialogue || '').trim(),
        type: s.type === 't2v' ? 't2v' : 'i2v',
        camera: typeof s.camera === 'string' ? String(s.camera).trim() : undefined,
        emotion: typeof s.emotion === 'string' ? String(s.emotion).trim() : undefined
      }))
  }

  /**
   * AI 导演·剧本分析：一次调用同时产出角色清单与分镜列表。
   * 提示词强制六步方法论：指称提取 → 归一合并 → 入选判定 →
   * 角色档案 → 主角归属 → 输出自检；返回前再做本地归一化兜底。
   */
  async analyze(script: string, genre: string): Promise<AnalyzeResult> {
    const tpl = this.genreTemplates.find(t => t.key === genre)
    const system = [
      '你是一名资深中文短剧剧本统筹，要把剧本解析为「角色表 + 分镜表」，供 AI 视频生产线使用。',
      '',
      '# 工作流程（严格按顺序在脑中完成，不要输出推理过程）',
      '',
      '第一步·提取人物指称：通读全文，标出所有指称人物的说法：',
      '- 全名、小名（如：陆景琛、苏晚、阿晚）',
      '- 身份头衔称呼（如：陆总、苏小姐、少爷、总裁、妈）',
      '- 代词（他/她/那个男人）：记下所在句子，第二步再归属',
      '- 群体说法（众人、宾客、保镖、服务员）：记为群演',
      '',
      '第二步·指称归一与身份合并：把指向同一人的说法合并：',
      '- 标准名选取优先级：全名 > 最常用称呼 > 首次出现的称呼',
      '- 必须合并的典型情况：姓氏+头衔与全名（陆总、景琛=陆景琛）；小名与全名（阿晚=苏晚）；关系称谓（妈、妈妈）与对应全名',
      '- 代词归属：按性别一致 + 同句或上一句的主语，就近消解',
      '- 证据不足以确定两个说法是同一人时，宁可保留为两个角色，禁止臆断合并',
      '- 群演（服务员、司机、保镖、路人、宾客、秘书、护士、店员、旁白、"众人"等）一律不进角色表；除非该人有姓名，并且有台词或推动剧情的关键动作',
      '',
      '第三步·角色入选判定：必须有稳定指称（姓名或固定称呼），且满足以下任一：',
      '- 有台词；- 做出推动剧情的关键动作；- 是多个镜头反复聚焦的对象',
      '- 角色数量 2~6 人；超过 6 人时只保留戏份最重要的',
      '',
      '第四步·建立角色档案（信息只能来自剧本，禁止编造）：',
      '- 优先采用括号角色小传（如：苏晚（25岁，长发，白色睡裙）），其次采用旁白与动作描写中的外貌、服装、年龄信息',
      '- gender 必须有明确依据（称呼、代词、外貌）；确实无法判断时再按名字与语境推测',
      '- appearance：中文客观外貌与服装描述（20~60字），开头注明「中国人，亚洲面孔」；剧本没写的内容不要虚构',
      '- lookEn：英文逗号分隔的「角色外观锁定短语」（15~30 词），是该角色定妆图与全剧每镜首帧图逐字复用的唯一外观来源，必须依次包含：① 人种年龄性别（chinese 开头）② 脸型与显著五官 ③ 发型发色（长度+颜色+造型）④ 锁定服装（颜色+款式，全剧不随镜头改变）⑤ 一个高辨识度锚点细节（如左眉上方小痣、单只银耳环、颈后纹身），扩散模型依赖这类特异细节跨镜重识别同一人。示例：chinese woman in her late 20s, oval face, almond-shaped dark eyes, shoulder-length wavy black hair parted on the left, rust-orange linen jacket over cream tee, small mole above left eyebrow。剧本未写明的细节可合理补全，但同一角色在所有镜头中必须使用完全相同的 lookEn 字符串，禁止逐镜改写',
      '',
      '第五步·拆分镜头并归属主角（8~20 镜，按剧情顺序）：',
      '- i2v（出现人物）必须归属唯一主角 characterName，归属优先级：',
      '  ① 该镜头台词的说话人（"某某：台词"或"某某说"中的某某）',
      '  ② 该镜头动作的主要执行者',
      '  ③ 镜头焦点人物',
      '  同镜多人时，说话人优先；都无台词时选动作主体。characterName 必须写角色表的标准名，禁止写头衔、小名、代词',
      '- 群演台词特殊处理：若说话人是群演（不在角色表，如服务员、护士、路人），该句不要写入 dialogue（视为环境声），镜头仍按画面焦点归属主角；严禁让主角"替说"群演的台词。群演与主角的台词出现在同一句/相邻句时，必须分别处理：丢群演、留主角，不可一并丢弃',
      '- dialogue 只包含台词内容本身：严禁出现"角色名："之类的说话人前缀（该字段会被 TTS 逐字朗读），也不要写旁白或动作提示',
      '- 极短回应（2~4字，如"不去""等一下""江哲"）也是正式台词，必须原样保留，不得因为短而丢弃',
      '- t2v（纯空镜）：环境、物品、场景过渡、只有群演出现的镜头，不给 characterName',
      '- 关键交接动作必须独立成镜：递接物品（递伞/接伞、交换文件、递东西）、开门上车、拥抱、握手、扇耳光、转身离开等推动剧情的物理动作，必须单独占一个镜头，明确呈现动作完成的瞬间（如手握住伞柄、伞易手）；严禁与对视、对话、心理犹豫等其他动作合并而被吞掉',
      '- 重要情绪转折点给足镜头：拒绝→动摇→接受这类情绪变化至少用两个镜头（先有犹豫/动容的反应镜头，再有做出决定的动作镜头），不能只在一个镜头里一笔带过',
      '- 单人居画面铁律（极重要）：每个镜头画面里只能出现一个可识别人脸的角色。对手戏必须用正反打/反应镜头拆开——说话人镜头只拍说话人；听话方用无台词的反应镜头（低头、眼神、手部小动作）表达；另一个人在场时只能以背影、过肩虚化剪影、画外空间的方式暗示，禁止两张清晰人脸同框（AI 无法保证第二张脸与角色一致）',
      '- 动作幅度要小而稳：i2v 是在静态首帧上做运动，无法完成大幅肢体位移。跑过场地、连续上楼、摔倒翻滚、打斗扑跃、长距离走动这类纯位移过程改用 t2v 空镜（脚步特写、门被拉开、远景移动人影）带过',
      '- 关键叙事动作必须有人物出镜（禁止做成空镜）：开门上车/下车、拥抱、递交、扇耳光等推动剧情的动作，用「动作完成态或临界态」的 i2v 呈现——首帧直接承载动作姿态，视频中只做小幅表演：上车=人已坐进车内座位、手扶车门回头说话；下车=人已站在车外手扶车门；拥抱=已相拥只余轻微起伏；递物=手已伸到对方面前。action 只描写姿态保持与微表情，禁止描写"弯腰移动、钻入、冲出"等位移过程',
      '- 每个镜头必须给出 shotSize 景别：closeup（面部/手部/道具特写，用于情绪与交接动作）、medium（腰部以上中景，用于对话表演，默认选择）、wide（远景全身与环境，人物镜少用）',
      '- 每个镜头必须给出 camera 镜头语言（英文短语，1~6 词）：机位与运镜，如 static camera、slow push-in（缓推强调情绪）、slow pull-back、slow pan、slight handheld；i2v 优先 static camera / slow push-in，禁止快速摇移与变焦',
      '- 每个镜头必须给出 emotion 情绪基调（英文，1~3 个形容词）：人物镜给表演情绪（如 tense, anxious / heartbroken, tearful / relieved, soft / cold, defiant），空镜给氛围情绪（如 eerie, gloomy / warm, peaceful）',
      '- action：英文视频动作提示词，15~40 词，只写动作/镜头运动/光影氛围，禁止写人物外貌（外貌由参考图控制）',
      '- 有台词的镜头：action 必须体现人物正在开口说话（如 speaking, lips moving naturally, expressive facial expression, gesturing while talking）；仅无台词镜头才用缓慢氛围动词（slowly/gently/slightly）',
      tpl ? `- 题材风格须贯穿全部分镜与角色气质: ${tpl.promptStyle}` : '',
      '',
      '第六步·输出前自检（全部通过才可输出）：',
      '1. 每个 i2v 镜头的 characterName 都与角色表中的某个标准名完全一致',
      '2. 角色表中没有任何群演或纯功能性人物',
      '3. 同一个人物没有被拆成两个角色；每个角色的 aliases 完整列出其头衔与小名',
      '4. 重新扫描原文中每一对引号内的台词，逐一核对：主角台词（含2~4字极短回应）都在某个镜头的 dialogue 中，且内容不含说话人前缀；群演台词未进入任何 dialogue',
      '5. action 全部是英文，且不含外貌描写',
      '6. 原文每个关键交接动作（递接物品、开门上车、拥抱、转身离开等）都能在分镜表中找到一个专门呈现它的镜头，没有被并入其他镜头',
      '7. 没有任何一个 i2v 镜头需要两张清晰人脸同框；对手戏已拆成说话人镜头与听话人反应镜头',
      '8. 人物 i2v 镜头不含奔跑、长距离走动、摔倒、打斗等大幅位移过程；上车/下车/拥抱等关键叙事动作为人物出镜的「完成态」i2v，未被误标成 t2v 空镜；每个镜头都有合法的 shotSize 字段',
      '9. 每个镜头都有英文 camera（机位运镜）与 emotion（情绪/氛围）字段，且 i2v 的运镜为静态或缓推',
      '',
      '# 边界示例（严格照此处理）',
      '示例1·同句中群演与主角各有台词：',
      '原文：服务员上前："二位，现在点餐吗？""等一下。"白若曦头也没抬。',
      '正确：characterName="白若曦"，dialogue="等一下。"——服务员的话丢弃，白若曦的话保留，不可一并丢弃',
      '示例2·极短回应：',
      '原文：孟瑶："晚上联谊，去吗？"苏棠："不去。"',
      '正确：两个镜头的 dialogue 分别为 "晚上联谊，去吗？" 与 "不去。"——3字以下也要保留，且不带"孟瑶：""苏棠："前缀',
      '',
      '# 输出格式：只输出一个 JSON 对象，禁止 markdown 代码围栏与任何解释',
      '{',
      '  "logline": "一句话故事梗概(中文)",',
      '  "characters": [',
      '    {"name":"标准名","gender":"male 或 female","age":"年龄段","appearance":"中文外貌描述","lookEn":"chinese ..., 脸型五官, 发型发色, 锁定服装, 辨识锚点（15~30词英文短语）","aliases":["其他称呼1","其他称呼2"],"confidence":"high/medium/low"}',
      '  ],',
      '  "shots": [',
      '    {"scene":"中文场景名(4~8字)","sceneEn":"英文环境短语","action":"英文动作提示词","dialogue":"中文台词，无则为空字符串","type":"i2v 或 t2v","characterName":"主角标准名，空镜省略","shotSize":"closeup 或 medium 或 wide","camera":"英文机位运镜短语","emotion":"英文情绪短语"}',
      '  ]',
      '}'
    ].filter(Boolean).join('\n')

    // 角色识别优先确定性：低温度降低指称归属漂移
    // 长方法论 prompt + 完整角色/分镜 JSON 输出，lite 模型需要较长超时
    const raw = await this.chat(system, script, 0.4, 300000)
    const cleaned = raw.replace(/```(?:json)?/g, '').trim()
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('LLM 返回格式异常，无法解析分析结果')
    }
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
      logline?: unknown
      characters?: unknown
      shots?: unknown
    }

    const characters: AnalyzedCharacter[] = Array.isArray(parsed.characters)
      ? parsed.characters
          .filter((c): c is Record<string, unknown> =>
            Boolean(c) && typeof (c as Record<string, unknown>).name === 'string'
          )
          .map(c => ({
            name: String(c.name).trim(),
            gender: c.gender === 'male' ? 'male' : 'female',
            age: c.age ? String(c.age) : undefined,
            appearance: String(c.appearance || '').trim(),
            lookEn: String(c.lookEn || '').trim() || 'attractive person',
            aliases: Array.isArray(c.aliases)
              ? c.aliases.map(a => String(a).trim()).filter(Boolean)
              : undefined,
            confidence: ['high', 'medium', 'low'].includes(c.confidence as string)
              ? (c.confidence as 'high' | 'medium' | 'low')
              : undefined
          }))
      : []

    if (characters.length === 0) throw new Error('LLM 未识别出任何角色')

    const shots: AnalyzedShot[] = Array.isArray(parsed.shots)
      ? parsed.shots
          .filter((s): s is Record<string, unknown> =>
            Boolean(s) && typeof (s as Record<string, unknown>).action === 'string'
          )
          .map(s => {
            const type = s.type === 't2v' ? 't2v' : 'i2v'
            const characterName =
              type === 'i2v' && typeof s.characterName === 'string'
                ? String(s.characterName).trim()
                : undefined
            const shotSizeRaw = String(s.shotSize || '').trim().toLowerCase()
            const shotSize =
              shotSizeRaw === 'closeup' || shotSizeRaw === 'wide'
                ? shotSizeRaw
                : 'medium'
            return {
              scene: String(s.scene || '').trim(),
              sceneEn: typeof s.sceneEn === 'string' ? String(s.sceneEn).trim() : undefined,
              action: String(s.action).trim(),
              dialogue: String(s.dialogue || '').trim(),
              type,
              characterName,
              shotSize: type === 'i2v' ? shotSize : undefined,
              camera: typeof s.camera === 'string' ? String(s.camera).trim() : undefined,
              emotion: typeof s.emotion === 'string' ? String(s.emotion).trim() : undefined
            }
          })
      : []

    if (shots.length === 0) throw new Error('LLM 未拆分出任何分镜')

    const result: AnalyzeResult = {
      logline: typeof parsed.logline === 'string' ? parsed.logline : undefined,
      characters,
      shots
    }
    // 本地兜底：别名归一 + 无法匹配的绑定记录为 warnings
    return this.normalizeBindings(result)
  }

  /**
   * 后处理兜底：把镜头 characterName 归一到角色标准名。
   * - 标准名精确命中 / aliases 命中 → 替换为标准名
   * - 去头衔（陆总→陆）或名字部分（去姓）模糊命中 → 替换
   * - 无法匹配 → 保留原值并记录 warning（该镜渲染时会失败并计入最终汇总）
   */
  private normalizeBindings(result: AnalyzeResult): AnalyzeResult {
    const warnings: string[] = []
    const aliasMap = new Map<string, string>()
    for (const c of result.characters) {
      aliasMap.set(this.foldName(c.name), c.name)
      for (const a of c.aliases || []) {
        aliasMap.set(this.foldName(a), c.name)
      }
    }

    // 去头衔 / 去姓 索引：用于 LLM 写出"陆总""景琛"时的兜底匹配
    const TITLE_WORDS = [
      '先生', '小姐', '女士', '太太', '夫人', '总裁', '总',
      '少爷', '老板', '经理', '主任', '医生', '老师',
      '哥', '姐', '叔', '姨', '妈', '父', '母'
    ]
    const shortMap = new Map<string, string>()
    for (const c of result.characters) {
      shortMap.set(this.foldName(c.name), c.name)
      if (c.name.length >= 2) {
        shortMap.set(this.foldName(c.name.slice(1)), c.name) // 去掉姓
      }
    }

    for (const s of result.shots) {
      if (s.type !== 'i2v') continue

      if (!s.characterName) {
        warnings.push(`镜头「${s.scene}」为人物镜头但未归属主角`)
        continue
      }

      const rawName = s.characterName.trim()
      const exact = aliasMap.get(this.foldName(rawName))
      if (exact) {
        s.characterName = exact
        continue
      }

      let stripped = rawName
      for (const w of TITLE_WORDS) {
        if (stripped.endsWith(w) && stripped.length > w.length) {
          stripped = stripped.slice(0, stripped.length - w.length)
          break
        }
      }
      const folded = this.foldName(stripped)
      const fuzzy =
        shortMap.get(folded) ||
        [...shortMap.entries()].find(
          ([k]) => k.includes(folded) || folded.includes(k)
        )?.[1]

      if (fuzzy) {
        s.characterName = fuzzy
        continue
      }

      warnings.push(
        `镜头「${s.scene}」的主角「${rawName}」无法匹配角色表（${result.characters.map(c => c.name).join('、')}）`
      )
    }

    if (warnings.length > 0) result.warnings = warnings
    return result
  }

  /** 名称归一化键：去空白并小写（中文不受影响） */
  private foldName(s: string): string {
    return s.trim().toLowerCase().replace(/\s+/g, '')
  }

  /**
   * AI 导演·成片复审：以剧本统筹视角审查分镜叙事的完整性与音频匹配。
   * 输入：故事梗概 + 各镜摘要（场景/角色/台词/实际时长）；输出：是否通过 + 问题清单。
   * 低温度保证审批结论稳定。
   */
  async reviewStory(input: {
    title: string
    logline: string
    genre: string
    shots: Array<{ index: number; scene: string; character: string; dialogue: string; durationSec: number }>
  }): Promise<{ passed: boolean; issues: string[]; summary: string }> {
    const system = [
      '你是一名严苛的短剧成片审片导演，负责在剪辑完成后做最终复审，不通过则不允许配 BGM 出片。',
      '',
      '# 审查维度（逐镜逐条过）',
      '1. 剧情完整性：故事是否有开端（人物/冲突引入）、发展（冲突升级或转折）、结局（收束或钩子）；缺哪一环指出缺在哪',
      '2. 镜头衔接逻辑：相邻镜头的时空/动作是否连贯；有没有跳跃、重复、因果断裂',
      '3. 台词与剧情相符：每句台词是否贴合该镜场景与角色处境；是否存在台词与画面行为矛盾、或台词推进了与上下文无关的内容',
      '4. 音画匹配：某镜时长（秒）明显配不上其台词量或剧情分量时指出（如 1 秒塞了 30 字台词、5 秒却只有一个"嗯"）',
      '5. 角色行为一致性：角色动机是否前后矛盾',
      '',
      '# 判定标准',
      '- passed=true：仅存在可忽略的小瑕疵（节奏偏好类），不阻碍出片',
      '- passed=false：存在剧情断裂、台词错位、关键情节缺失等观众能感知的问题',
      '- issues 用中文一句话写清「问题 + 位置（第 N 镜）+ 修改方向」；没有问题给空数组',
      '- summary：两句话内给出总体评价',
      '',
      '# 输出格式：只输出一个 JSON 对象，禁止 markdown 围栏与解释',
      '{"passed": true 或 false, "issues": ["问题1", "问题2"], "summary": "总体评价"}'
    ].join('\n')

    const listing = input.shots
      .map(s =>
        `第${s.index}镜 [${s.durationSec}s] ${s.scene}｜角色:${s.character || '空镜'}｜台词:${s.dialogue || '（无）'}`
      )
      .join('\n')

    const raw = await this.chat(
      system,
      `片名《${input.title}》 题材:${input.genre}\n梗概:${input.logline || '（未提供）'}\n\n分镜清单:\n${listing}`,
      0.2,
      120000
    )
    const cleaned = raw.replace(/```(?:json)?/g, '').trim()
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) {
      // LLM 输出异常时保守放行并说明，避免卡死流水线
      return { passed: true, issues: [], summary: '复审模型输出异常，已跳过剧情复审（仅通过技术质检）' }
    }
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
        passed?: unknown
        issues?: unknown
        summary?: unknown
      }
      return {
        passed: parsed.passed !== false,
        issues: Array.isArray(parsed.issues)
          ? parsed.issues.map(x => String(x)).filter(Boolean).slice(0, 10)
          : [],
        summary: String(parsed.summary || '').trim()
      }
    } catch {
      return { passed: true, issues: [], summary: '复审模型输出解析失败，已跳过剧情复审（仅通过技术质检）' }
    }
  }
}
