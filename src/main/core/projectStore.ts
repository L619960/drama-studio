import * as fs from 'fs/promises'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import type { Project, Character, Shot, SceneBoard } from '../../shared/ipcTypes'
import { mergeProtectedDoneShot, reviewedIsValid } from '../../shared/pipelineGuards'
import { isPeriodGenre } from '../../shared/castAppearance'
import { atomicWriteJson } from './fsUtil'
import { createLogger } from './logger'

const log = createLogger('ProjectStore')

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
          projects.push(this.normalizeProject(JSON.parse(raw) as Project))
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
    await fs.mkdir(path.join(projectDir, 'scenes'), { recursive: true })
    await fs.mkdir(path.join(projectDir, 'shots'), { recursive: true })

    const project: Project = {
      id,
      title,
      genre,
      episode: 1,
      status: 'draft',
      characters: [],
      sceneBoards: [],
      shots: [],
      fps: 24,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    await atomicWriteJson(this.getProjectJsonPath(id), project)
    return project
  }

  async get(id: string): Promise<Project> {
    const raw = await fs.readFile(this.getProjectJsonPath(id), 'utf-8')
    const project = JSON.parse(raw) as Project
    return this.normalizeProject(project)
  }

  /** 旧项目补齐资产字段：场景库数组、角色脸图回填 */
  private normalizeProject(project: Project): Project {
    if (!project.sceneBoards) project.sceneBoards = []
    for (const c of project.characters || []) {
      if (c.refImagePath && !c.faceImagePath) c.faceImagePath = c.refImagePath
    }
    // 旧数据迁移：现代剧（非古装/武侠）在 cecd961 之前被硬加持剑条款，
    // 这些武器短语缓存在 appearanceLock/lookEn 里会导致旧项目重渲仍持剑。
    // 加载时自动清掉，幂等。古装/武侠剧保留武器描述。
    if (!isPeriodGenre(project.genre)) {
      const WEAPON_CLAUSES = [
        ', carrying one traditional chinese weapon, exactly one weapon, one hand empty',
        'carrying one traditional chinese weapon, exactly one weapon, one hand empty',
        'holding a single chinese straight jian sword, exactly one weapon, one hand empty, NO katana, NO curved japanese blade',
        ', exactly one weapon, one hand empty',
        'exactly one weapon, one hand empty',
        ', NO katana, NO curved japanese blade',
      ]
      for (const c of project.characters || []) {
        let v = c.appearanceLock
        if (!v) continue
        for (const clause of WEAPON_CLAUSES) v = v.replace(clause, '')
        v = v.replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ').trim().replace(/,\s*$/, '')
        c.appearanceLock = v
      }
    }
    for (const s of project.shots || []) {
      if (s.reviewed && !reviewedIsValid(s.type, s.reviewed, s.firstFramePath)) s.reviewed = false
    }
    return project
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
    const tail = next.catch(() => { /* 吃掉错误，保证链不断 */ })
    this.saveChains.set(id, tail)
    // 链排空后回收条目，防止项目数量增长时 Map 永久膨胀（M-16）；
    // 仅当尾部仍是本次的 tail 时才删——已有后续入队时不回收
    void tail.then(() => {
      if (this.saveChains.get(id) === tail) this.saveChains.delete(id)
    })
    return next
  }

  private async doSave(project: Project): Promise<void> {
    this.normalizeProject(project)
    // 防旧快照覆盖已完成镜头（M-x）：director 断点续跑/审批等路径可能持有一份
    // 渲染期间的旧 project 对象，其已完成镜头仍是 rendering/pending（segmentPath 为空）。
    // 若磁盘上该镜已是 done 且产物文件在盘，本次写入又把它"退化"成无产物的状态，
    // 则保留磁盘 done 版本——避免已完成镜头被重置成待渲染（重渲浪费 + 状态丢失）。
    // 用户显式重置（分镜页删除产物重渲）会同时删产物文件，此保护自动放行。
    let prev: Project | null = null
    try {
      const raw = await fs.readFile(this.getProjectJsonPath(project.id), 'utf-8')
      prev = JSON.parse(raw) as Project
    } catch {
      /* 首次落盘或文件缺失：无磁盘副本可对比 */
    }
    if (prev) {
      const prevById = new Map(prev.shots.map(s => [s.id, s]))
      let restored = 0
      for (let i = 0; i < project.shots.length; i++) {
        const cur = project.shots[i]
        const old = prevById.get(cur.id)
        if (cur.intentReset) {
          delete cur.intentReset
          continue
        }
        if (!old || old.status !== 'done' || !old.segmentPath) continue
        const degraded =
          (cur.status === 'pending' || cur.status === 'failed' || cur.status === 'rendering') &&
          !cur.segmentPath
        if (!degraded) continue
        const abs = path.resolve(this.userDataPath, '..', old.segmentPath)
        let exists = false
        try {
          exists = (await fs.stat(abs)).isFile()
        } catch { /* 文件不在盘 */ }
        if (exists) {
          project.shots[i] = mergeProtectedDoneShot(old, cur)
          restored++
        }
      }
      if (restored > 0) {
        log.warn(`已拦截 ${restored} 个已完成镜头被旧快照退化覆盖（保护性恢复为 done）`)
      }
    }
    project.updatedAt = Date.now()
    await atomicWriteJson(this.getProjectJsonPath(project.id), project)
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
    await fs.mkdir(path.join(this.getProjectDir(target.id), 'scenes'), { recursive: true })

    for (const c of source.characters) {
      const newCharId = `char_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      charIdMap.set(c.id, newCharId)

      const newFace = await this.copyAssetFile(c.faceImagePath || c.refImagePath, target.id, 'characters', `${newCharId}_face`)
      const newBody = await this.copyAssetFile(c.bodySheetPath, target.id, 'characters', `${newCharId}_body`)
      const newRef = newFace || (await this.copyAssetFile(c.refImagePath, target.id, 'characters', newCharId))

      newCharacters.push({
        id: newCharId,
        name: c.name,
        refImagePath: newRef,
        faceImagePath: newFace || undefined,
        bodySheetPath: newBody || undefined,
        description: c.description,
        voice: c.voice,
        voiceRate: c.voiceRate,
        appearanceLock: c.appearanceLock
      })
    }

    const boardIdMap = new Map<string, string>()
    const newBoards: SceneBoard[] = []
    for (const board of source.sceneBoards || []) {
      const newBoardId = `scene_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      boardIdMap.set(board.id, newBoardId)
      const plate = await this.copyAssetFile(board.emptyPlatePath, target.id, 'scenes', `${newBoardId}_plate`)
      newBoards.push({
        id: newBoardId,
        key: board.key,
        name: board.name,
        description: board.description,
        emptyPlatePath: plate
      })
    }

    const newShots: Shot[] = source.shots.map((s, i) => ({
      // —— 创作/提示词字段全量复制（D-01 整改 2026-10-20：副本保留拆镜成果，
      //    不再丢 promptEn/negativeEn/首尾帧/转场/时长/道具等，避免「有分镜、提示词全空」）——
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
      workflow: s.workflow,
      voice: s.voice,
      sceneBoardId: s.sceneBoardId ? boardIdMap.get(s.sceneBoardId) : undefined,
      shotSize: s.shotSize,
      sceneEn: s.sceneEn,
      camera: s.camera,
      transition: s.transition,
      emotion: s.emotion,
      lighting: s.lighting,
      facing: s.facing,
      continuity: s.continuity,
      props: s.props ? [...s.props] : undefined,
      promptEn: s.promptEn,
      negativeEn: s.negativeEn,
      frameSeconds: s.frameSeconds,
      firstFrameEn: s.firstFrameEn,
      midFrameEn: s.midFrameEn,
      lastFrameEn: s.lastFrameEn,
      handoffToNext: s.handoffToNext,
      transitionEn: s.transitionEn,
      // 剪辑台人工决策保留（不引用文件，语义仍有效）
      trimStart: s.trimStart,
      trimEnd: s.trimEnd,
      skipped: s.skipped,
      // —— 运行时/产物字段显式重置（防悬空资产路径 + doSave 的 done 保护误把无文件镜头复活成 done）——
      sceneImagePath: undefined,
      firstFramePath: undefined,
      lastFramePath: undefined,
      reviewed: undefined,
      consistencyScore: undefined,
      lowConsistency: undefined,
      auditFix: undefined,
      auditHint: undefined,
      renderProfile: undefined,
      audioPath: undefined,
      audioFailed: undefined,
      audioFailedReason: undefined,
      rawVideoPath: undefined,
      segmentPath: undefined,
      error: undefined,
      status: 'pending'
    }))

    target.episode = source.episode
    target.fps = source.fps
    target.characters = newCharacters
    target.sceneBoards = newBoards
    target.shots = newShots
    await this.save(target)
    return target
  }

  /** 复制项目内资产文件到目标项目子目录，返回新相对路径；失败返回空串 */
  private async copyAssetFile(
    relOrAbs: string | undefined,
    targetProjectId: string,
    subdir: string,
    basename: string
  ): Promise<string> {
    if (!relOrAbs) return ''
    const sourceAbs = path.isAbsolute(relOrAbs)
      ? relOrAbs
      : path.join(this.userDataPath, relOrAbs.replace(/^projects[\\/]/, ''))
    const ext = path.extname(sourceAbs) || '.png'
    const destFromProjects = path.join(targetProjectId, subdir, `${basename}${ext}`)
    try {
      await fs.mkdir(path.dirname(path.join(this.userDataPath, destFromProjects)), { recursive: true })
      await fs.copyFile(sourceAbs, path.join(this.userDataPath, destFromProjects))
      return `projects/${destFromProjects.replace(/\\/g, '/')}`
    } catch {
      return ''
    }
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
