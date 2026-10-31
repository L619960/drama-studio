import { describe, it, expect } from 'vitest'
import {
  resolveCreation, DEFAULT_CREATION, DEFAULT_EDIT, mirrorEditToRender, mirrorRenderToEdit
} from '../../src/shared/creationSettings'
import type { AppSettings } from '../../src/shared/ipcTypes'

/** 构造一份结构完整的最小设置（镜像函数需要 creation.edit / render / tts 三块都在） */
function baseSettings(): AppSettings {
  return {
    creation: structuredClone(DEFAULT_CREATION),
    render: {
      defaultWidth: 720,
      defaultHeight: 480,
      defaultFrames: 81,
      timeout: 600,
      lipSync: true,
      lipSyncMode: 'auto',
      oomRetry: true,
      consistencyMode: 'warn',
      resolutionTier: 'auto',
      shotReviewGate: 'block',
      reviewGate: 'block',
      finalReviewGate: 'block',
      assetConcurrency: 2,
      perShotAudit: true,
      turboH3: false
    },
    tts: { defaultVoice: 'zh-CN-XiaoxiaoNeural', rate: 88, volume: 100 }
  } as unknown as AppSettings
}

describe('resolveCreation', () => {
  it('空设置回退全部默认值', () => {
    const c = resolveCreation({} as AppSettings)
    expect(c.edit.defaultFrames).toBe(DEFAULT_EDIT.defaultFrames)
    expect(c.edit.comfyTimeoutSec).toBe(DEFAULT_EDIT.comfyTimeoutSec)
    expect(c.storyboard.minShots).toBe(DEFAULT_CREATION.storyboard.minShots)
    expect(c.character.candidates).toBe(DEFAULT_CREATION.character.candidates)
    expect(c.presets).toEqual([])
  })

  it('旧 render/tts 字段镜像到 creation.edit（settingsStore 归一化依赖此行为）', () => {
    const c = resolveCreation({
      render: { defaultFrames: 65, timeout: 900, lipSync: false, lipSyncMode: 'latentsync' },
      tts: { rate: 60, volume: 50 }
    } as unknown as AppSettings)
    expect(c.edit.defaultFrames).toBe(65)
    expect(c.edit.comfyTimeoutSec).toBe(900)
    expect(c.edit.lipSync).toBe(false)
    expect(c.edit.lipSyncMode).toBe('latentsync')
    expect(c.edit.ttsRate).toBe(60)
    expect(c.edit.ttsVolume).toBe(50)
  })

  it('creation.edit 显式值优先于 render 镜像', () => {
    const c = resolveCreation({
      creation: { edit: { comfyTimeoutSec: 300 } },
      render: { timeout: 900 }
    } as unknown as AppSettings)
    expect(c.edit.comfyTimeoutSec).toBe(300)
  })

  it('presets 非法类型回退空数组', () => {
    const c = resolveCreation({ creation: { presets: 'bad' } } as unknown as AppSettings)
    expect(c.presets).toEqual([])
  })
})

describe('creation.edit ↔ render/tts 双写镜像（REQ-12 RA-01）', () => {
  it('edit 改动同步到 render/tts', () => {
    const s = baseSettings()
    s.creation.edit.defaultWidth = 1080
    s.creation.edit.defaultHeight = 1920
    s.creation.edit.comfyTimeoutSec = 900
    s.creation.edit.ttsRate = 70
    mirrorEditToRender(s)
    expect(s.render.defaultWidth).toBe(1080)
    expect(s.render.defaultHeight).toBe(1920)
    expect(s.render.timeout).toBe(900)
    expect(s.tts.rate).toBe(70)
  })

  it('render/tts 改动同步回 edit（设置「渲染」区修改同样生效）', () => {
    const s = baseSettings()
    s.render.defaultWidth = 1080
    s.render.defaultFrames = 65
    s.render.lipSyncMode = 'latentsync'
    s.tts.volume = 60
    mirrorRenderToEdit(s)
    expect(s.creation.edit.defaultWidth).toBe(1080)
    expect(s.creation.edit.defaultFrames).toBe(65)
    expect(s.creation.edit.lipSyncMode).toBe('latentsync')
    expect(s.creation.edit.ttsVolume).toBe(60)
  })

  it('反方向镜像后再次正方向镜像不会二次改动（同值不再写入）', () => {
    const s = baseSettings()
    s.creation.edit.defaultWidth = 1080
    mirrorEditToRender(s)
    const before = JSON.stringify(s)
    mirrorRenderToEdit(s)
    mirrorEditToRender(s)
    expect(JSON.stringify(s)).toBe(before)
  })
})
