import { describe, expect, it } from 'vitest'
import {
  collapseReadableFaces,
  comfyInstallRoot,
  mergeProtectedDoneShot,
  reviewFailureStops,
  shotsInCut,
  trimmedDurationSec,
  unreviewedI2vShots
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
