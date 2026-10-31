/**
 * SEC-02 回归：file:delete 白名单。
 * 仅允许删除项目渲染产物（audio/raw/segments/frames/shots 下的文件与成片/缩略图/字幕），
 * 拒绝 project.json、用户资产（characters/props/scenes）、目录与数据根之外路径。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as nodeFs from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const state = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || '/tmp'
  return {
    dir: `${base}/drama-sec02-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    handlers: new Map<string, (...a: unknown[]) => unknown>(),
  }
})

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? state.dir : '') },
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => {
      state.handlers.set(channel, fn)
    },
  },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined, openPath: async () => '' },
}))

import { IpcChannels } from '../../src/shared/ipcTypes'
import { DATA_ROOT } from '../../src/main/ipc/shared'
import { registerFileShellIpc } from '../../src/main/ipc/fileShell'

const call = (channel: string, ...args: unknown[]): unknown => {
  const fn = state.handlers.get(channel)
  if (!fn) throw new Error(`未注册通道 ${channel}`)
  return fn({}, ...args)
}

const PID = 'p_1761800000000_ab12'
const projectsDir = path.join(DATA_ROOT, 'projects')

beforeEach(async () => {
  state.handlers.clear()
  registerFileShellIpc({
    ffmpegService: { fileExists: async () => false, getFileSize: async () => 0 } as never,
    settingsStore: { get: async () => ({ comfyui: {} }) } as never,
  })
  await fs.rm(projectsDir, { recursive: true, force: true })
  await fs.mkdir(path.join(projectsDir, PID, 'audio'), { recursive: true })
  await fs.mkdir(path.join(projectsDir, PID, 'raw'), { recursive: true })
  await fs.mkdir(path.join(projectsDir, PID, 'characters'), { recursive: true })
  await fs.writeFile(path.join(projectsDir, PID, 'project.json'), '{"id":"x"}', 'utf-8')
  await fs.writeFile(path.join(projectsDir, PID, 'audio', 'shot_1.mp3'), 'audio', 'utf-8')
  await fs.writeFile(path.join(projectsDir, PID, 'raw', 'shot_1.mp4'), 'video', 'utf-8')
  await fs.writeFile(path.join(projectsDir, PID, 'characters', 'char_1_face.png'), 'img', 'utf-8')
  await fs.writeFile(path.join(projectsDir, PID, 'final.mp4'), 'final', 'utf-8')
})

afterAll(() => {
  nodeFs.rmSync(state.dir, { recursive: true, force: true })
})

describe('file:delete 白名单（SEC-02）', () => {
  it.each([
    ['项目元数据', `projects/${PID}/project.json`],
    ['角色定妆图（用户资产）', `projects/${PID}/characters/char_1_face.png`],
    ['项目根目录', `projects/${PID}`],
    ['产物子目录（目录不可删）', `projects/${PID}/audio`],
    ['空路径（数据根）', ''],
    ['路径穿越', '../../outside.txt'],
    ['非项目路径', 'preview/x.png'],
  ])('拒绝删除：%s', async (_label, rel) => {
    await expect(call(IpcChannels.fileDelete, rel) as Promise<unknown>).rejects.toThrow(
      /仅允许删除|不属于可清理|数据根目录之外/,
    )
    expect(nodeFs.existsSync(path.join(projectsDir, PID, 'project.json'))).toBe(true)
  })

  it('允许删除音频产物', async () => {
    await call(IpcChannels.fileDelete, `projects/${PID}/audio/shot_1.mp3`)
    expect(nodeFs.existsSync(path.join(projectsDir, PID, 'audio', 'shot_1.mp3'))).toBe(false)
  })

  it('允许删除原片与成片', async () => {
    await call(IpcChannels.fileDelete, `projects/${PID}/raw/shot_1.mp4`)
    await call(IpcChannels.fileDelete, `projects/${PID}/final.mp4`)
    expect(nodeFs.existsSync(path.join(projectsDir, PID, 'raw', 'shot_1.mp4'))).toBe(false)
    expect(nodeFs.existsSync(path.join(projectsDir, PID, 'final.mp4'))).toBe(false)
  })

  it('目标已不存在时幂等返回，不抛错', async () => {
    await expect(
      call(IpcChannels.fileDelete, `projects/${PID}/segments/shot_9.mp4`) as Promise<unknown>,
    ).resolves.toBeUndefined()
  })

  it('绝对路径形式的产物仍受同一白名单约束', async () => {
    const abs = path.join(projectsDir, PID, 'audio', 'shot_1.mp3')
    await call(IpcChannels.fileDelete, abs)
    expect(nodeFs.existsSync(abs)).toBe(false)
  })
})
