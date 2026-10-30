import type { Project } from '../../../shared/ipcTypes'
import {
  unreviewedRenderShots, warnedBatchKey, isWarnSuppressed
} from '../../../shared/pipelineGuards'
import router from '../router'
import { confirmUnreviewedBatch } from './confirm'

/**
 * 分镜审核「告警放行」二次确认（UX-P1-05 / REQ-04）。
 * 设置里 shotReviewGate=warn 时，未核对首帧的 i2v 镜头仍会入队，旧实现只在入队后
 * 弹一条 warning，用户没有反悔机会。这里在渲染前按与主进程相同的目标镜头规则预判，
 * 命中未核对镜头时给出「去审看 / 仍要渲染 / 取消」三选一，取消或去审看都不入队。
 * 用户明确选择「仍要渲染」后，同一项目同一批镜 30 分钟内不再重复弹框（内存态）。
 * block 模式由主进程直接拒绝，off 模式无需提示，两者都返回 true。
 */
const warnedBatches = new Map<string, number>()

export async function confirmUnreviewedRender(
  project: Project,
  shotIds?: string[],
  opts: { reason?: string; treatAllAsUnreviewed?: boolean } = {}
): Promise<boolean> {
  const settings = await window.api.settings.get()
  if ((settings?.render?.shotReviewGate ?? 'block') !== 'warn') return true

  const unreviewed = unreviewedRenderShots(project.shots, shotIds, opts.treatAllAsUnreviewed)
  if (unreviewed.length === 0) return true

  const ids = unreviewed.map(s => s.id)
  const key = warnedBatchKey(project.id, ids)
  if (isWarnSuppressed(warnedBatches.get(key), Date.now())) return true

  const list = unreviewed.slice(0, 8).map(s => `第${s.index}镜`).join('、')
  const more = unreviewed.length > 8 ? ` 等 ${unreviewed.length} 镜` : ''
  const message = `${opts.reason ? opts.reason + ' ' : ''}${list}${more}的首帧尚未核对，继续将按「告警放行」直接入队渲染，发现问题需重新渲染。`
  const choice = await confirmUnreviewedBatch(message)

  if (choice === 'render') {
    warnedBatches.set(key, Date.now())
    return true
  }
  if (choice === 'review') {
    // 复用 REQ-02 的审看定位：分镜页消费 ?review=<shotId> 并自动打开审核弹窗
    void router.push({
      path: `/project/${project.id}/storyboard`,
      query: { review: ids[0] }
    })
  }
  return false
}
