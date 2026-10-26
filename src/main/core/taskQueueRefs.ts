import * as path from 'node:path'
import { existsSync } from 'node:fs'
import {
  characterPrimaryRef, normalizeSceneKey,
  type Project, type Shot
} from '../../shared/ipcTypes'
import { resolveCreation } from '../../shared/creationSettings'
import type { SettingsStore } from './settingsStore'
import { readImageSize } from './taskQueueShared'

/**
 * 首帧或场景板是竖图时，视频保持竖屏。读不到图时跟首尾帧设置走。
 * @param resolveInBase 相对路径 → 绝对路径（由类内传入，行为不变）
 */
export function referenceIsPortrait(
  shot: Shot,
  project: Project,
  settings: Awaited<ReturnType<SettingsStore['get']>>,
  resolveInBase: (p: string) => string
): boolean {
  const board = (project.sceneBoards || []).find(b => b.id === shot.sceneBoardId)
  const rel = shot.firstFramePath || shot.sceneImagePath || board?.emptyPlatePath
  if (rel) {
    const size = readImageSize(resolveInBase(rel))
    if (size) return size.height >= size.width
  }
  const frame = resolveCreation(settings).scene
  return frame.frameHeight >= frame.frameWidth
}

/**
 * 空镜 → 场景图 / 场景板；
 * 人物镜 → 首帧 > 脸部定妆 > 兼容 ref > 三视图
 */
export function resolveRefImageRel(shot: Shot, project: Project): string {
  if (shot.type === 't2v') {
    if (shot.sceneImagePath) return shot.sceneImagePath
    const board = (project.sceneBoards || []).find(b => b.id === shot.sceneBoardId)
    if (board?.emptyPlatePath) return board.emptyPlatePath
    throw new Error('空镜缺少场景参考图，请绑定场景板或在分镜编辑中上传场景图')
  }
  const character = project.characters.find(c => c.id === shot.characterIds[0])
  // 特写优先本镜首帧（场景融合构图，与视频同机位/同姿态，一致性比对更可信）；
  // 旧项目 closeup 首帧就是定妆图副本，行为不变；无首帧才回退定妆图锁脸。
  if (shot.shotSize === 'closeup' && shot.firstFramePath) {
    return shot.firstFramePath
  }
  if (shot.firstFramePath) return shot.firstFramePath
  if (shot.shotSize === 'closeup' && character?.faceImagePath) {
    return character.faceImagePath
  }
  // 连镜回退：同角色上一镜尾帧 → 本镜起始（对齐可灵/即梦「上镜尾→下镜首」）
  const idx = project.shots.findIndex(s => s.id === shot.id)
  if (idx > 0) {
    const prev = project.shots[idx - 1]
    const cid = shot.characterIds[0]
    if (
      cid &&
      prev.lastFramePath &&
      prev.characterIds[0] === cid
    ) {
      return prev.lastFramePath
    }
  }
  if (!character) throw new Error('该镜头未绑定角色，无法图生视频')
  const primary = characterPrimaryRef(character)
  if (!primary) {
    throw new Error(`角色「${character.name}」缺少定妆图（面部或三视图）`)
  }
  return primary
}

/**
 * r2v 场景双参考的第二张图：场景专属空景（约定命名 scenes/<scene>_empty.png，最高优先）
 * > 场景板全景图 > 场景板空景。找不到时返回 null，渲染回退单参考（首帧人物），场景锁定由 promptEn 场景词承担。
 * 注：旧项目 sceneBoards.emptyPlatePath 可能串图（实测两个场景板都指向同一张老街图），
 * 空景约定文件 > board 字段，避免锁错背景。
 */
export function resolveSceneImageRel(
  shot: Shot,
  project: Project,
  baseDir: string
): string | null {
  if (shot.sceneImagePath) return shot.sceneImagePath
  const board = (project.sceneBoards || []).find(b => b.id === shot.sceneBoardId)
  for (const cand of [shot.scene, board ? normalizeSceneKey(shot.scene) : '']) {
    if (!cand) continue
    const rel = `projects/${project.id}/scenes/${cand}_empty.png`
    if (existsSync(path.join(baseDir, rel))) return rel
  }
  if (board?.panoPath) return board.panoPath
  if (board?.emptyPlatePath) return board.emptyPlatePath
  return null
}
