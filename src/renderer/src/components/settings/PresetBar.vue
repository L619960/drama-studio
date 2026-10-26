<template>
  <div class="preset-bar">
    <el-select v-model="selected" placeholder="选择预设" clearable style="width: 180px" size="small">
      <el-option v-for="p in presets" :key="p.id" :label="p.name" :value="p.id" />
    </el-select>
    <el-button size="small" :disabled="!selected" @click="emit('apply', selected!)">应用</el-button>
    <el-button size="small" @click="onSaveAs">另存为</el-button>
    <el-button size="small" type="danger" plain :disabled="!selected" @click="emit('remove', selected!)">删除</el-button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import type { CreationPreset } from '../../../../shared/ipcTypes'

defineProps<{
  presets: CreationPreset[]
}>()

const emit = defineEmits<{
  apply: [id: string]
  saveAs: [name: string]
  remove: [id: string]
}>()

const selected = ref<string | undefined>()

async function onSaveAs() {
  try {
    const { value } = await ElMessageBox.prompt('预设名称', '另存为创作预设', {
      confirmButtonText: '保存',
      cancelButtonText: '取消',
      inputPattern: /\S+/,
      inputErrorMessage: '请输入名称'
    })
    emit('saveAs', value.trim())
  } catch { /* cancel */ }
}
</script>

<style scoped>
.preset-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 16px;
}
</style>
