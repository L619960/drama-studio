import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { ImageService, ImageGenerateCancelled } from './imageService'
import { mapPool } from './asyncPool'
import type { AnalyzeResult, Character, Project } from '../../shared/ipcTypes'
import { validateCharacterAssets } from './roleBinding'
import { genreCompatible } from './assetReuse'
import {
  faceCastingPrompt, bodySheetPrompt, sceneNegativeFor, castingNegativeFor, castLookForGenre
} from '../../shared/imagePrompts'
import { hardenLookEnList, hardenLookWeapons } from '../../shared/castAppearance'
import { resolveCreation } from '../../shared/creationSettings'
import type { DirectorStageRuntime } from './directorStageAssets'

// 按性别轮转分配音色
const FEMALE_VOICES = ['zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural']
const MALE_VOICES = ['zh-CN-YunjianNeural', 'zh-CN-YunyeNeural', 'zh-CN-YunjieNeural']

/** 角色建档：面部定妆 + 全身三视图；角色间有限并发，单图失败带重试 */
export async function buildCharacters(
  rt: DirectorStageRuntime,
  projectId: string,
  analysis: AnalyzeResult
): Promise<Map<string, Character>> {
  const result = new Map<string, Character>()
  let femaleIdx = 0
  let maleIdx = 0
  let doneCount = 0
  const total = analysis.characters.length
  const settingsSnap = await rt.settings.get()
  const concurrency = Math.max(1, Math.min(3, settingsSnap.render.assetConcurrency || 2))
  const ch = resolveCreation(settingsSnap).character
  const faceCount = Math.max(1, Math.min(4, ch.candidates || 1))
  const wfOpt = ch.t2iWorkflow ? { workflowName: ch.t2iWorkflow } : {}
  const abort = (): boolean => rt.isCancelled(projectId)

  // 时代锁：古风/年代剧注入 genre，定妆图按时代约束生成（杜绝现代服化道混入古装剧）
  const projectForGenre = await rt.store.get(projectId)
  const genre = projectForGenre?.genre
  const neg = { negative: castingNegativeFor(ch.realismLock, genre) }

  rt.setStage(projectId, 'casting', 'running',
    `并发生成角色资产 0/${total}（并发 ${concurrency}，定妆抽卡×${faceCount}）...`, 5)

  const prepared = analysis.characters.map((ac, i) => {
    const id = `char_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const voice = ac.gender === 'male'
      ? MALE_VOICES[maleIdx++ % MALE_VOICES.length]
      : FEMALE_VOICES[femaleIdx++ % FEMALE_VOICES.length]
    const rawLookEn = /chinese|asian/i.test(ac.lookEn) ? ac.lookEn : `chinese, ${ac.lookEn}`
    // 古风/年代剧：建档源头即清洗现代服装词，定妆/首帧/渲染全链路使用同一份时代安全 lookEn
    const lookEn = castLookForGenre(rawLookEn, genre)
    return { ac, id, voice, lookEn, order: i }
  })

  // —— 硬门禁 v2：全角色 lookEn 结构化校验（武器单把+中式 / 结构缺项 / 三角色趋同差异化）——
  // LLM 角色设定不谨慎（katana/双持/趋同/缺条款）在此拦截修正，不带病进定妆生成
  const hardened = hardenLookEnList(prepared.map(p => p.lookEn), genre)
  for (const note of hardened.notes) {
    rt.log(projectId, 'casting', 'warn', `lookEn 硬门禁：${note}`)
  }
  prepared.forEach((p, i) => { p.lookEn = hardened.looks[i] })

  await mapPool(prepared, concurrency, async ({ ac, id, voice, lookEn, order }) => {
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
        await rt.image.generate(
          faceCastingPrompt(lookEn, { realismLock: ch.realismLock, genre }),
          path.join(rt.baseDir, rel),
          { width: ch.faceWidth, height: ch.faceHeight, seed, ...wfOpt, ...neg, ...genOpts }
        )
        candRels.push({ rel, seed })
      }
      if (candRels.length === 1) {
        character.faceImagePath = candRels[0].rel
      } else {
        const items = await Promise.all(candRels.map(async (c, i) => {
          const abs = path.join(rt.baseDir, c.rel)
          let score = 0.5
          let note = '生成成功'
          try {
            const st = await fs.stat(abs)
            // 文件更大通常细节更足；轻微拉开分差供 LLM 参考
            score = Math.min(0.95, 0.4 + Math.log10(Math.max(1000, st.size)) / 10)
            note = `file=${Math.round(st.size / 1024)}KB`
          } catch { note = 'stat 失败' }
          return { id: `c${i}`, relativePath: c.rel, seed: c.seed, score, note }
        }))
        const picked = await rt.picker.pick({
          kind: 'character',
          brief: `角色「${ac.name}」定妆，外观锁定：${lookEn}`,
          candidates: items,
          llmPick: ch.llmPick
        })
        await rt.picker.promoteWinner({
          baseDir: rt.baseDir,
          winnerRel: picked.winner.relativePath,
          finalRel: faceRel,
          rejectedRels: picked.rejected.map(r => r.relativePath),
          keepRejected: true
        })
        character.faceImagePath = faceRel
        rt.log(projectId, 'casting', 'info',
          `「${ac.name}」定妆抽卡 ${candRels.length}→1：${picked.reason}`)
      }
      character.refImagePath = character.faceImagePath || ''
    } catch (e) {
      if (e instanceof ImageGenerateCancelled) throw e
      rt.log(projectId, 'casting', 'warn',
        `「${ac.name}」面部定妆失败：${e instanceof Error ? e.message : String(e)}`)
    }

    try {
      const bodySeed = ch.seedMode === 'fixed' ? ch.seed : Math.floor(Math.random() * 0xffffffff)
      await rt.image.generate(
        bodySheetPrompt(lookEn, { realismLock: ch.realismLock, genre }),
        path.join(rt.baseDir, bodyRel),
        { width: ch.bodyWidth, height: ch.bodyHeight, seed: bodySeed, ...wfOpt, ...neg, ...genOpts }
      )
      character.bodySheetPath = bodyRel
      if (!character.refImagePath) character.refImagePath = bodyRel
    } catch (e) {
      if (e instanceof ImageGenerateCancelled) throw e
      rt.log(projectId, 'casting', 'warn',
        `「${ac.name}」三视图失败：${e instanceof Error ? e.message : String(e)}`)
    }

    // —— 资产复用回退：T2I 模型缺失/生成失败时，从资产库项目按出场顺序复用定妆 ——
    // 无 face 也无 body 才算"建档失败"；此时若 settings.render.assetFallbackProjectId 指向
    // 一个已完成项目，复制其第 order 位角色的 face/body 图到本项目，保证后续首帧/渲染有参考。
    if (!character.faceImagePath && !character.bodySheetPath) {
      const reused = await reuseFallbackCharacterAssets(rt, projectId, id, order, lookEn)
      if (reused) {
        character.faceImagePath = reused.faceRel
        character.refImagePath = reused.faceRel
        if (reused.bodyRel) character.bodySheetPath = reused.bodyRel
        character.appearanceLock = reused.appearanceLock
        rt.log(projectId, 'casting', 'warn',
          `「${ac.name}」T2I 不可用，已从资产库项目 ${reused.fromProjectId} 复用定妆资产（第 ${order + 1} 位）`)
      }
    }

    if (!character.faceImagePath && !character.bodySheetPath) {
      character.description = `${ac.appearance}（定妆资产生成失败）`
    }

    result.set(ac.name, character)
    doneCount++
    rt.setStage(projectId, 'casting', 'running',
      `并发生成角色资产 ${doneCount}/${total}...`,
      Math.round((doneCount / Math.max(1, total)) * 100))
  }, { shouldAbort: abort })

  // —— 角色资产绑定校验（2026-10-23 角色混淆根因级修复）——
  // 多角色剧：每角色必须绑定唯一人物参考图（共享图=硬错误停流水线）；外观锚点趋同=警告留痕
  let binding: { conflicts: string[]; similarLooks: string[] } = { conflicts: [], similarLooks: [] }
  try {
    const project = await rt.store.get(projectId)
    project.characters = [...result.values()]
    await rt.store.save(project)
    rt.notifyProjectUpdated(projectId)

    binding = validateCharacterAssets(project.characters)
    for (const warn of binding.similarLooks) {
      rt.log(projectId, 'casting', 'warn', warn)
    }
    if (binding.conflicts.length > 0) {
      for (const c of binding.conflicts) rt.log(projectId, 'casting', 'error', c)
      rt.setStage(projectId, 'casting', 'error',
        '角色资产冲突：多个角色共享同一张人物参考图（每角色必须绑定唯一定妆图），请修正剧本角色描述后重跑建档')
      throw new Error(binding.conflicts[0])
    }
  } catch (e) {
    if (e instanceof ImageGenerateCancelled) throw e
    if (binding.conflicts.length > 0) throw new Error(binding.conflicts[0])
    // 保存失败由后续阶段暴露
  }

  const allFailed = [...result.values()].every(c => !c.faceImagePath && !c.bodySheetPath && !c.refImagePath)
  rt.setStage(projectId, 'casting',
    allFailed ? 'error' : 'done',
    allFailed
      ? '全部角色资产生成失败，请检查 ComfyUI'
      : `已建档 ${result.size} 个角色（面部+三视图，并发 ${concurrency}）`,
    allFailed ? 0 : 100)

  return result
}

/**
 * 道具资产生成：为分镜阶段提取的关键道具（analysis.props）逐张生成道具定妆图，
 * 存 projects/{pid}/props/xxx.png，回填 imagePath 并保存到项目。
 * 用途：渲染时作为道具参考（配合 props 提示词锁形），防"袋变绳、道具凭空消失"。
 * 失败不阻断流水线（道具图是增强项，渲染靠提示词约束兜底）。
 */
export async function buildPropAssets(rt: DirectorStageRuntime, projectId: string, analysis: AnalyzeResult): Promise<void> {
  const props = analysis.props || []
  if (props.length === 0) return
  const settingsSnap = await rt.settings.get()
  const concurrency = Math.max(1, Math.min(3, settingsSnap.render.assetConcurrency || 2))
  const ch = resolveCreation(settingsSnap).character
  const wfOpt = ch.t2iWorkflow ? { workflowName: ch.t2iWorkflow } : {}
  const neg = { negative: sceneNegativeFor(ch.realismLock) }
  const abort = (): boolean => rt.isCancelled(projectId)
  let doneCount = 0

  rt.log(projectId, 'casting', 'info',
    `生成道具资产 0/${props.length}（${props.map(p => p.zh).join('、')}）...`)
  await mapPool(props, concurrency, async (prop, i) => {
    if (abort()) throw new ImageGenerateCancelled()
    const propsDir = path.join(rt.baseDir, 'projects', projectId, 'props')
    const propAbs = path.join(propsDir, `${prop.id}.png`)
    const lookText = prop.description
      ? `${prop.en}, ${prop.description}`
      : `${prop.en}`
    try {
      await rt.image.generate(
        `${lookText}, isolated prop asset for film production, centered on plain light-gray studio background, soft even lighting, subtle drop shadow, sharp focus, high detail, photorealistic, front three-quarter view, no person, no hands`,
        propAbs,
        { width: 768, height: 768, ...wfOpt, ...neg, shouldAbort: abort }
      )
      prop.imagePath = `projects/${projectId}/props/${prop.id}.png`
    } catch (e) {
      if (e instanceof ImageGenerateCancelled || /CANCELLED/i.test(String(e))) throw e
      rt.log(projectId, 'casting', 'warn', `道具「${prop.zh}」定妆图生成失败：${e instanceof Error ? e.message : String(e)}`)
    }
    doneCount += 1
    // 进度只写日志不写阶段状态：本函数在 casting 已置 done 之后运行，
    // 打回 running 且无终态复位会让该阶段在 UI 永久转圈（S2）
    rt.log(projectId, 'casting', 'info', `并发生成道具资产 ${doneCount}/${props.length}...`)
  }, { shouldAbort: abort })

  try {
    const project = await rt.store.get(projectId)
    project.props = props
    await rt.store.save(project)
    rt.notifyProjectUpdated(projectId)
  } catch {
    // 保存失败由后续阶段暴露
  }
  const okCount = props.filter(p => p.imagePath).length
  if (okCount > 0) {
    rt.log(projectId, 'casting', 'info', `道具定妆图 ${okCount}/${props.length} 生成完成（渲染锁形参考）`)
  }
}

/**
 * 重出角色定妆资产（face + body 三视图）：复用 casting 的提示词与写实负向，
 * 修复旧定妆图背景/肤质问题。
 * 角色 id / appearanceLock 保持不变，引用不断。重出后需重建首帧并重渲才生效。
 */
export async function rerunCasting(rt: DirectorStageRuntime, projectId: string): Promise<{ ok: boolean; text: string }> {
  const project = await rt.store.get(projectId)
  const chars = project.characters
  if (!chars.length) return { ok: false, text: '项目暂无角色，无法重出定妆' }
  const settingsSnap = await rt.settings.get()
  const ch = resolveCreation(settingsSnap).character
  const wfOpt = ch.t2iWorkflow ? { workflowName: ch.t2iWorkflow } : {}
  const neg = { negative: castingNegativeFor(ch.realismLock) }
  const abort = (): boolean => rt.isCancelled(projectId)
  const genre = project.genre
  let okCount = 0
  const failDetail: string[] = []
  // 硬门禁 v2：重出定妆同样过 lookEn 校验（武器单械中式），趋同差异化沿用建档时已落档的 appearanceLock
  const hardened = hardenLookEnList(chars.map(c => c.appearanceLock || 'chinese person, natural everyday appearance'), genre)
  for (const note of hardened.notes) {
    rt.log(projectId, 'casting', 'warn', `lookEn 硬门禁：${note}`)
  }
  for (const [ci, character] of chars.entries()) {
    const lookEn = hardened.looks[ci] || hardenLookWeapons(character.appearanceLock || 'chinese person, natural everyday appearance')
    const faceRel = `projects/${projectId}/characters/${character.id}_face.png`
    const bodyRel = `projects/${projectId}/characters/${character.id}_body.png`
    try {
      await rt.image.generate(
        faceCastingPrompt(lookEn, { realismLock: ch.realismLock, genre }),
        path.join(rt.baseDir, faceRel),
        { width: ch.faceWidth, height: ch.faceHeight, seed: Math.floor(Math.random() * 0xffffffff), ...wfOpt, ...neg, shouldAbort: abort }
      )
      character.faceImagePath = faceRel
      character.refImagePath = character.refImagePath || faceRel
    } catch (e) {
      if (e instanceof ImageGenerateCancelled) throw e
      failDetail.push(`「${character.name}」面部：${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      await rt.image.generate(
        bodySheetPrompt(lookEn, { realismLock: ch.realismLock, genre }),
        path.join(rt.baseDir, bodyRel),
        { width: ch.bodyWidth, height: ch.bodyHeight, seed: Math.floor(Math.random() * 0xffffffff), ...wfOpt, ...neg, shouldAbort: abort }
      )
      character.bodySheetPath = bodyRel
      if (!character.refImagePath) character.refImagePath = bodyRel
    } catch (e) {
      if (e instanceof ImageGenerateCancelled) throw e
      failDetail.push(`「${character.name}」三视图：${e instanceof Error ? e.message : String(e)}`)
    }
    okCount++
  }
  await rt.store.save(project)
  rt.notifyProjectUpdated(projectId)
  const text = failDetail.length
    ? `重出定妆：完成 ${okCount}/${chars.length}，失败 ${failDetail.join('；')}`
    : `重出定妆完成：${okCount} 位角色（面部+三视图已重出）`
  return { ok: failDetail.length === 0, text }
}

/**
 * T2I 资产复用回退（casting 建档失败兜底）：
 * 读取 settings.render.assetFallbackProjectId，若指向的已完成项目有角色定妆资产，
 * 按出场顺序（order 钳到池末）复制 face/body 图到本项目并返回引用；不可用返回 undefined。
 * 纯文件复制，不调用任何文生图——本机 T2I 模型缺失时保证导演流水线能继续建档。
 */
async function reuseFallbackCharacterAssets(
  rt: DirectorStageRuntime,
  projectId: string,
  charId: string,
  order: number,
  defaultLook: string
): Promise<{ faceRel: string; bodyRel?: string; appearanceLock: string; fromProjectId: string } | undefined> {
  let fbId: string | undefined
  try { fbId = (await rt.settings.get()).render?.assetFallbackProjectId } catch { return undefined }
  if (!fbId) return undefined
  let fb: Project | undefined
  try { fb = await rt.store.get(fbId) } catch { return undefined }
  // 题材一致性门禁（2026-10-23 现代剧适配）：资产库项目题材与本项目不一致（如现代剧回退到
  // 古装项目）→ 禁止复用，否则现代角色直接复用古装定妆/首帧穿帮；宁可回退失败走真实 T2I。
  try {
    const cur = await rt.store.get(projectId)
    if (!genreCompatible(fb?.genre, cur.genre)) {
      rt.log(projectId, 'casting', 'warn',
        `「${defaultLook.slice(0, 20)}…」T2I 回退跳过：资产库项目 ${fbId} 题材(${fb?.genre || '未知'}) 与本剧题材(${cur.genre || '未知'}) 不一致，禁止跨题材复用定妆`)
      return undefined
    }
  } catch { return undefined }
  const pool = (fb?.characters || []).filter(c => c.faceImagePath)
  if (!pool.length) return undefined
  const fc = pool[Math.min(Math.max(0, order), pool.length - 1)]
  const faceRel = `projects/${projectId}/characters/${charId}_face.png`
  try {
    await fs.copyFile(
      path.join(rt.baseDir, fc.faceImagePath!),
      path.join(rt.baseDir, faceRel)
    )
  } catch {
    return undefined
  }
  let bodyRel: string | undefined
  if (fc.bodySheetPath) {
    const rel = `projects/${projectId}/characters/${charId}_body.png`
    try {
      await fs.copyFile(path.join(rt.baseDir, fc.bodySheetPath), path.join(rt.baseDir, rel))
      bodyRel = rel
    } catch { /* 无三视图不影响建档 */ }
  }
  return { faceRel, bodyRel, appearanceLock: fc.appearanceLock || defaultLook, fromProjectId: fbId }
}
