/**
 * 输入框记忆工具：把用户输入过的值存入 localStorage，供下拉记忆复用。
 * 用途：设置页的 LLM 模型 / ComfyUI 地址 / 路径 / 试生成短语等输入框。
 * 存储键：ds-input-mem:<key>，值为 JSON 字符串数组（最新在前，默认最多 12 条）。
 */
const KEY_PREFIX = 'ds-input-mem:'

export interface InputMemory {
  /** 读取当前历史（最新在前） */
  read(): string[]
  /** 记入历史（去重后置顶，超出 max 截断） */
  remember(value: string): void
  /** 从历史移除一条 */
  remove(value: string): void
  /** 清空全部历史 */
  clear(): void
}

export function useInputMemory(key: string, max = 12): InputMemory {
  const storageKey = KEY_PREFIX + key

  function read(): string[] {
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) return []
      const list = JSON.parse(raw)
      return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }

  function write(list: string[]): void {
    localStorage.setItem(storageKey, JSON.stringify(list.slice(0, max)))
  }

  function remember(value: string): void {
    const v = String(value ?? '').trim()
    if (!v) return
    const list = read().filter(x => x !== v)
    list.unshift(v)
    write(list)
  }

  function remove(value: string): void {
    write(read().filter(x => x !== value))
  }

  function clear(): void {
    localStorage.removeItem(storageKey)
  }

  return { read, remember, remove, clear }
}
