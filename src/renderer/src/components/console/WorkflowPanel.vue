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
        <el-button v-if="!running" type="primary" :icon="VideoPlay" @click="onStartClick">
          {{ leftoverCount > 0 ? '继续上次任务' : '开始任务' }}
        </el-button>
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

    <!-- 常驻进度条：当前阶段 + 百分比 + 镜头进度 -->
    <div v-if="state" class="progress-bar-wrap">
      <div class="progress-label">
        <span class="progress-stage">{{ currentStageLabel }}</span>
        <span class="progress-percent">{{ currentPercent }}%</span>
        <span class="progress-shots" v-if="state.totalShots">镜头 {{ state.doneShots || 0 }}/{{ state.totalShots }}</span>
      </div>
      <el-progress :percentage="currentPercent" :status="paused ? 'warning' : (currentPercent >= 100 ? 'success' : '')" :stroke-width="6" :show-text="false" />
    </div>

    <el-alert
      v-if="paused"
      class="pause-alert"
      type="warning"
      :closable="false"
      show-icon
      :title="pausedTitle"
      :description="pausedDescription"
    >
      <!-- REQ-02：门禁待处理结构化 CTA —— 一眼看到待审镜数，一键定位到分镜审核 -->
      <div v-if="pendingShotCount > 0" class="interrupted-actions">
        <el-button type="primary" :icon="EditPen" @click="goReviewPendingShots">
          去审看（{{ pendingShotCount }} 镜待核对）
        </el-button>
      </div>
    </el-alert>

    <!-- P0-1 任务中断提示：应用重启/崩溃导致上次任务中断，给出明确入口而非卡死态 -->
    <el-alert
      v-if="interrupted"
      class="interrupted-alert"
      type="error"
      :closable="false"
      show-icon
      :title="interruptedTitle"
      description="已完成的素材与渲染产物全部保留，不会重跑。确认无误后点下方按钮从中断阶段继续；若 ComfyUI 未启动，请先启动后再继续。"
    >
      <div class="interrupted-actions">
        <el-button
          v-if="interruptedStage"
          type="primary"
          :icon="RefreshRight"
          @click="emit('resumeFrom', interruptedStage)"
        >
          从「{{ STAGE_LABELS[interruptedStage] }}」继续
        </el-button>
        <el-button
          v-if="!interruptedStage && pendingCount > 0"
          type="primary"
          :icon="VideoPlay"
          @click="emit('retryPending')"
        >
          继续待渲染 ({{ pendingCount }})
        </el-button>
      </div>
    </el-alert>

    <!-- 残留任务提示：上次任务结束后仍有未完成镜头（失败/待渲染），可一键续渲 -->
    <el-alert
      v-if="!running && !paused && leftoverCount > 0"
      class="leftover-alert"
      type="info"
      :closable="false"
      show-icon
      :title="`上次任务未完成：${failedCount} 镜失败、${pendingCount} 镜待渲染`"
      description="流水线已结束但镜头未全部产出。点下方「继续待渲染」可一键续渲所有待渲染镜头（含分镜审核门禁）；也可以在分镜页逐镜确认首帧后再渲。"
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
          type="primary"
          :icon="VideoPlay"
          @click="emit('retryPending')"
        >
继续待渲染 ({{ pendingCount }})
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
import { useRouter } from 'vue-router'
import {
  VideoPlay, VideoPause, Delete, CircleCloseFilled, RefreshRight, EditPen
} from '@element-plus/icons-vue'
import DirectorStartForm from '../project/DirectorStartForm.vue'
import StageTimeline from './StageTimeline.vue'
import LogPanel from './LogPanel.vue'
// 阶段中文标签复用唯一实现（与主进程 directorConstants.STAGE_LABELS 文案对齐，
// 避免中断提示标题与执行日志对同一阶段出现两种叫法）
import { STAGE_LABELS } from '../../composables/useDirectorState'
import {
  type DirectorState, type DirectorStage, type DirectorLogEntry,
  type Project, type WorkflowMeta, type WorkflowCapability,
  type AssetRegenerateInput, type DirectorStartInput
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

// ===== REQ-02 门禁待处理：结构化 pendingGates 渲染为可点 CTA =====
const router = useRouter()
const pendingGate = computed(() => props.state?.pendingGates?.find(g => g.reason === 'shotReview'))
const pendingShotCount = computed(() => pendingGate.value?.unreviewedShotIds.length ?? 0)
const pausedTitle = computed(() =>
  pendingShotCount.value > 0
    ? `等待分镜审核：${pendingShotCount.value} 个镜头未核对首帧`
    : '任务已停在阶段确认点'
)
const pausedDescription = computed(() =>
  pendingShotCount.value > 0
    ? '进行中的渲染已安全完成。请先逐镜核对分镜图（勾选确认），全部审完后点「继续」进入渲染。'
    : '进行中的渲染已安全完成，流水线已挂起。检查产物无误后点「继续」进入下一阶段，或点「停止任务」终止。'
)
/** 跳到分镜页并定位第一个待审镜（StoryboardView 消费 ?review=shotId 自动打开审核弹窗） */
function goReviewPendingShots(): void {
  const pid = props.state?.projectId || props.project?.id
  const first = pendingGate.value?.unreviewedShotIds[0]
  if (!pid) return
  void router.push({
    path: `/project/${pid}/storyboard`,
    query: first ? { review: first } : undefined
  })
}

// ===== P0-1 任务中断提示 =====
// interrupted 由主进程 hydrate 修复残留 running 状态时置位；interruptedStage 记录中断所在阶段
const interrupted = computed(() => !!props.state?.interrupted && !props.running && !props.paused)
const interruptedStage = computed<DirectorStage | undefined>(() => {
  const st = props.state?.interruptedStage
  return st && st !== 'done' ? st : undefined
})
const interruptedTitle = computed(() => {
  const st = interruptedStage.value
  return st
    ? `上次任务已中断：停在「${STAGE_LABELS[st]}」阶段`
    : '上次任务已中断（应用重启或异常退出）'
})

const currentStageLabel = computed(() => {
  const s = props.state
  if (!s) return ''
  for (const st of ['analyze','casting','scenes','render','combine','subtitle','review','bgm','done'] as const) {
    const info = s.stages?.[st]
    if (info && (info.status === 'running' || info.status === 'paused')) return STAGE_LABELS[st] || st
  }
  return s.stages?.done?.status === 'done' ? '完成' : '待开始'
})
const currentPercent = computed(() => {
  const s = props.state
  if (!s) return 0
  for (const st of ['analyze','casting','scenes','render','combine','subtitle','review','bgm','done'] as const) {
    const info = s.stages?.[st]
    if (info && (info.status === 'running' || info.status === 'paused')) return Math.round(info.percent ?? 0)
  }
  return s.stages?.done?.status === 'done' ? 100 : 0
})

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

function onStartClick(): void {
  // 有未完成镜头时直接续渲，不弹新剧对话框
  if (leftoverCount.value > 0) {
    if (pendingCount.value > 0) emit('retryPending')
    else if (failedCount.value > 0) emit('retryFailed')
    return
  }
  openStartDialog()
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
.interrupted-alert { border-radius: 8px; }
.interrupted-alert :deep(.el-alert__content) { width: 100%; }
.interrupted-actions { display: flex; gap: 8px; margin-top: 8px; }
.progress-bar-wrap { padding: 8px 16px; background: var(--el-fill-color-light, #f5f7fa); border-radius: 8px; margin-bottom: 8px; }
.progress-label { display: flex; gap: 12px; align-items: center; margin-bottom: 4px; font-size: 12px; }
.progress-stage { font-weight: 600; color: var(--el-color-primary, #409eff); }
.progress-percent { color: var(--el-text-color-primary, #303133); font-variant-numeric: tabular-nums; }
.progress-shots { color: var(--el-text-color-secondary, #909399); margin-left: auto; }
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
