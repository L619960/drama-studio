// ===== 导演记忆库（跨项目持久化）=====
/** preference=用户偏好；rule=拆镜/制作规则；lesson=经验教训 */
export type MemoryKind = 'preference' | 'rule' | 'lesson'

export interface MemoryItem {
  id: string
  kind: MemoryKind
  title: string
  content: string
  createdAt: number
  updatedAt: number
}

