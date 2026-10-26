/**
 * 文本净化域：渲染提示词清洗、对戏从句剥离、户外暗示净化、声音拟音词剥离、
 * 概念召唤词擦洗、中文台词保留。叶子模块：纯字符串处理，不依赖其它提示词模块。
 */

/* ============ 逻辑原子化（图生视频提示词强制规范） ============ */
/* 注：原 LOGIC_ATOMIZATION_RULES / MOTION_* 常量已删除——该块从未被注入任何 prompt
 * （死代码），且其术语表与 llmService 分镜规则的术语表重复维护、内容漂移。
 * 逻辑原子化规则的唯一权威来源是 llmService 分镜系统提示词 + sanitizeCinematicPrompt 清洗。 */

/**
 * 清洗图生视频渲染提示词（渲染组装层兜底，即使 LLM 违规也强制净化）：
 * 1) 删除 * 号（含 ** / *** 加粗残留）；2) 删除文学修饰虚词（中英文）；
 * 3) 删除因果解释词；4) 折叠多余空白。
 * 只作用于文本本身，不改语义顺序；返回空串时调用方回退工业级模板。
 */
export function sanitizeCinematicPrompt(prompt: string): string {
  if (!prompt) return prompt
  let p = prompt.replace(/\*{1,}/g, '')
  // 中文虚词（用户禁令原词 + 常见近义）
  p = p.replace(/(唯美|涟漪|旋涡|氛围|灵魂|能量|如诗如画|诗情画意|诗意|梦幻|缥缈|意境|空灵)/g, '')
  // 英文虚词（与中文禁令对等的艺术化形容词/名词）
  p = p.replace(/\b(ethereal|dreamy|poetic|enchanted|whimsical|soulful|soul|energy|vortex|ripple|serene|breathtaking|magical)\b/gi, '')
  // 因果解释词（中英文）——删除后用逗号衔接，避免句子断裂
  p = p.replace(/(因为|所以|为了|导致|由于|因而)/g, ',')
  p = p.replace(/\b(because|therefore|in order to|so as to|lead to|leads to|caused by|due to)\b/gi, ',')
  // 空断言清除（MiniMax H3 官方：keep consistent 类空断言无效且干扰模型——必须点出具体保留特征；
  // 具体特征由身份锁块 identityLockBlock 注入，此处仅删裸断言短语，避免与身份锁冲突）
  p = p.replace(/\bconsistent appearance\b/gi, '')
  p = p.replace(/\bunchanged outfit\b/gi, '')
  p = p.replace(/\bfixed facial features\b/gi, '')
  p = p.replace(/\bdo not change appearance\b/gi, '')
  p = p.replace(/\s*,\s*,\s*/g, ',')
  p = p.replace(/\s{2,}/g, ' ')
  return p.trim()
}

const SUMMON_RE =
  /\b(?:old man|old woman|elderly(?:\s+(?:face|man|woman|person))?|white stubble|gr[ae]y stubble|weathered face|white beard|gr[ae]y beard|automobiles?|vehicles?|cars?|suv|motorcycle|neon)\b/gi

/** 送进正向提示词前去掉会把概念召进画面的词。负向词只允许进有负向入口的工作流。 */
export function scrubSummoningTerms(text: string): string {
  return (text || '')
    .replace(SUMMON_RE, '')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,+/g, ',')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[,.\s]+|[,.\s]+$/g, '')
    .trim()
}

/** 正向里的中文会变成旁白。台词标记 <d>[Chinese]…</d> 保留。 */
export function keepDialogueChinese(text: string): string {
  return text.split(/(<d>\[Chinese\][\s\S]*?<\/d>)/g).map(part =>
    part.startsWith('<d>') ? part : part.replace(/[\u4e00-\u9fff]+/g, ' ').replace(/\s{2,}/g, ' ')
  ).join('')
}

/** 台词里的表演指示括号（（录音播放）（画外音）（冷笑）…）不是台词本体：
 *  TTS 会照读、字幕会照显示（实测成片出现「（录音播放）这瓶辣椒水…」）。
 *  只剥离开头连续的括号指示，句中括号（如「我（小声）说」）保留。 */
export function stripDialogueDirections(text: string): string {
  if (!text) return ''
  let s = text.trim()
  for (let i = 0; i < 4; i++) {
    const next = s.replace(/^[（(【[][^）)】\]]{0,20}[）)】\]][\s，,。:：]*/, '').trim()
    if (next === s) break
    s = next
  }
  return s
}

/** 声音拟音词剥离（t2i 文生图入口专用）：sceneEn/scenes[].en 允许含拟音词
 *  （rain hiss / distant echoes 等，视频渲染 soundscape 受益），但文生图模型对
 *  声音词无响应、只会稀释视觉权重，进图前统一剥除。 */
export function stripSoundCuesForImage(text: string): string {
  if (!text) return text
  return text
    .replace(/\b[\w-]+(?:\s+[\w-]+){0,2}\s+(?:hiss|hissing|rustle|rustling|echoes?|echoing|rumble|rumbling|murmur|buzz|buzzing|hum|humming|whirr|clatter|patter|drumming|sizzle)\b/gi, '')
    .replace(/\b(?:sound|sounds|soundscape|ambience|ambiance|ambient noise|background noise)\s+(?:of|from|like)\s+[^,;.]*/gi, '')
    .replace(/\s*,\s*,\s*/g, ',')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[,.\s]+|[,.\s]+$/g, '')
    .trim()
}

/** 英文双词人名（Su Tang / Lu Hanzhou）。LLM 写拼音名、项目存中文，名字匹配不可靠。 */
const ENGLISH_PERSON_NAME_RE = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g

/** 删掉英文双词人名，避免单人镜画出第二人。 */
export function stripEnglishCastNames(text: string): string {
  if (!text) return text
  return text
    .replace(ENGLISH_PERSON_NAME_RE, 'the subject')
    .replace(/\s*,\s*,\s*/g, ',')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * 把对戏肢体动作改成单人可拍的姿态。
 * 「撞上某人、抱腰、凑耳边」留在提示词里，图生图必画双人分身（成片镜6实测）。
 */
export function soloizeAction(text: string): string {
  if (!text) return text
  let t = text
  // 人名可能已先被换成 off-screen partner，所以 collides with / collides the partner 都要清
  t = t.replace(/\b(?:collides?|bumps?|crashes?)(?:\s+with)?(?:\s+(?:the\s+)?(?:off-screen\s+partner|subject))?\b[^,.;]*/gi, 'stands still')
  t = t.replace(/\b(?:leans?|leaning)\s+close(?:\s+to)?(?:\s+(?:the\s+)?(?:off-screen\s+partner|subject))?\b[^,.;]*/gi, 'leans slightly forward')
  t = t.replace(/\b(?:whispers?|whispering|speaks?|speaking|talks?|talking)\s+(?:into|to|in)\s+(?:his|her|their|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*|the\s+(?:off-screen\s+partner|subject))(?:'s)?\s*(?:ear)?\b[^,.;]*/gi, 'speaks softly')
  t = t.replace(/\b(?:(?:her|his|their)\s+)?(?:hands?\s+)?(?:gripping|grabs?|grabbing|holds?|holding|clutches?|clutching)\s+(?:his|her|their)\s+(?:waist|arm|shoulder|hand|collar)\b[^,.;]*/gi, 'hands held near the torso')
  t = t.replace(/\b(?:embraces?|embracing|hugs?|hugging|pulls?\s+(?:him|her|them)\s+(?:in|close)|pushes?\s+(?:him|her|them))\b[^,.;]*/gi, 'reaches one hand forward')
  t = t.replace(/\b(?:looking|looks)\s+up\s+(?:at|to)\s+(?:him|her|them|the\s+(?:subject|off-screen\s+partner))\b/gi, 'looking up')
  t = t.replace(/\bthe\s+off-screen\s+partner(?:\s*\([^)]*\))?/gi, '')
  t = t.replace(/\b(?:him|her|them)\b/gi, '')
  t = t.replace(/\bhands\s+hands\b/gi, 'hands')
  t = t.replace(/\s*,\s*,\s*/g, ',')
  t = t.replace(/\s{2,}/g, ' ')
  return t.replace(/^[,.\s]+|[,.\s]+$/g, '').trim()
}

/**
 * 按给定姓名表替换（中文名 + 拼音空格名）。主体名删成空主语，其余名改画外。
 */
export function maskCastNames(
  text: string,
  opts: { selfNames?: string[]; otherNames?: string[] }
): string {
  if (!text) return text
  let s = text
  const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const n of opts.otherNames || []) {
    if (!n?.trim()) continue
    s = s.replace(new RegExp(esc(n.trim()), 'gi'), 'the off-screen partner')
  }
  for (const n of opts.selfNames || []) {
    if (!n?.trim()) continue
    s = s.replace(new RegExp(`\\b${esc(n.trim())}\\b`, 'gi'), '')
  }
  return s.replace(/\s{2,}/g, ' ').replace(/\s*,\s*,/g, ',').trim()
}

/**
 * 单人居从句剥离（首帧图生与视频渲染共用）：删除提示词里"看向画外角色/与某角色对戏"
 * 的从句，防止模型把画外角色画进画面。
 * 不依赖角色名字匹配（LLM 输出英文名、项目存中文名，名字匹配不可靠），
 * 改为剥离典型对戏语法模式；保守删除——宁可少一条信息，不引第二人进画面。
 */
export function stripOtherPersonClauses(text: string): string {
  if (!text) return text
  let t = text
  // "X off-frame-left" / "off-frame X"（角色名 + 画外方位）。人名必须大写开头（LLM 用英文名），
  // 不能用 i 标志——否则 [A-Z] 会匹配小写（"from the reference image" 被误当人名替换）。
  t = t.replace(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+off-?frame(?:-left|-right)?\b/g, 'off-screen partner')
  // "off-screen X" / "off frame X"
  t = t.replace(/\boff-?screen\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g, 'off-screen partner')
  // ", eyes/gaze locked on X ..." 对视从句（删到标点）
  t = t.replace(/,\s*(?:eyes|gaze|glance|looks?|stare|staring|watching|meeting)\s+(?:locked\s+)?(?:on|at|toward|into|for|with)\s+[^,。;]+/g, '')
  // ", eyes searching X ..."（searching 直接接宾语，不接介词）
  t = t.replace(/,\s*eyes\s+searching\s+[^,。;]+/g, '')
  // ", looking/turning/glancing/nodding/facing (toward/at) X ..." 面向从句
  t = t.replace(/,\s*(?:looking|turning|glancing|nodding|facing)\s+(?:toward|towards|at|away from|past)\s+[^,。;]+/g, '')
  // 对坐结构整段剥离（须在最前面命中，先于下方介词替换——否则人名先被换成
  // "the off-screen partner"，from 消失后整段对坐结构就无法再匹配）：
  // "across the counter from crouching Lin Chuan" / "opposite the counter from him"——
  // 只替换人名会留下 "across the counter + partner"（两人隔着柜台对坐），实测模型必画双人；
  // 整段换成 "alone" 后画面只剩主体单人在柜台前。
  t = t.replace(/\b(?:across|opposite)\s+the\s+[\w ]+?\s+from\s+(?:crouching|standing|sitting|leaning|reacting|waiting|holding|watching|speaking|talking|staring|looking|facing|another|the other)?\s*(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*|him|her|them)\b/g, 'alone')
  // "opposite Su Wan"、"reacting to Lin Chuan"、"collides with Lu Hanzhou"、"close to Su Tang's ear"
  t = t.replace(/\b(?:from|across|opposite|beside|next to|behind|in front of|against|with|to|into|toward|towards|at)\s+(?:the\s+)?(?:crouching|standing|sitting|leaning|reacting|waiting|holding|watching|speaking|talking|staring|looking|facing|another|the other)?\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:'s)?/g, 'the off-screen partner')
  // "toward/at off-screen X" 独立对戏指向
  t = t.replace(/\b(?:toward|towards|at|to)\s+(?:the\s+)?off-?screen\s+[A-Za-z][^,。;]*/g, 'toward the off-screen partner')
  // 残留双词英文名一律去掉（对戏对象漏网时的兜底）
  t = stripEnglishCastNames(t)
  // 清理残留双逗号与多余空白
  t = t.replace(/\s*,\s*,\s*/g, ',')
  t = t.replace(/\s{2,}/g, ' ')
  return t.trim()
}

/** 录音回放 / 画外音：不该让本镜角色对口型念这段字。 */
export function isPlaybackOrVoiceoverAction(action?: string): boolean {
  return /plays?\s+a\s+recording|playback|录音|播放录音|画外音|voice-?over|vo\b/i.test(action || '')
}

/**
 * 场景户外暗示净化（模板路径兜底）：action 常残留剧本级户外声效描述
 * （如 "rain hiss continues outside"），室内场景镜会把模型往户外带、压过室内场景参考。
 * 仅当镜场景为室内语义（店/室/内/barber/shop/room 等）时启用；户外场景镜不做处理。
 */
export function stripOutdoorHints(text: string, scene: string): string {
  if (!text) return text
  const indoor = /店|室|内|barbershop|barber\s*shop|shop|store|room|office|home|kitchen|studio|hall|cafe|restaurant|garage|school|hospital/i.test(scene || '')
  if (!indoor) return text
  return text
    .replace(/\brain hiss continues outside\b/gi, 'rain hiss continues on the window')
    .replace(/\b(?:rain|wind|street|traffic|city)\s+sounds?\b/gi, 'rain sounds from the window')
    .replace(/\bon the street\b/gi, 'by the window')
    .replace(/\boutside\b/gi, 'through the window')
    .replace(/\boutdoor\b/gi, 'indoor')
}
