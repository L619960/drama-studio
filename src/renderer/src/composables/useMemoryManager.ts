import { computed, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { confirmDanger } from '../utils/confirm'
import type { MemoryItem, MemoryKind } from '../../../shared/ipcTypes'

export const MEMORY_KIND_OPTIONS = [
  { value: 'preference', label: '用户偏好' },
  { value: 'rule', label: '制作规则' },
  { value: 'lesson', label: '经验教训' }
] as const

// ===== 纯工具函数（R-13：唯一实现，MemoryPanel 直接 import，不再各自复制）=====

export function memoryCountOf(list: MemoryItem[], kind: MemoryKind): number {
  return list.filter(m => m.kind === kind).length
}
export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 导演记忆库：跨项目长期记忆的 CRUD + tabs 切换 + 编辑弹窗状态。
 */
export function useMemoryManager() {
  const memories = ref<MemoryItem[]>([])
  const memoryKind = ref<MemoryKind>('preference')
  const editingMemory = ref<MemoryItem | null>(null)
  const memorySaving = ref(false)
  const memoryDialog = reactive({
    visible: false,
    kind: 'preference' as MemoryKind,
    title: '',
    content: ''
  })

  const filteredMemories = computed(() => memories.value.filter(m => m.kind === memoryKind.value))

  async function loadMemories(): Promise<void> {
    // 必须自兜底：onMounted 的 Promise.all 中若此处 reject，
    // 后续 subscribe/subscribeChat/runSelfcheck 全部不执行，控制台呈"死"状态
    try {
      memories.value = await window.api.memory.list()
    } catch (e) {
      ElMessage.error(`记忆加载失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function openMemoryDialog(m?: MemoryItem): void {
    editingMemory.value = m || null
    memoryDialog.visible = true
    memoryDialog.kind = m?.kind || memoryKind.value
    memoryDialog.title = m?.title || ''
    memoryDialog.content = m?.content || ''
  }

  function closeMemoryDialog(): void {
    memoryDialog.visible = false
  }

  async function saveMemory(): Promise<void> {
    if (!memoryDialog.title.trim()) { ElMessage.warning('请填写标题'); return }
    if (!memoryDialog.content.trim()) { ElMessage.warning('请填写内容'); return }
    memorySaving.value = true
    try {
      if (editingMemory.value) {
        await window.api.memory.update(editingMemory.value.id, {
          kind: memoryDialog.kind,
          title: memoryDialog.title.trim(),
          content: memoryDialog.content.trim()
        })
      } else {
        await window.api.memory.create({
          kind: memoryDialog.kind,
          title: memoryDialog.title.trim(),
          content: memoryDialog.content.trim()
        })
      }
      memoryDialog.visible = false
      ElMessage.success('记忆已保存')
      await loadMemories()
    } catch (e) {
      ElMessage.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      memorySaving.value = false
    }
  }

  async function removeMemory(m: MemoryItem): Promise<void> {
    const ok = await confirmDanger(`确定删除记忆「${m.title}」吗？`, {
      title: '删除记忆', confirmText: '删除'
    })
    if (!ok) return
    try {
      await window.api.memory.remove(m.id)
      await loadMemories()
      ElMessage.success('已删除')
    } catch (e) {
      ElMessage.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return {
    memories, memoryKind, memoryKindOptions: MEMORY_KIND_OPTIONS,
    filteredMemories,
    editingMemory, memorySaving, memoryDialog,
    loadMemories, openMemoryDialog, closeMemoryDialog, saveMemory, removeMemory
  }
}
