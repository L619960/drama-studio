<template>
  <div class="error-state glass-panel">
    <div class="error-art">
      <el-icon :size="30"><WarningFilled /></el-icon>
    </div>
    <h3 class="error-title">{{ title }}</h3>
    <p v-if="description" class="error-desc">{{ description }}</p>
    <p v-if="detail" class="error-detail">{{ detail }}</p>
    <div class="error-actions">
      <el-button type="primary" size="small" :loading="retrying" @click="$emit('retry')">
        {{ retryLabel }}
      </el-button>
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { WarningFilled } from '@element-plus/icons-vue'
/**
 * 统一的「加载失败」卡片：明确说明这不是空态，并提供重试与自定义逃生入口。
 * 与空态（EmptyState）、加载态（PageSkeleton）严格区分，避免三态混淆。
 */
withDefaults(
  defineProps<{
    title: string
    description?: string
    /** 原始错误信息，折叠风格展示 */
    detail?: string
    retryLabel?: string
    retrying?: boolean
  }>(),
  { description: '', detail: '', retryLabel: '重试加载', retrying: false }
)

defineEmits<{ retry: [] }>()
</script>

<style scoped>
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 40px 24px;
  gap: 6px;
}
.error-art {
  width: 72px;
  height: 72px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-md);
  background: rgba(240, 113, 120, 0.14);
  border: 1px solid var(--glass-border);
  color: var(--danger);
  margin-bottom: 8px;
}
.error-title {
  font-family: var(--font-display);
  font-size: var(--font-lg);
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}
.error-desc {
  font-size: var(--font-base);
  color: var(--text-secondary);
  line-height: 1.6;
  max-width: 46ch;
  margin: 0;
}
.error-detail {
  font-size: var(--font-sm);
  color: var(--text-muted);
  font-family: var(--font-body);
  background: var(--bg-input);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  max-width: 70ch;
  word-break: break-all;
  margin: 4px 0 0;
}
.error-actions {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
  justify-content: center;
  margin-top: var(--space-2);
}
</style>
