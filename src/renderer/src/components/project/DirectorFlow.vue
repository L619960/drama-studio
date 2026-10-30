<template>
  <!-- AI 导演开拍对话框：复用统一开拍表单（含 gateStages 确认点）。
       进度展示已由 REQ-05 的全局 DirectorRunBar + 控制台 WorkflowPanel 承接，
       此处的旧进度弹窗模板与订阅已删除（RC-05）。 -->
  <el-dialog
    :model-value="dialog.visible"
    @update:model-value="onDialogVisible"
    title="AI 导演 · 一键成片"
    width="720px"
    top="6vh"
    :close-on-click-modal="false"
    class="director-start-dialog"
  >
    <DirectorStartForm
      :open="dialog.visible"
      :starting="starting"
      @cancel="dialog.visible = false"
      @submit="onSubmit"
    />
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { Project, DirectorStartInput } from '../../../../shared/ipcTypes'
import DirectorStartForm from './DirectorStartForm.vue'

defineProps<{ projects: Project[] }>()
const emit = defineEmits<{ started: [] }>()

const router = useRouter()
const dialog = ref({ visible: false })
const starting = ref(false)

function open(): void {
  dialog.value.visible = true
}

function onDialogVisible(v: boolean): void {
  dialog.value.visible = v
}

/** 统一开拍表单提交：透传 gateStages 等全部字段给 director.start */
async function onSubmit(input: DirectorStartInput): Promise<void> {
  starting.value = true
  try {
    const projectId = await window.api.director.start(input)
    dialog.value.visible = false
    emit('started')
    // 开拍成功后跳转控制台，由 WorkflowPanel 与全局运行条接管进度展示
    await router.push(`/project/${projectId}/console`)
  } catch (e) {
    ElMessage.error('启动失败：' + (e instanceof Error ? e.message : String(e)))
  } finally {
    starting.value = false
  }
}

defineExpose({ open })
</script>

<style scoped>
/* 开拍表单弹窗：内容过高时 body 内部滚动，底部按钮始终可见 */
.director-start-dialog :deep(.el-dialog__body) {
  max-height: 62vh;
  overflow-y: auto;
}
</style>
