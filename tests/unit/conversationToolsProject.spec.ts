import { describe, it, expect } from 'vitest'
import { renumberShots, validateFrames, recalcProjectStatus } from '../../src/main/core/conversationToolsProject'
import type { Project, Shot } from '../../src/shared/ipcTypes'

function mkShot(idx: number, status: Shot['status'] = 'pending', scene = `scene${idx}`): Shot {
  return {
    id: `s_${idx}`,
    index: idx,
    scene,
    action: 'a',
    dialogue: '',
    characterIds: [],
    type: 't2v',
    width: 512,
    height: 288,
    frames: 81,
    seed: 0,
    status
  }
}

describe('conversationToolsProject · renumberShots', () => {
  it('空数组不抛错', () => {
    const arr: Shot[] = []
    renumberShots(arr)
    expect(arr).toHaveLength(0)
  })

  it('把任意 index 重排为连续 1..N', () => {
    const shots: Shot[] = [mkShot(99), mkShot(7), mkShot(200)]
    renumberShots(shots)
    expect(shots.map(s => s.index)).toEqual([1, 2, 3])
  })
})

describe('conversationToolsProject · validateFrames', () => {
  it('非整数拒绝', () => {
    expect(validateFrames(81.5)).toMatch(/必须是/)
    expect(validateFrames(NaN)).toMatch(/必须是/)
    expect(validateFrames(Infinity)).toMatch(/必须是/)
  })

  it('< 17 拒绝', () => {
    expect(validateFrames(16)).toMatch(/≥17/)
    expect(validateFrames(0)).toMatch(/≥17/)
    expect(validateFrames(-1)).toMatch(/≥17/)
  })

  it('不满足 16n+1 拒绝', () => {
    expect(validateFrames(17)).toBeNull() // 16*1+1
    expect(validateFrames(33)).toBeNull() // 16*2+1
    expect(validateFrames(81)).toBeNull() // 16*5+1
    expect(validateFrames(97)).toBeNull() // 16*6+1
    expect(validateFrames(17)).toBeNull()
    expect(validateFrames(18)).toMatch(/16n\+1/)
    expect(validateFrames(32)).toMatch(/16n\+1/)
    expect(validateFrames(80)).toMatch(/16n\+1/)
  })
})

describe('conversationToolsProject · recalcProjectStatus', () => {
  function mkProject(shots: Shot[]): Project {
    return {
      id: 'p', title: 't', genre: 'g', episode: 1,
      status: 'draft',
      characters: [],
      shots,
      fps: 24,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  }

  it('渲染中保持 status 不变', () => {
    const p = mkProject([mkShot(1, 'failed'), mkShot(2, 'pending')])
    p.status = 'rendering'
    recalcProjectStatus(p)
    expect(p.status).toBe('rendering')
  })

  it('全部 done → done', () => {
    const p = mkProject([mkShot(1, 'done'), mkShot(2, 'done'), mkShot(3, 'done')])
    recalcProjectStatus(p)
    expect(p.status).toBe('done')
  })

  it('有 failed 且不全 done → failed', () => {
    const p = mkProject([mkShot(1, 'done'), mkShot(2, 'failed'), mkShot(3, 'pending')])
    recalcProjectStatus(p)
    expect(p.status).toBe('failed')
  })

  it('空 shots 数组 → draft（allDone 为 false）', () => {
    const p = mkProject([])
    recalcProjectStatus(p)
    expect(p.status).toBe('draft')
  })

  it('有 pending 无 failed → draft', () => {
    const p = mkProject([mkShot(1, 'done'), mkShot(2, 'pending')])
    recalcProjectStatus(p)
    expect(p.status).toBe('draft')
  })
})
