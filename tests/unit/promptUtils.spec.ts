import { describe, it, expect } from 'vitest'
import { joinParts, mergeNegative } from '../../src/shared/promptUtils'

describe('promptUtils · 提示词拼装共享原子（joinParts / mergeNegative）', () => {
  describe('joinParts：段落拼接，过滤 falsy + trim + 逗号连接', () => {
    it('正常字符串用逗号+空格连接', () => {
      expect(joinParts('a', 'b', 'c')).toBe('a, b, c')
    })

    it('undefined / null / false / 空字符串 → 全部过滤', () => {
      expect(joinParts('a', undefined, null, false, '', 'b')).toBe('a, b')
    })

    it('全 falsy → 空字符串', () => {
      expect(joinParts(undefined, null, false, '', undefined)).toBe('')
    })

    it('带空格的字符串自动 trim', () => {
      expect(joinParts('  hello  ', '  world  ')).toBe('hello, world')
    })

    it('只有空白字符 → 过滤', () => {
      expect(joinParts('   ', '\t\n', 'ok')).toBe('ok')
    })

    it('单参数原样返回（trim 后）', () => {
      expect(joinParts('  just one  ')).toBe('just one')
    })

    it('无参数 → 空串', () => {
      expect(joinParts()).toBe('')
    })
  })

  describe('mergeNegative：合并多段负向提示词，按逗号/分号拆分、trim、按小写去重', () => {
    it('基础去重：同词只保留首次出现', () => {
      expect(mergeNegative('blurry, low quality', 'blurry, bad anatomy')).toBe(
        'blurry, low quality, bad anatomy'
      )
    })

    it('大小写不敏感去重：Blurry 与 blurry 视为同词', () => {
      expect(mergeNegative('Blurry', 'blurry', 'BLURRY')).toBe('Blurry')
    })

    it('分号分隔同样支持', () => {
      expect(mergeNegative('a; b; c')).toBe('a, b, c')
    })

    it('混合逗号+分号', () => {
      expect(mergeNegative('a, b; c,d')).toBe('a, b, c, d')
    })

    it('trim 每一项并合并多空白为单空格', () => {
      expect(mergeNegative('  bad   anatomy ,  low    quality  ')).toBe(
        'bad anatomy, low quality'
      )
    })

    it('过滤 falsy 参数（undefined / null / false / 空串）', () => {
      expect(mergeNegative('a', undefined, null, false, '', 'b')).toBe('a, b')
    })

    it('全 falsy → 空串', () => {
      expect(mergeNegative(undefined, null, '', false)).toBe('')
    })

    // ★ 关键：覆盖 line 18 `if (!term) continue` —— split 产生空字符串
    it('连续逗号产生空 token → 跳过（覆盖未覆盖的 line 18）', () => {
      expect(mergeNegative(',,a,,')).toBe('a')
    })

    it('开头逗号 → 跳过首个空 token', () => {
      expect(mergeNegative(',hello,world')).toBe('hello, world')
    })

    it('结尾逗号 → 跳过末尾空 token', () => {
      expect(mergeNegative('hello,world,')).toBe('hello, world')
    })

    it('只有逗号 → 全跳过返回空串', () => {
      expect(mergeNegative(',,,', '; ; ;')).toBe('')
    })

    it('内部含只有空白的 token → trim 后为空 → 跳过', () => {
      expect(mergeNegative('a,   ,b')).toBe('a, b')
    })

    it('分号版连续分隔符同样跳过空 token', () => {
      expect(mergeNegative('a;;b;;;c')).toBe('a, b, c')
    })

    it('多参数间去重保持首次出现顺序', () => {
      expect(mergeNegative('c, b, a', 'a, b, c')).toBe('c, b, a')
    })
  })
})
