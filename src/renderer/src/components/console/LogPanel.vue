<template>
  <div class="panel panel-grow">
    <div class="panel-title log-title">
      执行日志
      <el-radio-group v-model="levelFilter" size="small" class="level-filter">
        <el-radio-button value="all">全部</el-radio-button>
        <el-radio-button value="warn">仅警告/错误</el-radio-button>
      </el-radio-group>
      <el-button size="small" plain :loading="exporting" @click="exportLogs">导出</el-button>
      <span class="log-hint">{{ logHover ? '已暂停滚动 · 移开鼠标恢复' : '警告默认收起 · 点击条目看明细' }}</span>
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
          <!-- REQ-18：warn 默认折叠在阶段组内，点击展开；error 始终可见 -->
          <div
            v-if="warnCount(group) > 0"
            class="log-warn-toggle"
            role="button"
            tabindex="0"
            @click="toggleWarn(group.stage)"
            @keydown.enter.prevent="toggleWarn(group.stage)"
            @keydown.space.prevent="toggleWarn(group.stage)"
          >
            <el-icon>
              <ArrowDown v-if="warnExpanded.has(group.stage)" />
              <ArrowRight v-else />
            </el-icon>
            <span>{{ warnExpanded.has(group.stage) ? `收起 ${warnCount(group)} 条警告` : `展开 ${warnCount(group)} 条警告` }}</span>
          </div>
          <div
            v-for="entry in visibleEntries(group)"
            :key="entry.id"
            class="log-entry"
            :class="{ 'is-expandable': !!entry.detail, 'is-open': expandedIds.has(entry.id) }"
            @click="toggleEntry(entry)"
          >
            <span class="log-time">{{ formatTime(entry.timestamp) }}</span>
            <span class="log-level" :class="`lv-${entry.level}`">{{ levelText[entry.level] }}</span>
            <span v-if="entry.errorKind" class="log-kind" :class="`ek-${entry.errorKind}`">
              {{ ERROR_KIND_TEXT[entry.errorKind] }}
            </span>
            <span class="log-msg" :class="{ 'msg-wrap': entry.level === 'error' }">{{ entry.message }}</span>
            <el-icon v-if="entry.detail" class="log-toggle">
              <ArrowDown v-if="expandedIds.has(entry.id)" />
              <ArrowRight v-else />
            </el-icon>
            <pre v-if="entry.detail && expandedIds.has(entry.id)" class="log-detail">{{ entry.detail }}</pre>
          </div>
        </el-collapse-item>
      </el-collapse>
      <el-empty v-else description="暂无日志，开始任务后在此实时显示" :image-size="80" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Loading, CircleCheckFilled, CircleCloseFilled, RemoveFilled, MoreFilled, FolderOpened,
  ArrowRight, ArrowDown
} from '@element-plus/icons-vue'
import type {
  DirectorState, DirectorStage, DirectorLogEntry
} from '../../../../shared/ipcTypes'
import { buildLogText } from '../../../../shared/logExport'
import { ERROR_KIND_TEXT } from '../../utils/errorGuide'
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
/** REQ-18：已展开警告的阶段（默认收起） */
const warnExpanded = ref<Set<DirectorStage>>(new Set())
/** REQ-18：已展开明细的日志 id */
const expandedIds = ref<Set<number>>(new Set())
const exporting = ref(false)
const logsByStage = computed(() => {
  const all = groupLogsByStage(props.localLogs)
  if (levelFilter.value !== 'warn') return all
  // 仅保留有 warn/error 的阶段组
  return all
    .map(g => ({ ...g, entries: g.entries.filter(e => e.level === 'warn' || e.level === 'error') }))
    .filter(g => g.entries.length > 0)
})

function warnCount(group: { entries: DirectorLogEntry[] }): number {
  return group.entries.filter(e => e.level === 'warn').length
}

/** 「仅警告/错误」过滤下不折叠；展开警告的阶段显示全部，其余阶段隐藏 warn */
function visibleEntries(group: { stage: DirectorStage; entries: DirectorLogEntry[] }): DirectorLogEntry[] {
  if (levelFilter.value === 'warn' || warnExpanded.value.has(group.stage)) {
    return group.entries
  }
  return group.entries.filter(e => e.level !== 'warn')
}

function toggleWarn(stage: DirectorStage): void {
  const next = new Set(warnExpanded.value)
  if (next.has(stage)) next.delete(stage)
  else next.add(stage)
  warnExpanded.value = next
}

function toggleEntry(entry: DirectorLogEntry): void {
  if (!entry.detail) return
  const next = new Set(expandedIds.value)
  if (next.has(entry.id)) next.delete(entry.id)
  else next.add(entry.id)
  expandedIds.value = next
}

// el-collapse v-model 在父子分离场景下用 :model-value + @update
function onStagesUpdate(val: string | string[]): void {
  emit('update:expandedStages', Array.isArray(val) ? val as DirectorStage[] : [val as DirectorStage])
}

/** REQ-18：按当前项目导出日志为 txt，落盘到项目目录 */
async function exportLogs(): Promise<void> {
  const pid = props.state?.projectId
  if (!pid) {
    ElMessage.warning('当前未绑定项目，无法导出到项目目录')
    return
  }
  exporting.value = true
  try {
    const rel = await window.api.director.exportLogs(pid, buildLogText(props.localLogs))
    ElMessage.success(`日志已导出：${rel}`)
  } catch (e) {
    ElMessage.error(`导出失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    exporting.value = false
  }
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
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 10px;
  font-size: 12px;
  line-height: 1.9;
  padding: 0 8px;
  border-bottom: 1px dashed var(--border-weak);
}
.log-entry.is-expandable { cursor: pointer; }
.log-entry.is-expandable:hover { background: var(--bg-hover); }
.log-warn-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px 4px;
  font-size: 12px;
  color: var(--warning, #e6a23c);
  cursor: pointer;
  width: fit-content;
}
.log-kind {
  flex-shrink: 0;
  align-self: center;
  padding: 0 6px;
  font-size: 11px;
  line-height: 18px;
  border: 1px solid currentColor;
  border-radius: 4px;
}
.ek-transient { color: var(--warning, #e6a23c); }
.ek-oom, .ek-permanent { color: var(--danger, #f56c6c); }
.ek-unknown { color: var(--text-muted); }
.log-toggle {
  margin-left: auto;
  flex-shrink: 0;
  align-self: center;
  color: var(--text-muted);
}
.log-detail {
  flex-basis: 100%;
  margin: 0 0 6px;
  padding: 8px 10px;
  background: var(--bg-input);
  border-radius: 6px;
  color: var(--text-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}
.log-time { color: var(--text-muted); font-variant-numeric: tabular-nums; flex-shrink: 0; }
.log-level { flex-shrink: 0; width: 34px; font-weight: 600; }
.lv-info { color: #409eff; }
.lv-success { color: #67c23a; }
.lv-warn { color: #e6a23c; }
.lv-error { color: #f56c6c; }
.log-msg { color: var(--text-secondary); }
</style>
