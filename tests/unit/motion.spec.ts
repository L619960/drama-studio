import { describe, it, expect } from 'vitest'
import {
  cleanAction,
  actionLacksEnglish,
  motionCueFromAction,
  chooseRenderWorkflow,
  DISPLACEMENT_ACTION_RE,
  STRONG_ACTION_RE,
  COMBAT_ACTION_RE
} from '../../src/shared/motion'

describe('motion · 视频动作/运动域（2026-10-30 补覆盖率）', () => {
  describe('cleanAction：清洗 LLM 动作里的身份锁定套话', () => {
    it('空字符串 → 原样返回', () => {
      expect(cleanAction('')).toBe('')
    })

    it('undefined → 原样返回（防御）', () => {
      expect(cleanAction(undefined as unknown as string)).toBe(undefined)
    })

    it('删掉 "from the reference image keeps identical face" 套话', () => {
      const v = cleanAction(
        'the young woman from the reference image keeps identical face and outfit, walks forward'
      )
      expect(v).not.toMatch(/reference image/)
      expect(v).not.toMatch(/keeps identical/)
      expect(v).toContain('walks forward')
    })

    it('删掉 "keep identical look" 套话（注意：正则只匹配 keep/keeping，不匹配 keeps）', () => {
      const v = cleanAction('keep identical look, sits down')
      expect(v).not.toMatch(/keeps? identical/)
      expect(v).toContain('sits down')
    })

    it('删掉 "do not change face/outfit" 套话', () => {
      const v = cleanAction('do not change the face or outfit, speaks')
      expect(v).not.toMatch(/do not change/)
      expect(v).toContain('speaks')
    })

    it('折叠双逗号和多余空白', () => {
      const v = cleanAction('walks, , speaks, , turns')
      expect(v).not.toMatch(/,\s*,/)
      expect(v).not.toMatch(/\s{2,}/)
    })

    it('正常动作无套话 → 原样 trim 后返回', () => {
      const v = cleanAction('  woman walks toward camera  ')
      expect(v).toBe('woman walks toward camera')
    })
  })

  describe('actionLacksEnglish：中文≥4字 且 英文<4词 → 纯中文标记', () => {
    it('纯中文 → true', () => {
      expect(actionLacksEnglish('他走向窗前，看着远方')).toBe(true)
    })

    it('中英混合 → false', () => {
      expect(actionLacksEnglish('he walks toward the window')).toBe(false)
    })

    it('中文<4字 → false', () => {
      expect(actionLacksEnglish('好的')).toBe(false)
    })

    it('全英文 → false', () => {
      expect(actionLacksEnglish('a woman walks slowly')).toBe(false)
    })
  })

  describe('motionCueFromAction：中文/英文动作 → 英文单拍动作 cue', () => {
    it('空输入 → pose fallback', () => {
      expect(motionCueFromAction('')).toContain('holds the pose')
    })

    it('英文动作 → 清洗后返回第一拍（soloized + stripOtherPersonClauses）', () => {
      const v = motionCueFromAction(
        'the woman walks toward the camera, then speaks to Lu Hanzhou'
      )
      expect(v).not.toMatch(/then/)
      expect(v).not.toMatch(/Lu Hanzhou/)
    })

    it('英文超长 → 截断 110 字符', () => {
      const long = 'a '.repeat(200) + 'woman walks toward camera slowly and speaks'
      const v = motionCueFromAction(long)
      expect(v.length).toBeLessThanOrEqual(110 + 50) // slice(0,110) + 尾部清逗号 trim
    })

    // ---- 中文 table 分支 ----
    it('中文"拔剑" → draws the sword', () => {
      expect(motionCueFromAction('他拔剑出鞘')).toContain('draws the sword')
    })

    it('中文"收剑" → sheathes', () => {
      expect(motionCueFromAction('他收剑回鞘')).toContain('sheathes')
    })

    it('中文"侧身" → sidesteps', () => {
      expect(motionCueFromAction('她侧身躲过')).toContain('sidesteps')
    })

    it('中文"格开" → parries', () => {
      expect(motionCueFromAction('他格开来剑')).toContain('parries')
    })

    it('中文"按剑" → holds still', () => {
      expect(motionCueFromAction('他按剑立在原地')).toContain('holds still')
    })

    it('中文"退回" → steps back', () => {
      expect(motionCueFromAction('他退回了一步')).toContain('steps back')
    })

    it('中文"退一步" → steps back', () => {
      expect(motionCueFromAction('他退一步')).toContain('steps back')
    })

    it('中文"开口" → speaks', () => {
      expect(motionCueFromAction('她开口说道')).toContain('speaks')
    })

    it('中文无匹配 → fallback pose', () => {
      expect(motionCueFromAction('他微微一笑，眨了眨眼')).toContain('holds the pose')
    })
  })

  describe('chooseRenderWorkflow：出视频前工作流选型', () => {
    it('pinned 优先 → 直接返回指定工作流', () => {
      const v = chooseRenderWorkflow({ pinned: 'custom_wf', action: 'walk' })
      expect(v.workflow).toBe('custom_wf')
      expect(v.reason).toContain('已指定')
    })

    it('有 dialogue 且非 playback → minimax_h3_r2v（走口型）', () => {
      const v = chooseRenderWorkflow({ dialogue: '你好', action: 'walk' })
      expect(v.workflow).toBe('minimax_h3_r2v')
      expect(v.reason).toContain('口型')
    })

    it('playback + dialogue → minimax_h3_i2v（不走口型）', () => {
      const v = chooseRenderWorkflow({ dialogue: '录音内容', action: 'plays a recording, speaks' })
      expect(v.workflow).toBe('minimax_h3_i2v')
      expect(v.reason).toContain('不走本角色口型')
    })

    it('有 dialogue 但 action 含 voice-over → i2v（不走口型）', () => {
      const v = chooseRenderWorkflow({ dialogue: '画外音', action: 'voice-over, speaks' })
      expect(v.workflow).toBe('minimax_h3_i2v')
    })

    it('武打/持械 → minimax_h3_i2v（首帧锁定）', () => {
      const v = chooseRenderWorkflow({ action: 'he draws the sword and parries' })
      expect(v.workflow).toBe('minimax_h3_i2v')
      expect(v.reason).toContain('首帧锁定')
    })

    it('中文"拔剑" → 持械判定生效 → i2v', () => {
      const v = chooseRenderWorkflow({ action: '他拔剑出鞘刺向敌人' })
      expect(v.workflow).toBe('minimax_h3_i2v')
    })

    it('跨镜位移 + 有尾帧 → wan22_remix_flf2v', () => {
      const v = chooseRenderWorkflow({ action: 'walks toward the door', hasEndFrame: true })
      expect(v.workflow).toBe('wan22_remix_flf2v')
      expect(v.reason).toContain('首尾帧')
    })

    it('跨镜位移但无尾帧 → fallback', () => {
      const v = chooseRenderWorkflow({ action: 'walks toward the door', hasEndFrame: false })
      expect(v.workflow).toBe('minimax_h3_i2v')
    })

    it('自定义 defaultWorkflow → fallback 为 default', () => {
      const v = chooseRenderWorkflow({ action: 'just standing', defaultWorkflow: 'my_custom' })
      expect(v.workflow).toBe('my_custom')
      expect(v.reason).toContain('按项目默认')
    })

    it('全空 → 默认 minimax_h3_i2v', () => {
      const v = chooseRenderWorkflow({})
      expect(v.workflow).toBe('minimax_h3_i2v')
    })
  })

  describe('正则常量导出（烟雾测试）', () => {
    it('DISPLACEMENT_ACTION_RE 匹配中文位移词', () => {
      expect(DISPLACEMENT_ACTION_RE.test('他走进房间')).toBe(true)
      expect(DISPLACEMENT_ACTION_RE.test('she walks away')).toBe(true)
      expect(DISPLACEMENT_ACTION_RE.test('he stands still')).toBe(false)
    })

    it('STRONG_ACTION_RE 匹配强动作', () => {
      expect(STRONG_ACTION_RE.test('她摔砸了花瓶')).toBe(true)
      expect(STRONG_ACTION_RE.test('he slams the door')).toBe(true)
      expect(STRONG_ACTION_RE.test('他拿起杯子')).toBe(false)
    })

    it('COMBAT_ACTION_RE 匹配武打', () => {
      expect(COMBAT_ACTION_RE.test('她侧身 parries')).toBe(true)
      expect(COMBAT_ACTION_RE.test('他站着不动')).toBe(false)
    })
  })
})
