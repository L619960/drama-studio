import { describe, it, expect } from 'vitest'
import { buildFinishedNotification } from '../../src/shared/notify'
import type { DirectorFinishedEvent } from '../../src/shared/ipcTypes'

function event(patch: Partial<DirectorFinishedEvent>): DirectorFinishedEvent {
  return {
    type: 'director:finished',
    projectId: 'p1',
    title: '雨夜重逢',
    success: true,
    cancelled: false,
    failedShotIds: [],
    message: '',
    ...patch
  }
}

describe('任务终态系统通知文案（REQ-15）', () => {
  it('完成时带片名与镜头总数', () => {
    const copy = buildFinishedNotification(event({ totalShots: 12 }))
    expect(copy).toEqual({ title: '渲染完成', body: '《雨夜重逢》渲染完成，共 12 镜' })
  })

  it('完成但镜数缺失时不拼接数量', () => {
    const copy = buildFinishedNotification(event({}))
    expect(copy?.body).toBe('《雨夜重逢》渲染完成')
  })

  it('失败时带片名与收尾原因', () => {
    const copy = buildFinishedNotification(event({ success: false, message: '字幕阶段失败' }))
    expect(copy).toEqual({ title: '任务失败', body: '《雨夜重逢》任务失败：字幕阶段失败' })
  })

  it('用户主动取消不发通知', () => {
    expect(buildFinishedNotification(event({ cancelled: true, success: false }))).toBeNull()
  })

  it('片名为空时使用「未命名项目」兜底', () => {
    expect(buildFinishedNotification(event({ title: '  ', totalShots: 12 }))?.body).toBe('《未命名项目》渲染完成，共 12 镜')
  })
})
