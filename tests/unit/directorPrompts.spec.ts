import { describe, it, expect } from 'vitest'
import {
  pickPanoView,
  sanitizeCameraForFrame,
  buildCloseupEditPrompt,
  buildPanoEditPrompt
} from '../../src/main/core/directorPrompts'

/**
 * 导演首/尾帧提示词单测（directorPrompts 首个 spec）：
 * 机位方位选取、camera 净化、单人居与道具强约束、action 为 start 权威 / lastFrameEn 为 end 权威。
 */
const SIZE_CUE = '中景'

function makeDir(over: Record<string, unknown> = {}) {
  return {
    as: {
      action: 'glances over the shoulder',
      emotion: 'sad',
      camera: 'slow dolly in, blurred figure at frame edge, shallow depth of field',
      props: ['comb'],
      ...over
    }
  } as never
}

describe('pickPanoView（directorPrompts 副本）', () => {
  it('空方位图返回 undefined，未知机位取前视', () => {
    expect(pickPanoView(undefined, undefined)).toBeUndefined()
    expect(pickPanoView('closeup', ['f.png'])).toBe('f.png')
  })
})

describe('sanitizeCameraForFrame', () => {
  it('剥离第二人/人影从句，保留运镜与景深词', () => {
    const out = sanitizeCameraForFrame('slow dolly in, blurred figure at frame edge, shallow depth of field')
    expect(out).toContain('slow dolly in')
    expect(out).toContain('shallow depth of field')
    expect(out).not.toContain('blurred figure')
  })

  it('支持中文逗号分隔并过滤中文路人词', () => {
    const out = sanitizeCameraForFrame('中景，路人甲，缓慢推镜')
    expect(out).toBe('中景, 缓慢推镜')
  })

  it('过滤主角姓名与 out of focus 从句', () => {
    const out = sanitizeCameraForFrame('Su Wan as blurred figure out of focus at frame edge, medium shot, eye level')
    expect(out).toBe('medium shot, eye level')
  })

  it('空串返回空串', () => {
    expect(sanitizeCameraForFrame('')).toBe('')
  })
})

describe('buildCloseupEditPrompt', () => {
  it('start 阶段以 action 为权威，不采用 firstFrameEn', () => {
    const out = buildCloseupEditPrompt(
      'long black hair, white shirt',
      '天台',
      makeDir({ firstFrameEn: 'under the umbrella at the street corner' }),
      SIZE_CUE
    )
    expect(out).toContain('把图1中的人物放入场景「天台」')
    expect(out).toContain('glances over the shoulder')
    expect(out).not.toContain('under the umbrella')
  })

  it('注入情绪、净化后的机位与道具强约束', () => {
    const out = buildCloseupEditPrompt('long black hair', '天台', makeDir(), SIZE_CUE)
    expect(out).toContain('，sad的表情')
    expect(out).toContain('slow dolly in')
    expect(out).not.toContain('blurred figure')
    expect(out).toContain('关键道具：comb')
    expect(out).toContain('不得缺失')
  })

  it('无 props 时改用通用道具句，不列示例道具名', () => {
    const out = buildCloseupEditPrompt('long black hair', '天台', makeDir({ props: [] }), SIZE_CUE)
    expect(out).toContain('动作描述中出现的手持道具必须清晰入画')
    expect(out).not.toContain('关键道具：')
  })

  it('始终包含禁餐具、单人、背景替换等硬约束', () => {
    const out = buildCloseupEditPrompt('long black hair', '天台', makeDir(), SIZE_CUE)
    expect(out).toContain('严禁出现与动作描述无关的碗、筷、勺、杯、盘、餐具')
    expect(out).toContain('画面中只能出现主体人物一人')
    expect(out).toContain('背景完全替换为场景描述')
    expect(out).toContain('嘴部闭合')
    expect(out).toContain('保持面部、发型、服装、肤色与图1完全一致')
  })

  it('end 阶段优先 lastFrameEn，缺失时回退 action', () => {
    const withLast = buildCloseupEditPrompt(
      'long black hair', '天台', makeDir({ lastFrameEn: 'walks out of frame' }), SIZE_CUE, 'end'
    )
    expect(withLast).toContain('walks out of frame')
    expect(withLast).not.toContain('glances over the shoulder')

    const noLast = buildCloseupEditPrompt('long black hair', '天台', makeDir({ lastFrameEn: '' }), SIZE_CUE, 'end')
    expect(noLast).toContain('glances over the shoulder')
  })

  it('action 与 firstFrameEn 均缺失时省略动作从句', () => {
    const out = buildCloseupEditPrompt('long black hair', '天台', makeDir({ action: '', firstFrameEn: '' }), SIZE_CUE)
    expect(out.startsWith('把图1中的人物放入场景「天台」：中景')).toBe(true)
    expect(out).not.toContain('glances')
  })
})

describe('buildPanoEditPrompt', () => {
  it('双图语义：人物取图2、场景取图1，并锁定场景复用', () => {
    const out = buildPanoEditPrompt('long black hair', '天台', makeDir(), SIZE_CUE)
    expect(out).toContain('把图2中的人物放入图1的场景「天台」')
    expect(out).toContain('人物的面部、发型、服装、肤色与图2完全一致')
    expect(out).toContain('场景的空间布局、光线、色调、机位角度与图1完全一致')
  })

  it('同样注入道具强约束与单人硬约束', () => {
    const out = buildPanoEditPrompt('long black hair', '天台', makeDir(), SIZE_CUE)
    expect(out).toContain('关键道具：comb')
    expect(out).toContain('画面中只能出现主体人物一人')
    expect(out).toContain('严禁出现与动作描述无关的碗、筷、勺、杯、盘、餐具')
  })

  it('end 阶段用 lastFrameEn', () => {
    const out = buildPanoEditPrompt(
      'long black hair', '天台', makeDir({ lastFrameEn: 'leaves the room' }), SIZE_CUE, 'end'
    )
    expect(out).toContain('leaves the room')
  })
})
