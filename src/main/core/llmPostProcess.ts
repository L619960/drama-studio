/**
 * analyze 后处理层（从 llmService.ts 抽出）：
 * - enforcePromptLengths：提示词字数硬校验 + LLM 整改循环 + 确定性收尾
 * - backfillMissingProps：propList 道具未写入镜头时自动注入
 * - foldName / escapeRegExp：本地归一与正则转义工具
 * 行为与原 LLMService 内联实现一字不差。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppSettings, AnalyzeResult, AnalyzeScene, AnalyzedCharacter, AnalyzedShot } from '../../shared/ipcTypes'
import { DISPLACEMENT_ACTION_RE } from '../../shared/imagePrompts'
import { CROSS_SOURCE } from '../../shared/promptAuditRules'
import { httpChat } from './llmHttp'

/** 名称归一化键：去空白并小写（中文不受影响） */
export function foldName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '')
}

/** 正则转义（backfillMissingProps 匹配 action 词边界用） */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 提示词字数硬校验 + 整改循环：
 * LLM 一次输出常不达模板字数铁律（场景 en 40~80、sceneEn 30~60、promptEn 80~150、
 * negativeEn 15~35、首中尾帧 20~50 词），且偶发套话（clearly visible 等）。
 * 收集全部不达标字段后，让 LLM 只补写这些字段（聚焦短调用），合并回结果；
 * 整改调用/解析失败时保留原值继续，不阻塞主流程（宁可原值也不返工）。
 */
export async function enforcePromptLengths(
  getSettings: () => Promise<AppSettings>,
  scenes: AnalyzeScene[],
  shots: AnalyzedShot[],
  characters: AnalyzedCharacter[]
): Promise<{ scenes: AnalyzeScene[]; shots: AnalyzedShot[]; characters: AnalyzedCharacter[] }> {
  const L = (t?: string): number => (t ? (t.trim().match(/[a-zA-Z'-]+/g) || []).length : 0)
  const SLANG = /\bclearly visible\b|\bholding a [\w -]+ visible\b/i
  // 串台词（跨项目污染防线）：旧示例项目的专属元素/角色/服装道具。出现在本剧任一提示词字段即代表 LLM 沿用了示例内容，
  // 必须按本镜 action 重写。理发店元素通用项目也可能出现，但本防线仅在本字段与该镜剧情无关时由 LLM 重写纠正。
  // 2026-10-25 单源化：词表收敛到 promptAuditRules.CROSS_SOURCE（旧剧专属元素；现代服装词由 render 层
  // FOREIGN_COAT_RE 按"古装镜出现现代服装"语义承担，analyze 层不拦现代剧正常服装，避免误伤现代剧）。
  const CROSS_RE = new RegExp(CROSS_SOURCE, 'gi')

  interface Violation {
    kind: 'scene' | 'shot' | 'character'
    sceneName?: string
    idx?: number
    name?: string
    field: string
    current: number
    min: number
    max?: number
    slang?: string
    /** 串台词：字段内容疑似沿用了其他剧情/其他镜的示例文本 */
    cross?: string
  }

  // 跨镜位移语义统一判定（尾帧/转场/flf2v 路由同一把尺；「转身/起身」属原地微动不算位移）。
  // 与 taskQueue flf2v 切换判定共用 imagePrompts.DISPLACEMENT_ACTION_RE，口径禁止分裂
  const DISPLACEMENT_RE = DISPLACEMENT_ACTION_RE

  const collect = (sc: AnalyzeScene[], sh: AnalyzedShot[], ch: AnalyzedCharacter[]): Violation[] => {
    const vs: Violation[] = []
    for (const c of sc) {
      const n = L(c.en)
      if (n < 40 || n > 80) vs.push({ kind: 'scene', sceneName: c.name, field: 'en', current: n, min: 40, max: 80 })
    }
    sh.forEach((s, i) => {
      const idx = i + 1
      // i2v 镜 promptEn 走 motion-first 短结构（60~110 词）；t2v 空镜走画面概念（80~130 词）
      const pMin = s.type === 'i2v' ? 60 : 80
      const pMax = s.type === 'i2v' ? 110 : 130
      const checks: Array<[string, number, number, number | undefined]> = [
        ['sceneEn', L(s.sceneEn), 30, 60],
        ['promptEn', L(s.promptEn), pMin, pMax],
        ['negativeEn', L(s.negativeEn), 0, 20],
        ['firstFrameEn', L(s.firstFrameEn), 20, 50],
        ['midFrameEn', L(s.midFrameEn), s.midFrameEn ? 20 : 0, 40]
      ]
      // 尾帧/转场与位移语义同生同灭：仅「跨镜位移镜」必填 lastFrameEn/transitionEn；
      // 站立微动/对话/单动作完成镜禁写（flf2v 自由插值是动作漂移源头，见规则「尾帧镜判定铁律」）
      if (s.type === 'i2v' && DISPLACEMENT_RE.test(s.action ?? '')) {
        const lf = L(s.lastFrameEn)
        if (lf < 20) checks.push(['lastFrameEn', lf, 20, 50])
        const tn = L(s.transitionEn)
        if (tn < 60) checks.push(['transitionEn', tn, 60, 120])
      }
      for (const [field, n, min, max] of checks) {
        if (field === 'midFrameEn' && min === 0) continue
        if (n < min || n > (max ?? 1e9)) vs.push({ kind: 'shot', idx, field, current: n, min, max })
      }
      // 套话检测
      if (s.promptEn) {
        const slang = SLANG.exec(s.promptEn)
        if (slang) vs.push({ kind: 'shot', idx, field: 'promptEn', current: L(s.promptEn), min: pMin, max: pMax, slang: slang[0] })
      }
      // 串戏语义检测（2026-10-17 漂移根因修复·确定性防线）：promptEn 必须与 action 讲同一个故事。
      // 实测事故：LLM 把系统提示词示例当剧本，24 镜古装戏 promptEn 全写成雨夜现代戏，
      // 与 action 完全脱节 → i2v 拿古装定妆演白裙女子，22 镜全部换脸漂移。
      // 黑名单 CROSS_RE 只能堵已知旧剧词；这里用语义对齐兜底未知幻觉：action 内容词
      // 在 promptEn 中命中率 <15% 即判串戏，交整改循环按 action 重写（宁可重写不可放行）。
      if (s.promptEn && s.action) {
        const STOP = new Set([
          'the', 'from', 'with', 'then', 'than', 'that', 'this', 'these', 'those', 'into', 'onto',
          'over', 'under', 'while', 'their', 'there', 'here', 'have', 'has', 'had', 'his', 'her',
          'him', 'she', 'its', 'and', 'but', 'not', 'for', 'are', 'was', 'were', 'been', 'being',
          'same', 'reference', 'image', 'slight', 'slow', 'slowly', 'push', 'shot', 'pan', 'tilt',
          'arc', 'static', 'zoom', 'camera', 'rhythm', 'keeps', 'still', 'starting', 'fixed',
          'framing', 'level', 'speaking', 'naturally', 'motion'
        ])
        const words = (t: string): Set<string> =>
          new Set((t.toLowerCase().match(/[a-z]{4,}/g) || []).filter(w => !STOP.has(w)))
        const aw = words(s.action)
        const pw = words(s.promptEn)
        if (aw.size >= 4) {
          let hit = 0
          for (const w of aw) if (pw.has(w)) hit++
          const ratio = hit / aw.size
          if (ratio < 0.15) {
            vs.push({
              kind: 'shot', idx, field: 'promptEn', current: L(s.promptEn), min: pMin, max: pMax,
              cross: `promptEn 与本镜 action 剧情脱节（动作词命中率仅 ${Math.round(ratio * 100)}%，疑似幻觉串戏）`
            })
          }
        }
      }
      // 串台检测（跨项目污染防线）：任一英文提示词字段出现旧项目专属元素（理发店/剪刀/旧角色名/旧服装道具）→ 重写该字段。
      // 这些词不属于本剧（便利店悬疑），出现即代表 LLM 拆镜时沿用了其他示例内容，必须按本镜 action 重写。
      for (const field of ['sceneEn', 'promptEn', 'firstFrameEn', 'midFrameEn', 'lastFrameEn', 'transitionEn', 'handoffToNext', 'negativeEn']) {
        const v = s[field as keyof AnalyzedShot] as string | undefined
        if (!v) continue
        const m = CROSS_RE.exec(v)
        if (m) vs.push({ kind: 'shot', idx, field, current: L(v), min: 1, max: undefined, cross: m[0] })
      }
    })
    for (const c of ch) {
      const n = L(c.lookEn)
      if (n < 30) vs.push({ kind: 'character', name: c.name, field: 'lookEn', current: n, min: 30, max: 70 })
    }
    return vs
  }

  let vs = collect(scenes, shots, characters)
  if (vs.length === 0) return { scenes, shots, characters }

  // 整改轮次：每轮补写后复验（LLM 补写常再次打折 → 复验不合格再补一轮，最多 2 轮）
  let curScenes = scenes
  let curShots = shots
  let curChars = characters
  for (let round = 1; round <= 2 && vs.length > 0; round++) {
    const lines = vs.map(v => {
      const who = v.kind === 'scene' ? `场景[${v.sceneName}]`
        : v.kind === 'character' ? `角色[${v.name}]`
          : `镜头${v.idx}`
      const range = v.max != null ? `${v.min}~${v.max}` : `${v.min}+`
      const extra = v.slang ? `（含套话词 "${v.slang}"，必须重写去掉）` : ''
      const cross = v.cross ? `（含其他剧情/其他项目的串台词 "${v.cross}"，必须按本镜 action 实际剧情重写，禁止沿用示例内容）` : ''
      return `- ${who} 的 ${v.field} 现 ${v.current} 词，要求 ${range} 词${extra}${cross}`
    })

    const system =
      '你是专业短剧分镜提示词编辑。以下字段因字数不足、含套话或含禁词会降低后续出图/出视频质量，' +
      '请只补写这些字段，保持剧情、场景、镜头顺序、角色外观完全不变。' +
      '只输出一个 JSON 对象，禁止 markdown 代码围栏，所有字符串必须是单行纯文本（不得含换行/制表符/未转义双引号）。' +
      'i2v 镜头的 transitionEn 必须补写（60~120 英文词：起始帧→结束帧的动态转场，A 类原地演变/B 类运镜驱动，按本镜 frameSeconds(3~6秒) 拆解，禁人名/技能词）。' +
      '所有字段严禁出现其他剧情/其他示例项目的串台词（理发店/剪刀/旧角色名/旧服装道具等），必须按本镜 action 实际剧情写，禁止沿用示例内容。' +
      'i2v 镜头的 promptEn 必须按 motion-first 四段结构补写（60~110 词：the same [角色英文名] from the reference image + 具体保留特征词(服装/湿发/道具，禁止仅写 consistent appearance 空断言) + 可观察事件链动作(起始姿态→程度词单一原子动作→结束定格，含物体/道具状态变化，非剧情摘要) + 单条微运镜(static / slow push-in with small amplitude / slight pan / slight tilt / slight arc shot 择一) + 节奏词；禁止重述场景/外貌/光线，禁止多动作堆叠，禁止 static 与运镜并存）。' +
      '角色 lookEn 必须补写（30~70 英文词：人种年龄性别/脸型五官/写实肤质/发型发色/服装面料款式(完整得体禁裸露)/配饰/体型/剧情痕迹；禁 beautiful/porcelain/flawless 空泛词）。'
    const user = `# 需整改字段\n${lines.join('\n')}\n\n# 输出格式\n` +
      `{"fixes":[{"shotIndex":1,"promptEn":"...","transitionEn":"..."}],"sceneFixes":[{"sceneName":"昏暗老宅","en":"..."}],"charFixes":[{"name":"主角名","lookEn":"..."}]}\n` +
      `只包含需整改的字段；补写必须按该镜/该场景/该角色剧情写，禁止逐镜雷同模板，promptEn 不含外貌服装描述，negativeEn 只写本镜增量风险词（0~20 词，系统已覆盖的通用漂移/画质/字幕/转场词禁止重复；无增量风险可留空）。`

    try {
      const raw = await httpChat(getSettings, system, user, 0.4, 300000, 8192)
      const m = raw.match(/\{[\s\S]*\}/)
      if (!m) break
      const fix = JSON.parse(m[0]) as {
        fixes?: Array<{ shotIndex: number; [k: string]: unknown }>
        sceneFixes?: Array<{ sceneName: string; en: string }>
        charFixes?: Array<{ name: string; lookEn: string }>
      }
      const shotMap = new Map<number, Record<string, unknown>>()
      if (Array.isArray(fix.fixes)) {
        for (const f of fix.fixes) {
          if (f && typeof f.shotIndex === 'number') shotMap.set(f.shotIndex, f)
        }
      }
      const sceneMap = new Map<string, string>()
      if (Array.isArray(fix.sceneFixes)) {
        for (const f of fix.sceneFixes) {
          if (f && typeof f.sceneName === 'string' && typeof f.en === 'string') sceneMap.set(f.sceneName, f.en.trim())
        }
      }
      const charMap = new Map<string, string>()
      if (Array.isArray(fix.charFixes)) {
        for (const f of fix.charFixes) {
          if (f && typeof f.name === 'string' && typeof f.lookEn === 'string') charMap.set(f.name.trim(), f.lookEn.trim())
        }
      }
      if (shotMap.size === 0 && sceneMap.size === 0 && charMap.size === 0) break
      curShots = curShots.map((s, i) => {
        const f = shotMap.get(i + 1)
        if (!f) return s
        const nxt: AnalyzedShot = { ...s }
        const keys = ['sceneEn', 'promptEn', 'negativeEn', 'firstFrameEn', 'midFrameEn', 'lastFrameEn', 'handoffToNext', 'transitionEn'] as const
        for (const k of keys) {
          if (typeof f[k] === 'string' && (f[k] as string).trim()) nxt[k] = (f[k] as string).trim()
        }
        return nxt
      })
      curScenes = curScenes.map(sc => {
        const en = sceneMap.get(sc.name)
        return en ? { ...sc, en } : sc
      })
      curChars = curChars.map(c => {
        const look = charMap.get(c.name) || charMap.get((c.aliases || []).find(a => charMap.has(a)) || '')
        return look ? { ...c, lookEn: look } : c
      })
    } catch (e) {
      // 整改失败不阻塞：保留原值（记录留痕便于排障；确定性收尾仍会补 transitionEn/截断上限）
      console.warn('[enforcePromptLengths] 整改调用失败，保留原值:', e instanceof Error ? e.message : String(e))
      break
    }
    // 复验：补写仍不达标（LLM 二次打折/漏霓虹）则进入下一轮，2 轮后放弃
    vs = collect(curScenes, curShots, curChars)
  }

  // ===== 确定性收尾（LLM 区间控制不可靠，代码兜底保证落盘达标）=====
  const clamp = (t: string | undefined, max: number): string | undefined => {
    if (!t) return t
    const words = t.trim().split(/\s+/)
    if (words.length <= max) return t
    let out = words.slice(0, max).join(' ')
    if (!/[.!?。！？]/.test(out.slice(-1))) out += '.'
    return out
  }
  // transitionEn 兜底：仅「跨镜位移镜」LLM 漏写（2 轮整改仍空）时桥接生成，
  // 保证 flf2v 首尾帧分支有可用的转场提示词（无 LLM 依赖，禁因果词/人名/技能词）；
  // 非位移镜强制剥除 LLM 多写的尾帧/转场（防 flf2v 误切与全量尾帧图空耗）
  const buildTransition = (s: AnalyzedShot): string => {
    const secs = s.frameSeconds && s.frameSeconds >= 3 ? Math.min(6, Math.round(s.frameSeconds)) : 5
    const a = s.firstFrameEn ? s.firstFrameEn.split(',').slice(0, 3).join(',') : 'the opening state'
    const b = s.lastFrameEn ? s.lastFrameEn.split(',').slice(0, 3).join(',') : 'the closing state'
    const cam = s.camera || 'steady camera'
    const mid = s.midFrameEn ? `passing through ${s.midFrameEn.split(',').slice(0, 2).join(',')}, ` : ''
    return `Transition over ${secs} seconds: ${cam}, the frame begins at ${a}, the subject movement evolves smoothly, ${mid}and finally settles at ${b}. The change happens in place with minimal camera motion, consistent lighting and no morphing.`
  }
  curScenes = curScenes.map(sc => ({ ...sc, en: clamp(sc.en, 80) }))
  curShots = curShots.map(s => {
    const nxt: AnalyzedShot = { ...s }
    if (s.type === 'i2v' && DISPLACEMENT_RE.test(s.action ?? '')) {
      if (!nxt.transitionEn) nxt.transitionEn = buildTransition(nxt)
    } else {
      nxt.lastFrameEn = undefined
      nxt.transitionEn = undefined
    }
    nxt.sceneEn = clamp(nxt.sceneEn, 60)
    nxt.promptEn = clamp(nxt.promptEn, 150)
    nxt.negativeEn = clamp(nxt.negativeEn, 35)
    nxt.firstFrameEn = clamp(nxt.firstFrameEn, 50)
    nxt.midFrameEn = clamp(nxt.midFrameEn, 40)
    nxt.lastFrameEn = clamp(nxt.lastFrameEn, 50)
    nxt.transitionEn = clamp(nxt.transitionEn, 120)
    return nxt
  })
  // 调试留痕：确认收尾是否执行、transitionEn 生成情况（写盘便于排查）
  try {
    const fsLog = path.join(process.env.APPDATA || os.homedir(), 'drama-studio', 'enforce-debug.log')
    fs.appendFileSync(fsLog,
      `[${new Date().toISOString()}] i2v=${curShots.filter(x => x.type === 'i2v').length} ` +
      `t2v=${curShots.filter(x => x.type === 't2v').length} ` +
      `transition生成=${curShots.filter(x => x.transitionEn).length} ` +
      `sceneEn=[${curShots.map(x => (x.sceneEn || '').trim().split(/\s+/).length).join(',')}] ` +
      `promptEn=[${curShots.map(x => (x.promptEn || '').trim().split(/\s+/).length).join(',')}]\n`, 'utf-8')
  } catch { /* 日志失败不阻塞 */ }
  return { scenes: curScenes, shots: curShots, characters: curChars }
}

/**
 * 本地兜底：propList 中的道具若未写入任何镜头（props 数组或 action），
 * 自动注入到第一个 i2v 镜头（全 t2v 则第一个镜头）的 props + action 尾部，
 * 并记录 warning。确保"剧本反复出现的道具"绝不沦为"全剧从未出现"。
 */
export function backfillMissingProps(result: AnalyzeResult): void {
  const list = result.props
  if (!list || list.length === 0) return
  const shots = result.shots
  const warnings: string[] = []
  for (const prop of list) {
    const en = prop.en || prop.zh
    // 匹配：props 数组包含 en（整词）或 action 出现 en（词边界）
    const key = en.toLowerCase()
    const re = new RegExp(`\\b${escapeRegExp(key).split(' ')[0]}`, 'i')
    const assigned = shots.some(s => {
      const inProps = (s.props || []).some(p => p.toLowerCase().includes(key))
      const inAction = re.test(s.action)
      return inProps || inAction
    })
    if (assigned) continue

    // 未分配：注入最相关镜头（第一个 i2v 镜优先；无 i2v 则第一镜）
    const target =
      shots.find(s => s.type === 'i2v') ||
      shots[0]
    if (!target) {
      warnings.push(`道具「${prop.zh}」未写入任何镜头（无可注入镜头）`)
      continue
    }
    target.props = [...(target.props || []), en]
    const actionAdd = `holding a ${en}`
    if (!re.test(target.action)) {
      target.action = `${target.action.trim().replace(/[.,;]?\s*$/, '')}, ${actionAdd}`
    }
    warnings.push(
      `道具「${prop.zh}（${en}）」未写入任何镜头，已自动补入第 ${shots.indexOf(target) + 1} 镜的 props 与动作提示词`
    )
  }
  if (warnings.length > 0) {
    result.warnings = [...(result.warnings || []), ...warnings]
  }
}
