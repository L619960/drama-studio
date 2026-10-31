/**
 * pinyin 适配单一来源（P2-1）：pinyin v3 既可能是命名空间 `{ pinyin }`，也可能是函数默认导出，
 * 这里做一次形态归一，避免每个调用方各写一份 as unknown as 断言。
 */

import pinyinMod from 'pinyin'

export const pinyinFn = ((pinyinMod as unknown as { pinyin?: (name: string, opts?: unknown) => string[][] }).pinyin ||
  (pinyinMod as unknown as (name: string, opts?: unknown) => string[][])) as (
  name: string,
  opts?: unknown,
) => string[][]
