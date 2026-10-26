import type { VramTier } from './comfyuiClient'
import type { RenderProfile, Shot } from '../../shared/ipcTypes'
import { audioTailSecFor } from '../../shared/shotDoctrine'

/** 引擎模式：与 renderShot 内部 type EngineMode 保持一致 */
export type EngineMode = 'h3-r2v' | 'h3-i2v' | 'wan'

/**
 * 选择引擎模式（纯计算）。
 * - 首尾帧 flf → 强制 wan
 * - forceI2v（录音回放/画外音）→ 不因有台词升到 r2v
 * - H3：有台词且 lipMode!=='latentsync' → h3-r2v，否则 h3-i2v
 * - 否则 → wan
 *
 * 注意：全局默认工作流常为 minimax_h3_i2v，不能据此钉死 i2v——
 * 否则台词镜全走 i2v+TTS，口型对不上就成「解说片」。
 */
export function selectEngineMode(opts: {
  preferFlf: boolean
  preferH3: boolean
  hasLine: boolean
  lipMode: string
  /** 录音回放/画外音：强制 i2v，不升 r2v */
  forceI2v?: boolean
}): EngineMode {
  if (opts.preferFlf) return 'wan'
  if (opts.preferH3) {
    if (opts.forceI2v) return 'h3-i2v'
    return (opts.hasLine && opts.lipMode !== 'latentsync') ? 'h3-r2v' : 'h3-i2v'
  }
  return 'wan'
}

/**
 * Wan 单镜初始时长（秒）：frames-1 / 16 取整，受档位 maxWanSec 上限钳制，下限 1s。
 */
export function computeWanDurationSec(frames: number, maxWanSec: number): number {
  return Math.min(maxWanSec, Math.max(1, Math.round((frames - 1) / 16)))
}

/**
 * H3 所需秒数 = max(镜头设计时长, 音频需求)。
 * - 镜头设计时长：由 shot.frames 反推（prepareShotAudio 已把 frames 归一为 finalSec*16+1）。
 *   台词短不代表镜短：动作量大的镜头（摔跤/泼洒/起身）台词只有一两个词时，
 *   只按音频算需求会渲成 2 秒出头，画面来不及演完（实测「哎呀」镜只渲出 2.3s）。
 * - 音频需求：audioSec + 开口留白 + 尾音（tailSec 与 prepareShotAudio 同口径，
 *   isLast 取项目内最大 index）。
 * - 无音频时：镜头设计时长为准，下限 2s。
 */
export function computeH3NeedSec(
  shot: Shot,
  audioSec: number | undefined,
  allShots: Shot[],
  audioLeadSec: number
): number {
  const lastIndex = allShots.reduce((max, s) => Math.max(max, s.index), shot.index)
  const tailSec = audioTailSecFor({ dialogue: shot.dialogue, emotion: shot.emotion, isLast: shot.index === lastIndex })
  const designSec = Number.isFinite(shot.frames) && shot.frames > 1
    ? Math.round((shot.frames - 1) / 16)
    : 0
  const audioNeed = audioSec !== undefined ? audioSec + audioLeadSec + tailSec : 0
  const floorSec = audioSec === undefined ? 2 : 0
  return Math.max(floorSec, designSec, audioNeed)
}

/**
 * H3 17k+5 网格帧数换算 + 档位上限钳制。
 * 实际时长 ≈ (frames-5)/17×0.75s；超档位时返回 capped=true 与 capSec/needSec 供日志。
 */
export function computeH3Length(
  h3NeedSec: number,
  maxFrames: number
): { length: number; capped: boolean; capSec: number; needSecRounded: number } {
  const raw = 17 * Math.max(3, Math.ceil((h3NeedSec * 24 - 5) / 17)) + 5
  const length = Math.min(maxFrames, raw)
  const capped = raw > maxFrames
  const capSec = Math.round(((maxFrames - 5) / 17) * 0.75 * 10) / 10
  const needSecRounded = Math.round(h3NeedSec * 10) / 10
  return { length, capped, capSec, needSecRounded }
}

/**
 * OOM 首次降负（不换档位）：H3 减 17 帧（保 56 下限），步数固定回 8；Wan 减 2 秒（保 2 下限）。
 * 返回新值对象，调用方负责写回外层可变变量。
 */
export function applyOomLightDowngrade(
  mode: EngineMode,
  state: { h3Length: number; h3Steps: number; wanDurationSec: number }
): { h3Length: number; h3Steps: number; wanDurationSec: number } {
  if (mode.startsWith('h3')) {
    return {
      h3Length: Math.max(56, state.h3Length - 17),
      h3Steps: 8,
      wanDurationSec: state.wanDurationSec
    }
  }
  return {
    h3Length: state.h3Length,
    h3Steps: state.h3Steps,
    wanDurationSec: Math.max(2, state.wanDurationSec - 2)
  }
}

/**
 * OOM 二次降档：换更低 VramTier 后，按新档位上限钳制 h3Length / wanDurationSec。
 */
export function applyOomTierDowngrade(
  tier: VramTier,
  h3Length: number,
  wanDurationSec: number
): { h3Length: number; wanDurationSec: number } {
  return {
    h3Length: Math.min(tier.maxFrames, h3Length),
    wanDurationSec: Math.min(tier.maxWanSec, wanDurationSec)
  }
}

/**
 * H3 原生口型失败是否回退 h3-i2v + LatentSync：
 * 非 OOM、当前 h3-r2v、lipMode=auto 且 lipSync 开关打开。
 */
export function shouldFallbackR2vToI2v(opts: {
  isOom: boolean
  mode: EngineMode
  lipMode: string
  lipSyncEnabled: boolean
}): boolean {
  return !opts.isOom && opts.mode === 'h3-r2v' && opts.lipMode === 'auto' && opts.lipSyncEnabled
}

/**
 * 抽卡候选数：设置 renderCandidates 钳制到 [1,3]。
 */
export function computeWantedCandidates(renderCandidates: number | undefined): number {
  return Math.max(1, Math.min(3, renderCandidates || 1))
}

/**
 * 渲染档案的口型路线标签。
 */
export function computeLipProfile(
  mode: EngineMode,
  needLipSync: boolean,
  lipSynced: boolean
): RenderProfile['lipSync'] {
  if (mode === 'h3-r2v') return 'native'
  if (needLipSync && lipSynced) return 'latentsync'
  return 'none'
}

/**
 * 判定是否首尾帧 flf2v 工作流（按名字或元数据 hasEndFrame/END_IMAGE 占位符）。
 */
export function isFlf2vWorkflow(
  workflowName: string,
  meta: { hasEndFrame?: boolean; placeholders?: string[] } | undefined
): boolean {
  return workflowName === 'wan22_remix_flf2v' ||
    (meta?.hasEndFrame ?? (meta?.placeholders ?? []).includes('END_IMAGE'))
}

/**
 * 从工作流元数据列表中挑选 flf2v 工作流名（优先精确名 wan22_remix_flf2v）。
 */
export function resolveFlfWorkflowName(
  metas: Array<{ name: string; hasEndFrame?: boolean; placeholders: string[] }>
): string | undefined {
  const flf = metas.find(w => w.name === 'wan22_remix_flf2v')
    || metas.find(w => w.hasEndFrame || w.placeholders.includes('END_IMAGE'))
  return flf?.name
}

/**
 * H3 turbo LoRA 图注入（纯图改写）：在 UNETLoader(20) 后插入 LoraLoaderModelOnly(25)，
 * 并把 42(sched)/43(guider) 的 model 引用改挂 LoRA 输出。返回是否实际注入。
 */
export function injectH3TurboLora(
  graph: Record<string, unknown>,
  mode: EngineMode,
  turboH3: boolean,
  loraT2v: string,
  loraR2v: string
): boolean {
  if (!turboH3 || !mode.startsWith('h3')) return false
  const loraName = mode === 'h3-r2v' ? loraR2v : loraT2v
  graph['25'] = {
    inputs: { model: ['20', 0], lora_name: loraName, strength_model: 1.0 },
    class_type: 'LoraLoaderModelOnly'
  }
  const sched42 = graph['42'] as { inputs?: Record<string, unknown> } | undefined
  const guider43 = graph['43'] as { inputs?: Record<string, unknown> } | undefined
  if (sched42?.inputs) sched42.inputs.model = ['25', 0]
  if (guider43?.inputs) guider43.inputs.model = ['25', 0]
  return true
}
