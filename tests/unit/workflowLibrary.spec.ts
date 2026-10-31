import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { WorkflowLibrary } from '../../src/main/core/workflowLibrary'

/**
 * P2 路径穿越探针（可重复执行）：
 * 临时 libDir 内放 sub/ok.json（合法），libDir 外放 decoy.json（诱饵）。
 * 断言 ../、..\ 与跨盘符/绝对路径都被中文越界错误拒绝，库内正常文件不被误杀。
 */
describe('WorkflowLibrary.convertToApi 路径穿越防护', () => {
  let sandbox: string
  let libDir: string
  let lib: WorkflowLibrary

  beforeAll(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-lib-'))
    libDir = path.join(sandbox, 'lib')
    await fs.mkdir(path.join(libDir, 'sub'), { recursive: true })
    // 库外诱饵：与 libDir 同级的 decoy.json
    await fs.writeFile(path.join(sandbox, 'decoy.json'), JSON.stringify({ secret: 'outside' }), 'utf-8')
    // 库内合法文件（API 格式：数字键、无 nodes，转换会直通返回）
    await fs.writeFile(path.join(libDir, 'sub', 'ok.json'), JSON.stringify({
      '1': { class_type: 'KSampler', inputs: { seed: 1 } }
    }), 'utf-8')
    lib = new WorkflowLibrary(libDir)
  })

  afterAll(async () => {
    await fs.rm(sandbox, { recursive: true, force: true })
  })

  it('../ 穿越读取库外 decoy.json → 抛中文越界错误', () => {
    expect(() => lib.convertToApi('../decoy.json', {})).toThrow('工作流库路径越界：仅允许读取库目录内的文件')
  })

  it('反斜杠 ..\\decoy.json 穿越 → 抛同样错误', () => {
    expect(() => lib.convertToApi('..\\decoy.json', {})).toThrow('工作流库路径越界：仅允许读取库目录内的文件')
  })

  it('库内 sub/ok.json 正常返回，不被误杀', () => {
    const r = lib.convertToApi('sub/ok.json', {})
    expect(r.nodeCount).toBe(1)
    expect((r.graph['1'] as { class_type: string }).class_type).toBe('KSampler')
  })

  it('同盘绝对路径指向库外 decoy.json → 拒绝', () => {
    const absDecoy = path.join(sandbox, 'decoy.json')
    expect(() => lib.convertToApi(absDecoy, {})).toThrow('工作流库路径越界')
  })

  it('库外绝对路径（不存在）→ 在 readFileSync 前即被越界校验拒绝', () => {
    // 用平台无关的绝对路径：Windows 盘符路径在 POSIX 上不是绝对路径，会走到 readFile 的 ENOENT
    const outsideAbs = path.join(sandbox, '..', 'outside-workflow.json')
    expect(() => lib.convertToApi(outsideAbs, {})).toThrow('工作流库路径越界')
  })

  it.skipIf(process.platform !== 'win32')(
    '跨盘符绝对路径（Z:\\fake\\outside.json，文件不存在）→ 在 readFileSync 前即被越界校验拒绝',
    () => {
      expect(() => lib.convertToApi('Z:\\fake\\outside.json', {})).toThrow('工作流库路径越界')
    }
  )
})
