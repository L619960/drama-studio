import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { MemoryItem, MemoryKind } from '../../../shared/ipcTypes'

export const MEMORY_KIND_OPTIONS = [
  { value: 'preference', label: '用户偏好' },
  { value: 'rule', label: '制作规则' },
  { value: 'lesson', label: '经验教训' }
] as const

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
  function memoryCountOf(kind: MemoryKind): number {
    return memories.value.filter(m => m.kind === kind).length
  }
  function formatDateTime(ts: number): string {
    const d = new Date(ts)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  async function loadMemories(): Promise<void> {
    memories.value = await window.api.memory.list()
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
    try {
      await ElMessageBox.confirm(`确定删除记忆「${m.title}」吗？`, '删除记忆', {
        type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消'
      })
    } catch { return }
    await window.api.memory.remove(m.id)
    await loadMemories()
    ElMessage.success('已删除')
  }

  return {
    memories, memoryKind, memoryKindOptions: MEMORY_KIND_OPTIONS,
    filteredMemories, memoryCountOf, formatDateTime,
    editingMemory, memorySaving, memoryDialog,
    loadMemories, openMemoryDialog, closeMemoryDialog, saveMemory, removeMemory
  }
}
