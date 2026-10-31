import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProjectStore } from '../../src/main/core/projectStore'
import type { Project, Shot } from '../../src/shared/ipcTypes'

/** 构造含完整创作字段 + 运行时产物的镜头 */
function richShot(i: number): Shot {
  return {
    id: `shot_src_${i}`,
    index: i + 1,
    scene: '夜巷',
    action: '转身',
    dialogue: '别走',
    characterIds: ['char_src_0'],
    type: 'i2v',
    width: 720,
    height: 480,
    frames: 81,
    seed: 12345,
    workflow: 'wan22_i2v',
    voice: 'zh-CN-XiaoxiaoNeural',
    sceneBoardId: 'scene_src_0',
    shotSize: 'medium',
    sceneEn: 'night alley',
    camera: 'static',
    transition: 'hard',
    emotion: 'sad',
    lighting: 'moody',
    facing: 'camera',
    continuity: 'same position as prev',
    props: ['umbrella'],
    promptEn: 'the same woman from the reference image, turning around slowly, static camera, smooth motion',
    negativeEn: 'no modern vehicles',
    frameSeconds: 4,
    firstFrameEn: 'woman standing, back to camera',
    midFrameEn: 'woman turning head',
    lastFrameEn: 'woman facing camera, tears',
    handoffToNext: 'woman stops at alley corner',
    transitionEn: 'slow push-in from back to front',
    // 运行时/产物字段（副本必须重置）
    sceneImagePath: 'projects/x/scenes/shot_src_1_plate.png',
    firstFramePath: 'projects/x/shots/shot_src_1_first.png',
    lastFramePath: 'projects/x/shots/shot_src_1_last.png',
    audioPath: 'projects/x/audio/shot_src_1.mp3',
    segmentPath: 'projects/x/shots/shot_src_1.mp4',
    reviewed: true,
    consistencyScore: 0.92,
    lowConsistency: true,
    renderProfile: { engine: 'h3-i2v', workflow: 'h3_turbo', seed: 12345, lipSync: 'native', renderedAt: 0 },
    status: 'done',
  } as Shot
}

describe('ProjectStore.duplicate（D-01 回归）', () => {
  let dir: string
  let store: ProjectStore
  let source: Project

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-proj-'))
    store = new ProjectStore(path.join(dir, 'projects'))
    source = await store.create('源项目', '悬疑')
    source.characters = [
      {
        id: 'char_src_0',
        name: '苏晚',
        refImagePath: '',
        faceImagePath: '',
        bodySheetPath: '',
        description: '',
        voice: 'zh-CN-XiaoxiaoNeural',
        voiceRate: '88',
        appearanceLock: '强',
      },
    ]
    source.sceneBoards = [{ id: 'scene_src_0', key: 'S1', name: '夜巷', description: '', emptyPlatePath: '' }]
    source.shots = [richShot(0), richShot(1)]
    await store.save(source)
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('创作/提示词字段全量复制', async () => {
    const dup = await store.duplicate(source.id)
    expect(dup.id).not.toBe(source.id)
    const d0 = dup.shots[0]
    if (!d0) throw new Error('测试夹具缺少 dup.shots[0]')
    expect(d0.promptEn).toBe(source.shots[0]?.promptEn)
    expect(d0.negativeEn).toBe(source.shots[0]?.negativeEn)
    expect(d0.firstFrameEn).toBe(source.shots[0]?.firstFrameEn)
    expect(d0.lastFrameEn).toBe(source.shots[0]?.lastFrameEn)
    expect(d0.transitionEn).toBe(source.shots[0]?.transitionEn)
    expect(d0.frameSeconds).toBe(source.shots[0]?.frameSeconds)
    expect(d0.props).toEqual(['umbrella'])
    expect(d0.workflow).toBe('wan22_i2v')
    expect(d0.voice).toBe(source.shots[0]?.voice)
  })

  it('运行时/产物字段全部重置（无悬空资产、不复活成 done）', async () => {
    const dup = await store.duplicate(source.id)
    const d0 = dup.shots[0]
    if (!d0) throw new Error('测试夹具缺少 dup.shots[0]')
    expect(d0.status).toBe('pending')
    expect(d0.firstFramePath).toBeUndefined()
    expect(d0.lastFramePath).toBeUndefined()
    expect(d0.sceneImagePath).toBeUndefined()
    expect(d0.audioPath).toBeUndefined()
    expect(d0.segmentPath).toBeUndefined()
    expect(d0.reviewed).toBeUndefined()
    expect(d0.renderProfile).toBeUndefined()
    expect(d0.consistencyScore).toBeUndefined()
    expect(d0.lowConsistency).toBeUndefined()
    expect(d0.audioFailed).toBeUndefined()
  })

  it('角色/场景板 ID 重映射到新 ID，镜头引用同步', async () => {
    const dup = await store.duplicate(source.id)
    const c0 = dup.characters[0]
    if (!c0) throw new Error('测试夹具缺少 dup.characters[0]')
    expect(c0.id).not.toBe('char_src_0')
    expect(dup.shots[0]?.characterIds).toContain(c0.id)
    expect(dup.shots[0]?.sceneBoardId).toBe(dup.sceneBoards?.[0]?.id)
  })
})
