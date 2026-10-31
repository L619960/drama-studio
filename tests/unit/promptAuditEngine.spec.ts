import { describe, expect, it } from 'vitest'
import type { Project, Shot } from '../../src/shared/ipcTypes'
import { auditProjectPrompts, buildShotDriftBaseline } from '../../src/shared/promptAuditEngine'

const shot = (over: Partial<Shot> = {}): Shot => ({
  id: 's1',
  index: 1,
  scene: '便利店',
  action: 'she wipes the counter with a damp rag',
  dialogue: '',
  characterIds: [],
  type: 'i2v',
  width: 1080,
  height: 1920,
  frames: 97,
  seed: 1,
  shotSize: 'medium',
  camera: 'eye-level static, 50mm lens, medium depth of field',
  lighting: 'cool moonlight key from camera-left, low-key exposure, deep shadows',
  emotion: 'guarded tension',
  facing: 'facing camera-left, standing in the right third of frame',
  continuity: 'standing behind the counter with both hands resting on it',
  sceneEn: 'convenience store at rainy midnight, wet glass door, cold fluorescent ceiling tubes, tiled floor with dark reflections',
  firstFrameEn: 'both hands resting on the counter, medium shot, guarded tension, cool moonlight key from camera-left, static posture at the start of the shot',
  promptEn: 'the same person from the reference image, grey work jacket, starting from both hands resting on the counter, she slowly wipes the damp rag across it in one arc, keeps still, static camera, fixed framing, eye-level, guarded tension, smooth motion',
  frameSeconds: 4,
  ...over
})
const project = (shots: Shot[], over: Partial<Project> = {}): Project => ({
  id: 'p1', title: '测试项目', genre: '现代都市', episode: 1, status: 'draft',
  characters: [], sceneBoards: [], props: [], shots, fps: 24, createdAt: 0, updatedAt: 0,
  ...over
})
const codesOf = (projectObj: Project, shotId: string): string[] => {
  const task = auditProjectPrompts(projectObj).tasks.find(t => t.id === shotId)
  return (task?.issues || []).map(i => i.code)
}

describe('promptAuditEngine · 字段完整性与时长校验', () => {
  it('标准 i2v 镜无时长/字段类硬性问题', () => {
    const codes = codesOf(project([shot()]), 's1')
    expect(codes).not.toContain('frame-seconds')
    expect(codes).not.toContain('missing')
  })

  it('frameSeconds 缺失或越界 → frame-seconds 告警', () => {
    expect(codesOf(project([shot({ frameSeconds: undefined })]), 's1')).toContain('frame-seconds')
    expect(codesOf(project([shot({ frameSeconds: 9 })]), 's1')).toContain('frame-seconds')
  })

  it('i2v 缺 facing / continuity → missing（AI 可补写）', () => {
    const codes = codesOf(project([shot({ facing: undefined, continuity: undefined })]), 's1')
    expect(codes).toContain('missing')
  })
})

describe('promptAuditEngine · 同场景漂移检查', () => {
  it('同场景光线时段或主光方向反转 → scene-drift', () => {
    const codes = codesOf(project([
      shot({ id: 'a', index: 1 }),
      shot({ id: 'b', index: 2, lighting: 'warm golden-hour backlight from camera-right, soft rim light' })
    ]), 'b')
    expect(codes).toContain('scene-drift')
  })

  it('同场景光线一致 → 不报 scene-drift', () => {
    const codes = codesOf(project([
      shot({ id: 'a', index: 1 }),
      shot({ id: 'b', index: 2 })
    ]), 'b')
    expect(codes).not.toContain('scene-drift')
  })

  it('sceneEn 与场景板英文基底不重合 → scene-drift', () => {
    const board = {
      id: 'sb1', key: '便利店', name: '便利店', emptyPlatePath: 'p.png',
      description: 'convenience store interior at rainy midnight, wet glass door, cold fluorescent ceiling tubes, tiled floor with dark reflections'
    }
    const codes = codesOf(project([
      shot({ sceneEn: 'sunny beach boardwalk with palm trees and turquoise water' })
    ], { sceneBoards: [board] }), 's1')
    expect(codes).toContain('scene-drift')
  })

  it('sceneEn 复用场景板基底 → 不报 scene-drift', () => {
    const desc = 'convenience store interior at rainy midnight, wet glass door, cold fluorescent ceiling tubes, tiled floor with dark reflections'
    const codes = codesOf(project([shot({ sceneEn: desc })], {
      sceneBoards: [{ id: 'sb1', key: '便利店', name: '便利店', emptyPlatePath: 'p.png', description: desc }]
    }), 's1')
    expect(codes).not.toContain('scene-drift')
  })

  it('基线按同场景首镜建立，跨场景互不干扰', () => {
    const baseline = buildShotDriftBaseline([
      shot({ id: 'a', scene: '便利店' }),
      shot({ id: 'b', scene: '办公室', lighting: 'warm practical interior key light from camera-left' })
    ], project([]))
    expect(baseline.lighting.size).toBe(2)
  })
})
