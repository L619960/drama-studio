/**
 * SEC-05：跨 IPC 错误文本脱敏（纯函数，便于单测）。
 * 目标：渲染层与日志导出包只拿到「可读的失败原因」，不包含绝对数据路径、完整命令行与密钥样式串。
 * 规则：数据根路径 → <DATA_ROOT>；常见密钥/令牌样式 → 掩码；控制字符剔除；超长截断。
 */
export interface SanitizeErrorOptions {
  /** 数据根绝对路径（替换为 <DATA_ROOT>） */
  dataRoot?: string
  /** 最大保留长度（默认 500） */
  maxLen?: number
}

/** 密钥样式：sk-/rk-/ark- 前缀、Bearer 令牌、key=value 形式的 key/token/secret/password */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:sk|rk|ark)-[A-Za-z0-9_-]{8,}/g, 'sk-***'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'],
  [/((?:api[_-]?key|access[_-]?token|token|secret|password)\s*[=:]\s*)[^\s,;)"']{6,}/gi, '$1***'],
]

/**
 * 脱敏错误文本：路径替换 → 密钥掩码 → 控制字符清理 → 截断。
 * 保留换行与缩进（stderr 片段可读性），仅剔除不可见控制字符。
 */
export function sanitizeErrorText(text: unknown, options: SanitizeErrorOptions = {}): string {
  let s = typeof text === 'string' ? text : String(text ?? '')
  if (options.dataRoot) {
    const root = options.dataRoot
    s = s.split(root).join('<DATA_ROOT>')
    // 反斜杠/正斜杠变体（Windows 日志里两种写法都常见）
    s = s.split(root.replace(/\\/g, '/')).join('<DATA_ROOT>')
    s = s.split(root.replace(/\//g, '\\')).join('<DATA_ROOT>')
  }
  for (const [re, repl] of SECRET_PATTERNS) s = s.replace(re, repl)
  // eslint-disable-next-line no-control-regex -- 需要剔除不可见控制字符（保留 \t \n \r）
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  const max = options.maxLen ?? 500
  if (max > 0 && s.length > max) s = `${s.slice(0, max)}…（已截断）`
  return s
}
