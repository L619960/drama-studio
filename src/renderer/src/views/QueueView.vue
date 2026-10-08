<template>
  <div class="queue-view">
    <div class="header">
      <h1>渲染队列</h1>
      <div class="actions">
        <el-button @click="refresh">
          <el-icon><Refresh /></el-icon>刷新
        </el-button>
        <el-button @click="clearCompleted" :disabled="doneCount === 0">
          <el-icon><RefreshLeft /></el-icon>清除已完成
        </el-button>
        <el-button type="danger" @click="cancelRender" :disabled="!hasRendering">
          <el-icon><CircleClose /></el-icon>取消全部
        </el-button>
      </div>
    </div>

    <!-- 进度总览 -->
    <div class="summary" v-if="shots.length > 0">
      <div class="summary-item">
        <span class="label">总计</span>
        <span class="value">{{ shots.length }}</span>
      </div>
      <div class="summary-item">
        <span class="label">完成</span>
        <span class="value success">{{ doneCount }}</span>
      </div>
      <div class="summary-item">
        <span class="label">渲染中</span>
        <span class="value warning">{{ renderingCount }}</span>
      </div>
      <div class="summary-item">
        <span class="label">待渲染</span>
        <span class="value info">{{ pendingCount }}</span>
      </div>
      <div class="summary-item">
        <span class="label">失败</span>
        <span class="value danger">{{ failedCount }}</span>
      </div>
    </div>

    <el-table
      :data="shots"
      style="width: 100%"
      @row-contextmenu="onRowContextMenu"
    >
      <el-table-column prop="index" label="#" width="50" align="center" />
      <el-table-column prop="scene" label="场景" width="120" show-overflow-tooltip />
      <el-table-column label="进度" width="220">
        <template #default="{ row }">
          <div class="progress-cell">
            <el-progress
              :percentage="getProgress(row)"
              :status="row.status === 'failed' ? 'exception' : row.status === 'done' ? 'success' : ''"
              :stroke-width="8"
            />
            <span class="progress-msg">{{ getMessage(row) }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="status" label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="statusType(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="消息" show-overflow-tooltip>
        <template #default="{ row }">{{ row.error || '-' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="140" align="center">
        <template #default="{ row }">
          <el-button
            v-if="row.status === 'failed'"
            link
            type="primary"
            size="small"
            @click.stop="retryShot(row)"
          >重试</el-button>
          <el-button
            v-if="row.status === 'rendering'"
            link
            type="danger"
            size="small"
            @click.stop="cancelShot(row)"
          >取消</el-button>
          <el-button
            v-if="row.status === 'done' && row.segmentPath"
            link
            type="success"
            size="small"
            @click.stop="previewShot(row)"
          >预览</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 右键菜单 -->
    <teleport to="body">
      <div
        v-if="contextMenu.visible"
        class="context-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
        @click.stop
      >
        <div class="menu-item" v-if="contextMenu.row?.status === 'failed'" @click="retryShot(contextMenu.row!)">
          <el-icon><RefreshLeft /></el-icon>重试
        </div>
        <div class="menu-item" v-if="contextMenu.row?.status === 'rendering'" @click="cancelShot(contextMenu.row!)">
          <el-icon><CircleClose /></el-icon>取消
        </div>
        <div class="menu-item" v-if="contextMenu.row?.status === 'done'" @click="previewShot(contextMenu.row!)">
          <el-icon><VideoPlay /></el-icon>预览
        </div>
        <div class="menu-divider" v-if="contextMenu.row?.status !== 'pending'" />
        <div class="menu-item" @click="resetShot(contextMenu.row!)">
          <el-icon><Refresh /></el-icon>重置状态
        </div>
        <div class="menu-divider" />
        <div class="menu-item" @click="viewDetails(contextMenu.row!)">
          <el-icon><Document /></el-icon>查看详情
        </div>
        <div
          class="menu-item"
          @click="contextMenu.row?.segmentPath && openOutputFolder(contextMenu.row!)"
          :class="{ disabled: !contextMenu.row?.segmentPath }"
        >
          <el-icon><FolderOpened /></el-icon>打开输出目录
        </div>
      </div>
    </teleport>

    <!-- 详情对话框 -->
    <el-dialog v-model="detailVisible" title="分镜详情" width="600px">
      <el-descriptions :column="2" border v-if="detailShot">
        <el-descriptions-item label="场景">{{ detailShot.scene }}</el-descriptions-item>
        <el-descriptions-item label="状态">{{ statusText(detailShot.status) }}</el-descriptions-item>
        <el-descriptions-item label="类型">{{ detailShot.type === 'i2v' ? '人物' : '空镜' }}</el-descriptions-item>
        <el-descriptions-item label="帧数">{{ detailShot.frames }}</el-descriptions-item>
        <el-descriptions-item label="Seed">{{ detailShot.seed }}</el-descriptions-item>
        <el-descriptions-item label="错误" :span="2" v-if="detailShot.error">
          <span style="color: #f56c6c">{{ detailShot.error }}</span>
        </el-descriptions-item>
      </el-descriptions>
      <div v-if="detailShot?.segmentPath" style="margin-top: 16px">
        <video :src="urlCache[detailShot.segmentPath]" controls style="width: 100%; max-height: 300px" />
      </div>
    </el-dialog>

    <!-- 预览对话框 -->
    <el-dialog v-model="previewVisible" title="预览" width="800px">
      <video :src="previewUrl" controls autoplay style="width: 100%" />
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useHotkeys } from '../composables/useHotkeys'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, CircleClose, RefreshLeft, VideoPlay, Document, FolderOpened } from '@element-plus/icons-vue'
import type { Project, Shot, ProgressEvent } from '../../../shared/ipcTypes'
import { useFileUrl, clearFileUrlCache } from '../composables/useFileUrl'
import { snapshot } from '../utils/snapshot'

const { urlCache, ensureFileUrl, ensureFileUrls } = useFileUrl()

const route = useRoute()
const projectId = route.params.id as string

const project = ref<Project | null>(null)
const progressMap = ref<Record<string, { percent: number; message: string }>>({})
const previewVisible = ref(false)
const previewUrl = ref('')
const detailVisible = ref(false)
const detailShot = ref<Shot | null>(null)

// 右键菜单
const contextMenu = ref({ visible: false, x: 0, y: 0, row: null as Shot | null })

const shots = computed(() => project.value?.shots || [])
const hasRendering = computed(() => shots.value.some(s => s.status === 'rendering'))
const doneCount = computed(() => shots.value.filter(s => s.status === 'done').length)
const renderingCount = computed(() => shots.value.filter(s => s.status === 'rendering').length)
const pendingCount = computed(() => shots.value.filter(s => s.status === 'pending').length)
const failedCount = computed(() => shots.value.filter(s => s.status === 'failed').length)

let unsubscribe: (() => void) | null = null

onMounted(async () => {
  await loadProject()
  unsubscribe = window.api.onProgress((e: ProgressEvent) => {
    if (e.projectId === projectId) {
      progressMap.value[e.shotId] = { percent: e.percent, message: e.message }
      if (e.step === 'done' || e.step === 'failed') {
        loadProject()
      }
    }
  })
  document.addEventListener('click', closeContextMenu)
})

onUnmounted(() => {
  unsubscribe?.()
  document.removeEventListener('click', closeContextMenu)
})

async function loadProject() {
  project.value = await window.api.project.get(projectId)
  // 解析已完成镜头的分段 URL（预览/详情使用）
  const paths = project.value.shots
    .filter(s => s.status === 'done' && s.segmentPath)
    .map(s => s.segmentPath) as string[]
  await ensureFileUrls(paths)
}

function refresh() {
  loadProject()
}

// F5 刷新队列状态
useHotkeys([
  { keys: 'f5', handler: () => refresh() }
])

function getProgress(shot: Shot) {
  const p = progressMap.value[shot.id]
  if (p) return p.percent
  if (shot.status === 'done') return 100
  if (shot.status === 'failed') return 0
  return 0
}

function getMessage(shot: Shot) {
  const p = progressMap.value[shot.id]
  if (p) return p.message
  if (shot.status === 'done') return '完成'
  if (shot.status === 'failed') return '失败'
  return '等待中'
}

// 右键菜单
function onRowContextMenu(row: Shot, column: unknown, event: MouseEvent) {
  event.preventDefault()
  contextMenu.value = { visible: true, x: event.clientX, y: event.clientY, row }
}

function closeContextMenu() {
  contextMenu.value.visible = false
}

async function retryShot(shot: Shot) {
  shot.status = 'pending'
  shot.error = undefined
  if (project.value) {
    await window.api.project.save(snapshot(project.value))
    await window.api.render.start(projectId, [shot.id])
    ElMessage.success('已加入队列')
  }
  contextMenu.value.visible = false
}

async function cancelShot(shot: Shot) {
  try {
    await ElMessageBox.confirm('确定取消此镜头的渲染吗？', '取消确认', { type: 'warning' })
    await window.api.render.cancel(projectId, shot.id)
    await loadProject()
    ElMessage.success('已取消')
  } catch {
    // 用户取消
  }
  contextMenu.value.visible = false
}

async function cancelRender() {
  try {
    await ElMessageBox.confirm('确定取消所有渲染任务吗？', '取消确认', { type: 'warning' })
    await window.api.render.cancel(projectId)
    if (project.value) {
      project.value.shots.forEach(s => {
        if (s.status === 'rendering') s.status = 'pending'
      })
      await window.api.project.save(snapshot(project.value))
    }
    ElMessage.success('已取消全部')
  } catch {
    // 用户取消
  }
}

function previewShot(shot: Shot) {
  const segPath = shot.segmentPath
  if (!segPath) {
    ElMessage.warning('视频尚未生成')
    return
  }
  ensureFileUrl(segPath).then(() => {
    previewUrl.value = urlCache[segPath]
    previewVisible.value = true
  })
  contextMenu.value.visible = false
}

function resetShot(shot: Shot) {
  shot.status = 'pending'
  shot.error = undefined
  if (project.value) {
    window.api.project.save(snapshot(project.value))
    ElMessage.success('已重置')
  }
  contextMenu.value.visible = false
}

function viewDetails(shot: Shot) {
  detailShot.value = shot
  detailVisible.value = true
  contextMenu.value.visible = false
}

// 打开分镜产物所在文件夹（在系统资源管理器中定位）
async function openOutputFolder(shot: Shot) {
  const target = shot.segmentPath || shot.rawVideoPath || `projects/${projectId}/segments`
  try {
    await window.api.shell.showItem(target)
  } catch {
    ElMessage.warning('产物文件不存在')
  }
  contextMenu.value.visible = false
}

// 清除所有已完成镜头：重置状态 + 清理旧产物与成片，便于重新批量渲染
async function clearCompleted() {
  if (!project.value) return
  const doneShots = project.value.shots.filter(s => s.status === 'done')
  if (doneShots.length === 0) {
    ElMessage.info('没有已完成的镜头')
    contextMenu.value.visible = false
    return
  }
  try {
    await ElMessageBox.confirm(
      `将重置 ${doneShots.length} 个已完成镜头并删除其渲染产物（成片也会失效），确定继续？`,
      '清除已完成',
      { type: 'warning' }
    )
    for (const s of doneShots) {
      for (const p of [s.audioPath, s.rawVideoPath, s.segmentPath]) {
        if (p) {
          await window.api.file.delete(p).catch(() => {})
          clearFileUrlCache(p)
        }
      }
      s.status = 'pending'
      s.error = undefined
      s.audioPath = undefined
      s.rawVideoPath = undefined
      s.segmentPath = undefined
    }
    const finalRel = `projects/${projectId}/final.mp4`
    await window.api.file.delete(finalRel).catch(() => {})
    clearFileUrlCache(finalRel)
    await window.api.project.save(snapshot(project.value))
    ElMessage.success(`已清除 ${doneShots.length} 个镜头`)
  } catch {
    // 用户取消
  }
  contextMenu.value.visible = false
}

function statusType(status: string) {
  const map: Record<string, string> = { pending: 'info', rendering: 'warning', done: 'success', failed: 'danger' }
  return map[status] || 'info'
}

function statusText(status: string) {
  const map: Record<string, string> = { pending: '排队中', rendering: '渲染中', done: '完成', failed: '失败' }
  return map[status] || status
}
</script>

<style scoped>
.queue-view { padding: 20px; }
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
.header h1 { font-size: 24px; color: var(--text-primary); }
.actions { display: flex; gap: 12px; }

.summary {
  display: flex;
  gap: 24px;
  margin-bottom: 20px;
  padding: 16px;
  background: var(--bg-card);
  border-radius: 8px;
}
.summary-item { display: flex; flex-direction: column; align-items: center; }
.summary-item .label { font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; }
.summary-item .value { font-size: 24px; font-weight: bold; color: var(--text-primary); }
.summary-item .value.success { color: #67c23a; }
.summary-item .value.warning { color: #e6a23c; }
.summary-item .value.info { color: var(--text-muted); }
.summary-item .value.danger { color: #f56c6c; }

.progress-cell { display: flex; flex-direction: column; gap: 4px; }
.progress-msg { font-size: 12px; color: var(--text-secondary); }

/* 右键菜单 */
.context-menu {
  position: fixed;
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  padding: 4px 0;
  min-width: 160px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  z-index: 9999;
}
.menu-item {
  padding: 8px 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: var(--text-primary);
  font-size: 14px;
}
.menu-item:hover { background: var(--border-strong); }
.menu-divider { height: 1px; background: var(--border-strong); margin: 4px 0; }
</style>
