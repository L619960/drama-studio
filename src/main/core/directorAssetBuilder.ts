import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {
  AnalyzeResult, Character, Shot, SceneBoard
} from '../../shared/ipcTypes'
import { normalizeSceneKey, type Project } from '../../shared/ipcTypes'
import {
  faceCastingPrompt, bodySheetPrompt, scenePlatePrompt, shotFramePrompt, SHOT_SIZE_CUE,
  panoramaScenePrompt, realismNegativeFor, sceneNegativeFor, emptySceneNegativeFor,
  frameCrowdNegativeFor, castingNegativeFor, stripOtherPersonClauses, mergeNegative,
  stripDialogueDirections, castLookForGenre, oocWardrobeNegativeFor, ageDriftNegativeFor,
  withNegativeOverride
} from '../../shared/imagePrompts'
import { resolveCreation } from '../../shared/creationSettings'
import { hardenLookEnList } from '../../shared/castAppearance'
import { mapPool } from './asyncPool'
import { ImageGenerateCancelled } from './imageService'
import { FIRST_FRAME_FACE_THRESHOLD } from './consistencyService'
import { genreCompatible } from './assetReuse'
import type { DirectorAgent } from './directorAgent'
import { pickPanoView, FEMALE_VOICES, MALE_VOICES, stageWorkflowOverride } from './directorConstants'
import {
  logImpl, setStageImpl, isCancelledImpl
} from './directorStateMachine'
import { notifyProjectUpdatedImpl } from './directorProgressBridge'
import { createLogger } from './logger'

const log = createLogger('DirAsset')

/**
 * 资产构建：角色定妆 / 道具 / 场景板 / 首尾帧。
 * 每个函数接收 agent 作为上下文（this. → agent.）。
 */

/** 单镜首帧 camera 净化：剥离镜头描述里的"第二人/背景人影"从句。
 *  历史角色名（Su Wan/Lin Chuan/苏晚/林川/李强）已从硬编码正则移除——它们是旧项目
 *  的特定角色名，新项目若同名会被误删。其他角色名由调用方 maskOtherIn 动态剥离。 */
export function sanitizeCameraForFrameImpl(camera: string): string {
  const segs = camera.split(/[,，]/).map(s => s.trim()).filter(Boolean)
  const keep = segs.filter(s => !/(?:another|other person|second person|background figure|blurred figure|out of focus|路人|人影|另一位|另一人|剪影)/i.test(s))
  return keep.join(', ')
}

export function buildCloseupEditPromptImpl(
  sceneHint: string,
  d: { as: { action?: string; emotion?: string; camera?: string; shotSize?: string; firstFrameEn?: string; lastFrameEn?: string; props?: string[] } },
  sizeCue: string,
  phase: 'start' | 'end' = 'start'
): string {
  const frameCue = phase === 'start'
    ? (d.as.action?.trim() || d.as.firstFrameEn?.trim())
    : (d.as.lastFrameEn?.trim() || d.as.action?.trim())
  const action = frameCue ? `，${frameCue}` : ''
  const emotion = d.as.emotion?.trim() ? `，${d.as.emotion.trim()}的表情` : ''
  const camera = d.as.camera?.trim() ? `，${sanitizeCameraForFrameImpl(d.as.camera)}` : ''
  const props = (d.as.props?.length ? d.as.props : []).join('、')
  const propLock = props
    ? `。画面中必须清晰出现本镜关键道具：${props}（手持或置于身前，不得缺失）`
    : `。动作描述中出现的手持道具必须清晰入画，置于手中或身前台面上，不得缺失`
  const tablewareBan = `。严禁出现与动作描述无关的碗、筷、勺、杯、盘、餐具、食物或任何手持容器，人物双手严格按动作描述摆放，否则双手自然下垂空置、不得持物`
  return `把图1中的人物放入场景「${sceneHint}」：${sizeCue}${action}${emotion}${camera}${propLock}${tablewareBan}。` +
    `人物按${sizeCue}景别完整入画（肢体不得截断、不裁剪），` +
    `人物姿态、视线方向、手持道具状态严格按动作描述执行（不得改为直视镜头，除非动作本就如此），` +
    `保持面部、发型、服装、肤色与图1完全一致；服装严格锁定为图1所示定妆（不得换成围裙、制服、马甲、领带、帽子、外套等任何未在定妆图中的服装）；` +
    `画面中除动作描述与关键道具外，不得出现任何其他物品、工具、容器、器械（严禁凭空添加台面杂物）；` +
    `画面中只能出现主体人物一人，严禁任何其他人物（不得有路人、第二张人脸、背景人影、镜像倒影人影、玻璃窗反射人影）；` +
    `背景完全替换为场景描述（不得保留图1原始背景、不得出现图1背景元素），` +
    `写实电影感，自然光影，背景符合场景氛围。`
}

export function buildPanoEditPromptImpl(
  lookEn: string,
  sceneHint: string,
  d: { as: { action?: string; emotion?: string; camera?: string; shotSize?: string; firstFrameEn?: string; lastFrameEn?: string; props?: string[] } },
  sizeCue: string,
  phase: 'start' | 'end' = 'start'
): string {
  const frameCue = phase === 'start'
    ? (d.as.action?.trim() || d.as.firstFrameEn?.trim())
    : (d.as.lastFrameEn?.trim() || d.as.action?.trim())
  const action = frameCue ? `，${frameCue}` : ''
  const emotion = d.as.emotion?.trim() ? `，${d.as.emotion.trim()}的表情` : ''
  const camera = d.as.camera?.trim() ? `，${sanitizeCameraForFrameImpl(d.as.camera)}` : ''
  const props = (d.as.props?.length ? d.as.props : []).join('、')
  const propLock = props
    ? `。画面中必须清晰出现本镜关键道具：${props}（手持或置于身前，不得缺失）`
    : `。动作描述中出现的手持道具必须清晰入画，置于手中或身前台面上，不得缺失`
  const tablewareBan = `。严禁出现与动作描述无关的碗、筷、勺、杯、盘、餐具、食物或任何手持容器，人物双手严格按动作描述摆放，否则双手自然下垂空置、不得持物`
  return `把图2中的人物放入图1的场景「${sceneHint}」：${sizeCue}${action}${emotion}${camera}${propLock}${tablewareBan}。` +
    `人物的面部、发型、服装、肤色与图2完全一致；服装严格锁定为图2所示定妆（不得换成围裙、制服、马甲、领带、帽子、外套等任何未在定妆图中的服装）；` +
    `人物姿态、视线方向、手持道具状态严格按动作描述执行（不得改为直视镜头，除非动作本就如此）；` +
    `画面中除动作描述与关键道具外，不得出现任何其他物品、工具、容器、器械（严禁凭空添加台面杂物）；` +
    `画面中只能出现主体人物一人，严禁任何其他人物（不得有路人、第二张人脸、背景人影、镜像倒影人影、玻璃窗反射人影）；` +
    `场景的空间布局、光线、色调、机位角度与图1完全一致（图1是该场景的全景方位图，全剧复用）；` +
    `写实电影感，自然光影，背景严格符合图1场景氛围，不得改成其他地点。`
}

/**
 * 多角色同框首帧提示词（P1-2）：每位角色各自一张定妆参考图，避免多人同框时只锁一人、
 * 其余人物靠文字生成导致换脸/串装。
 * scenePlateIncluded 决定图序：true = 图1场景板 + 图2..N 角色；false = 图1..N 角色（图1同时作构图基底）。
 */
export function buildMultiEditPromptImpl(
  sceneHint: string,
  d: { as: { action?: string; emotion?: string; camera?: string; shotSize?: string; firstFrameEn?: string; lastFrameEn?: string; props?: string[] } },
  sizeCue: string,
  personCount: number,
  scenePlateIncluded: boolean,
  phase: 'start' | 'end' = 'start'
): string {
  const frameCue = phase === 'start'
    ? (d.as.action?.trim() || d.as.firstFrameEn?.trim())
    : (d.as.lastFrameEn?.trim() || d.as.action?.trim())
  const action = frameCue ? `，${frameCue}` : ''
  const emotion = d.as.emotion?.trim() ? `，${d.as.emotion.trim()}的表情` : ''
  const camera = d.as.camera?.trim() ? `，${sanitizeCameraForFrameImpl(d.as.camera)}` : ''
  const props = (d.as.props?.length ? d.as.props : []).join('、')
  const propLock = props
    ? `。画面中必须清晰出现本镜关键道具：${props}（手持或置于身前，不得缺失）`
    : `。动作描述中出现的手持道具必须清晰入画，置于手中或身前台面上，不得缺失`
  const tablewareBan = `。严禁出现与动作描述无关的碗、筷、勺、杯、盘、餐具、食物或任何手持容器，人物双手严格按动作描述摆放，否则双手自然下垂空置、不得持物`
  const personIdx = scenePlateIncluded
    ? Array.from({ length: personCount }, (_, i) => i + 2)
    : Array.from({ length: personCount }, (_, i) => i + 1)
  const personRefs = personIdx.map(i => `图${i}`).join('、')
  const scenePhrase = scenePlateIncluded
    ? `把${personRefs}中的 ${personCount} 位人物一起放进图1的场景「${sceneHint}」`
    : `把${personRefs}中的 ${personCount} 位人物一起放在场景「${sceneHint}」`
  return `${scenePhrase}：${sizeCue}${action}${emotion}${camera}${propLock}${tablewareBan}。` +
    `${personRefs} 分别是 ${personCount} 位不同角色，每位人物的面部、发型、服装、肤色须与其各自定妆参考图完全一致，` +
    `严禁互换服装、串脸、把两人合并成一张脸；各自身份、性别、年龄、体态不得混淆；` +
    `人物姿态、视线方向、手持道具状态严格按动作描述执行（不得改为直视镜头，除非动作本就如此）；` +
    `画面中只允许上述 ${personCount} 位人物出现，严禁路人、额外人脸、背景人影、镜像倒影人影；` +
    (scenePlateIncluded
      ? `场景的空间布局、光线、色调、机位角度与图1完全一致（图1是该场景的全景方位图，全剧复用）；`
      : '') +
    `写实电影感，自然光影，背景严格符合场景氛围，不得改成其他地点。`
}

/** 角色建档：面部定妆 + 全身三视图；角色间有限并发，单图失败带重试 */
export async function buildCharactersImpl(
  agent: DirectorAgent,
  projectId: string,
  analysis: AnalyzeResult
): Promise<Map<string, Character>> {
  const result = new Map<string, Character>()
  let femaleIdx = 0
  let maleIdx = 0
  let doneCount = 0
  const total = analysis.characters.length
  const settingsSnap = await agent.settings.get()
  const concurrency = Math.max(1, Math.min(3, settingsSnap.render.assetConcurrency || 2))
  const ch = resolveCreation(settingsSnap).character
  const faceCount = Math.max(1, Math.min(4, ch.candidates || 1))
  const castingWf = stageWorkflowOverride(settingsSnap, 'casting')
  const wfOpt = castingWf ? { workflowName: castingWf } : ch.t2iWorkflow ? { workflowName: ch.t2iWorkflow } : {}
  const neg = { negative: withNegativeOverride(castingNegativeFor(ch.realismLock), settingsSnap.negatives, 'casting') }
  const abort = (): boolean => isCancelledImpl(agent, projectId)

  setStageImpl(agent, projectId, 'casting', 'running',
    `并发生成角色资产 0/${total}（并发 ${concurrency}，定妆抽卡×${faceCount}）...`, 5)

  // 时代锁：古风/年代剧注入 genre，定妆图按时代约束生成（杜绝现代服化道混入古装剧）
  const projectForGenre = await agent.store.get(projectId)
  const genre = projectForGenre?.genre

  const prepared = analysis.characters.map((ac) => {
    const id = `char_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const voice = ac.gender === 'male'
      ? MALE_VOICES[maleIdx++ % MALE_VOICES.length]
      : FEMALE_VOICES[femaleIdx++ % FEMALE_VOICES.length]
    const rawLookEn = /chinese|asian/i.test(ac.lookEn) ? ac.lookEn : `chinese, ${ac.lookEn}`
    // 古风/年代剧：建档源头即清洗现代服装词，定妆/首帧/渲染全链路使用同一份时代安全 lookEn
    const lookEn = castLookForGenre(rawLookEn, genre)
    return { ac, id, voice, lookEn }
  })

  // —— 硬门禁 v2：全角色 lookEn 结构化校验 ——
  const hardened = hardenLookEnList(prepared.map(p => p.lookEn), genre)
  for (const note of hardened.notes) {
    logImpl(agent, projectId, 'casting', 'warn', `lookEn 硬门禁：${note}`)
  }
  prepared.forEach((p, i) => { p.lookEn = hardened.looks[i] })

  await mapPool(prepared, concurrency, async ({ ac, id, voice, lookEn }) => {
    if (abort()) throw new ImageGenerateCancelled()
    const character: Character = {
      id,
      name: ac.name,
      refImagePath: '',
      description: ac.appearance,
      voice,
      appearanceLock: lookEn
    }
    const faceRel = `projects/${projectId}/characters/${id}_face.png`
    const bodyRel = `projects/${projectId}/characters/${id}_body.png`
    const genOpts = { shouldAbort: abort }

    try {
      const candRels: Array<{ rel: string; seed: number }> = []
      for (let ci = 0; ci < faceCount; ci++) {
        if (abort()) throw new ImageGenerateCancelled()
        const seed = ch.seedMode === 'fixed'
          ? (ch.seed + ci * 9973) >>> 0
          : Math.floor(Math.random() * 0xffffffff)
        const rel = faceCount === 1
          ? faceRel
          : `projects/${projectId}/characters/${id}_face_c${ci}.png`
        await agent.image.generate(
          faceCastingPrompt(lookEn, { realismLock: ch.realismLock, genre }),
          path.join(agent.baseDir, rel),
          { width: ch.faceWidth, height: ch.faceHeight, seed, ...wfOpt, ...neg, ...genOpts }
        )
        candRels.push({ rel, seed })
      }
      if (candRels.length === 1) {
        character.faceImagePath = candRels[0].rel
      } else {
        const items = await Promise.all(candRels.map(async (c, i) => {
          const abs = path.join(agent.baseDir, c.rel)
          let score = 0.5
          let note: string
          try {
            const st = await fs.stat(abs)
            score = Math.min(0.95, 0.4 + Math.log10(Math.max(1000, st.size)) / 10)
            note = `file=${Math.round(st.size / 1024)}KB`
          } catch { note = 'stat 失败' }
          return { id: `c${i}`, relativePath: c.rel, seed: c.seed, score, note }
        }))
        const picked = await agent.picker.pick({
          kind: 'character',
          brief: `角色「${ac.name}」定妆，外观锁定：${lookEn}`,
          candidates: items,
          llmPick: ch.llmPick
        })
        await agent.picker.promoteWinner({
          baseDir: agent.baseDir,
          winnerRel: picked.winner.relativePath,
          finalRel: faceRel,
          rejectedRels: picked.rejected.map(r => r.relativePath),
          keepRejected: true
        })
        character.faceImagePath = faceRel
        logImpl(agent, projectId, 'casting', 'info',
          `「${ac.name}」定妆抽卡 ${candRels.length}→1：${picked.reason}`)
      }
      character.refImagePath = character.faceImagePath || ''
    } catch (e) {
      if (e instanceof ImageGenerateCancelled) throw e
      logImpl(agent, projectId, 'casting', 'warn',
        `「${ac.name}」面部定妆失败：${e instanceof Error ? e.message : String(e)}`)
    }

    try {
      const bodySeed = ch.seedMode === 'fixed' ? ch.seed : Math.floor(Math.random() * 0xffffffff)
      await agent.image.generate(
        bodySheetPrompt(lookEn, { realismLock: ch.realismLock, genre }),
        path.join(agent.baseDir, bodyRel),
        { width: ch.bodyWidth, height: ch.bodyHeight, seed: bodySeed, ...wfOpt, ...neg, ...genOpts }
      )
      character.bodySheetPath = bodyRel
      if (!character.refImagePath) character.refImagePath = bodyRel
    } catch (e) {
      if (e instanceof ImageGenerateCancelled) throw e
      logImpl(agent, projectId, 'casting', 'warn',
        `「${ac.name}」三视图失败：${e instanceof Error ? e.message : String(e)}`)
    }

    if (!character.faceImagePath && !character.bodySheetPath) {
      character.description = `${ac.appearance}（定妆资产生成失败）`
    }

    result.set(ac.name, character)
    doneCount++
    setStageImpl(agent, projectId, 'casting', 'running',
      `并发生成角色资产 ${doneCount}/${total}...`,
      Math.round((doneCount / Math.max(1, total)) * 100))
  }, { shouldAbort: abort })

  try {
    const project = await agent.store.get(projectId)
    project.characters = [...result.values()]
    await agent.store.save(project)
    notifyProjectUpdatedImpl(agent, projectId)
  } catch {
    // 保存失败由后续阶段暴露
  }

  const allFailed = [...result.values()].every(c => !c.faceImagePath && !c.bodySheetPath && !c.refImagePath)
  setStageImpl(agent, projectId, 'casting',
    allFailed ? 'error' : 'done',
    allFailed
      ? '全部角色资产生成失败，请检查 ComfyUI'
      : `已建档 ${result.size} 个角色（面部+三视图，并发 ${concurrency}）`,
    allFailed ? 0 : 100)

  return result
}

export async function buildPropAssetsImpl(
  agent: DirectorAgent,
  projectId: string,
  analysis: AnalyzeResult
): Promise<void> {
  const props = analysis.props || []
  if (props.length === 0) return
  const settingsSnap = await agent.settings.get()
  const concurrency = Math.max(1, Math.min(3, settingsSnap.render.assetConcurrency || 2))
  const ch = resolveCreation(settingsSnap).character
  const propWf = stageWorkflowOverride(settingsSnap, 'prop')
  const wfOpt = propWf ? { workflowName: propWf } : ch.t2iWorkflow ? { workflowName: ch.t2iWorkflow } : { workflowName: 'klein_t2i_clean' }
  const neg = { negative: withNegativeOverride(sceneNegativeFor(ch.realismLock), settingsSnap.negatives, 'prop') }
  const abort = (): boolean => isCancelledImpl(agent, projectId)
  let doneCount = 0

  logImpl(agent, projectId, 'casting', 'info',
    `生成道具资产 0/${props.length}（${props.map(p => p.zh).join('、')}）...`)
  await mapPool(props, concurrency, async (prop, _i) => {
    if (abort()) throw new ImageGenerateCancelled()
    const propsDir = path.join(agent.baseDir, 'projects', projectId, 'props')
    const propAbs = path.join(propsDir, `${prop.id}.png`)
    const lookText = prop.description
      ? `${prop.en}, ${prop.description}`
      : `${prop.en}`
    try {
      await agent.image.generate(
        `${lookText}, isolated prop asset for film production, centered on plain light-gray studio background, soft even lighting, subtle drop shadow, sharp focus, high detail, photorealistic, front three-quarter view, no person, no hands`,
        propAbs,
        { width: 768, height: 768, ...wfOpt, ...neg, shouldAbort: abort }
      )
      prop.imagePath = `projects/${projectId}/props/${prop.id}.png`
    } catch (e) {
      if (e instanceof ImageGenerateCancelled || /CANCELLED/i.test(String(e))) throw e
      logImpl(agent, projectId, 'casting', 'warn', `道具「${prop.zh}」定妆图生成失败：${e instanceof Error ? e.message : String(e)}`)
    }
    doneCount += 1
    logImpl(agent, projectId, 'casting', 'info', `并发生成道具资产 ${doneCount}/${props.length}...`)
  }, { shouldAbort: abort })

  try {
    const project = await agent.store.get(projectId)
    project.props = props
    await agent.store.save(project)
    notifyProjectUpdatedImpl(agent, projectId)
  } catch {
    // 保存失败由后续阶段暴露
  }
  const okCount = props.filter(p => p.imagePath).length
  if (okCount > 0) {
    logImpl(agent, projectId, 'casting', 'info', `道具定妆图 ${okCount}/${props.length} 生成完成（渲染锁形参考）`)
  }
}

/**
 * T2I 资产复用回退（场景板生成失败兜底）：从资产库项目按场景出场顺序复制场景板。
 */
export async function tryReuseSceneBoardImpl(
  agent: DirectorAgent,
  projectId: string,
  board: SceneBoard,
  bi: number
): Promise<string | undefined> {
  let fbId: string | undefined
  try { fbId = (await agent.settings.get()).render?.assetFallbackProjectId } catch { return undefined }
  if (!fbId) return undefined
  let fb: Project
  try { fb = await agent.store.get(fbId) } catch { return undefined }
  try {
    const cur = await agent.store.get(projectId)
    if (!genreCompatible(fb.genre, cur.genre)) {
      logImpl(agent, projectId, 'scenes', 'warn',
        `场景板 T2I 回退跳过：资产库项目 ${fbId} 题材(${fb.genre || '未知'}) 与本剧题材(${cur.genre || '未知'}) 不一致，禁止跨题材复用场景板`)
      return undefined
    }
  } catch { return undefined }
  const pool = (fb.sceneBoards || []).filter(b => b.emptyPlatePath)
  if (!pool.length) return undefined
  const src = pool[Math.min(Math.max(0, bi), pool.length - 1)]
  const rel = `projects/${projectId}/scenes/${board.id}_plate.png`
  try {
    await fs.mkdir(path.join(agent.baseDir, 'projects', projectId, 'scenes'), { recursive: true })
    await fs.copyFile(path.join(agent.baseDir, src.emptyPlatePath!), path.join(agent.baseDir, rel))
    board.emptyPlatePath = rel
    board.panoViews = [rel]
    return fbId
  } catch {
    return undefined
  }
}

/** 场景英文短语兜底：分析结果缺 sceneEn 时用 LLM 补写并回写同场景分镜 */
export async function ensureSceneEnImpl(
  agent: DirectorAgent,
  projectId: string,
  uniqueScenes: Array<{ key: string; name: string; sceneEn?: string; emotion?: string }>,
  analysis: AnalyzeResult
): Promise<void> {
  const missing = uniqueScenes.filter(
    u => (u.sceneEn || '').trim().split(/\s+/).filter(Boolean).length < 8
  )
  if (!missing.length) return
  for (const u of missing) {
    try {
      const peers = analysis.shots.filter(s => normalizeSceneKey(s.scene || 'unnamed') === u.key)
      const actionCtx = peers.slice(0, 3).map(s => s.action || '').filter(Boolean).join(' | ')
      const en = await agent.llm.fillPromptField(
        {
          field: 'sceneEn',
          label: '环境短语（英文，驱动场景板/全景 T2I）',
          lang: 'en',
          range: [30, 60],
          role: '本镜场景的英文环境短语：先明确室内/室外（interior 或 exterior）+ 地点物理结构与陈设 + 时代特征 + 光线（时刻/主光方向/色温）+ 材质纹理 + 氛围；只写环境不写人物；室内场景严禁写成街道/户外',
          mustAvoid: ['人物', '把室内写成户外', 'Markdown', '解释性文字']
        },
        { scene: u.name, action: actionCtx, currentText: u.sceneEn || '' }
      )
      u.sceneEn = en
      logImpl(agent, projectId, 'scenes', 'info', `场景「${u.name}」英文环境短语已补写`)
    } catch (e) {
      logImpl(agent, projectId, 'scenes', 'warn',
        `场景「${u.name}」英文环境短语补写失败（回退中文名）：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const byKey = new Map(uniqueScenes.filter(u => u.sceneEn).map(u => [u.key, u.sceneEn!]))
  for (const as of analysis.shots) {
    const en = byKey.get(normalizeSceneKey(as.scene || 'unnamed'))
    if (en) as.sceneEn = en
  }
}

/**
 * 单镜首帧生成（人物镜 i2v）——供 buildShots 建档与「重建首帧」共用。
 */
export async function generateShotFirstFrameImpl(
  agent: DirectorAgent,
  projectId: string,
  d: {
    id: string
    index: number
    as: AnalyzeResult['shots'][number]
    board?: SceneBoard
    characterIds: string[]
    character?: Character
    characters?: Character[]
    firstFramePath?: string
  },
  sc: { frameWidth: number; frameHeight: number },
  abort: () => boolean,
  allCharacterNames: string[] = []
): Promise<void> {
  const look = d.character?.appearanceLock || 'chinese person, natural everyday appearance'
  const settingsSnap = await agent.settings.get()
  // P1-3: i2i 参考图权重（denoise）可调，越界回退默认 1（保持既有出图行为）
  const rawDenoise = Number(settingsSnap.render?.i2iDenoise)
  const denoiseStrength = Number.isFinite(rawDenoise) ? Math.max(0.1, Math.min(1, rawDenoise)) : 1
  const rawThreshold = Number(settingsSnap.render?.firstFrameFaceThreshold)
  const faceThreshold = Number.isFinite(rawThreshold) ? Math.max(0.1, Math.min(1, rawThreshold)) : FIRST_FRAME_FACE_THRESHOLD
  const sizeCue = SHOT_SIZE_CUE[d.as.shotSize || 'medium']
  const env = d.as.sceneEn || d.as.scene
  const maskOtherIn = (t: string): string => {
    const others = allCharacterNames.filter(n => n && n !== d.character?.name)
    let s = t
    if (others.length) {
      const re = new RegExp(others.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
      s = s.replace(re, 'the off-screen partner (NOT visible in frame)')
    }
    const GROUP_RE = /\b(escort team|the escort team|his escort team|the escort|escorts?|guards?|followers?|entourage|retinue|the team|his team|the party|group of escorts)\b/gi
    s = s.replace(GROUP_RE, 'distant background silhouettes of the convoy (NOT in the foreground, not a second person)')
    return stripOtherPersonClauses(s)
  }
  const shotSceneDesc = maskOtherIn(d.as.continuity?.trim() || d.as.action?.trim() || '')
  const plateHint = (d.board?.emptyPlatePath
    ? `matching the empty location plate mood of ${env}`
    : env) + (shotSceneDesc ? `；本镜场景：${shotSceneDesc}` : '')
  const firstRel = `projects/${projectId}/shots/${d.id}_first.png`
  const firstAbs = path.join(agent.baseDir, firstRel)
  // P1-2：同框角色各自的定妆图（最多 3 张，超出部分由文字约束兜底）
  const facesAbs: string[] = []
  for (const c of (d.characters?.length ? d.characters : d.character ? [d.character] : [])) {
    if (!c.faceImagePath) continue
    const p = path.join(agent.baseDir, c.faceImagePath)
    if (!facesAbs.includes(p)) facesAbs.push(p)
    if (facesAbs.length >= 3) break
  }
  const faceAbs = facesAbs[0] || ''
  const dMasked = {
    ...d,
    as: {
      ...d.as,
      action: maskOtherIn(d.as.action?.trim() || ''),
      continuity: maskOtherIn(d.as.continuity?.trim() || ''),
      // camera 也先动态屏蔽其他角色名（历史硬编码名单已移除），再做通用第二人从句剥离
      camera: sanitizeCameraForFrameImpl(maskOtherIn(d.as.camera?.trim() || ''))
    }
  }

  /**
   * 首帧产出过程（单图融合 → 全景双图 → 文生兜底）。
   * 抽成闭包以便低相似度时用同一套参数重抽一次。
   */
  const produceFirstFrame = async (): Promise<void> => {
    let fusionRoot = ''
    let copiedFromFace = false
    // P1-2：多角色同框优先走逐角色参考图（图1场景板/[图1角色A] + 每位角色各一张定妆）
    if (facesAbs.length >= 2) {
      try {
        const panoViewRel = pickPanoView(d.as.camera, d.board?.panoViews)
        const refs = panoViewRel
          ? [path.join(agent.baseDir, panoViewRel), ...facesAbs]
          : facesAbs
        await agent.image.generate(
          buildMultiEditPromptImpl(plateHint, dMasked, sizeCue, facesAbs.length, Boolean(panoViewRel), 'start'),
          firstAbs,
          {
            workflowName: 'qwen2511_i2i_multi',
            referenceImagePaths: refs,
            strictWorkflow: true,
            denoise: denoiseStrength,
            shouldAbort: abort
          }
        )
        d.firstFramePath = firstRel
      } catch (e) {
        if (e instanceof ImageGenerateCancelled) throw e
        fusionRoot = e instanceof Error ? e.message : String(e)
        logImpl(agent, projectId, 'scenes', 'warn',
          `第${d.index}镜多角色融合失败（${fusionRoot}），回退单角色融合`)
      }
    }
    if (!d.firstFramePath && faceAbs) {
      try {
        await agent.image.generate(
          buildCloseupEditPromptImpl(plateHint, dMasked, sizeCue, 'start'),
          firstAbs,
          {
            workflowName: 'qwen2511_i2i_edit',
            referenceImagePath: faceAbs,
            denoise: denoiseStrength,
            shouldAbort: abort
          }
        )
        d.firstFramePath = firstRel
      } catch (e) {
        if (e instanceof ImageGenerateCancelled) throw e
        fusionRoot = e instanceof Error ? e.message : String(e)
        logImpl(agent, projectId, 'scenes', 'warn',
          `第${d.index}镜单图定妆融合失败（${fusionRoot}），尝试全景双图融合`)
        const panoViewRel = pickPanoView(d.as.camera, d.board?.panoViews)
        if (panoViewRel) {
          try {
            await agent.image.generate(
              buildPanoEditPromptImpl(look, plateHint, dMasked, sizeCue, 'start'),
              firstAbs,
              {
                workflowName: 'qwen2511_i2i_two',
                referenceImagePaths: [path.join(agent.baseDir, panoViewRel), faceAbs],
                strictWorkflow: true,
                denoise: denoiseStrength,
                shouldAbort: abort
              }
            )
            d.firstFramePath = firstRel
          } catch (e2) {
            if (e2 instanceof ImageGenerateCancelled) throw e2
            fusionRoot = e2 instanceof Error ? e2.message : String(e2)
            logImpl(agent, projectId, 'scenes', 'warn',
              `第${d.index}镜全景双图融合失败（${fusionRoot}）`)
          }
        }
      }
    }
    if (!d.firstFramePath && faceAbs) {
      const fusionFallback = (await agent.settings.get()).render.fusionFallback
      if (fusionFallback !== 'allow') {
        throw new Error(
          `首帧融合失败（第${d.index}镜）：${fusionRoot || '单图/双图融合均未产出首帧'}，已 halt（fusionFallback=block）；修复工作流/模型后 resume`)
      }
    }
    if (!d.firstFramePath) {
      try {
        const frameAction = dMasked.as.action?.trim() || dMasked.as.firstFrameEn?.trim() || ''
        await agent.image.generate(
          shotFramePrompt({
            phase: 'start',
            lookEn: look,
            scene: plateHint,
            action: frameAction,
            shotSizeCue: sizeCue,
            emotion: dMasked.as.emotion || undefined,
            camera: dMasked.as.camera || undefined,
            lighting: dMasked.as.lighting,
            facing: dMasked.as.facing,
            continuity: dMasked.as.continuity,
            characterCount: d.characterIds.length || 1,
            props: d.as.props
          }),
          firstAbs,
          {
            width: sc.frameWidth, height: sc.frameHeight, shouldAbort: abort,
            negative: withNegativeOverride(mergeNegative(realismNegativeFor('standard'), frameCrowdNegativeFor(d.characterIds.length || 1), oocWardrobeNegativeFor(look || ''), ageDriftNegativeFor(look || '')), settingsSnap.negatives, 'shot'),
            workflowName: stageWorkflowOverride(settingsSnap, 'shot') || 'klein_t2i_clean'
          }
        )
        d.firstFramePath = firstRel
      } catch (e) {
        if (e instanceof ImageGenerateCancelled) throw e
        if (faceAbs) {
          try {
            await fs.copyFile(faceAbs, firstAbs)
            d.firstFramePath = firstRel
            copiedFromFace = true
          } catch { /* 三级都失败：留空，渲染时回退定妆图 */ }
        }
      }
    }
    // P1-3: face restore 后处理（CodeFormer），修复 i2i 融合导致的五官漂移；
    // 定妆图直接复制成首帧时无需修复。
    if (d.firstFramePath && faceAbs && !copiedFromFace) {
      try {
        const restoredAbs = firstAbs.replace(/\.png$/, '_fr.png')
        await agent.image.restoreFace(firstAbs, restoredAbs)
        await fs.rename(restoredAbs, firstAbs)
      } catch { /* face restore 失败不阻塞 */ }
    }
  }

  await produceFirstFrame()

  // P1-1: 首帧-定妆照人脸相似度比对（多人同框取最低分）；低于阈值用同参数重抽 1 次，仍低只告警不阻塞。
  if (d.firstFramePath && facesAbs.length && typeof agent.queue?.compareImages === 'function') {
    const compareImages = agent.queue.compareImages.bind(agent.queue)
    const worstFaceScore = async (): Promise<number | null> => {
      const scores: number[] = []
      for (const f of facesAbs) {
        const r = await compareImages(f, firstAbs)
        if (r && r.method === 'face') scores.push(r.score)
      }
      return scores.length ? Math.min(...scores) : null
    }
    try {
      const score = await worstFaceScore()
      if (score !== null) {
        logImpl(agent, projectId, 'scenes', 'info',
          `第${d.index}镜首帧人脸相似度 ${score.toFixed(3)}（阈值 ${faceThreshold}${facesAbs.length > 1 ? `，${facesAbs.length} 人取最低` : ''}）`)
        if (score < faceThreshold) {
          logImpl(agent, projectId, 'scenes', 'warn',
            `第${d.index}镜首帧人脸相似度偏低（${score.toFixed(3)} < ${faceThreshold}），自动重抽 1 次`)
          const prevFirst = d.firstFramePath
          d.firstFramePath = undefined
          try {
            await produceFirstFrame()
          } catch (e) {
            if (e instanceof ImageGenerateCancelled) throw e
            // 重抽失败保留原首帧，不让自检拖垮流水线
            d.firstFramePath = prevFirst
            logImpl(agent, projectId, 'scenes', 'warn',
              `第${d.index}镜重抽失败，保留原首帧：${e instanceof Error ? e.message : String(e)}`)
            return
          }
          if (d.firstFramePath) {
            const second = await worstFaceScore()
            if (second !== null && second < faceThreshold) {
              logImpl(agent, projectId, 'scenes', 'warn',
                `第${d.index}镜重抽后相似度仍偏低（${second.toFixed(3)}），已放行，可在分镜页手动重出首帧`)
            } else if (second !== null) {
              logImpl(agent, projectId, 'scenes', 'info',
                `第${d.index}镜重抽后相似度 ${second.toFixed(3)}`)
            }
          }
        }
      }
    } catch (e) {
      // 自检依赖不可用/解码失败：只记录，不影响首帧产出
      log.warn(`首帧相似度自检失败（不阻塞）: ${e instanceof Error ? e.message : e}`)
    }
  }
}

export async function buildShotsImpl(
  agent: DirectorAgent,
  projectId: string,
  analysis: AnalyzeResult,
  characterMap: Map<string, Character>
): Promise<void> {
  const s = await agent.settings.get()
  const shots: Shot[] = []
  const total = analysis.shots.length
  let frameFailed = 0
  let project = await agent.store.get(projectId)

  await fs.mkdir(path.join(agent.baseDir, 'projects', projectId, 'scenes'), { recursive: true })

  // —— 1) 场景板库：按场景键去重生成无人空场景 ——
  const boardByKey = new Map<string, SceneBoard>()
  const uniqueScenes: Array<{ key: string; name: string; sceneEn?: string; emotion?: string }> = []
  for (const as of analysis.shots) {
    const key = normalizeSceneKey(as.scene || 'unnamed')
    if (boardByKey.has(key) || uniqueScenes.some(u => u.key === key)) continue
    uniqueScenes.push({
      key,
      name: as.scene || 'unnamed',
      sceneEn: as.sceneEn,
      emotion: as.emotion
    })
  }

  await ensureSceneEnImpl(agent, projectId, uniqueScenes, analysis)

  const settingsSnap = await agent.settings.get()
  const concurrency = Math.max(1, Math.min(3, settingsSnap.render.assetConcurrency || 2))
  const sc = resolveCreation(settingsSnap).scene
  const plateCount = Math.max(1, Math.min(4, sc.candidates || 1))
  const plateOpts = {
    weatherHint: sc.weatherHint,
    emptyStrict: sc.emptyStrict
  }
  const panoOn = sc.panorama !== false
  const panoViewsCount = Math.max(2, Math.min(6, sc.panoViewsCount || 4))
  const sceneWf = stageWorkflowOverride(settingsSnap, 'scene') || 'klein_t2i_clean'
  const shotWf = stageWorkflowOverride(settingsSnap, 'shot') || 'klein_t2i_clean'
  const abort = (): boolean => isCancelledImpl(agent, projectId)
  let platesDone = 0
  setStageImpl(agent, projectId, 'scenes', 'running',
    `并发生成${panoOn ? `全景场景板（裁${panoViewsCount}方位）` : '场景板'} 0/${uniqueScenes.length}（并发 ${concurrency}${panoOn ? '' : `，抽卡×${plateCount}`}）...`, 5)

  await mapPool(uniqueScenes, concurrency, async (u, bi) => {
    if (abort()) throw new ImageGenerateCancelled()
    const boardId = `scene_${Date.now()}_${bi}_${Math.random().toString(36).slice(2, 6)}`
    const plateRel = `projects/${projectId}/scenes/${boardId}_plate.png`
    const board: SceneBoard = {
      id: boardId,
      key: u.key,
      name: u.name,
      description: u.sceneEn || u.name,
      emptyPlatePath: ''
    }
    try {
      if (panoOn) {
        const scenesDir = path.join(agent.baseDir, 'projects', projectId, 'scenes')
        const panoRel = `projects/${projectId}/scenes/${boardId}_pano.png`
        const panoAbs = path.join(agent.baseDir, panoRel)
        const seed = Math.floor(Math.random() * 0xffffffff)
        await agent.image.generate(
          panoramaScenePrompt(u.sceneEn || u.name, u.emotion || undefined, { weatherHint: sc.weatherHint }),
          panoAbs,
          { width: 1536, height: 768, seed, negative: withNegativeOverride(emptySceneNegativeFor('standard', u.sceneEn || u.name), settingsSnap.negatives, 'scene'), shouldAbort: abort, workflowName: sceneWf }
        )
        const viewsAbs = await agent.ffmpeg.cropPanoramaViews(panoAbs, scenesDir, {
          count: panoViewsCount,
          outW: 480,
          outH: 864,
          prefix: boardId
        })
        board.panoPath = panoRel
        board.panoViews = viewsAbs.map(v => `projects/${projectId}/scenes/${path.basename(v)}`)
        try {
          const gridRel = `projects/${projectId}/scenes/${boardId}_pano_grid.png`
          await agent.ffmpeg.tileImages(viewsAbs, path.join(agent.baseDir, gridRel), {
            cols: 2, cellW: 384, cellH: 691
          })
          board.panoGrid = gridRel
        } catch (e) {
          logImpl(agent, projectId, 'scenes', 'warn',
            `场景「${u.name}」宫格看板拼接失败：${e instanceof Error ? e.message : String(e)}`)
        }
        board.emptyPlatePath = board.panoViews[0]
        logImpl(agent, projectId, 'scenes', 'info',
          `场景「${u.name}」全景图生成 + 裁 ${board.panoViews.length} 方位（0°起逆时针）`)
      } else {
        const candRels: Array<{ rel: string; seed: number }> = []
        for (let ci = 0; ci < plateCount; ci++) {
          if (abort()) throw new ImageGenerateCancelled()
          const seed = Math.floor(Math.random() * 0xffffffff)
          const rel = plateCount === 1
            ? plateRel
            : `projects/${projectId}/scenes/${boardId}_plate_c${ci}.png`
          await agent.image.generate(
            scenePlatePrompt(u.sceneEn || u.name, u.emotion || undefined, plateOpts),
            path.join(agent.baseDir, rel),
            { width: sc.plateWidth, height: sc.plateHeight, seed, negative: withNegativeOverride(emptySceneNegativeFor('standard', u.sceneEn || u.name), settingsSnap.negatives, 'scene'), shouldAbort: abort, workflowName: sceneWf }
          )
          candRels.push({ rel, seed })
        }
        if (candRels.length === 1) {
          board.emptyPlatePath = candRels[0].rel
        } else {
          const items = await Promise.all(candRels.map(async (c, i) => {
            let score = 0.5
            let note = sc.emptyStrict ? '期望无人空镜' : '场景板'
            try {
              const st = await fs.stat(path.join(agent.baseDir, c.rel))
              score = Math.min(0.95, 0.4 + Math.log10(Math.max(1000, st.size)) / 10)
              note += `；file=${Math.round(st.size / 1024)}KB`
            } catch { /* ignore */ }
            return { id: `s${i}`, relativePath: c.rel, seed: c.seed, score, note }
          }))
          const picked = await agent.picker.pick({
            kind: 'scene',
            brief: `场景「${u.name}」空场景板，英文：${u.sceneEn || u.name}，情绪：${u.emotion || 'n/a'}，天气：${sc.weatherHint}`,
            candidates: items,
            llmPick: sc.llmPick
          })
          await agent.picker.promoteWinner({
            baseDir: agent.baseDir,
            winnerRel: picked.winner.relativePath,
            finalRel: plateRel,
            rejectedRels: picked.rejected.map(r => r.relativePath),
            keepRejected: true
          })
          board.emptyPlatePath = plateRel
          logImpl(agent, projectId, 'scenes', 'info',
            `场景「${u.name}」抽卡 ${candRels.length}→1：${picked.reason}`)
        }
      }
    } catch (e) {
      if (e instanceof ImageGenerateCancelled) throw e
      logImpl(agent, projectId, 'scenes', 'warn',
        `场景板「${u.name}」失败：${e instanceof Error ? e.message : String(e)}`)
      const reusedFrom = await tryReuseSceneBoardImpl(agent, projectId, board, bi)
      if (reusedFrom) {
        logImpl(agent, projectId, 'scenes', 'warn',
          `场景「${u.name}」已从资产库项目 ${reusedFrom} 复用场景板（T2I 回退，第 ${bi + 1} 位）`)
      }
    }
    boardByKey.set(u.key, board)
    platesDone++
    setStageImpl(agent, projectId, 'scenes', 'running',
      `并发生成场景板 ${platesDone}/${uniqueScenes.length}...`,
      Math.round(5 + (platesDone / Math.max(1, uniqueScenes.length)) * 25))
  }, { shouldAbort: abort })

  try {
    const project = await agent.store.get(projectId)
    project.sceneBoards = [...boardByKey.values()]
    await agent.store.save(project)
    notifyProjectUpdatedImpl(agent, projectId)
  } catch {
    // 后续写 shots 时一并暴露
  }

  const prevLastByChar = new Map<string, string>()

  type Draft = {
    id: string
    index: number
    as: AnalyzeResult['shots'][number]
    board?: SceneBoard
    characterIds: string[]
    character?: Character
    characters?: Character[]
    sceneImagePath?: string
    firstFramePath?: string
    lastFramePath?: string
  }

  const drafts: Draft[] = analysis.shots.map((as, i) => {
    const id = `shot_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`
    const sceneKey = normalizeSceneKey(as.scene || 'unnamed')
    const board = boardByKey.get(sceneKey)
    let characterIds: string[] = []
    let character: Character | undefined
    let characters: Character[] | undefined
    if (as.type === 'i2v') {
      // P1-2：同镜多人时按 characters 名单逐个解析定妆图；characterName 作为兼容兜底
      const names = [...(as.characters || []), ...(as.characterName ? [as.characterName] : [])]
      const resolved: Character[] = []
      for (const n of names) {
        const c = characterMap.get(n)
        if (c && !resolved.some(x => x.id === c.id)) resolved.push(c)
      }
      character = resolved[0]
      characters = resolved.length > 1 ? resolved.slice(0, 3) : undefined
      characterIds = resolved.map(c => c.id)
    }
    return { id, index: i + 1, as, board, characterIds, character, characters }
  })

  // —— 2a) 首帧 / 空镜参考：有限并发 ——
  let framesDone = 0
  setStageImpl(agent, projectId, 'scenes', 'running',
    `并发生成镜头首帧 0/${total}...`, 30)

  await mapPool(drafts, concurrency, async (d) => {
    if (abort()) throw new ImageGenerateCancelled()
    try {
      if (d.as.type === 't2v') {
        if (d.board?.emptyPlatePath) {
          d.sceneImagePath = d.board.emptyPlatePath
        } else {
          const frameRel = `projects/${projectId}/shots/${d.id}_scene.png`
          await agent.image.generate(
            scenePlatePrompt(d.as.sceneEn || d.as.scene, d.as.emotion || undefined, plateOpts),
            path.join(agent.baseDir, frameRel),
            { width: sc.plateWidth, height: sc.plateHeight, shouldAbort: abort }
          )
          d.sceneImagePath = frameRel
        }
      } else {
        await generateShotFirstFrameImpl(agent, projectId, d, sc, abort, project.characters.map(c => c.name))
      }
    } catch (e) {
      if (e instanceof ImageGenerateCancelled) throw e
      frameFailed++
      logImpl(agent, projectId, 'scenes', 'warn',
        `第${d.index}镜首帧失败：${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
    framesDone++
    setStageImpl(agent, projectId, 'scenes', 'running',
      `并发生成镜头首帧 ${framesDone}/${total}...`,
      Math.round(30 + (framesDone / Math.max(1, total)) * 40))
  }, { shouldAbort: abort })

  // —— 2b) 尾帧串行：按镜序承接同角色连续性 ——
  setStageImpl(agent, projectId, 'scenes', 'running', '生成连镜尾帧...', 75)
  for (const d of drafts) {
    if (abort()) break
    if (d.as.type !== 'i2v') continue
    const isCloseup = (d.as.shotSize || 'medium') === 'closeup'
    if (isCloseup) {
      if (d.character && d.firstFramePath) prevLastByChar.set(d.character.id, d.firstFramePath)
    }
    if (!d.as.lastFrameEn?.trim()) continue
    try {
      const look = d.character?.appearanceLock || 'chinese person, natural everyday appearance'
      const sizeCue = SHOT_SIZE_CUE[d.as.shotSize || 'medium']
      const env = d.as.sceneEn || d.as.scene
      const plateHint = d.board?.emptyPlatePath
        ? `matching the empty location plate mood of ${env}`
        : env
      const continuityCue = d.character && prevLastByChar.has(d.character.id)
        ? 'strict visual continuity from previous shot end pose of the SAME person, identical face wardrobe hair'
        : ''
      const lastRel = `projects/${projectId}/shots/${d.id}_last.png`
      const lastCue = d.as.lastFrameEn?.trim() || d.as.action
      await agent.image.generate(
        shotFramePrompt({
          phase: 'end',
          lookEn: look,
          scene: plateHint,
          action: lastCue,
          shotSizeCue: sizeCue,
          emotion: d.as.emotion || undefined,
          continuity: continuityCue || d.as.continuity || undefined,
          camera: d.as.camera || undefined,
          lighting: d.as.lighting,
          facing: d.as.facing,
          characterCount: d.characterIds.length || 1,
          props: d.as.props
        }),
        path.join(agent.baseDir, lastRel),
        {
          width: sc.frameWidth, height: sc.frameHeight, shouldAbort: abort,
          negative: withNegativeOverride(mergeNegative(realismNegativeFor('standard'), frameCrowdNegativeFor(d.characterIds.length || 1), oocWardrobeNegativeFor(look || ''), ageDriftNegativeFor(look || '')), settingsSnap.negatives, 'shot'),
          workflowName: shotWf
        }
      )
      d.lastFramePath = lastRel
      if (d.character) prevLastByChar.set(d.character.id, lastRel)
    } catch (e) {
      if (e instanceof ImageGenerateCancelled) throw e
      frameFailed++
      logImpl(agent, projectId, 'scenes', 'warn',
        `第${d.index}镜尾帧失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  for (const d of drafts) {
    shots.push({
      id: d.id,
      index: d.index,
      scene: d.as.scene,
      action: d.as.action,
      dialogue: stripDialogueDirections(d.as.dialogue),
      characterIds: d.characterIds,
      type: d.as.type,
      width: s.render.defaultWidth,
      height: s.render.defaultHeight,
      frames: s.render.defaultFrames,
      seed: Math.floor(Math.random() * 0xffffffff),
      shotSize: d.as.type === 'i2v' ? (d.as.shotSize || 'medium') : undefined,
      camera: d.as.camera || undefined,
      transition: d.as.transition === 'hard' || d.as.transition === 'dissolve' || d.as.transition === 'smash'
        ? d.as.transition
        : undefined,
      emotion: d.as.emotion || undefined,
      lighting: d.as.lighting || undefined,
      facing: d.as.facing || undefined,
      continuity: d.as.continuity || undefined,
      props: d.as.props,
      promptEn: d.as.promptEn,
      negativeEn: d.as.negativeEn,
      sceneEn: d.as.sceneEn,
      frameSeconds: d.as.frameSeconds,
      firstFrameEn: d.as.firstFrameEn,
      midFrameEn: d.as.midFrameEn,
      lastFrameEn: d.as.lastFrameEn,
      handoffToNext: d.as.handoffToNext,
      transitionEn: d.as.transitionEn,
      sceneBoardId: d.board?.id,
      sceneImagePath: d.sceneImagePath,
      firstFramePath: d.firstFramePath,
      lastFramePath: d.lastFramePath,
      status: 'pending'
    })
  }

  project = await agent.store.get(projectId)
  project.sceneBoards = [...boardByKey.values()]
  project.shots = shots
  await agent.store.save(project)

  const state = agent.states.get(projectId)!
  state.totalShots = shots.length

  const t2vTotal = shots.filter(x => x.type === 't2v').length
  const t2vFailed = shots.filter(s => s.type === 't2v' && !s.sceneImagePath && !s.sceneBoardId).length
  const boardsOk = [...boardByKey.values()].filter(b => b.emptyPlatePath).length
  const t2vFatal = t2vTotal > 0 && t2vFailed === t2vTotal && boardsOk === 0
  setStageImpl(agent, projectId, 'scenes',
    t2vFatal ? 'error' : 'done',
    t2vFatal
      ? `场景板与首尾帧生成失败`
      : frameFailed
        ? `场景板 ${boardsOk}/${boardByKey.size}，分镜 ${shots.length}，${frameFailed} 镜帧失败已回退`
        : `场景板 ${boardsOk} 张，分镜 ${shots.length} 个（含首尾帧）`,
    100)
}
