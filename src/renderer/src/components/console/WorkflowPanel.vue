<template>
  <div class="workflow-panel">
    <header class="control-bar">
      <div class="control-title">
        <span v-if="state">{{ state.title }}</span>
        <span v-else>导演工作台</span>
        <el-tag v-if="paused" type="warning" effect="dark" size="small" class="state-tag">已暂停 · 等待确认</el-tag>
        <el-tag v-else-if="running" type="primary" effect="dark" size="small" class="state-tag">执行中</el-tag>
        <el-tag v-else-if="state" type="success" effect="plain" size="small" class="state-tag">已结束</el-tag>
        <el-tag v-else type="info" effect="plain" size="small" class="state-tag">待命</el-tag>
      </div>
      <div class="control-actions">
        <el-button v-if="!running" type="primary" :icon="VideoPlay" @click="openStartDialog">开始任务</el-button>
        <template v-else>
          <el-button v-if="!paused" type="warning" :icon="VideoPause" @click="emit('pause')">暂停</el-button>
          <el-button v-else type="success" :icon="VideoPlay" @click="emit('resume')">继续</el-button>
          <el-button type="danger" :icon="Close" @click="emit('cancel')">取消任务</el-button>
        </template>
      </div>
    </header>

    <el-alert
      v-if="paused"
      class="pause-alert"
      type="warning"
      :closable="false"
      show-icon
      title="任务已停在阶段确认点"
      description="进行中的渲染已安全完成，流水线已挂起。检查产物无误后点「继续」进入下一阶段，或点「取消任务」终止。"
    />

    <!-- 九阶段时间线 -->
    <div class="panel">
      <div class="panel-title">工作流阶段</div>
      <div class="stage-list">
        <div
          v-for="stage in stageOrder"
          :key="stage"
          class="stage-row"
          :class="[`is-${state?.stages[stage]?.status || 'pending'}`]"
        >
          <div class="stage-icon">
            <el-icon v-if="state?.stages[stage]?.status === 'running'" class="is-loading"><Loading /></el-icon>
            <el-icon v-else-if="state?.stages[stage]?.status === 'done'"><CircleCheckFilled /></el-icon>
            <el-icon v-else-if="state?.stages[stage]?.status === 'error'"><CircleCloseFilled /></el-icon>
            <el-icon v-else-if="state?.stages[stage]?.status === 'skipped'"><RemoveFilled /></el-icon>
            <el-icon v-else-if="isGate(stage)"><Timer /></el-icon>
            <el-icon v-else><MoreFilled /></el-icon>
          </div>
          <div class="stage-body">
            <div class="stage-head">
              <span class="stage-name">{{ stageLabels[stage] }}</span>
              <el-tag v-if="isGate(stage)" size="small" type="warning" effect="plain" class="gate-tag">阶段后暂停</el-tag>
            </div>
            <div v-if="state?.stages[stage]?.message" class="stage-msg">{{ state.stages[stage].message }}</div>
            <el-progress
              v-if="state?.stages[stage]?.status === 'running'"
              :percentage="state.stages[stage].percent"
              :stroke-width="4"
              :show-text="false"
              class="stage-progress"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- 中文执行日志（按阶段自动折叠） -->
    <div class="panel panel-grow">
      <div class="panel-title log-title">
        执行日志
        <span class="log-hint">已完成阶段自动折叠 · 新消息自动滚底</span>
      </div>
      <div ref="logBoxRef" class="log-box">
        <el-collapse
          :model-value="expandedStages"
          @update="onStagesUpdate"
          class="log-collapse"
        >
          <el-collapse-item
            v-for="group in logsByStage"
            :key="group.stage"
            :name="group.stage"
          >
            <template #title>
              <span class="log-group-title">{{ stageLabels[group.stage] }}</span>
              <el-tag size="small" :type="groupHasError(group) ? 'danger' : 'info'" effect="plain" class="log-count">
                {{ group.entries.length }} 条
              </el-tag>
            </template>
            <div v-for="entry in group.entries" :key="entry.id" class="log-entry">
              <span class="log-time">{{ formatTime(entry.timestamp) }}</span>
              <span class="log-level" :class="`lv-${entry.level}`">{{ levelText[entry.level] }}</span>
              <span class="log-msg">{{ entry.message }}</span>
            </div>
          </el-collapse-item>
        </el-collapse>
        <el-empty v-else description="暂无日志，开始任务后在此实时显示" :image-size="80" />
      </div>
    </div>

    <!-- 开拍需求确认弹窗 -->
    <el-dialog
      :model-value="startDialogVisible"
      @update="emit('update:startDialogVisible', $event)"
      title="开拍需求确认"
      width="640px"
      :close-on-click-modal="false"
    >
      <el-alert
        type="info"
        :closable="false"
        show-icon
        class="confirm-tip"
        title="导演将按以下配置全自动执行：拆镜 → 定妆/首帧 → 逐镜渲染与审批 → 拼接 → 字幕 → 复审 → BGM"
        description="勾选的阶段结束后流水线会暂停，等你检查确认再继续；不勾选则一口气跑完。"
      />
      <el-form label-width="92px" class="start-form">
        <el-form-item label="片名" required>
          <el-input v-model="startForm.title" maxlength="40" placeholder="例如：雨夜重逢" />
        </el-form-item>
        <el-form-item label="题材" required>
          <el-select v-model="startForm.genre" style="width: 200px">
            <el-option v-for="g in GENRE_TEMPLATES" :key="g.key" :label="g.label" :value="g.key" />
          </el-select>
        </el-form-item>
        <el-form-item label="剧本" required>
          <el-input
            v-model="startForm.script"
            type="textarea"
            :rows="7"
            placeholder="粘贴剧本正文，包含场景描述与角色台词…"
          />
        </el-form-item>
        <el-form-item label="确认点">
          <el-checkbox-group v-model="startForm.gateStages" class="gate-checks">
            <el-checkbox v-for="g in gateOptions" :key="g.value" :label="g.value">
              {{ g.label }}完成后暂停
            </el-checkbox>
          </el-checkbox-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="emit('update:startDialogVisible', false)">取消</el-button>
        <el-button type="primary" :loading="starting" @click="confirmStart">确认开拍</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  VideoPlay, VideoPause, Close,
  Loading, CircleCheckFilled, CircleCloseFilled, RemoveFilled, MoreFilled, Timer
} from '@element-plus/icons-vue'
import {
  GENRE_TEMPLATES,
  type DirectorState, type DirectorStage, type DirectorLogEntry
} from '../../../../shared/ipcTypes'
import { STAGE_ORDER, STAGE_LABELS, LEVEL_TEXT } from '../../composables/useDirectorState'

const props = defineProps<{
  state: DirectorState | null
  localLogs: DirectorLogEntry[]
  expandedStages: DirectorStage[]
  gateOptions: ReadonlyArray<{ value: DirectorStage; label: string }>
  running: boolean
  paused: boolean
  startDialogVisible: boolean
  starting: boolean
}>()

const emit = defineEmits<{
  pause: []
  resume: []
  cancel: []
  openFinalFolder: []
  'update:expandedStages': [stages: DirectorStage[]]
  'update:startDialogVisible': [visible: boolean]
  start: [input: { title: string; genre: string; script: string; gateStages: DirectorStage[] }]
}>()

const stageOrder = STAGE_ORDER
const stageLabels = STAGE_LABELS
const levelText = LEVEL_TEXT

const logsByStage = computed(() => {
  const map = new Map<DirectorStage, DirectorLogEntry[]>()
  for (const e of props.localLogs) {
    const arr = map.get(e.stage) || []
    arr.push(e)
    map.set(e.stage, arr)
  }
  return STAGE_ORDER
    .filter(s => map.has(s))
    .map(stage => ({ stage, entries: map.get(stage)! }))
})

function isGate(stage: DirectorStage): boolean {
  return props.state?.gateStages.includes(stage) ?? false
}
function groupHasError(g: { entries: DirectorLogEntry[] }): boolean {
  return g.entries.some(e => e.level === 'error')
}
function formatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

// el-collapse v-model 在父子分离场景下用 :model-value + @update
function onStagesUpdate(val: string | string[]): void {
  emit('update:expandedStages', Array.isArray(val) ? val as DirectorStage[] : [val as DirectorStage])
}

// ===== 开拍弹窗（form 状态由本子组件自管；visible 由父控制） =====
const startForm = ref({
  title: '',
  genre: '霸总',
  script: '',
  gateStages: ['analyze', 'render'] as DirectorStage[]
})

// visible 由 false → true 时重置表单到默认值
watch(() => props.startDialogVisible, (v) => {
  if (v) {
    startForm.value = {
      title: startForm.value.title || '',
      genre: startForm.value.genre || '霸总',
      script: startForm.value.script || '',
      gateStages: ['analyze', 'render']
    }
  }
})

function openStartDialog(): void {
  emit('update:startDialogVisible', true)
}

function confirmStart(): void {
  if (!startForm.value.title.trim()) { ElMessage.warning('请填写片名'); return }
  if (!startForm.value.script.trim()) { ElMessage.warning('请粘贴剧本正文'); return }
  emit('start', {
    title: startForm.value.title.trim(),
    genre: startForm.value.genre,
    script: startForm.value.script.trim(),
    gateStages: startForm.value.gateStages
  })
}

// ===== 新日志自动滚底（用户正在回看历史时不打断） =====
const logBoxRef = ref<HTMLElement | null>(null)
watch(() => props.localLogs.length, async () => {
  await nextTick()
  const box = logBoxRef.value
  if (!box) return
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140
  if (nearBottom) box.scrollTop = box.scrollHeight
})
</script>

<style scoped>
.workflow-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-height: 0;
}
.control-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg-card);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  padding: 12px 16px;
}
.control-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 10px;
}
.pause-alert { border-radius: 8px; }

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

.stage-list { display: flex; flex-direction: column; gap: 2px; }
.stage-row {
  display: flex;
  gap: 12px;
  padding: 8px 4px;
  border-radius: 6px;
}
.stage-icon { width: 22px; display: flex; justify-content: center; color: var(--text-muted); font-size: 18px; }
.stage-row.is-running .stage-icon { color: #409eff; }
.stage-row.is-done .stage-icon { color: #67c23a; }
.stage-row.is-error .stage-icon { color: #f56c6c; }
.stage-row.is-skipped .stage-icon { color: var(--text-muted); }
.is-loading { animation: spin 1.4s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.stage-body { flex: 1; min-width: 0; }
.stage-head { display: flex; align-items: center; gap: 8px; }
.stage-name {
  font-size: 13px;
  color: var(--text-secondary);
}
.stage-row.is-running .stage-name,
.stage-row.is-done .stage-name,
.stage-row.is-error .stage-name { color: var(--text-primary); font-weight: 500; }
.gate-tag { transform: scale(0.9); }
.stage-msg {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stage-row.is-error .stage-msg { color: #f56c6c; }
.stage-progress { margin-top: 4px; max-width: 320px; }

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
.log-group-title { font-size: 13px; font-weight: 500; }
.log-count { margin-left: 10px; }
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

.confirm-tip { margin-bottom: 16px; }
.start-form :deep(.el-checkbox) { margin-right: 0; }
.gate-checks { display: flex; flex-direction: column; gap: 4px; }
</style>
