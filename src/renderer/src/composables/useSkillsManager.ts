import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { confirmDanger } from '../utils/confirm'
import type { Skill } from '../../../shared/ipcTypes'

/**
 * 技能管理：列表 + 编辑弹窗状态 + 增删改查。
 * 弹窗 UI 状态（visible/name/description/promptTemplate）由 composable 持有，
 * SkillsPanel 子组件双向绑定。
 */
export function useSkillsManager() {
  const skills = ref<Skill[]>([])
  const editingSkill = ref<Skill | null>(null)
  const skillSaving = ref(false)
  const skillDialog = reactive({ visible: false, name: '', description: '', promptTemplate: '' })

  async function loadSkills(): Promise<void> {
    try {
      if (!window.api.skills) {
        console.error('[loadSkills] window.api.skills is undefined')
        return
      }
      skills.value = await window.api.skills.list()
    } catch (e) {
      console.error('[loadSkills] failed:', e)
      ElMessage.error(`加载技能失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function toggleSkill(s: Skill, enabled: boolean): Promise<void> {
    try {
      await window.api.skills.toggle(s.id, enabled)
      s.enabled = enabled
    } catch (e) {
      ElMessage.error(`切换失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function openSkillDialog(s?: Skill): void {
    editingSkill.value = s || null
    skillDialog.visible = true
    skillDialog.name = s?.name || ''
    skillDialog.description = s?.description || ''
    skillDialog.promptTemplate = s?.promptTemplate || ''
  }

  function closeSkillDialog(): void {
    skillDialog.visible = false
  }

  async function saveSkill(): Promise<void> {
    if (!skillDialog.name.trim()) { ElMessage.warning('请填写技能名称'); return }
    if (!skillDialog.description.trim()) { ElMessage.warning('请填写能力说明'); return }
    if (!skillDialog.promptTemplate.trim()) { ElMessage.warning('请填写提示词模板'); return }
    skillSaving.value = true
    try {
      if (editingSkill.value) {
        await window.api.skills.update(editingSkill.value.id, {
          name: skillDialog.name.trim(),
          description: skillDialog.description.trim(),
          promptTemplate: skillDialog.promptTemplate.trim()
        })
      } else {
        await window.api.skills.create({
          name: skillDialog.name.trim(),
          description: skillDialog.description.trim(),
          promptTemplate: skillDialog.promptTemplate.trim()
        })
      }
      skillDialog.visible = false
      ElMessage.success('技能已保存')
      await loadSkills()
    } catch (e) {
      ElMessage.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      skillSaving.value = false
    }
  }

  async function removeSkill(s: Skill): Promise<void> {
    const ok = await confirmDanger(`确定删除技能「${s.name}」吗？`, {
      title: '删除技能', confirmText: '删除'
    })
    if (!ok) return
    try {
      await window.api.skills.remove(s.id)
      await loadSkills()
      ElMessage.success('已删除')
    } catch (e) {
      ElMessage.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return {
    skills, editingSkill, skillSaving, skillDialog,
    loadSkills, toggleSkill, openSkillDialog, closeSkillDialog, saveSkill, removeSkill
  }
}
