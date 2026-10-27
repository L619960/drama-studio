/**
 * 定妆外观/身份锁域：定妆皮肤清洗、发型/服装句抽取、身份硬锁块、OOC 服装清洗。
 * 依赖：promptUtils（joinParts）。
 */

import { joinParts } from './promptUtils'

const HAIR_CLAUSE_RE = /\b(hair|bun|ponytail|topknot|braid|bangs|fringe|bald|hairline)\b/i
const OUTFIT_CLAUSE_RE = /\b(robe|tunic|hanfu|outfit|uniform|belt|sash|hoodie|jacket|coat|cardigan|shirt|suit|dress|sweater|trousers|pants|jeans|skirt|cloak|armou?r|kimono)\b/i

/** 从定妆英文里拆出发型句和服装句。按逗号分句，避免只认得 shirt 而丢掉 robe。 */
export function extractAppearanceClauses(lookEn: string): { hair: string; outfit: string } {
  const clauses = sanitizeCastLook(lookEn).split(/[,;]/).map(s => s.trim()).filter(Boolean)
  const hair = clauses.filter(c => HAIR_CLAUSE_RE.test(c) && !OUTFIT_CLAUSE_RE.test(c))
  const outfit = clauses.filter(c => OUTFIT_CLAUSE_RE.test(c) && !HAIR_CLAUSE_RE.test(c))
  return { hair: hair.join(', '), outfit: outfit.join(', ') }
}

/** 从 lookEn 抽服装短语，供 STRICT 复读 */
export function extractOutfitLock(lookEn: string): string {
  return extractAppearanceClauses(lookEn).outfit
}

/**
 * 首帧图生图用的正向外观锁。只点名定妆里已有的发型和衣服。
 * 不列举帽子、马甲、围裙，点名这些词会把它们画出来。
 */
export function frameAppearanceLock(lookEn: string): string {
  const { hair, outfit } = extractAppearanceClauses(lookEn)
  const hairLine = hair ? `发型只允许与定妆相同：${hair}。` : '发型只允许与定妆图相同。'
  const outfitLine = outfit ? `服装只允许与定妆相同：${outfit}。` : '服装只允许与定妆图相同。'
  return `${hairLine}${outfitLine}衣物层次与定妆图相同，不新增层次。兵器保持定妆图中的普通金属外形。`
}

/** OOC 服装清洗（MiniMax H3 官方：删矛盾指令而非堆负向词）：
 *  LLM 拆镜常脑补职业装/服务装（理发师白围裙、领带、帽子、马甲、制服、实验服、工牌），
 *  与角色定妆 lookEn 冲突，视频渲染时模型会中途"挂上"这些服装造成漂移。
 *  删除 promptEn 中不属于定妆锁的高危服装名词（含颜色修饰），只保留 lookEn 已有的服装词。 */
export function stripOocWardrobe(prompt: string, lookEn: string): string {
  if (!prompt) return prompt
  const lock = (extractOutfitLock(lookEn) || '').toLowerCase()
  // 高危 OOC 服装名词（颜色+名词 或 名词本身），理发店/服务业脑补高频
  const patterns: RegExp[] = [
    /\b(?:white|black|grey|gray|blue|green|red|beige|cream|striped|checked)?\s*(?:barber\s+apron|apron)\b/gi,
    /\b(?:leather|denim|knitted)?\s*vest\b/gi,
    /\b(?:cowboy|baseball|flat|bowler|fedora|knit|wool|black|white)?\s*hat\b/gi,
    /\b(?:baseball|black|white)?\s*cap\b/gi,
    /\b(?:silk|black|white|red)?\s*necktie\b/gi,
    /\bbow\s?tie\b/gi,
    /\b(?:wool|silk|black|white)?\s*scarf\b/gi,
    /\b(?:evening|white|black|red|floor-?length|ball)?\s*gown\b/gi,
    /\bfloor-?length\s+(?:dress|gown)\b/gi,
    /\b(?:black|white|blue)?\s*blazer\b/gi,
    /\b(?:black\s+)?(?:necktie|tie)\b/gi,
    /\b(?:school|police|military|work)?\s*uniform\b/gi,
    /\boveralls?\b/gi,
    /\blab\s?coat\b/gi,
    /\bname\s?tag\b/gi
  ]
  let p = prompt
  for (const re of patterns) {
    // 仅当该服装词不在定妆锁中时才删除（lock 中已有同词则保留——identityLockBlock 会先锁定它）
    const lockedHits = new Set<string>()
    for (const m of lock.match(re) || []) lockedHits.add(m.toLowerCase())
    p = p.replace(re, (m) => {
      const w = m.toLowerCase()
      // 若该词（或其核心名词）已在定妆锁中，保留；否则删除
      const core = w.replace(/^(?:white|black|grey|gray|blue|green|red|beige|cream|striped|checked|leather|denim|knitted|silk|wool|cowboy|baseball|flat|bowler|fedora|evening|school|police|military|work)\s*/gi, '').trim()
      if (lockedHits.has(w) || lock.includes(core)) return m
      return ''
    })
  }
  p = p.replace(/\s*,\s*,\s*/g, ',')
  p = p.replace(/\s{2,}/g, ' ')
  return p.trim()
}

/**
 * 古装/年代剧 lookEn 时代清洗：LLM 的 lookEn 常混入现代服装词
 * （uniform/jacket/hoodie/jeans/suit/sweater/raincoat/work clothes 等），
 * 直接复读会把现代服化道锁进古装定妆三视图（实测：古装武侠剧角色定妆被画成
 * 黑色作战服/面罩、改良制服+街道灯）。古装剧在定妆生成前删除这些现代服装词。
 * 若清洗后仍残留高危现代形态（面罩/制服/战斗服）或词数过少，追加古装兜底描述，
 * 防止画成现代武士。
 */
export function stripModernWardrobe(lookEn: string): string {
  const t = (lookEn || '').trim()
  if (!t) return t
  const modern =
    /\b(?:leather\s+jacket|jacket|hoodie|sweater|cardigan|trench\s?coat|raincoat|windbreaker|blazer|suit|tie|necktie|bow\s?tie|uniform|work\s+clothes|overalls|lab\s?coat|jeans|denim|trousers|pants|shirt|t-shirt|sneakers|trainers|baseball\s?cap|flat\s?cap|fedora|sunglasses|briefcase|backpack|necklace|wristwatch|smartphone|headphones|tactical|combat|mask|hood|swat|army|katana|ninja|samurai|shinobi)\b/gi
  // 高危现代服化道核心词：只要命中过（删除前），无条件追加古装兜底——
  // 否则删词后残留（black katana / boots / dark alley）仍会被画成现代黑武士
  const removedHighRisk = /tactical|combat|uniform|mask|swat|army|hoodie|ninja|samurai|katana/i.test(t)
  const cleaned = t.replace(modern, ' ').replace(/\s{2,}/g, ' ').trim()
  // 高危现代形态仍残留（面罩/制服/战斗服/忍者/武士），或残留现代场景词（街道灯/沥青/霓虹/汽车/摩天楼），
  // 或清洗后太短：追加古装兜底（保证画出来是古装，不画成现代武士/现代街道）
  const stillModern =
    /\b(mask|uniform|combat|tactical|swat|army|ninja|samurai|katana)\b/i.test(cleaned) ||
    /\b(street\s?lamps?|streetlight|street\b|asphalt|neon|glass\s+building|skyscraper|car\b|vehicle|motorcycle|traffic|billboard|subway|elevator)\b/i.test(cleaned)
  const wordCount = cleaned.split(/\s+/).filter(Boolean).length
  if (!cleaned) {
    return 'chinese person, wearing traditional ancient chinese hanfu robes, classical hairstyle with hairpin, natural matte skin'
  }
  if (removedHighRisk || stillModern || wordCount < 8) {
    return `${cleaned}, wearing traditional ancient chinese hanfu robes, no modern clothing`
  }
  return cleaned
}

/** 判定流派是否属于「古风/年代」类：需要时代清洗与时代锁 */
export function isPeriodGenre(genre: string | undefined): boolean {
  const g = (genre || '').trim()
  return /古装|宫廷|仙侠|玄幻|武侠|穿越|民国/.test(g)
}

/**
 * 定妆皮肤清洗：LLM 的 lookEn 常混入 stubble/pores/acne/scar 等皮肤瑕疵词，
 * 直接复读会在 closeup 定妆被放大成麻子/疤/胡茬。清洗后保留发型/脸型/服装/痣等身份特征。
 * 注意：剧本明确要求的角色特征（beard/mustache 络腮胡/胡须、眉型、痣等身份锚点）
 * 必须保留——它们是角色差异化锚点（如劫匪络腮胡），不属于随机瑕疵；
 * 仅随机胡茬类（stubble / five o'clock shadow / unshaven）与皮肤瑕疵词被清洗。
 */
export function sanitizeCastLook(lookEn: string): string {
  const t = (lookEn || '').trim()
  if (!t) return t
  const skinNoise =
    /\b(stubble|five o.?clock shadow|unshaven|visible pores|pores|porous skin|rough skin|coarse skin|acne|acne scars|pockmarks|pockmark|blemishes|blemish|freckles|freckled|freckle|wrinkles|wrinkled|wrinkle|creases|skin texture|textured skin|imperfect skin|sun damaged|sun-damaged|scarred|scar|scars|scratches|rash|dry skin|flaky skin|blotchy|discolored skin|uneven skin|oily skin|greasy skin|moles?|mole|birthmark|lumps?|bumps?|skin tags?|warts?|cysts?|tumou?rs?|growths?|protrusions?|raised skin|pimple|pimples|spots?|marks? on (?:face|skin|forehead|cheek))\b/g
  return t.replace(skinNoise, ' ').replace(/\s{2,}/g, ' ').trim() || t
}

/** 身份硬锁块：脸/发/服必须逐字复用。只写要保留的发型和衣服，不点名要禁止的单品。 */
export function identityLockBlock(lookEn: string): string {
  const look = sanitizeCastLook(lookEn) || 'chinese person, natural everyday appearance'
  const { hair, outfit } = extractAppearanceClauses(look)
  return joinParts(
    'LOCKED IDENTITY (continuity bible — must match exactly across every shot)',
    look,
    hair ? `STRICT HAIR LOCK: ${hair}, same hairstyle as the reference image for the whole shot` : 'STRICT HAIR LOCK: same hairstyle as the reference image for the whole shot',
    outfit ? `STRICT OUTFIT LOCK: wear only ${outfit}, same garments as the reference image for the whole shot` : 'STRICT OUTFIT LOCK: same garments as the reference image for the whole shot',
    'same face identity, same hair length, same wardrobe layers from the first frame to the last frame'
  )
}

/* ================= 硬门禁 v2：lookEn 结构化校验（武器/结构/趋同） ================= */

/** 违禁武器词表：日式/弯刀/现代枪械/双持。命中即修正为中式单械。 */
const BANNED_WEAPON_RE =
  /\b(katana|wakizashi|nagamaki|ninjato|ninja\s*to|scimitar|saber|rapier|estoc|gun|pistol|rifle|revolver|submachine\s?gun|machine\s?gun|chainsaw|battle\s?axe|axe\b|dual\s+weapons?|two\s+weapons?|double\s+(?:swords?|blades?)|twin\s+(?:swords?|blades?)|paired\s+blades?|handguns?|firearm)\b/gi

/** 中式兵器允许词表（lookEn 出现其中之一即可视为「单械中式」形态） */
const CHINESE_WEAPON_RE =
  /\b(sword|blade|jian|dao|pudao|glaive|spear|staff|halberd|polearm|dagger|short\s+sword|long\s+sword|scabbard)\b/i

/** 外观结构完整性：发型/服装/面部特征缺项清单（缺项=LLM 角色设定不谨慎，需修正） */
export function lookEnStructureIssues(lookEn: string): string[] {
  const t = (lookEn || '').trim()
  if (!t) return ['lookEn 为空']
  const issues: string[] = []
  if (!/\b(hair|bun|ponytail|topknot|braid|bangs|fringe|hairline|bald)\b/i.test(t)) issues.push('缺发型条款')
  if (!/\b(robe|tunic|hanfu|outfit|uniform|belt|sash|jacket|coat|shirt|dress|skirt|cloak|armou?r|garb|clothing|attire)\b/i.test(t)) issues.push('缺服装条款')
  if (!/\b(face|round|oval|square|sharp|jaw|cheek|brow|brows|mustache|beard|stubble|eyes?|nose|features)\b/i.test(t)) issues.push('缺面部特征条款')
  return issues
}

/**
 * 武器硬门禁：lookEn 内武器必须「单把+中式」。
 * - 违禁（katana/枪械/双持）→ 删违禁词并追加「中式单械」锁；
 * - 无武器词 → 追加「一件中式兵器、单手空」；
 * - 已有中式武器词 → 补「exactly one weapon, one hand empty」。
 */
export function hardenLookWeapons(lookEn: string): string {
  const t = (lookEn || '').trim()
  if (!t) return t
  const hasBan = BANNED_WEAPON_RE.test(t)
  const hasChinese = CHINESE_WEAPON_RE.test(t)
  let clause: string
  if (hasBan) {
    clause = 'holding a single chinese straight jian sword, exactly one weapon, one hand empty, NO katana, NO curved japanese blade'
  } else if (!hasChinese) {
    clause = 'carrying one traditional chinese weapon, exactly one weapon, one hand empty'
  } else {
    clause = 'exactly one weapon, one hand empty'
  }
  const cleaned = t.replace(BANNED_WEAPON_RE, ' ').replace(/\s{2,}/g, ' ').trim()
  const joined = cleaned ? `${cleaned}, ${clause}` : clause
  return joined.replace(/,\s*,/g, ',').trim()
}

/** 三角色趋同检测：色系/发型/脸型三个维度两两对比，重复维度≥2 判定趋同，给后角追加差异化条款。 */
export function differentiateLooks(looks: string[]): { looks: string[]; notes: string[] } {
  const notes: string[] = []
  if (looks.length <= 1) return { looks, notes }
  const colorRe = /#?[0-9a-fA-F]{6}|\b(black|white|grey|gray|brown|tan|beige|ivory|navy|blue|dark blue|deep blue|indigo|teal|green|olive|red|crimson|scarlet|purple|violet|lavender|pink|rose|orange|amber|gold|golden|silver|rust|maroon|claret|ochre|mustard|emerald|jade|cyan|azure|charcoal|slate|oxblood|mauve|plum|wine)\b/i
  const hairRe = /\b(hair|bun|ponytail|topknot|braid|bangs|fringe|hairline)\b/i
  const faceRe = /\b(round\s+face|oval\s+face|square\s+face|long\s+face|sharp\s+jaw|square\s+jaw|high\s+cheekbones|broad\s+cheekbones|narrow\s+face|round\s+cheeks|almond\s+eyes|deep\s+set\s+eyes|wide\s+eyes|narrow\s+eyes|arched\s+brows|straight\s+brows|thick\s+brows|thin\s+lips|full\s+lips|aquiline\s+nose|flat\s+nose|mustache|beard|goatee|stubble|mole|scar)\b/i
  const seen = looks.map((l, i) => ({
    color: (l.match(colorRe) || []).slice(0, 3),
    hair: hairRe.test(l) ? (l.match(/[a-z]+(?: hair| bun| ponytail| topknot| braid| bangs| fringe)/i)?.[0] || 'hair') : '',
    face: faceRe.test(l) ? (l.match(faceRe)?.[0] || 'face') : ''
  }))
  const out = [...looks]
  for (let i = 1; i < out.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = seen[j]
      const b = seen[i]
      let same = 0
      if (a.color.some(c => b.color.includes(c))) same++
      if (a.hair && a.hair === b.hair) same++
      if (a.face && a.face === b.face) same++
      if (same >= 2) {
        const tag = i % 3 === 1
          ? 'distinctly different face shape and hairstyle and clothing color from the other characters, unique appearance'
          : 'completely different face, different hairstyle, different outfit color from all other characters, visually distinct'
        if (!new RegExp('distinct|different (?:face|hair|outfit)', 'i').test(out[i])) {
          out[i] = `${out[i].replace(/,\s*$/,'')}, ${tag}`
          notes.push(`角色 ${i + 1} 与角色 ${j + 1} 外观趋同（${same} 维相同），已追加差异化条款`)
        }
      }
    }
  }
  return { looks: out, notes }
}

/**
 * lookEn 硬门禁总入口（casting 建档前对全角色执行）：
 * 武器单械中式 + 结构缺项记录 + 三角色趋同差异化。
 * 返回修正后的 lookEn 列表与留痕 notes（notes 写入日志，修正后的 lookEn 落档建档）。
 */
export function hardenLookEnList(looks: string[], genre?: string): { looks: string[]; notes: string[] } {
  const notes: string[] = []
  const period = isPeriodGenre(genre)
  let prepared = looks.map((l, i) => {
    // 武器硬门禁仅对古装/武侠等动作题材生效——现代剧（医生/白领/学生）无武器，
    // 否则会被强加 "carrying one traditional chinese weapon" 把现代职业角色画成持剑人
    const hardened = period ? hardenLookWeapons(l) : l
    const issues = lookEnStructureIssues(hardened)
    if (issues.length) notes.push(`角色 ${i + 1} lookEn 结构缺项：${issues.join('、')}（已尽力保留原文建档，首帧/渲染由 lookEn 锁+抽帧验收兜底）`)
    return hardened
  })
  if (period) prepared = prepared.map(l => stripModernWardrobe(l))
  const diff = differentiateLooks(prepared)
  notes.push(...diff.notes)
  return { looks: diff.looks, notes }
}
