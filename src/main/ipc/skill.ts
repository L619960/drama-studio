import { IpcChannels, type Skill, type MemoryItem, type MemoryKind } from '../../shared/ipcTypes'
import { handleIpc } from './shared'
import type { SkillService } from '../core/skillService'
import type { MemoryStore } from '../core/memoryStore'

export interface SkillIpcCtx {
  skillService: SkillService
  memoryStore: MemoryStore
}

export function registerSkillIpc(ctx: SkillIpcCtx): void {
  // 导演技能
  handleIpc(IpcChannels.skillList, () => ctx.skillService.list())
  handleIpc(IpcChannels.skillCreate, (_, input: { name: string; description: string; promptTemplate: string }) =>
    ctx.skillService.create(input)
  )
  handleIpc(IpcChannels.skillUpdate, (_, id: string, patch: Partial<Pick<Skill, 'name' | 'description' | 'enabled' | 'promptTemplate'>>) =>
    ctx.skillService.update(id, patch)
  )
  handleIpc(IpcChannels.skillDelete, (_, id: string) => ctx.skillService.remove(id))

  // 导演记忆库
  handleIpc(IpcChannels.memoryList, (_, kind?: MemoryKind) => ctx.memoryStore.list(kind))
  handleIpc(IpcChannels.memoryCreate, (_, input: { kind: MemoryKind; title: string; content: string }) =>
    ctx.memoryStore.create(input)
  )
  handleIpc(IpcChannels.memoryUpdate, (_, id: string, patch: Partial<Pick<MemoryItem, 'title' | 'content' | 'kind'>>) =>
    ctx.memoryStore.update(id, patch)
  )
  handleIpc(IpcChannels.memoryDelete, (_, id: string) => ctx.memoryStore.remove(id))
}
