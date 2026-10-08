<template>
  <!-- AI 导演对话框 -->
  <el-dialog v-model="dialog.visible" title="AI 导演 · 剧本一键成片" width="640px">
    <el-form label-width="80px">
      <el-form-item label="片名" required>
        <el-input v-model="dialog.title" placeholder="如：总裁的隐婚新娘" />
      </el-form-item>
      <el-form-item label="题材">
        <el-select v-model="dialog.genre" filterable allow-create style="width: 100%">
          <el-option
            v-for="t in GENRE_TEMPLATES"
            :key="t.key"
            :label="t.label"
            :value="t.key"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="剧本" required>
        <el-input
          v-model="dialog.script"
          type="textarea"
          :rows="10"
          placeholder="粘贴完整剧本（含场景、动作、台词），AI 将自动拆分分镜、创建角色、生成定妆图与场景图，逐镜渲染后拼接为成片"
        />
      </el-form-item>
      <el-form-item label="BGM">
        <div class="bgm-row">
          <span class="bgm-name" :class="{ placeholder: !dialog.bgmPath }">
            {{ dialog.bgmPath || '可选：选择背景音乐' }}
          </span>
          <el-button size="small" @click="selectBgm">选择</el-button>
          <el-button v-if="dialog.bgmPath" size="small" link @click="dialog.bgmPath = ''">
            清除
          </el-button>
        </div>
      </el-form-item>
    </el-form>
    <div class="director-tip">
      将自动完成：剧本分析 → 角色建档/定妆图 → 场景图 → 逐镜渲染（含配音）→ 拼接 → 字幕烧录 → BGM 混音。
      中途失败的镜头将跳过并在结束时汇总。
    </div>
    <template #footer>
      <el-button @click="dialog.visible = false">取消</el-button>
      <el-button
        type="success"
        :loading="starting"
        @click="startDirector"
      >开始制作</el-button>
    </template>
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
            >{{ shotIndexById(id) }}</el-tag>
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
          <div v-if="state.reviewIssues?.length" class="failed-list">
            <div style="margin-bottom: 4px">复审意见：</div>
            <div
              v-for="(issue, i) in state.reviewIssues"
              :key="i"
              class="review-issue"
            >{{ issue }}</div>
          </div>
        </template>
      </div>
    </div>
    <template #footer>
      <el-button
        v-if="state?.running"
        type="danger"
        @click="cancelDirector"
      >取消制作</el-button>
      <template v-else>
        <el-button
          v-if="state?.finalPath"
          @click="locateFinal"
        >在文件夹中显示</el-button>
        <el-button
          type="primary"
          @click="goResult"
        >前往成片页</el-button>
      </template>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  CircleCheckFilled, CircleCloseFilled, Loading, RemoveFilled, MoreFilled
} from '@element-plus/icons-vue'
import type { Project, DirectorState, DirectorStage, DirectorProgressEvent } from '../../../../shared/ipcTypes'
import { GENRE_TEMPLATES } from '../../../../shared/ipcTypes'

const props = defineProps<{ projects: Project[] }>()
const emit = defineEmits<{ started: [] }>()

const router = useRouter()

const dialog = ref({
  visible: false,
  title: '',
  genre: '',
  script: '',
  bgmPath: ''
})
const starting = ref(false)
const progressVisible = ref(false)
const state = ref<DirectorState | null>(null)
const currentId = ref('')
let unsub: (() => void) | null = null

const STAGE_LABEL_LIST: Array<{ key: DirectorStage; label: string }> = [
  { key: 'analyze', label: '剧本分析' },
  { key: 'casting', label: '角色建档 · 定妆图' },
  { key: 'scenes', label: '场景图生成' },
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
  dialog.value = {
    visible: true,
    title: '',
    genre: '',
    script: '',
    bgmPath: ''
  }
}

async function selectBgm(): Promise<void> {
  const p = await window.api.dialog.selectAudio()
  if (p) dialog.value.bgmPath = p
}

async function startDirector(): Promise<void> {
  const d = dialog.value
  if (!d.title.trim()) { ElMessage.warning('请输入片名'); return }
  if (!d.script.trim()) { ElMessage.warning('请粘贴剧本'); return }

  // 订阅进度：先清理上一次的订阅，避免重复发起时监听器叠加
  unsub?.()
  unsub = window.api.director.onProgress((e: DirectorProgressEvent) => {
    if (e.projectId !== currentId.value) return
    state.value = e.state
  })

  starting.value = true
  try {
    const projectId = await window.api.director.start({
      title: d.title.trim(),
      genre: d.genre,
      script: d.script,
      bgmAbsolutePath: d.bgmPath || undefined
    })
    currentId.value = projectId
    // 主进程在 start 返回前已发出首个事件（此时还拿不到 projectId 会被过滤），
    // 主动拉取一次当前状态补齐，避免进度面板首阶段空白
    state.value = await window.api.director.getState(projectId)
    dialog.value.visible = false
    progressVisible.value = true
    emit('started')
  } catch (e) {
    ElMessage.error('启动失败：' + (e instanceof Error ? e.message : String(e)))
    unsub?.()
    unsub = null
  } finally {
    starting.value = false
  }
}

async function cancelDirector(): Promise<void> {
  try {
    await ElMessageBox.confirm('确定取消制作吗？已完成的渲染产物会保留。', '取消制作', {
      confirmButtonText: '取消制作',
      cancelButtonText: '继续制作',
      type: 'warning'
    })
  } catch {
    return
  }
  await window.api.director.cancel(currentId.value)
}

/** 失败镜头 id → 镜头序号（用于汇总展示） */
function shotIndexById(id: string): number {
  const p = props.projects.find(x => x.id === currentId.value)
  const idx = p?.shots.find(s => s.id === id)?.index
  return idx ?? 0
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
/* AI 导演 */
.bgm-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.bgm-name {
  flex: 1;
  font-size: 13px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bgm-name.placeholder { color: var(--text-muted); }

.director-tip {
  font-size: 12px;
  color: var(--text-muted);
  background: var(--bg-card);
  border-radius: 6px;
  padding: 8px 12px;
  line-height: 1.7;
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
