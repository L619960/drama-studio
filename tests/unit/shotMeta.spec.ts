import { describe, it, expect } from 'vitest'
import {
  SHOT_SIZE_OPTIONS,
  CAMERA_OPTIONS,
  EMOTION_OPTIONS,
  metaLabel,
  displayShotSize
} from '../../src/renderer/src/utils/shotMeta'

describe('REQ-09 镜头语言字段展示', () => {
  it('景别英文值映射中文标签，空值提示默认中景', () => {
    expect(displayShotSize('closeup')).toBe('特写')
    expect(displayShotSize('wide')).toBe('远景')
    expect(displayShotSize('')).toBe('未设定（默认中景）')
    expect(displayShotSize(undefined)).toBe('未设定（默认中景）')
  })

  it('机位/情绪命中选项返回中文，未命中原样回显', () => {
    expect(metaLabel(CAMERA_OPTIONS, 'eye-level')).toBe('平视')
    expect(metaLabel(CAMERA_OPTIONS, 'handheld slow push-in')).toBe('handheld slow push-in')
    expect(metaLabel(EMOTION_OPTIONS, 'tense')).toBe('紧张')
    expect(metaLabel(EMOTION_OPTIONS, '')).toBe('')
  })

  it('选项值大小写不敏感，且每组都含默认空值以外的可选项', () => {
    expect(metaLabel(CAMERA_OPTIONS, 'EYE-LEVEL')).toBe('平视')
    expect(SHOT_SIZE_OPTIONS.map(o => o.value)).toEqual(['closeup', 'medium', 'wide'])
    expect(CAMERA_OPTIONS.length).toBeGreaterThan(0)
    expect(EMOTION_OPTIONS.length).toBeGreaterThan(0)
  })
})
