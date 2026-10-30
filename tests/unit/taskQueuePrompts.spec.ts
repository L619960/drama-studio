/**
 * taskQueuePrompts 单元测试：H3 结构化提示词组装辅助的纯函数/半纯函数。
 * 不发真实网络、不跑真实 ComfyUI。依赖的 imagePrompts 共享工具函数
 * （motionPrompt / cleanAction / sanitizeCinematicPrompt / identityLockBlock ...）
 * 全是纯函数，直接导入执行。只 mock createLogger 消除日志副作用。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/main/core/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import type { Shot, Project, GenreTemplate } from '../../src/shared/ipcTypes'
import { driftLockBlock, usablePromptEn, sceneCueFor, propsConstraintBlock, noExtrasLockFor, buildH3Prompt } from '../../src/main/core/taskQueuePrompts'

// ---------- 辅助：构造最小 Shot ----------
function mkShot(o: Partial<Shot> = {}): Shot {
  return {
    id: 's1', index: 1, scene: '便利店', action: '转身', dialogue: '', characterIds: ['c1'],
    type: 'i2v', width: 720, height: 480, frames: 81, seed: 1, ...o
  }
}
function mkProject(o: Partial<Project> = {}): Project {
  return {
    id: 'p1', title: 'x', genre: '都市', episode: 1, status: 'draft',
    characters: [{ id: 'c1', name: '周野', refImagePath: '', description: '', voice: '', voiceRate: '' }],
    sceneBoards: [], shots: [], fps: 24, createdAt: 0, updatedAt: 0, ...o
  }
}

// ==============================================================
// driftLockBlock
// ==============================================================
describe('driftLockBlock · 位置锁定块', () => {
  it('facing 存在 → 注入 BLOCKING LOCK + facing 值', () => {
    const out = driftLockBlock(mkShot({ facing: 'facing camera, body three-quarter' }))
    expect(out).toContain('BLOCKING LOCK')
    expect(out).toContain('facing camera, body three-quarter')
    expect(out).toContain('stay in the same screen position')
  })

  it('无 facing → 不注入 BLOCKING LOCK 段落', () => {
    const out = driftLockBlock(mkShot({ facing: undefined }))
    expect(out).not.toContain('BLOCKING LOCK')
  })

  it('continuity 存在 → 注入 CONTINUITY HANDOFF 段落，并剥离对戏子句', () => {
    const out = driftLockBlock(mkShot({ continuity: 'same pose as she left him, both hands up' }))
    expect(out).toContain('CONTINUITY HANDOFF')
    expect(out).toContain('same pose as')
  })

  it('位移动作（walk toward）→ 跳过 "no sudden movement / no large displacement" 抑制，保留机位锁', () => {
    // DISPLACEMENT_ACTION_RE: walk|run|approach|走进...
    const out = driftLockBlock(mkShot({ action: 'walk toward the camera', facing: 'facing down' }))
    expect(out).not.toContain('no sudden movement')
    expect(out).not.toContain('no large displacement')
    expect(out).toContain('single atomic motion only')
    expect(out).toContain('BLOCKING LOCK')
  })

  it('普通动作 + facing → facing 块含 no body rotation，完整运动限制注入', () => {
    const out = driftLockBlock(mkShot({ action: 'slowly turns head', facing: 'camera' }))
    expect(out).toContain('no sudden movement')
    expect(out).toContain('no large displacement')
    expect(out).toContain('no body rotation')
  })

  it('无 facing 无 continuity → 只剩 single atomic motion + framing 约束', () => {
    const out = driftLockBlock(mkShot({ facing: undefined, continuity: undefined, action: 'stand still' }))
    expect(out).not.toContain('BLOCKING LOCK')
    expect(out).not.toContain('CONTINUITY')
    expect(out).toContain('single atomic motion only')
    expect(out).toContain('fixed framing')
  })
})

// ==============================================================
// usablePromptEn
// ==============================================================
describe('usablePromptEn · promptEn 有效性门控', () => {
  it('空字符串 promptEn → undefined', () => {
    expect(usablePromptEn(mkShot({ promptEn: '   ' }), '')).toBeUndefined()
  })

  it('undefined promptEn → undefined', () => {
    expect(usablePromptEn(mkShot({ promptEn: undefined }), '')).toBeUndefined()
  })

  it('含英文双词人名（Alice Green）→ undefined（避免画双人分身）', () => {
    expect(usablePromptEn(mkShot({ promptEn: 'Alice Green slowly walks' }), '')).toBeUndefined()
  })

  it('含肢体接触动词（embraces）→ undefined', () => {
    expect(usablePromptEn(mkShot({ promptEn: 'she embraces him tightly' }), '')).toBeUndefined()
  })

  it('含多个 then 动作拍数过多 → undefined', () => {
    expect(usablePromptEn(mkShot({ promptEn: 'walk forward then stop then turn then sit' }), '')).toBeUndefined()
  })

  it('正常 promptEn → 清洗后返回（stripOtherPerson / stripEnglishCastNames / soloizeAction）', () => {
    const out = usablePromptEn(mkShot({ promptEn: 'the same woman from the reference, slow turn' }), '')
    expect(out).toBeDefined()
    expect(typeof out).toBe('string')
  })
})

// ==============================================================
// sceneCueFor
// ==============================================================
describe('sceneCueFor · sceneEn 兜底提取', () => {
  it('cleanedRaw 非空且无中文 → 直接返回（已清洗过的英文 sceneEn）', () => {
    expect(sceneCueFor(mkShot({ action: '' }), 'convenience store interior')).toBe('convenience store interior')
  })

  it('cleanedRaw 为空或中文 → 从 action 提取已知场景名词 → 生成 "xxx interior, no visible signage text"', () => {
    expect(sceneCueFor(mkShot({ action: '周野走进 the convenience store' }), '')).toContain('convenience store')
    expect(sceneCueFor(mkShot({ action: '周野走进 the convenience store' }), '')).toContain('interior')
  })

  it('action 无已知场景词 → 返回空串', () => {
    expect(sceneCueFor(mkShot({ action: '周野转身' }), '')).toBe('')
  })

  it('action 英文也能提取 → 匹配 /\b(convenience store|...)/', () => {
    expect(sceneCueFor(mkShot({ action: 'walking into the street market' }), '')).toContain('street market')
  })
})

// ==============================================================
// propsConstraintBlock
// ==============================================================
describe('propsConstraintBlock · 道具硬约束', () => {
  it('COMBAT 动作（draws a sword）→  exactly ONE weapon 条款', () => {
    // COMBAT_ACTION_RE: draws? a sword|拔剑|抽出... 不是 swordfight（那是 COMBAT_OR_CLOSEUP_RE）
    const out = propsConstraintBlock(mkShot({ action: 'draws a sword to strike' }))
    expect(out).toContain('PROP LOCK')
    expect(out).toContain('exactly ONE weapon')
    expect(out).toContain('the other hand empty')
    expect(out).toContain('no dual wielding')
  })

  it('持物动作（hold a bowl）→ hands hold only the object specified', () => {
    const out = propsConstraintBlock(mkShot({ action: 'she holds a bowl of noodles' }))
    expect(out).toContain('hands hold only the object specified')
  })

  it('有 characterIds 但无 combat/hold → hands empty, no object held', () => {
    const out = propsConstraintBlock(mkShot({ action: 'slowly turns around', characterIds: ['c1'] }))
    expect(out).toContain('hands empty')
    expect(out).toContain('no object held')
  })

  it('无 characterIds（空镜 t2v）→ 返回空串（不锁双手）', () => {
    const out = propsConstraintBlock(mkShot({ action: 'empty street, wind blows', characterIds: [] }))
    expect(out).toBe('')
  })
})

// ==============================================================
// noExtrasLockFor
// ==============================================================
describe('noExtrasLockFor · 场景无路人锁', () => {
  it('非战斗 非特写 非中景 → 空串（远景/大全景不锁路人）', () => {
    expect(noExtrasLockFor(mkShot({ action: '', shotSize: 'wide' }))).toBe('')
    expect(noExtrasLockFor(mkShot({ action: 'walk', shotSize: 'longshot' }))).toBe('')
  })

  it('单人 + closeup →  exactly ONE person', () => {
    const out = noExtrasLockFor(mkShot({ action: '', shotSize: 'closeup', characterIds: ['c1'] }))
    expect(out).toContain('NO EXTRAS')
    expect(out).toContain('exactly ONE person')
    expect(out).toContain('no other people')
    expect(out).toContain('empty background')
  })

  it('单人 + medium 同样触发', () => {
    const out = noExtrasLockFor(mkShot({ action: '', shotSize: 'medium', characterIds: ['c1'] }))
    expect(out).toContain('exactly ONE person')
  })

  it('单人 + fight 动作（即使 shotSize 不触发）→ 触发锁', () => {
    const out = noExtrasLockFor(mkShot({ action: 'fight with swords', shotSize: 'wide', characterIds: ['c1'] }))
    expect(out).toContain('exactly ONE person')
  })

  it('双人 + closeup →  exactly 2 people', () => {
    const out = noExtrasLockFor(mkShot({ action: '', shotSize: 'closeup', characterIds: ['c1', 'c2'] }))
    expect(out).toContain('exactly 2 people')
    expect(out).toContain('only the 2 characters from the reference images')
  })

  it('无 characterIds → n=1 → 触发 ONE person（characterIds 为空时回退 1）', () => {
    const out = noExtrasLockFor(mkShot({ action: '', shotSize: 'closeup', characterIds: [] }))
    expect(out).toContain('exactly ONE person')
  })
})

// ==============================================================
// buildH3Prompt（大拼装，挑关键点断言；对 sceneEn / handoff / timeline 等具体实现对齐）
// ==============================================================
describe('buildH3Prompt · H3 结构化提示词组装', () => {
  const p = mkProject({
    genre: '都市',
    characters: [{ id: 'c1', name: '周野', refImagePath: '', description: 'young man in hoodie', appearanceLock: 'young asian man, black hoodie' }],
    sceneBoards: [{ id: 'b1', key: 'S1', name: '深夜便利店', description: '', emptyPlatePath: '' }]
  })

  it('i2v + 无音频 → integrated_multimodal_description + <Picture 1> subject 声明 + no speech 禁令 + TIMELINE PROTOCOL', () => {
    const shot = mkShot({ type: 'i2v', characterIds: ['c1'], sceneBoardId: 'b1', shotSize: 'medium', facing: 'camera', action: 'slowly turns to camera' })
    const out = buildH3Prompt(shot, p, false, 4, 'cinematic lighting')
    expect(out).toContain('integrated_multimodal_description')
    expect(out).toContain('<Picture 1>')
    expect(out).toContain('no speech, no narration')
    expect(out).toContain('cinematic lighting')
    expect(out).toContain('TIMELINE PROTOCOL')
    expect(out).toContain('0.00 seconds')
  })

  it('r2v + 有音频 → 注入 <d>[Chinese] 台词 + <Audio 1> 参考音频 + 仅片中角色说 + 禁旁白', () => {
    const shot = mkShot({
      type: 'i2v', characterIds: ['c1'], dialogue: '别走',
      shotSize: 'closeup', action: 'grabs her arm, urgent'
    })
    const out = buildH3Prompt(shot, p, true, 3, 'dramatic')
    expect(out).toContain('<d>[Chinese] 别走</d>')
    expect(out).toContain('<Audio 1>')
    expect(out).toContain('Lips move naturally in sync')
    expect(out).toContain('Only this character speaks')
    expect(out).toContain('no narrator, no voiceover, no commentator')
  })

  it('有角色且有 appearanceLock → identityLockBlock 输出（LOCKED IDENTITY / STRICT HAIR LOCK / STRICT OUTFIT LOCK）', () => {
    const shot = mkShot({ type: 'i2v', characterIds: ['c1'], sceneBoardId: 'b1', action: 'walk in', shotSize: 'medium' })
    const out = buildH3Prompt(shot, p, false, 4, '')
    expect(out).toContain('LOCKED IDENTITY')
    expect(out).toContain('STRICT HAIR LOCK')
    expect(out).toContain('STRICT OUTFIT LOCK')
    expect(out).toContain('young asian man')
    expect(out).toContain('black hoodie')
  })

  it('有角色但无 appearanceLock / description → 无 identity 锁定段（lookEn 为空）', () => {
    const pNoLook = mkProject({
      genre: '都市',
      characters: [{ id: 'c1', name: '周野', refImagePath: '', description: '', voice: '', voiceRate: '', appearanceLock: '' }]
    })
    const shot = mkShot({ type: 'i2v', characterIds: ['c1'], action: 'walk in', shotSize: 'medium' })
    const out = buildH3Prompt(shot, pNoLook, false, 4, '')
    expect(out).not.toContain('STRICT OUTFIT LOCK')
    // 无 lookEn → identityLockBlock 输出空串
    // 但仍有其他 motion 内容
    expect(out.length).toBeGreaterThan(0)
  })

  it('t2v（空镜 characterIds 为空）→ subject 只锁场景；无 hands lock / face expression 段落', () => {
    const shot = mkShot({ type: 'i2v', characterIds: [], action: 'wind blows papers on floor', shotSize: 'wide' })
    const out = buildH3Prompt(shot, p, false, 4, '')
    expect(out).toContain('<Picture 1>')
    // 无 characterIds → 没有 face expression 锁定
    expect(out).not.toContain('subtle natural expression')
    expect(out).not.toContain('face stays consistent')
  })

  it('sceneEn 含 noodles/soup/chopsticks 等食物实体词 → 被剥离（防模型给人物塞碗）', () => {
    const shot = mkShot({
      type: 'i2v', characterIds: ['c1'], action: 'sits down',
      sceneEn: 'steaming noodles, soup, bowl, chopsticks, food, interior'
    })
    const out = buildH3Prompt(shot, p, false, 4, '')
    // sceneCue（in xxx interior）不应再有 noodles/soup 等实体词
    // 注意 propsConstraintBlock 里的 "no cup, no bowl" 是代码层的空手锁，
    // 这里只验证 sceneEn → sceneCue 转换后的位置（in xxx interior 之后）不出现食物词
    // 用否定断言在 motion 主体里不应该出现 steaming noodles / chopsticks 这类
    // （sanitize 之后这些词不会出现在 identity/blocking/timeline 这些段）
    // 简化断言：sceneEn 里的 steaming noodles 短语不应原样出现
    expect(out).not.toContain('steaming noodles')
    expect(out).not.toContain('chopsticks')
  })

  it('有 auditFix → Revision directive 被拼接', () => {
    const shot = mkShot({ type: 'i2v', characterIds: ['c1'], action: 'walks', auditFix: 'fix face identity, add more emotion' })
    const out = buildH3Prompt(shot, p, false, 4, '')
    expect(out).toContain('Revision directive')
    expect(out).toContain('fix face identity')
  })

  it('无 auditFix → 无 Revision directive 段', () => {
    const shot = mkShot({ type: 'i2v', characterIds: ['c1'], action: 'walks' })
    const out = buildH3Prompt(shot, p, false, 4, '')
    expect(out).not.toContain('Revision directive')
  })
})
