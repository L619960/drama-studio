import { describe, it, expect } from 'vitest'
import {
  pickCandidateSystem, translatePromptPrompts, optimizePromptSystem,
  fillPromptPrompts, translateTextSystem, reviewStorySystem,
  diagnoseFailureSystem, auditImageSystem, auditImageUser
} from '../../src/main/core/llmPromptsOps'

/**
 * 日常操作提示词（llmPromptsOps）单测：
 * 多候选/翻译/优化/字段补写/复审/诊断/视觉审核提示词的必备约束与上下文拼装。
 */
describe('pickCandidateSystem', () => {
  it('带上候选类型标签并要求只输出 JSON', () => {
    const s = pickCandidateSystem('分镜')
    expect(s).toContain('抽卡导演')
    expect(s).toContain('分镜')
    expect(s).toContain('"index"')
    expect(s).toContain('禁止 markdown')
  })
})

describe('translatePromptPrompts', () => {
  it('system 禁止描述外貌，user 拼入场景/动作/台词', () => {
    const r = translatePromptPrompts(
      { scene: '雨夜天台', action: 'slowly turns around', dialogue: '你来了' },
      '古风悬疑'
    )
    expect(r.system).toContain('Never describe character appearance')
    expect(r.system).toContain('古风悬疑')
    expect(r.user).toContain('场景: 雨夜天台')
    expect(r.user).toContain('动作: slowly turns around')
    expect(r.user).toContain('台词情绪参考: 你来了')
  })

  it('无台词与无风格时省略对应行', () => {
    const r = translatePromptPrompts({ scene: '', action: 'walks away', dialogue: '' })
    expect(r.user).toContain('场景: 未指定')
    expect(r.user).not.toContain('台词情绪参考')
    expect(r.system).not.toContain('Style prefix')
  })
})

describe('optimizePromptSystem', () => {
  it('正负向两档规则不同', () => {
    expect(optimizePromptSystem('negative')).toContain('suppress')
    expect(optimizePromptSystem('positive')).toContain('20~60 words')
  })
})

describe('fillPromptPrompts', () => {
  const guide = {
    field: 'promptEn', label: '本镜英文提示词', lang: 'en' as const,
    range: [15, 40] as [number, number],
    role: '描述动作/镜头/光影',
    mustAvoid: ['人物外貌', '解释性句子']
  }

  it('system 写入语种/区间/禁止项', () => {
    const { system } = fillPromptPrompts(guide, { currentText: 'old text' })
    expect(system).toContain('本镜英文提示词（promptEn）')
    expect(system).toContain('英文')
    expect(system).toContain('15~40 词')
    expect(system).toContain('- 人物外貌')
    expect(system).toContain('- 解释性句子')
  })

  it('range 上限 0 显示无上限；user 按上下文逐项拼装', () => {
    const unlimited = fillPromptPrompts({ ...guide, range: [10, 0] }, { currentText: '' })
    expect(unlimited.system).toContain('≥10 词（无上限）')
    expect(unlimited.user).toContain('（空）')

    const { user } = fillPromptPrompts(guide, {
      currentText: 'hello',
      scene: '天台', sceneEn: 'rooftop', action: 'turns', shotSize: 'medium',
      type: 'i2v', characterName: '林夏', characterLocks: 'long black hair',
      props: '伞', era: '古装', issue: '动作缺失'
    })
    expect(user).toContain('- 场景：天台')
    expect(user).toContain('- 同场景已锁环境短语')
    expect(user).toContain('- 本镜动作（必须逐字呼应动词与道具名）：turns')
    expect(user).toContain('- 景别：medium')
    expect(user).toContain('- 镜头类型：i2v')
    expect(user).toContain('- 出场角色：林夏')
    expect(user).toContain('- 角色定妆外观锁')
    expect(user).toContain('- 本镜道具：伞')
    expect(user).toContain('- 时代：古装')
    expect(user).toContain('- 体检问题：动作缺失')
    expect(user).toContain('当前字段内容')
  })
})

describe('其余 system 提示词', () => {
  it('翻译/复审/诊断/视觉审核均要求只输出结果', () => {
    expect(translateTextSystem()).toContain('output ONLY the translation')
    expect(reviewStorySystem()).toContain('"passed": true 或 false')
    expect(reviewStorySystem()).toContain('关键道具落幅')
    expect(diagnoseFailureSystem()).toContain('"canAutoFix"')
    expect(diagnoseFailureSystem()).toContain('原样自动重试')
  })

  it('视觉审核 system 注入清单，user 标注镜号/景别/机位与外观锁', () => {
    const sys = auditImageSystem('- 人脸身份一致')
    expect(sys).toContain('- 人脸身份一致')
    expect(sys).toContain('block 项任一不过')

    const user = auditImageUser({
      index: 3, kind: 'video', scene: '天台', character: '林夏',
      action: '转身', shotSize: 'closeup', camera: 'slow push-in',
      lookEn: 'long black hair'
    })
    expect(user).toContain('第3镜 视频抽帧审核｜景别:closeup｜机位:slow push-in')
    expect(user).toContain('场景:天台｜角色:林夏｜外观锁定:long black hair')
    expect(user).toContain('动作:转身')

    const noLook = auditImageUser({
      index: 1, kind: 'keyframe', scene: '空镜', character: '空镜',
      action: '雨落', shotSize: 'wide', camera: 'static'
    })
    expect(noLook).toContain('关键帧审核')
    expect(noLook).not.toContain('外观锁定')
  })
})
