import { normalizeSceneKey } from './ipcTypes'

/**
 * 资产名称去重键：去首尾空白、折叠内部空格、忽略大小写。
 * 与场景板 normalizeSceneKey 同一口径，避免「客厅 」「客厅」「Living
 * Room」这类肉眼同名的可编辑资产共存。
 */
export function normalizeAssetName(name: string | undefined): string {
  return (name || '').trim().replace(/\s+/g, ' ').toLowerCase()
}

export interface NamedAsset {
  id: string
  name: string
}

/** 查找与候选名重名的资产；excludeId 用于编辑时排除自身 */
export function findDuplicateByName<T extends NamedAsset>(
  list: readonly T[],
  candidate: string,
  excludeId?: string
): T | undefined {
  const key = normalizeAssetName(candidate)
  if (!key) return undefined
  return list.find(item => item.id !== excludeId && normalizeAssetName(item.name) === key)
}

/** 场景板重名判定：必须与分镜绑定旧板用的 normalizeSceneKey 保持一致 */
export function findDuplicateSceneBoard<T extends NamedAsset>(
  boards: readonly T[],
  candidate: string,
  excludeId?: string
): T | undefined {
  const key = normalizeSceneKey(candidate)
  if (!key) return undefined
  return boards.find(b => b.id !== excludeId && normalizeSceneKey(b.name) === key)
}
