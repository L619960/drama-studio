import { reactive } from 'vue'

/**
 * 相对路径 → Electron 原生 app-file:// URL（窗口内 <video>/<img> 播放）。
 * 由主进程 protocol.registerFileProtocol 解析到 DATA_ROOT 内文件。
 */
const urlCache = reactive<Record<string, string>>({})

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
  await Promise.all(relativePaths.map(p => ensureFileUrl(p)))
}

export function clearFileUrlCache(prefix?: string): void {
  if (!prefix) {
    for (const key of Object.keys(urlCache)) delete urlCache[key]
    return
  }
  for (const key of Object.keys(urlCache)) {
    if (key.startsWith(prefix)) delete urlCache[key]
  }
}

export function useFileUrl() {
  return {
    urlCache,
    ensureFileUrl,
    ensureFileUrls
  }
}
