import { IpcChannels } from '../../shared/ipcTypes'
import { handleIpc } from './shared'
import type { SelfCheckService } from '../core/selfCheckService'
import { getDiskSpace } from '../core/diskSpace'

export interface SystemIpcCtx {
  selfCheckService: SelfCheckService
  /** 数据根目录：磁盘空间按该盘统计 */
  dataRoot: string
  /** 清理崩溃残留临时产物（复用 taskQueue 既有清理逻辑） */
  cleanupTmp: () => Promise<void>
}

export function registerSystemIpc(ctx: SystemIpcCtx): void {
  // 系统自检
  handleIpc(IpcChannels.systemSelfcheck, () => ctx.selfCheckService.run())
  // REQ-15 DC-OPEN-22：数据盘空间（低磁盘警告）+ 清理临时产物
  handleIpc(IpcChannels.systemDiskSpace, () => getDiskSpace(ctx.dataRoot))
  handleIpc(IpcChannels.systemCleanupTmp, () => ctx.cleanupTmp())
}
