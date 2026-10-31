import { describe, it, expect } from 'vitest'
import { findDuplicateByName, findDuplicateSceneBoard, normalizeAssetName } from '../../src/shared/assetNames'

describe('资产重名校验（REQ-13 RA-14）', () => {
  it('normalizeAssetName 忽略首尾空白、连续空格与大小写', () => {
    expect(normalizeAssetName('  客厅 ')).toBe('客厅')
    expect(normalizeAssetName('Paper   Bag')).toBe('paper bag')
    expect(normalizeAssetName(undefined)).toBe('')
  })

  it('角色/道具同名判定命中，编辑自身时排除', () => {
    const list = [
      { id: 'a', name: '小雨' },
      { id: 'b', name: 'Player One' }
    ]
    expect(findDuplicateByName(list, '小雨')?.id).toBe('a')
    expect(findDuplicateByName(list, ' player  one ')?.id).toBe('b')
    expect(findDuplicateByName(list, '小雨', 'a')).toBeUndefined()
    expect(findDuplicateByName(list, '  ')).toBeUndefined()
  })

  it('场景板按 normalizeSceneKey 判定同名（大小写/空格归一）', () => {
    const boards = [
      { id: 'b1', name: '便利店 雨夜' },
      { id: 'b2', name: '客厅' }
    ]
    expect(findDuplicateSceneBoard(boards, ' 客厅 ')?.id).toBe('b2')
    // normalizeSceneKey 只折叠空白、不吞掉空格：'便利店   雨夜' 归一为 '便利店 雨夜'
    expect(findDuplicateSceneBoard(boards, '便利店   雨夜')?.id).toBe('b1')
    expect(findDuplicateSceneBoard(boards, '便利店 雨夜', 'b1')).toBeUndefined()
    expect(findDuplicateSceneBoard(boards, '便利店雨夜')).toBeUndefined()
    expect(findDuplicateSceneBoard(boards, '卧室')).toBeUndefined()
  })
})
