import { describe, expect, it } from 'vitest'
import type { Project, Shot } from '../../src/shared/ipcTypes'
import { applyAutoFixes, assignField } from '../../src/shared/promptAuditFixes'
import { auditProjectPrompts } from '../../src/shared/promptAuditEngine'

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
  status: 'pending',
  shotSize: 'medium',
  camera: 'eye-level static, 50mm lens, medium depth of field',
  lighting: 'cool moonlight key from camera-left, low-key exposure, deep shadows',
  emotion: 'guarded tension',
  facing: 'facing camera-left, standing in the right third of frame',
  continuity: 'standing behind the counter with both hands resting on it',
  sceneEn:
    'convenience store at rainy midnight, wet glass door, cold fluorescent ceiling tubes, tiled floor with dark reflections',
  firstFrameEn:
    'both hands resting on the counter, medium shot, guarded tension, cool moonlight key from camera-left, static posture at the start of the shot',
  promptEn:
    'the same person from the reference image, grey work jacket, starting from both hands resting on the counter, she slowly wipes the damp rag across it in one arc, keeps still, static camera, fixed framing, eye-level, guarded tension, smooth motion',
  frameSeconds: 4,
  ...over,
})

const project = (shots: Shot[], over: Partial<Project> = {}): Project => ({
  id: 'p1',
  title: '测试项目',
  genre: '现代都市',
  episode: 1,
  status: 'draft',
  characters: [],
  sceneBoards: [],
  props: [],
  shots,
  fps: 24,
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

/** 取修正后某镜的字段值 */
const fieldOf = (p: Project, shotId: string, field: string): string => {
  const s = (p.shots || []).find((x) => x.id === shotId)
  const v = s ? (s as unknown as Record<string, unknown>)[field] : undefined
  return typeof v === 'string' ? v : ''
}

describe('applyAutoFixes · 确定性文本修复', () => {
  it('英文提示词混入中文 → 删除 CJK 字符并返回新副本', () => {
    const original = project([shot({ camera: 'eye-level static 平视 50mm lens' })])
    const { project: fixed, applied } = applyAutoFixes(original)
    expect(applied).toBeGreaterThan(0)
    const camera = fieldOf(fixed, 's1', 'camera')
    expect(camera).not.toMatch(/[\u4e00-\u9fff]/)
    expect(camera).toContain('50mm lens')
    // 原项目不被修改（纯函数语义）
    expect(fieldOf(original, 's1', 'camera')).toBe('eye-level static 平视 50mm lens')
  })

  it('多余空白/换行 → 归一为单行纯文本', () => {
    const original = project([shot({ camera: 'eye-level   static,\n50mm lens' })])
    const { project: fixed, applied } = applyAutoFixes(original)
    expect(applied).toBeGreaterThan(0)
    const camera = fieldOf(fixed, 's1', 'camera')
    expect(camera).not.toMatch(/\s{2,}|\n|\t|\r/)
    expect(camera).toContain('50mm lens')
  })

  it('Markdown 星号 → 净化后不再含 *', () => {
    const original = project([shot({ camera: 'eye-level static, **beauty** 50mm lens' })])
    const { project: fixed } = applyAutoFixes(original)
    expect(fieldOf(fixed, 's1', 'camera')).not.toContain('*')
  })

  it('套话词 clearly visible → 删除且不残留悬空连接词', () => {
    const original = project([shot({ camera: 'eye-level static, clearly visible, 50mm lens' })])
    const { project: fixed } = applyAutoFixes(original)
    const camera = fieldOf(fixed, 's1', 'camera')
    expect(camera.toLowerCase()).not.toContain('clearly visible')
    expect(camera).toContain('50mm lens')
  })

  it('进图字段含声场拟音词 → 剥除拟音残留', () => {
    const original = project([
      shot({ firstFrameEn: 'both hands resting on the counter, the hiss of rain outside, medium shot' }),
    ])
    const { project: fixed } = applyAutoFixes(original)
    const text = fieldOf(fixed, 's1', 'firstFrameEn').toLowerCase()
    expect(text).not.toContain('hiss')
    expect(text).toContain('medium shot')
  })

  it('古装缺时代隔离 → 负向自动补齐 ERA_TERMS', () => {
    const original = project([shot({ negativeEn: 'no extra characters' })], { genre: '古装武侠' })
    const { project: fixed } = applyAutoFixes(original)
    const negative = fieldOf(fixed, 's1', 'negativeEn').toLowerCase()
    expect(negative).toContain('no modern vehicles')
    expect(negative).toContain('no extra characters')
  })

  it('正负向服装冲突 → 只删除负向的 no <term>，正向不动', () => {
    const original = project([
      shot({
        promptEn:
          'the same person from the reference image, grey apron, wipes the counter in one arc, static camera, fixed framing, smooth motion',
        negativeEn: 'no apron, no extra characters',
      }),
    ])
    const { project: fixed } = applyAutoFixes(original)
    const negative = fieldOf(fixed, 's1', 'negativeEn')
    expect(negative).not.toMatch(/\bno\s+apron\b/i)
    expect(negative).toContain('no extra characters')
    expect(fieldOf(fixed, 's1', 'promptEn')).toContain('grey apron')
  })

  it('taskIds 过滤：只修指定任务，其余任务保持原样', () => {
    const original = project([
      shot({ id: 's1', index: 1, camera: 'eye-level static 平视 50mm lens' }),
      shot({ id: 's2', index: 2, camera: 'eye-level static 俯视 50mm lens' }),
    ])
    const { project: fixed } = applyAutoFixes(original, { taskIds: ['s1'] })
    expect(fieldOf(fixed, 's1', 'camera')).not.toMatch(/[\u4e00-\u9fff]/)
    expect(fieldOf(fixed, 's2', 'camera')).toBe('eye-level static 俯视 50mm lens')
  })

  it('只改提示词字段：status / 产物路径 / 脚本保持原值', () => {
    const original = project(
      [shot({ camera: 'eye-level static 平视 50mm lens', status: 'done', firstFramePath: 'shots/a.png' })],
      { script: '第一场 便利店 夜 内' },
    )
    const { project: fixed } = applyAutoFixes(original)
    const s = fixed.shots[0]
    if (!s) throw new Error('测试夹具缺少 fixed.shots[0]')
    expect(s.status).toBe('done')
    expect(s.firstFramePath).toBe('shots/a.png')
    expect(fixed.script).toBe('第一场 便利店 夜 内')
    expect(fixed.id).toBe('p1')
  })

  it('无 fixable 问题时 applied 为 0 且内容不变', () => {
    const original = project([shot()])
    const { project: fixed, applied } = applyAutoFixes(original)
    expect(applied).toBe(0)
    expect(fixed).toEqual(original)
  })

  it('角色外观锁含中文同样可修（scope=character 写回路径）', () => {
    const original = project([], {
      characters: [
        {
          id: 'c1',
          name: '林晚',
          description: '短发、深色外套',
          appearanceLock: 'late twenties woman, short black hair 短发, grey coat',
          voice: '',
        } as unknown as Project['characters'][number],
      ],
    })
    const report = auditProjectPrompts(original)
    expect(report.tasks.some((t) => t.scope === 'character' && t.issues.some((i) => i.code === 'chinese-char'))).toBe(
      true,
    )
    const { project: fixed } = applyAutoFixes(original)
    const ch = (fixed.characters || []).find((c) => c.id === 'c1')
    expect(ch?.appearanceLock || '').not.toMatch(/[\u4e00-\u9fff]/)
    expect(ch?.description).toBe('短发、深色外套')
  })
})

describe('assignField · 边界', () => {
  it('任务目标不存在时返回 false', () => {
    const p = project([])
    const ok = assignField(p, { id: 'missing', scope: 'shot' } as never, 'camera', 'x')
    expect(ok).toBe(false)
  })

  it('P2-3：白名单外字段（status/seed 等非提示词字段）拒绝写入', () => {
    const p = project([shot()])
    const task = auditProjectPrompts(p).tasks[0]
    if (!task) throw new Error('测试夹具缺少 auditProjectPrompts(p).tasks[0]')
    const okField = assignField(p, task, 'camera', 'low angle static')
    expect(okField).toBe(true)
    expect(p.shots[0]?.camera).toBe('low angle static')
    // 非白名单字段：不得越界写入（原实现会直接给对象塞任意属性）
    expect(assignField(p, task, 'status', 'done')).toBe(false)
    expect(assignField(p, task, 'seed', '42')).toBe(false)
    expect(p.shots[0]?.status).toBe('pending')
    expect(p.shots[0]?.seed).toBe(1)
  })
})
