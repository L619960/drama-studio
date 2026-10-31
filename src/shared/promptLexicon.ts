/**
 * 提示词词表单一来源（P2-1）：室内/室外空间、皮肤瑕疵、发型、OOC 服装、时代流派、老年身份。
 * 只放词表与判定正则，不依赖任何业务模块（叶子节点）；negatives / scenePrompts / castAppearance /
 * promptDrift / promptStrips / promptAuditRules / promptSchema 统一引用，避免同一词表多处维护后漂移。
 */

/* ================= 室内 / 室外空间 ================= */

/** 室内空间线索（场景类型判定唯一来源；原 negatives 与 scenePrompts 各持一份且已漂移） */
export const INDOOR_SPACE_RE =
  /室内|室|房|厕|洗手间|卫生间|厅|店|办公室|办公|厨房|走廊|楼道|电梯|包间|包厢|卧室|浴室|大厅|前台|化妆间|车厢|车内|餐厅|酒吧|会所|会议室|\b(indoor|interior|inside|restroom|bathroom|toilet|lobby|office|room|suite|restaurant|bar|elevator|corridor|hallway|store|shop|kitchen)\b/i

/** 室外空间线索（与室内同时命中时按“混合”处理，不强行归类） */
export const OUTDOOR_SPACE_RE =
  /街|路|巷|广场|公园|海边|海滩|山|桥|天台|露台|工地|码头|停车场|院|小区|野外|郊外|田|河|湖|车站|站台|\b(outdoor|outdoors|street|road|alley|plaza|park|beach|rooftop|parking lot|dock|pier|field|forest)\b/i

/** 灯光兜底用的室内词：含 temple/inn 等题材词，语义比空间判定宽，故单独成表 */
export const INDOOR_LIGHTING_RE =
  /室内|房间|屋里|店内|办公|写字楼|楼内|厅内|hall|room|store|shop|office|apartment|interior|indoor|corridor|stairwell|temple|inn/i

/* ================= 皮肤瑕疵 ================= */

/** 病变/严重皮肤瑕疵：负向压制与定妆清洗共用。
 *  毛孔、细纹、胡茬、浅痣、肤色不匀属于真实皮肤纹理，刻意不在列（压制会得到塑料脸）。 */
export const SKIN_FLAW_TERMS = [
  'acne',
  'acne scars',
  'pockmarks',
  'rash',
  'sunburn',
  'peeling skin',
  'lumps',
  'bumps',
  'skin tags',
  'warts',
  'cysts',
  'tumors',
  'growths',
  'protrusions',
  'raised skin',
  'pimples',
  'dermatitis',
  'eczema',
  'skin disease',
  'greasy skin',
] as const

/** lookEn 清洗只删痤疮类会放大成病变的词；其余瑕疵只进负向，不动剧本已写好的外观描述 */
export const SKIN_FLAW_LOOK_RE = /\b(acne scars|acne|pockmarks?|pimples?|blemishes?|rash)\b/g

/* ================= 发型 ================= */

/** 发型名词：拆句/结构校验/趋同检测共用（bald 同属发型维度） */
export const HAIR_RE = /\b(hair|bun|ponytail|topknot|braid|bangs|fringe|bald|hairline)\b/i

/* ================= OOC 服装 ================= */

/** 高危 OOC 服装核心名词：体检「正负相冲」与锁感知负向共用。
 *  体检按纯子串匹配，故只放不会被常见词根误命中的名词（不放 tie 等短词）。 */
export const OOC_WARDROBE_CORE = [
  'apron',
  'vest',
  'hat',
  'cap',
  'necktie',
  'bow tie',
  'scarf',
  'gown',
  'blazer',
  'uniform',
  'overalls',
  'lab coat',
  'name tag',
  'waiter costume',
] as const

/** 负向压制额外覆盖的配饰/外套（锁感知：定妆已写明的词会自动跳过） */
export const OOC_WARDROBE_NEGATIVE_EXTRA = [
  'beanie',
  'hood',
  'tie',
  'shawl',
  'stole',
  'necklace',
  'pendant',
  'earrings',
  'bracelet',
  'watch',
  'glasses',
  'sunglasses',
  'purse',
  'handbag',
  'shoulder bag',
  'backpack',
  'suit jacket',
  'apron dress',
  'cardigan',
  'blouse',
  'turtleneck sweater',
] as const

/** 正向提示词清洗用的带颜色修饰匹配源（锁感知：定妆里已有的词保留） */
export const OOC_WARDROBE_STRIP_PATTERN_SOURCES = [
  '\\b(?:white|black|grey|gray|blue|green|red|beige|cream|striped|checked)?\\s*(?:barber\\s+apron|apron)\\b',
  '\\b(?:leather|denim|knitted)?\\s*vest\\b',
  '\\b(?:cowboy|baseball|flat|bowler|fedora|knit|wool|black|white)?\\s*hat\\b',
  '\\b(?:baseball|black|white)?\\s*cap\\b',
  '\\b(?:silk|black|white|red)?\\s*necktie\\b',
  '\\bbow\\s?tie\\b',
  '\\b(?:wool|silk|black|white)?\\s*scarf\\b',
  '\\b(?:evening|white|black|red|floor-?length|ball)?\\s*gown\\b',
  '\\bfloor-?length\\s+(?:dress|gown)\\b',
  '\\b(?:black|white|blue)?\\s*blazer\\b',
  '\\b(?:black\\s+)?(?:necktie|tie)\\b',
  '\\b(?:school|police|military|work)?\\s*uniform\\b',
  '\\boveralls?\\b',
  '\\blab\\s?coat\\b',
  '\\bname\\s?tag\\b',
] as const

/** 清洗命中词的前缀修饰（取核心名词判断定妆锁是否已包含） */
export const OOC_WARDROBE_PREFIX_RE =
  /^(?:white|black|grey|gray|blue|green|red|beige|cream|striped|checked|leather|denim|knitted|silk|wool|cowboy|baseball|flat|bowler|fedora|evening|school|police|military|work)\s*/gi

/* ================= 时代流派 ================= */

/** 流派级时代判定词（古装/年代）：定妆时代清洗、时代负向、时代锁共用 */
export const PERIOD_GENRE_TERMS = ['古装', '宫廷', '仙侠', '玄幻', '武侠', '穿越', '民国'] as const
export const PERIOD_GENRE_RE = /古装|宫廷|仙侠|玄幻|武侠|穿越|民国/

/** 民国题材单独走「1930 年代」时代锁，不套用古装汉服/武侠模板（词仍由流派词表派生的单一来源维护） */
export const REPUBLICAN_GENRE_RE = /民国/

/** 内容级时代线索（比流派判定宽：含年代/朝代/服化道词，用于提示词体检） */
export const PERIOD_CUE_RE = new RegExp(
  `${PERIOD_GENRE_TERMS.join('|')}|年代|古代|清朝|明朝|唐朝|宋朝|汉朝|晋朝|抗战|长袍|汉服|马褂|旗袍|官服|官府|衙门|客栈|酒楼|掌柜|轿子`,
  'i',
)

/* ================= 老年身份 ================= */

/** 定妆写明老年时，才允许提示词出现老年身份。 */
export const ELDERLY_LOOK_RE =
  /\b(?:60s|70s|80s|90s|elderly|senior|old man|old woman|in his (?:6|7|8|9)0s|in her (?:6|7|8|9)0s)\b/i

/** 身份漂移老年词源：调用方按需克隆为带 g 的正则，避免模块级 lastIndex 串扰。 */
export const ELDERLY_DRIFT_SOURCE =
  '\\b(old man|old woman|elderly(?: man| woman| person)?|senior citizen|weathered face|white stubble|gr[ae]y stubble|white beard|gr[ae]y beard|white hair|silver hair)\\b'

/** 非老年定妆的负向压制词（年龄漂移）。 */
export const ELDERLY_NEGATIVE_TERMS =
  'old man, old woman, elderly face, white stubble, grey stubble, white beard, age shift, different person'

/** 正向提示词里需剥离的“否定式老年召唤词”源（不含 \b，由调用方补边界）。 */
export const SUMMON_ELDERLY_SOURCE =
  'old man|old woman|elderly(?:\\s+(?:face|man|woman|person))?|white stubble|gr[ae]y stubble|weathered face|white beard|gr[ae]y beard'
