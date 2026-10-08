/// <reference types="vite/client" />

// 渲染进程全局类型：预加载脚本通过 contextBridge 暴露的 window.api
import type { IpcApi } from '../../shared/ipcTypes'

declare global {
  interface Window {
    api: IpcApi
  }
}

export {}
