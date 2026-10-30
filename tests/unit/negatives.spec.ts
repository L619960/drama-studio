import { describe, it, expect } from 'vitest'
import {
  oocWardrobeNegativeFor,
  videoNegativeFor,
  realismPositiveExtra,
  realismNegativeFor,
  sceneNegativeFor,
  eraNegativeFor,
  sceneSpaceNegativeFor,
  emptySceneNegativeFor,
  castingNegativeFor,
  ageDriftNegativeFor,
  frameCrowdNegativeFor,
  negativeForSlot
} from '../../src/shared/negatives'

describe('negatives · 负向提示拼装（2026-10-30 补覆盖率）', () => {
  describe('oocWardrobeNegativeFor：lock-aware OOC 服装负向', () => {
    it('lock 里有的服装词跳过，没有的压制', () => {
      const v = oocWardrobeNegativeFor('blue blazer, white shirt')
      expect(v).not.toMatch(/blazer/)
      expect(v).toMatch(/no hat/)   // hat 不在 lock
    })

    it('空 lock → 全压制', () => {
      const v = oocWardrobeNegativeFor('')
      expect(v).toContain('no hat')
      expect(v).toContain('no blazer')
    })
  })

  describe('videoNegativeFor：按镜型条件拼装视频负向', () => {
    it('位移动作 → 只注入 BASE（跳过动作压制组）', () => {
      const v = videoNegativeFor('woman walks toward the camera')
      expect(v).not.toMatch(/motion suppress|动作压制/) // 关键：不应该有抑制动作的
    })

    it('强动作 → 只注入 BASE', () => {
      const v = videoNegativeFor('he slams the door')
      expect(typeof v).toBe('string')
    })

    it('普通动作 → BASE + 动作压制组', () => {
      const v = videoNegativeFor('woman stands still')
      expect(v.length).toBeGreaterThan(videoNegativeFor('walks').length)
    })

    it('undefined action → 按普通动作处理', () => {
      const v = videoNegativeFor(undefined)
      expect(typeof v).toBe('string')
    })
  })

  describe('realismPositiveExtra：写实锁正向加强', () => {
    it('standard → 空串', () => { expect(realismPositiveExtra()).toBe('') })
    it('显式 standard → 空串', () => { expect(realismPositiveExtra('standard')).toBe('') })
    it('strong → 返回加强短语', () => {
      const v = realismPositiveExtra('strong')
      expect(v).toContain('ultra-strict')
      expect(v).toContain('identity plate')
    })
  })

  describe('realismNegativeFor：写实锁负向', () => {
    it('standard → REALISM_NEGATIVE + 皮肤瑕疵', () => {
      const v = realismNegativeFor('standard')
      expect(v).toContain('acne')
    })

    it('strong → 追加 beautified face 等更强压制', () => {
      const v = realismNegativeFor('strong')
      expect(v).toContain('beautified face')
      expect(v).toContain('acne')
    })
  })

  describe('eraNegativeFor：时代负向组', () => {
    it('现代剧 undefined → 空串', () => { expect(eraNegativeFor(undefined)).toBe('') })
    it('现代剧 genre → 空串', () => { expect(eraNegativeFor('都市言情')).toBe('') })
    it('古装剧 → 返回时代负向', () => {
      const v = eraNegativeFor('古装武侠')
      expect(v).toContain('no modern clothing')
      expect(v).toContain('no car')
    })
    it('民国 → 同样时代负向', () => {
      const v = eraNegativeFor('民国上海滩')
      expect(v).toContain('no modern clothing')
    })
  })

  describe('sceneNegativeFor：场景类负向 = 写实 + 时代', () => {
    it('现代剧 → 只有写实', () => {
      const v = sceneNegativeFor('standard', '都市')
      expect(v).not.toContain('no modern clothing')
    })

    it('古装 → 写实 + 时代', () => {
      const v = sceneNegativeFor('standard', '古装')
      expect(v).toContain('no modern clothing')
    })
  })

  describe('sceneSpaceNegativeFor：按场景名生成空间类型负向', () => {
    it('室内场景 → 压室外元素', () => {
      const v = sceneSpaceNegativeFor('男厕所')
      expect(v).toContain('street')
      expect(v).toContain('traffic')
    })

    it('英文 indoor 场景 → 同样压室外', () => {
      const v = sceneSpaceNegativeFor('office kitchen')
      expect(v).toContain('street')
    })

    it('室外场景 → 空串', () => {
      expect(sceneSpaceNegativeFor('公园广场')).toBe('')
      expect(sceneSpaceNegativeFor('street corner')).toBe('')
    })

    it('空场景 → 空串', () => {
      expect(sceneSpaceNegativeFor('')).toBe('')
    })
  })

  describe('emptySceneNegativeFor：空场景专用负向', () => {
    it('无 scene → 写实 + EMPTY_SCENE_NEGATIVE', () => {
      const v = emptySceneNegativeFor('standard')
      expect(v).toContain('people')
      expect(v).toContain('cartoon')
    })

    it('有室内 scene → 叠加空间负向', () => {
      const v = emptySceneNegativeFor('standard', '男厕所')
      expect(v).toContain('people')
      expect(v).toContain('street')
    })

    it('有室外 scene → 不加空间负向（空）', () => {
      const v = emptySceneNegativeFor('standard', '公园')
      expect(v).not.toMatch(/traffic|street/)
    })
  })

  describe('castingNegativeFor：定妆背景隔离负向', () => {
    it('现代剧 → 写实 + 背景隔离', () => {
      const v = castingNegativeFor('standard')
      expect(v).toContain('street')
      expect(v).toContain('city')
    })

    it('古装 → 叠加时代负向', () => {
      const v = castingNegativeFor('standard', '古装')
      expect(v).toContain('no modern clothing')
    })
  })

  describe('ageDriftNegativeFor：老年漂移负向', () => {
    it('lookEn 为空 → 空串', () => { expect(ageDriftNegativeFor('')).toBe('') })

    it('lookEn 含 elderly/old man 关键词 → 空串（允许老年）', () => {
      expect(ageDriftNegativeFor('an old man with white beard')).toBe('')
      expect(ageDriftNegativeFor('elderly chinese woman')).toBe('')
    })

    it('lookEn 描述年轻人 → 返回老年压制', () => {
      const v = ageDriftNegativeFor('young woman in her 20s')
      expect(v).toContain('old man')
      expect(v).toContain('elderly face')
    })
  })

  describe('frameCrowdNegativeFor：首帧人数负向', () => {
    it('count ≤ 1 → 单人镜压制第二人', () => {
      const v = frameCrowdNegativeFor(1)
      expect(v).toContain('two people')
      expect(v).toContain('deformed hands')
    })

    it('count = 0 → 同样单人压制', () => {
      const v = frameCrowdNegativeFor(0)
      expect(v).toContain('two people')
    })

    it('count > 1 → 群像压制', () => {
      const v = frameCrowdNegativeFor(5)
      expect(v).toContain('crowd')
      expect(v).not.toContain('two people')
    })
  })

  describe('negativeForSlot：有负向入口时才返回文字', () => {
    it('hasSlot = false → undefined', () => {
      expect(negativeForSlot(false, 'a, b')).toBeUndefined()
    })

    it('negative 为空 → undefined', () => {
      expect(negativeForSlot(true, '')).toBeUndefined()
      expect(negativeForSlot(true, '   ')).toBeUndefined()
    })

    it('hasSlot = true 且有内容 → 返回 trim 后文字', () => {
      expect(negativeForSlot(true, '  a, b  ')).toBe('a, b')
    })
  })
})
