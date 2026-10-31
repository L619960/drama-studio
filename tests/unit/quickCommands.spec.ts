import { describe, it, expect } from 'vitest'
import { buildRerenderShotCommand } from '../../src/shared/quickCommands'

describe('导演对话快捷指令（REQ-14 DC-OPEN-26）', () => {
  it('正整数镜号生成指令文本', () => {
    expect(buildRerenderShotCommand(3)).toBe('重渲第 3 镜')
    expect(buildRerenderShotCommand(' 12 ')).toBe('重渲第 12 镜')
  })

  it('非法输入返回 null（不发送空指令）', () => {
    expect(buildRerenderShotCommand('')).toBeNull()
    expect(buildRerenderShotCommand('abc')).toBeNull()
    expect(buildRerenderShotCommand(0)).toBeNull()
    expect(buildRerenderShotCommand(-2)).toBeNull()
    expect(buildRerenderShotCommand(1.5)).toBeNull()
  })
})
