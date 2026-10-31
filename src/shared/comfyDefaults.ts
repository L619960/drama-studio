/**
 * ComfyUI 本地服务默认地址（单一事实源）。
 * 设置默认值、客户端启动兜底、MCP 子进程环境变量与设置页占位符共用，
 * 避免多处硬编码后改一处漏一处。
 */
export const DEFAULT_COMFY_BASE_URL = 'http://127.0.0.1:8188'
