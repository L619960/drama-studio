/**
 * 提示词拼装共享原子：段落拼接与负向合并。叶子模块，不依赖其它提示词模块。
 */

export function joinParts(...parts: Array<string | undefined | false | null>): string {
  return parts.filter(Boolean).map(s => String(s).trim()).filter(Boolean).join(', ')
}

/** 合并多段负向提示词：按逗号/分号拆分，trim、去空、按小写去重（保留首次出现顺序）。
 *  系统基础负向与用户追加负向必须经此合并——用户负向是「追加压制项」，不能替换基础负向。 */
export function mergeNegative(...parts: Array<string | undefined | false | null>): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of parts) {
    if (!p) continue
    for (const raw of String(p).split(/[,;]/)) {
      const term = raw.trim().replace(/\s+/g, ' ')
      if (!term) continue
      const key = term.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(term)
    }
  }
  return out.join(', ')
}
