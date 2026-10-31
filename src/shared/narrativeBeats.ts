/**
 * 叙事节拍与关键道具：拆镜后本地校验 + 画面提示词注入。
 * 对应审片高频问题：道具失踪、入画缺反应、上车链断裂、结局空镜无车辆。
 */

export interface NarrativeShotLike {
  index?: number | undefined
  scene?: string | undefined
  action: string
  dialogue?: string | undefined
  type: 'i2v' | 't2v'
  characterName?: string | undefined
  shotSize?: string | undefined
}

const PROP_LEXICON: Array<{ keys: RegExp; en: string[]; label: string }> = [
  {
    keys: /伞|雨伞|umbrella/i,
    en: ['umbrella', 'umbrella handle', 'black umbrella', 'clear umbrella'],
    label: '伞',
  },
  {
    keys: /车|轿车|迈巴赫|car|sedan|vehicle/i,
    en: ['car', 'sedan', 'car door', 'taillights', 'passenger seat'],
    label: '车',
  },
  {
    // 「西装内袋」「口袋」是服装结构不是道具，必须排除（否则剧本提内袋就误报道具失踪）
    keys: /(?<!内|口|衣|裤)袋|纸袋|购物袋|手提袋|\bbag\b/i,
    en: ['shopping bag', 'paper bag', 'tote bag'],
    label: '袋',
  },
  {
    keys: /手机|电话|\bphones?\b|\bsmartphones?\b/i,
    en: ['phone', 'mobile phone', 'smartphone'],
    label: '手机',
  },
  {
    keys: /合同|文件|信|请柬|contract|letter|envelope/i,
    en: ['contract', 'document', 'envelope', 'letter'],
    label: '文件',
  },
  {
    keys: /钥匙|\bkeys?\b/i,
    en: ['key', 'brass key', 'keyring'],
    label: '钥匙',
  },
  {
    keys: /药|药丸|药瓶|medicine|pill/i,
    en: ['pill', 'medicine bottle', 'pill bottle'],
    label: '药',
  },
]

/** 从片名/梗概/剧本抽关键道具（中文标签） */
export function extractKeyProps(...texts: string[]): string[] {
  const blob = texts.join('\n')
  const hits: string[] = []
  for (const p of PROP_LEXICON) {
    if (p.keys.test(blob)) hits.push(p.label)
  }
  return hits
}

/** 动作文案是否提及某英文道具词 */
function actionMentionsProp(action: string, en: string[]): boolean {
  const a = action.toLowerCase()
  return en.some((w) => a.includes(w.toLowerCase()))
}

/**
 * 从 action 抽道具锁定短语，写入首帧/视频提示，避免「写了伞、画面没伞」。
 */
export function propLockFromAction(action: string): string {
  const a = action.toLowerCase()
  const locks: string[] = []
  if (/umbrella/.test(a)) {
    locks.push(
      'KEY PROP ON SCREEN: black or clear umbrella (or curved umbrella handle) must be clearly visible and sharp',
      'do not omit the umbrella — hands gripping umbrella handle if mentioned',
    )
  }
  if (/shopping bag|paper bag|tote/.test(a)) {
    locks.push('KEY PROP ON SCREEN: shopping bag must stay visible in hands or on lap')
  }
  if (/phone|smartphone/.test(a)) locks.push('KEY PROP ON SCREEN: mobile phone must stay visible in the hand')
  if (/keyring|brass key|\bkey\b/.test(a)) locks.push('KEY PROP ON SCREEN: the key must stay visible and sharp')
  if (/envelope|contract|document|letter/.test(a))
    locks.push('KEY PROP ON SCREEN: the document or envelope must stay readable in frame')
  if (/pill|medicine bottle/.test(a)) locks.push('KEY PROP ON SCREEN: the medicine bottle or pill must stay visible')
  if (/car door|passenger seat|taillight|sedan|black car/.test(a)) {
    locks.push('KEY PROP ON SCREEN: vehicle or car door must be readable in frame')
  }
  return locks.join(', ')
}

export interface NarrativeEnforceOptions {
  enforcePropLock?: boolean
  enforceReactionBeats?: boolean
  enforceBoardingChain?: boolean
}

/**
 * 拆镜结果本地叙事校验 → warnings（不阻断，供 UI/复审强化）。
 */
export function validateNarrativeContinuity(
  title: string,
  logline: string | undefined,
  scriptHint: string,
  shots: NarrativeShotLike[],
  enforce: NarrativeEnforceOptions = {},
): string[] {
  const warnings: string[] = []
  if (!shots.length) return warnings
  const propOn = enforce.enforcePropLock !== false
  const reactionOn = enforce.enforceReactionBeats !== false
  const boardOn = enforce.enforceBoardingChain !== false

  // 台词落镜铁律（本地兜底校验）：剧本每一对引号内台词必须出现在某个镜头 dialogue 中。
  // LLM 偶发漏句（如把出门台词留在动作里），本地可稳定检出并提示。
  const quoted = (scriptHint.match(/[「""]([^」""]+)[」""]/g) || [])
    .map((s) => s.replace(/[「」""]/g, '').trim())
    .filter(Boolean)
  if (quoted.length > 0) {
    const dialogs = shots.map((s) => (s.dialogue || '').trim()).filter(Boolean)
    const missing = quoted.filter((q) => !dialogs.some((d) => d.includes(q) || q.includes(d)))
    if (missing.length > 0) {
      warnings.push(`台词未落镜：${missing.join('；')}——需补入相关镜头 dialogue（短回应也不可丢）`)
    }
  }

  if (propOn) {
    const props = extractKeyProps(title, logline || '', scriptHint)
    for (const prop of props) {
      const lex = PROP_LEXICON.find((p) => p.label === prop)
      if (!lex) continue
      const covered = shots.some((s) => actionMentionsProp(s.action, lex.en))
      const closeupCovered = shots.some(
        (s) =>
          s.shotSize === 'closeup' && actionMentionsProp(s.action, lex.en) && (s.type === 'i2v' || s.type === 't2v'),
      )
      if (!covered) {
        warnings.push(`关键道具「${prop}」未写入任何镜头 action，易与片名/梗概脱节`)
      } else if (prop === '伞' && !closeupCovered) {
        warnings.push('关键道具「伞」缺少 closeup 交接特写（递伞/接伞手柄），成片易看不见伞')
      }
    }
  }

  // 入画：t2v/wide 引入对方后，下一镜若直接是等待方台词，缺反应镜
  if (reactionOn) {
    for (let i = 0; i < shots.length - 1; i++) {
      const cur = shots[i]
      const next = shots[i + 1]
      if (!cur || !next) continue
      const intro =
        cur.type === 't2v' && /approach|cross|walk|toward|arrive|figure|umbrella figure|走近|走来/i.test(cur.action)
      const jumpDialogue =
        next.type === 'i2v' &&
        Boolean(next.dialogue?.trim()) &&
        !/look|gaze|turn|notice|react|see|eyeline|看见|回头/i.test(next.action)
      if (intro && jumpDialogue) {
        const idx = next.index ?? i + 2
        warnings.push(`第${idx}镜在对方入画空镜后直接开口，建议前插等待方「看见/视线」无台词反应镜`)
      }
    }
  }

  // 上车链：有开门镜后应有坐进车内；结局应有车辆驶离而非纯街道空镜
  if (boardOn) {
    const openDoor = shots.findIndex((s) =>
      /open(s|ing)? (the )?(car )?door|passenger door|拉开.*车门|开车门/i.test(s.action),
    )
    if (openDoor >= 0) {
      const after = shots.slice(openDoor + 1)
      const seated = after.some((s) => /seat|sit|seated|inside the car|passenger|坐进|车内/i.test(s.action))
      if (!seated) {
        warnings.push('有开车门镜头但缺少「坐进车内」完成态镜头，上车过程易跳跃')
      }
    }

    const last = shots[shots.length - 1]
    const scriptHasLeave = /驶离|离开|驱车|drive away|drives away|receding/i.test(
      `${title}\n${logline || ''}\n${scriptHint}`,
    )
    if (scriptHasLeave && last) {
      const leaveOk =
        /taillight|receding|drives away|drive away|pulls away|驶离|车尾/i.test(last.action) &&
        /car|sedan|vehicle|轿车|车/i.test(last.action)
      if (!leaveOk) {
        warnings.push('结局镜未明确呈现车辆驶离（车尾灯远离镜头），纯街道空镜收束叙事不完整')
      }
    }
  }

  const handoff = /hand(?:s|ing)? over|\bpass(?:es|ing)?\b|\bhug\b|\bslap\b|递|扇耳光|拥抱|开车门|拉开车门/i
  const secondBeat = /walks? away|turns? and leaves|sits? down|drives? away|speaks?|开口|说道/i
  for (const s of shots) {
    if (handoff.test(s.action) && secondBeat.test(s.action)) {
      const idx = s.index ?? 0
      warnings.push(`第${idx}镜同时写了交接和另一个动作，递接、耳光、拥抱、上车应独占一镜`)
    }
  }

  return warnings
}
