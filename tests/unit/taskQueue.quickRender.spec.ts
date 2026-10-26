/**
 * TaskQueue.quickRender 单测：WIDTH2/HEIGHT2 双采尺寸换算
 *
 * 被测逻辑（src/main/core/taskQueue.ts quickRender）：
 *   vars.WIDTH2  = meta.placeholders 含 'WIDTH2' 且传了 width  时注入 = floor(width*1.5/32)*32
 *   vars.HEIGHT2 = meta.placeholders 含 'HEIGHT2' 且传了 height 时注入 = floor(height*1.5/32)*32
 *
 * 测试缝（不改生产代码）：
 * - WorkflowLoader 用真实实例，夹具 JSON 通过 createWorkflow 写入临时目录（不动 workflows/ 真实模板）；
 * - comfyui 用对象字面量 stub（断言捕获 submit 收到的 graph），cast 成 ComfyUIClient 满足构造类型；
 * - store/settings/tts/ffmpeg 用最小 stub：quickRender 路径只用到 settings.get()，
 *   返回 {} 时 resolveCreation 走默认值（comfyTimeoutSec=600），不触碰其它依赖。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { TaskQueue } from '../../src/main/core/taskQueue'
import { WorkflowLoader } from '../../src/main/core/workflowLoader'
import { ComfyUIClient } from '../../src/main/core/comfyuiClient'
import type { ComfyUIHistoryOutput } from '../../src/shared/ipcTypes'
import type { ProjectStore } from '../../src/main/core/projectStore'
import type { SettingsStore } from '../../src/main/core/settingsStore'
import type { TTSService } from '../../src/main/core/ttsService'
import type { FFmpegService } from '../../src/main/core/ffmpegService'

/** 夹具 A：双采模板，含 $PROMPT$/$WIDTH2$/$HEIGHT2$ */
const WF_DUAL = {
  '1': { class_type: 'CLIPTextEncode', _meta: { title: '提示词' }, inputs: { text: '$PROMPT$' } },
  '2': { class_type: 'EmptyLatentImage', _meta: { title: '潜空间尺寸' }, inputs: { width: '$WIDTH2$', height: '$HEIGHT2$', batch_size: 1 } }
}

/** 夹具 B：普通模板，只有 $PROMPT$（宽高写死 512×768） */
const WF_PLAIN = {
  '1': { class_type: 'CLIPTextEncode', _meta: { title: '提示词' }, inputs: { text: '$PROMPT$' } },
  '2': { class_type: 'EmptyLatentImage', _meta: { title: '潜空间尺寸' }, inputs: { width: 512, height: 768, batch_size: 1 } }
}

/** 从 buildGraph 产物里取某节点 inputs（窄化 unknown） */
function nodeInputs(graph: Record<string, unknown>, id: string): Record<string, unknown> {
  const node = graph[id] as { inputs?: Record<string, unknown> } | undefined
  return node?.inputs ?? {}
}

/** 递归收集 graph 里所有数字，用于断言「不出现 704/1280」 */
function collectNumbers(v: unknown, out: number[] = []): number[] {
  if (typeof v === 'number') out.push(v)
  else if (Array.isArray(v)) v.forEach(x => collectNumbers(x, out))
  else if (typeof v === 'object' && v !== null) Object.values(v).forEach(x => collectNumbers(x, out))
  return out
}

describe('TaskQueue.quickRender 双采尺寸换算', () => {
  let dir: string
  let wl: WorkflowLoader

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-quick-'))
    wl = new WorkflowLoader(dir)
    await wl.createWorkflow('dual', JSON.stringify(WF_DUAL))
    await wl.createWorkflow('plain', JSON.stringify(WF_PLAIN))
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  /**
   * 每个用例新建一套 stub：捕获 submit 收到的 graph。
   * objectInfo 只登记夹具用到的两个 class_type（inspect 对无定义输入的节点不做枚举校验）。
   */
  function makeQueue(): { queue: TaskQueue; captured: () => Record<string, unknown> | null } {
    let submitted: Record<string, unknown> | null = null
    const comfy = {
      getObjectInfo: async () => ({
        CLIPTextEncode: { input: { required: {} } },
        EmptyLatentImage: { input: { required: {} } }
      }),
      submit: async (graph: Record<string, unknown>) => {
        submitted = graph
        return { promptId: 'pid-quick', number: 1 }
      },
      waitForCompletion: async (): Promise<ComfyUIHistoryOutput> => ({
        gifs: [{ filename: 'out.mp4', subfolder: '', type: 'output', fullpath: 'E:/tmp/out.mp4' }]
      }),
      // 与 ComfyUIClient.findVideoOutput 同语义：优先 gifs/videos/images 首项
      findVideoOutput: (out: ComfyUIHistoryOutput) => out.gifs?.[0] ?? out.videos?.[0] ?? out.images?.[0] ?? null,
      downloadFromFullPath: async () => { /* 不真下载 */ }
    } as unknown as ComfyUIClient

    // settings.get() 返回 {}：resolveCreation 全量走 DEFAULT_CREATION（comfyTimeoutSec=600）
    const settings = { get: async () => ({}) } as unknown as SettingsStore
    const queue = new TaskQueue(
      dir,
      comfy,
      wl,
      {} as unknown as TTSService,
      {} as unknown as FFmpegService,
      {} as unknown as ProjectStore,
      settings
    )
    return { queue, captured: () => submitted }
  }

  it('用例1：模板含 $WIDTH2$/$HEIGHT2$ 时按 ×1.5 向下对齐 32 注入（480→704，864→1280）', async () => {
    const { queue, captured } = makeQueue()
    const result = await queue.quickRender({
      workflowName: 'dual',
      prompt: '一只猫',
      width: 480,
      height: 864,
      seed: 42
    })

    const graph = captured()
    expect(graph, 'submit 应收到 buildGraph 产物').not.toBeNull()
    // 480*1.5=720 → floor(720/32)=22 → 704；864*1.5=1296 → floor(1296/32)=40 → 1280
    expect(nodeInputs(graph!, '2').width).toBe(704)
    expect(nodeInputs(graph!, '2').height).toBe(1280)
    // 占位符已全部替换、无残留 $
    expect(JSON.stringify(graph)).not.toMatch(/\$[A-Z_]+\$/)
    // 流程走通到下载返回
    expect(result.promptId).toBe('pid-quick')
    expect(result.outputAbs).toMatch(/\.mp4$/)
  })

  it('用例2：模板不含 WIDTH2/HEIGHT2 时传 width/height 不注入换算值，也不报错', async () => {
    const { queue, captured } = makeQueue()
    const result = await queue.quickRender({
      workflowName: 'plain',
      prompt: '一只狗',
      width: 480,
      height: 864,
      seed: 7
    })

    const graph = captured()
    expect(graph).not.toBeNull()
    const nums = collectNumbers(graph)
    expect(nums).not.toContain(704)
    expect(nums).not.toContain(1280)
    // 模板自身写死的尺寸保留
    expect(nodeInputs(graph!, '2').width).toBe(512)
    expect(result.outputAbs).toMatch(/\.mp4$/)
  })

  it('用例3（门控）：模板含 WIDTH2 但不传 width/height 时不注入，buildGraph 漏检未替换占位符报错', async () => {
    const { queue, captured } = makeQueue()
    // 真实行为：params.width/height 为 undefined → 不注入 WIDTH2/HEIGHT2 →
    // buildGraph 发现 $WIDTH2$/$HEIGHT2$ 未替换 → 抛「存在未替换占位符」
    await expect(queue.quickRender({
      workflowName: 'dual',
      prompt: '一只鸟'
    })).rejects.toThrow(/未替换占位符.*WIDTH2/)
    expect(captured(), 'buildGraph 报错时不应提交 ComfyUI').toBeNull()
  })
})
