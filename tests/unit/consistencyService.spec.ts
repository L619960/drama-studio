/**
 * ConsistencyService 多帧聚合逻辑单测（P1-3 核心模块补测）：
 * 不加载真实 CLIP/ArcFace 模型，直接替换实例上的 compare 返回各帧结果，
 * 验证 frameTimes 空/全失败回退、face 与 full 两套量表分方法聚合、异常帧跳过。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/main/core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
// FaceDetector 只在 compare 内部使用，这里整体打桩，避免 import onnxruntime
vi.mock('../../src/main/core/faceDetector', () => ({
  FaceDetector: class {
    available = vi.fn(async () => false)
    recognitionAvailable = vi.fn(async () => false)
    detectPair = vi.fn(async () => null)
    embedPair = vi.fn(async () => null)
  }
}))
// 可选依赖：本机是否安装 @xenova/transformers 不确定，统一打桩为「模型下载失败」，
// 让 available() 稳定走 initFailed 分支，测试结果不依赖外部环境
vi.mock('@xenova/transformers', () => ({
  env: {},
  RawImage: class {},
  pipeline: async () => {
    throw new Error('模型下载失败')
  }
}))

import {
  ConsistencyService, FACE_CONSISTENCY_THRESHOLD, CONSISTENCY_THRESHOLD, H3_WAN_FALLBACK_THRESHOLD
} from '../../src/main/core/consistencyService'
import type { ConsistencyResult } from '../../src/main/core/consistencyService'

function mkService() {
  // loadRawImage 在 compareFrames 路径下不会被触达（compare 已被替换）
  const svc = new ConsistencyService('/tmp/models', vi.fn() as never)
  const compare = vi.fn(async (_ref: string, _target: string, _t?: number): Promise<ConsistencyResult> => ({ score: 0.8, method: 'full' }))
  ;(svc as unknown as { compare: typeof compare }).compare = compare
  return { svc, compare }
}

describe('阈值常量', () => {
  it('face（ArcFace）与 full（CLIP）使用各自的阈值口径', () => {
    expect(FACE_CONSISTENCY_THRESHOLD).toBe(0.5)
    expect(CONSISTENCY_THRESHOLD).toBe(0.7)
    expect(H3_WAN_FALLBACK_THRESHOLD).toBeLessThan(FACE_CONSISTENCY_THRESHOLD)
  })
})

describe('compareFrames · 多帧聚合', () => {
  it('frameTimes 为空 → 直接退回单帧 compare（不传时间点）', async () => {
    const { svc, compare } = mkService()
    const r = await svc.compareFrames('ref.png', 'video.mp4', [])
    expect(compare).toHaveBeenCalledTimes(1)
    expect(compare).toHaveBeenCalledWith('ref.png', 'video.mp4')
    expect(r).toEqual({ score: 0.8, method: 'full' })
  })

  it('人脸帧存在时只用人脸帧均分（不被 CLIP 高分稀释），保留 3 位小数', async () => {
    const { svc, compare } = mkService()
    compare.mockImplementation(async (_r, _t, t?: number) =>
      t === 0 ? { score: 0.91, method: 'face' }
        : t === 1 ? { score: 0.55, method: 'face' }
          : { score: 0.99, method: 'full' })
    const r = await svc.compareFrames('ref.png', 'video.mp4', [0, 1, 2])
    // (0.91 + 0.55) / 2 = 0.73
    expect(r).toEqual({ score: 0.73, method: 'face' })
  })

  it('全部无人脸（被小脸门控回退）→ 用 CLIP 均分', async () => {
    const { svc, compare } = mkService()
    compare.mockImplementation(async () => ({ score: 0.6, method: 'full' }))
    const r = await svc.compareFrames('ref.png', 'video.mp4', [0, 1])
    expect(r).toEqual({ score: 0.6, method: 'full' })
  })

  it('部分帧失败被跳过，剩余帧继续聚合', async () => {
    const { svc, compare } = mkService()
    compare.mockImplementation(async (_r, _t, t?: number) => {
      if (t === 0) throw new Error('抽帧失败')
      return { score: 0.8, method: 'face' }
    })
    const r = await svc.compareFrames('ref.png', 'video.mp4', [0, 1, 2])
    expect(r).toEqual({ score: 0.8, method: 'face' })
    expect(compare).toHaveBeenCalledTimes(3)
  })

  it('所有帧都失败 → 回退首帧时间点单帧 compare', async () => {
    const { svc, compare } = mkService()
    // 循环内两帧都失败，回退调用（同一时间点）才成功：
    // 真实实现回退时传 frameTimes[0]，因此不能靠时间点区分，改用调用计数
    let n = 0
    compare.mockImplementation(async (): Promise<ConsistencyResult> => {
      n++
      if (n <= 2) throw new Error('抽帧失败')
      return { score: 0.66, method: 'full' }
    })
    const r = await svc.compareFrames('ref.png', 'video.mp4', [1, 2])
    expect(compare).toHaveBeenCalledTimes(3)
    expect(compare).toHaveBeenLastCalledWith('ref.png', 'video.mp4', 1)
    expect(r).toEqual({ score: 0.66, method: 'full' })
  })
})

describe('available / needsDownload 状态机', () => {
  it('模型加载失败后 available=false 且 needsDownload=false（本会话永久禁用）', async () => {
    const svc = new ConsistencyService('/tmp/models', vi.fn() as never)
    // 依赖未安装：@xenova/transformers 动态 import 失败 → initFailed
    await expect(svc.available()).resolves.toBe(false)
    expect(svc.needsDownload).toBe(false)
  })
})
