/**
 * llmParsers.normalizeBindings 分支覆盖（2026-10-30）：
 * i2v 跳过 / 无主角警告 / 别名精确 / 去头衔 / 去姓 shortMap / 模糊 includes /
 * 拼音容错 / 无法匹配警告 / claimPerformer 认领 / alignStoryboardPrompts 改写。
 */
import { describe, it, expect } from 'vitest'
import { normalizeBindings } from '../../src/main/core/llmParsers'
import type { AnalyzeResult, AnalyzedCharacter, AnalyzedShot } from '../../src/shared/ipcTypes'

const char = (name: string, extra: Partial<AnalyzedCharacter> = {}): AnalyzedCharacter => ({
  name,
  gender: 'male',
  appearance: '',
  lookEn: 'young man, short black hair',
  ...extra,
})

const shot = (o: Partial<AnalyzedShot>): AnalyzedShot => ({
  scene: '客厅',
  action: '',
  dialogue: '',
  type: 'i2v',
  ...o,
})

const result = (characters: AnalyzedCharacter[], shots: AnalyzedShot[]): AnalyzeResult => ({
  characters,
  shots,
})

describe('normalizeBindings · 角色绑定归一', () => {
  describe('i2v 过滤与无主角警告', () => {
    it('t2v 镜头直接跳过：不产生警告、名不改', () => {
      const r = normalizeBindings(result([char('林川')], [shot({ type: 't2v', action: 'wind blows' })]))
      expect(r.warnings).toBeUndefined()
      expect(r.shots[0]?.type).toBe('t2v')
    })

    it('i2v 无 characterName → 未归属主角警告', () => {
      const r = normalizeBindings(result([char('林川')], [shot({ scene: '废弃工厂', action: 'empty room' })]))
      expect(r.warnings).toContain('镜头「废弃工厂」为人物镜头但未归属主角')
    })
  })

  describe('别名精确命中', () => {
    it('全名命中 → 保持标准名', () => {
      const r = normalizeBindings(result([char('林川')], [shot({ characterName: '林川' })]))
      expect(r.shots[0]?.characterName).toBe('林川')
      expect(r.warnings).toBeUndefined()
    })

    it('别名命中 → 归一为标准名', () => {
      const r = normalizeBindings(result([char('林川', { aliases: ['阿川'] })], [shot({ characterName: '阿川' })]))
      expect(r.shots[0]?.characterName).toBe('林川')
    })

    it('别名大小写/空白容错（foldName）', () => {
      const r = normalizeBindings(
        result([char('林川', { aliases: [' Lin Chuan '] })], [shot({ characterName: 'lin  chuan' })]),
      )
      expect(r.shots[0]?.characterName).toBe('林川')
    })
  })

  describe('去头衔兜底', () => {
    it('"陆总" 去「总」后模糊命中 陆沉', () => {
      const r = normalizeBindings(result([char('陆沉')], [shot({ characterName: '陆总' })]))
      expect(r.shots[0]?.characterName).toBe('陆沉')
    })

    it('"林先生" 去「先生」后命中 林川', () => {
      const r = normalizeBindings(result([char('林川')], [shot({ characterName: '林先生' })]))
      expect(r.shots[0]?.characterName).toBe('林川')
    })
  })

  describe('去姓 shortMap 直接命中', () => {
    it('"景琛" → 沈景琛（name.slice(1) 索引）', () => {
      const r = normalizeBindings(result([char('沈景琛')], [shot({ characterName: '景琛' })]))
      expect(r.shots[0]?.characterName).toBe('沈景琛')
    })
  })

  describe('模糊 includes 命中 + characters 列表归一', () => {
    it('命中后 s.characters 经 aliasMap 归一并 trim', () => {
      const r = normalizeBindings(
        result(
          [char('陆沉', { aliases: ['小沉'] })],
          [shot({ characterName: '陆总', characters: [' 小沉 ', ' 路人 '] })],
        ),
      )
      expect(r.shots[0]?.characterName).toBe('陆沉')
      expect(r.shots[0]?.characters).toEqual(['陆沉', '路人'])
    })
  })

  describe('拼音容错', () => {
    it('"Lin Chuan" ↔ 林川，characters 别名同步归一', () => {
      const r = normalizeBindings(
        result([char('林川', { aliases: ['阿川'] })], [shot({ characterName: 'Lin Chuan', characters: ['阿川'] })]),
      )
      expect(r.shots[0]?.characterName).toBe('林川')
      expect(r.shots[0]?.characters).toEqual(['林川'])
    })
  })

  describe('无法匹配警告', () => {
    it('"机器猫" 无法匹配 → 警告含角色表清单，原名保留', () => {
      const r = normalizeBindings(result([char('林川')], [shot({ scene: '天台', characterName: '机器猫' })]))
      expect(r.warnings).toContain('镜头「天台」的主角「机器猫」无法匹配角色表（林川）')
      expect(r.shots[0]?.characterName).toBe('机器猫')
    })

    it('已有 warnings 数组 → 追加而非覆盖', () => {
      const base = result([char('林川')], [shot({ scene: '天台', characterName: '机器猫' })])
      base.warnings = ['原有告警']
      const r = normalizeBindings(base)
      expect(r.warnings).toEqual(['原有告警', '镜头「天台」的主角「机器猫」无法匹配角色表（林川）'])
    })
  })

  describe('claimPerformer 空镜认领', () => {
    it('t2v 动作含中文名「陈舟」→ 改判 i2v 并绑定主角', () => {
      const r = normalizeBindings(result([char('陈舟')], [shot({ type: 't2v', action: '陈舟 pushes the door open' })]))
      expect(r.shots[0]?.type).toBe('i2v')
      expect(r.shots[0]?.characterName).toBe('陈舟')
      expect(r.shots[0]?.characters).toEqual(['陈舟'])
    })

    it('t2v 动作含拼音连写 chenzhou → 认领 陈舟', () => {
      const r = normalizeBindings(
        result([char('陈舟')], [shot({ type: 't2v', action: 'chenzhou stands alone in the rain' })]),
      )
      expect(r.shots[0]?.type).toBe('i2v')
      expect(r.shots[0]?.characterName).toBe('陈舟')
    })

    it('t2v 动作无人物 → 保持空镜不认领', () => {
      const r = normalizeBindings(
        result([char('陈舟')], [shot({ type: 't2v', action: 'wind sweeps the empty street' })]),
      )
      expect(r.shots[0]?.type).toBe('t2v')
      expect(r.shots[0]?.characterName).toBeUndefined()
    })
  })

  describe('alignStoryboardPrompts 生成期改写', () => {
    it('promptEn 身份漂移（old man）→ 按本镜动作改写，notes 不进 warnings', () => {
      const r = normalizeBindings(
        result(
          [char('林川')],
          [
            shot({
              characterName: '林川',
              action: '林川 opens the door slowly',
              promptEn: 'the same old man walks down the hallway',
            }),
          ],
        ),
      )
      expect(r.shots[0]?.promptEn).toContain('the same person from the reference image')
      expect(r.shots[0]?.promptEn).not.toContain('old man')
      expect((r.warnings || []).some((w) => w.includes('提示词核对'))).toBe(false)
    })

    it('同场景下一镜缺 continuity → 自动补上衔接句', () => {
      const r = normalizeBindings(
        result(
          [char('林川')],
          [
            shot({ scene: '客厅', characterName: '林川', action: '林川 opens the door slowly' }),
            shot({ scene: '客厅', characterName: '林川', action: '林川 steps inside' }),
          ],
        ),
      )
      expect(r.shots[1]?.continuity).toContain('continues immediately after the previous shot')
      expect(r.shots[1]?.continuity).toContain('林川 opens the door slowly')
    })

    it('sceneEn 纯中文动作串戏 → 弃用场景提示词', () => {
      const r = normalizeBindings(
        result(
          [char('林川')],
          [
            shot({
              characterName: '林川',
              action: '林川站在门口发呆',
              sceneEn: 'a cozy living room with a wooden door and bookshelf',
            }),
          ],
        ),
      )
      expect(r.shots[0]?.sceneEn).toBeUndefined()
    })
  })
})
