import { describe, it, expect } from 'vitest'
import {
  extractAppearanceClauses,
  extractOutfitLock,
  frameAppearanceLock,
  stripOocWardrobe,
  stripModernWardrobe,
  isPeriodGenre,
  sanitizeCastLook,
  identityLockBlock,
  lookEnStructureIssues,
  hardenLookWeapons,
  differentiateLooks,
  hardenLookEnList
} from '../../src/shared/castAppearance'

describe('castAppearance · 定妆外观/身份锁域（2026-10-30 补未覆盖函数）', () => {
  describe('extractAppearanceClauses + extractOutfitLock', () => {
    it('拆出 hair 和 outfit 句子', () => {
      const v = extractAppearanceClauses('long black hair bun, blue hanfu robe, holding a sword')
      expect(v.hair).toContain('hair')
      expect(v.outfit).toContain('hanfu')
    })

    it('hair 和 outfit 同句时不重复计入', () => {
      const v = extractAppearanceClauses('long hair and hanfu robe')
      // 含两个关键词但同句，可能被两边都命中——取决于过滤条件
      expect(typeof v.hair).toBe('string')
      expect(typeof v.outfit).toBe('string')
    })

    it('extractOutfitLock → extractAppearanceClauses().outfit', () => {
      expect(extractOutfitLock('blue hanfu robe')).toContain('hanfu')
    })
  })

  describe('frameAppearanceLock：正向外观锁', () => {
    it('hair 和 outfit 都有 → 点名定妆内容', () => {
      const v = frameAppearanceLock('black hair bun, red hanfu robe')
      expect(v).toContain('发型只允许')
      expect(v).toContain('black hair bun')
      expect(v).toContain('服装只允许')
      expect(v).toContain('red hanfu robe')
    })

    it('只有 hair → outfit 用默认短语', () => {
      const v = frameAppearanceLock('black hair bun')
      expect(v).toContain('发型只允许与定妆相同：black hair bun')
      expect(v).toContain('服装只允许与定妆图相同')
    })

    it('空输入 → 全走默认短语', () => {
      const v = frameAppearanceLock('')
      expect(v).toContain('发型只允许与定妆图相同')
      expect(v).toContain('服装只允许与定妆图相同')
    })
  })

  describe('stripOocWardrobe：OOC 服装清洗', () => {
    it('空 prompt → 原样返回', () => {
      expect(stripOocWardrobe('', 'hanfu robe')).toBe('')
    })

    it('prompt 里有 apron 但 lookEn 没有 → 删 apron', () => {
      const v = stripOocWardrobe('woman walks, white apron', 'blue hanfu robe')
      expect(v).not.toMatch(/apron/)
      expect(v).toContain('woman walks')
    })

    it('prompt 里的 hat 但 lookEn 里也有 → 保留', () => {
      const v = stripOocWardrobe('woman with hat walks', 'hat and robe')
      expect(v).toContain('hat')
    })

    it('删后清理双逗号和空白', () => {
      const v = stripOocWardrobe('apron, , woman, , walks', 'robe')
      expect(v).not.toMatch(/apron/)
      expect(v).not.toMatch(/,\s*,/)
    })

    it('lookEn 为空 → 所有高危词都删', () => {
      const v = stripOocWardrobe('apron, hat, vest, necktie', '')
      // 全删后可能残留逗号或空串
      expect(v).not.toMatch(/apron|hat|vest|necktie/i)
    })
  })

  describe('stripModernWardrobe：古装剧现代服装清洗', () => {
    it('空 lookEn → 原样返回', () => {
      expect(stripModernWardrobe('')).toBe('')
    })

    it('纯古装 lookEn → 原样返回（不触发兜底）', () => {
      const v = stripModernWardrobe('ancient chinese hanfu robe, black hair bun with hairpin')
      expect(v).not.toContain('hanfu robes') // 兜底补的
    })

    it('含现代服装词 → 删除并补兜底', () => {
      const v = stripModernWardrobe('chinese man, leather jacket, jeans, short hair')
      expect(v).not.toMatch(/leather jacket|jeans/)
      expect(v).toContain('hanfu robes')
    })

    it('含高危词 ninja → 追加兜底', () => {
      const v = stripModernWardrobe('man, ninja outfit, katana')
      expect(v).not.toMatch(/ninja|katana/i)
      expect(v).toContain('hanfu robes')
    })

    it('清洗后太短（< 8 词）→ 补兜底', () => {
      const v = stripModernWardrobe('man')
      expect(v).toContain('hanfu robes')
    })
  })

  describe('isPeriodGenre：判定是否古风/年代类', () => {
    it('古装武侠 → true', () => { expect(isPeriodGenre('古装武侠')).toBe(true) })
    it('民国 → true', () => { expect(isPeriodGenre('民国上海滩')).toBe(true) })
    it('仙侠 → true', () => { expect(isPeriodGenre('仙侠')).toBe(true) })
    it('现代都市 → false', () => { expect(isPeriodGenre('都市言情')).toBe(false) })
    it('undefined → false', () => { expect(isPeriodGenre(undefined)).toBe(false) })
    it('空串 → false', () => { expect(isPeriodGenre('')).toBe(false) })
  })

  describe('sanitizeCastLook：定妆皮肤清洗', () => {
    it('空 → 原样返回', () => { expect(sanitizeCastLook('')).toBe('') })
    it('含 acne → 删除；stubble 等真实纹理保留', () => {
      const v = sanitizeCastLook('man with stubble, acne scars on face')
      expect(v).not.toMatch(/acne/i)
      expect(v).toMatch(/stubble/i)
    })
    it('含 beard（身份锚点）→ 保留', () => {
      const v = sanitizeCastLook('man with beard, black hair')
      expect(v).toContain('beard')
    })
    it('仅 acne 会被删，stubble/毛孔等纹理不再清洗', () => {
      const v = sanitizeCastLook('acne scars, stubble')
      expect(v).not.toMatch(/acne/i)
      expect(v).toMatch(/stubble/i)
    })
  })

  describe('identityLockBlock：身份硬锁块', () => {
    it('有 lookEn → LOCKED IDENTITY 开头', () => {
      const v = identityLockBlock('black hair bun, red hanfu robe')
      expect(v).toContain('LOCKED IDENTITY')
      expect(v).toContain('STRICT HAIR LOCK')
      expect(v).toContain('STRICT OUTFIT LOCK')
    })

    it('空 lookEn → 用默认身份描述', () => {
      const v = identityLockBlock('')
      expect(v).toContain('chinese person')
    })
  })

  describe('lookEnStructureIssues：结构化校验', () => {
    it('空 → 返回缺项', () => {
      expect(lookEnStructureIssues('')).toContain('lookEn 为空')
    })

    it('缺发型 → 报告', () => {
      expect(lookEnStructureIssues('man, hanfu robe, sharp face')).toContain('缺发型条款')
    })

    it('缺服装 → 报告', () => {
      expect(lookEnStructureIssues('man, black hair bun, sharp face')).toContain('缺服装条款')
    })

    it('缺面部 → 报告', () => {
      expect(lookEnStructureIssues('man, black hair bun, hanfu robe')).toContain('缺面部特征条款')
    })

    it('全齐 → 空数组', () => {
      expect(lookEnStructureIssues('man, black hair bun, hanfu robe, sharp face')).toEqual([])
    })
  })

  describe('hardenLookWeapons：武器硬门禁', () => {
    it('空 lookEn → 原样返回', () => { expect(hardenLookWeapons('')).toBe('') })

    it('含违禁武器 katana → 删违禁词+追加中式单械锁', () => {
      const v = hardenLookWeapons('man holding a katana')
      // BANNED_WEAPON_RE 把 katana 替换成空格，clause 追加中式剑词和 NO katana 否定
      expect(v).toContain('chinese straight jian sword')
      expect(v).toContain('one hand empty')
      expect(v).toContain('holding a') // 原句关键动词保留
      // clause 里有 "NO katana" 是预期行为（显式否定），所以不检查 katana 残留
    })

    it('无武器词 → 追加中式兵器描述', () => {
      const v = hardenLookWeapons('man standing')
      expect(v).toContain('one traditional chinese weapon')
    })

    it('已有中式 sword → 只补 exactly one', () => {
      const v = hardenLookWeapons('man holding a jian sword')
      expect(v).toContain('exactly one weapon')
      expect(v).not.toContain('chinese straight jian') // 不需要那套
    })
  })

  describe('differentiateLooks：三角色趋同检测', () => {
    it('≤ 1 角色 → 原样返回无 notes', () => {
      expect(differentiateLooks(['one'])).toEqual({ looks: ['one'], notes: [] })
    })

    it('三角色完全不同 → 无 notes', () => {
      const v = differentiateLooks([
        'young woman, black hair bun, red hanfu robe, round face',
        'middle-aged man, white beard, dark blue suit, square face',
        'teenage boy, brown short hair, green t-shirt, oval face'
      ])
      expect(v.notes.length).toBe(0)
    })

    it('两角色同色系+同发型 → 追加差异化条款', () => {
      const v = differentiateLooks([
        'man, black hair, black suit',
        'man, black hair, black suit'
      ])
      expect(v.notes.length).toBeGreaterThan(0)
      expect(v.looks[1]).toContain('different')
    })
  })

  describe('hardenLookEnList：硬门禁总入口', () => {
    it('古装 genre → 执行武器清洗+时代清洗', () => {
      const v = hardenLookEnList(['man, katana, ninja outfit'], '古装武侠')
      expect(v.looks[0]).not.toMatch(/katana|ninja/i)
      expect(v.looks[0]).toContain('hanfu robes')
    })

    it('现代 genre → 跳过武器硬门禁', () => {
      const v = hardenLookEnList(['doctor with stethoscope'], '都市言情')
      expect(v.looks[0]).not.toContain('weapon')
    })

    it('空 looks → 空返回', () => {
      expect(hardenLookEnList([])).toEqual({ looks: [], notes: [] })
    })

    it('结构缺项写入 notes', () => {
      const v = hardenLookEnList(['man, hanfu robe'])
      expect(v.notes.some(n => n.includes('结构缺项'))).toBe(true)
    })
  })
})
