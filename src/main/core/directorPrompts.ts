import {
  frameAppearanceLock,
  motionCueFromAction,
  soloizeAction,
  stripOtherPersonClauses,
} from '../../shared/imagePrompts'

/**
 * 从全景方位图中按镜头机位选一张（青橙Lab「全景固定场景」）。
 * 方位约定（cropPanoramaViews 从左到右裁）：view0=前视(默认)、view1=右90°、view2=后180°、view3=左270°；
 * panoViews 数量不足时取最后一档兜底。
 */
export function pickPanoView(camera: string | undefined, views: string[] | undefined): string | undefined {
  if (!views?.length) return undefined
  const cam = (camera || '').toLowerCase()
  let idx = 0
  if (/\b(left)\b|portrait side/.test(cam)) idx = Math.min(views.length - 1, 3)
  else if (/\b(right)\b|profile/.test(cam)) idx = Math.min(views.length - 1, 1)
  else if (/back|behind|rear|over-?shoulder|from behind/.test(cam)) idx = Math.min(views.length - 1, 2)
  return views[idx]
}

/**
 * 首帧 prompt 的 camera 净化：剥离镜头描述里的"第二人/背景人影"从句。
 * camera 常含 "Su Wan as blurred figure out of focus at frame edge" 这类对白/配角
 * 位置描述——若原样进首帧图生 prompt，模型会画出第二个人，污染单人居画面。
 * 只保留运镜/景深/视角词（这些对静态首帧构图仍有价值）。
 */
export function sanitizeCameraForFrame(camera: string): string {
  const segs = camera
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
  const keep = segs.filter(
    (s) =>
      !/(?:another|other person|second person|background figure|blurred figure|out of focus|路人|人影|另一位|另一人|剪影)/i.test(
        s,
      ),
  )
  return keep.join(', ')
}

/**
 * closeup 首帧图生图编辑指令（FireRed Image Edit）：以定妆图为参考，
 * 只改场景/姿态/表情/构图，要求面部、发型、服装、肤色与参考图完全一致。
 * 图生图模板是"编辑指令"语义（TextEncodeQwenImageEditPlus），
 * 与文生图 prompt（shotFramePrompt）不同，不能混用。
 */
export function buildCloseupEditPrompt(
  lookEn: string,
  sceneHint: string,
  d: {
    as: {
      action?: string | undefined
      emotion?: string | undefined
      camera?: string | undefined
      shotSize?: string | undefined
      firstFrameEn?: string | undefined
      lastFrameEn?: string | undefined
      props?: string[] | undefined
    }
  },
  sizeCue: string,
  phase: 'start' | 'end' = 'start',
): string {
  // 分镜级首/尾帧提示词。start 首帧一律以 action 为权威（action 是 LLM 按剧情写的动作起点姿态，
  // firstFrameEn 常与 action 场景/动作冲突——如"店外收伞"vs"店内递剪"——不再优先使用）；
  // end 尾帧用 lastFrameEn（仅大幅转场镜才写）。
  const rawCue =
    phase === 'start'
      ? d.as.action?.trim() || d.as.firstFrameEn?.trim()
      : d.as.lastFrameEn?.trim() || d.as.action?.trim()
  // 首帧动作压成单人单拍：长对戏英文句会画第二人（成片镜1/6）
  const frameCue = rawCue ? soloizeAction(stripOtherPersonClauses(motionCueFromAction(rawCue))) : ''
  const action = frameCue ? `，${frameCue}` : ''
  const emotion = d.as.emotion?.trim() ? `，${d.as.emotion.trim()}的表情` : ''
  const camera = d.as.camera?.trim() ? `，${sanitizeCameraForFrame(d.as.camera)}` : ''
  // 道具强约束：本镜关键道具必须出现在首帧画面（视频模型只会延续首帧里已有的东西——
  // 梳子/剪刀没画进首帧，视频就永远做不了"放梳/递剪"动作）。
  // props 字段缺失时兜底：通用道具句强制动作描述中的手持道具入画，不依赖 LLM 自觉
  const props = (d.as.props?.length ? d.as.props : []).join('、')
  const propLock = props
    ? `。画面中必须清晰出现本镜关键道具：${props}（手持或置于身前，不得缺失）`
    : `。动作描述中出现的手持道具必须清晰入画，置于手中或身前台面上，不得缺失`
  // 禁联想餐具/容器（实测：面馆场景氛围会诱导模型给人物端碗持筷；动作未要求的容器一律禁止）
  const tablewareBan = `。严禁出现与动作描述无关的碗、筷、勺、杯、盘、餐具、食物或任何手持容器，人物双手严格按动作描述摆放，否则双手自然下垂空置、不得持物`
  return (
    `把图1中的人物放入场景「${sceneHint}」：${sizeCue}${action}${emotion}${camera}${propLock}${tablewareBan}。` +
    `人物按${sizeCue}景别完整入画（肢体不得截断、不裁剪），` +
    `人物姿态、视线方向、手持道具状态严格按动作描述执行（不得改为直视镜头，除非动作本就如此），` +
    `${frameAppearanceLock(lookEn)}` +
    `保持面部、发型、服装、肤色与图1完全一致。` +
    `画面中除动作描述与关键道具外，不得出现任何其他物品、工具、容器、器械（严禁凭空添加台面杂物）；` +
    `画面中只能出现主体人物一人，严禁任何其他人物（不得有路人、第二张人脸、背景人影、镜像倒影人影、玻璃窗反射人影、镜子里的第二人）；` +
    `洗手台、走廊、套房背景里不得出现另一个男人或女人。` +
    `背景完全替换为场景描述（不得保留图1原始背景、不得出现图1背景元素），` +
    `写实电影感，自然光影，背景符合场景氛围。嘴部闭合。器物、建筑和地面都与这个场景的时代一致。`
  )
}

/**
 * 全景双图融合提示词（firered_i2i_two 工作流：image1=场景方位图，image2=角色定妆图）：
 * 人物全部来自图2（锁脸/发型/服装/肤色），场景全部来自图1（锁空间/光线/色调/机位），
 * 二者互不干扰——这是「全景固定场景」的提示词侧落地。
 */
export function buildPanoEditPrompt(
  lookEn: string,
  sceneHint: string,
  d: {
    as: {
      action?: string | undefined
      emotion?: string | undefined
      camera?: string | undefined
      shotSize?: string | undefined
      firstFrameEn?: string | undefined
      lastFrameEn?: string | undefined
      props?: string[] | undefined
    }
  },
  sizeCue: string,
  phase: 'start' | 'end' = 'start',
): string {
  // 分镜级首/尾帧提示词。start 首帧一律以 action 为权威（同 buildCloseupEditPrompt）；
  // end 尾帧用 lastFrameEn（仅大幅转场镜才写）。
  const rawCue =
    phase === 'start'
      ? d.as.action?.trim() || d.as.firstFrameEn?.trim()
      : d.as.lastFrameEn?.trim() || d.as.action?.trim()
  const frameCue = rawCue ? soloizeAction(stripOtherPersonClauses(motionCueFromAction(rawCue))) : ''
  const action = frameCue ? `，${frameCue}` : ''
  const emotion = d.as.emotion?.trim() ? `，${d.as.emotion.trim()}的表情` : ''
  const camera = d.as.camera?.trim() ? `，${sanitizeCameraForFrame(d.as.camera)}` : ''
  // 道具强约束（同 buildCloseupEditPrompt）：关键道具必须画进首帧，视频才能执行道具动作。
  // props 缺失时用通用句兜底（不列示例道具词，避免诱导模型凭空添加）
  const props = (d.as.props?.length ? d.as.props : []).join('、')
  const propLock = props
    ? `。画面中必须清晰出现本镜关键道具：${props}（手持或置于身前，不得缺失）`
    : `。动作描述中出现的手持道具必须清晰入画，置于手中或身前台面上，不得缺失`
  const tablewareBan = `。严禁出现与动作描述无关的碗、筷、勺、杯、盘、餐具、食物或任何手持容器，人物双手严格按动作描述摆放，否则双手自然下垂空置、不得持物`
  return (
    `把图2中的人物放入图1的场景「${sceneHint}」：${sizeCue}${action}${emotion}${camera}${propLock}${tablewareBan}。` +
    `${frameAppearanceLock(lookEn)}` +
    `人物的面部、发型、服装、肤色与图2完全一致。` +
    `人物姿态、视线方向、手持道具状态严格按动作描述执行（不得改为直视镜头，除非动作本就如此）；` +
    `画面中除动作描述与关键道具外，不得出现任何其他物品、工具、容器、器械（严禁凭空添加台面杂物）；` +
    `画面中只能出现主体人物一人，严禁任何其他人物（不得有路人、第二张人脸、背景人影、镜像倒影人影、玻璃窗反射人影、镜子里的第二人）；` +
    `洗手台、走廊、套房背景里不得出现另一个男人或女人。` +
    `场景的空间布局、光线、色调、机位角度与图1完全一致（图1是该场景的全景方位图，全剧复用）；` +
    `写实电影感，自然光影，背景严格符合图1场景氛围，不得改成其他地点。嘴部闭合。器物、建筑和地面都与这个场景的时代一致。`
  )
}
