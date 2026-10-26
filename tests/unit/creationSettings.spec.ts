import { describe, it, expect } from 'vitest'
import { resolveCreation, DEFAULT_CREATION, DEFAULT_EDIT } from '../../src/shared/creationSettings'
import type { AppSettings } from '../../src/shared/ipcTypes'

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
