import type { IpcApi } from '../shared/ipcTypes'

declare global {
  interface Window {
    api: IpcApi
  }
}

export {}
