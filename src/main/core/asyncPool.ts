/**
 * 有限并发映射：定妆/场景板等可并行的 I/O 任务共用。
 * ComfyUI 侧仍按队列串行吃 GPU，客户端并行可重叠上传/等待/下载。
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  opts?: { shouldAbort?: () => boolean; abortError?: Error }
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let next = 0
  const limit = Math.max(1, Math.min(concurrency, items.length))
  const abortErr = opts?.abortError ?? new Error('CANCELLED')

  const worker = async (): Promise<void> => {
    while (true) {
      if (opts?.shouldAbort?.()) throw abortErr
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()))
  return results
}
