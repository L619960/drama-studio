import { createLogger } from './logger'
import { GENRE_TEMPLATES, type Project, type Shot } from '../../shared/ipcTypes'
import {
  videoMotionPrompt,
  cleanAction,
  identityLockBlock,
  stripOocWardrobe,
  stripOtherPersonClauses,
  stripOutdoorHints,
  soloizeAction,
  stripEnglishCastNames,
  timelineProtocolBlock,
  castPromptPoisoned,
  repairCastText,
  periodLockFor,
  motionCueFromAction,
  scrubSummoningTerms,
  keepDialogueChinese,
  sanitizeCinematicPrompt,
  DISPLACEMENT_ACTION_RE,
  STRONG_ACTION_RE,
  faceExpressionLockFor,
  COMBAT_ACTION_RE,
} from '../../shared/imagePrompts'

const log = createLogger('TaskQueue')

/**
 * 防漂移强锁块（代码层兜底，渲染时注入 LLM promptEn 之后）：
 * 补 LLM 提示词缺失的「位置锁定 / 单原子动作 / 平滑运动」约束，
 * 把模型自由插值空间压到最小——位置/朝向/机位由代码层锁死，不依赖 LLM 自觉。
 * 微运镜策略（用户拍板：接受微运镜）：允许 promptEn 中的慢速小幅运镜
 * （slow push-in with small amplitude / slight pan / slight tilt / slight arc shot）生效，
 * 但禁止模型自行追加额外运镜/缩放——机位变化只能来自提示词明确指定的一条。
 */
export function driftLockBlock(shot: Shot): string {
  const parts: string[] = []
  // 强动作/位移镜跳过动作幅度压制（no sudden movement / no large displacement / no body rotation）——
  // 否则会压制剧本要求的摔砸/踢倒/位移（与动作忠实铁律冲突）；机位与复合动作锁仍注入
  const skipMotionSuppress = DISPLACEMENT_ACTION_RE.test(shot.action || '') || STRONG_ACTION_RE.test(shot.action || '')
  if (shot.facing) {
    parts.push(
      `BLOCKING LOCK: ${shot.facing}, stay in the same screen position and facing direction for the whole clip, no side-slide, no teleport${skipMotionSuppress ? '' : ', no body rotation, upper body fixed position'}`,
    )
  }
  if (shot.continuity) {
    parts.push(
      `CONTINUITY HANDOFF: ${stripOtherPersonClauses(shot.continuity)}, start exactly in this state, do not replay a prior beat`,
    )
  }
  parts.push(
    skipMotionSuppress
      ? 'single atomic motion only, fixed framing, camera motion only as specified, no extra camera moves, no zoom unless specified'
      : 'single atomic motion only, no compound action, no sudden movement, no large displacement, smooth steady motion, fixed framing, camera motion only as specified, no extra camera moves, no zoom unless specified',
  )
  return parts.join(', ')
}

/** 与定妆年龄/性别/服装或本镜动作冲突的 promptEn 不送进视频模型。
 *  含英文双词人名或对戏肢体接触的长句一律作废——成片实测会画双人分身。 */
export function usablePromptEn(shot: Shot, lookEn: string): string | undefined {
  const p = shot.promptEn?.trim()
  if (!p) return undefined
  if (castPromptPoisoned(shot.action || '', p, lookEn, shot.sceneEn)) {
    log.warn(`镜头 ${shot.index} 的视频提示词与定妆或动作冲突，已改用动作模板`)
    return undefined
  }
  if (/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/.test(p) || /\b(?:collides?|leans?\s+close|gripping|embraces?|hugs?)\b/i.test(p)) {
    log.warn(`镜头 ${shot.index} 的视频提示词含对戏人名或肢体接触，已改用动作模板`)
    return undefined
  }
  if (/\bthen\b/i.test(p) && p.split(/\bthen\b/i).length > 2) {
    log.warn(`镜头 ${shot.index} 的视频提示词动作拍数过多，已改用动作模板`)
    return undefined
  }
  return soloizeAction(stripOtherPersonClauses(stripEnglishCastNames(p)))
}

/**
 * 道具数量硬约束块（渲染时注入，代码层兜底，不依赖 LLM 自觉）：
 * 实测《雨夜山门》镜4 沈青崖被生成双手各持一剑相交、镜1 同镜刀具由莹绿短刃漂移成匕首——
 * 根因是提示词未锁道具数量与形态，模型自由发挥。
 * 持械镜：显式"仅一把武器、单手持械、另一手空手可见、武器形态全程稳定"；
 * 空手镜：显式"双手空手、无任何物品"（防止模型塞碗/杯/扇/卷轴等联想道具）。
 * 持物豁免（2026-10-23 现代剧首跑实测）：action 明确要求手持物品（端碗/端杯/抱盒等）
 * 时不锁空手，否则"hands empty"会与 action 持物冲突（《深夜便利店》镜3 周野端关东煮碗）。
 */
const HOLD_ACTION_RE =
  /\b(?:hold(?:ing|s)?|carry(?:ing|s)?|grip(?:s|ping)?|clutch(?:es|ing)?|grasp(?:es|ing)?|lift(?:s|ing)?|raise(?:s|ing)?|wave(?:s|ing)?|point(?:s|ing)?|raise)\s+(?:a|an|the|his|her|one)\s+(?:[\w-]+\s+)*(?:bowl|cup|mug|glass|bottle|box|bag|fan|sword|blade|knife|pipe|staff|stick|pole|umbrella|scroll|plate|tray|phone|book|lantern|torch|spoon|chopsticks?|oden|tray)\b/i

/** sceneEn 缺失时的场景词兜底（2026-10-23 现代剧首跑修复）：LLM 未产出 sceneEn → 从 action 提取已知场景名词。 */
export function sceneCueFor(shot: Pick<Shot, 'sceneEn' | 'action'>, cleanedRaw: string): string {
  if (cleanedRaw && !/[\u4e00-\u9fff]/.test(cleanedRaw)) return cleanedRaw
  const sceneWord = (shot.action || '').match(
    /\b(?:convenience store|department store|supermarket|street market|market|shop|store|cafe|restaurant|noodle house|teahouse|counter|office|apartment|room|hall|temple|gate|mountain|forest|alley|street|riverbank|inn|pavilion)\w*\b/i,
  )?.[0]
  return sceneWord ? `${sceneWord.toLowerCase()} interior` : ''
}
export function propsConstraintBlock(shot: Shot): string {
  const combat = COMBAT_ACTION_RE.test(shot.action || '')
  if (combat) {
    return 'PROP LOCK: exactly ONE weapon only, held in ONE hand, the other hand empty and clearly visible, no second weapon, no dual wielding, no extra object in the other hand; the weapon keeps the same shape, blade type and color for the whole clip, no morphing, no weapon changing into another'
  }
  if (HOLD_ACTION_RE.test(shot.action || '')) {
    return 'hands hold only the object specified in the action, nothing else, no extra prop in either hand'
  }
  if (shot.characterIds.length) {
    return 'hands empty, no object held, no cup, no bowl, no fan, no scroll, no cloth, no extra prop in either hand'
  }
  return ''
}

/**
 * 场景无路人锁（2026-10-23《雨夜山门 v2》外观漂移修复）：武打/对打/对峙/持械镜与特写镜
 * 必须显式声明场景中只有分镜声明的角色、背景无路人——H3 对未锁角色数的武打镜会自由添
 * 背景人（实测镜1 戴斗笠路人、镜4 黑劲装路人）。单人居一律锁「仅此 1 人 + 背景无人」；
 * 双人交锋锁「仅此 2 人」。台词/特写镜同规则（背景不得出现剧本外人物）。
 */
const COMBAT_OR_CLOSEUP_RE =
  /\b(?:fight|duel|swordfight|swordplay|combat|clash|parry|block|slash|strike|grip|wrestle|confront|standoff|fencing|martial arts|kungfu|wuxia)\b/i
export function noExtrasLockFor(shot: Pick<Shot, 'action' | 'characterIds' | 'shotSize'>): string {
  const n = shot.characterIds?.length || 1
  const isCombat = COMBAT_OR_CLOSEUP_RE.test(shot.action || '')
  const sz = shot.shotSize as string | undefined
  if (!isCombat && sz !== 'closeup' && sz !== 'medium') {
    return ''
  }
  if (n <= 1) {
    return 'NO EXTRAS: the scene contains exactly ONE person (the protagonist in the reference image), the surrounding background is empty and clear of any other figures'
  }
  return `NO EXTRAS: the scene contains exactly ${n} people (only the ${n} characters from the reference images), the surrounding background is empty and clear of any other figures`
}

/**
 * 构建 H3 结构化提示词（integrated_multimodal_description 格式，H3 模型训练格式）：
 * - 五元组：场景/人物 + 情绪(mood) + 机位运镜(camera) + 动作(action)
 * - i2v：场景/人物参考 <Picture 1> + 环境音描述
 * - r2v：额外注入台词 <d>[Chinese]...</d> 与参考音频 <Audio 1>，驱动口型与音色
 * @param qualityBlock 技能库电影级质量条款（由调用方注入，为空时回退代码层精简条款已在内部处理）
 */
export function buildH3Prompt(
  shot: Shot,
  project: Project,
  withAudio: boolean,
  sec: number,
  qualityBlock: string,
): string {
  const tpl = GENRE_TEMPLATES.find((t) => t.key === project.genre)
  // 题材只约束光影，身份锁压在题材词之前，避免「霸总」把卫衣角色渲成西装
  const char = project.characters.find((c) => c.id === shot.characterIds[0])
  const board = (project.sceneBoards || []).find((b) => b.id === shot.sceneBoardId)
  // 身份/发型/服装代码层强锁：无论主提示词来自 LLM 还是模板，都压在最前（H3/Wan 均适用）
  const lookEn = char?.appearanceLock || char?.description
  const identityLock = lookEn ? identityLockBlock(lookEn) : ''
  // 场景词显式注入：i2v 人物镜 subject 已声明参考图场景延续，但 H3 对背景延续仍会自由发挥
  // （实测镜7：参考图是理发店内，模型把背景重绘成雨夜街道）——场景名直接写进 prompt 双保险。
  // 联想词剥离：sceneEn 若含食物/餐具词（noodles/soup/bowl/chopsticks/food），H3 会给人物"端碗持筷"
  // （实测面馆镜：sceneEn 带 steam from pot → 视频人物端碗）；保留氛围词但剔除实体食物/餐具词
  const sceneCueRaw = (shot.sceneEn || '')
    .replace(/\b(?:steaming\s+)?(?:noodles?|soup|bowls?|chopsticks|food|dishes?|plates?|cutlery)\w*\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  // sceneEn 缺失回退（2026-10-23 现代剧首跑实测：《深夜便利店》LLM 未产出 sceneEn →
  // H3 prompt 无任何场景词 → R2V 背景自由发挥，镜4 便利店被重绘成药铺）。sceneEn 空时
  // 从 action 提取已知场景名词兜底注入（中文 scene/board.name 无法英文化，取 action 英文词）。
  const sceneCue = sceneCueFor(shot, sceneCueRaw)
  // 上下镜衔接：本镜尾帧为下一镜提供的连续状态（动作完成态/位置/道具归属），强化连镜不断裂
  const handoff = shot.handoffToNext ? `, HANDOFF TO NEXT SHOT: ${shot.handoffToNext}` : ''
  // 分镜级完整提示词（LLM 按镜头定制）优先；无则回退工业级模板拼装。
  // 组装后强制逻辑原子化清洗（去 * 号 / 文学虚词 / 因果解释词 / 空断言），LLM 违规也兜底净化；
  // 再删 OOC 服装词（围裙/领带/帽子等脑补职业装，与定妆冲突会造成渲染中途挂装漂移）
  const promptEn = usablePromptEn(shot, lookEn || '')
  const motion = promptEn
    ? sanitizeCinematicPrompt(
        stripOocWardrobe(
          stripOtherPersonClauses(
            `${identityLock}${sceneCue ? `, in ${sceneCue}` : ''}, ${promptEn}, ${driftLockBlock(shot)}${handoff}, ${qualityBlock}`,
          ),
          lookEn || '',
        ),
      )
    : sanitizeCinematicPrompt(
        videoMotionPrompt({
          action: cleanAction(stripOutdoorHints(shot.action, shot.scene || '')),
          ...(lookEn !== undefined ? { lookEn } : {}),
          scene: board?.name || shot.scene,
          ...(shot.emotion !== undefined ? { emotion: shot.emotion } : {}),
          ...(shot.camera !== undefined ? { camera: shot.camera } : {}),
          ...(withAudio ? { dialogue: shot.dialogue } : {}),
          ...(tpl?.promptStyle !== undefined ? { genreStyle: tpl.promptStyle } : {}),
          ...(shot.shotSize !== undefined ? { shotSize: shot.shotSize } : {}),
          ...(shot.lighting !== undefined ? { lighting: shot.lighting } : {}),
          ...(shot.facing !== undefined ? { facing: shot.facing } : {}),
          ...(shot.continuity !== undefined ? { continuity: shot.continuity } : {}),
        }),
      )
  // 渲染层禁联想道具（实测根因：面馆场景空景含筷子筒/煮面锅 → H3 把碗筷联想给人物"端碗持筷"；
  // 通用禁餐具/食物/手持容器，除非 action 明确要求——避免模型给空手人物塞碗筷杯子）
  // 服装联想词（围裙/领带/制服/帽子等）不在此静态清单——由 oocWardrobeNegativeFor 按定妆锁
  // 动态压制，避免定妆即制服/帽子时负向与身份锁自相矛盾。
  // 道具数量硬约束（propsConstraintBlock）：持械镜锁"一把武器单手执械"、空手镜锁"双手无物"，
  // 杜绝双剑/多械/凭空变械与联想道具（实测《雨夜山门》镜4 双剑相交、镜1 刀形漂移的根因）。
  const propsLock = propsConstraintBlock(shot)
  const hands =
    shot.type === 'i2v' && shot.characterIds.length
      ? `hands follow the action, empty when the action does not hold an object, ${propsLock}`
      : propsLock
  // 场景无路人锁（武打/对打/特写镜）：禁止 H3 添加剧本外背景人（实测《雨夜山门》镜1/镜4 路人）
  const noExtras = noExtrasLockFor(shot)
  const finalMotion =
    motion +
    (hands ? `, ${hands}` : '') +
    (noExtras ? `, ${noExtras}` : '') +
    // 面部表情锁定（正向约束）：H3 r2v 对参考图身份锁定弱，表演时脸型/表情夸张漂移
    // （实测温和微笑被放大成大笑，ArcFace 相似度 0.16）。条件化：强表情镜放行表情但锁面部结构。
    (shot.characterIds.length ? `, ${faceExpressionLockFor(shot.emotion, shot.action)}` : '')
  // 时间轴稳定块（在 sanitize 之后拼接：总时长+首中末时间戳+帧序列规则+末帧转场锚点）
  const look = lookEn || ''
  const timelineFirst = repairCastText(shot.firstFrameEn, shot.action || '', look, 'frame')
  const timelineMid = repairCastText(shot.midFrameEn, shot.action || '', look, 'frame')
  const timelineLast = repairCastText(shot.lastFrameEn, shot.action || '', look, 'frame')
  const timeline = timelineProtocolBlock({
    sec,
    fps: 24,
    ...(shot.transition !== undefined ? { transition: shot.transition } : {}),
    ...(timelineFirst !== undefined ? { firstFrameEn: timelineFirst } : {}),
    ...(timelineMid !== undefined ? { midFrameEn: timelineMid } : {}),
    ...(timelineLast !== undefined ? { lastFrameEn: timelineLast } : {}),
    motionEn: promptEn || motionCueFromAction(shot.action),
  })
  // H3 工作流没有负向入口。负向词写进正向会被画出来，所以这里不写。
  const periodLock = periodLockFor(project.genre)
  // 官方 I2VA 首帧锚定格式（MiniMax H3 prompt guide）：显式声明 0.00s 时首帧被完全参考，
  // 比"the person shown in <Picture 1>"更符合 H3 训练格式，降低模型把首帧当参考而非精确起点的概率。
  // 人物镜：人物+场景双锚定（实测镜7 r2v：只锁人物、promptEn 无场景词 → 模型把理发店背景自由发挥成街道）
  const subject =
    shot.type === 'i2v' && shot.characterIds.length
      ? withAudio
        ? // r2v 双参考：<Picture 1> 人物首帧（ref_image_1）+ <Picture 2> 场景板空景（ref_image_2）锁背景
          'For the target video, at 0.00 seconds, <Picture 1> is fully referenced: the person shown in it, appearance, clothing and identity fully preserved; <Picture 2> is fully referenced: the scene shown in it, layout, lighting and tone fully preserved'
        : // i2v 单参考：first_frame 整图延续（人物+背景一体）
          'For the target video, at 0.00 seconds, <Picture 1> is fully referenced: the person shown in it, appearance, clothing and identity fully preserved; the surrounding scene, layout, lighting and tone also fully preserved from <Picture 1>'
      : 'For the target video, at 0.00 seconds, <Picture 1> is fully referenced: the scene shown in it, layout, lighting and tone fully preserved'
  // 逐镜审核整改指令（看守）：未过审重渲时注入上次审核给出的修正要点
  const fix = shot.auditFix ? ` Revision directive: ${shot.auditFix}` : ''
  if (withAudio) {
    // r2v：只允许片中角色说 <d> 台词；严禁旁白/解说/第三人称念白（否则听感像纪录片解说）
    return keepDialogueChinese(
      scrubSummoningTerms(
        `integrated_multimodal_description: [Shot 1] Live-action, cinematic. ${subject}. ${finalMotion}. ${periodLock}. ${timeline}.${fix} At 0.4 seconds, the on-screen character says: <d>[Chinese] ${shot.dialogue}</d> Lips move naturally in sync with the Mandarin speech of reference audio <Audio 1>. Only this character speaks; no narrator, no voiceover, no commentator, no third-person storytelling. overall_soundscape: natural ambience under the dialogue. non_diegetic_music: N/A`,
      ),
    )
  }
  // i2v 无参考音：H3 极易把英文 multimodal 描述念成旁白——显式禁语音
  return keepDialogueChinese(
    scrubSummoningTerms(
      `integrated_multimodal_description: [Shot 1] Live-action, cinematic. ${subject}. ${finalMotion}. ${periodLock}. ${timeline}.${fix} overall_soundscape: natural ambience only; no speech, no narration, no voiceover, no commentator, no spoken description of the scene; mouth remains closed. non_diegetic_music: N/A`,
    ),
  )
}
