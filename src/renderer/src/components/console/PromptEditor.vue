<template>
  <div class="prompt-editor" :class="{ 'is-busy': busy }">
    <el-input
      :model-value="modelValue"
      type="textarea"
      :rows="rows"
      :placeholder="placeholder"
      resize="vertical"
      @update:model-value="emit('update:modelValue', $event)"
      @keydown.ctrl.enter.prevent="emit('ctrlEnter')"
    />
    <!-- 右上角：AI 专业化优化 -->
    <el-tooltip content="AI 优化为专业提示词（摄影/光影/构图术语）" placement="top" :show-after="300">
      <button
        type="button"
        class="pe-icon pe-icon-top"
        :disabled="busy || !modelValue?.trim()"
        title="AI 优化"
        @click="runAssist('optimize')"
      >
        <el-icon v-if="busyAction === 'optimize'" class="is-loading"><Loading /></el-icon>
        <el-icon v-else><MagicStick /></el-icon>
      </button>
    </el-tooltip>
    <!-- 右下角：中英互译 -->
    <el-tooltip content="中英互译（保留专业术语）" placement="bottom" :show-after="300">
      <button
        type="button"
        class="pe-icon pe-icon-bottom pe-icon-lang"
        :disabled="busy || !modelValue?.trim()"
        title="中英互译"
        @click="runAssist('translate')"
      >
        <el-icon v-if="busyAction === 'translate'" class="is-loading"><Loading /></el-icon>
        <span v-else class="pe-lang-text">{{ langBadge }}</span>
      </button>
    </el-tooltip>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Loading, MagicStick } from '@element-plus/icons-vue'

const props = withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
  rows?: number
  /** positive=正向画面/动作提示词，negative=负向压制项（影响 AI 优化策略） */
  kind?: 'positive' | 'negative'
}>(), { rows: 2, kind: 'positive' })

const emit = defineEmits<{
  'update:modelValue': [value: string]
  ctrlEnter: []
}>()

const busyAction = ref<'' | 'optimize' | 'translate'>('')
const busy = computed(() => busyAction.value !== '')

/** 根据内容判断翻译方向徽标：含中文 → EN（将译成英文），否则 → 中 */
const langBadge = computed(() => /[一-龥]/.test(props.modelValue || '') ? 'EN' : '中')

async function runAssist(action: 'optimize' | 'translate'): Promise<void> {
  const text = props.modelValue?.trim()
  if (!text) { ElMessage.info('请先输入内容'); return }
  if (busy.value) return
  busyAction.value = action
  try {
    const res = await window.api.prompt.assist({ text, action, kind: props.kind })
    if (res.text) {
      emit('update:modelValue', res.text)
      ElMessage.success(action === 'optimize' ? '已优化为专业提示词' : '翻译完成')
    }
  } catch (e) {
    ElMessage.error((e as Error)?.message || '辅助失败，请检查 LLM 配置')
  } finally {
    busyAction.value = ''
  }
}
</script>

<style scoped>
.prompt-editor { position: relative; }
/* 给右上角/右下角悬浮图标留出空间，避免文字被遮挡 */
.prompt-editor :deep(.el-textarea__inner) {
  padding-right: 34px;
  padding-bottom: 30px;
}
.pe-icon {
  position: absolute;
  width: 22px; height: 22px;
  display: flex; align-items: center; justify-content: center;
  border: none; border-radius: 4px;
  background: transparent;
  color: var(--text-muted, #9a9a9a);
  cursor: pointer;
  font-size: 13px;
  transition: background 0.15s, color 0.15s;
  z-index: 2;
}
.pe-icon:hover:not(:disabled) { background: var(--bg-input, rgba(0,0,0,0.06)); color: #b8860b; }
.pe-icon:disabled { opacity: 0.4; cursor: not-allowed; }
.pe-icon-top { top: 5px; right: 5px; }
.pe-icon-bottom { bottom: 5px; right: 5px; }
.pe-icon-lang { width: 26px; }
.pe-lang-text { font-size: 10px; font-weight: 600; letter-spacing: 0.5px; }
</style>
