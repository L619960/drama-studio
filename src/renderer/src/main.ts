import { createApp } from 'vue'
import ElementPlus, { ElMessage } from 'element-plus'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './assets/theme.css'
import App from './App.vue'
import router from './router'

/**
 * Toast 时长统一（交互规范 1.2，2026-10-13 ux-standards.md）。
 * Element Plus 2.14.7 的 `app.use(ElementPlus, { message })` 全局配置只接受单一
 * duration，无法按 type 区分 success/error。这里在入口处对 ElMessage.success /
 * ElMessage.error / ElMessage.warning / ElMessage.info 做薄封装，使各调用点无
 * 感知地落到规范时长：
 *   success 2000ms / info 2000ms / warning 2500ms / error 3500ms。
 * 调用点若显式传入 duration 则以调用点为准（保留例外能力）。
 */
type MessageOpts = string | { message?: string; duration?: number }
function patchType(type: 'success' | 'error' | 'warning' | 'info', defaultDuration: number) {
  const original = ElMessage[type] as (...args: any[]) => ReturnType<typeof ElMessage>
  const wrapped = ((...args: any[]) => {
    if (typeof args[0] === 'string') {
      return original({ message: args[0], duration: defaultDuration })
    }
    if (args[0] && typeof args[0] === 'object' && args[0].duration == null) {
      return original({ ...args[0], duration: defaultDuration })
    }
    return original(...args)
  }) as typeof original
  ;(ElMessage as any)[type] = wrapped
}
patchType('success', 2000)
patchType('info', 2000)
patchType('warning', 2500)
patchType('error', 3500)

/**
 * 全局异常兜底（交互规范：任何失败都不能静默）。
 * 个别调用点漏写 try/catch 时，未捕获的 Promise 拒绝 / 运行时错误在这里统一
 * 给出错误提示，避免用户"点了没反应"。提示本身做节流，防异常风暴刷屏。
 */
let lastGlobalErrorTip = 0
function globalErrorTip(message: string): void {
  const now = Date.now()
  if (now - lastGlobalErrorTip < 3000) return
  lastGlobalErrorTip = now
  ElMessage.error(`操作失败：${message}`)
}
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason
  globalErrorTip(reason instanceof Error ? reason.message : String(reason))
  e.preventDefault()
})

const app = createApp(App)
app.config.errorHandler = (err) => {
  globalErrorTip(err instanceof Error ? err.message : String(err))
}
app.use(router)
app.use(ElementPlus)
app.mount('#app')
