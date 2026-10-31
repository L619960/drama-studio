/**
 * TTS 音色清单（单一事实源）。
 * 设置页默认音色、角色编辑音色、分镜级音色三处下拉共用，避免清单漂移。
 */
export interface TtsVoiceOption {
  value: string
  /** 下拉展示文案（含性别） */
  label: string
  /** 中文短名（角色卡/试听标题用） */
  name: string
}

export const TTS_VOICES: readonly TtsVoiceOption[] = [
  { value: 'zh-CN-XiaoxiaoNeural', label: '小晓 (女声)', name: '小晓' },
  { value: 'zh-CN-XiaoyiNeural', label: '小艺 (女声)', name: '小艺' },
  { value: 'zh-CN-YunjianNeural', label: '云健 (男声)', name: '云健' },
  { value: 'zh-CN-YunyeNeural', label: '云野 (男声)', name: '云野' },
  { value: 'zh-CN-YunjieNeural', label: '云杰 (男声)', name: '云杰' }
]

/** 默认音色（首播） */
export const DEFAULT_TTS_VOICE = TTS_VOICES[0].value

/** 按音色标识取中文短名，未知音色原样返回 */
export function ttsVoiceName(value: string | undefined): string {
  if (!value) return ''
  return TTS_VOICES.find(v => v.value === value)?.name ?? value
}
