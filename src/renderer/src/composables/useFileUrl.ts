import { reactive } from 'vue'

// 全局缓存：相对路径 -> file URL
const urlCache = reactive<Record<string, string>>({})

// Windows 绝对路径转 file:/// URL
function toFileUrl(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, '/')
  return 'file:///' + encodeURI(normalized).replace(/#/g, '%23')
}

// 确保某个相对路径的 URL 已解析（异步，带缓存）
export async function ensureFileUrl(relativePath?: string): Promise<string> {
  if (!relativePath) return ''
  if (urlCache[relativePath]) return urlCache[relativePath]
  const absolute = await window.api.file.resolvePath(relativePath)
  const url = toFileUrl(absolute)
  urlCache[relativePath] = url
  return url
}

// 批量解析
export async function ensureFileUrls(relativePaths: string[]): Promise<void> {
  await Promise.all(relativePaths.map(p => ensureFileUrl(p)))
}

/**
 * 清理缓存：
 * - 传 prefix：仅删除以该前缀开头的键（如项目删除时传 `projects/<id>/`）
 * - 不传：清空全部缓存
 * 防止 urlCache 随项目/分镜增删而无界增长。
 */
export function clearFileUrlCache(prefix?: string): void {
  if (!prefix) {
    for (const key of Object.keys(urlCache)) delete urlCache[key]
    return
  }
  for (const key of Object.keys(urlCache)) {
    if (key.startsWith(prefix)) delete urlCache[key]
  }
}

// 模板中直接取用（可能暂时为空，ensureFileUrl 完成后自动更新）
export function useFileUrl() {
  return {
    urlCache,
    ensureFileUrl,
    ensureFileUrls
  }
}
