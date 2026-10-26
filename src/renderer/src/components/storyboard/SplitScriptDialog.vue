<template>
  <el-dialog v-model="visible" title="AI 拆分镜" width="700px">
    <p v-if="initialScript" class="prefill-tip">已预填当前项目剧本，可直接「开始拆分」；也可修改后再拆分。</p>
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

const props = defineProps<{ projectGenre: string; initialScript?: string }>()
const emit = defineEmits<{ split: [script: string] }>()

const visible = ref(false)
const loading = ref(false)
const script = ref('')

function open(): void {
  // 预填项目已有剧本：对已建项目的「AI 拆分镜」不再要求手动复制粘贴
  script.value = props.initialScript || ''
  loading.value = false
  visible.value = true
}

/** 剧本交回父组件，由完整剧本分析（角色/场景/道具建档 + 分镜绑定）统一处理 */
function doSplitScript() {
  if (!script.value.trim()) {
    ElMessage.warning('请输入剧本内容（如已有剧本请直接开始拆分）')
    return
  }
  loading.value = true
  emit('split', script.value)
}

function done(): void {
  loading.value = false
  visible.value = false
}

defineExpose({ open, done })
</script>

<style scoped>
.prefill-tip {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
