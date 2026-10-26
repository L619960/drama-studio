// ===== ComfyUI WebSocket 消息类型 =====
export type ComfyWSMessage =
  | { type: 'status'; data: { status: { exec_info: { queue_remaining: number } }; sid?: string } }
  | { type: 'execution_start'; data: { prompt_id: string; timestamp: number } }
  | { type: 'execution_cached'; data: { prompt_id: string; timestamp: number; nodes: string[] } }
  | { type: 'executing'; data: { node: string | null; prompt_id: string; display_node?: string } }
  | { type: 'executed'; data: { node: string; prompt_id: string; output: { images?: Array<{ filename: string; subfolder: string; type: string }> } } }
  | { type: 'progress'; data: { value: number; max: number; prompt_id: string; node: string } }
  | { type: 'execution_success'; data: { prompt_id: string; timestamp: number } }
  | { type: 'execution_error'; data: { prompt_id: string; exception_message: string; traceback: string[] } }

// ===== ComfyUI 输出类型（适配 Wan2.2 工作流）=====
export interface ComfyUIOutputItem {
  filename: string
  subfolder: string
  type: string
  format?: string
  frame_rate?: number
  workflow?: string
  fullpath?: string
}

export interface ComfyUIHistoryOutput {
  images?: ComfyUIOutputItem[]
  videos?: ComfyUIOutputItem[]
  gifs?: ComfyUIOutputItem[]
  [key: string]: ComfyUIOutputItem[] | undefined
}

// ===== ComfyUI 控制面板 =====
export interface ComfyGpuDevice {
  name: string
  type: string
  vramTotal: number
  vramFree: number
}

export interface ComfySystemStats {
  online: boolean
  version: string
  pythonVersion: string
  devices: ComfyGpuDevice[]
}

/** 一键启动 ComfyUI 的结果 */
export interface ComfyStartResult {
  ok: boolean
  /** 启动前已在线（无需重复启动） */
  already?: boolean
  /** 已派生进程 PID */
  pid?: number
  error?: string
}

