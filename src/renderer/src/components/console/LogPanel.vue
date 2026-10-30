<template>
  <div class="panel panel-grow">
    <div class="panel-title log-title">
      执行日志
      <el-radio-group v-model="levelFilter" size="small" class="level-filter">
        <el-radio-button value="all">全部</el-radio-button>
        <el-radio-button value="warn">仅警告/错误</el-radio-button>
      </el-radio-group>
      <span class="log-hint">{{ logHover ? '已暂停滚动 · 移开鼠标恢复' : '已完成阶段自动折叠 · 新消息自动滚底' }}</span>
    </div>
    <div ref="logBoxRef" class="log-box" @mouseenter="logHover = true" @mouseleave="logHover = false">
      <el-collapse
        v-if="logsByStage.length"
        :model-value="expandedStages"
        @update:model-value="onStagesUpdate"
        class="log-collapse"
      >
        <el-collapse-item
          v-for="group in logsByStage"
          :key="group.stage"
          :name="group.stage"
        >
          <template #title>
            <el-icon class="log-group-icon" :class="`st-${state?.stages[group.stage]?.status || 'pending'}`">
              <Loading v-if="state?.stages[group.stage]?.status === 'running'" />
              <CircleCheckFilled v-else-if="state?.stages[group.stage]?.status === 'done'" />
              <CircleCloseFilled v-else-if="state?.stages[group.stage]?.status === 'error'" />
              <RemoveFilled v-else-if="state?.stages[group.stage]?.status === 'skipped'" />
              <MoreFilled v-else />
            </el-icon>
            <span class="log-group-title">{{ stageLabels[group.stage] }}</span>
            <span v-if="groupDurationSec(group.entries) > 0" class="log-group-dur">
              耗时 {{ formatDuration(groupDurationSec(group.entries)) }}
            </span>
            <el-tag size="small" :type="groupHasError(group) ? 'danger' : 'info'" effect="plain" class="log-count">
              {{ group.entries.length }} 条
            </el-tag>
          </template>
          <!-- C 自愈：该阶段的 AI 诊断与修复建议 -->
          <el-alert
            v-if="state?.heal?.stage === group.stage"
            class="heal-alert"
            type="warning"
            :closable="false"
            show-icon
            :title="`AI 诊断：${state.heal.diagnosis}`"
            :description="`修复建议：${state.heal.suggestion}`"
          />
          <!-- 成片产物快捷入口 -->
          <div v-if="group.stage === 'done' && state?.finalPath" class="final-row">
            <el-button size="small" @click="emit('openFinalFolder')">
              <el-icon><FolderOpened /></el-icon>&nbsp;打开成片所在目录
            </el-button>
          </div>
          <div v-for="entry in group.entries" :key="entry.id" class="log-entry">
            <span class="log-time">{{ formatTime(entry.timestamp) }}</span>
            <span class="log-level" :class="`lv-${entry.level}`">{{ levelText[entry.level] }}</span>
            <span class="log-msg" :class="{ 'msg-wrap': entry.level === 'error' }">{{ entry.message }}</span>
          </div>
        </el-collapse-item>
      </el-collapse>
      <el-empty v-else description="暂无日志，开始任务后在此实时显示" :image-size="80" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  Loading, CircleCheckFilled, CircleCloseFilled, RemoveFilled, MoreFilled, FolderOpened
} from '@element-plus/icons-vue'
import type {
  DirectorState, DirectorStage, DirectorLogEntry
} from '../../../../shared/ipcTypes'
import {
  STAGE_LABELS, LEVEL_TEXT, groupLogsByStage, groupHasError,
  groupDurationSec, formatDuration, formatTime
} from '../../composables/useDirectorState'

const props = defineProps<{
  localLogs: DirectorLogEntry[]
  expandedStages: DirectorStage[]
  state: DirectorState | null
}>()

const emit = defineEmits<{
  'update:expandedStages': [stages: DirectorStage[]]
  openFinalFolder: []
}>()

const stageLabels = STAGE_LABELS
const levelText = LEVEL_TEXT

const logHover = ref(false)
const levelFilter = ref<'all' | 'warn'>('all')
const logBoxRef = ref<HTMLElement | null>(null)
const logsByStage = computed(() => {
  const all = groupLogsByStage(props.localLogs)
  if (levelFilter.value !== 'warn') return all
  // 仅保留有 warn/error 的阶段组
  return all
    .map(g => ({ ...g, entries: g.entries.filter(e => e.level === 'warn' || e.level === 'error') }))
    .filter(g => g.entries.length > 0)
})

// el-collapse v-model 在父子分离场景下用 :model-value + @update
function onStagesUpdate(val: string | string[]): void {
  emit('update:expandedStages', Array.isArray(val) ? val as DirectorStage[] : [val as DirectorStage])
}

// ===== 新日志自动滚底（悬停时完全暂停，移开后恢复） =====
watch(() => props.localLogs.length, async () => {
  if (logHover.value) return
  await nextTick()
  const box = logBoxRef.value
  if (!box) return
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140
  if (nearBottom) box.scrollTop = box.scrollHeight
})
</script>

<style scoped>
.panel {
  background: var(--bg-card);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  padding: 14px 16px;
}
.panel-grow {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.panel-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 10px;
  display: flex;
  align-items: center;
}
.log-title { justify-content: space-between; }
.log-hint { font-size: 12px; font-weight: 400; color: var(--text-muted); }
.level-filter { margin-left: 12px; }
.log-box {
  flex: 1;
  overflow-y: auto;
  min-height: 120px;
}
.log-collapse {
  --el-collapse-border-color: var(--border-weak);
  --el-collapse-header-bg-color: transparent;
  --el-collapse-content-bg-color: transparent;
  --el-collapse-header-text-color: var(--text-primary);
  --el-collapse-text-color: var(--text-primary);
}
.is-loading { animation: spin 1.4s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.log-group-title { font-size: 13px; font-weight: 500; }
.log-group-icon { margin-right: 8px; font-size: 15px; color: var(--text-muted); }
.log-group-icon.st-running { color: #409eff; animation: spin 1.4s linear infinite; }
.log-group-icon.st-done { color: #67c23a; }
.log-group-icon.st-error { color: #f56c6c; }
.log-group-icon.st-skipped { color: var(--text-muted); }
.log-group-dur {
  margin-left: 10px;
  font-size: 12px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.log-count { margin-left: 10px; }
.heal-alert { margin: 4px 8px 10px; border-radius: 8px; }
.final-row { padding: 4px 8px 10px; }
.msg-wrap {
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.6;
}
.log-entry {
  display: flex;
  gap: 10px;
  font-size: 12px;
  line-height: 1.9;
  padding: 0 8px;
  border-bottom: 1px dashed var(--border-weak);
}
.log-time { color: var(--text-muted); font-variant-numeric: tabular-nums; flex-shrink: 0; }
.log-level { flex-shrink: 0; width: 34px; font-weight: 600; }
.lv-info { color: #409eff; }
.lv-success { color: #67c23a; }
.lv-warn { color: #e6a23c; }
.lv-error { color: #f56c6c; }
.log-msg { color: var(--text-secondary); }
</style>
