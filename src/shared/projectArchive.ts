/**
 * 项目包（REQ-20）纯规则：打包排除清单、路径安全、重名标题、项目 id 路径改写。
 * 与文件系统解耦，便于单测；实际读写由主进程 core/projectArchive 负责。
 */

/** 临时/崩溃残留文件：不进入项目包 */
const IGNORED_PATTERNS = [
  /\.part\./i,       // xxx.mp4.part.123
  /\.part$/i,        // xxx.part
  /\.tmp$/i,         // 原子写残留
  /\.crdownload$/i,  // 下载未完成
  /(^|[\\/])\.DS_Store$/i,
  /(^|[\\/])Thumbs\.db$/i,
  /(^|[\\/])node_modules([\\/]|$)/i
]

export interface ArchiveIgnoreOptions {
  /** 是否打包导演运行状态（默认不含，避免把运行中断状态带到别的机器） */
  includeDirectorState?: boolean
}

/**
 * 判断项目目录内相对路径是否应排除。
 * `director-state.json` 默认排除；其余临时产物一律排除。
 */
export function isArchiveIgnored(relPath: string, options: ArchiveIgnoreOptions = {}): boolean {
  const normalized = relPath.replace(/\\/g, '/')
  if (!options.includeDirectorState && normalized === 'director-state.json') return true
  return IGNORED_PATTERNS.some(re => re.test(normalized))
}

/**
 * 重名项目标题：`-副本`、`-副本2`… 依次递增，不覆盖已有项目。
 * `existing` 为当前数据根内全部项目标题。
 */
export function uniqueProjectTitle(title: string, existing: readonly string[]): string {
  const base = title.trim() || '未命名项目'
  if (!existing.includes(base)) return base
  let candidate = `${base}-副本`
  let n = 2
  while (existing.includes(candidate)) candidate = `${base}-副本${n++}`
  return candidate
}

/**
 * 导入时项目 id 会重新分配，project.json 内所有 `projects/<oldId>/...`
 * 资源引用必须同步改写（含 Windows 反斜杠写法），否则图片/视频全部悬空。
 */
export function rewriteProjectIdPaths<T>(value: T, oldId: string, newId: string): T {
  if (typeof value === 'string') {
    if (!value.includes(oldId)) return value
    return value
      .split(`projects/${oldId}`).join(`projects/${newId}`)
      .split(`projects\\${oldId}`).join(`projects\\${newId}`) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map(v => rewriteProjectIdPaths(v, oldId, newId)) as unknown as T
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewriteProjectIdPaths(v, oldId, newId)
    }
    return out as unknown as T
  }
  return value
}
