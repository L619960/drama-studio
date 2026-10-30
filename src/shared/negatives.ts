/**
 * 负向提示与写实锁域：视频负向拼装、写实负向/正向加强、场景/定妆负向、
 * OOC 服装负向、老年漂移负向、负向插槽判断。
 * 依赖：promptConstants、promptUtils、motion（动作判定正则）、promptDrift（lookAllowsElderly）。
 */

import { REALISM_NEGATIVE, VIDEO_NEGATIVE_BASE, VIDEO_NEGATIVE_MOTION_SUPPRESS } from './promptConstants'
import { mergeNegative } from './promptUtils'
import { DISPLACEMENT_ACTION_RE, STRONG_ACTION_RE } from './motion'
import { lookAllowsElderly } from './promptDrift'
import { isPeriodGenre } from './castAppearance'

/** OOC 服装负向（lock-aware）：高危脑补服装词只压制「定妆锁里没有的」，
 *  定妆已有的服装词跳过（否则与身份锁自相矛盾——定妆穿西装却负向 no blazer）。 */
export function oocWardrobeNegativeFor(lookEn: string): string {
  const lock = (lookEn || '').toLowerCase()
  const terms = [
    'apron', 'vest', 'hat', 'cap', 'beanie', 'hood', 'necktie', 'tie', 'bow tie',
    'scarf', 'shawl', 'stole', 'necklace', 'pendant', 'earrings', 'bracelet', 'watch',
    'glasses', 'sunglasses', 'purse', 'handbag', 'shoulder bag', 'backpack',
    'gown', 'blazer', 'suit jacket', 'uniform', 'overalls', 'lab coat',
    'name tag', 'waiter costume', 'apron dress', 'cardigan', 'blouse', 'turtleneck sweater'
  ]
  return terms.filter(t => !lock.includes(t)).map(t => `no ${t}`).join(', ')
}

/** 按镜型条件拼装系统负向：位移镜与强动作镜跳过动作压制组（否则会压制剧本要求的
 *  位移与摔砸/踢倒动作），其余镜全量注入。与分镜 negativeEn 经 mergeNegative 合并。 */
export function videoNegativeFor(action?: string): string {
  const a = action || ''
  if (DISPLACEMENT_ACTION_RE.test(a) || STRONG_ACTION_RE.test(a)) return VIDEO_NEGATIVE_BASE
  return VIDEO_NEGATIVE_BASE + '; ' + VIDEO_NEGATIVE_MOTION_SUPPRESS
}

/** 写实锁：strong 时追加更强身份/美颜压制短语（负向仍用 REALISM_NEGATIVE / STRONG） */
export function realismPositiveExtra(lock: 'standard' | 'strong' = 'standard'): string {
  if (lock !== 'strong') return ''
  return 'ultra-strict identity plate, clean even skin tone, healthy natural complexion, zero beauty retouch, wardrobe locked'
}

export function realismNegativeFor(lock: 'standard' | 'strong' = 'standard'): string {
  // 皮肤瑕疵补充项（mergeNegative 会自动去掉与 REALISM_NEGATIVE 重复的词）
  const cleanSkin =
    'acne, acne scars, pockmarks, skin blotches, age spots, rashes, sunburn, peeling skin, ' +
    'wrinkles, creases, stubble shadow, five o clock shadow, beard stubble, unshaven, ' +
    'dirty skin, greasy skin, uneven skin tone, discolored patches, blemishes, freckles, ' +
    'dermatitis, eczema, skin disease, scars, cuts, wounds, bruising, ' +
    'moles, mole, birthmarks, lumps, bumps, skin tags, warts, cysts, tumors, growths, protrusions, raised skin, pimples, spots on face'
  if (lock !== 'strong') return mergeNegative(REALISM_NEGATIVE, cleanSkin)
  return mergeNegative(
    REALISM_NEGATIVE,
    [
      'beautified face', 'soft focus glamour', 'k-pop idol retouch', 'plastic specular skin',
      'wardrobe redesign', 'hairstyle change', 'age shift'
    ].join(', '),
    cleanSkin
  )
}

/** 场景类负向：写实压制（realismNegativeFor）+ 时代负向组（古风/年代剧）。
 *  供场景板 / 全景图 / 首帧场景生成传入 image.generate 的 negative。
 *  genre 缺省/现代剧时不加时代组，避免误锁现代题材。 */
export function sceneNegativeFor(lock: 'standard' | 'strong' = 'standard', genre?: string): string {
  const era = eraNegativeFor(genre)
  return era ? mergeNegative(realismNegativeFor(lock), era) : realismNegativeFor(lock)
}

/** 古风/年代剧时代负向组：只压现代服化道与东亚他文化元素（忍者/武士/面罩），
 *  同时压现代街道与科技元素。注意不压剧本明确的身份锚点——
 *  布巾蒙面（veil / cloth covering the lower face）与络腮胡（beard）是古装武侠剧
 *  角色差异化特征，禁止压掉（实测：劫匪定妆被画成黑色忍者服+面罩+日式武士刀，
 *  根因即负面通道缺时代词，lookEn 的 black cloth covering lower face 被 T2I 误解为忍者原型）。 */
export function eraNegativeFor(genre: string | undefined): string {
  if (!isPeriodGenre(genre)) return ''
  return (
    'no modern clothing, no jacket, no hoodie, no sweater, no cardigan, no jeans, no denim, no sneakers, no trainers, no suit, no tie, no necktie, no uniform, no raincoat, no work clothes, no trench coat, no leather jacket, no blazer, no overalls, no lab coat, no t-shirt, no trousers, no pants, no hat, no cap, no sunglasses, no backpack, no wristwatch, no earphone, no name tag, ' +
    'no tactical gear, no combat gear, no military uniform, no swat, no army, no body armor, no face mask, no balaclava, no ski mask, no respirator, no hood, no full-face covering, no face fully covered, no eyes-only mask, ' +
    'no ninja, no ninja outfit, no samurai, no japanese warrior, no katana, no gun, no pistol, no rifle, no firearm, no sci-fi weapon, ' +
    'no modern street, no asphalt, no road, no sidewalk, no street lamp, no streetlight, no neon sign, no glass building, no skyscraper, no car, no vehicle, no motorcycle, no bicycle, no traffic, no billboard, no electronics, no smartphone, no camera, no sci-fi, no robot, no spaceship'
  )
}

/** 空场景（全景/空镜板）专用负向：只压人物与图库风，走负向通道。
 *  正向写 "no people" 会被 CLIP 当概念召唤（实测空镜里出现两个骑车路人），
 *  因此人物压制必须放在 negative 里；不得用于角色定妆（会把人一起压掉）。 */
const EMPTY_SCENE_NEGATIVE =
  'people, person, human, crowd, pedestrian, passerby, silhouette, figure, face, portrait, ' +
  'cartoon, illustration, cgi render, text, watermark, logo, ' +
  // 360° 全景底部常见 artifact（实测天台全景底部出现轮胎/井盖）：走负向压制
  'tires, wheels, manhole covers, drain grates, circular metal covers, random mechanical objects, ' +
  'repeated circular patterns on the ground, fisheye distortion, warp at bottom edge'

/** 室内外空间负向：室内场景被画成临街/外景是本项目高频事故
 *  （实测「男厕所」全景 = 雨夜临街公厕 + 汽车 + 马路）。正向已声明 interior，
 *  这里再用负向压住室外元素，双保险。 */
const INDOOR_SPACE_RE =
  /室内|厕所|洗手间|卫生间|浴室|卧室|厨房|办公室|会议|电梯|走廊|楼道|大厅|前台|包间|包厢|房|店|酒吧|餐厅|会所|\b(indoor|interior|inside|restroom|bathroom|toilet|room|suite|office|lobby|corridor|hallway|elevator|kitchen|restaurant|bar)\b/i
const OUTDOOR_SPACE_RE =
  /街|路|巷|广场|公园|海|山|桥|天台|露台|工地|码头|停车场|院|小区|野外|郊外|田|河|湖|车站|站台|\b(outdoor|street|road|alley|plaza|park|beach|rooftop|dock|pier|field|forest)\b/i
const OUTDOOR_NOISE_NEGATIVE =
  'street, road, sidewalk, asphalt, traffic, car, vehicle, night street, city skyline, sky, ' +
  'exterior building facade, window view of street, outdoor scenery, parking lot, rain-soaked street, ' +
  'wall lamp, vintage wall lantern, wet floor, reflective wet floor, water puddle on floor, glossy wet floor reflection'

/** 按场景名生成空间类型负向（仅室内场景需要压室外元素） */
export function sceneSpaceNegativeFor(scene: string): string {
  const s = (scene || '').trim()
  if (!s) return ''
  const indoor = INDOOR_SPACE_RE.test(s)
  const outdoor = OUTDOOR_SPACE_RE.test(s)
  return indoor && !outdoor ? OUTDOOR_NOISE_NEGATIVE : ''
}

export function emptySceneNegativeFor(lock: 'standard' | 'strong' = 'standard', scene?: string): string {
  const base = mergeNegative(realismNegativeFor(lock), EMPTY_SCENE_NEGATIVE)
  return scene ? mergeNegative(base, sceneSpaceNegativeFor(scene)) : base
}

/** 定妆专用背景隔离负向（裸概念词，走 t2i $NEGATIVE$ 通道）：
 *  正向 prompt 写 "no street / no city" 会被 CLIP 当概念召唤（实测事故：古装掌柜定妆
 *  背景出现雨夜现代街景）——背景压制必须走负向通道，正向只写「要什么」。 */
const CASTING_BG_NEGATIVE =
  'street, city, cityscape, road, vehicles, outdoor scenery, rain, snow, crowd, background people, window view, detailed background, textured backdrop, ' +
  'street lamp, floor lamp, standing lamp, light stand, studio light, tripod, lantern, candle, wall lamp, vintage wall lantern, gas lamp, ' +
  'wet ground, puddle, water reflection on ground, stone pavement, wet pavement, outdoor floor, wooden floor, carpet';

export function castingNegativeFor(lock: 'standard' | 'strong' = 'standard', genre?: string): string {
  const era = eraNegativeFor(genre)
  return era
    ? mergeNegative(realismNegativeFor(lock), CASTING_BG_NEGATIVE, era)
    : mergeNegative(realismNegativeFor(lock), CASTING_BG_NEGATIVE)
}

/** 定妆不是老年时，负向压住老年脸，避免正向漏网后仍被画成老头。 */
export function ageDriftNegativeFor(lookEn: string): string {
  if (!lookEn?.trim() || lookAllowsElderly(lookEn)) return ''
  return 'old man, old woman, elderly face, white stubble, grey stubble, white beard, weathered face, age shift, different person'
}

/** 首帧/尾帧人数负向：单人镜必须压住「第二个人」，否则会被画成两人同框
 *  （实测 shot_0 首帧出现女主 + 戴草帽男子）。同时压手部畸变。
 *  v2（硬门禁）：补「第二主体/队伍成主体」压制——单人镜动作含群像词（镖队/随从）时
 *  模型会把队伍画成与主体同框的第二人，需明确压住。 */
export function frameCrowdNegativeFor(count: number): string {
  const hands = 'deformed hands, extra fingers, missing fingers, fused fingers, mutated hands, malformed limbs'
  if (count <= 1) {
    return mergeNegative(
      'two people, multiple people, extra person, second person, crowd, background figures, ' +
      'multiple faces, couple, group of people, passerby, ' +
      'two people facing each other, second person as main subject, group of people as main subject, ' +
      'people standing side by side in foreground, another character in the same frame',
      hands
    )
  }
  return mergeNegative('crowd, extra people beyond the specified count, duplicate same person', hands)
}

/** 有负向节点的工作流才接收这段文字。没有负向入口时返回空，禁止写进正向。 */
export function negativeForSlot(hasSlot: boolean, negative: string): string | undefined {
  const text = (negative || '').trim()
  if (!hasSlot || !text) return undefined
  return text
}
