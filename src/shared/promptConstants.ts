/**
 * 电影工业级资产提示词——纯常量（画质/负向/景别/质量块）。
 * 本模块为叶子节点：不依赖本目录其它提示词模块。
 */

/** 正向：摄影质感 + 光学 + 肤质颗粒（竖屏短剧，非宽银幕变形镜头） */
export const REALISM_POSITIVE =
  [
    'photorealistic live-action chinese vertical short-drama frame',
    'shot on ARRI Alexa Mini LF with Zeiss Supreme Prime 50mm T1.5',
    'natural real skin texture with soft subtle pores and healthy even tone, no beauty filter',
    'subtle Kodak Vision3 film grain, practical motivated lighting',
    'soft volumetric atmosphere, accurate fabric weave and material response',
    'true-to-life asian facial proportions, documentary color science, matte finish'
  ].join(', ')

/**
 * 负向：油光 / 塑料 / 美颜 / 换装漂移 / CGI / 皮肤瑕疵 / 面部水珠。
 * 注入工作流 $NEGATIVE$（klein_t2i_clean / qwen_t2i_hq / builtin_t2i）。
 */
export const REALISM_NEGATIVE =
  [
    'plastic skin', 'oily skin', 'shiny skin', 'waxy skin', 'airbrushed', 'beauty filter',
    'smooth skin', 'porcelain skin', 'doll face', 'mannequin', 'wax figure',
    'CGI', '3d render', 'octane render', 'unreal engine', 'overprocessed',
    'anime', 'cartoon', 'illustration', 'painting', 'digital art', 'idol makeup',
    'heavy makeup', 'bright eyeshadow', 'glossy lips', 'overexposed highlights', 'bloom', 'hdr glow',
    'perfect symmetry', 'uncanny valley', 'fake skin', 'blurry', 'low detail',
    'deformed face', 'extra fingers', 'watermark', 'text', 'logo',
    // 通用防换装漂移词保留；具体服装/场景黑名单（gown/校服/办公室/宴会厅等）属于
    // 单项目防漂移补丁，全局生效会误杀正式场合/学生/职场题材——已移至 lock-aware 负向
    'different outfit', 'outfit change', 'costume change', 'wardrobe change',
    'changed clothes mid-shot',
    // 拼贴/多格/分屏：模型偶把分镜格子图当成图/首帧输出（实测事故：三格拼贴当首帧，视频全程继承畸形）
    'collage', 'multi-panel', 'multiple panels', 'split screen', 'storyboard grid', 'comic strip', 'panel layout', 'triptych',
    'anamorphic flare spam', 'over-sharpened', 'plastic specular',
    'reverse motion', 'playing backwards', 'car reversing', 'wheels spinning backward',
    'morphing face', 'identity flicker', 'limb melt',
    // 皮肤瑕疵与面部水珠：定妆/首帧/视频人脸统一压制（雨滴只出现在场景与空气，不在脸上）
    'acne', 'acne scars', 'pockmarks', 'skin blotches', 'age spots', 'blemishes', 'freckles',
    'moles', 'mole', 'birthmarks', 'lumps', 'bumps', 'skin tags', 'warts', 'cysts', 'tumors',
    'growths', 'protrusions', 'raised skin', 'pimples', 'spots on face', 'stubble shadow',
    'five o clock shadow', 'beard stubble', 'unshaven', 'wrinkles', 'creases', 'scars', 'cuts',
    'water droplets on face', 'raindrops on face', 'wet skin', 'sweat on face', 'perspiration',
    'dirty skin', 'greasy skin', 'uneven skin tone', 'discolored patches', 'rash', 'sunburn'
  ].join(', ')

/**
 * 电影级质量强制块（看守条款，代码层兜底）：每次图/视频生成自动追加。
 * 与技能库 skills/director/rules.json 的 cinematicQuality 互补：
 * REALISM_POSITIVE 已含画质/肤质/颗粒，本块侧重特效/运镜/光效/场景锁定。
 */
export const CINEMATIC_QUALITY_BLOCK = [
  'cinematic vfx discipline: practical effects only, no CGI, no 3d render, no illustration',
  'motivated camera language: smooth continuous move, no whip-pan, no crash zoom, no teleport cut',
  'motivated practical lighting: single consistent key direction, volumetric atmosphere, scene-matched color temperature',
  'locked set continuity: same physical location, key props persist, no scene swap, no reverse motion',
  'era-locked world: objects, architecture and clothing match the story era'
].join(', ')

/** 视频渲染通用负向指令·基础组（无条件全镜注入）：
 *  皮肤瑕疵/画质/身份漂移/字幕类高频根因压制，与分镜 negativeEn（增量风险词）合并使用。
 *  两链路均为文本内注入：MiniMax H3 云端 API 无 negative 参数；Wan 2.2 本地工作流虽有
 *  负向节点，但 wan22_i2v.json 采用 CFG=1 蒸馏 LoRA、负向分支失效——统一以
 *  "Negative directives:" 段并入正向提示词尾部（社区实践，非官方指南章节）。
 *  转场/帧序列类词不在此列：timelineProtocolBlock 正向协议每镜必含同款，不重复压制。
 *  注意：服装黑名单不在此静态清单——静态禁词不感知定妆锁（定妆就是西装/制服时会
 *  与身份锁自相矛盾），OOC 服装压制统一走 oocWardrobeNegativeFor(lookEn)。 */
export const VIDEO_NEGATIVE_BASE =
  'avoid acne, pockmarks, moles, birthmarks, warts, scars, cuts, stubble shadow, water droplets or sweat on face, wet skin; avoid extra people, extra limbs, morphing face, identity flicker, outfit change, costume change, hairstyle change, hair length change, background object displacement, prop morphing, reverse motion, playing backwards, limb melt, deformed face, distorted hands, distorted limbs, blurry, low quality; no lighting flicker, no extra characters; consistent background, no background swap; no subtitles, no watermark, no text, no captions'

/** 视频渲染通用负向指令·动作压制组（条件化注入，经 videoNegativeFor 拼装）：
 *  位移镜（DISPLACEMENT_ACTION_RE 命中）与强动作镜（STRONG_ACTION_RE 命中）必须跳过——
 *  "no large displacement / no sudden movement" 会直接压制剧本要求的位移与摔砸/踢倒动作。 */
export const VIDEO_NEGATIVE_MOTION_SUPPRESS =
  'no sudden movement, no large displacement, no position shift, no body rotation, no compound action'

/** 景别工业术语 */
export const SHOT_SIZE_CUE: Record<string, string> = {
  closeup: 'ECU/CU: extreme close-up or tight close-up, face or hands fill frame, shallow DOF T1.5, catchlight in eyes',
  // 中景构图强化（2026-10-17 漂移根因）：主角脸占比 <6% + 背景多张清晰人脸是 H3 i2v
  // 换脸漂移两大驱动（实测：中景群像镜主角被换成"平均脸"）——强制主角胸像主导画面、
  // 背景人脸浅景深糊掉，把可锁定人脸面积拉大
  medium: 'MS: medium shot waist-up, dialogue performance framing, eye-level, clean headroom, the lead subject dominates the frame with clearly readable face (at least 15% of frame height), any background faces heavily blurred and out of focus (shallow depth of field)',
  wide: 'WS: wide establishing or full-body in environment, readable blocking, environmental storytelling'
}

/** 提示词模块自检用：确保工业级锚点仍在 */
export const PROMPT_QA_MARKERS = [
  'LOCKED IDENTITY',
  'ARRI Alexa',
  'STRICT',
  'LOCKED LOCATION'
] as const

/** Wan 负向节点原文。只填进 $NEGATIVE$，不进正向。 */
export const WAN_QUALITY_NEGATIVE =
  '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走'
