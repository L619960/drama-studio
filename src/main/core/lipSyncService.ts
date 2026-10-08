import * as path from 'node:path'
import type { ComfyUIClient } from './comfyuiClient'
import type { WorkflowLoader } from './workflowLoader'

/**
 * LatentSync 1.6 音频驱动口型同步：
 * 有台词的镜头渲染后，把「原片 + TTS 音频」送入 ComfyUI LatentSync 节点，
 * 重新生成与语音对齐的嘴部动作，输出替换原片。
 *
 * 依赖（ComfyUI 侧）：ComfyUI-LatentSyncWrapper（节点类 LatentSyncNode）+
 * VHS（VHS_LoadVideoPath / VHS_LoadAudio / VHS_VideoCombine，本项目已装）。
 * 节点缺失时 available()=false，调用方应跳过本环节并回退原片。
 */
export class LipSyncService {
  private static readonly NODE_CLASS = 'LatentSyncNode'
  private static readonly WORKFLOW = 'latentsync'

  constructor(
    private comfyui: ComfyUIClient,
    private workflow: WorkflowLoader
  ) {}

  /** 能力探测：LatentSync 节点是否已安装 */
  async available(): Promise<boolean> {
    return this.comfyui.hasNode(LipSyncService.NODE_CLASS)
  }

  /**
   * 执行口型同步。
   * @param videoAbsPath  渲染原片绝对路径
   * @param audioAbsPath  TTS 音频绝对路径
   * @param outputAbsPath 同步后视频落盘绝对路径
   */
  async sync(
    videoAbsPath: string,
    audioAbsPath: string,
    outputAbsPath: string,
    onProgress?: (percent: number) => void
  ): Promise<void> {
    const graph = await this.workflow.buildGraph(LipSyncService.WORKFLOW, {
      // VHS Path 节点接受绝对路径；Windows 反斜杠会破坏 JSON，统一转正斜杠
      VIDEO_PATH: videoAbsPath.replace(/\\/g, '/'),
      AUDIO_PATH: audioAbsPath.replace(/\\/g, '/'),
      SEED: Math.floor(Math.random() * 0xffffffff),
      EXPRESSION: 1.5,   // 日常对话默认口型幅度
      STEPS: 20
    })

    const { promptId } = await this.comfyui.submit(graph)
    // RTX 5060 Ti 16GB 实测 20 步约 15~20 分钟/镜（含首次加载 5GB 模型），超时放到 40 分钟
    const output = await this.comfyui.waitForCompletion(promptId, (percent) => {
      onProgress?.(percent)
    }, 40 * 60 * 1000)

    const video = this.comfyui.findVideoOutput(output)
    if (!video) throw new Error('LatentSync 未输出视频')
    if (video.fullpath) {
      await this.comfyui.downloadFromFullPath(video.fullpath, outputAbsPath)
    } else {
      await this.comfyui.download(video.filename, video.subfolder, video.type, outputAbsPath)
    }
    // 防止返回路径意外落在目录外
    if (path.extname(outputAbsPath) === '') throw new Error('口型同步输出路径无扩展名')
  }
}
