<template>
  <div v-if="variant === 'cards'" class="skeleton-grid">
    <div v-for="i in count" :key="i" class="glass-card skeleton-card">
      <el-skeleton animated variant="rect" :style="{ width: '100%', height: `${height}px` }" />
      <div class="skeleton-body">
        <el-skeleton animated variant="text" style="width: 60%" :rows="2" />
      </div>
    </div>
  </div>
  <div v-else class="glass-panel skeleton-editor">
    <el-skeleton animated :rows="rows" />
  </div>
</template>

<script setup lang="ts">
/**
 * 页面级加载骨架：在项目数据取回前替代白屏。
 * cards=资产卡片网格（对齐项目列表六卡骨架），editor=整块编辑区。
 */
withDefaults(
  defineProps<{
    variant?: 'cards' | 'editor'
    /** cards 变体的卡片数量 */
    count?: number
    /** cards 变体的封面高度 */
    height?: number
    /** editor 变体的行数 */
    rows?: number
  }>(),
  { variant: 'cards', count: 6, height: 130, rows: 10 }
)
</script>

<style scoped>
.skeleton-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: var(--space-4);
}
.skeleton-card {
  overflow: hidden;
}
.skeleton-body {
  padding: 12px 14px;
}
.skeleton-editor {
  padding: var(--space-5);
}
</style>
