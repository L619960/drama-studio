/**
 * SEC-03 / SEC-11 单测：ComfyUI 一键启动命令白名单 + 停止候选归属判定。
 * 仅覆盖导出的纯函数（不起 Electron、不 spawn、不调用 PowerShell）：
 * - validateStartCommand：解释器白名单、main.py 约束、目录归属、控制字符
 * - resolveComfyRoots：inputDir/modelsDir 推导 + 未配置时的整合包退化
 * - commandLineOwnsPort / commandLineIsComfyMain / parseStopCandidates：误杀防护
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  validateStartCommand,
  resolveComfyRoots,
  commandLineOwnsPort,
  commandLineIsComfyMain,
  parseStopCandidates,
} from '../../src/main/core/comfyuiClient'

describe('SEC-03 validateStartCommand', () => {
  let root: string
  let pyDir: string
  let pyExe: string
  let script: string
  let inputDir: string

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-comfy-sec-'))
    pyDir = path.join(root, 'python')
    await fs.mkdir(pyDir, { recursive: true })
    pyExe = path.join(pyDir, 'python.exe')
    await fs.writeFile(pyExe, 'stub')
    script = path.join(root, 'ComfyUI', 'main.py')
    await fs.mkdir(path.dirname(script), { recursive: true })
    await fs.writeFile(script, '# stub')
    inputDir = path.join(root, 'ComfyUI', 'input')
    await fs.mkdir(inputDir, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  const okCmd = (): string => `"${pyExe}" "${script}" --listen 127.0.0.1 --port 8188`
  const roots = (): string[] => [path.dirname(inputDir)]

  it('合法命令：python.exe + 安装目录内 main.py → 通过并返回 exe/args/script', async () => {
    const r = await validateStartCommand(okCmd(), roots())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.exe).toBe(pyExe)
    expect(r.script).toBe(script)
    expect(r.args).toEqual([script, '--listen', '127.0.0.1', '--port', '8188'])
  })

  it('拒绝非 Python 解释器（cmd.exe / powershell / wscript / curl）', async () => {
    for (const exe of [
      'C:\\Windows\\System32\\cmd.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Windows\\System32\\wscript.exe',
      'C:\\Windows\\System32\\curl.exe',
    ]) {
      const r = await validateStartCommand(`"${exe}" "${script}"`, roots())
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/Python 解释器/)
    }
  })

  it('拒绝 python -c / -m 等任意代码执行参数', async () => {
    for (const flag of ['-c', '-m']) {
      const r = await validateStartCommand(`"${pyExe}" ${flag} "import os; os.system('calc')"`, roots())
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/不允许的参数/)
    }
  })

  it('必须显式执行 main.py（缺脚本参数直接拒绝）', async () => {
    const r = await validateStartCommand(`"${pyExe}" --port 8188`, roots())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/main\.py/)
  })

  it('main.py 不在已配置 ComfyUI 目录内 → 拒绝', async () => {
    const outside = path.join(os.tmpdir(), 'drama-outside-main.py')
    await fs.writeFile(outside, '# outside')
    const r = await validateStartCommand(`"${pyExe}" "${outside}"`, roots())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/不在已配置的 ComfyUI 目录内/)
    await fs.rm(outside, { force: true })
  })

  it('启动程序/脚本不存在或不是文件 → 拒绝', async () => {
    const missingExe = await validateStartCommand(`"${path.join(root, 'nope', 'python.exe')}" "${script}"`, roots())
    expect(missingExe.ok).toBe(false)
    if (!missingExe.ok) expect(missingExe.error).toMatch(/启动程序不存在/)

    const missingScript = await validateStartCommand(`"${pyExe}" "${path.join(root, 'nope', 'main.py')}"`, roots())
    expect(missingScript.ok).toBe(false)
    if (!missingScript.ok) expect(missingScript.error).toMatch(/入口脚本不存在/)
  })

  it('控制字符 / 空命令 / 无路径裸命令 → 拒绝', async () => {
    const withNewline = await validateStartCommand(`"${pyExe}"\n"${script}"`, roots())
    expect(withNewline.ok).toBe(false)
    if (!withNewline.ok) expect(withNewline.error).toMatch(/控制字符/)

    expect((await validateStartCommand('', roots())).ok).toBe(false)
    const bare = await validateStartCommand('python main.py', roots())
    expect(bare.ok).toBe(false)
    if (!bare.ok) expect(bare.error).toMatch(/启动程序不存在或未配置/)
  })

  it('未配置 inputDir/modelsDir 时按整合包目录退化校验（<root>/python/python.exe + <root>/ComfyUI/main.py 通过）', async () => {
    const fallback = resolveComfyRoots({}, pyExe)
    expect(fallback).toEqual([pyDir, root])
    const r = await validateStartCommand(okCmd(), fallback)
    expect(r.ok).toBe(true)

    // 目录外的脚本仍被拒
    const outsideScript = path.join(os.tmpdir(), 'drama-elsewhere', 'main.py')
    await fs.mkdir(path.dirname(outsideScript), { recursive: true })
    await fs.writeFile(outsideScript, '# elsewhere')
    const bad = await validateStartCommand(`"${pyExe}" "${outsideScript}"`, fallback)
    expect(bad.ok).toBe(false)
    await fs.rm(path.dirname(outsideScript), { recursive: true, force: true })
  })
})

describe('SEC-03 resolveComfyRoots', () => {
  it('优先 inputDir/modelsDir 的上一级', () => {
    const r = resolveComfyRoots(
      { inputDir: '/x/ComfyUI/input', modelsDir: '/x/ComfyUI/models' },
      '/x/python/python.exe',
    )
    expect(r).toEqual([path.dirname('/x/ComfyUI/input'), path.dirname('/x/ComfyUI/models')])
  })

  it('两者未配置 → exe 目录与其上一级', () => {
    const exe = path.join('/x', 'python', 'python.exe')
    const r = resolveComfyRoots({}, exe)
    expect(r).toEqual([path.dirname(exe), path.dirname(path.dirname(exe))])
  })
})

describe('SEC-11 停止候选归属', () => {
  it('commandLineOwnsPort：显式端口精确匹配，默认 8188 才按无端口归属', () => {
    expect(commandLineOwnsPort('python main.py --port 8188', 8188)).toBe(true)
    expect(commandLineOwnsPort('python main.py --port=8188', 8188)).toBe(true)
    // 词边界：--port 81880 不属于 8188
    expect(commandLineOwnsPort('python main.py --port 81880', 8188)).toBe(false)
    expect(commandLineOwnsPort('python main.py', 8188)).toBe(true)
    expect(commandLineOwnsPort('python main.py', 8199)).toBe(false)
  })

  it('commandLineIsComfyMain：含 main.py 才算 ComfyUI 主进程', () => {
    expect(commandLineIsComfyMain('python.exe "D:\\ComfyUI\\main.py" --port 8188')).toBe(true)
    expect(commandLineIsComfyMain('python.exe script.py')).toBe(false)
  })

  it('parseStopCandidates：解析 pid::commandLine，跳过畸形行', () => {
    const out = [
      '1234::python.exe "D:\\ai\\ComfyUI\\main.py" --port 8188',
      'not-a-pid::python.exe main.py',
      '5678::python.exe main.py --port 8199',
      '',
      'no separator line',
    ].join('\r\n')
    const list = parseStopCandidates(out)
    expect(list).toHaveLength(2)
    expect(list[0]).toEqual({ pid: 1234, commandLine: 'python.exe "D:\\ai\\ComfyUI\\main.py" --port 8188' })
    expect(list[1]?.pid).toBe(5678)
  })

  it('停止候选过滤：只保留 main.py + 端口归属命中的进程', () => {
    const lines = parseStopCandidates(
      [
        '1234::python.exe main.py --port 8188',
        '2222::python.exe other.py --port 8188',
        '3333::python.exe main.py --port 81880',
        '4444::python.exe main.py',
      ].join('\n'),
    )
    const pids = lines
      .filter((p) => commandLineIsComfyMain(p.commandLine) && commandLineOwnsPort(p.commandLine, 8188))
      .map((p) => p.pid)
    expect(pids).toEqual([1234, 4444])
  })
})
