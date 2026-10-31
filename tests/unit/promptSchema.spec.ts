import { describe, expect, it } from 'vitest'
import type { AnalyzedShot } from '../../src/shared/ipcTypes'
import {
  defaultCameraFor, defaultLightingFor, frameSecondsFor, normalizeShotPrompts,
  sanitizeEnglishField
} from '../../src/shared/promptSchema'

const shot = (over: Partial<AnalyzedShot> = {}): AnalyzedShot => ({
  scene: '便利店',
  action: 'she wipes the counter with a damp rag',
  dialogue: '',
  type: 'i2v',
  characterIds: [],
  ...over
})

describe('sanitizeEnglishField：英文提示词清洗', () => {
  it('纯中文 → 视为缺失（返回 undefined）', () => {
    expect(sanitizeEnglishField('她站着不动')).toBeUndefined()
  })
  it('中英混写 → 剥离中文并清理全角标点', () => {
    expect(sanitizeEnglishField('she stands still，半身不动')).toBe('she stands still')
  })
  it('换行/制表/Markdown 星号 → 收敛为单行纯文本', () => {
    expect(sanitizeEnglishField('she *slowly*\nraises\tone hand')).toBe('she slowly raises one hand')
  })
  it('空值/纯空白 → undefined', () => {
    expect(sanitizeEnglishField('')).toBeUndefined()
    expect(sanitizeEnglishField(null)).toBeUndefined()
  })
})

describe('frameSecondsFor：3~6 秒兜底', () => {
  it('已有合法整数 → 原样保留', () => {
    expect(frameSecondsFor('随便说说', 4)).toBe(4)
  })
  it('越界值 → 按台词重算（无台词回 3 秒）', () => {
    expect(frameSecondsFor('', 9)).toBe(3)
  })
  it('12 字台词 → 4 字/秒 + 2 秒缓冲 = 5 秒', () => {
    expect(frameSecondsFor('你终于来了我等你很久', undefined)).toBe(5)
  })
  it('超长台词 → 收敛到上限 6 秒', () => {
    const long = '一'.repeat(40)
    expect(frameSecondsFor(long, undefined)).toBe(6)
  })
})

describe('光线/机位兜底：按场景与景别给标准值', () => {
  it('夜景 → 月光低照度，不用日光；雨夜 → 街灯实用光', () => {
    expect(defaultLightingFor('深夜天台')).toContain('moonlight')
    expect(defaultLightingFor('雨夜天台')).toContain('streetlight')
  })
  it('室内 → 实用光灯', () => {
    expect(defaultLightingFor('办公室')).toContain('interior')
  })
  it('特写/远景 → 对应焦距与景深', () => {
    expect(defaultCameraFor('closeup')).toContain('85mm')
    expect(defaultCameraFor('closeup')).toContain('shallow depth of field')
    expect(defaultCameraFor('wide')).toContain('24mm')
  })
})

describe('normalizeShotPrompts：字段补齐与同场景统一', () => {
  it('缺失字段全部补成标准英文（camera/lighting/emotion/facing/continuity/时长/切镜/帧提示词）', () => {
    const { shots, notes } = normalizeShotPrompts([shot(), shot({ scene: '便利店' })])
    const s = shots[0]
    expect(s.camera).toContain('eye-level')
    expect(s.camera).toContain('lens')
    expect(s.lighting).toBeTruthy()
    expect(s.emotion).toBeTruthy()
    expect(s.facing).toBeTruthy()
    expect(s.continuity).toBeTruthy()
    expect(s.frameSeconds).toBe(3)
    expect(s.transition).toBe('hard')
    expect(s.firstFrameEn).toBeTruthy()
    expect(s.promptEn).toBeTruthy()
    expect(notes.length).toBeGreaterThan(0)
  })

  it('同场景 sceneEn 统一为 scenes[].en 基底，逐镜改写的地点被拉回', () => {
    const { shots } = normalizeShotPrompts(
      [
        shot({ sceneEn: 'bright shopping mall atrium with glass railings' }),
        shot({ sceneEn: 'sunny beach boardwalk with palm trees' })
      ],
      { scenes: [{ name: '便利店', en: 'convenience store at rainy midnight, wet glass door, cold fluorescent ceiling tubes' }] }
    )
    expect(shots[0].sceneEn).toBe(shots[1].sceneEn)
    expect(shots[0].sceneEn).toContain('convenience store')
    expect(shots[0].sceneEn).not.toContain('boardwalk')
  })

  it('同场景 lighting 统一为同一主光方向（杜绝忽昼忽夜/忽左忽右）', () => {
    const { shots } = normalizeShotPrompts([
      shot({ lighting: 'cool moonlight key from camera-left, low-key exposure' }),
      shot({ lighting: 'warm golden-hour backlight from camera-right, soft rim light' })
    ])
    expect(shots[1].lighting).toBe(shots[0].lighting)
  })

  it('中文残留的英文字段被清洗；纯中文 action 保留原文但绝不进英文提示词', () => {
    const { shots } = normalizeShotPrompts([shot({ action: '她慢慢擦柜台', camera: '静态镜头' })])
    expect(shots[0].action).toBe('她慢慢擦柜台')
    expect(shots[0].camera).toContain('eye-level')
    expect(shots[0].promptEn).not.toMatch(/[一-龥]/)
    expect(shots[0].firstFrameEn).not.toMatch(/[一-龥]/)
  })

  it('negativeEn 去除系统已注入的通用负向；现代剧再去时代隔离词，古装剧保留', () => {
    const modern = normalizeShotPrompts([shot({ negativeEn: 'no morphing, no lighting flicker, no modern vehicles' })], { genre: '现代都市' })
    expect(modern.shots[0].negativeEn).toBe('no lighting flicker')
    const period = normalizeShotPrompts([shot({ negativeEn: 'no morphing, no modern vehicles' })], { genre: '古装武侠剧' })
    expect(period.shots[0].negativeEn).toBe('no modern vehicles')
  })

  it('末镜清空 handoffToNext，非末镜补齐承接', () => {
    const { shots } = normalizeShotPrompts([shot(), shot(), shot({ handoffToNext: 'stale handoff from llm' })])
    expect(shots[0].handoffToNext).toBeTruthy()
    expect(shots[1].handoffToNext).toBeTruthy()
    expect(shots[2].handoffToNext).toBeUndefined()
  })

  it('道具去空去重', () => {
    const { shots } = normalizeShotPrompts([shot({ props: ['umbrella', 'umbrella', '  ', 'rag'] })])
    expect(shots[0].props).toEqual(['umbrella', 'rag'])
  })

  it('幂等：规范化两次结果一致，第二次无新告警', () => {
    const opts = { scenes: [{ name: '便利店', en: 'convenience store at rainy midnight, wet glass door, cold fluorescent ceiling tubes' }] }
    const once = normalizeShotPrompts([shot(), shot()], opts)
    const twice = normalizeShotPrompts(once.shots, opts)
    expect(twice.shots).toEqual(once.shots)
    expect(twice.notes).toEqual([])
  })
})
