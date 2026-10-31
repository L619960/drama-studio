import { describe, it, expect } from 'vitest'
import { TTS_VOICES, DEFAULT_TTS_VOICE, ttsVoiceName } from '../../src/shared/ttsVoices'

describe('TTS 音色共享清单（REQ-12 RA-12）', () => {
  it('清单含 5 个音色（含云杰），三处下拉共用同一份', () => {
    expect(TTS_VOICES).toHaveLength(5)
    expect(TTS_VOICES.map(v => v.value)).toContain('zh-CN-YunjieNeural')
  })

  it('默认音色在清单内', () => {
    expect(TTS_VOICES.some(v => v.value === DEFAULT_TTS_VOICE)).toBe(true)
  })

  it('ttsVoiceName 返回中文短名，未知音色原样返回', () => {
    expect(ttsVoiceName('zh-CN-YunjieNeural')).toBe('云杰')
    expect(ttsVoiceName('custom-voice')).toBe('custom-voice')
    expect(ttsVoiceName(undefined)).toBe('')
  })
})
