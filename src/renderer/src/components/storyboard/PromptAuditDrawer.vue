<template>
  <el-drawer
    :model-value="modelValue"
    title="提示词体检"
    size="68%"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div v-if="loading" class="audit-state">正在体检全部文生图 / 文生视频任务，请稍候…</div>

    <template v-else-if="report">
      <div class="audit-summary">
        <div class="summary-line">
          共 <b>{{ report.summary.total }}</b> 个任务 ·
          正常 <b class="ok">{{ report.summary.ok }}</b> ·
          警告 <b class="warn">{{ report.summary.warn }}</b> ·
          异常 <b class="err">{{ report.summary.error }}</b> ·
          问题 <b>{{ report.summary.issueTotal }}</b> 项（可一键修正 <b>{{ report.summary.fixableTotal }}</b> 项 · 可 AI 补写 <b>{{ aiFillableTotal }}</b> 项）
        </div>
        <div class="summary-actions">
          <el-button size="small" :disabled="fixing || bulkFilling" @click="emit('recheck')">重新体检</el-button>
          <el-button
            size="small" type="primary"
            :disabled="report.summary.fixableTotal === 0 || fixing || bulkFilling"
            :loading="fixing"
            @click="emit('fix-all')"
          >
            一键修正全部可修项（{{ report.summary.fixableTotal }}）
          </el-button>
          <el-button
            size="small" type="success"
            :disabled="aiFillableTotal === 0 || fixing || bulkFilling"
            :loading="bulkFilling"
            @click="emit('bulk-fill-all')"
          >
            批量 AI 补写（{{ aiFillableTotal }} 字段）
          </el-button>
        </div>
        <div v-if="bulkFilling" class="bulk-progress">
          <el-progress
            :percentage="bulkProgress && bulkProgress.total ? Math.round(bulkProgress.done * 100 / bulkProgress.total) : 0"
            :status="bulkProgress && bulkProgress.done >= bulkProgress.total ? 'success' : undefined"
          />
          <span class="bulk-progress-text">
            AI 补写中… 已完成 {{ bulkProgress?.done ?? 0 }} / {{ bulkProgress?.total ?? 0 }}
          </span>
        </div>
      </div>

      <div v-if="report.summary.byCode.length" class="code-chips">
        <el-tag
          v-for="c in report.summary.byCode" :key="c.code"
          size="small" :type="codeTagType(c.code)" effect="plain"
          class="code-chip"
        >
          {{ c.label }} × {{ c.count }}
        </el-tag>
      </div>

      <div class="audit-filters">
        <el-radio-group v-model="scopeFilter" size="small">
          <el-radio-button label="all">全部</el-radio-button>
          <el-radio-button label="shot">分镜</el-radio-button>
          <el-radio-button label="character">角色</el-radio-button>
          <el-radio-button label="sceneBoard">场景板</el-radio-button>
          <el-radio-button label="prop">道具</el-radio-button>
        </el-radio-group>
        <el-checkbox v-model="onlyAbnormal" size="small">只看异常/警告</el-checkbox>
        <span class="filter-count">显示 {{ visibleTasks.length }} / {{ report.tasks.length }}</span>
      </div>

      <el-alert
        v-if="report.tasks.length === 0"
        type="info" show-icon :closable="false"
        title="本项目还没有可体检的提示词任务（分镜 / 角色 / 场景板 / 道具均为空）"
      />
      <el-alert
        v-else-if="visibleTasks.length === 0"
        type="success" show-icon :closable="false"
        title="当前筛选条件下全部合法：正向与负向提示词完整性、格式、敏感内容均通过"
      />

      <div v-else class="audit-list">
        <div
          v-for="task in visibleTasks" :key="task.id"
          class="audit-card" :class="task.status"
        >
          <div class="card-head">
            <el-tag size="small" :type="statusTagType(task.status)">{{ statusText(task.status) }}</el-tag>
            <span class="task-title">{{ task.title }}</span>
            <el-tag size="small" effect="plain">{{ taskTypeText(task.taskType) }}</el-tag>
            <span class="spacer" />
            <el-button
              v-if="fixableCount(task) > 0"
              link type="primary" size="small" :disabled="fixing || bulkFilling"
              @click="emit('fix-one', task.id)"
            >
              一键修正（{{ fixableCount(task) }}）
            </el-button>
            <el-button
              v-if="aiFillableCount(task) > 0"
              link type="success" size="small" :disabled="fixing || bulkFilling"
              @click="emit('bulk-fill-one', task.id)"
            >
              AI 补写（{{ aiFillableCount(task) }}）
            </el-button>
            <el-button link type="warning" size="small" @click="emit('edit', task)">跳转编辑</el-button>
          </div>

          <div class="field-rows">
            <div v-for="f in task.fields" :key="f.field" class="field-row">
              <el-tag size="small" :type="f.polarity === 'positive' ? 'success' : 'danger'" effect="plain">
                {{ f.polarity === 'positive' ? '正向' : '负向' }}
              </el-tag>
              <span class="field-label">{{ f.label }}{{ f.system ? '（系统）' : '' }}</span>
              <span
                class="field-text"
                :class="{ empty: !f.text, folded: !isExpanded(task.id, f.field) }"
                @click="toggleExpanded(task.id, f.field)"
              >{{ f.text || '（空）' }}</span>
              <span class="field-count">{{ f.wordCount }} 词</span>
            </div>
          </div>

          <div v-if="task.issues.length" class="issue-list">
            <div
              v-for="(issue, i) in task.issues" :key="i"
              class="issue-row" :class="issue.level"
            >
              <span class="issue-dot">{{ issue.level === 'error' ? '✕' : '!' }}</span>
              <div class="issue-body">
                <div class="issue-msg">{{ issue.message }}</div>
                <div class="issue-type">{{ issue.fieldLabel }} · {{ codeLabel(issue.code) }}{{ issue.fixable ? ' · 可一键修正' : ' · 需人工编辑' }}</div>
              </div>
              <el-button
                v-if="issue.fixable"
                link type="primary" size="small" :disabled="fixing"
                @click="emit('fix-one', task.id)"
              >
                修正
              </el-button>
            </div>
          </div>
          <div v-else class="issue-none">未发现问题</div>
        </div>
      </div>
    </template>

    <el-empty v-else description="尚未执行体检" />
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PromptAuditReport, PromptAuditTask, PromptAuditStatus, PromptAuditTaskType, PromptAuditScope } from '../../../../shared/ipcTypes'
import { AUDIT_CODE_LABELS, AI_FILLABLE_CODES } from '../../../../shared/promptAudit'

const props = defineProps<{
  modelValue: boolean
  report: PromptAuditReport | null
  loading?: boolean
  fixing?: boolean
  bulkFilling?: boolean
  bulkProgress?: { done: number; total: number } | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'recheck'): void
  (e: 'fix-all'): void
  (e: 'fix-one', taskId: string): void
  (e: 'bulk-fill-all'): void
  (e: 'bulk-fill-one', taskId: string): void
  (e: 'edit', task: PromptAuditTask): void
}>()

const scopeFilter = ref<'all' | PromptAuditScope>('all')
const onlyAbnormal = ref(false)
const expandedKeys = ref<Set<string>>(new Set())

const visibleTasks = computed<PromptAuditTask[]>(() => {
  const tasks = props.report?.tasks || []
  return tasks.filter(t => {
    if (scopeFilter.value !== 'all' && t.scope !== scopeFilter.value) return false
    if (onlyAbnormal.value && (t.status === 'ok' || t.issues.length === 0)) return false
    return true
  })
})

function statusText(status: PromptAuditStatus): string {
  return status === 'error' ? '异常' : status === 'warn' ? '警告' : '合法'
}

function statusTagType(status: PromptAuditStatus): 'success' | 'warning' | 'danger' {
  return status === 'error' ? 'danger' : status === 'warn' ? 'warning' : 'success'
}

function taskTypeText(type: PromptAuditTaskType): string {
  return type === 'i2v' ? '图生视频' : type === 't2v' ? '文生视频' : '文生图'
}

function codeLabel(code: string): string {
  return AUDIT_CODE_LABELS[code] || code
}

/** 问题类型标签配色：敏感类与串戏/缺失用红，其余用黄 */
function codeTagType(code: string): 'danger' | 'warning' {
  return code.startsWith('taboo') || code === 'cross-project' || code === 'missing' ? 'danger' : 'warning'
}

function fixableCount(task: PromptAuditTask): number {
  return task.issues.filter(i => i.fixable).length
}

/** 该任务中可交给 AI 补写的字段数（去重字段） */
function aiFillableCount(task: PromptAuditTask): number {
  return new Set(
    task.issues
      .filter(i => AI_FILLABLE_CODES.has(i.code) && !task.fields.find(f => f.field === i.field)?.system)
      .map(i => i.field)
  ).size
}

/** 全报告可 AI 补写字段总数 */
const aiFillableTotal = computed(() => {
  if (!props.report) return 0
  let n = 0
  for (const t of props.report.tasks) n += aiFillableCount(t)
  return n
})

function isExpanded(taskId: string, field: string): boolean {
  return expandedKeys.value.has(`${taskId}:${field}`)
}

function toggleExpanded(taskId: string, field: string): void {
  const key = `${taskId}:${field}`
  const next = new Set(expandedKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedKeys.value = next
}
</script>

<style scoped>
.audit-state { padding: 40px 0; text-align: center; color: var(--text-muted); font-size: 13px; }
.audit-summary {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 10px 12px; margin-bottom: 10px;
  background: var(--bg-input); border: 1px solid var(--border-strong); border-radius: 10px;
}
.summary-line { flex: 1 1 320px; font-size: 13px; color: var(--text-secondary); }
.summary-line b { color: var(--text-primary); }
.summary-line b.ok { color: #2e7d46; }
.summary-line b.warn { color: #b8860b; }
.summary-line b.err { color: #c0504d; }
.summary-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.bulk-progress { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
.bulk-progress .el-progress { flex: 1; max-width: 360px; }
.bulk-progress-text { font-size: 12px; color: var(--text-muted); white-space: nowrap; }
.code-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.audit-filters {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px;
}
.filter-count { font-size: 12px; color: var(--text-muted); }
.audit-list { display: flex; flex-direction: column; gap: 10px; }
.audit-card {
  border: 1px solid var(--border-strong); border-left-width: 3px; border-radius: 10px;
  background: var(--bg-input); padding: 10px 12px;
}
.audit-card.ok { border-left-color: #2e7d46; }
.audit-card.warn { border-left-color: #b8860b; background: rgba(184, 134, 11, 0.06); }
.audit-card.error { border-left-color: #c0504d; background: rgba(192, 80, 77, 0.07); }
.card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.task-title { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.spacer { flex: 1; }
.field-rows { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
.field-row { display: flex; align-items: flex-start; gap: 6px; font-size: 12px; }
.field-label { flex: 0 0 190px; color: var(--text-muted); }
.field-text {
  flex: 1; font-family: ui-monospace, Consolas, monospace; color: var(--text-secondary);
  word-break: break-all; white-space: pre-wrap; cursor: pointer;
}
.field-text.folded { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.field-text.empty { color: #c0504d; font-weight: 600; }
.field-count { flex: 0 0 52px; text-align: right; color: var(--text-muted); }
.issue-list { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border-strong); }
.issue-row { display: flex; align-items: flex-start; gap: 6px; font-size: 12px; }
.issue-dot { font-weight: 700; line-height: 18px; }
.issue-row.error .issue-dot { color: #c0504d; }
.issue-row.warn .issue-dot { color: #b8860b; }
.issue-body { flex: 1; }
.issue-msg { color: var(--text-secondary); }
.issue-row.error .issue-msg { color: #8a3b38; }
.issue-type { color: var(--text-muted); font-size: 11px; margin-top: 2px; }
.issue-none { margin-top: 8px; font-size: 12px; color: #2e7d46; }
</style>
