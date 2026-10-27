<template>
  <!-- AI 导演对话框：复用统一开拍表单（含 gateStages 确认点） -->
  <el-dialog
    :model-value="dialog.visible"
    @update:model-value="onDialogVisible"
    title="AI 导演 · 一键成片"
    width="720px"
    top="6vh"
    :close-on-click-modal="false"
    class="director-start-dialog"
  >
    <DirectorStartForm
      :open="dialog.visible"
      :starting="starting"
      @cancel="dialog.visible = false"
      @submit="onSubmit"
    />
  </el-dialog>

  <!-- AI 导演进度面板 -->
  <el-dialog
    v-model="progressVisible"
    title="AI 导演 · 制作进度"
    width="640px"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="!state?.running"
  >
    <div v-if="state" class="director-panel">
      <div
        v-for="stage in stageList"
        :key="stage.key"
        class="stage-row"
        :class="stage.key"
      >
        <div class="stage-icon">
          <el-icon v-if="stage.data.status === 'done'"><CircleCheckFilled class="ok" /></el-icon>
          <el-icon v-else-if="stage.data.status === 'running'" class="running"><Loading /></el-icon>
          <el-icon v-else-if="stage.data.status === 'error'"><CircleCloseFilled class="err" /></el-icon>
          <el-icon v-else-if="stage.data.status === 'skipped'"><RemoveFilled class="skip" /></el-icon>
          <el-icon v-else><MoreFilled class="pending" /></el-icon>
        </div>
        <div class="stage-body">
          <div class="stage-head">
            <span class="stage-label">{{ stage.label }}</span>
            <span v-if="stage.data.status === 'running'" class="stage-percent">
              {{ stage.data.percent }}%
            </span>
          </div>
          <div v-if="stage.data.message" class="stage-msg">{{ stage.data.message }}</div>
          <el-progress
            v-if="stage.data.status === 'running'"
            :percentage="stage.data.percent"
            :stroke-width="3"
            :show-text="false"
            style="margin-top: 4px"
          />
        </div>
      </div>

      <div v-if="!state.running" class="director-summary">
        <template v-if="state.finalPath">
          <el-alert
            :title="`成片已生成（成功 ${state.doneShots}/${state.totalShots} 镜，复审已通过）`"
            type="success"
            :closable="false"
            show-icon
            style="margin: 8px 0 12px"
          />
          <div v-if="state.failedShotIds.length" class="failed-list">
            失败镜头编号：
            <el-tag
              v-for="id in state.failedShotIds"
              :key="id"
              type="danger"
              size="small"
            >
{{ shotIndexById(id) }}
</el-tag>
            <el-button size="small" type="danger" plain :loading="retrying" @click="retryFailed">
              重试失败镜头 ({{ state.failedShotIds.length }})
            </el-button>
          </div>
        </template>
        <template v-else>
          <el-alert
            title="制作未能产出成片，请查看上方失败阶段"
            type="error"
            :closable="false"
            show-icon
            style="margin: 8px 0 12px"
          />
          <div v-if="state.failedShotIds.length" class="failed-list" style="margin-bottom: 10px">
            失败镜头编号：
            <el-tag
              v-for="id in state.failedShotIds"
              :key="id"
              type="danger"
              size="small"
            >
{{ shotIndexById(id) }}
</el-tag>
            <el-button size="small" type="danger" plain :loading="retrying" @click="retryFailed">
              重试失败镜头 ({{ state.failedShotIds.length }})
            </el-button>
          </div>
          <div v-if="state.reviewIssues?.length" class="failed-list">
            <div style="margin-bottom: 4px">复审意见：</div>
            <div
              v-for="(issue, i) in state.reviewIssues"
              :key="i"
              class="review-issue"
            >
{{ issue }}
</div>
          </div>
        </template>
      </div>
    </div>
    <template #footer>
      <el-button
        v-if="state?.running"
        type="danger"
        @click="cancelDirector"
      >
取消制作
</el-button>
      <template v-else>
        <el-button
          v-if="state?.finalPath"
          @click="locateFinal"
        >
在文件夹中显示
</el-button>
        <el-button
          type="primary"
          @click="goResult"
        >
前往成片页
</el-button>
      </template>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { confirmDanger } from '../../utils/confirm'
import {
  CircleCheckFilled, CircleCloseFilled, Loading, RemoveFilled, MoreFilled
} from '@element-plus/icons-vue'
import type {
  Project, DirectorState, DirectorStage, DirectorProgressEvent, DirectorStartInput
} from '../../../../shared/ipcTypes'
import DirectorStartForm from './DirectorStartForm.vue'

const props = defineProps<{ projects: Project[] }>()
const emit = defineEmits<{ started: [] }>()

const router = useRouter()

const dialog = ref({ visible: false })
const starting = ref(false)
const progressVisible = ref(false)
const state = ref<DirectorState | null>(null)
const currentId = ref('')
let unsub: (() => void) | null = null

const STAGE_LABEL_LIST: Array<{ key: DirectorStage; label: string }> = [
  { key: 'analyze', label: '剧本分析' },
  { key: 'casting', label: '角色建档 · 面部+三视图' },
  { key: 'scenes', label: '场景板与首尾帧' },
  { key: 'render', label: '逐镜渲染 · 审批' },
  { key: 'combine', label: '拼接成片' },
  { key: 'subtitle', label: '烧录字幕' },
  { key: 'review', label: '成片复审' },
  { key: 'bgm', label: 'BGM 混音' }
]

const stageList = computed(() =>
  STAGE_LABEL_LIST.map(s => ({
    ...s,
    data: state.value!.stages[s.key]
  }))
)

function open(): void {
  dialog.value.visible = true
}

function onDialogVisible(v: boolean): void {
  dialog.value.visible = v
}

/** 统一开拍表单提交：透传 gateStages 等全部字段给 director.start */
async function onSubmit(input: DirectorStartInput): Promise<void> {
  // 订阅进度：先清理上一次的订阅，避免重复发起时监听器叠加
  unsub?.()
  unsub = window.api.director.onProgress((e: DirectorProgressEvent) => {
    if (e.projectId !== currentId.value) return
    state.value = e.state
  })

  starting.value = true
  try {
    const projectId = await window.api.director.start(input)
    currentId.value = projectId
    // 主进程在 start 返回前已发出首个事件（此时还拿不到 projectId 会被过滤），
    // 主动拉取一次当前状态补齐，避免进度面板首阶段空白
    state.value = await window.api.director.getState(projectId)
    dialog.value.visible = false
    emit('started')
    // 开拍成功后跳转控制台，由 WorkflowPanel/ConsoleView 接管进度展示；
    // 切到其他页后 ConsoleView 的 hydrate 会恢复进度，不会丢失
    await router.push(`/project/${projectId}/console`)
  } catch (e) {
    ElMessage.error('启动失败：' + (e instanceof Error ? e.message : String(e)))
    unsub?.()
    unsub = null
  } finally {
    starting.value = false
  }
}

async function cancelDirector(): Promise<void> {
  const ok = await confirmDanger('确定取消制作吗？已完成的渲染产物会保留。', {
    title: '取消制作',
    confirmText: '取消制作',
    cancelText: '继续制作'
  })
  if (!ok) return
  try {
    await window.api.director.cancel(currentId.value)
    ElMessage.info('已请求取消，当前阶段结束后自动停下')
  } catch (e) {
    ElMessage.error(`取消失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 失败镜头 id → 镜头序号（用于汇总展示） */
function shotIndexById(id: string): number {
  const p = props.projects.find(x => x.id === currentId.value)
  const idx = p?.shots.find(s => s.id === id)?.index
  return idx ?? 0
}

/** D 批量重试失败镜头：入队后由影子任务同步进度回本面板 */
const retrying = ref(false)
async function retryFailed(): Promise<void> {
  const ids = state.value?.failedShotIds ?? []
  if (!ids.length || retrying.value) return
  retrying.value = true
  try {
    await window.api.render.start(currentId.value, [...ids], false)
    ElMessage.success(`已重新入队 ${ids.length} 个失败镜头，进度在下方实时更新`)
  } catch (e) {
    ElMessage.error('重试失败：' + (e instanceof Error ? e.message : String(e)))
  } finally {
    retrying.value = false
  }
}

function locateFinal(): void {
  if (state.value?.finalPath) {
    window.api.shell.showItem(state.value.finalPath)
  }
}

function goResult(): void {
  progressVisible.value = false
  router.push(`/project/${currentId.value}/result`)
}

onUnmounted(() => {
  unsub?.()
  unsub = null
})

defineExpose({ open })
</script>

<style scoped>
/* 开拍表单弹窗：内容过高时 body 内部滚动，底部按钮始终可见 */
.director-start-dialog :deep(.el-dialog__body) {
  max-height: 62vh;
  overflow-y: auto;
}

.director-panel {
  max-height: 60vh;
  overflow-y: auto;
  padding: 4px 4px 4px 0;
}
.stage-row {
  display: flex;
  gap: 12px;
  padding: 10px 4px;
  border-radius: 8px;
}
.stage-icon {
  padding-top: 2px;
  font-size: 18px;
}
.stage-icon .ok { color: #67c23a; }
.stage-icon .err { color: #f56c6c; }
.stage-icon .running { color: #409eff; animation: spin 1.2s linear infinite; }
.stage-icon .skip { color: var(--text-muted); }
.stage-icon .pending { color: var(--text-muted); }

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.stage-body { flex: 1; min-width: 0; }
.stage-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.stage-label {
  font-size: 14px;
  color: var(--text-primary);
  font-weight: 500;
}
.stage-percent {
  font-size: 12px;
  color: #409eff;
}
.stage-msg {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
  line-height: 1.6;
  word-break: break-all;
}
.director-summary { margin-top: 12px; }
.failed-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: var(--text-muted);
}

.review-issue {
  width: 100%;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary, #c8c8c8);
  padding-left: 8px;
  border-left: 2px solid var(--el-color-danger, #f56c6c);
}
</style>
