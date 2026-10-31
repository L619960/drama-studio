import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { isArchiveIgnored, rewriteProjectIdPaths, uniqueProjectTitle } from '../../src/shared/projectArchive'
import { readZip } from '../../src/shared/zipArchive'
import { exportProjectPackage, importProjectPackage } from '../../src/main/core/projectArchive'

describe('shared/projectArchive 规则', () => {
  it('默认排除 director-state.json 与临时产物', () => {
    expect(isArchiveIgnored('director-state.json')).toBe(true)
    expect(isArchiveIgnored('director-state.json', { includeDirectorState: true })).toBe(false)
    expect(isArchiveIgnored('shots/shot_1/segment.mp4.part.123')).toBe(true)
    expect(isArchiveIgnored('project.json.tmp')).toBe(true)
    expect(isArchiveIgnored('final.mp4')).toBe(false)
  })

  it('重名标题依次加 -副本 后缀', () => {
    expect(uniqueProjectTitle('重生', [])).toBe('重生')
    expect(uniqueProjectTitle('重生', ['重生'])).toBe('重生-副本')
    expect(uniqueProjectTitle('重生', ['重生', '重生-副本'])).toBe('重生-副本2')
    expect(uniqueProjectTitle('   ', [])).toBe('未命名项目')
  })

  it('递归改写 project.json 内项目 id 路径（含反斜杠）', () => {
    const input = {
      id: 'p_old',
      shots: [{ firstFramePath: 'projects/p_old/shots/a.png' }],
      legacy: 'projects\\p_old\\bgm.mp3',
      other: 'projects/p_new/x.png'
    }
    const out = rewriteProjectIdPaths(input, 'p_old', 'p_new')
    expect(out.shots[0].firstFramePath).toBe('projects/p_new/shots/a.png')
    expect(out.legacy).toBe('projects\\p_new\\bgm.mp3')
    expect(out.other).toBe('projects/p_new/x.png')
    expect(out.id).toBe('p_old')
  })
})

describe('main/core/projectArchive 导出与导入', () => {
  let tmpRoot = ''
  let srcRoot = ''
  let projectDir = ''

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ds-archive-'))
    srcRoot = path.join(tmpRoot, 'src')
    projectDir = path.join(srcRoot, 'projects', 'p_src')
    await fs.mkdir(path.join(projectDir, 'shots', 'shot_1'), { recursive: true })
    await fs.mkdir(path.join(projectDir, 'characters'), { recursive: true })
    await fs.writeFile(path.join(projectDir, 'characters', 'hero.png'), 'png-bytes')
    await fs.writeFile(path.join(projectDir, 'shots', 'shot_1', 'segment.mp4'), 'video-bytes')
    await fs.writeFile(path.join(projectDir, 'shots', 'shot_1', 'segment.mp4.part.42'), 'partial')
    await fs.writeFile(path.join(projectDir, 'director-state.json'), '{"stage":"render"}')
    await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
      id: 'p_src',
      title: '重生',
      genre: '都市',
      episode: 1,
      status: 'done',
      characters: [{ id: 'char_1', name: '林晚', refImagePath: 'projects/p_src/characters/hero.png' }],
      sceneBoards: [],
      shots: [{ id: 'shot_1', index: 1, segmentPath: 'projects/p_src/shots/shot_1/segment.mp4' }],
      fps: 24,
      createdAt: 1,
      updatedAt: 1
    }))
  })

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it('导出排除临时产物与导演状态，导入分配新 id 且重名加 -副本', async () => {
    const zipPath = path.join(tmpRoot, 'pkg.dspzip')
    const exported = await exportProjectPackage({ projectDir, targetPath: zipPath })
    expect(exported.files).toBe(3) // project.json + hero.png + segment.mp4（director-state 与 .part 已排除）
    const entries = readZip(await fs.readFile(zipPath))
    const names = entries.map(e => e.path).sort()
    expect(names).toEqual(['characters/hero.png', 'project.json', 'shots/shot_1/segment.mp4'].sort())
    expect(names).not.toContain('director-state.json')
    expect(names.some(n => n.includes('.part.'))).toBe(false)

    const destRoot = path.join(tmpRoot, 'dest')
    const { project } = await importProjectPackage({
      dataRoot: destRoot,
      zipBuffer: await fs.readFile(zipPath),
      existingTitles: ['重生']
    })
    expect(project.id).not.toBe('p_src')
    expect(project.title).toBe('重生-副本')
    expect(project.characters[0].refImagePath).toBe(`projects/${project.id}/characters/hero.png`)
    expect(project.shots[0].segmentPath).toBe(`projects/${project.id}/shots/shot_1/segment.mp4`)

    const destDir = path.join(destRoot, 'projects', project.id)
    expect(await fs.readFile(path.join(destDir, 'characters', 'hero.png'), 'utf8')).toBe('png-bytes')
    expect(await fs.readFile(path.join(destDir, 'shots', 'shot_1', 'segment.mp4'), 'utf8')).toBe('video-bytes')
    expect(await fs.readFile(path.join(destDir, 'project.json'), 'utf8')).toContain(project.id)
  })

  it('显式 includeDirectorState 时打包导演状态', async () => {
    const zipPath = path.join(tmpRoot, 'pkg-with-state.dspzip')
    await exportProjectPackage({ projectDir, targetPath: zipPath, includeDirectorState: true })
    const names = readZip(await fs.readFile(zipPath)).map(e => e.path)
    expect(names).toContain('director-state.json')
  })

  it('缺少 project.json 的项目包拒绝导入', async () => {
    const destRoot = path.join(tmpRoot, 'dest2')
    await expect(importProjectPackage({
      dataRoot: destRoot,
      zipBuffer: Buffer.from('not a zip'),
      existingTitles: []
    })).rejects.toThrow('不是有效的项目包')
  })
})
