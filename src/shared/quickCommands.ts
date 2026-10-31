/**
 * 导演对话快捷指令（REQ-14 DC-OPEN-26）。
 * 输入框上方的「重渲第X镜」chip 需要用户填写镜号，统一在这里生成指令文本，
 * 避免组件内散落字符串拼装、也便于单测覆盖边界。
 */
export function buildRerenderShotCommand(input: string | number): string | null {
  const raw = typeof input === 'number' ? input : Number(input.trim())
  if (!Number.isInteger(raw) || raw <= 0) return null
  return `重渲第 ${raw} 镜`
}
