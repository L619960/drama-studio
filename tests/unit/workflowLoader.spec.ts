import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { WorkflowLoader } from '../../src/main/core/workflowLoader'

const WF = {
  '3': { class_type: 'CLIPTextEncode', inputs: { text: '$PROMPT$' } },
  '10': { class_type: 'KSampler', inputs: { seed: 42, steps: 20 } },
  '12': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 768 } }
}

describe('WorkflowLoader', () => {
  let dir: string
  let wl: WorkflowLoader

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-wf-'))
    wl = new WorkflowLoader(dir)
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('createWorkflow 写入合法 JSON', async () => {
    const name = await wl.createWorkflow('wf_a', JSON.stringify(WF))
    expect(name).toBe('wf_a')
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'wf_a.json'), 'utf-8'))
    expect(saved['10'].inputs.seed).toBe(42)
  })

  it('updateParam 修改指定节点输入并落盘', async () => {
    await wl.updateParam('wf_a', '10', 'seed', 7)
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'wf_a.json'), 'utf-8'))
    expect(saved['10'].inputs.seed).toBe(7)
  })

  it('占位符与连接引用不可修改，缺失节点报错', async () => {
    await expect(wl.updateParam('wf_a', '3', 'text', 'x')).rejects.toThrow('占位符')
    await expect(wl.updateParam('wf_a', '99', 'x', 1)).rejects.toThrow('不存在')
  })

  it('D-05：并发 updateParam 串行化，全部生效且 JSON 不损坏', async () => {
    await wl.createWorkflow('wf_race', JSON.stringify(WF))
    await Promise.all([
      wl.updateParam('wf_race', '10', 'seed', 1),
      wl.updateParam('wf_race', '10', 'steps', 10),
      wl.updateParam('wf_race', '12', 'width', 768)
    ])
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'wf_race.json'), 'utf-8'))
    expect(saved['10'].inputs.seed).toBe(1)
    expect(saved['10'].inputs.steps).toBe(10)
    expect(saved['12'].inputs.width).toBe(768)
  })

  it('同一文件串行：前一个写失败不阻塞后续写', async () => {
    await wl.createWorkflow('wf_seq', JSON.stringify(WF))
    const results = await Promise.allSettled([
      wl.updateParam('wf_seq', '99', 'x', 1), // 失败（节点不存在）
      wl.updateParam('wf_seq', '10', 'seed', 5)
    ])
    expect(results[0].status).toBe('rejected')
    expect(results[1].status).toBe('fulfilled')
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'wf_seq.json'), 'utf-8'))
    expect(saved['10'].inputs.seed).toBe(5)
  })

  it('buildGraph：$PROMPT$ 与 $WIDTH2$/$HEIGHT2$ 全部替换且无残留 $', async () => {
    const wfNum = {
      '1': { class_type: 'CLIPTextEncode', inputs: { text: '$PROMPT$' } },
      '2': { class_type: 'EmptyLatentImage', inputs: { width: '$WIDTH2$', height: '$HEIGHT2$' } }
    }
    const name = await wl.createWorkflow('wf_ph', JSON.stringify(wfNum))
    const g = await wl.buildGraph(name, { PROMPT: 'a cat', WIDTH2: 704, HEIGHT2: 1280 })
    expect((g['1'] as { inputs: { text: string } }).inputs.text).toBe('a cat')
    expect((g['2'] as { inputs: { width: number; height: number } }).inputs.width).toBe(704)
    expect((g['2'] as { inputs: { width: number; height: number } }).inputs.height).toBe(1280)
    // 数字占位符按 vars 原始类型替换（不应残留 $WIDTH2$ 字符串）
    expect(JSON.stringify(g)).not.toContain('$')
  })

  it('buildGraph：含数字的未替换占位符 $WIDTH2$ 必须报错（旧正则漏检用例）', async () => {
    const wfNum = {
      '1': { class_type: 'EmptyLatentImage', inputs: { width: '$WIDTH2$', height: 768 } }
    }
    const name = await wl.createWorkflow('wf_miss', JSON.stringify(wfNum))
    await expect(wl.buildGraph(name, {})).rejects.toThrow(/未替换占位符/)
    await expect(wl.buildGraph(name, {})).rejects.toThrow(/WIDTH2/)
  })

  it('buildGraph：嵌入模式文本替换 + 连接数组整型 node id 字符串化', async () => {
    const wfNum = {
      '5': { class_type: 'LoadImage', inputs: { filename: 'x_$SEED$_y' } },
      '6': { class_type: 'KSampler', inputs: { seed: 1 } },
      '7': { class_type: 'VAEDecode', inputs: { samples: [6, 0] } }
    }
    const name = await wl.createWorkflow('wf_embed', JSON.stringify(wfNum))
    const g = await wl.buildGraph(name, { SEED: 42 })
    expect((g['5'] as { inputs: { filename: string } }).inputs.filename).toBe('x_42_y')
    // [整型节点id, 槽位] → [字符串节点id, 槽位]，否则 ComfyUI 提交 KeyError
    expect((g['7'] as { inputs: { samples: unknown[] } }).inputs.samples).toEqual(['6', 0])
  })

  it('getEditableParams：$WIDTH2$ 含数字占位符正确识别为 isPlaceholder（旧正则漏检用例）', async () => {
    const wfNum = {
      '1': { class_type: 'CLIPTextEncode', inputs: { text: '$PROMPT$' } },
      '2': { class_type: 'EmptyLatentImage', inputs: { width: '$WIDTH2$', height: '$HEIGHT2$' } },
      '3': { class_type: 'KSampler', inputs: { seed: 42 } }
    }
    const name = await wl.createWorkflow('wf_params', JSON.stringify(wfNum))
    const params = await wl.getEditableParams(name)
    const width = params.find(p => p.key === 'width')
    const text = params.find(p => p.key === 'text')
    const seed = params.find(p => p.key === 'seed')
    // $WIDTH2$ 被正确识别为占位符（旧锚定正则 /^\$[A-Z_]+\$$/ 会漏检）
    expect(width?.isPlaceholder).toBe(true)
    // 回归：$PROMPT$ 等无数字占位符仍为占位符
    expect(text?.isPlaceholder).toBe(true)
    // 普通数值参数不误判
    expect(seed?.isPlaceholder).toBe(false)
  })

  it('updateParam：$WIDTH2$ 含数字占位符不可直接修改（旧正则漏检→可改写→修复后拦截）', async () => {
    const wfNum = {
      '2': { class_type: 'EmptyLatentImage', inputs: { width: '$WIDTH2$', height: 768 } }
    }
    const name = await wl.createWorkflow('wf_protect', JSON.stringify(wfNum))
    // 267 行语义：目标值当前已是占位符 → 抛「占位符不可直接修改」
    await expect(wl.updateParam(name, '2', 'width', 704)).rejects.toThrow('占位符不可直接修改')
    // 校验未被误杀：同节点普通数值参数仍可正常修改
    await wl.updateParam(name, '2', 'height', 1024)
    const saved = JSON.parse(await fs.readFile(path.join(dir, `${name}.json`), 'utf-8'))
    expect(saved['2'].inputs.height).toBe(1024)
    expect(saved['2'].inputs.width).toBe('$WIDTH2$')
  })
})
