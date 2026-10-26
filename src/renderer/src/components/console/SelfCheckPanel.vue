<template>
  <div class="panel selfcheck-panel">
    <div class="panel-title">
      <span class="title-text">
        <el-icon><Odometer /></el-icon>&nbsp;系统自检
      </span>
      <el-button size="small" :icon="Refresh" :loading="loading" @click="emit('rerun')">重新自检</el-button>
    </div>

    <div v-if="loading && !items.length" class="sc-loading">
      <el-icon class="is-loading"><Loading /></el-icon><span>正在检查环境与功能…</span>
    </div>

    <div v-else-if="!items.length" class="sc-empty">尚未运行自检</div>

    <div v-else class="sc-list">
      <div class="sc-summary">
        <el-tag v-if="badCount" type="danger" effect="plain">{{ badCount }} 项异常</el-tag>
        <el-tag v-if="fixedCount" type="success" effect="plain">{{ fixedCount }} 项已自动修复</el-tag>
        <el-tag v-if="!badCount" type="success" effect="plain">全部通过</el-tag>
      </div>
      <div
        v-for="it in items"
        :key="it.name"
        class="sc-item"
        :class="{ 'is-bad': !it.ok, 'is-fixed': it.fixed }"
      >
        <el-icon v-if="it.fixed" class="sc-icon is-fixed"><CircleCheckFilled /></el-icon>
        <el-icon v-else-if="it.warn" class="sc-icon" color="var(--el-color-warning)"><WarningFilled /></el-icon>
        <el-icon v-else-if="it.ok" class="sc-icon is-ok"><CircleCheckFilled /></el-icon>
        <el-icon v-else class="sc-icon is-bad"><CircleCloseFilled /></el-icon>
        <div class="sc-body">
          <div class="sc-name">
            {{ it.name }}
            <el-tag v-if="it.fixed" size="small" type="success" effect="plain">已修复</el-tag>
            <el-tag v-else-if="!it.ok" size="small" type="danger" effect="plain">需处理</el-tag>
          </div>
          <div class="sc-detail">{{ it.detail }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  Odometer, Refresh, Loading, CircleCheckFilled, CircleCloseFilled, WarningFilled
} from '@element-plus/icons-vue'
import { computed } from 'vue'
import type { SelfCheckItem } from '../../../../shared/ipcTypes'

const props = defineProps<{
  items: SelfCheckItem[]
  loading: boolean
}>()

const emit = defineEmits<{ rerun: [] }>()

const badCount = computed(() => props.items.filter(i => !i.ok).length)
const fixedCount = computed(() => props.items.filter(i => i.fixed).length)
</script>

<style scoped>
.panel {
  background: var(--bg-card);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  padding: 12px 14px;
}
.panel-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.title-text { display: flex; align-items: center; }

.selfcheck-panel { flex: 1; overflow-y: auto; }

.sc-loading, .sc-empty {
  margin: 40px auto;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.sc-summary {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.sc-item {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border-weak);
  border-radius: 6px;
  background: var(--bg-input);
  margin-bottom: 8px;
}
.sc-item.is-bad { border-color: #f56c6c66; }
.sc-item.is-fixed { border-color: #67c23a55; }
.sc-icon { font-size: 16px; margin-top: 2px; }
.sc-icon.is-ok { color: #67c23a; }
.sc-icon.is-fixed { color: #67c23a; }
.sc-icon.is-bad { color: #f56c6c; }
.sc-body { flex: 1; min-width: 0; }
.sc-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 3px;
}
.sc-detail {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
  word-break: break-word;
}
</style>
