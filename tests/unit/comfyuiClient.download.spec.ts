/**
 * CORE-02 回归：ComfyUI 产物 0 字节必须判失败且清理，不得让空文件进入后续合成。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ComfyUIClient } from '../../src/main/core/comfyuiClient'

let dir: string
let client: ComfyUIClient

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-comfy-dl-'))
  client = new ComfyUIClient({ baseUrl: 'http://127.0.0.1:18188', clientId: 'test-client' })
})

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('ComfyUIClient.downloadFromFullPath', () => {
  it('源文件为 0 字节 → 抛错并删除已写入的目标文件', async () => {
    const src = path.join(dir, 'empty.mp4')
    const dest = path.join(dir, 'out-empty.mp4')
    await fs.writeFile(src, '')
    await expect(client.downloadFromFullPath(src, dest)).rejects.toThrow(/为空/)
    await expect(fs.stat(dest)).rejects.toThrow()
  })

  it('源文件不存在 → 直接抛错', async () => {
    await expect(
      client.downloadFromFullPath(path.join(dir, 'missing.mp4'), path.join(dir, 'out-missing.mp4')),
    ).rejects.toThrow()
  })

  it('正常文件 → 复制成功且内容一致', async () => {
    const src = path.join(dir, 'ok.mp4')
    const dest = path.join(dir, 'out-ok.mp4')
    await fs.writeFile(src, 'video-bytes')
    await client.downloadFromFullPath(src, dest)
    expect(await fs.readFile(dest, 'utf-8')).toBe('video-bytes')
  })
})
