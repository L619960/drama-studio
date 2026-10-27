<template>
  <div class="workflow-panel">
    <header class="control-bar">
      <div class="control-title">
        <span v-if="state" class="control-title-text" :title="state.title">{{ state.title }}</span>
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
        </template>
        <!-- 停止/清空按钮常驻显示，状态不满足时置灰，避免用户找不到入口 -->
        <el-button type="danger" :icon="CircleCloseFilled" :disabled="!running" @click="emit('cancel')">停止任务</el-button>
        <el-button :icon="Delete" :disabled="running || !state" @click="emit('clear')">清空任务</el-button>
        <el-button
          v-if="!running && failedCount > 0"
          type="danger"
          plain
          :icon="RefreshRight"
          @click="emit('retryFailed')"
        >
重试失败镜头 ({{ failedCount }})
</el-button>
      </div>
    </header>

    <el-alert
      v-if="paused"
      class="pause-alert"
      type="warning"
      :closable="false"
      show-icon
      title="任务已停在阶段确认点"
      description="进行中的渲染已安全完成，流水线已挂起。检查产物无误后点「继续」进入下一阶段，或点「停止任务」终止。"
    />

    <!-- 残留任务提示：上次任务结束后仍有未完成镜头（失败/待渲染），可一键续渲 -->
    <el-alert
      v-if="!running && !paused && leftoverCount > 0"
      class="leftover-alert"
      type="info"
      :closable="false"
      show-icon
      :title="`上次任务未完成：${failedCount} 镜失败、${pendingCount} 镜待渲染`"
      description="流水线已结束但镜头未全部产出。可重试失败镜头或续渲待渲染镜头，也可以在分镜页逐镜处理。"
    >
      <div class="leftover-actions">
        <el-button
          v-if="failedCount > 0"
          size="small"
          type="danger"
          plain
          :icon="RefreshRight"
          @click="emit('retryFailed')"
        >
重试失败镜头 ({{ failedCount }})
</el-button>
        <el-button
          v-if="pendingCount > 0"
          size="small"
          type="primary"
          plain
          :icon="VideoPlay"
          @click="emit('retryPending')"
        >
续渲待渲染 ({{ pendingCount }})
</el-button>
      </div>
    </el-alert>

    <!-- 九阶段时间线（可折叠：点击阶段行展开产物预览/改提示词重渲） -->
    <StageTimeline
      :state="state"
      :project="project"
      :asset-urls="assetUrls"
      :video-workflows="videoWorkflows"
      :image-workflows="imageWorkflows"
      :rerendering-shot-id="rerenderingShotId"
      @resume-from="emit('resumeFrom', $event)"
      @rerender-shot="emit('rerenderShot', $event)"
      @rerender-shots="emit('rerenderShots', $event)"
      @open-final-folder="emit('openFinalFolder')"
      @asset-refreshed="emit('asset-refreshed')"
      @start-task="openStartDialog"
    />

    <!-- 中文执行日志（可交互时间线：阶段卡片可展开，含耗时/错误详情/修复建议/产物） -->
    <LogPanel
      :local-logs="localLogs"
      :expanded-stages="expandedStages"
      :state="state"
      @update:expanded-stages="emit('update:expandedStages', $event)"
      @open-final-folder="emit('openFinalFolder')"
    />

    <!-- 开拍需求确认弹窗 -->
    <el-dialog
      :model-value="startDialogVisible"
      @update:model-value="emit('update:startDialogVisible', $event)"
      title="开拍需求确认"
      width="720px"
      top="6vh"
      append-to-body
      :close-on-click-modal="false"
      class="start-dialog"
    >
      <DirectorStartForm
        :open="startDialogVisible"
        :starting="starting"
        @cancel="emit('update:startDialogVisible', false)"
        @submit="confirmStart"
      />
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  VideoPlay, VideoPause, Delete, CircleCloseFilled, RefreshRight
} from '@element-plus/icons-vue'
import DirectorStartForm from '../project/DirectorStartForm.vue'
import StageTimeline from './StageTimeline.vue'
import LogPanel from './LogPanel.vue'
import {
  type DirectorState, type DirectorStage, type DirectorLogEntry,
  type Project, type WorkflowMeta, type WorkflowCapability,
  type AssetRegenerateKind, type AssetRegenerateInput, type DirectorStartInput
} from '../../../../shared/ipcTypes'

const props = defineProps<{
  state: DirectorState | null
  localLogs: DirectorLogEntry[]
  expandedStages: DirectorStage[]
  gateOptions: ReadonlyArray<{ value: DirectorStage; label: string }>
  running: boolean
  paused: boolean
  startDialogVisible: boolean
  starting: boolean
  /** 项目快照与产物 URL（实时预览角色/场景/镜头/成片） */
  project: Project | null
  assetUrls: Record<string, string>
  /** 正在重渲的镜头 id（按钮 loading） */
  rerenderingShotId: string
}>()

const emit = defineEmits<{
  pause: []
  resume: []
  cancel: []
  /** 清空已结束任务的状态与日志，回到待命态 */
  clear: []
  openFinalFolder: []
  /** A 断点续跑：从指定阶段重跑 */
  resumeFrom: [stage: DirectorStage]
  /** D 批量重试失败镜头 */
  retryFailed: []
  /** 续渲全部待渲染镜头 */
  retryPending: []
  /** 渲染阶段：改提示词/工作流后重渲单镜 */
  rerenderShot: [payload: { shotId: string; prompt: string; dialogue: string; negative: string; workflow: string }]
  /** 渲染阶段：批量重渲选中镜头 */
  rerenderShots: [payloads: Array<{ shotId: string; prompt: string; dialogue: string; negative: string; workflow: string }>]
  /** 工作台产物：编辑提示词/工作流后重新生成（角色/场景/首尾帧） */
  regenerateAsset: [payload: AssetRegenerateInput]
  /** 工作台产物：回滚到上一版 */
  rollbackAsset: [payload: AssetRegenerateInput]
  /** 产物已变更，通知父级刷新 project/assetUrls */
  'asset-refreshed': []
  'update:expandedStages': [stages: DirectorStage[]]
  'update:startDialogVisible': [visible: boolean]
  start: [input: { title: string; genre: string; script: string; gateStages?: DirectorStage[]; bgmAbsolutePath?: string }]
}>()

const failedCount = computed(() => props.state?.failedShotIds.length ?? 0)
/** 待渲染镜头数（残留任务提示用）：优先取项目快照，取不到时回退 state */
const pendingCount = computed(() => {
  const shots = props.project?.shots
  if (shots) return shots.filter(s => s.status === 'pending').length
  const total = props.state?.totalShots ?? 0
  const done = props.state?.doneShots ?? 0
  const failed = failedCount.value
  return Math.max(0, total - done - failed)
})
const leftoverCount = computed(() => failedCount.value + pendingCount.value)

// ===== 工作流列表：按能力标签过滤（视频/图像分别给对应下拉） =====
const workflows = ref<WorkflowMeta[]>([])
onMounted(async () => {
  try {
    workflows.value = await window.api.workflow.list()
  } catch {
    workflows.value = []
  }
})
const VIDEO_CAPS: WorkflowCapability[] = ['t2v', 'i2v', 'flf2v']
const IMAGE_CAPS: WorkflowCapability[] = ['t2i', 'i2i']
const videoWorkflows = computed(() => workflows.value.filter(w => !w.capability || VIDEO_CAPS.includes(w.capability)))
const imageWorkflows = computed(() => workflows.value.filter(w => !w.capability || IMAGE_CAPS.includes(w.capability)))

function openStartDialog(): void {
  emit('update:startDialogVisible', true)
}

function confirmStart(input: DirectorStartInput): void {
  emit('start', input)
}
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
  min-width: 0;
}
/* 长标题单行截断，悬停显示全名；不折行 */
.control-title-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 220px;
  min-width: 0;
}
/* 语义禁用态：type=danger 按钮 disabled 后不再残留粉色，与「清空任务」一致置灰 */
.control-actions .el-button.is-disabled,
.control-actions .el-button.is-disabled:hover,
.control-actions .el-button.is-disabled:focus {
  background-color: var(--bg-input);
  border-color: var(--border-weak);
  color: var(--text-muted);
}
.pause-alert { border-radius: 8px; }
.leftover-alert { border-radius: 8px; }
.leftover-alert :deep(.el-alert__content) { width: 100%; }
.leftover-actions { display: flex; gap: 8px; margin-top: 8px; }

/* 弹窗：内容过高时 body 内部滚动，保证底部按钮始终可见 */
.start-dialog :deep(.el-dialog__body) {
  max-height: 62vh;
  overflow-y: auto;
}
.start-dialog :deep(.el-dialog__footer) {
  border-top: 1px solid var(--border-weak);
}
</style>
