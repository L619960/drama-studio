/**
 * taskQueueRender 纯函数单测：renderShot 中抽出的引擎选择/时长换算/降档/回退/抽卡/lipProfile
 * 计算段。这些函数不依赖 this、不触发副作用，探针式断言典型输入输出即可锁定行为。
 */
import { describe, it, expect } from 'vitest'
import {
  selectEngineMode, computeWanDurationSec, computeH3NeedSec, computeH3Length,
  applyOomLightDowngrade, applyOomTierDowngrade, shouldFallbackR2vToI2v,
  computeWantedCandidates, computeLipProfile, isFlf2vWorkflow, resolveFlfWorkflowName,
  injectH3TurboLora
} from '../../src/main/core/taskQueueRender'
import type { Shot } from '../../src/shared/ipcTypes'
import type { VramTier } from '../../src/main/core/comfyuiClient'

/** 构造一个最小可用的 shot stub（只填被测函数读取的字段） */
function makeShot(over: Partial<Shot> = {}): Shot {
  return {
    id: 's1', index: 1, type: 'i2v', status: 'pending',
    action: '', dialogue: '', emotion: '', camera: '', shotSize: 'medium',
    lighting: '', facing: '', continuity: '', scene: '',
    characters: [], characterIds: [], ...over
  } as Shot
}

describe('selectEngineMode', () => {
  it('flf 强制 wan（无论 H3/有台词）', () => {
    expect(selectEngineMode({ preferFlf: true, preferH3: true, hasLine: true, lipMode: 'auto' })).toBe('wan')
  })
  it('H3 + 有台词 + lipMode=auto → h3-r2v', () => {
    expect(selectEngineMode({ preferFlf: false, preferH3: true, hasLine: true, lipMode: 'auto' })).toBe('h3-r2v')
  })
  it('H3 + 有台词 + lipMode=latentsync → h3-i2v', () => {
    expect(selectEngineMode({ preferFlf: false, preferH3: true, hasLine: true, lipMode: 'latentsync' })).toBe('h3-i2v')
  })
  it('H3 + 无台词 → h3-i2v', () => {
    expect(selectEngineMode({ preferFlf: false, preferH3: true, hasLine: false, lipMode: 'auto' })).toBe('h3-i2v')
  })
  it('非 H3 → wan', () => {
    expect(selectEngineMode({ preferFlf: false, preferH3: false, hasLine: true, lipMode: 'auto' })).toBe('wan')
  })
  it('录音/画外音 forceI2v：即使有台词也不升 r2v', () => {
    expect(selectEngineMode({
      preferFlf: false, preferH3: true, hasLine: true, lipMode: 'auto', forceI2v: true
    })).toBe('h3-i2v')
  })
  it('默认工作流名不影响：有台词仍走 r2v（禁止因 minimax_h3_i2v 默认钉死解说片）', () => {
    expect(selectEngineMode({
      preferFlf: false, preferH3: true, hasLine: true, lipMode: 'auto', forceI2v: false
    })).toBe('h3-r2v')
  })
})

describe('computeWanDurationSec', () => {
  it('frames=65 → (65-1)/16=4s', () => {
    expect(computeWanDurationSec(65, 10)).toBe(4)
  })
  it('受 maxWanSec 上限钳制（4s 需求 vs 上限 2s）', () => {
    expect(computeWanDurationSec(65, 2)).toBe(2)
  })
  it('下限 1s（frames=1 → 0，钳到 1）', () => {
    expect(computeWanDurationSec(1, 10)).toBe(1)
  })
})

describe('computeH3NeedSec', () => {
  const shots = [
    makeShot({ id: 'a', index: 1 }),
    makeShot({ id: 'b', index: 2 })
  ]
  it('有台词（非末镜）：audioSec + leadSec + dialogueTailSec', () => {
    // dialogue 非末镜走 dialogueTailSec=0.5；lastIndex 由 allShots 最大 index 决定
    const shot = makeShot({ id: 'a', index: 1, dialogue: '你好' })
    const allShots = [shot, makeShot({ id: 'b', index: 5 })]
    const need = computeH3NeedSec(shot, 3.0, allShots, 0.3)
    expect(need).toBeCloseTo(3.0 + 0.3 + 0.5, 5)
  })
  it('无 audioSec：frames 反推，下限 2s', () => {
    const shot = makeShot({ id: 'a', index: 1, frames: 33 }) // (33-1)/16=2
    expect(computeH3NeedSec(shot, undefined, shots, 0.3)).toBe(2)
  })
  it('无 audioSec 且 frames 极小 → 下限 2s', () => {
    const shot = makeShot({ id: 'a', index: 1, frames: 1 }) // (1-1)/16=0 → max(2,0)=2
    expect(computeH3NeedSec(shot, undefined, shots, 0.3)).toBe(2)
  })
  it('短台词但镜头设计时长更长 → 取设计时长（台词短不代表镜短）', () => {
    // frames=81 → 设计 5s；台词只 0.9s + 0.3 lead + 0.5 tail = 1.7s
    // 只按音频算会渲成 2.3s（实测「哎呀」镜），必须按设计时长 5s 渲
    const shot = makeShot({ id: 'a', index: 1, dialogue: '哎呀', frames: 81 })
    const allShots = [shot, makeShot({ id: 'b', index: 5 })]
    expect(computeH3NeedSec(shot, 0.9, allShots, 0.3)).toBe(5)
  })
})

describe('computeH3Length', () => {
  it('正常换算：needSec=5s → 17*ceil((5*24-5)/17)+5', () => {
    // (5*24-5)=115, ceil(115/17)=7, 17*7+5=124
    const r = computeH3Length(5, 200)
    expect(r.length).toBe(124)
    expect(r.capped).toBe(false)
  })
  it('超档位被钳制：needSec=10s（raw=17*ceil(235/17)+5=17*14+5=243）vs maxFrames=158', () => {
    const r = computeH3Length(10, 158)
    expect(r.length).toBe(158)
    expect(r.capped).toBe(true)
    // capSec = ((158-5)/17)*0.75 ≈ 6.75
    expect(r.capSec).toBeCloseTo(6.75, 1)
  })
})

describe('applyOomLightDowngrade', () => {
  it('H3：h3Length-17 且下限 56，步数回 8', () => {
    const r = applyOomLightDowngrade('h3-r2v', { h3Length: 158, h3Steps: 8, wanDurationSec: 5 })
    expect(r).toEqual({ h3Length: 141, h3Steps: 8, wanDurationSec: 5 })
  })
  it('H3：已到 56 下限不再减', () => {
    const r = applyOomLightDowngrade('h3-i2v', { h3Length: 56, h3Steps: 8, wanDurationSec: 5 })
    expect(r.h3Length).toBe(56)
  })
  it('Wan：wanDurationSec-2 且下限 2', () => {
    const r = applyOomLightDowngrade('wan', { h3Length: 124, h3Steps: 8, wanDurationSec: 5 })
    expect(r).toEqual({ h3Length: 124, h3Steps: 8, wanDurationSec: 3 })
  })
  it('Wan：已到 2 下限不再减', () => {
    const r = applyOomLightDowngrade('wan', { h3Length: 124, h3Steps: 8, wanDurationSec: 2 })
    expect(r.wanDurationSec).toBe(2)
  })
})

describe('applyOomTierDowngrade', () => {
  const lowTier: VramTier = { name: 'low', label: 'low', width: 448, height: 800, maxFrames: 107, maxWanSec: 4 }
  it('按新档位钳制 h3Length / wanDurationSec', () => {
    const r = applyOomTierDowngrade(lowTier, 158, 6)
    expect(r).toEqual({ h3Length: 107, wanDurationSec: 4 })
  })
  it('值本身低于档位上限时保持不变', () => {
    const r = applyOomTierDowngrade(lowTier, 56, 3)
    expect(r).toEqual({ h3Length: 56, wanDurationSec: 3 })
  })
})

describe('shouldFallbackR2vToI2v', () => {
  it('全部条件满足 → true（OOM、非 r2v、非 auto、lipSync 关 任一不满足即 false）', () => {
    expect(shouldFallbackR2vToI2v({ isOom: false, mode: 'h3-r2v', lipMode: 'auto', lipSyncEnabled: true })).toBe(true)
  })
  it('OOM 时不回退（OOM 走降档分支）', () => {
    expect(shouldFallbackR2vToI2v({ isOom: true, mode: 'h3-r2v', lipMode: 'auto', lipSyncEnabled: true })).toBe(false)
  })
  it('非 r2v 不回退', () => {
    expect(shouldFallbackR2vToI2v({ isOom: false, mode: 'h3-i2v', lipMode: 'auto', lipSyncEnabled: true })).toBe(false)
  })
  it('lipMode 非 auto 不回退', () => {
    expect(shouldFallbackR2vToI2v({ isOom: false, mode: 'h3-r2v', lipMode: 'latentsync', lipSyncEnabled: true })).toBe(false)
  })
  it('lipSync 关闭不回退', () => {
    expect(shouldFallbackR2vToI2v({ isOom: false, mode: 'h3-r2v', lipMode: 'auto', lipSyncEnabled: false })).toBe(false)
  })
})

describe('computeWantedCandidates', () => {
  it('undefined → 1', () => {
    expect(computeWantedCandidates(undefined)).toBe(1)
  })
  it('3 以内原值', () => {
    expect(computeWantedCandidates(2)).toBe(2)
  })
  it('>3 钳到 3', () => {
    expect(computeWantedCandidates(9)).toBe(3)
  })
  it('<1 钳到 1', () => {
    expect(computeWantedCandidates(0)).toBe(1)
  })
})

describe('computeLipProfile', () => {
  it('h3-r2v 一律 native', () => {
    expect(computeLipProfile('h3-r2v', false, false)).toBe('native')
    expect(computeLipProfile('h3-r2v', true, true)).toBe('native')
  })
  it('needLipSync 且实际走了 latentsync → latentsync', () => {
    expect(computeLipProfile('h3-i2v', true, true)).toBe('latentsync')
  })
  it('needLipSync 但未实际同步（回退原片）→ none', () => {
    expect(computeLipProfile('h3-i2v', true, false)).toBe('none')
  })
  it('wan 且无需口型 → none', () => {
    expect(computeLipProfile('wan', false, false)).toBe('none')
  })
})

describe('isFlf2vWorkflow', () => {
  it('按名字判定', () => {
    expect(isFlf2vWorkflow('wan22_remix_flf2v', undefined)).toBe(true)
  })
  it('按 hasEndFrame 元数据判定', () => {
    expect(isFlf2vWorkflow('custom', { hasEndFrame: true, placeholders: [] })).toBe(true)
  })
  it('按 END_IMAGE 占位符判定', () => {
    expect(isFlf2vWorkflow('custom', { placeholders: ['REF_IMAGE', 'END_IMAGE'] })).toBe(true)
  })
  it('普通工作流 → false', () => {
    expect(isFlf2vWorkflow('wan22_i2v', { placeholders: ['PROMPT', 'REF_IMAGE'] })).toBe(false)
  })
})

describe('resolveFlfWorkflowName', () => {
  it('优先精确名 wan22_remix_flf2v', () => {
    const metas = [
      { name: 'wan22_i2v', placeholders: [] },
      { name: 'wan22_remix_flf2v', placeholders: ['END_IMAGE'] }
    ]
    expect(resolveFlfWorkflowName(metas)).toBe('wan22_remix_flf2v')
  })
  it('无精确名时按 hasEndFrame 挑选', () => {
    const metas = [
      { name: 'plain', placeholders: [] },
      { name: 'custom_flf', hasEndFrame: true, placeholders: ['END_IMAGE'] }
    ]
    expect(resolveFlfWorkflowName(metas)).toBe('custom_flf')
  })
  it('无 flf → undefined', () => {
    expect(resolveFlfWorkflowName([{ name: 'wan22_i2v', placeholders: ['PROMPT'] }])).toBeUndefined()
  })
})

describe('injectH3TurboLora', () => {
  it('H3 + turboH3=true：在 25 注入 LoRA 并改 42/43 model 引用', () => {
    const graph: Record<string, unknown> = {
      '42': { inputs: { model: ['20', 0], steps: 8 } },
      '43': { inputs: { model: ['20', 0] } }
    }
    const ok = injectH3TurboLora(graph, 'h3-r2v', true, 't2v.safetensors', 'r2v.safetensors')
    expect(ok).toBe(true)
    expect(graph['25']).toEqual({
      inputs: { model: ['20', 0], lora_name: 'r2v.safetensors', strength_model: 1.0 },
      class_type: 'LoraLoaderModelOnly'
    })
    expect((graph['42'] as { inputs: { model: unknown } }).inputs.model).toEqual(['25', 0])
    expect((graph['43'] as { inputs: { model: unknown } }).inputs.model).toEqual(['25', 0])
  })
  it('i2v 用 t2v LoRA', () => {
    const graph: Record<string, unknown> = {
      '42': { inputs: { model: ['20', 0] } },
      '43': { inputs: { model: ['20', 0] } }
    }
    injectH3TurboLora(graph, 'h3-i2v', true, 't2v.safetensors', 'r2v.safetensors')
    expect((graph['25'] as { inputs: { lora_name: string } }).inputs.lora_name).toBe('t2v.safetensors')
  })
  it('turboH3=false 不注入', () => {
    const graph: Record<string, unknown> = { '42': { inputs: { model: ['20', 0] } } }
    expect(injectH3TurboLora(graph, 'h3-r2v', false, 't2v.safetensors', 'r2v.safetensors')).toBe(false)
    expect(graph['25']).toBeUndefined()
  })
  it('wan 模式不注入', () => {
    const graph: Record<string, unknown> = {}
    expect(injectH3TurboLora(graph, 'wan', true, 't2v.safetensors', 'r2v.safetensors')).toBe(false)
    expect(graph['25']).toBeUndefined()
  })
})
