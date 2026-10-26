import { IpcChannels } from '../../shared/ipcTypes'
import { handleIpc } from './shared'
import type { SelfCheckService } from '../core/selfCheckService'

export interface SystemIpcCtx {
  selfCheckService: SelfCheckService
}

export function registerSystemIpc(ctx: SystemIpcCtx): void {
  // 系统自检
  handleIpc(IpcChannels.systemSelfcheck, () => ctx.selfCheckService.run())
}
