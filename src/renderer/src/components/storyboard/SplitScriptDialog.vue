<template>
  <el-dialog v-model="visible" title="AI 拆分镜" width="700px">
    <el-input
      v-model="script"
      type="textarea"
      :rows="12"
      placeholder="粘贴剧本内容（支持中文），AI 将自动拆分为分镜列表，包含场景名、英文动作提示词、台词和镜头类型（人物/空镜）"
    />
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="loading" @click="doSplitScript">
        {{ loading ? '拆分中...' : '开始拆分' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { GeneratedShot } from '../../../../shared/ipcTypes'

const props = defineProps<{ projectGenre: string }>()
const emit = defineEmits<{ split: [generated: GeneratedShot[]] }>()

const visible = ref(false)
const loading = ref(false)
const script = ref('')

function open(): void {
  script.value = ''
  loading.value = false
  visible.value = true
}

/** 调 LLM 拆分剧本，成功后把结果交给父组件追加保存 */
async function doSplitScript() {
  if (!script.value.trim()) {
    ElMessage.warning('请输入剧本内容')
    return
  }
  loading.value = true
  try {
    const generated = await window.api.llm.splitScript(script.value, props.projectGenre)
    if (generated.length === 0) throw new Error('未拆分出有效分镜')
    visible.value = false
    emit('split', generated)
  } catch (e) {
    ElMessage.error((e as Error).message || '拆分失败')
  } finally {
    loading.value = false
  }
}

defineExpose({ open })
</script>
