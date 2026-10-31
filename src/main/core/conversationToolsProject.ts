/**
 * 对话工具·项目/角色/分镜编辑域：项目列表与切换、角色查看/修改、分镜增删改调序与状态重算。
 * 从 conversationTools.ts 按域拆分外移，行为不变。
 */
import type { ConversationToolsHost, ToolResult } from './conversationTools'
import type { Project, Shot } from '../../shared/ipcTypes'
import { RESULT_LIMIT } from './conversationConstants'

export async function tListProjects(host: ConversationToolsHost): Promise<ToolResult> {
  const list = await host.projects.list()
  if (!list.length) return { ok: true, text: JSON.stringify({ empty: true, message: '还没有任何项目' }) }
  return {
    ok: true,
    text: JSON.stringify(
      list.slice(0, 30).map((p) => ({
        id: p.id,
        title: p.title,
        genre: p.genre,
        status: p.status,
        shots: p.shots.length,
        doneShots: p.shots.filter((s) => s.status === 'done').length,
        updatedAt: new Date(p.updatedAt).toLocaleString('zh-CN'),
      })),
    ),
  }
}

export async function tOpenProject(host: ConversationToolsHost, args: Record<string, unknown>): Promise<ToolResult> {
  const title = String(args.title || '').trim()
  if (!title) return { ok: false, text: '缺少 title' }
  const list = await host.projects.list()
  const p = list.find((x) => x.title === title) || list.find((x) => x.title.includes(title))
  if (!p) return { ok: false, text: `找不到项目「${title}」，可用 list_projects 查看全部` }
  host.lastProjectId = p.id
  return {
    ok: true,
    text: JSON.stringify({
      switched: true,
      projectId: p.id,
      title: p.title,
      genre: p.genre,
      shots: p.shots.length,
      characters: p.characters.map((c) => c.name),
      message: '导演上下文已切换到该项目，后续分镜/角色/渲染操作都作用于它',
    }),
  }
}

// ===== 角色 / 分镜编辑 =====

export async function tListCharacters(host: ConversationToolsHost, pid: string | undefined): Promise<ToolResult> {
  if (!pid) return { ok: false, text: '当前没有打开的项目' }
  const p = await host.projects.get(pid)
  if (!p.characters.length)
    return { ok: true, text: JSON.stringify({ empty: true, message: '项目还没有角色，可开拍自动建档' }) }
  return {
    ok: true,
    text: JSON.stringify(
      p.characters.map((c) => ({
        name: c.name,
        voice: c.voice,
        voiceRate: c.voiceRate || 100,
        description: c.description,
        appearanceLock: c.appearanceLock || '',
        hasPortrait: Boolean(c.faceImagePath || c.refImagePath || c.bodySheetPath),
      })),
      null,
      0,
    ).slice(0, RESULT_LIMIT),
  }
}

export async function tUpdateCharacter(
  host: ConversationToolsHost,
  pid: string | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (!pid) return { ok: false, text: '当前没有打开的项目' }
  const name = String(args.character_name || '').trim()
  if (!name) return { ok: false, text: '缺少 character_name' }
  const p = await host.projects.get(pid)
  const char = p.characters.find((c) => c.name === name)
  if (!char) return { ok: false, text: `角色不存在：${name}（现有：${p.characters.map((c) => c.name).join('、')}）` }
  const changes: string[] = []
  if (typeof args.name === 'string' && args.name.trim()) {
    changes.push(`姓名 ${char.name} → ${args.name.trim()}`)
    char.name = args.name.trim()
  }
  if (typeof args.description === 'string' && args.description.trim()) {
    char.description = args.description.trim()
    changes.push('简介已更新')
  }
  if (typeof args.voice === 'string' && /^zh-CN-[A-Za-z]+Neural$/.test(args.voice)) {
    char.voice = args.voice
    changes.push(`音色 → ${args.voice}`)
  }
  if (typeof args.voice_rate === 'number' && args.voice_rate >= 50 && args.voice_rate <= 200) {
    char.voiceRate = String(Math.round(args.voice_rate))
    changes.push(`语速 → ${Math.round(args.voice_rate)}%`)
  }
  if (!changes.length) return { ok: false, text: '没有提供任何有效修改字段' }
  await host.projects.save(p)
  return { ok: true, text: `角色「${name}」已更新：${changes.join('；')}` }
}

/** 重排分镜 index：删/增/移动后统一按数组位置重编号 */
export function renumberShots(shots: Shot[]): void {
  shots.forEach((s, i) => {
    s.index = i + 1
  })
}

export function validateFrames(frames: number): string | null {
  if (!Number.isInteger(frames) || frames < 17) return 'frames 必须是 ≥17 的整数'
  if ((frames - 1) % 16 !== 0) return 'frames 必须满足 16n+1（如 81/97/113/129），保证 Wan 引擎帧数约束'
  return null
}

/** 镜头被 agent 改动后同步重算项目状态（渲染中除外，由 TaskQueue 收尾统一重算） */
export function recalcProjectStatus(p: Project): void {
  if (p.status === 'rendering') return
  const anyFailed = p.shots.some((s) => s.status === 'failed')
  const allDone = p.shots.length > 0 && p.shots.every((s) => s.status === 'done')
  p.status = allDone ? 'done' : anyFailed ? 'failed' : 'draft'
}

export async function tUpdateShot(
  host: ConversationToolsHost,
  pid: string | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (!pid) return { ok: false, text: '当前没有打开的项目' }
  const idx = Number(args.shot_index || 0)
  if (!idx) return { ok: false, text: '缺少 shot_index' }
  const p = await host.projects.get(pid)
  const shot = p.shots.find((s) => s.index === idx)
  if (!shot) return { ok: false, text: `不存在第 ${idx} 镜（共 ${p.shots.length} 镜）` }
  const changes: string[] = []
  if (typeof args.scene === 'string' && args.scene.trim()) {
    shot.scene = args.scene.trim()
    changes.push('场景')
  }
  if (typeof args.action === 'string' && args.action.trim()) {
    shot.action = args.action.trim()
    changes.push('动作提示词')
  }
  if (typeof args.dialogue === 'string') {
    shot.dialogue = args.dialogue.trim()
    changes.push('台词')
  }
  if (args.type === 'i2v' || args.type === 't2v') {
    if (args.type !== shot.type) {
      shot.type = args.type
      if (args.type === 't2v') shot.characterIds = []
      changes.push(`类型→${args.type}`)
    }
  }
  if (args.shot_size === 'closeup' || args.shot_size === 'medium' || args.shot_size === 'wide') {
    shot.shotSize = args.shot_size
    changes.push(`景别→${args.shot_size}`)
  }
  if (typeof args.camera === 'string' && args.camera.trim()) {
    shot.camera = args.camera.trim()
    changes.push('运镜')
  }
  if (typeof args.emotion === 'string' && args.emotion.trim()) {
    shot.emotion = args.emotion.trim()
    changes.push('情绪')
  }
  if (typeof args.lighting === 'string' && args.lighting.trim()) {
    shot.lighting = args.lighting.trim()
    changes.push('光线')
  }
  if (typeof args.facing === 'string' && args.facing.trim()) {
    shot.facing = args.facing.trim()
    changes.push('朝向站位')
  }
  if (typeof args.continuity === 'string' && args.continuity.trim()) {
    shot.continuity = args.continuity.trim()
    changes.push('动作衔接')
  }
  if (args.frames !== undefined) {
    const frames = Number(args.frames)
    const err = validateFrames(frames)
    if (err) return { ok: false, text: err }
    shot.frames = frames
    changes.push(`帧数→${frames}`)
  }
  if (!changes.length) return { ok: false, text: '没有提供任何有效修改字段' }
  // 字段变更后旧渲染产物不再可信：回退为待渲染
  if (shot.status === 'done' || shot.status === 'failed') {
    shot.status = 'pending'
    shot.intentReset = true
    changes.push('状态已重置为待渲染（改动生效需重新渲染该镜）')
  }
  recalcProjectStatus(p)
  await host.projects.save(p)
  // 渲染中修改字段要显式提醒（M-18）：本次改动不会反映到进行中的渲染，
  // 静默生效会让 agent 误以为镜头产物已包含新内容
  const renderingNote =
    p.status === 'rendering' ? '。注意：项目正在渲染中，本次修改不影响进行中的渲染任务，完成后请复核并重渲该镜' : ''
  return { ok: true, text: `第 ${idx} 镜已更新：${changes.join('；')}${renderingNote}` }
}

export async function tAddShot(
  host: ConversationToolsHost,
  pid: string | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (!pid) return { ok: false, text: '当前没有打开的项目' }
  const scene = String(args.scene || '').trim()
  const action = String(args.action || '').trim()
  const type = args.type === 't2v' ? 't2v' : 'i2v'
  if (!scene || !action) return { ok: false, text: 'scene 与 action 不能为空' }
  const s = await host.settings.get()
  const shot: Shot = {
    id: `shot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    index: 0,
    scene,
    action,
    dialogue: String(args.dialogue || '').trim(),
    characterIds: [],
    type,
    width: s.render.defaultWidth,
    height: s.render.defaultHeight,
    frames: s.render.defaultFrames,
    seed: Math.floor(Math.random() * 0xffffffff),
    ...(type === 'i2v'
      ? { shotSize: args.shot_size === 'closeup' || args.shot_size === 'wide' ? args.shot_size : 'medium' }
      : {}),
    ...(typeof args.camera === 'string' && args.camera.trim() ? { camera: args.camera.trim() } : {}),
    ...(typeof args.emotion === 'string' && args.emotion.trim() ? { emotion: args.emotion.trim() } : {}),
    status: 'pending',
  }
  const p = await host.projects.get(pid)
  const after = Number(args.after_index || 0)
  const pos = after >= 1 && after <= p.shots.length ? after : p.shots.length
  p.shots.splice(pos, 0, shot)
  renumberShots(p.shots)
  recalcProjectStatus(p)
  await host.projects.save(p)
  return { ok: true, text: `已新增第 ${shot.index} 镜「${scene}」（${type}），后续镜头已自动重新编号` }
}

export async function tDeleteShot(
  host: ConversationToolsHost,
  pid: string | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (!pid) return { ok: false, text: '当前没有打开的项目' }
  const idx = Number(args.shot_index || 0)
  if (!idx) return { ok: false, text: '缺少 shot_index' }
  const p = await host.projects.get(pid)
  const i = p.shots.findIndex((s) => s.index === idx)
  if (i < 0) return { ok: false, text: `不存在第 ${idx} 镜` }
  const removed = p.shots[i]
  if (!removed) return { ok: false, text: `不存在第 ${idx} 镜` }
  p.shots.splice(i, 1)
  renumberShots(p.shots)
  recalcProjectStatus(p)
  await host.projects.save(p)
  return { ok: true, text: `已删除第 ${idx} 镜「${removed.scene}」，共剩 ${p.shots.length} 镜，镜号已重新编号` }
}

export async function tMoveShot(
  host: ConversationToolsHost,
  pid: string | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (!pid) return { ok: false, text: '当前没有打开的项目' }
  const from = Number(args.shot_index || 0)
  const to = Number(args.to_index || 0)
  if (!from || !to) return { ok: false, text: '需要 shot_index 与 to_index' }
  const p = await host.projects.get(pid)
  const i = p.shots.findIndex((s) => s.index === from)
  if (i < 0) return { ok: false, text: `不存在第 ${from} 镜` }
  const shot = p.shots[i]
  if (!shot) return { ok: false, text: `不存在第 ${from} 镜` }
  p.shots.splice(i, 1)
  p.shots.splice(Math.max(0, Math.min(p.shots.length, to - 1)), 0, shot)
  renumberShots(p.shots)
  recalcProjectStatus(p)
  await host.projects.save(p)
  return { ok: true, text: `「${shot.scene}」已移到第 ${shot.index} 镜位置，镜号已重新编号` }
}
