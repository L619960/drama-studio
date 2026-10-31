import { reactive } from 'vue'

/**
 * 相对路径 → Electron 原生 app-file:// URL（窗口内 <video>/<img> 播放）。
 * 由主进程 protocol.registerFileProtocol 解析到 DATA_ROOT 内文件。
 */
const urlCache = reactive<Record<string, string>>({})
/** P2-13：降采样缩略图 URL 缓存（key 仍是源文件相对路径，失效口径与 urlCache 一致） */
const thumbCache = reactive<Record<string, string>>({})
const thumbPending = new Map<string, Promise<string>>()

export async function ensureFileUrl(relativePath?: string): Promise<string> {
  if (!relativePath) return ''
  if (urlCache[relativePath]) return urlCache[relativePath]
  try {
    const url = await window.api.file.mediaUrl(relativePath)
    if (!url) return ''
    urlCache[relativePath] = url
    return url
  } catch {
    return ''
  }
}

export async function ensureFileUrls(relativePaths: string[]): Promise<void> {
  await Promise.all(relativePaths.map((p) => ensureFileUrl(p)))
}

/**
 * P2-13：取降采样缩略图（最长边 160px，主进程按 mtime 缓存）。
 * 同一路径并发请求合并为一次 IPC；失败返回空串，由调用方回落占位。
 */
export function ensureThumbUrl(relativePath?: string): Promise<string> {
  if (!relativePath) return Promise.resolve('')
  const cached = thumbCache[relativePath]
  if (cached) return Promise.resolve(cached)
  const pending = thumbPending.get(relativePath)
  if (pending) return pending
  const task = (async (): Promise<string> => {
    try {
      const url = await window.api.file.thumbUrl(relativePath)
      if (url) thumbCache[relativePath] = url
      return url || ''
    } catch {
      return ''
    } finally {
      thumbPending.delete(relativePath)
    }
  })()
  thumbPending.set(relativePath, task)
  return task
}

export async function ensureThumbUrls(relativePaths: string[]): Promise<void> {
  await Promise.all(relativePaths.map((p) => ensureThumbUrl(p)))
}

export function clearFileUrlCache(prefix?: string): void {
  if (!prefix) {
    for (const key of Object.keys(urlCache)) delete urlCache[key]
    for (const key of Object.keys(thumbCache)) delete thumbCache[key]
    return
  }
  for (const key of Object.keys(urlCache)) {
    if (key.startsWith(prefix)) delete urlCache[key]
  }
  for (const key of Object.keys(thumbCache)) {
    if (key.startsWith(prefix)) delete thumbCache[key]
  }
}

/**
 * P2-12：媒体加载失败（文件被删/损坏/协议解析失败）时逐条失效缓存。
 * 删除对应 key 后，模板里的 `v-if="urlCache[path]"` 会自动回落为占位提示，
 * 不会留下一张裂图；下次预热/刷新若文件恢复会重新解析。
 */
export function invalidateFileUrl(relativePath?: string): void {
  if (!relativePath) return
  delete urlCache[relativePath]
  // 缩略图与源图同生共死：源图缺失/损坏时一并作废，避免列表继续显示旧缩略图
  delete thumbCache[relativePath]
}

export function useFileUrl() {
  return {
    urlCache,
    thumbCache,
    ensureFileUrl,
    ensureFileUrls,
    ensureThumbUrl,
    ensureThumbUrls,
  }
}
