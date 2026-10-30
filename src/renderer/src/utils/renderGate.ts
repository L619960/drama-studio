import type { Project } from '../../../shared/ipcTypes'
import { unreviewedRenderShots } from '../../../shared/pipelineGuards'
import { confirmAction } from './confirm'

/**
 * 分镜审核「告警放行」二次确认（UX-P1-05）。
 * 设置里 shotReviewGate=warn 时，未核对首帧的 i2v 镜头仍会入队，旧实现只在入队后
 * 弹一条 warning，用户没有反悔机会。这里在渲染前按与主进程相同的目标镜头规则预判，
 * 命中未核对镜头时先确认，取消则直接返回 false、不入队。
 * block 模式由主进程直接拒绝，off 模式无需提示，两者都返回 true。
 */
export async function confirmUnreviewedRender(
  project: Project,
  shotIds?: string[],
  opts: { reason?: string; treatAllAsUnreviewed?: boolean } = {}
): Promise<boolean> {
  const settings = await window.api.settings.get()
  if ((settings?.render?.shotReviewGate ?? 'block') !== 'warn') return true

  const unreviewed = unreviewedRenderShots(project.shots, shotIds, opts.treatAllAsUnreviewed)
  if (unreviewed.length === 0) return true

  const list = unreviewed.slice(0, 8).map(s => `第${s.index}镜`).join('、')
  const more = unreviewed.length > 8 ? ` 等 ${unreviewed.length} 镜` : ''
  const message = `${opts.reason ? opts.reason + ' ' : ''}${list}${more}尚未核对分镜图，继续将按「告警放行」直接入队渲染，发现问题需重新渲染。`
  return confirmAction(message, { title: '分镜未核对', confirmText: '仍要渲染', cancelText: '先去核对' })
}
