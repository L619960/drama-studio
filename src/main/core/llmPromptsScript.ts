/**
 * 【2026-10-25 标注：死代码——本文件导出仅经 llmPrompts.ts 枢纽可达，枢纽 0 消费；
 * live 提示词以 llmService.ts 内联/单文件为准。勿在此新增提示词。】
 * 剧本生产提示词（从 llmPrompts.ts 拆分）：写剧本/视频抽帧写剧本/剧本医生/拆分镜。
 */
import type { GenreTemplate } from '../../shared/ipcTypes'

/** 想法 → 完整短剧剧本：system + user */
export function writeScriptPrompts(
  input: { idea: string; title?: string; genre: string },
  tpl: GenreTemplate | undefined
): { system: string; user: string } {
  const system = [
    '你是一名资深中文短剧编剧，要把创作者的想法扩写成一部可直接用于 AI 短剧生产线的完整分场剧本。',
    '输出要求：',
    '- 纯文本剧本，不要 JSON、不要 markdown 标题符号、不要解释性文字',
    '- 每场格式：第一行「【第N场 · 场景名】」（场景名 4~8 字，如：雨夜天台），随后括号内写环境与动作（人物动作、道具、光线），再写对白「角色：台词」',
    '- 3~6 场，1 个主角 + 1~2 个关键配角 + 可容纳群演；总台词 8~20 句，每句不超过 30 字',
    '- 必须包含：明确的场景/动作/道具细节（供分镜与资产生成使用）、关键道具重复出现（如片名意象）、有起承转合的完整小剧情',
    '- 禁止：网络小说式大段心理描写、无动作的纯对话、超过 4 个有名有姓的角色',
    tpl ? `- 题材风格：${tpl.promptStyle}，开篇 20 字内要有钩子` : ''
  ].filter(Boolean).join('\n')
  const user = [
    input.title ? `片名：《${input.title}》（剧情与关键道具要呼应片名意象）` : '',
    `创作想法：\n${input.idea}`,
    input.genre ? `题材：${tpl?.label || input.genre}` : ''
  ].filter(Boolean).join('\n')
  return { system, user }
}

/** 视频抽帧 → 反推写剧本 system 提示词 */
export function writeScriptFromFramesSystem(tplStyle?: string): string {
  return [
    '你是一名资深中文短剧编剧与拆解导演。下面给你一支视频的关键帧画面（按时间顺序），请根据画面内容反推并扩写为一部完整的 AI 短剧分场剧本。',
    '规则：',
    '- 画面中出现的人物/场景/道具必须纳入剧情；画面没有的信息（台词细节）可以合理创作但不得与画面冲突',
    '- 每场格式：第一行「【第N场 · 场景名】」，随后括号内写环境与动作（人物动作、道具、光线），再写对白「角色：台词」',
    '- 3~6 场，总台词 8~20 句，每句不超过 30 字，关键道具重复出现',
    '- 纯文本剧本，不要 JSON、不要 markdown 标题符号、不要解释性文字',
    tplStyle ? `- 题材风格：${tplStyle}` : ''
  ].filter(Boolean).join('\n')
}

/** 剧本医生（reviewScript）system 提示词 */
export function reviewScriptSystem(tplStyle: string | undefined, title: string | undefined): string {
  return [
    '你是一位从业三十年的短剧剧本医生/资深编剧顾问，专治 AI 短剧剧本的逻辑病。',
    '审查范围（逐项过）：',
    '1. 人物：动机是否成立、性格是否前后矛盾、对话是否符合人设、角色是否工具化/凭空消失',
    '2. 逻辑因果：事件是否铺垫充分、转折是否有依据、是否有无来源信息/预言式跳跃',
    '3. 时间与空间：时间线是否自洽、场景切换是否有交代、人物是否瞬移、昼夜/天气是否冲突',
    '4. 道具与细节：关键道具是否交代去向、前后是否一致、是否有「用过的道具凭空出现」',
    '5. 台词与动作：台词和动作是否矛盾、对话是否答非所问、是否有多余废句',
    '6. 结构节奏：是否头重脚轻、高潮是否草率、结尾是否收得住、题材风格是否统一',
    '',
    '输出 ONLY JSON（禁止 markdown 围栏）：',
    '{"issues":[{"severity":"block 或 warn","scene":"第几场/位置","problem":"问题描述（中文，具体到细节）","suggestion":"修改建议（中文，可执行）"}],"revisedScript":"修复以上全部问题后的完整剧本，格式与原剧本一致（第N场标题行+括号动作+角色：台词），保留原有剧情骨架与人物"}',
    '- 没有问题的维度不要写；确实没问题的剧本 issues 可为空数组，revisedScript 与原剧本一致',
    '- block=会穿帮/明显违背逻辑必须修；warn=建议优化',
    '- revisedScript 必须是完整剧本（不是只列修改），AI 短剧生产线直接可用的分场格式',
    tplStyle ? `- 题材风格基调：${tplStyle}` : '',
    title ? `- 片名：《${title}》，意象需呼应` : ''
  ].filter(Boolean).join('\n')
}

/** 剧本 → 分镜 JSON 数组（splitScript）system 提示词 */
export function splitScriptSystem(tplStyle?: string): string {
  return [
    'You are a short-drama director. Split the script into shots for AI video generation.',
    'Output ONLY a JSON array, no markdown fences, no explanations.',
    'Each element: {"scene": "中文场景名(4~8字)", "action": "英文动作提示词(15~40词,逗号分隔短语,只写动作/镜头/光影,不写人物外貌)", "dialogue": "中文台词(无台词则为空字符串)", "type": "i2v 或 t2v", "camera": "英文机位运镜短语(static camera/slow push-in 等)", "emotion": "英文情绪短语(1~3个形容词)"}',
    '- type=i2v：有人物出现的镜头；type=t2v：纯空镜（环境/物品/场景过渡）',
    '- 动作提示词使用缓慢动词（slowly/gently/slightly），镜头以静态或缓推为主',
    '- 单镜节奏 3~6 秒，长句台词拆成两句或两镜；action 只写动作/镜头/光影，严禁 identical face/appearance/outfit 等外貌锁定措辞',
    '- camera/emotion 为必填英文短语',
    tplStyle ? `- 题材风格: ${tplStyle}` : '',
    '- 8~20 个镜头，按剧情顺序排列'
  ].filter(Boolean).join('\n')
}
