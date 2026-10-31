<template>
  <div class="empty-state glass-panel">
    <div class="empty-art" :class="art">
      <el-icon v-if="icon" :size="34" class="empty-icon">
        <component :is="icon" />
      </el-icon>
      <span v-else class="empty-art-glyph">✦</span>
    </div>
    <h3 class="empty-title">{{ title }}</h3>
    <p v-if="description" class="empty-desc">{{ description }}</p>
    <div v-if="$slots.default" class="empty-actions">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Component } from 'vue'
/**
 * 统一空状态：占位图形 + 标题 + 描述 + 引导 CTA（插槽）。
 * 用法：
 *   <EmptyState title="还没有项目" description="..." :icon="FolderOpened">
 *     <el-button type="primary">新建项目</el-button>
 *   </EmptyState>
 */
withDefaults(
  defineProps<{
    title: string
    description?: string
    /** Element Plus 图标组件；缺省显示装饰符号 */
    icon?: Component
    /** 占位图形变体：default=圆角卡片，flat=极简线框 */
    art?: 'default' | 'flat'
  }>(),
  { description: '', art: 'default' },
)
</script>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 40px 24px;
  gap: 6px;
}
.empty-art {
  width: 72px;
  height: 72px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-md);
  background: var(--brand-dim);
  border: 1px solid var(--glass-border);
  color: var(--brand-strong);
  margin-bottom: 8px;
}
.empty-art.flat {
  background: transparent;
  border-style: dashed;
}
.empty-art-glyph {
  font-size: 28px;
  opacity: 0.7;
}
.empty-title {
  font-family: var(--font-display);
  font-size: var(--font-lg);
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}
.empty-desc {
  font-size: var(--font-base);
  color: var(--text-secondary);
  line-height: 1.6;
  max-width: 46ch;
  margin: 0 0 8px;
}
.empty-actions {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
  justify-content: center;
  margin-top: var(--space-2);
}
</style>
