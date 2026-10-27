/**
 * 渲染重试策略决策（从 taskQueue.renderShot 的 while 重试循环抽出，纯函数）：
 * 每类重试各有独立预算，互不挤占：
 *   ① OOM → 先减帧/步/时长一次（oom-light）；再降分辨率档位一次（oom-tier）
 *   ② H3 原生口型失败（auto 路线）→ 回退 h3-i2v + LatentSync（仅非 OOM）
 *   ③ 瞬时故障 → 指数退避最多 2 次（transient）
 * 副作用（interrupt / emit / sleep）仍由 renderShot 编排，本模块只决定「下一步做什么」。
 * 决策顺序与原内联循环一字不差。
 */
import { shouldFallbackR2vToI2v, type EngineMode } from './taskQueueRender'

export interface RetryInput {
  err: unknown
  /** 已被取消（项目/镜头级） */
  cancelled: boolean
  /** 是否 OOM/显存不足类错误 */
  isOOM: boolean
  /** 设置 render.oomRetry !== false */
  oomRetryEnabled: boolean
  /** 本轮是否已做过一次 OOM 减负（不换档） */
  oomDowngraded: boolean
  /** 本轮是否已降过一次分辨率档位 */
  resDowngraded: boolean
  /** 当前档位能否再降一档（stepDownVramTier(tier) != null） */
  canStepDownTier: boolean
  mode: EngineMode
  lipMode: string
  lipSyncEnabled: boolean
  /** 已用过的瞬时重试次数（上限 2） */
  transientRetries: number
  /** 是否瞬时错误（网络/5xx/超时等） */
  isTransient: boolean
}

export type RetryDecision =
  | { kind: 'cancel' }        // 取消，原样上抛
  | { kind: 'oom-light' }     // OOM 首次减负（减帧/步/时长），continue
  | { kind: 'oom-tier' }     // OOM 二次降分辨率档位，continue
  | { kind: 'r2v-fallback' }  // H3 原生口型失败 → 回退 i2v+LatentSync，continue
  | { kind: 'transient' }     // 瞬时错误退避重试，continue
  | { kind: 'give-up' }       // 重试用尽，原样上抛

/** 按原循环顺序判定下一步动作。 */
export function decideRetryAction(i: RetryInput): RetryDecision {
  if (i.cancelled) return { kind: 'cancel' }

  if (i.oomRetryEnabled && i.isOOM) {
    if (!i.oomDowngraded) return { kind: 'oom-light' }
    if (!i.resDowngraded && i.canStepDownTier) return { kind: 'oom-tier' }
    // OOM 预算用尽：不 continue，落到下面的回退/瞬时判定（isOOM 时 r2v 回退恒 false）
  }

  if (shouldFallbackR2vToI2v({
    isOom: i.isOOM,
    mode: i.mode,
    lipMode: i.lipMode,
    lipSyncEnabled: i.lipSyncEnabled
  })) {
    return { kind: 'r2v-fallback' }
  }

  if (i.isTransient && i.transientRetries < 2) return { kind: 'transient' }

  return { kind: 'give-up' }
}
