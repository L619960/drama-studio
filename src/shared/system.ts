// ===== 系统自检 =====
export interface SelfCheckItem {
  name: string
  ok: boolean
  detail: string
  /** 本次运行自动修复了问题 */
  fixed?: boolean
  /** 非故障但需用户注意（如 ComfyUI 离线）：面板渲染为告警而非绿勾 */
  warn?: boolean
}

