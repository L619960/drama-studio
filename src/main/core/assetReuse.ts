/**
 * 资产复用回退（纯函数）：T2I 模型缺失时，导演流水线从资产库项目按"出场顺序"复用
 * 角色定妆/场景板资产。规则：想要 N 个目标（按顺序），从池子里按序取，超出池子钳到最后一个。
 * 池子为空 → 全部回退失败（返回 undefined 数组）。
 */
export function planAssetReuse<T>(wantedCount: number, pool: readonly T[]): Array<T | undefined> {
  if (!pool.length) return new Array(wantedCount).fill(undefined)
  return Array.from({ length: wantedCount }, (_, i) => pool[Math.min(i, pool.length - 1)])
}

/** 单目标取池：返回池中第 order 位（越界钳到最后一位），池空返回 undefined。 */
export function pickFromPool<T>(pool: readonly T[], order: number): T | undefined {
  if (!pool.length) return undefined
  return pool[Math.min(Math.max(0, order), pool.length - 1)]
}

/**
 * 题材一致性判定（回退资产复用前的硬门禁）：
 * 资产库项目题材与本项目不一致（如现代剧回退到古装项目）→ 禁止复用，否则定妆/首帧直接穿帮。
 * 规则：双方 genre 均非空且相等才允许；任一缺失或不等 → false（宁可回退失败走 T2I/报错，不穿帮）。
 */
export function genreCompatible(fromGenre: string | undefined, curGenre: string | undefined): boolean {
  if (!fromGenre || !curGenre) return false
  return fromGenre === curGenre
}
