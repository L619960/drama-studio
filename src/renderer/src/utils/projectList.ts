import type { DirectorState, Project } from '../../../shared/ipcTypes'

/**
 * REQ-08 项目列表检索/排序/封面工具（纯函数，便于单测）。
 *
 * 排序口径：
 * - recent：最近打开优先（本地记录打开时间戳），没打开过的回退 updatedAt；
 * - created：创建时间倒序；
 * - status：进行中 → 失败 → 草稿 → 完成（状态分组内再按最近打开/更新时间倒序）。
 */
export type ProjectSortMode = 'recent' | 'created' | 'status'

export const PROJECT_SORT_OPTIONS: ReadonlyArray<{ value: ProjectSortMode; label: string }> = [
  { value: 'recent', label: '最近打开' },
  { value: 'created', label: '创建时间' },
  { value: 'status', label: '完成状态' }
]

const OPENS_KEY = 'drama-studio:projectOpens'

/** 读取项目打开时间戳表；无存储/损坏时返回空表，不影响列表主流程 */
export function readProjectOpens(): Record<string, number> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(OPENS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** 记录一次「打开项目」；写入失败（配额满/禁用）不影响打开本身 */
export function markProjectOpened(id: string, now = Date.now()): void {
  if (typeof localStorage === 'undefined' || !id) return
  try {
    const opens = readProjectOpens()
    opens[id] = now
    localStorage.setItem(OPENS_KEY, JSON.stringify(opens))
  } catch {
    // 存储不可用时排序退化为按 updatedAt，不阻断打开
  }
}

/** 片名/剧本关键词模糊过滤（大小写不敏感） */
export function filterProjects(list: readonly Project[], keyword: string): Project[] {
  const kw = keyword.trim().toLowerCase()
  if (!kw) return [...list]
  return list.filter(
    p => (p.title || '').toLowerCase().includes(kw) || (p.script || '').toLowerCase().includes(kw)
  )
}

const STATUS_RANK: Record<string, number> = { rendering: 0, failed: 1, draft: 2, done: 3 }

export function sortProjects(
  list: readonly Project[],
  mode: ProjectSortMode,
  opens: Record<string, number> = readProjectOpens()
): Project[] {
  const out = [...list]
  out.sort((a, b) => {
    if (mode === 'created') return b.createdAt - a.createdAt
    if (mode === 'status') {
      const diff = (STATUS_RANK[a.status] ?? 4) - (STATUS_RANK[b.status] ?? 4)
      if (diff !== 0) return diff
    }
    const ta = opens[a.id] ?? a.updatedAt
    const tb = opens[b.id] ?? b.updatedAt
    return tb - ta
  })
  return out
}

/** 卡片封面：首镜首帧优先，回退既有缩略图 */
export function projectCoverPath(project: Pick<Project, 'id' | 'shots'>): string {
  const firstFrame = project.shots?.[0]?.firstFramePath
  return firstFrame || `projects/${project.id}/thumbnail.jpg`
}

/**
 * 导演进度事件 → 卡片状态徽章。
 * 返回 null 表示事件不携带可判定的终态，保留列表原状态（避免把已完成的项目改回草稿）。
 */
export function directorProjectStatus(
  state: Pick<DirectorState, 'running' | 'paused' | 'finalPath' | 'failedShotIds' | 'totalShots'>
): Project['status'] | null {
  if (state.running || state.paused) return 'rendering'
  if (state.finalPath) return 'done'
  if ((state.failedShotIds?.length ?? 0) > 0 && (state.totalShots ?? 0) > 0) return 'failed'
  return null
}
