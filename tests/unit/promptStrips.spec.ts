import { describe, it, expect } from 'vitest'
import {
  sanitizeCinematicPrompt,
  scrubSummoningTerms,
  keepDialogueChinese,
  stripDialogueDirections,
  stripSoundCuesForImage,
  stripEnglishCastNames,
  soloizeAction,
  maskCastNames,
  stripOtherPersonClauses,
  isPlaybackOrVoiceoverAction,
  stripOutdoorHints
} from '../../src/shared/promptStrips'

describe('promptStrips · 文本净化域（2026-10-30 补覆盖率）', () => {
  describe('sanitizeCinematicPrompt：清洗图生视频提示词', () => {
    it('空输入 → 原样返回', () => {
      expect(sanitizeCinematicPrompt('')).toBe('')
    })

    it('删 * 号（加粗残留）', () => {
      expect(sanitizeCinematicPrompt('**dramatic** moment')).toBe('dramatic moment')
    })

    it('删中文文艺虚词', () => {
      const v = sanitizeCinematicPrompt('唯美的诗意画面')
      expect(v).not.toMatch(/唯美|诗意/)
      expect(v).toMatch(/画面/)
    })

    it('删英文文艺虚词 ethereal / dreamy', () => {
      const v = sanitizeCinematicPrompt('an ethereal dreamy scene')
      expect(v).not.toMatch(/ethereal|dreamy/i)
      expect(v).toMatch(/an.*scene/)
    })

    it('删因果解释词（中英文）', () => {
      const v1 = sanitizeCinematicPrompt('因为下雨，所以她进来')
      expect(v1).not.toMatch(/因为|所以/)
      expect(v1).toMatch(/她进来/)

      const v2 = sanitizeCinematicPrompt('he left because it rained')
      expect(v2).not.toMatch(/because/i)
    })

    it('删空断言 consistent appearance / unchanged outfit 等', () => {
      const v = sanitizeCinematicPrompt('consistent appearance, unchanged outfit')
      expect(v).not.toMatch(/consistent appearance|unchanged outfit/i)
    })

    it('折叠双逗号与多余空白并 trim', () => {
      const v = sanitizeCinematicPrompt('scene, , dramatic, , woman')
      expect(v).not.toMatch(/,\s*,/)
      expect(v).not.toMatch(/\s{2,}/)
    })
  })

  describe('scrubSummoningTerms：正向里的概念召唤词剥离', () => {
    it('old man → 剥离', () => {
      expect(scrubSummoningTerms('an old man sits down')).toContain('sits down')
      expect(scrubSummoningTerms('an old man sits down')).not.toMatch(/old man/)
    })

    it('汽车类召唤词 → 剥离', () => {
      const v = scrubSummoningTerms('a car passes by')
      expect(v).not.toMatch(/\bcar\b/)
      expect(v).toContain('passes by')
    })

    it('neon → 保留（不再压制招牌/霓虹场景）', () => {
      expect(scrubSummoningTerms('neon lights glow')).toContain('neon')
    })

    it('全无关文本 → 原样返回', () => {
      expect(scrubSummoningTerms('a young woman smiles')).toBe('a young woman smiles')
    })

    it('空输入 → 空串', () => {
      expect(scrubSummoningTerms('')).toBe('')
    })
  })

  describe('keepDialogueChinese：保留台词标记 <d>[Chinese]…</d> 里的中文，其余中文删为空格', () => {
    it('普通中文 → 删为单个空格（正则 [\u4e00-\u9fff]+ 匹配连续中文）', () => {
      const v = keepDialogueChinese('她走向窗前')
      expect(v).not.toMatch(/[\u4e00-\u9fff]/)
    })

    it('台词标记里的中文保留', () => {
      const v = keepDialogueChinese('she walks, <d>[Chinese]你好吗</d>, smiles')
      expect(v).toContain('你好吗')
      expect(v).toContain('she walks')
    })

    it('空输入 → 空串', () => {
      expect(keepDialogueChinese('')).toBe('')
    })
  })

  describe('stripDialogueDirections：剥离开头连续括号里的表演指示', () => {
    it('空输入 → 空串', () => {
      expect(stripDialogueDirections('')).toBe('')
    })

    it('（录音播放）开头 → 剥离', () => {
      expect(stripDialogueDirections('（录音播放）这瓶辣椒水')).toBe('这瓶辣椒水')
    })

    it('【画外音】开头 → 剥离', () => {
      expect(stripDialogueDirections('【画外音】他走了')).toBe('他走了')
    })

    it('句中括号保留', () => {
      expect(stripDialogueDirections('我（小声）说')).toBe('我（小声）说')
    })

    it('开头多对括号连续剥离（最多 4 次）', () => {
      expect(stripDialogueDirections('（录音播放）（画外音）（冷笑）你好')).toBe('你好')
    })
  })

  describe('stripSoundCuesForImage：声音拟音词剥离（文生图入口）', () => {
    it('空输入 → 原样返回', () => {
      expect(stripSoundCuesForImage('')).toBe('')
    })

    it('rain hiss / distant echoes → 剥离', () => {
      const v = stripSoundCuesForImage('rain hiss, distant echoes, woman walks')
      expect(v).not.toMatch(/hiss|echoes/)
      expect(v).toContain('woman walks')
    })

    it('"sound of rain" → 剥离', () => {
      const v = stripSoundCuesForImage('sound of rain, woman stands')
      expect(v).not.toMatch(/sound of rain/)
      expect(v).toContain('woman stands')
    })
  })

  describe('stripEnglishCastNames：英文双词人名 → the subject', () => {
    it('空输入 → 空串', () => {
      expect(stripEnglishCastNames('')).toBe('')
    })

    it('双词英文名 → the subject', () => {
      const v = stripEnglishCastNames('Su Tang walks toward Lu Hanzhou')
      expect(v).not.toMatch(/Su Tang|Lu Hanzhou/)
      expect(v).toContain('the subject')
    })

    it('三词英文名（中间小写？不）→ Su Tang → 单个大写开头后跟空格大写开头', () => {
      const v = stripEnglishCastNames('Su Tang speaks')
      expect(v).toContain('the subject')
    })
  })

  describe('soloizeAction：把对戏动作改成单人姿态', () => {
    it('空输入 → 空串', () => {
      expect(soloizeAction('')).toBe('')
    })

    it('collides with the partner → stands still', () => {
      expect(soloizeAction('she collides with the partner')).toContain('stands still')
    })

    it('whispers into his ear → speaks softly', () => {
      expect(soloizeAction('she whispers into his ear')).toContain('speaks softly')
    })

    it('embraces him → reaches one hand forward', () => {
      expect(soloizeAction('she embraces him tightly')).toContain('reaches one hand forward')
    })

    it('h gripping his waist → hands held near torso', () => {
      expect(soloizeAction('her hand gripping his waist')).toContain('hands held near')
    })

    it('leans close to him → leans slightly forward', () => {
      expect(soloizeAction('she leans close to him')).toContain('leans slightly forward')
    })

    it('looking up at him → looking up', () => {
      const v = soloizeAction('she looks up at him')
      expect(v).toContain('looking up')
      expect(v).not.toMatch(/him/)
    })

    it('off-screen partner 残留清理', () => {
      const v = soloizeAction('the off-screen partner and the subject')
      expect(v).not.toMatch(/off-screen partner/)
      expect(v).not.toMatch(/\b(him|her|them)\b/)
    })
  })

  describe('maskCastNames：按姓名表替换主体名→空、对戏名→画外', () => {
    it('空输入 → 空串', () => {
      expect(maskCastNames('', { selfNames: ['张三'], otherNames: ['李四'] })).toBe('')
    })

    it('selfNames 中的英文名 → 删除（\\b 词边界对英文生效）', () => {
      const v = maskCastNames('Zhang San walks slowly', { selfNames: ['Zhang San'] })
      expect(v).not.toContain('Zhang San')
      expect(v).toContain('walks slowly')
    })

    it('otherNames 中的英文名 → 换成 the off-screen partner', () => {
      const v = maskCastNames('Li Si walks over', { otherNames: ['Li Si'] })
      expect(v).toContain('off-screen partner')
      expect(v).not.toContain('Li Si')
    })

    it('otherNames 里空字符串 → 跳过', () => {
      const v = maskCastNames('she looks at him', { otherNames: ['', '  '] })
      expect(v).toBe('she looks at him')
    })

    it('同时有 self 和 other', () => {
      const v = maskCastNames(
        'Zhang San looks at Li Si',
        { selfNames: ['Zhang San'], otherNames: ['Li Si'] }
      )
      expect(v).not.toContain('Zhang San')
      expect(v).toContain('off-screen partner')
    })

    it('正则转义测试：含特殊字符的名字', () => {
      const v = maskCastNames('Mr. Smith walks', { otherNames: ['Mr. Smith'] })
      expect(v).toContain('off-screen partner')
    })
  })

  describe('stripOtherPersonClauses：单人居从句剥离', () => {
    it('空输入 → 空串', () => {
      expect(stripOtherPersonClauses('')).toBe('')
    })

    it('Lin Chuan off-frame-left → off-screen partner', () => {
      const v = stripOtherPersonClauses('Lin Chuan off-frame-left, she speaks')
      expect(v).not.toMatch(/Lin Chuan/)
      expect(v).toContain('off-screen partner')
    })

    it('off-screen Su Tang → off-screen partner', () => {
      const v = stripOtherPersonClauses('off-screen Su Tang, she speaks')
      expect(v).not.toMatch(/Su Tang/)
      expect(v).toContain('off-screen partner')
    })

    it('", eyes locked on Lin Chuan" → 删掉对视从句', () => {
      const v = stripOtherPersonClauses('she stands, eyes locked on Lin Chuan, speaks')
      expect(v).not.toMatch(/eyes locked/)
      expect(v).not.toMatch(/Lin Chuan/)
    })

    it('", looking toward Lu Hanzhou" → 删掉面向从句', () => {
      const v = stripOtherPersonClauses('she turns, looking toward Lu Hanzhou, walks away')
      expect(v).not.toMatch(/looking toward/)
      expect(v).not.toMatch(/Lu Hanzhou/)
    })

    it('across the counter from crouching Lin Chuan → alone', () => {
      const v = stripOtherPersonClauses('she stands across the counter from crouching Lin Chuan')
      expect(v).toContain('alone')
      expect(v).not.toMatch(/Lin Chuan|across the counter/)
    })

    it('opposite Su Wan → off-screen partner', () => {
      const v = stripOtherPersonClauses('she sits opposite Su Wan')
      expect(v).toContain('off-screen partner')
    })

    it('正常单人英文 → 不破坏', () => {
      const v = stripOtherPersonClauses('a young woman walks toward the window')
      expect(v).toBe('a young woman walks toward the window')
    })
  })

  describe('isPlaybackOrVoiceoverAction：录音回放 / 画外音判定', () => {
    it('plays a recording → true', () => {
      expect(isPlaybackOrVoiceoverAction('he plays a recording')).toBe(true)
    })

    it('playback → true', () => {
      expect(isPlaybackOrVoiceoverAction('playback starts')).toBe(true)
    })

    it('中文"录音" → true', () => {
      expect(isPlaybackOrVoiceoverAction('播放录音')).toBe(true)
    })

    it('中文"画外音" → true', () => {
      expect(isPlaybackOrVoiceoverAction('画外音响起')).toBe(true)
    })

    it('voice-over → true', () => {
      expect(isPlaybackOrVoiceoverAction('voice-over narrates')).toBe(true)
    })

    it('vo 独立词 → true', () => {
      expect(isPlaybackOrVoiceoverAction('vo speaks')).toBe(true)
    })

    it('正常说话 → false', () => {
      expect(isPlaybackOrVoiceoverAction('he speaks normally')).toBe(false)
    })

    it('undefined → false', () => {
      expect(isPlaybackOrVoiceoverAction(undefined)).toBe(false)
    })

    it('空串 → false', () => {
      expect(isPlaybackOrVoiceoverAction('')).toBe(false)
    })
  })

  describe('stripOutdoorHints：户外暗示净化（室内场景）', () => {
    it('空输入 → 空串', () => {
      expect(stripOutdoorHints('', 'kitchen')).toBe('')
    })

    it('非室内场景 → 原样返回', () => {
      const v = stripOutdoorHints('rain hiss continues outside', 'park')
      expect(v).toBe('rain hiss continues outside')
    })

    it('室内场景 rain hiss continues outside → on the window', () => {
      const v = stripOutdoorHints('rain hiss continues outside', 'in the barbershop')
      expect(v).not.toMatch(/outside/)
      expect(v).toMatch(/window/)
    })

    it('室内 rain sounds → rain sounds from the window', () => {
      const v = stripOutdoorHints('rain sounds, woman sits', 'in the cafe')
      expect(v).toContain('from the window')
    })

    it('室内 on the street → by the window', () => {
      const v = stripOutdoorHints('car sounds on the street', 'in the office')
      expect(v).toContain('by the window')
      expect(v).not.toMatch(/on the street/)
    })

    it('室内 outside → through the window', () => {
      const v = stripOutdoorHints('a man looks outside', 'in the kitchen')
      expect(v).not.toMatch(/outside/)
      expect(v).toMatch(/window/)
    })

    it('室内 outdoor → indoor', () => {
      const v = stripOutdoorHints('outdoor lighting', 'studio')
      expect(v).not.toMatch(/outdoor/)
      expect(v).toMatch(/indoor/)
    })
  })
})
