/**
 * ImageService 单测（不起 ComfyUI、不发网络）：
 * 覆盖 generate 重试循环（OOM 降档 / 瞬时退避 / 取消 / 重试耗尽 throw lastErr）、
 * runOnce 工作流选择与降级、seed/negative/参考图注入、graph 后处理、产物校验与下载分支、
 * raceAbort / sleep 的取消路径、restoreFace 的跳过与吞错路径。
 * comfyui / workflow 均为对象字面量 stub（as unknown as 强转），electron/fs 无运行时依赖。
 */
import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { ImageService, ImageGenerateCancelled } from '../../src/main/core/imageService'
import { CINEMATIC_QUALITY_BLOCK, REALISM_NEGATIVE } from '../../src/shared/imagePrompts'
import type { ComfyUIClient } from '../../src/main/core/comfyuiClient'
import type { WorkflowLoader } from '../../src/main/core/workflowLoader'

interface Meta {
  name: string
  placeholders: string[]
}

interface StubOpts {
  metas?: Meta[]
  checkpoints?: string[]
  graphFactory?: () => Record<string, unknown>
  /** waitForCompletion 行为：可传工厂函数按调用次数决定 */
  completion?: (
    n: number,
  ) => Promise<{ images?: Array<{ filename: string; subfolder: string; type: string; fullpath?: string }> }>
  submit?: (n: number) => Promise<{ promptId: string }>
  interrupt?: () => Promise<void>
}

function defaultGraph(): Record<string, unknown> {
  return {
    '1': { class_type: 'CLIPTextEncode', inputs: { text: '$PROMPT$' } },
    '2': { class_type: 'EmptyLatentImage', inputs: { width: 0, height: 0 } },
    '3': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'keep.safetensors' } },
  }
}

function makeService(opts: StubOpts = {}) {
  const metas = opts.metas ?? [{ name: 'qwen_t2i_hq', placeholders: ['PROMPT', 'SEED', 'NEGATIVE', 'WIDTH', 'HEIGHT'] }]
  const checkpoints = opts.checkpoints ?? ['model.safetensors']
  const builds: Array<{ name: string; vars: Record<string, unknown>; graph: Record<string, unknown> }> = []
  const uploads: string[] = []
  const downloads: Array<{ f: string; s: string; t: string; abs: string }> = []
  const fullDownloads: Array<{ fp: string; abs: string }> = []
  let submitN = 0
  let completeN = 0
  let interruptN = 0
  const rejectPendingCalls: Array<{ msg: string; pid?: string }> = []

  const comfyui = {
    getCheckpoints: async () => checkpoints,
    uploadImage: async (p: string) => {
      uploads.push(p)
      return `up_${path.basename(p)}`
    },
    submit: async () => {
      submitN++
      if (opts.submit) return opts.submit(submitN)
      return { promptId: `pid-${submitN}` }
    },
    waitForCompletion: async () => {
      completeN++
      if (opts.completion) return opts.completion(completeN)
      return { images: [{ filename: 'img.png', subfolder: 'sub', type: 'output', fullpath: 'E:/comfy/out/img.png' }] }
    },
    download: async (f: string, s: string, t: string, abs: string) => {
      downloads.push({ f, s, t, abs })
    },
    downloadFromFullPath: async (fp: string, abs: string) => {
      fullDownloads.push({ fp, abs })
    },
    interrupt: async () => {
      interruptN++
      if (opts.interrupt) return opts.interrupt()
    },
    // CORE-05：取消分支会精确结束挂起等待，stub 不能缺该方法
    rejectPending: (msg: string, pid?: string) => {
      rejectPendingCalls.push({ msg, ...(pid !== undefined ? { pid } : {}) })
    },
  } as unknown as ComfyUIClient

  const workflow = {
    list: async () => metas,
    buildGraph: async (name: string, vars: Record<string, unknown>) => {
      const graph = opts.graphFactory ? opts.graphFactory() : defaultGraph()
      builds.push({ name, vars, graph })
      return graph
    },
  } as unknown as WorkflowLoader

  const svc = new ImageService(comfyui, workflow)
  return {
    svc,
    builds,
    uploads,
    downloads,
    fullDownloads,
    rejectPendingCalls,
    counters: () => ({ submitN, completeN, interruptN }),
  }
}

const OUT = path.join(process.env.TEMP || '/tmp', 'imgsvc', 'out.png')

describe('ImageService.generate 重试循环', () => {
  it('首次成功：提示词追加电影级质量条款，fullpath 走 downloadFromFullPath', async () => {
    const { svc, builds, fullDownloads } = makeService()
    await svc.generate('一只猫', OUT)
    expect(builds).toHaveLength(1)
    expect(builds[0]?.name).toBe('qwen_t2i_hq')
    expect(builds[0]?.vars.PROMPT).toBe(`一只猫, ${CINEMATIC_QUALITY_BLOCK}`)
    expect(builds[0]?.vars.NEGATIVE).toBe(REALISM_NEGATIVE)
    expect(builds[0]?.vars.WIDTH).toBe(768)
    expect(builds[0]?.vars.HEIGHT).toBe(1152)
    expect(fullDownloads[0]?.fp).toBe('E:/comfy/out/img.png')
    expect(fullDownloads[0]?.abs).toBe(OUT)
  })

  it('提示词已含质量条款整块 → 不重复追加', async () => {
    const { svc, builds } = makeService()
    await svc.generate(`猫, ${CINEMATIC_QUALITY_BLOCK}`, OUT)
    expect(builds[0]?.vars.PROMPT).toBe(`猫, ${CINEMATIC_QUALITY_BLOCK}`)
  })

  it('自定义 qualityBlock 字段生效', async () => {
    const { svc, builds } = makeService()
    svc.qualityBlock = 'CUSTOM QUALITY'
    await svc.generate('狗', OUT)
    expect(builds[0]?.vars.PROMPT).toBe('狗, CUSTOM QUALITY')
  })

  it('shouldAbort 起始即为 true → 立即抛取消，不提交', async () => {
    const { svc, counters } = makeService()
    await expect(svc.generate('猫', OUT, { shouldAbort: () => true })).rejects.toBeInstanceOf(ImageGenerateCancelled)
    expect(counters().submitN).toBe(0)
  })

  it('OOM → interrupt(失败被吞) + 分辨率降档重试成功', async () => {
    const { svc, builds, counters } = makeService({
      submit: (n) =>
        n === 1
          ? Promise.reject(new Error('CUDA out of memory when allocating tensor'))
          : Promise.resolve({ promptId: 'p2' }),
      interrupt: () => Promise.reject(new Error('interrupt failed')),
    })
    await svc.generate('猫', OUT)
    expect(builds).toHaveLength(2)
    // 768→640（round(652.8/32)*32），1152→992（round(979.2/32)*32）
    expect(builds[1]?.vars.WIDTH).toBe(640)
    expect(builds[1]?.vars.HEIGHT).toBe(992)
    expect(counters().interruptN).toBe(1)
  })

  it('OOM 已降过档再次 OOM → 不再降，直接抛出', async () => {
    const { svc, builds } = makeService({
      submit: () => Promise.reject(new Error('out of memory')),
    })
    await expect(svc.generate('猫', OUT, { retries: 1 })).rejects.toThrow(/out of memory/)
    expect(builds).toHaveLength(2)
  })

  it('非 Error 的字符串 OOM（显存不足）同样触发降档重试', async () => {
    const { svc, builds } = makeService({
      submit: (n) => (n === 1 ? Promise.reject('显存不足') : Promise.resolve({ promptId: 'p2' })),
    })
    await svc.generate('猫', OUT)
    expect(builds).toHaveLength(2)
    expect(builds[1]?.vars.WIDTH).toBe(640)
  })

  it('retries=0 且 OOM → continue 耗尽循环 → throw lastErr', async () => {
    const { svc } = makeService({
      submit: () => Promise.reject(new Error('vram insufficient')),
    })
    await expect(svc.generate('猫', OUT, { retries: 0 })).rejects.toThrow(/vram insufficient/)
  })

  it('瞬时故障 → 退避 2s 后重试成功', async () => {
    const { svc, builds } = makeService({
      submit: (n) => (n === 1 ? Promise.reject(new Error('fetch failed')) : Promise.resolve({ promptId: 'p2' })),
    })
    await svc.generate('猫', OUT, { retries: 1 })
    expect(builds).toHaveLength(2)
  })

  it('瞬时退避 sleep 期间 shouldAbort 置真 → 中断为取消', async () => {
    const { svc } = makeService({
      submit: () => Promise.reject(new Error('socket hang up')),
    })
    const t0 = Date.now()
    const p = svc.generate('猫', OUT, { retries: 2, shouldAbort: () => Date.now() - t0 > 300 })
    await expect(p).rejects.toBeInstanceOf(ImageGenerateCancelled)
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('非瞬时错误 retries=0 → 直接抛出', async () => {
    const { svc } = makeService({
      submit: () => Promise.reject(new Error('invalid graph structure')),
    })
    await expect(svc.generate('猫', OUT, { retries: 0 })).rejects.toThrow(/invalid graph/)
  })

  it('catch 后 shouldAbort 置真 → 抛取消而非原错误', async () => {
    const { svc } = makeService({
      submit: () => Promise.reject(new Error('bad prompt')),
    })
    let called = 0
    await expect(svc.generate('猫', OUT, { retries: 0, shouldAbort: () => ++called > 2 })).rejects.toBeInstanceOf(
      ImageGenerateCancelled,
    )
  })

  it('runOnce 提交前取消 → ImageGenerateCancelled 原样上抛', async () => {
    const { svc, counters } = makeService()
    let called = 0
    await expect(svc.generate('猫', OUT, { retries: 0, shouldAbort: () => ++called > 1 })).rejects.toBeInstanceOf(
      ImageGenerateCancelled,
    )
    expect(counters().submitN).toBe(0)
  })
})

describe('ImageService.runOnce 工作流选择与注入', () => {
  it('strictWorkflow 且模板缺失 → 直接报错不降级', async () => {
    const { svc, builds } = makeService({ metas: [{ name: 'other', placeholders: [] }] })
    await expect(svc.generate('猫', OUT, { strictWorkflow: true })).rejects.toThrow(/strictWorkflow/)
    expect(builds).toHaveLength(0)
  })

  it('模板缺失回退 builtin_t2i', async () => {
    const { svc, builds } = makeService({
      metas: [{ name: 'builtin_t2i', placeholders: ['PROMPT', 'SEED', 'NEGATIVE'] }],
    })
    await svc.generate('猫', OUT)
    expect(builds[0]?.name).toBe('builtin_t2i')
  })

  it('preferred 与 builtin 都不存在 → 仍按 preferred 名构建', async () => {
    const { svc, builds } = makeService({ metas: [{ name: 'other', placeholders: [] }] })
    await svc.generate('猫', OUT, { workflowName: 'missing_wf' })
    expect(builds[0]?.name).toBe('missing_wf')
  })

  it('无可用 Checkpoint → 报错', async () => {
    const { svc } = makeService({ checkpoints: [] })
    await expect(svc.generate('猫', OUT)).rejects.toThrow(/Checkpoint/)
  })

  it('seed 取整无符号化；NaN 走随机；negative 自定义', async () => {
    const { svc, builds } = makeService()
    await svc.generate('猫', OUT, { seed: 12.9, negative: 'no blur' })
    expect(builds[0]?.vars.SEED).toBe(12)
    expect(builds[0]?.vars.NEGATIVE).toBe('no blur')
    await svc.generate('猫', OUT, { seed: Number.NaN })
    const s = builds[1]?.vars.SEED as number
    expect(Number.isInteger(s)).toBe(true)
    expect(s).toBeGreaterThanOrEqual(0)
  })

  it('模板无 WIDTH/HEIGHT 占位符时不注入尺寸', async () => {
    const { svc, builds } = makeService({
      metas: [{ name: 'qwen_t2i_hq', placeholders: ['PROMPT', 'SEED', 'NEGATIVE'] }],
    })
    await svc.generate('猫', OUT, { width: 512, height: 512 })
    const build = builds[0]
    if (!build) throw new Error('测试夹具缺少生成调用记录')
    expect('WIDTH' in build.vars).toBe(false)
    expect('HEIGHT' in build.vars).toBe(false)
  })

  it('referenceImagePaths 依次注入 REF_IMAGE/REF_IMAGE2，且优先于 referenceImagePath', async () => {
    const { svc, builds, uploads } = makeService({
      metas: [{ name: 'qwen_t2i_hq', placeholders: ['PROMPT', 'SEED', 'NEGATIVE', 'REF_IMAGE', 'REF_IMAGE2'] }],
    })
    await svc.generate('猫', OUT, {
      referenceImagePaths: ['a.png', 'b.png'],
      referenceImagePath: 'old.png',
    })
    expect(uploads).toEqual(['a.png', 'b.png'])
    expect(builds[0]?.vars.REF_IMAGE).toBe('up_a.png')
    expect(builds[0]?.vars.REF_IMAGE2).toBe('up_b.png')
  })

  it('referenceImagePath 旧字段单图兼容', async () => {
    const { svc, builds, uploads } = makeService({
      metas: [{ name: 'qwen_t2i_hq', placeholders: ['PROMPT', 'SEED', 'NEGATIVE', 'REF_IMAGE'] }],
    })
    await svc.generate('猫', OUT, { referenceImagePath: 'x.png' })
    expect(uploads).toEqual(['x.png'])
    expect(builds[0]?.vars.REF_IMAGE).toBe('up_x.png')
  })

  it('模板需要 REF_IMAGE2 但只给一张参考图 → 报错', async () => {
    const { svc } = makeService({
      metas: [{ name: 'qwen_t2i_hq', placeholders: ['PROMPT', 'SEED', 'NEGATIVE', 'REF_IMAGE', 'REF_IMAGE2'] }],
    })
    await expect(svc.generate('猫', OUT, { referenceImagePaths: ['a.png'] })).rejects.toThrow(/第 2 张参考图/)
  })

  it('模板需要 REF_IMAGE 但未给参考图 → 报错', async () => {
    const { svc } = makeService({
      metas: [{ name: 'qwen_t2i_hq', placeholders: ['PROMPT', 'SEED', 'NEGATIVE', 'REF_IMAGE'] }],
    })
    await expect(svc.generate('猫', OUT)).rejects.toThrow(/参考图/)
  })

  it('graph 后处理：ckpt 回填/尺寸写入/负向文本替换与保留', async () => {
    const promptFull = `猫, ${CINEMATIC_QUALITY_BLOCK}`
    const { svc, builds } = makeService({
      metas: [{ name: 'qwen_t2i_hq', placeholders: ['PROMPT', 'SEED', 'WIDTH', 'HEIGHT'] }],
      graphFactory: () => ({
        '1': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: 'x'.repeat(100) } },
        '3': { class_type: 'CLIPTextEncode', inputs: { text: 'anime style' } },
        '4': { class_type: 'CLIPTextEncode', inputs: { text: promptFull } },
        '5': { class_type: 'EmptyLatentImage', inputs: { width: 0, height: 0 } },
        '6': { class_type: 'EmptySD3LatentImage', inputs: { width: 0, height: 0 } },
        '7': { class_type: 'OtherNode', inputs: { width: 0, height: 0 } },
        '8': { class_type: 'NoInputsNode' },
        '9': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '' } },
        '10': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'keep.safetensors' } },
      }),
    })
    await svc.generate('猫', OUT, { width: 512, height: 768 })
    const g = builds[0]?.graph as Record<string, { class_type?: string; inputs?: Record<string, unknown> }> | undefined
    const inp = (id: string) => {
      const node = g?.[id]
      if (!node?.inputs) throw new Error(`测试夹具缺少 graph 节点 ${id}`)
      return node.inputs
    }
    expect(inp('1').text).toBe(REALISM_NEGATIVE) // 空文本 → 负向替换
    expect(inp('2').text).toBe('x'.repeat(100)) // 长文本无坏词 → 保留
    expect(inp('3').text).toBe(REALISM_NEGATIVE) // 命中 anime → 替换
    expect(inp('4').text).toBe(promptFull) // 等于主提示词 → 保留
    expect(inp('5').width).toBe(512)
    expect(inp('5').height).toBe(768)
    expect(inp('6').width).toBe(512)
    expect(inp('7').width).toBe(0) // 非空 Latent 节点不动
    expect(inp('9').ckpt_name).toBe('model.safetensors') // 空 ckpt 回填
    expect(inp('10').ckpt_name).toBe('keep.safetensors') // 已有 ckpt 保留
  })

  it('模板含 NEGATIVE 占位符时不替换 CLIPTextEncode 文本', async () => {
    const { svc, builds } = makeService({
      graphFactory: () => ({ '1': { class_type: 'CLIPTextEncode', inputs: { text: 'anime' } } }),
    })
    await svc.generate('猫', OUT)
    const g = builds[0]?.graph as Record<string, { inputs?: Record<string, unknown> }> | undefined
    if (!g) throw new Error('测试夹具缺少 builds[0]')
    const node = g['1']
    if (!node?.inputs) throw new Error('测试夹具缺少 graph 节点 1')
    expect(node.inputs.text).toBe('anime')
  })

  it('ComfyUI 无输出图片 → 报错', async () => {
    const { svc } = makeService({ completion: async () => ({ images: [] }) })
    await expect(svc.generate('猫', OUT)).rejects.toThrow(/未输出图片/)
    const { svc: svc2 } = makeService({ completion: async () => ({}) })
    await expect(svc2.generate('猫', OUT)).rejects.toThrow(/未输出图片/)
  })

  it('产物无 fullpath → 走 download(filename,subfolder,type)', async () => {
    const { svc, downloads, fullDownloads } = makeService({
      completion: async () => ({ images: [{ filename: 'a.png', subfolder: 'sd', type: 'output' }] }),
    })
    await svc.generate('猫', OUT)
    expect(fullDownloads).toHaveLength(0)
    expect(downloads[0]).toEqual({ f: 'a.png', s: 'sd', t: 'output', abs: OUT })
  })
})

describe('ImageService raceAbort 取消竞态', () => {
  it('带 shouldAbort 且始终为 false → 正常完成', async () => {
    const { svc } = makeService()
    await expect(svc.generate('猫', OUT, { shouldAbort: () => false })).resolves.toBeUndefined()
  })

  it('带 shouldAbort，waitForCompletion 报错 → 原错误透传', async () => {
    const { svc } = makeService({ completion: () => Promise.reject(new Error('render died')) })
    await expect(svc.generate('猫', OUT, { shouldAbort: () => false, retries: 0 })).rejects.toThrow(/render died/)
  })

  it('waitForCompletion 挂起期间取消 → 抛取消、interrupt 并精确结束挂起等待', async () => {
    const { svc, counters, rejectPendingCalls } = makeService({
      completion: () =>
        new Promise(() => {
          /* 永不完成 */
        }),
    })
    let called = 0
    const p = svc.generate('猫', OUT, { retries: 0, shouldAbort: () => ++called > 2 })
    await expect(p).rejects.toBeInstanceOf(ImageGenerateCancelled)
    expect(counters().interruptN).toBeGreaterThanOrEqual(1)
    // CORE-05：必须按当前 promptId 结束挂起等待，避免重试时该 id 仍被当成在途
    expect(rejectPendingCalls).toHaveLength(1)
    expect(rejectPendingCalls[0]?.pid).toBe('pid-1')
    expect(rejectPendingCalls[0]?.msg).toContain('已取消生成')
  })
})

describe('ImageService.restoreFace', () => {
  it('face_restore 模板不存在 → 跳过不提交', async () => {
    const { svc, counters } = makeService()
    await svc.restoreFace('E:/in.png', OUT)
    expect(counters().submitN).toBe(0)
  })

  it('成功：fullpath 走 downloadFromFullPath', async () => {
    const { svc, builds, fullDownloads } = makeService({
      metas: [{ name: 'face_restore', placeholders: ['INPUT_IMAGE'] }],
    })
    await svc.restoreFace('E:/in.png', OUT)
    expect(builds[0]?.name).toBe('face_restore')
    expect(builds[0]?.vars.INPUT_IMAGE).toBe('up_in.png')
    expect(fullDownloads[0]?.abs).toBe(OUT)
  })

  it('成功：无 fullpath 走 download', async () => {
    const { svc, downloads } = makeService({
      metas: [{ name: 'face_restore', placeholders: ['INPUT_IMAGE'] }],
      completion: async () => ({ images: [{ filename: 'f.png', subfolder: '', type: 'output' }] }),
    })
    await svc.restoreFace('E:/in.png', OUT)
    expect(downloads[0]?.f).toBe('f.png')
  })

  it('无输出图片 → 失败被吞（不阻塞）', async () => {
    const { svc } = makeService({
      metas: [{ name: 'face_restore', placeholders: ['INPUT_IMAGE'] }],
      completion: async () => ({}),
    })
    await expect(svc.restoreFace('E:/in.png', OUT)).resolves.toBeUndefined()
  })

  it('提交报错 → 失败被吞（不阻塞）', async () => {
    const { svc } = makeService({
      metas: [{ name: 'face_restore', placeholders: ['INPUT_IMAGE'] }],
      submit: () => Promise.reject(new Error('boom')),
    })
    await expect(svc.restoreFace('E:/in.png', OUT)).resolves.toBeUndefined()
  })
})
