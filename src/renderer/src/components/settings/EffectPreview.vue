<template>
  <div class="effect-preview">
    <div class="effect-title">效果预览</div>
    <ul>
      <li v-for="(line, i) in lines" :key="i">{{ line }}</li>
    </ul>
    <div v-if="imageUrl" class="effect-image">
      <img :src="imageUrl" alt="试生成预览" />
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  lines: string[]
  imageUrl?: string
}>()
</script>

<style scoped>
.effect-preview {
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  border-radius: 10px;
  padding: 14px 16px;
  background: rgba(0, 0, 0, 0.18);
  min-width: 220px;
}
.effect-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--text-secondary);
}
ul {
  margin: 0;
  padding-left: 16px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-primary);
}
.effect-image {
  margin-top: 12px;
  border-radius: 8px;
  overflow: hidden;
  max-height: 280px;
}
.effect-image img {
  width: 100%;
  display: block;
  object-fit: cover;
}
</style>
