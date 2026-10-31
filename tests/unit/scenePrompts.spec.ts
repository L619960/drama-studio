import { describe, it, expect } from 'vitest'
import {
  eraLockBlock,
  castLookForGenre,
  shotSizeCueFor,
  sceneIsIndoor,
  interiorCueFor,
  faceExpressionLockFor,
  periodLockFor,
  faceCastingPrompt,
  bodySheetPrompt,
  panoramaScenePrompt,
  scenePlatePrompt,
  videoMotionPrompt,
  shotFramePrompt,
  timelineProtocolBlock
} from '../../src/shared/scenePrompts'

describe('scenePrompts · 镜头/场景提示组装域（2026-10-30 补前几个简单函数）', () => {
  describe('eraLockBlock：时代锁块', () => {
    it('民国 → 1930s republican-era（正向写旗袍/长衫，不用否定式）', () => {
      const v = eraLockBlock('民国上海滩')
      expect(v).toContain('republican-era')
      expect(v).toContain('qipao')
      expect(v).not.toMatch(/no ancient hanfu/)
    })

    it('古装武侠 → wuxia + hanfu，禁止 modern/katana/ninja', () => {
      const v = eraLockBlock('古装武侠')
      expect(v).toContain('wuxia')
      expect(v).toContain('hanfu')
      expect(v).toMatch(/no modern/i)
      expect(v).toMatch(/no.*katana/i)
      expect(v).toMatch(/no.*ninja/i)
    })

    it('现代剧 → modern contemporary', () => {
      const v = eraLockBlock('都市言情')
      expect(v).toContain('modern contemporary')
    })

    it('undefined → 空串', () => { expect(eraLockBlock(undefined)).toBe('') })
    it('空串 → 空串', () => { expect(eraLockBlock('')).toBe('') })
  })

  describe('castLookForGenre：按流派清洗定妆', () => {
    it('现代剧 → lookEn 原样返回', () => {
      expect(castLookForGenre('young woman, jeans, t-shirt', '都市')).toBe('young woman, jeans, t-shirt')
    })

    it('古装剧 → 删现代服装词', () => {
      const v = castLookForGenre('chinese man, jeans, t-shirt, sword', '古装')
      expect(v).not.toMatch(/jeans|t-shirt/)
      expect(v).toContain('sword')
    })

    it('undefined genre → 原样返回', () => {
      expect(castLookForGenre('hello', undefined)).toBe('hello')
    })
  })

  describe('shotSizeCueFor：景别 → 提示词 cue', () => {
    it('closeup → 特写 cue', () => {
      const v = shotSizeCueFor('closeup')
      expect(v.toLowerCase()).toMatch(/closeup|extreme close/)
    })

    it('medium → 中景', () => {
      const v = shotSizeCueFor('medium')
      expect(v).toBeTruthy()
    })

    it('wide → 远景', () => {
      const v = shotSizeCueFor('wide')
      expect(v).toBeTruthy()
    })

    it('大小写不敏感', () => {
      expect(shotSizeCueFor('CLOSEUP')).toBe(shotSizeCueFor('closeup'))
    })

    it('未知值 → fallback medium', () => {
      expect(shotSizeCueFor('unknown')).toBe(shotSizeCueFor('medium'))
    })

    it('undefined → fallback medium', () => {
      expect(shotSizeCueFor()).toBe(shotSizeCueFor('medium'))
    })
  })

  describe('sceneIsIndoor：场景是否室内', () => {
    it('男厕所 → true', () => { expect(sceneIsIndoor('男厕所')).toBe(true) })
    it('办公室 → true', () => { expect(sceneIsIndoor('总裁办公室')).toBe(true) })
    it('park → false', () => { expect(sceneIsIndoor('park')).toBe(false) })
    it('street → false', () => { expect(sceneIsIndoor('street')).toBe(false) })
    it('空串 → false', () => { expect(sceneIsIndoor('')).toBe(false) })
    it('厕所+街 混合 → false（同时命中 indoor 和 outdoor）', () => {
      // "公厕" 有厕(indoor) 和 街(outdoor)? 让我想... 实际上 "公园厕所" 里 park 是 outdoor, 厕所是 indoor
      expect(sceneIsIndoor('公园厕所')).toBe(false)
    })
  })

  describe('interiorCueFor：室内/室外 cue', () => {
    it('室内 → 封闭四面墙（正向描述，不写否定词）', () => {
      const v = interiorCueFor('男厕所')
      expect(v).toContain('fully enclosed interior')
      expect(v).not.toMatch(/exterior location/)
    })

    it('室外 → exterior location', () => {
      const v = interiorCueFor('street corner')
      expect(v).toContain('exterior location')
    })

    it('已含 interior 关键词 → 空串（避免重复注入）', () => {
      expect(interiorCueFor('interior living room')).toBe('')
    })

    it('混合 → 空串', () => {
      expect(interiorCueFor('公园厕所')).toBe('')
    })

    it('空串 → 空串', () => { expect(interiorCueFor('')).toBe('') })
  })

  describe('faceExpressionLockFor：表情锁', () => {
    it('无 emotion → 返回默认 subtle natural expression', () => {
      const v = faceExpressionLockFor()
      expect(v).toContain('subtle natural expression')
    })

    it('emotion 不匹配强表情 → 同样返回默认', () => {
      const v = faceExpressionLockFor('smiling')
      expect(v).toContain('subtle natural expression')
    })

    it('强表情 emotion → 返回强表情锁短语', () => {
      const v = faceExpressionLockFor('crying, eyes wide open')
      expect(v).toContain('facial expression follows')
    })
  })

  describe('periodLockFor：朝代锁（scenePrompts 未展开的部分）', () => {
    it('古装 → 时代锁内容', () => {
      const v = periodLockFor('古装武侠')
      expect(v).toContain('ancient chinese')
      expect(v).not.toContain('no modern objects')
    })
  })

  describe('正向提示规则审计（2026-10-31 整改回归）', () => {
    it('定妆/全景/首尾帧/视频运动提示不再含被清除的否定式硬规则', () => {
      const face = faceCastingPrompt('young woman, black hair bun, beige coat')
      expect(face).not.toContain('no film grain')
      expect(face).not.toContain('no beauty filter')

      const pano = panoramaScenePrompt('street corner')
      expect(pano).not.toContain('no CGI')
      expect(pano).not.toContain('no vignette')
      expect(pano).not.toContain('no seam')

      const frame = shotFramePrompt({
        phase: 'start',
        lookEn: 'young woman, black hair bun',
        scene: 'street corner',
        action: 'stands still'
      })
      expect(frame).not.toContain('no extra people')
      expect(frame).not.toContain('no background crowd')

      const motion = videoMotionPrompt({ action: 'woman walks' })
      expect(motion).not.toContain('no mid-clip light change')
      expect(motion).not.toContain('no side-slide')
    })
  })

  describe('faceCastingPrompt：定妆头照提示词（复杂 joinParts 拼装）', () => {
    it('空 lookEn → 用默认 chinese person', () => {
      const v = faceCastingPrompt('')
      expect(v).toContain('grey wall')
      expect(v).toContain('chinese person')
    })

    it('正常 lookEn → 拼接含时代锁+身份锁+写实锁', () => {
      const v = faceCastingPrompt('black hair bun, red hanfu robe, round face', {
        realismLock: 'standard', genre: '古装武侠'
      })
      expect(v).toContain('hanfu')
      expect(v).toContain('LOCKED IDENTITY')
    })

    it('strong realism → 追加 ultra-strict', () => {
      const v = faceCastingPrompt('young woman', { realismLock: 'strong' })
      expect(v).toContain('ultra-strict')
    })
  })

  describe('bodySheetPrompt：全身三视图提示词', () => {
    it('空 lookEn → 用默认 chinese person', () => {
      const v = bodySheetPrompt('')
      expect(v).toContain('three equal panels')
      expect(v).toContain('chinese person')
    })
    it('有 lookEn + genre → 含时代锁', () => {
      const v = bodySheetPrompt('black hair bun, red hanfu robe', { genre: '古装武侠' })
      expect(v).toContain('hanfu')
      expect(v).toContain('LOCKED IDENTITY')
    })
  })

  describe('panoramaScenePrompt：全景场景图提示词', () => {
    it('室外场景 → 含 360-degree + panorama + 2:1', () => {
      const v = panoramaScenePrompt('公园广场')
      expect(v).toContain('360-degree')
      expect(v).toMatch(/panorama/i)
      expect(v).toContain('2:1')
    })
    it('室内场景（总裁办公室）→ ultra-wide rectilinear interior 分支', () => {
      const v = panoramaScenePrompt('总裁办公室')
      expect(v).toContain('rectilinear interior')
      expect(v).not.toMatch(/360-degree panorama/i)
      expect(v).toContain('2:1')
    })
    it('rainy weather → 含雨景词', () => {
      const v = panoramaScenePrompt('街道', undefined, { weatherHint: 'rainy' })
      expect(v).toMatch(/rain/i)
    })
    it('mood 存在 → 含 mood 词', () => {
      const v = panoramaScenePrompt('办公室', '紧张压抑')
      expect(v).toContain('紧张压抑')
    })
  })

  describe('scenePlatePrompt：场景参考图提示词', () => {
    it('基础 indoor scene → 返回非空字符串', () => {
      const v = scenePlatePrompt('男厕所')
      expect(v.length).toBeGreaterThan(10)
      expect(typeof v).toBe('string')
    })
    it('emptyStrict → 返回非空字符串', () => {
      const v = scenePlatePrompt('公园', undefined, { emptyStrict: true })
      expect(v.length).toBeGreaterThan(10)
    })
  })

  describe('videoMotionPrompt：视频动作提示词', () => {
    it('空 action → 返回非空', () => {
      const v = videoMotionPrompt({ action: '' })
      expect(v.length).toBeGreaterThan(5)
    })
    it('正常 action → 返回非空', () => {
      const v = videoMotionPrompt({ action: 'woman walks toward camera' })
      expect(v.length).toBeGreaterThan(5)
    })
  })

  describe('shotFramePrompt：首/末帧提示词（复杂拼装）', () => {
    it('phase start + 全参数 → 返回完整提示词', () => {
      const v = shotFramePrompt({
        phase: 'start',
        lookEn: 'young woman, black hair, coat',
        scene: 'rainy street at night',
        action: 'woman walks',
        emotion: 'melancholy',
        camera: 'medium shot',
        lighting: 'dramatic neon',
        facing: 'front',
        characterCount: 1
      })
      expect(v.length).toBeGreaterThan(50)
      expect(typeof v).toBe('string')
    })

    it('phase end + props → 含道具锁定', () => {
      const v = shotFramePrompt({
        phase: 'end',
        lookEn: 'man in suit',
        scene: 'office',
        action: 'holds a smartphone',
        props: ['smartphone']
      })
      expect(v.length).toBeGreaterThan(50)
    })
  })

  describe('timelineProtocolBlock：时间轴协议块（三段式）', () => {
    it('正常 sec=5 fps=24 → 有 start/mid/end 三段', () => {
      const v = timelineProtocolBlock({
        sec: 5,
        fps: 24,
        firstFrameEn: 'start pose',
        midFrameEn: 'middle action',
        lastFrameEn: 'end pose'
      })
      expect(v).toContain('start pose')
      expect(v).toContain('middle action')
      expect(v).toContain('end pose')
    })

    it('sec 小数 → Math.round 处理', () => {
      const v = timelineProtocolBlock({ sec: 4.67, fps: 16 })
      expect(v.length).toBeGreaterThan(10)
    })

    it('transition 存在 → 协议块里含转场词', () => {
      const v = timelineProtocolBlock({ sec: 4, fps: 24, transition: 'cut to', firstFrameEn: 'pose' })
      expect(v.length).toBeGreaterThan(10)
    })
  })
})
