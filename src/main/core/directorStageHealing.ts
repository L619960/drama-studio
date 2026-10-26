import type { DirectorStage } from '../../shared/ipcTypes'
import { isTransientError } from './errorClassify'
import type { DirectorStageRuntime } from './directorStageAssets'
/** C 自愈预算：每项目每次流水线运行最多自动重试 HEAL_MAX 次（runPipeline 开头清零） */
const HEAL_MAX = 2

/**
 * C 错误回流自愈：阶段失败时把错误样本交回 LLM 诊断，
 * 判定值得重试（瞬时/抖动类）且预算未耗尽时自动重跑一次，否则把
 * 诊断与修复建议写入 state.heal 供 UI 展示后暂停。
 * @returns true = 已自动重试且重试动作本身未抛错（最终结果由调用方复查产物）
 */
export async function selfHealStage(
  rt: DirectorStageRuntime,
  projectId: string,
  stage: DirectorStage,
  stageLabel: string,
  errors: string[],
  retry: () => Promise<void>
): Promise<boolean> {
  const used = rt.healBudget.get(projectId) ?? 0
  if (used >= HEAL_MAX) return false
  const state = rt.states.get(projectId)
  if (!state) return false

  rt.setStage(projectId, stage, 'running', 'AI 正在诊断失败原因...', 0)
  let diag: { canAutoFix: boolean; diagnosis: string; suggestion: string }
  try {
    diag = await rt.llm.diagnoseFailure({
      stageLabel,
      errors: errors.slice(0, 5),
      context: `项目共 ${state.totalShots} 镜，此前成功 ${state.doneShots} 镜`
    })
  } catch {
    // 诊断服务不可用：降级为不自愈，保持原失败路径
    return false
  }

  if (!diag.canAutoFix) {
    // 预算只在真正执行重试时消耗（D5）：诊断失败/不可自动修复不挤占额度
    state.heal = { stage, diagnosis: diag.diagnosis, suggestion: diag.suggestion }
    rt.log(projectId, stage, 'warn',
      `AI 诊断：${diag.diagnosis}。建议：${diag.suggestion}（需人工处理后重试）`)
    return false
  }

  rt.healBudget.set(projectId, used + 1)
  state.heal = { stage, diagnosis: diag.diagnosis, suggestion: '已自动重试（若再次失败请按建议人工处理）' }
  rt.log(projectId, stage, 'warn',
    `AI 自诊断：${diag.diagnosis}——判定可自动恢复，正在自动重试「${stageLabel}」（${used + 1}/${HEAL_MAX}）`)
  try {
    await retry()
    return true
  } catch (e) {
    rt.log(projectId, stage, 'error', `自动重试仍未成功: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

/**
 * B 瞬时故障重试包装：网络抖动/服务过载/超时类错误自动退避重试，
 * 永久性错误立即原样抛出。notify 用于把重试过程写进阶段消息。
 * isCancelled 传入后退避等待按 200ms 分片轮询，取消时立即抛 CANCELLED（D6）。
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; notify?: (msg: string) => void; isCancelled?: () => boolean } = {}
): Promise<T> {
  const retries = opts.retries ?? 2
  let lastErr: unknown
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (i === retries || !isTransientError(e)) throw e
      const delay = 3000 * (i + 1)
      opts.notify?.(`遇到瞬时异常（${(e as Error).message.slice(0, 80)}），${delay / 1000}s 后自动重试（${i + 1}/${retries}）...`)
      const deadline = Date.now() + delay
      while (Date.now() < deadline) {
        if (opts.isCancelled?.()) throw new Error('CANCELLED')
        await new Promise(r => setTimeout(r, 200))
      }
    }
  }
  throw lastErr
}
