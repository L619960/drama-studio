import { describe, expect, it } from 'vitest'
import {
  collapseReadableFaces,
  comfyInstallRoot,
  mergeProtectedDoneShot,
  reviewFailureStops,
  shotsInCut,
  trimmedDurationSec,
  unreviewedI2vShots,
  renderTargetShots,
  unreviewedRenderShots,
  clampShotList,
  shouldFallbackToWan,
  orientVideoSize,
  shouldPauseAfterAudit,
  CATASTROPHIC_CONSISTENCY_SCORE,
  reviewedIsValid
} from '../../src/shared/pipelineGuards'
import { extractKeyProps, propLockFromAction, validateNarrativeContinuity } from '../../src/shared/narrativeBeats'
import { audioTailSecFor } from '../../src/shared/shotDoctrine'

describe('成片入选', () => {
  it('低一致性仍入片，跳过和空路径不入片', () => {
    const cut = shotsInCut([
      { status: 'done', segmentPath: 'projects/a.mp4', lowConsistency: true },
      { status: 'done', segmentPath: 'projects/b.mp4', skipped: true },
      { status: 'done', segmentPath: '   ' }
    ])
    expect(cut).toHaveLength(1)
    expect(cut[0].segmentPath).toBe('projects/a.mp4')
  })

  it('非法裁切退回整段时长', () => {
    expect(trimmedDurationSec(6, 1, 4)).toBe(3)
    expect(trimmedDurationSec(6, 5, 2)).toBe(6)
  })

  it('审核失败只在关闭闸门时继续', () => {
    expect(reviewFailureStops('block')).toBe(true)
    expect(reviewFailureStops('warn')).toBe(true)
    expect(reviewFailureStops('off')).toBe(false)
  })

  it('图生视频未审或没有首帧都算未审', () => {
    const pending = unreviewedI2vShots([
      { type: 'i2v', reviewed: true, firstFramePath: '' },
      { type: 'i2v', reviewed: true, firstFramePath: 'projects/f.png' },
      { type: 't2v', reviewed: false }
    ])
    expect(pending).toHaveLength(1)
  })

  it('开渲目标：显式 shotIds 优先，否则只取 pending/failed', () => {
    const shots = [
      { id: 'a', status: 'done' },
      { id: 'b', status: 'pending' },
      { id: 'c', status: 'failed' },
      { id: 'd', status: 'rendering' }
    ]
    expect(renderTargetShots(shots).map(s => s.id)).toEqual(['b', 'c'])
    expect(renderTargetShots(shots, ['a', 'd']).map(s => s.id)).toEqual(['a', 'd'])
  })

  it('告警放行预判：只看目标中的 i2v，重渲场景按全部 i2v 提示', () => {
    const shots = [
      { id: 'a', index: 1, status: 'pending', type: 'i2v', reviewed: true, firstFramePath: 'projects/f.png' },
      { id: 'b', index: 2, status: 'pending', type: 'i2v', reviewed: false },
      { id: 'c', index: 3, status: 'done', type: 'i2v', reviewed: false },
      { id: 'd', index: 4, status: 'pending', type: 't2v', reviewed: false }
    ]
    expect(unreviewedRenderShots(shots).map(s => s.id)).toEqual(['b'])
    expect(unreviewedRenderShots(shots, ['a', 'b']).map(s => s.id)).toEqual(['b'])
    // 重渲会清空 reviewed：已核对的 a 也需提示，非 i2v 的 d 不提示
    expect(unreviewedRenderShots(shots, ['a', 'b', 'd'], true).map(s => s.id)).toEqual(['a', 'b'])
  })
})

describe('一镜一张可读脸', () => {
  it('多名角色只保留第一个并给出说明', () => {
    const result = collapseReadableFaces([
      { type: 'i2v', characterName: '林夏', characters: ['林夏', '周衡'] },
      { type: 't2v', characters: ['路人甲', '路人乙'] }
    ])
    expect(result.shots[0].characters).toEqual(['林夏'])
    expect(result.shots[0].characterName).toBe('林夏')
    expect(result.notes[0]).toContain('周衡')
    expect(result.shots[1].characters).toEqual(['路人甲', '路人乙'])
  })
})

describe('已完成镜头落盘保护', () => {
  it('空路径不能盖掉磁盘上的成片路径', () => {
    const merged = mergeProtectedDoneShot(
      { status: 'done', segmentPath: 'projects/a.mp4', audioPath: 'projects/a.wav' },
      { status: 'pending', segmentPath: '  ', audioPath: '' }
    )
    expect(merged.status).toBe('done')
    expect(merged.segmentPath).toBe('projects/a.mp4')
    expect(merged.audioPath).toBe('projects/a.wav')
  })

  it('新的非空路径可以替换', () => {
    const merged = mergeProtectedDoneShot(
      { status: 'done', segmentPath: 'projects/old.mp4' },
      { status: 'done', segmentPath: 'projects/new.mp4' }
    )
    expect(merged.segmentPath).toBe('projects/new.mp4')
  })
})

describe('Comfy 安装根', () => {
  it('从启动命令里的 main.py 推出目录', () => {
    expect(comfyInstallRoot('"C:\\Comfy\\python\\python.exe" "C:\\Comfy\\ComfyUI\\main.py" --listen 127.0.0.1')).toBe(
      'C:\\Comfy\\ComfyUI'
    )
    expect(comfyInstallRoot('')).toBe('')
  })
})

describe('音频收尾与道具', () => {
  it('台词收尾短于按钮收尾', () => {
    expect(audioTailSecFor({ dialogue: '走。' })).toBeLessThan(audioTailSecFor({ emotion: '崩溃', isLast: true }))
  })

  it('手机和钥匙进入道具清单，并写进画面锁定', () => {
    expect(extractKeyProps('她把钥匙和手机递过去')).toEqual(expect.arrayContaining(['手机', '钥匙']))
    expect(propLockFromAction('holds a smartphone')).toContain('mobile phone')
    const warnings = validateNarrativeContinuity('夜', '', '她把手机递过去', [
      { type: 'i2v', action: 'stands still', dialogue: '' }
    ])
    expect(warnings.some(w => w.includes('手机'))).toBe(true)
  })
})

// ====== 2026-10-30 补 pipelineGuards 未覆盖函数 ======
describe('pipelineGuards · 流水线契约补测', () => {
  describe('clampShotList：按上限截断', () => {
    it('shots ≤ max → 原样返回，trimmed = 0', () => {
      const v = clampShotList([1, 2, 3], 5)
      expect(v.shots).toEqual([1, 2, 3])
      expect(v.trimmed).toBe(0)
    })
    it('shots > max → slice(0, max)，trimmed = len - max', () => {
      const v = clampShotList([1, 2, 3, 4, 5], 3)
      expect(v.shots).toEqual([1, 2, 3])
      expect(v.trimmed).toBe(2)
    })
    it('maxShots = 0 → 强制 max = 1（Math.max(1, ...)）', () => {
      const v = clampShotList([1, 2, 3], 0)
      expect(v.shots.length).toBe(1)
      expect(v.trimmed).toBe(2)
    })
    it('maxShots = -3 → 同样强制 max = 1', () => {
      const v = clampShotList([1, 2, 3], -3)
      expect(v.shots.length).toBe(1)
    })
    it('maxShots 小数 → round', () => {
      const v = clampShotList([1, 2, 3, 4], 2.6)
      // round(2.6) = 3
      expect(v.shots.length).toBe(3)
    })
    it('空数组 → trimmed = 0', () => {
      const v = clampShotList([], 5)
      expect(v.shots).toEqual([])
      expect(v.trimmed).toBe(0)
    })
  })

  describe('shouldFallbackToWan：H3 极低分切 Wan', () => {
    it("consistencyMode = 'off' → false", () => {
      expect(shouldFallbackToWan('off', 'h3-r2v', 0.01, 0.5)).toBe(false)
    })
    it('非 H3 引擎 → false', () => {
      expect(shouldFallbackToWan('rerender', 'wan2-remix', 0.01, 0.5)).toBe(false)
    })
    it("consistencyMode = 'rerender' → score < threshold 才 true", () => {
      expect(shouldFallbackToWan('rerender', 'h3-r2v', 0.3, 0.5)).toBe(true)
      expect(shouldFallbackToWan('rerender', 'h3-r2v', 0.6, 0.5)).toBe(false)
    })
    it("consistencyMode = 'warn' + score < 灾难阈值(0.15) → true", () => {
      expect(shouldFallbackToWan('warn', 'h3-i2v', 0.1, 0.5)).toBe(true)
      expect(shouldFallbackToWan('warn', 'h3-i2v', 0.2, 0.5)).toBe(false)
    })
    it('h3-i2v 也是 H3', () => {
      expect(shouldFallbackToWan('warn', 'h3-i2v', 0.1, 0.5)).toBe(true)
    })
    it('CATASTROPHIC_CONSISTENCY_SCORE = 0.15', () => {
      expect(CATASTROPHIC_CONSISTENCY_SCORE).toBe(0.15)
    })
  })

  describe('orientVideoSize：按参考图方向确定横竖屏', () => {
    it('tierPortrait 且 portrait 需求 → 原样', () => {
      expect(orientVideoSize(720, 1280, true)).toEqual({ width: 720, height: 1280 })
    })
    it('tierLandscape 且 landscape 需求 → 原样', () => {
      expect(orientVideoSize(1920, 1080, false)).toEqual({ width: 1920, height: 1080 })
    })
    it('竖屏需求 + tier 是横屏 → 对调', () => {
      expect(orientVideoSize(1920, 1080, true)).toEqual({ width: 1080, height: 1920 })
    })
    it('横屏需求 + tier 是竖屏 → 对调', () => {
      expect(orientVideoSize(720, 1280, false)).toEqual({ width: 1280, height: 720 })
    })
    it('正方形 tier → tierPortrait = true（height >= width）', () => {
      expect(orientVideoSize(1080, 1080, true)).toEqual({ width: 1080, height: 1080 })
    })
  })

  describe('shouldPauseAfterAudit：硬失败才暂停', () => {
    it('failCount > 0 → true', () => { expect(shouldPauseAfterAudit(5, 1)).toBe(true) })
    it('failCount = 0 → false（不管 hintCount）', () => {
      expect(shouldPauseAfterAudit(5, 0)).toBe(false)
      expect(shouldPauseAfterAudit(0, 0)).toBe(false)
      expect(shouldPauseAfterAudit(0, 0)).toBe(false)
    })
  })

  describe('reviewedIsValid 补测：边界', () => {
    it('reviewed = undefined → false', () => { expect(reviewedIsValid('t2v', undefined)).toBe(false) })
    it('reviewed = false → false', () => { expect(reviewedIsValid('t2v', false)).toBe(false) })
    it('i2v + reviewed + firstFramePath 全空白 → false', () => {
      expect(reviewedIsValid('i2v', true, '   ')).toBe(false)
    })
    it('i2v + reviewed + firstFramePath 非空 → true', () => {
      expect(reviewedIsValid('i2v', true, 'projects/f.png')).toBe(true)
    })
  })
})
