/**
 * 镜头/场景/定妆提示组装域：面部定妆、三视图、全景/空场景板、首尾帧、图生视频动作提示、
 * 景别 cue、时间轴协议块、表情锁、朝代锁。
 * 依赖：promptConstants、promptUtils、castAppearance、motion、promptDrift、negatives、
 *       promptStrips，以及外部 narrativeBeats（propLockFromAction）。
 */

import { CINEMATIC_QUALITY_BLOCK, REALISM_POSITIVE, SHOT_SIZE_CUE } from './promptConstants'
import { joinParts } from './promptUtils'
import { sanitizeCastLook, identityLockBlock, stripModernWardrobe, isPeriodGenre } from './castAppearance'
import { motionCueFromAction } from './motion'
import { ageLockFor } from './promptDrift'
import { realismPositiveExtra } from './negatives'
import { stripSoundCuesForImage } from './promptStrips'
import { propLockFromAction } from './narrativeBeats'

/**
 * 时代锁块（题材级）：古风/年代剧必须在每张定妆图/场景板/全景图提示词中显式锁定时代
 * 与「禁止现代元素」，否则 LLM/H3 会把现代服化道混进古装剧（实测：古装武侠剧角色定妆
 * 被画成黑色作战服+面罩、改良制服+雨夜街道灯——根因即定妆生成路径缺时代锁）。
 */
export function eraLockBlock(genre: string | undefined): string {
  const g = (genre || '').trim()
  if (/民国/.test(g)) {
    return 'period-accurate 1930s republican-era chinese setting: qipao, changshan, vintage decor, ' +
      'no ancient hanfu, no modern street wear, no modern buildings, no cars, no neon signs'
  }
  if (isPeriodGenre(g)) {
    return 'period-accurate ancient chinese costume drama, chinese wuxia martial-arts style ONLY, NOT Japanese, NOT modern: ' +
      'loose hanfu robe with cloth belt, classical chinese hairstyles with hairpins or topknots, ancient chinese architecture of wood and stone, lantern or torch lighting, ' +
      'weapons are chinese-style only: a single jian sword, dao blade, pudao, or spear — exactly ONE weapon in hand, no second weapon, no Japanese katana, no ninja weapons, ' +
      'facial covering if any is an ancient chinese cloth veil wrapped around the LOWER HALF of the face only, from nose down to chin, forehead, eyebrows, hairline and hair bun fully visible and unobstructed, never covering the upper face, never a full-face wrap, never only eyes visible, ' +
      'no modern clothing, no uniforms, no street lights, no asphalt, no glass buildings, no cars, no electronics, no neon signs, no billboards, ' +
      'no katana, no gun, no military uniform, no face mask, no tactical gear, no ninja, no samurai, no Japanese armor'
  }
  if (g) {
    return 'modern contemporary setting, current-era clothing and props consistent with the script, no historical costumes'
  }
  return ''
}

/** 按流派清洗定妆 lookEn：古风/年代剧删现代服装词，其余保留原样 */
export function castLookForGenre(lookEn: string, genre: string | undefined): string {
  return isPeriodGenre(genre) ? stripModernWardrobe(lookEn) : lookEn
}

/** 景别 → 提示词 cue（未知值回退中景；供 videoMotionPrompt/shotFramePrompt 共用） */
export function shotSizeCueFor(shotSize?: string): string {
  if (shotSize && SHOT_SIZE_CUE[shotSize.toLowerCase()]) return SHOT_SIZE_CUE[shotSize.toLowerCase()]
  return SHOT_SIZE_CUE.medium
}

/**
 * 室内/室外锁：中文场景名直接进英文提示词时，模型常把室内写成街景
 * （实测「男厕所」被画成雨夜户外小便所）。这里按关键词显式声明 interior/exterior，
 * 让场景板/首帧的取景落在正确的空间类型上。
 */
const INDOOR_SCENE_RE =
  /室内|室|房|厕|洗手间|卫生间|厅|店|办公室|办公|厨房|走廊|楼道|电梯|包间|包厢|卧室|浴室|大厅|前台|化妆间|车厢|车内|餐厅|酒吧|会所|会议室|\b(indoor|interior|inside|restroom|bathroom|toilet|lobby|office|room|suite|restaurant|bar|elevator|corridor|hallway|store|shop|kitchen)\b/i
const OUTDOOR_SCENE_RE =
  /街|路|巷|广场|公园|海边|海滩|山|桥|天台|露台|工地|码头|停车场|院|小区|野外|郊外|田|河|湖|车站|站台|\b(outdoor|outdoors|street|road|alley|plaza|park|beach|rooftop|parking lot|dock|pier|field|forest)\b/i

/** 场景是否为「室内空间」：全景分支需据此换掉 360° 环绕描述（见 panoramaScenePrompt） */
export function sceneIsIndoor(scene: string): boolean {
  const s = (scene || '').trim()
  if (!s) return false
  return INDOOR_SCENE_RE.test(s) && !OUTDOOR_SCENE_RE.test(s)
}

export function interiorCueFor(scene: string): string {
  const s = (scene || '').trim()
  if (!s) return ''
  if (/\binterior\b/i.test(s)) return ''
  const indoor = INDOOR_SCENE_RE.test(s)
  const outdoor = OUTDOOR_SCENE_RE.test(s)
  // 室内：必须把「四面墙+顶棚包围、无室外视野」写死，否则模型会把室内写成临街公厕/街景
  if (indoor && !outdoor) {
    return 'fully enclosed interior set, interior walls and ceiling surround the camera on every side, ' +
      'no exterior view, no street, no sky, no outdoor area visible'
  }
  if (outdoor && !indoor) return 'exterior location, open air outdoor setting'
  return ''
}

/** 面部定妆：头肩特写，锁 lookEn（古风/年代剧注入时代锁，杜绝现代服化道） */
export function faceCastingPrompt(
  lookEn: string,
  opts?: { realismLock?: 'standard' | 'strong'; genre?: string }
): string {
  const look = castLookForGenre(lookEn.trim(), opts?.genre) || 'chinese person, natural everyday appearance'
  const lock = opts?.realismLock || 'standard'
  return joinParts(
    'plain solid medium-grey painted wall background, passport ID photo style, mugshot, flat grey screen backdrop, even flat front lighting',
    'photorealistic casting headshot for live-action chinese short drama',
    'tight head-and-shoulders close-up, chest-up framing, front-facing, clear ocular landmarks and ear silhouette',
    eraLockBlock(opts?.genre),
    'healthy natural east-asian complexion, clean even skin tone, smooth supple skin with soft subtle pores, natural skin glow, no blemishes, no scars, no pockmarks, smooth flat forehead, perfectly clear skin surface',
    identityLockBlock(look),
    realismPositiveExtra(lock),
    'neutral expression, natural everyday look, matte skin finish, minimal makeup',
    'isolated single subject centered in frame, grey wall fills 100% of background behind head and shoulders',
    'clean studio casting photography, sharp focus, high detail, neutral color grading, no film grain',
    'production still quality, continuity reference plate'
  )
}

/** 全身标准三视图：同一人三面板（正面/侧面/背面），锁 lookEn（古风/年代剧注入时代锁） */
export function bodySheetPrompt(
  lookEn: string,
  opts?: { realismLock?: 'standard' | 'strong'; genre?: string }
): string {
  const look = castLookForGenre(lookEn.trim(), opts?.genre) || 'chinese person, natural everyday appearance'
  const lock = opts?.realismLock || 'standard'
  return joinParts(
    'plain solid medium-grey painted wall background, passport ID photo style, flat grey screen backdrop, even flat front lighting',
    'photorealistic character turnaround reference sheet for live-action casting department',
    'exactly three equal panels of the SAME person side by side: full front view, full side profile view, full back view — orthogonal 90-degree rotations',
    eraLockBlock(opts?.genre),
    'identical face identity hairstyle and full-body outfit across all three panels',
    'each panel: full body visible head to toe, standing straight, neutral stance, arms relaxed at sides, accurate proportions, realistic clothing folds',
    'even spacing between panels, grey wall fills 100% of frame',
    'healthy natural east-asian complexion, clean even skin tone, no blemishes, no scars, no pockmarks',
    identityLockBlock(look),
    realismPositiveExtra(lock),
    'clean studio casting photography, soft even lighting, sharp focus, high detail, neutral color grading, no film grain',
    'wardrobe continuity bible plate'
  )
}

/** 360° 全景场景图（青橙Lab「全景固定场景」方案落地）：
 *  2:1 宽幅无缝全景，同一场景所有镜头从这张全景裁出的方位图取景，
 *  场景不再随镜漂移。宽高比须与裁切方位图的分段数匹配（2:1 裁 4 段=每段 90°）。 */
export function panoramaScenePrompt(
  scene: string,
  mood?: string,
  opts?: { weatherHint?: 'auto' | 'rainy' | 'clear'; genre?: string }
): string {
  const weather =
    opts?.weatherHint === 'rainy'
      ? 'heavy rain night, wet reflective ground with mirror-like reflections, rain streaks'
      : opts?.weatherHint === 'clear'
        ? 'clear dry weather, soft daylight or warm practical lamps'
        : ''
  // 室内不能要求 360° 环绕：2:1 画幅两端会各露出一个「室外开口」
  // （实测男厕所全景左右两端各画出一条雨夜街道 + 汽车），裁出的方位图全部被污染。
  // 室内改用「正面广角 + 两端是实墙」的正投影描述，裁切后每段都是同一间房的不同朝向。
  const indoor = sceneIsIndoor(scene)
  return joinParts(
    indoor
      ? 'photorealistic ultra-wide rectilinear interior photograph from live-action chinese short drama, 2:1 horizontal frame'
      : 'photorealistic 360-degree seamless panorama from live-action chinese short drama, 2:1 ultra-wide horizontal wrap-around',
    indoor
      ? 'camera facing the principal wall of the room, real interior architecture fills the frame edge to edge, solid walls and ceiling at the left and right ends, no opening to the outside'
      : 'single continuous locked set seen from all directions, left and right edges visually connect (wrap-around continuity)',
    stripSoundCuesForImage(scene),
    interiorCueFor(scene),
    mood ? `${mood} atmosphere, motivated practical lights` : 'motivated practical lights',
    eraLockBlock(opts?.genre),
    weather,
    // 空镜人物压制必须走负向通道：正向写 "no people" 会被 CLIP 当概念召唤
    // （实测男厕所全景里出现两个骑车路人）。这里只写「要什么」。
    'uninhabited deserted location, purely architectural and furnishing detail, empty floor',
    'LOCKED LOCATION for the whole episode, every direction is the same physical place, consistent lighting direction across the wrap',
    indoor
      ? 'even exposure across the full frame, no vignette, no seam, no perspective distortion'
      : 'even exposure across the full panorama, no vignette, no seam, no distortion at edges',
    opts?.weatherHint === 'rainy'
      ? 'real-world materials, wet ground with mirror-like reflections'
      : 'real-world materials, dry clean ground, natural surface wear',
    'period-accurate materials and objects that belong to the story era',
    'natural atmospheric haze, documentary location photography, subtle grain',
    'no CGI, no illustration, no beauty filter'
  )
}

/** 无人空场景板（古风/年代剧注入时代锁） */
export function scenePlatePrompt(
  scene: string,
  mood?: string,
  opts?: { weatherHint?: 'auto' | 'rainy' | 'clear'; emptyStrict?: boolean; genre?: string }
): string {
  const weather =
    opts?.weatherHint === 'rainy'
      ? 'heavy rain night, wet reflective ground with mirror-like reflections, rain streaks'
      : opts?.weatherHint === 'clear'
        ? 'clear dry weather, soft daylight or warm practical lamps'
        : ''
  const empty =
    opts?.emptyStrict === false
      ? 'location plate, minimal distant silhouettes allowed only if tiny and unrecognizable'
      // 同全景：人物压制走负向，正向只写「无人使用中的场地」
      : 'uninhabited deserted location, purely architectural and furnishing detail, empty floor'
  return joinParts(
    'photorealistic vertical empty establishing plate from live-action chinese short drama',
    'production design location plate, locked set for episode continuity',
    stripSoundCuesForImage(scene),
    interiorCueFor(scene),
    mood ? `${mood} atmosphere, motivated practical lights` : 'motivated practical lights',
    eraLockBlock(opts?.genre),
    weather,
    empty,
    'LOCKED LOCATION for the whole episode, do not invent a different place',
    opts?.weatherHint === 'rainy'
      ? 'real-world materials, wet ground with mirror-like reflections'
      : 'real-world materials, dry clean ground, natural surface wear',
    'period-accurate materials and objects that belong to the story era',
    'natural atmospheric haze, documentary location photography, subtle grain',
    'no CGI, no illustration, no beauty filter'
  )
}

/** 镜头首帧 / 尾帧 */
export function shotFramePrompt(opts: {
  phase: 'start' | 'end'
  lookEn: string
  scene: string
  action: string
  shotSizeCue?: string
  emotion?: string
  continuity?: string
  camera?: string
  lighting?: string
  facing?: string
  /** 画面人物数量（1=单人，2=双人，N=多人）；缺省 1。防止多人镜被强制画成单人 */
  characterCount?: number
  /** 关键道具（英文名词数组）：画面必须出现且不得替换/变形/消失 */
  props?: string[]
}): string {
  const phaseLabel = opts.phase === 'start'
    ? 'START KEYFRAME — beginning of the beat, holdable still for I2V'
    : 'END KEYFRAME — terminal pose after the beat, continuity handoff'
  const people = (() => {
    const n = Math.max(1, Math.floor(opts.characterCount ?? 1))
    if (n <= 1) return 'single person only, no other faces, no extra people'
    return `exactly ${n} people in frame, no extra people, no background crowd`
  })()
  const propCue = opts.props?.length
    ? (() => {
        const a = (opts.action || '').toLowerCase()
        const parts: string[] = []
        for (const p of opts.props) {
          const prop = p.toLowerCase()
          // action 说"放下/放在地上" → 道具在地上，主角空手
          if (/(place|put|lay|drop|set|leave).{0,40}(on the|on the ground|on the floor|down)/.test(a) && a.includes(prop)) {
            parts.push(`${p} is placed on the wet ground/floor, NOT in anyone's hand; the subject's hands are empty`)
          }
          // action 说"拿着/握着" → 道具在主角手里
          else if (/(hold|grip|clutch|carry|hold on|holding|gripping|clutching|carrying|reaching for|grabbing|takes|taking)/.test(a) && a.includes(prop)) {
            parts.push(`${p} is held in the subject's hand exactly as the action describes`)
          }
          // action 没提这个道具 → 主角空手，不要自动塞给他
          else {
            parts.push(`the subject must NOT be holding ${p} — if ${p} appears at all, it must be in the other character's hand or in the background, NOT in the subject's hands`)
          }
        }
        return `KEY PROPS: ${parts.join('; ')}. Do not swap, reshape, or magically hand props to the wrong person.`
      })()
    : ''
  return joinParts(
    `photorealistic vertical ${phaseLabel} from live-action chinese short drama`,
    opts.shotSizeCue,
    identityLockBlock(opts.lookEn),
    `LOCKED LOCATION: ${stripSoundCuesForImage(opts.scene)}`,
    interiorCueFor(opts.scene),
    'stay at the LOCKED LOCATION above, do not switch to any other place or interior',
    opts.lighting
      ? `LIGHTING LOCK: ${opts.lighting}, same key direction and color temperature as the video shot`
      : '',
    opts.facing
      ? `BLOCKING LOCK: ${opts.facing}, same screen position and facing as the video shot`
      : '',
    opts.continuity,
    opts.camera
      ? `camera direction: ${opts.camera}, motivated move only, no whip-pan`
      : 'camera: static eye-level, stable tripod',
    opts.emotion
      ? `performance: ${opts.emotion}, nuanced micro-expression, natural minimal makeup`
      : '',
    opts.phase === 'start'
      ? `action onset: ${opts.action}`
      : `action resolve: ${opts.action}, same person identity and outfit as start frame`,
    propLockFromAction(opts.action),
    propCue,
    'wardrobe lock: wear EXACTLY the outfit described in the locked identity above — same garments, same layers, same collar, same accessories; ' +
      'do not add, remove, or substitute any garment or accessory',
    'matte natural skin, realistic fabric, practical location lighting',
    people,
    'cinematic color grade restrained, short-drama production still',
    CINEMATIC_QUALITY_BLOCK,
    REALISM_POSITIVE
  )
}

/**
 * 图生视频动作提示：身份/服装必须压过题材风格词。
 * 结构：IDENTITY → LOCATION → LIGHTING → BLOCKING → CONTINUITY → CAMERA → PERFORMANCE → ACTION
 */
export function videoMotionPrompt(opts: {
  action: string
  lookEn?: string
  scene?: string
  emotion?: string
  camera?: string
  dialogue?: string
  genreStyle?: string
  /** 景别（closeup/medium/wide）：注入电影工业景别与焦段/景深 */
  shotSize?: string
  /** 光线条件（时刻+主光方向）：锁定全剧光源一致，防光影漂移 */
  lighting?: string
  /** 人物朝向与画面位置：锁定跨镜站位，防瞬移 */
  facing?: string
  /** 动作起点承接：衔接上一镜结尾状态，防动作过程断裂 */
  continuity?: string
}): string {
  const cue = motionCueFromAction(opts.action)
  return joinParts(
    opts.lookEn ? identityLockBlock(opts.lookEn) : '',
    opts.scene
      ? `LOCKED LOCATION: ${/[\u4e00-\u9fff]/.test(opts.scene) ? 'the place shown in the reference image' : opts.scene}`
      : '',
    opts.shotSize ? shotSizeCueFor(opts.shotSize) : '',
    // 光线锁定：全剧同一场景相邻镜保持同光源方向；有分镜光线则落地，无则用电影级动机光
    opts.lighting
      ? `LIGHTING LOCK: ${opts.lighting}, same key direction and color temperature across adjacent shots, no mid-clip light change`
      : 'motivated cinematic lighting, single consistent key direction, scene-matched color temperature, no mid-clip light change',
    opts.genreStyle
      ? `look development (lighting/grade only): ${opts.genreStyle}`
      : 'cinematic motivated lighting, restrained grade',
    'animate the reference image only — preserve identical face, hair length, outfit silhouette and fabric every frame',
    'do not redesign the character, do not change wardrobe mid-clip',
    // 朝向与站位锁定：防人物跨镜瞬移/转身漂移
    opts.facing
      ? `BLOCKING LOCK: ${opts.facing}, stay in the same screen position and facing direction for the whole clip, no side-slide, no teleport`
      : 'keep the same screen position and facing direction for the whole clip, no side-slide, no teleport',
    // 动作起点承接：本镜首帧即上一镜结尾状态，防"过程断裂/凭空出现"
    opts.continuity
      ? `CONTINUITY HANDOFF: ${opts.continuity}, start exactly in this state, do not replay the previous beat`
      : 'start the clip at the pose shown in the reference frame, do not replay a prior action',
    // 运镜必须落地：有 camera 字段就执行，禁止"写了但不动"
    opts.camera
      ? `EXECUTE CAMERA MOVE: ${opts.camera}, smooth cinematic, continuous, no whip-pan, no teleport cut inside the clip`
      : 'EXECUTE CAMERA MOVE: very slow push-in toward subject, subtle and continuous',
    opts.emotion
      ? `ACTING BEAT: ${opts.emotion} — eyes, brows, mouth corners and micro-breathing carry the emotion`
      : 'ACTING BEAT: living stillness with readable micro-expression',
    cue,
    propLockFromAction(cue),
    ageLockFor(opts.lookEn || ''),
    opts.dialogue
      ? 'dialogue performance: natural Mandarin lip sync, emotional subtext in eyes, restrained jaw and cheek motion'
      : 'mouth closed, no speech, breathing and fabric movement only',
    'filmic temporal coherence, props that appear must persist',
    CINEMATIC_QUALITY_BLOCK
  )
}

/**
 * 时间轴稳定块（H3/Wan 通用，按引擎 fps 参数化）：
 * 显式声明总时长 + 首/中/末时间戳 + 帧序列稳定规则 + 末帧转场锚点，
 * 把模型的自由插值空间压到最小（单镜 I2V 模型必须给时间轴协议，否则运动节奏随机）。
 *
 * 注意：本块必须在 sanitizeCinematicPrompt 之后拼接——
 * 块内为规则文本，不参与虚词/因果词清洗。
 *
 * 转场职责边界：镜间转场由 ffmpeg 合成端执行（仅 dissolve 叠化，其余硬切），
 * 提示词只负责让末帧按 transition 类型进入正确的可切状态，禁止模型自造转场。
 */
export function timelineProtocolBlock(opts: {
  /** 本镜设计时长（秒） */
  sec: number
  /** 引擎帧率：H3=24，Wan=16 */
  fps: number
  /** 分镜转场类型，决定末帧协议 */
  transition?: string
  firstFrameEn?: string
  midFrameEn?: string
  lastFrameEn?: string
  /** 无 midFrameEn 时的中段动作回落（通常取 promptEn） */
  motionEn?: string
}): string {
  const sec = Math.max(0.5, Math.round(opts.sec * 10) / 10 || 0)
  const end = Math.max(0, Math.round((sec - 0.4) * 10) / 10)
  const mid = Math.max(0, Math.round(((sec - 0.4) / 2) * 10) / 10)
  const opening = (opts.firstFrameEn || '').trim()
    || 'same subject, layout, lighting and tone as the reference'
  const middle = (opts.midFrameEn || '').trim()
    || (opts.motionEn || '').trim()
    || 'the specified single motion progressing at constant speed'
  const ending = (opts.lastFrameEn || '').trim()
    || 'the motion completes and settles'
  const endingRule = opts.transition === 'dissolve'
    ? 'Ending rule: framing, color temperature and brightness stay steady through the final 0.5s for a clean dissolve'
    : 'Ending rule: during the final 0.4s the camera and all motion settle to a clean, stable final frame as a hard-cut point'
  return [
    `TIMELINE PROTOCOL — target duration ~${sec.toFixed(1)}s at ${opts.fps} fps, one single continuous shot`,
    `At 0.0s: opening frame matches the reference exactly, ${opening}`,
    `At ${mid.toFixed(1)}s: ${middle}, moving at one constant smooth speed`,
    `At ${end.toFixed(1)}s: ${ending}`,
    'Frame rules: frame-to-frame incremental change only, constant motion speed, no sudden acceleration or stop, no skipped frames, no duplicated frames, no frame hold, no interpolation jump, no in-clip cut, no crossfade, no fade to black or white, no whip pan, no zoom punch, no new objects entering frame, background geometry locked, lighting and exposure continuous with no flicker',
    endingRule
  ].join('. ') + '.'
}

/** 强表情判定：剧情明确要求大笑/大哭/尖叫/愤怒等夸张表演时，表情锁定需放行表情
 *  只约束面部结构不夸张变形，不能压制剧本表演（否则哭戏被锁成面瘫）。 */
const STRONG_EXPRESSION_RE =
  /laugh|laughter|scream|shout|cry|sob|weep|wail|scream|rage|furious|angry|shock|surprised|terrify|fearful|grin widely|大笑|大哭|尖叫|愤怒|震惊|惊恐/i

/** 面部表情锁定（正向约束，注入 H3/Wan 视频 motion 段）：
 *  针对 H3 r2v 参考图身份锁定弱、表演时脸型漂移的实测问题（老周温和微笑被放大成夸张大笑，
 *  ArcFace 相似度仅 0.16）。条件化：
 *  - 普通镜：微表情 + 面部结构与参考图一致
 *  - 强表情镜：允许表情，但面部骨架结构/五官比例不夸张变形，身份延续 */
export function faceExpressionLockFor(emotion?: string, action?: string): string {
  const hit = STRONG_EXPRESSION_RE.test((emotion || '') + ' ' + (action || ''))
  return hit
    ? 'facial expression follows the described emotion but stays controlled and realistic, no exaggerated face deformation, facial bone structure and features remain consistent with the reference image throughout, identity preserved'
    : 'subtle natural expression, face stays consistent with the reference image facial structure and features, no exaggerated expression, no face distortion, identity preserved throughout'
}

/** 古装镜时代锁：正向写朝代，不点名现代物件（点名会把物件召进画面）；负面时代隔离另行注入 */
export function periodLockFor(genre: string | undefined): string {
  const g = (genre || '').trim()
  if (/民国/.test(g)) {
    return 'period-accurate 1930s republican-era setting, only materials and objects of that era'
  }
  if (/古装|宫廷|仙侠|玄幻|武侠|穿越/.test(g)) {
    return 'ancient chinese period setting, only stone, wood, bamboo, cloth, jade and metal of that era, hanfu or wuxia robes, lantern or torch light, no modern objects, no modern vehicles, no street lights, no asphalt, no glass buildings, no electronics, no neon signs'
  }
  return ''
}
