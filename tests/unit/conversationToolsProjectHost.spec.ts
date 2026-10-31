/**
 * conversationToolsProject 中依赖 host 的 async 工具函数单测：
 * 用最小 mock host（projects.list/get/save、settings.get、lastProjectId）触发全部分支。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  tListProjects,
  tOpenProject,
  tListCharacters,
  tUpdateCharacter,
  tUpdateShot,
  tAddShot,
  tDeleteShot,
  tMoveShot,
} from '../../src/main/core/conversationToolsProject'
import type { ConversationToolsHost } from '../../src/main/core/conversationTools'
import type { Character, Project, Shot } from '../../src/shared/ipcTypes'

function mkShot(index: number, over: Partial<Shot> = {}): Shot {
  return {
    id: `s${index}`,
    index,
    scene: `scene${index}`,
    action: 'act',
    dialogue: '',
    characterIds: [],
    type: 'i2v',
    width: 720,
    height: 480,
    frames: 81,
    seed: 1,
    status: 'pending',
    ...over,
  }
}

function mkChar(name: string, over: Partial<Character> = {}): Character {
  return {
    id: `c_${name}`,
    name,
    refImagePath: '',
    description: 'desc',
    voice: 'zh-CN-XiaoxiaoNeural',
    ...over,
  }
}

function mkProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    title: '测试项目',
    genre: '悬疑',
    episode: 1,
    status: 'draft',
    characters: [],
    shots: [],
    fps: 24,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

function mkHost(projects: Project[]) {
  const save = vi.fn(async (_p: Project) => {})
  const host = {
    projects: {
      list: vi.fn(async () => projects),
      get: vi.fn(async (pid: string) => projects.find((p) => p.id === pid) ?? projects[0]),
      save,
    },
    settings: {
      get: vi.fn(async () => ({
        render: { defaultWidth: 720, defaultHeight: 480, defaultFrames: 81 },
      })),
    },
    lastProjectId: undefined as string | undefined,
  } as unknown as ConversationToolsHost
  return { host, save }
}

describe('tListProjects', () => {
  it('空列表返回 empty 提示', async () => {
    const { host } = mkHost([])
    const r = await tListProjects(host)
    expect(r.ok).toBe(true)
    expect(JSON.parse(r.text)).toEqual({ empty: true, message: '还没有任何项目' })
  })

  it('有项目时输出摘要与 done 镜头统计', async () => {
    const p = mkProject({
      id: 'p9',
      title: '雨夜天台',
      shots: [mkShot(1, { status: 'done' }), mkShot(2, { status: 'pending' }), mkShot(3, { status: 'done' })],
      updatedAt: 1700000000000,
    })
    const { host } = mkHost([p])
    const r = await tListProjects(host)
    const arr = JSON.parse(r.text)
    expect(arr).toHaveLength(1)
    expect(arr[0]).toEqual({
      id: 'p9',
      title: '雨夜天台',
      genre: '悬疑',
      status: 'draft',
      shots: 3,
      doneShots: 2,
      updatedAt: new Date(1700000000000).toLocaleString('zh-CN'),
    })
  })
})

describe('tOpenProject', () => {
  const a = mkProject({ id: 'pa', title: '我的项目' })
  const b = mkProject({ id: 'pb', title: '雨夜天台' })

  it('缺 title（未提供）', async () => {
    const { host } = mkHost([a, b])
    const r = await tOpenProject(host, {})
    expect(r).toEqual({ ok: false, text: '缺少 title' })
  })

  it('缺 title（纯空白）', async () => {
    const { host } = mkHost([a, b])
    const r = await tOpenProject(host, { title: '   ' })
    expect(r.ok).toBe(false)
    expect(r.text).toBe('缺少 title')
  })

  it('精确匹配切换成功并写入 lastProjectId', async () => {
    const { host } = mkHost([a, b])
    const r = await tOpenProject(host, { title: '雨夜天台' })
    expect(r.ok).toBe(true)
    const j = JSON.parse(r.text)
    expect(j.switched).toBe(true)
    expect(j.projectId).toBe('pb')
    expect(j.shots).toBe(0)
    expect(j.characters).toEqual([])
    expect(host.lastProjectId).toBe('pb')
  })

  it('includes 模糊匹配命中', async () => {
    const { host } = mkHost([a, b])
    const r = await tOpenProject(host, { title: '我的' })
    expect(r.ok).toBe(true)
    expect(JSON.parse(r.text).projectId).toBe('pa')
    expect(host.lastProjectId).toBe('pa')
  })

  it('找不到项目', async () => {
    const { host } = mkHost([a, b])
    const r = await tOpenProject(host, { title: '不存在' })
    expect(r.ok).toBe(false)
    expect(r.text).toContain('找不到项目「不存在」')
  })
})

describe('tListCharacters', () => {
  it('无 pid 提示未打开项目', async () => {
    const { host } = mkHost([])
    const r = await tListCharacters(host, undefined)
    expect(r).toEqual({ ok: false, text: '当前没有打开的项目' })
  })

  it('空角色返回 empty 提示', async () => {
    const { host } = mkHost([mkProject()])
    const r = await tListCharacters(host, 'p1')
    expect(JSON.parse(r.text)).toEqual({ empty: true, message: '项目还没有角色，可开拍自动建档' })
  })

  it('有角色：voiceRate/appearanceLock 默认值与 hasPortrait 各字段组合', async () => {
    const p = mkProject({
      characters: [
        mkChar('甲', { faceImagePath: 'f.png', voiceRate: '150', appearanceLock: 'lock', voice: 'zh-CN-AoedeNeural' }),
        mkChar('乙', { refImagePath: 'r.png' }),
        mkChar('丙', { bodySheetPath: 'b.png' }),
        mkChar('丁'),
      ],
    })
    const { host } = mkHost([p])
    const r = await tListCharacters(host, 'p1')
    const arr = JSON.parse(r.text)
    expect(arr[0]).toEqual({
      name: '甲',
      voice: 'zh-CN-AoedeNeural',
      voiceRate: '150',
      description: 'desc',
      appearanceLock: 'lock',
      hasPortrait: true,
    })
    expect(arr[1].hasPortrait).toBe(true)
    expect(arr[1].voiceRate).toBe(100)
    expect(arr[1].appearanceLock).toBe('')
    expect(arr[2].hasPortrait).toBe(true)
    expect(arr[3].hasPortrait).toBe(false)
  })
})

describe('tUpdateCharacter', () => {
  function hostWithChar() {
    const p = mkProject({ characters: [mkChar('甲'), mkChar('乙')] })
    const { host, save } = mkHost([p])
    const char = p.characters[0]
    if (!char) throw new Error('测试夹具缺少 p.characters[0]')
    return { host, save, p, char }
  }

  it('无 pid', async () => {
    const { host } = mkHost([])
    const r = await tUpdateCharacter(host, undefined, { character_name: '甲' })
    expect(r).toEqual({ ok: false, text: '当前没有打开的项目' })
  })

  it('缺 character_name', async () => {
    const { host } = mkHost([mkProject()])
    const r = await tUpdateCharacter(host, 'p1', {})
    expect(r).toEqual({ ok: false, text: '缺少 character_name' })
  })

  it('角色不存在', async () => {
    const { host } = hostWithChar()
    const r = await tUpdateCharacter(host, 'p1', { character_name: '丙' })
    expect(r.text).toBe('角色不存在：丙（现有：甲、乙）')
  })

  it('voice 正则不合法且无其他字段 → 无有效修改', async () => {
    const { host, save } = hostWithChar()
    const r = await tUpdateCharacter(host, 'p1', { character_name: '甲', voice: 'zh-CN-Neural' })
    expect(r).toEqual({ ok: false, text: '没有提供任何有效修改字段' })
    expect(save).not.toHaveBeenCalled()
  })

  it('name 空白 / description 非字符串 / voice_rate 越界 → 无有效修改', async () => {
    const { host, save } = hostWithChar()
    const r = await tUpdateCharacter(host, 'p1', {
      character_name: '甲',
      name: '   ',
      description: 42,
      voice_rate: 40,
    })
    expect(r.ok).toBe(false)
    expect(save).not.toHaveBeenCalled()
  })

  it('全字段合法更新：改名/简介/音色/语速取整并保存', async () => {
    const { host, save, char } = hostWithChar()
    const r = await tUpdateCharacter(host, 'p1', {
      character_name: '甲',
      name: ' 新甲 ',
      description: ' 新简介 ',
      voice: 'zh-CN-XiaoxiaoNeural',
      voice_rate: 120.6,
    })
    expect(r.ok).toBe(true)
    expect(r.text).toBe('角色「甲」已更新：姓名 甲 → 新甲；简介已更新；音色 → zh-CN-XiaoxiaoNeural；语速 → 121%')
    expect(char.name).toBe('新甲')
    expect(char.description).toBe('新简介')
    expect(char.voice).toBe('zh-CN-XiaoxiaoNeural')
    expect(char.voiceRate).toBe('121')
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('voice_rate 上越界不生效，仅简介更新', async () => {
    const { host, char } = hostWithChar()
    const r = await tUpdateCharacter(host, 'p1', { character_name: '甲', description: 'x', voice_rate: 300 })
    expect(r.text).toBe('角色「甲」已更新：简介已更新')
    expect(char.voiceRate).toBeUndefined()
  })

  it('voice_rate 边界 50 生效', async () => {
    const { host, char } = hostWithChar()
    const r = await tUpdateCharacter(host, 'p1', { character_name: '甲', voice_rate: 50 })
    expect(r.text).toBe('角色「甲」已更新：语速 → 50%')
    expect(char.voiceRate).toBe('50')
  })
})

describe('tUpdateShot', () => {
  it('无 pid', async () => {
    const { host } = mkHost([])
    const r = await tUpdateShot(host, undefined, { shot_index: 1 })
    expect(r).toEqual({ ok: false, text: '当前没有打开的项目' })
  })

  it('缺 shot_index（未提供或为 0）', async () => {
    const { host } = mkHost([mkProject({ shots: [mkShot(1)] })])
    expect(await tUpdateShot(host, 'p1', { scene: 'x' })).toEqual({ ok: false, text: '缺少 shot_index' })
    expect(await tUpdateShot(host, 'p1', { shot_index: 0 })).toEqual({ ok: false, text: '缺少 shot_index' })
  })

  it('镜不存在', async () => {
    const { host } = mkHost([mkProject({ shots: [mkShot(1), mkShot(2)] })])
    const r = await tUpdateShot(host, 'p1', { shot_index: 9, scene: 'x' })
    expect(r.text).toBe('不存在第 9 镜（共 2 镜）')
  })

  it('frames 非法（不满足 16n+1）直接报错且不保存', async () => {
    const { host, save } = mkHost([mkProject({ shots: [mkShot(1)] })])
    const r = await tUpdateShot(host, 'p1', { shot_index: 1, frames: 80 })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/16n\+1/)
    expect(save).not.toHaveBeenCalled()
  })

  it('frames 非法（非整数）报错', async () => {
    const { host } = mkHost([mkProject({ shots: [mkShot(1)] })])
    const r = await tUpdateShot(host, 'p1', { shot_index: 1, frames: 'abc' })
    expect(r.text).toMatch(/必须是 ≥17 的整数/)
  })

  it('全为无效字段（空白/类型不符/枚举外）→ 无有效修改', async () => {
    const { host, save } = mkHost([mkProject({ shots: [mkShot(1, { type: 'i2v' })] })])
    const r = await tUpdateShot(host, 'p1', {
      shot_index: 1,
      scene: '   ',
      type: 'xxx',
      shot_size: 'telephoto',
      camera: '',
    })
    expect(r).toEqual({ ok: false, text: '没有提供任何有效修改字段' })
    expect(save).not.toHaveBeenCalled()
  })

  it('全字段更新：i2v→t2v 清 characterIds、done 状态重置、帧数生效并重算项目状态', async () => {
    const shot = mkShot(1, { type: 'i2v', status: 'done', characterIds: ['c1'], shotSize: 'medium' })
    const p = mkProject({ shots: [shot] })
    const { host, save } = mkHost([p])
    const r = await tUpdateShot(host, 'p1', {
      shot_index: 1,
      scene: ' 天台 ',
      action: ' 奔跑 ',
      dialogue: '',
      type: 't2v',
      shot_size: 'closeup',
      camera: ' push-in ',
      emotion: ' tense ',
      lighting: ' dusk ',
      facing: ' camera ',
      continuity: ' standing ',
      frames: 97,
    })
    expect(r.ok).toBe(true)
    expect(shot.scene).toBe('天台')
    expect(shot.action).toBe('奔跑')
    expect(shot.dialogue).toBe('')
    expect(shot.type).toBe('t2v')
    expect(shot.characterIds).toEqual([])
    expect(shot.shotSize).toBe('closeup')
    expect(shot.camera).toBe('push-in')
    expect(shot.emotion).toBe('tense')
    expect(shot.lighting).toBe('dusk')
    expect(shot.facing).toBe('camera')
    expect(shot.continuity).toBe('standing')
    expect(shot.frames).toBe(97)
    expect(shot.status).toBe('pending')
    expect(shot.intentReset).toBe(true)
    expect(r.text).toContain('类型→t2v')
    expect(r.text).toContain('帧数→97')
    expect(r.text).toContain('状态已重置为待渲染（改动生效需重新渲染该镜）')
    expect(p.status).toBe('draft')
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('type 与当前相同不产生变更；pending 镜不触发状态重置', async () => {
    const shot = mkShot(1, { type: 'i2v' })
    const { host } = mkHost([mkProject({ shots: [shot] })])
    const r = await tUpdateShot(host, 'p1', { shot_index: 1, scene: 'x', type: 'i2v' })
    expect(r.text).toBe('第 1 镜已更新：场景')
    expect(shot.status).toBe('pending')
    expect(shot.intentReset).toBeUndefined()
  })

  it('failed 镜改动后重置为 pending', async () => {
    const shot = mkShot(1, { status: 'failed' })
    const { host } = mkHost([mkProject({ shots: [shot] })])
    const r = await tUpdateShot(host, 'p1', { shot_index: 1, action: 'y' })
    expect(shot.status).toBe('pending')
    expect(r.text).toContain('动作提示词')
    expect(r.text).toContain('状态已重置为待渲染')
  })

  it('项目渲染中：状态保持 rendering 且追加提醒文案', async () => {
    const shot = mkShot(1)
    const p = mkProject({ shots: [shot], status: 'rendering' })
    const { host } = mkHost([p])
    const r = await tUpdateShot(host, 'p1', { shot_index: 1, emotion: 'sad' })
    expect(p.status).toBe('rendering')
    expect(r.text).toBe(
      '第 1 镜已更新：情绪。注意：项目正在渲染中，本次修改不影响进行中的渲染任务，完成后请复核并重渲该镜',
    )
  })
})

describe('tAddShot', () => {
  it('无 pid', async () => {
    const { host } = mkHost([])
    const r = await tAddShot(host, undefined, { scene: 's', action: 'a' })
    expect(r).toEqual({ ok: false, text: '当前没有打开的项目' })
  })

  it('scene 或 action 为空报错', async () => {
    const { host, save } = mkHost([mkProject({ shots: [mkShot(1)] })])
    expect(await tAddShot(host, 'p1', { action: 'a' })).toEqual({ ok: false, text: 'scene 与 action 不能为空' })
    expect(await tAddShot(host, 'p1', { scene: 's', action: '   ' })).toEqual({
      ok: false,
      text: 'scene 与 action 不能为空',
    })
    expect(save).not.toHaveBeenCalled()
  })

  it('i2v + closeup：after_index=1 插入中间并全量重编号，settings 默认值生效', async () => {
    const p = mkProject({ shots: [mkShot(1), mkShot(2)] })
    const { host, save } = mkHost([p])
    const r = await tAddShot(host, 'p1', {
      scene: ' 雨夜 ',
      action: ' 对峙 ',
      after_index: 1,
      shot_size: 'closeup',
      dialogue: ' 你好 ',
      camera: ' pan ',
      emotion: 123,
    })
    expect(r.ok).toBe(true)
    const added = p.shots[1]
    if (!added) throw new Error('测试夹具缺少 p.shots[1]')
    expect(added.scene).toBe('雨夜')
    expect(added.action).toBe('对峙')
    expect(added.type).toBe('i2v')
    expect(added.shotSize).toBe('closeup')
    expect(added.dialogue).toBe('你好')
    expect(added.camera).toBe('pan')
    expect(added.emotion).toBeUndefined()
    expect(added.width).toBe(720)
    expect(added.height).toBe(480)
    expect(added.frames).toBe(81)
    expect(added.status).toBe('pending')
    expect(p.shots.map((s) => s.index)).toEqual([1, 2, 3])
    expect(r.text).toContain('已新增第 2 镜「雨夜」（i2v），后续镜头已自动重新编号')
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('i2v 非法 shot_size 回退 medium', async () => {
    const p = mkProject({ shots: [mkShot(1)] })
    const { host } = mkHost([p])
    await tAddShot(host, 'p1', { scene: 's', action: 'a', shot_size: 'telephoto' })
    expect(p.shots[1]?.shotSize).toBe('medium')
  })

  it('t2v：shotSize 为 undefined，after_index 越界回退末尾', async () => {
    const p = mkProject({ shots: [mkShot(1), mkShot(2)] })
    const { host } = mkHost([p])
    const r = await tAddShot(host, 'p1', { scene: 's', action: 'a', type: 't2v', after_index: 99 })
    const added = p.shots[2]
    if (!added) throw new Error('测试夹具缺少 p.shots[2]')
    expect(added.type).toBe('t2v')
    expect(added.shotSize).toBeUndefined()
    expect(added.index).toBe(3)
    expect(r.text).toContain('已新增第 3 镜「s」（t2v）')
  })

  it('after_index=0 同样回退末尾并重算项目状态', async () => {
    const p = mkProject({ shots: [mkShot(1, { status: 'done' })] })
    p.status = 'done'
    const { host } = mkHost([p])
    await tAddShot(host, 'p1', { scene: 's', action: 'a' })
    expect(p.shots[1]?.index).toBe(2)
    expect(p.status).toBe('draft')
  })
})

describe('tDeleteShot', () => {
  it('无 pid', async () => {
    const { host } = mkHost([])
    const r = await tDeleteShot(host, undefined, { shot_index: 1 })
    expect(r).toEqual({ ok: false, text: '当前没有打开的项目' })
  })

  it('缺 shot_index', async () => {
    const { host } = mkHost([mkProject({ shots: [mkShot(1)] })])
    const r = await tDeleteShot(host, 'p1', {})
    expect(r).toEqual({ ok: false, text: '缺少 shot_index' })
  })

  it('镜不存在', async () => {
    const { host } = mkHost([mkProject({ shots: [mkShot(1)] })])
    const r = await tDeleteShot(host, 'p1', { shot_index: 5 })
    expect(r).toEqual({ ok: false, text: '不存在第 5 镜' })
  })

  it('删除成功并重编号剩余镜', async () => {
    const p = mkProject({ shots: [mkShot(1), mkShot(2), mkShot(3)] })
    const { host, save } = mkHost([p])
    const r = await tDeleteShot(host, 'p1', { shot_index: 2 })
    expect(r.ok).toBe(true)
    expect(r.text).toBe('已删除第 2 镜「scene2」，共剩 2 镜，镜号已重新编号')
    expect(p.shots.map((s) => s.index)).toEqual([1, 2])
    expect(save).toHaveBeenCalledTimes(1)
  })
})

describe('tMoveShot', () => {
  it('无 pid', async () => {
    const { host } = mkHost([])
    const r = await tMoveShot(host, undefined, { shot_index: 1, to_index: 2 })
    expect(r).toEqual({ ok: false, text: '当前没有打开的项目' })
  })

  it('缺 shot_index 或 to_index', async () => {
    const { host } = mkHost([mkProject({ shots: [mkShot(1)] })])
    expect(await tMoveShot(host, 'p1', { to_index: 2 })).toEqual({ ok: false, text: '需要 shot_index 与 to_index' })
    expect(await tMoveShot(host, 'p1', { shot_index: 1 })).toEqual({ ok: false, text: '需要 shot_index 与 to_index' })
  })

  it('源镜不存在', async () => {
    const { host } = mkHost([mkProject({ shots: [mkShot(1)] })])
    const r = await tMoveShot(host, 'p1', { shot_index: 9, to_index: 1 })
    expect(r).toEqual({ ok: false, text: '不存在第 9 镜' })
  })

  it('前移成功并重编号', async () => {
    const p = mkProject({ shots: [mkShot(1), mkShot(2), mkShot(3)] })
    const { host, save } = mkHost([p])
    const r = await tMoveShot(host, 'p1', { shot_index: 3, to_index: 1 })
    expect(r.text).toBe('「scene3」已移到第 1 镜位置，镜号已重新编号')
    expect(p.shots.map((s) => s.id)).toEqual(['s3', 's1', 's2'])
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('to_index 越界钳制到末尾', async () => {
    const p = mkProject({ shots: [mkShot(1), mkShot(2), mkShot(3)] })
    const { host } = mkHost([p])
    const r = await tMoveShot(host, 'p1', { shot_index: 1, to_index: 99 })
    expect(p.shots.map((s) => s.id)).toEqual(['s2', 's3', 's1'])
    expect(r.text).toContain('已移到第 3 镜位置')
  })
})
