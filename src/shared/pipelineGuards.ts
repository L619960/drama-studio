/** 流水线契约（纯函数，供主进程与验收脚本共用） */

export type GateMode = 'off' | 'warn' | 'block'

/** 拆镜结果按设置上限截断。下限不凭空补镜。 */
export function clampShotList<T>(shots: T[], maxShots: number): { shots: T[]; trimmed: number } {
  const max = Math.max(1, Math.round(maxShots))
  if (shots.length <= max) return { shots, trimmed: 0 }
  return { shots: shots.slice(0, max), trimmed: shots.length - max }
}

/** H3 极低分切 Wan：rerender 模式下按阈值触发；
 *  另设「灾难级」硬阈值（<0.15），warn/off 也强制切一次 Wan——
 *  实测 warn 模式下一镜 0.069 仍用 H3 出片，画面对不上人，属于必须兜底的坏镜。 */
export function shouldFallbackToWan(
  consistencyMode: 'off' | 'warn' | 'rerender',
  engine: string,
  score: number,
  threshold: number,
): boolean {
  if (consistencyMode === 'off') return false
  const isH3 = engine === 'h3-r2v' || engine === 'h3-i2v'
  if (!isH3) return false
  if (consistencyMode === 'rerender') return score < threshold
  return score < CATASTROPHIC_CONSISTENCY_SCORE
}

/** 灾难级一致性分数：视频里的人已经不是参考人物，任何模式都必须兜底重渲 */
export const CATASTROPHIC_CONSISTENCY_SCORE = 0.15

/**
 * 显存档位的宽高是竖屏。只有参考图本身是横图时才对调。
 * 分镜默认 720×480 不能当成横屏设计，否则竖屏首帧会被渲成横屏视频。
 */
export function orientVideoSize(
  tierWidth: number,
  tierHeight: number,
  portrait: boolean,
): { width: number; height: number } {
  const tierPortrait = tierHeight >= tierWidth
  if (portrait === tierPortrait) return { width: tierWidth, height: tierHeight }
  return { width: tierHeight, height: tierWidth }
}

/** i2v 勾选已审必须有首帧路径，否则审核无效。 */
export function reviewedIsValid(type: string, reviewed: boolean | undefined, firstFramePath?: string): boolean {
  if (!reviewed) return false
  if (type !== 'i2v') return true
  return Boolean(firstFramePath && firstFramePath.trim())
}

/** 两个开拍入口共用的默认确认点：剧本锁定、首帧锁定、成片复审。 */
export const DEFAULT_DIRECTOR_GATES = ['analyze', 'scenes', 'review'] as const

/** warn 放行后同一批未审镜的免打扰窗口（REQ-04：30 分钟） */
export const WARN_SUPPRESS_WINDOW_MS = 30 * 60 * 1000

/** 同一项目的同一批未审镜去重键（镜号排序后拼接，顺序无关） */
export function warnedBatchKey(projectId: string, shotIds: string[]): string {
  return `${projectId}:${[...shotIds].sort().join(',')}`
}

/** 该批未审镜是否仍在免打扰窗口内 */
export function isWarnSuppressed(lastWarnedAt: number | undefined, now: number): boolean {
  return lastWarnedAt !== undefined && now - lastWarnedAt < WARN_SUPPRESS_WINDOW_MS
}

export interface CutCandidate {
  status?: string
  segmentPath?: string
  skipped?: boolean
}

/**
 * 进入成片的镜：已完成、有分段、用户未跳过。
 * 低一致性只打标，不从时间线上拿掉。
 */
export function shotsInCut<T extends CutCandidate>(shots: T[]): T[] {
  return shots.filter((s) => s.status === 'done' && Boolean(s.segmentPath && s.segmentPath.trim()) && !s.skipped)
}

/** 复审时长与拼接使用同一裁切区间。非法裁切退回整段时长。 */
export function trimmedDurationSec(fullSec: number, trimStart?: number, trimEnd?: number): number {
  if (!Number.isFinite(fullSec) || fullSec <= 0) return 0
  const start = trimStart !== undefined ? Math.max(0, trimStart) : 0
  const end = trimEnd !== undefined ? Math.min(fullSec, trimEnd) : fullSec
  if (!(end > start)) return fullSec
  return end - start
}

/** 复审调用失败：关闭复审才放行，告警和拦截都停在复审、不配乐。 */
export function reviewFailureStops(reviewGate: GateMode): boolean {
  return reviewGate !== 'off'
}

export function unreviewedI2vShots<T extends { type: string; reviewed?: boolean; firstFramePath?: string }>(
  shots: T[],
): T[] {
  return shots.filter((s) => s.type === 'i2v' && !reviewedIsValid(s.type, s.reviewed, s.firstFramePath))
}

/** 开渲目标镜头：显式 shotIds 优先，否则仅 pending/failed（主进程入队与渲染器预判共用） */
export function renderTargetShots<T extends { id: string; status?: string }>(shots: T[], shotIds?: string[]): T[] {
  return shotIds && shotIds.length > 0
    ? shots.filter((s) => shotIds.includes(s.id))
    : shots.filter((s) => s.status === 'pending' || s.status === 'failed')
}

/**
 * 需「告警放行」确认的未核对 i2v 镜头。
 * treatAllAsUnreviewed 用于重渲前预判：重渲会清空 reviewed，当前已核对的 i2v 也将变成未核对。
 */
export function unreviewedRenderShots<
  T extends { id: string; status?: string; type: string; reviewed?: boolean; firstFramePath?: string },
>(shots: T[], shotIds?: string[], treatAllAsUnreviewed = false): T[] {
  const targets = renderTargetShots(shots, shotIds)
  return treatAllAsUnreviewed ? targets.filter((s) => s.type === 'i2v') : unreviewedI2vShots(targets)
}

const DONE_MEDIA_KEYS = [
  'segmentPath',
  'rawVideoPath',
  'audioPath',
  'firstFramePath',
  'lastFramePath',
  'sceneImagePath',
] as const

/**
 * 保护已完成镜头时，空的产物路径不能盖掉磁盘上的路径。
 * status 固定为 done。
 */
export function mergeProtectedDoneShot<T extends { status?: string }>(oldShot: T, incoming: T): T {
  const merged = { ...oldShot, ...incoming, status: 'done' } as T
  const prevRec = oldShot as Record<string, unknown>
  const nextRec = incoming as Record<string, unknown>
  const out = merged as Record<string, unknown>
  for (const key of DONE_MEDIA_KEYS) {
    const next = nextRec[key]
    const prev = prevRec[key]
    if (typeof next !== 'string' || !next.trim()) {
      if (typeof prev === 'string' && prev.trim()) out[key] = prev
    }
  }
  return merged
}

/** 分镜重跑时用于判断新旧镜头是否描述同一内容 */
export interface RebuiltShotLike {
  scene?: string
  action?: string
  dialogue?: string
}

/** 内容指纹一致才允许保留产物与审校状态（避免旧画面挂在新内容上） */
export function shotContentEqual(a: RebuiltShotLike, b: RebuiltShotLike): boolean {
  return (
    (a.scene ?? '') === (b.scene ?? '') &&
    (a.action ?? '') === (b.action ?? '') &&
    (a.dialogue ?? '') === (b.dialogue ?? '')
  )
}

/** 重跑分镜时从旧镜头保留的字段（STAGE-01）：人工编辑、审校与已生成产物 */
const REBUILD_PRESERVED_KEYS = [
  'id',
  'status',
  'reviewed',
  'segmentPath',
  'rawVideoPath',
  'audioPath',
  'firstFramePath',
  'lastFramePath',
  'sceneImagePath',
  'audioFailed',
  'audioFailedReason',
  'renderProfile',
  'consistencyScore',
  'lowConsistency',
  'auditFix',
  'auditHint',
  'trimStart',
  'trimEnd',
  'skipped',
  'seed',
  'width',
  'height',
  'frames',
  'workflow',
  'voice',
  'error',
  'errorKind',
  'retryCount',
  'retryBudget',
] as const

/**
 * 重跑分镜阶段时，内容未变的镜头沿用旧 id 与运行态产物，避免：
 * 手工编辑的提示词/裁切、reviewed 标记、已生成的首尾帧与成片全部丢失。
 * 调用方须先用 shotContentEqual 判定内容一致。
 */
export function mergeRebuiltShot<T extends Record<string, unknown>>(prev: T, rebuilt: T): T {
  const out = { ...rebuilt } as Record<string, unknown>
  const p = prev as Record<string, unknown>
  for (const key of REBUILD_PRESERVED_KEYS) {
    if (p[key] !== undefined) out[key] = p[key]
  }
  // 旧状态若停留在 rendering（上次异常中断），重跑时应回到待渲染
  if (out.status === 'rendering') out.status = 'pending'
  return out as T
}

/** 一镜只留一个可读角色名。多余的名字记入说明，由正反打拆镜承担。 */
export function collapseReadableFaces<T extends { type: string; characterName?: string; characters?: string[] }>(
  shots: T[],
): { shots: T[]; notes: string[] } {
  const notes: string[] = []
  const next = shots.map((shot, i) => {
    if (shot.type !== 'i2v') return shot
    const names: string[] = []
    const push = (name?: string) => {
      const trimmed = name?.trim()
      if (trimmed && !names.includes(trimmed)) names.push(trimmed)
    }
    push(shot.characterName)
    for (const name of shot.characters || []) push(name)
    if (names.length <= 1) {
      return names.length === 1 ? { ...shot, characterName: names[0], characters: [names[0]] } : shot
    }
    notes.push(`第${i + 1}镜有多名可读角色（${names.join('、')}），已只保留「${names[0]}」，另一人须拆成下一镜正反打`)
    return { ...shot, characterName: names[0], characters: [names[0]] }
  })
  return { shots: next, notes }
}

/** 从 ComfyUI 启动命令里的 main.py 推出安装根目录。解析不到则返回空字符串。 */
export function comfyInstallRoot(startCommand: string): string {
  const argv: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(startCommand)) !== null) {
    const token = match[1] ?? match[2] ?? match[3]
    if (token !== undefined) argv.push(token)
  }
  const main = argv.find((arg) => /main\.py$/i.test(arg))
  if (!main) return ''
  const slash = Math.max(main.lastIndexOf('/'), main.lastIndexOf('\\'))
  return slash > 0 ? main.slice(0, slash) : ''
}

/**
 * LOGIC-P0-03 逐镜审核汇总：仅硬失败（failCount>0）才暂停流水线；
 * 软提示（hintCount>0，技术快审未过但不阻断）只记录不暂停。
 */
export function shouldPauseAfterAudit(hintCount: number, failCount: number): boolean {
  return failCount > 0
}
