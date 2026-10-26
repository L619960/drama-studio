import * as fs from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { IpcChannels } from '../../shared/ipcTypes'
import { handleIpc } from './shared'
import type { ComfyUIClient } from '../core/comfyuiClient'
import type { WorkflowLoader } from '../core/workflowLoader'
import type { SettingsStore } from '../core/settingsStore'

/**
 * 工作流环境自检（I-16 去重）：控制面板手动触发与启动 15s 静默自检共用同一份逻辑。
 * 缺自定义节点 / 缺模型文件逐模板汇报。
 */
export async function validateWorkflowTemplates(comfyuiClient: ComfyUIClient, workflowLoader: WorkflowLoader): Promise<{ workflow: string; ok: boolean; issues: { message: string }[] }[]> {
  const objectInfo = await comfyuiClient.getObjectInfo()
  const metas = await workflowLoader.list()
  const reports: { workflow: string; ok: boolean; issues: { message: string }[] }[] = []
  for (const meta of metas) {
    const issues = await workflowLoader.validateTemplate(meta.name, objectInfo)
    reports.push({ workflow: meta.name, ok: issues.length === 0, issues })
  }
  return reports
}

// ComfyUI models 目录解析：设置指定 > inputDir 同级推断 > null（UI 据此禁用按钮）
export async function resolveComfyModelsDir(settingsStore: SettingsStore): Promise<string | null> {
  const s = await settingsStore.get()
  if (s.comfyui.modelsDir) {
    try { await fs.access(s.comfyui.modelsDir); return s.comfyui.modelsDir } catch { /* 配置失效按未配置处理 */ }
  }
  if (s.comfyui.inputDir) {
    const guess = join(dirname(s.comfyui.inputDir), 'models')
    try { await fs.access(guess); return guess } catch { /* 推断路径不存在 */ }
  }
  return null
}

export interface ComfyIpcCtx {
  comfyuiClient: ComfyUIClient
  workflowLoader: WorkflowLoader
  settingsStore: SettingsStore
}

export function registerComfyIpc(ctx: ComfyIpcCtx): void {
  // ComfyUI
  handleIpc(IpcChannels.comfyuiHealth, () => ctx.comfyuiClient.healthCheck())

  // ComfyUI 控制面板
  handleIpc(IpcChannels.comfySystemStats, () => ctx.comfyuiClient.getSystemStats())
  handleIpc(IpcChannels.comfyObjectNodes, () => ctx.comfyuiClient.getObjectNodeNames())
  // 工作流环境自检：缺自定义节点 / 缺模型文件
  handleIpc(IpcChannels.comfyValidate, () => validateWorkflowTemplates(ctx.comfyuiClient, ctx.workflowLoader))
  handleIpc(IpcChannels.comfyModelsDir, () => resolveComfyModelsDir(ctx.settingsStore))
  // 一键启动/停止本机 ComfyUI（后台无窗口；启动命令取 settings.comfyui.startCommand，空=内置默认路径）
  handleIpc(IpcChannels.comfyStart, async () => {
    const s = await ctx.settingsStore.get()
    return ctx.comfyuiClient.start(s.comfyui?.startCommand)
  })
  handleIpc(IpcChannels.comfyStop, () => ctx.comfyuiClient.stop())
}
