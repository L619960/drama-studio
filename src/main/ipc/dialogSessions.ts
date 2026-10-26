// 对话框会话登记：用户在原生对话框中显式选择的路径短期内才可被 file:copy /
// workflow:import 使用。防止渲染层被攻陷（如 LLM 内容注入）后伪造路径，
// 把数据目录内文件写到系统任意位置、或读取磁盘任意文件进应用目录。
export const DIALOG_SESSION_TTL = 10 * 60 * 1000
export const dialogSavedFiles = new Map<string, number>()   // 保存对话框选中的导出目标 / 打开对话框选中的导入源
export const dialogSelectedDirs = new Map<string, number>() // 目录选择对话框选中的目录（批量导出）

export function registerDialogPath(map: Map<string, number>, p: string): void {
  const now = Date.now()
  for (const [k, exp] of map) {
    if (exp < now) map.delete(k)
  }
  map.set(p, now + DIALOG_SESSION_TTL)
}

export function hasDialogSession(map: Map<string, number>, p: string): boolean {
  const exp = map.get(p)
  if (!exp) return false
  if (exp < Date.now()) {
    map.delete(p)
    return false
  }
  return true
}
