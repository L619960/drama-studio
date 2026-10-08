import * as fs from 'fs/promises'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import type { Project, Character, Shot } from '../../shared/ipcTypes'

// 延迟获取 electron：在 Electron 主进程内为真实对象；在纯 Node（测试）下
// require('electron') 返回可执行路径字符串，解构得到 undefined 而不抛错。
// 避免在模块顶层硬依赖 electron，使核心逻辑可脱离 Electron 独立测试。
const nodeRequire = createRequire(import.meta.url)
function loadElectron(): { app?: Electron.App; dialog?: Electron.Dialog } {
  return nodeRequire('electron')
}

export class ProjectStore {
  private userDataPath: string
  /** 每项目一条写链：串行化 save，避免并发写互相覆盖/交错 */
  private saveChains = new Map<string, Promise<unknown>>()

  constructor(dataPath?: string) {
    if (dataPath) {
      this.userDataPath = dataPath
    } else {
      const { app } = loadElectron()
      this.userDataPath = path.join(app!.getPath('userData'), 'drama-studio', 'projects')
    }
  }

  private getProjectDir(id: string): string {
    return path.join(this.userDataPath, id)
  }

  private getProjectJsonPath(id: string): string {
    return path.join(this.getProjectDir(id), 'project.json')
  }

  async list(): Promise<Project[]> {
    try {
      await fs.mkdir(this.userDataPath, { recursive: true })
      const dirs = await fs.readdir(this.userDataPath, { withFileTypes: true })
      const projects: Project[] = []

      for (const dir of dirs) {
        if (!dir.isDirectory()) continue
        try {
          const jsonPath = path.join(this.userDataPath, dir.name, 'project.json')
          const raw = await fs.readFile(jsonPath, 'utf-8')
          projects.push(JSON.parse(raw))
        } catch {
          // 跳过无效目录
        }
      }

      return projects.sort((a, b) => b.createdAt - a.createdAt)
    } catch {
      return []
    }
  }

  async create(title: string, genre: string): Promise<Project> {
    const id = `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const projectDir = this.getProjectDir(id)
    await fs.mkdir(projectDir, { recursive: true })
    await fs.mkdir(path.join(projectDir, 'characters'), { recursive: true })
    await fs.mkdir(path.join(projectDir, 'shots'), { recursive: true })

    const project: Project = {
      id,
      title,
      genre,
      episode: 1,
      status: 'draft',
      characters: [],
      shots: [],
      fps: 24,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    await fs.writeFile(this.getProjectJsonPath(id), JSON.stringify(project, null, 2))
    return project
  }

  async get(id: string): Promise<Project> {
    const raw = await fs.readFile(this.getProjectJsonPath(id), 'utf-8')
    return JSON.parse(raw)
  }

  async save(project: Project): Promise<void> {
    return this.enqueue(project.id, () => this.doSave(project))
  }

  /**
   * 读-改-写一体化（串行）：解决「渲染中用户在分镜页改台词被队列回写冲掉」类竞态。
   * mutator 拿到的是磁盘上的最新数据，修改后落盘。
   */
  async update(id: string, mutator: (draft: Project) => void | Promise<void>): Promise<Project> {
    return this.enqueue(id, async () => {
      const draft = await this.get(id)
      await mutator(draft)
      await this.doSave(draft)
      return draft
    })
  }

  private enqueue<T>(id: string, job: () => Promise<T>): Promise<T> {
    const prev = this.saveChains.get(id) ?? Promise.resolve()
    const next = prev.then(job)
    this.saveChains.set(id, next.catch(() => { /* 吃掉错误，保证链不断 */ }))
    return next
  }

  private async doSave(project: Project): Promise<void> {
    project.updatedAt = Date.now()
    const target = this.getProjectJsonPath(project.id)
    const tmp = `${target}.tmp`
    // 原子写入：先写临时文件，再重命名，避免崩溃导致 project.json 损坏
    await fs.writeFile(tmp, JSON.stringify(project, null, 2))
    await fs.rename(tmp, target)
  }

  async delete(id: string): Promise<void> {
    const dir = this.getProjectDir(id)
    await fs.rm(dir, { recursive: true, force: true })
  }

  async importCharacterImage(projectId: string): Promise<string> {
    const { dialog } = loadElectron()
    const result = await dialog!.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })

    if (result.canceled || result.filePaths.length === 0) {
      throw new Error('User cancelled')
    }

    const sourcePath = result.filePaths[0]
    const ext = path.extname(sourcePath)
    const charId = `char_${Date.now()}`
    const fileRelFromProjects = path.join(projectId, 'characters', `${charId}${ext}`)

    await fs.copyFile(sourcePath, path.join(this.userDataPath, fileRelFromProjects))
    // 统一返回相对 DATA_ROOT 的相对路径
    return `projects/${fileRelFromProjects.replace(/\\/g, '/')}`
  }

  /**
   * 深复制项目：
   * - 角色重新生成 id，定妆图文件复制到新项目目录并重写路径
   * - 分镜重新生成 id，characterIds 同步重映射
   * - 不复制任何渲染产物（音频/原片/分段），副本状态为 draft，需重新渲染
   */
  async duplicate(sourceId: string): Promise<Project> {
    const source = await this.get(sourceId)
    const target = await this.create(`${source.title} (副本)`, source.genre)

    const charIdMap = new Map<string, string>()
    const newCharacters: Character[] = []

    for (const c of source.characters) {
      const newCharId = `char_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      charIdMap.set(c.id, newCharId)

      let newRefImagePath = ''
      if (c.refImagePath) {
        // 兼容旧数据（绝对路径）与新规范（projects/<sid>/... → 相对 projects 目录为 <sid>/...）
        const sourceAbs = path.isAbsolute(c.refImagePath)
          ? c.refImagePath
          : path.join(this.userDataPath, c.refImagePath.replace(/^projects[\\/]/, ''))
        const ext = path.extname(sourceAbs) || '.png'
        const destFromProjects = path.join(target.id, 'characters', `${newCharId}${ext}`)
        try {
          await fs.copyFile(sourceAbs, path.join(this.userDataPath, destFromProjects))
          newRefImagePath = `projects/${destFromProjects.replace(/\\/g, '/')}`
        } catch {
          // 源定妆图缺失：副本保留空图，不阻断复制
        }
      }

      newCharacters.push({
        id: newCharId,
        name: c.name,
        refImagePath: newRefImagePath,
        description: c.description,
        voice: c.voice,
        voiceRate: c.voiceRate
      })
    }

    const newShots: Shot[] = source.shots.map((s, i) => ({
      id: `shot_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
      index: i + 1,
      scene: s.scene,
      action: s.action,
      dialogue: s.dialogue,
      characterIds: s.characterIds
        .map(cid => charIdMap.get(cid))
        .filter((v): v is string => Boolean(v)),
      type: s.type,
      width: s.width,
      height: s.height,
      frames: s.frames,
      seed: s.seed,
      status: 'pending'
    }))

    target.episode = source.episode
    target.fps = source.fps
    target.characters = newCharacters
    target.shots = newShots
    await this.save(target)
    return target
  }

  async getShotDir(projectId: string, shotId: string): Promise<string> {
    const dir = path.join(this.getProjectDir(projectId), 'shots', shotId)
    await fs.mkdir(dir, { recursive: true })
    return dir
  }

  /** 导入项目级 BGM，复制到项目目录并返回相对路径 */
  async importBgm(projectId: string): Promise<string> {
    const { dialog } = loadElectron()
    const result = await dialog!.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '音频', extensions: ['mp3', 'wav', 'aac', 'ogg', 'm4a'] }]
    })
    if (result.canceled || result.filePaths.length === 0) {
      throw new Error('User cancelled')
    }
    const sourcePath = result.filePaths[0]
    const ext = path.extname(sourcePath) || '.mp3'
    const relFromProjects = path.join(projectId, `bgm${ext}`)
    await fs.copyFile(sourcePath, path.join(this.userDataPath, relFromProjects))
    return `projects/${relFromProjects.replace(/\\/g, '/')}`
  }
}
