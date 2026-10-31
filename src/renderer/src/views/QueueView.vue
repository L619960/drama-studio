<template>
  <div class="queue-view page">
    <div class="page-header">
      <div>
        <h1>渲染队列</h1>
        <p class="subtitle">实时跟踪每镜进度与失败原因</p>
      </div>
      <div class="page-actions">
        <el-button
          v-if="allDone"
          type="success"
          @click="router.push(`/project/${projectId}/result`)"
        >
          <el-icon><VideoPlay /></el-icon>去成片预览
        </el-button>
        <el-button @click="refresh" :loading="refreshing">
          <el-icon><Refresh /></el-icon>刷新
        </el-button>
        <el-button @click="clearCompleted" :disabled="doneCount === 0" :loading="clearing">
          <el-icon><RefreshLeft /></el-icon>清除已完成
        </el-button>
        <el-button type="danger" @click="cancelRender" :disabled="!hasRendering" :loading="cancellingAll">
          <el-icon><CircleClose /></el-icon>取消全部
        </el-button>
      </div>
    </div>

    <el-alert
      v-if="allDone"
      type="success"
      show-icon
      :closable="false"
      class="done-banner"
      title="全部镜头已渲染完成，可以前往成片预览合成导出"
    >
      <el-button type="success" link size="small" @click="router.push(`/project/${projectId}/result`)">
        去成片预览
      </el-button>
    </el-alert>

    <!-- 进度总览 -->
    <div class="summary glass-panel" v-if="shots.length > 0">
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
      <div class="summary-item" v-if="taskActive && etaText">
        <span class="label">预计</span>
        <span class="value info">{{ etaText }}</span>
      </div>
    </div>

    <el-empty
      v-if="project && shots.length === 0"
      description="暂无镜头，请先在分镜编辑中添加并开始渲染"
    >
      <el-button type="primary" @click="router.push(`/project/${projectId}/storyboard`)">
        去分镜编辑
      </el-button>
    </el-empty>

    <div v-else-if="shots.length > 0" class="glass-panel table-shell">
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
              v-if="getProgress(row) !== null"
              :percentage="getProgress(row) ?? 0"
              :status="row.status === 'failed' ? 'exception' : row.status === 'done' ? 'success' : ''"
              :stroke-width="8"
            />
            <!-- 已入队但还没收到进度事件：显示不确定态，避免「0% 卡死」错觉 -->
            <el-progress
              v-else
              :percentage="0"
              :indeterminate="true"
              :show-text="false"
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
        <template #default="{ row }">
          <span>{{ row.error || '-' }}</span>
          <div v-if="row.status === 'failed'" class="error-guide">
            <span v-if="row.errorKind" class="error-kind">{{ errorKindHint(row.errorKind) }}</span>
            <span v-if="retryBadge(row)" class="retry-badge">{{ retryBadge(row) }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="140" align="center">
        <template #default="{ row }">
          <el-button
            v-if="row.status === 'failed'"
            link
            type="primary"
            size="small"
            :loading="retryingId === row.id"
            @click.stop="retryShot(row)"
          >
重试
</el-button>
          <el-button
            v-if="row.status === 'rendering'"
            link
            type="danger"
            size="small"
            @click.stop="cancelShot(row)"
          >
取消
</el-button>
          <el-button
            v-if="row.status === 'done' && row.segmentPath"
            link
            type="success"
            size="small"
            @click.stop="previewShot(row)"
          >
预览
</el-button>
        </template>
      </el-table-column>
    </el-table>
    </div>

    <!-- 右键菜单（REQ-14：复用全局 ContextMenu，自带 Esc/失焦/边缘钳位） -->
    <ContextMenu ref="menuRef" :items="menuItems" />

    <!-- 详情对话框 -->
    <el-dialog v-model="detailVisible" title="分镜详情" width="600px">
      <el-descriptions :column="2" border v-if="detailShot">
        <el-descriptions-item label="场景">{{ detailShot.scene }}</el-descriptions-item>
        <el-descriptions-item label="状态">{{ statusText(detailShot.status) }}</el-descriptions-item>
        <el-descriptions-item label="类型">{{ detailShot.type === 'i2v' ? '人物' : '空镜' }}</el-descriptions-item>
        <el-descriptions-item label="帧数">{{ detailShot.frames }}</el-descriptions-item>
        <el-descriptions-item label="Seed">{{ detailShot.seed }}</el-descriptions-item>
        <el-descriptions-item label="场景板" v-if="detailShot.sceneBoardId">
          {{ sceneBoardName(detailShot.sceneBoardId) }}
        </el-descriptions-item>
        <el-descriptions-item label="资产预览" :span="2" v-if="detailAssetPaths(detailShot).length">
          <div class="detail-assets">
            <div v-for="a in detailAssetPaths(detailShot)" :key="a.path" class="detail-asset">
              <img v-if="urlCache[a.path]" :src="urlCache[a.path]" :alt="a.label" />
              <span>{{ a.label }}</span>
            </div>
          </div>
        </el-descriptions-item>
        <el-descriptions-item label="口型" v-if="detailShot.renderProfile">
          {{
            detailShot.renderProfile.lipSync === 'native' ? 'H3 原生'
              : detailShot.renderProfile.lipSync === 'latentsync' ? 'LatentSync'
                : '未做 / 已跳过'
          }}
        </el-descriptions-item>
        <el-descriptions-item
          label="口型回退"
          :span="2"
          v-if="detailShot.renderProfile?.lipSyncFallback"
        >
          <span style="color: #e6a23c">{{ detailShot.renderProfile.lipSyncFallback }}</span>
        </el-descriptions-item>
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
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Refresh, CircleClose, RefreshLeft, VideoPlay, Document, FolderOpened, Remove } from '@element-plus/icons-vue'
import type { Project, Shot, ProgressEvent } from '../../../shared/ipcTypes'
import { useFileUrl, clearFileUrlCache } from '../composables/useFileUrl'
import { errorKindHint, retryBadge } from '../utils/errorGuide'
import { useRouteProjectId } from '../composables/useRouteProjectId'
import { useTaskBoard } from '../composables/useTaskBoard'
import { snapshot } from '../utils/snapshot'
import { throttleTap } from '../utils/throttle'
import { statusTagType as statusType, shotStatusText } from '../utils/status'
import { confirmDanger, confirmAction } from '../utils/confirm'
import { confirmUnreviewedRender } from '../utils/renderGate'
import { showUndoToast } from '../utils/undoToast'
import ContextMenu, { type CtxItem } from '../components/ContextMenu.vue'

const { urlCache, ensureFileUrl, ensureFileUrls } = useFileUrl()

const router = useRouter()
const project = ref<Project | null>(null)
// 必须在 useRouteProjectId 之前声明：immediate watch 会同步清进度表
const progressMap = ref<Record<string, { percent: number; message: string }>>({})
const projectId = useRouteProjectId((id) => {
  progressMap.value = {}
  void loadProject(id)
})

const previewVisible = ref(false)
const previewUrl = ref('')
const detailVisible = ref(false)
const detailShot = ref<Shot | null>(null)

// 异步操作 loading 态（P1：补视觉反馈）
const refreshing = ref(false)
const clearing = ref(false)
const cancellingAll = ref(false)
const retryingId = ref<string | null>(null)

// 右键菜单（REQ-14：全局 ContextMenu 组件）
const menuRef = ref<InstanceType<typeof ContextMenu> | null>(null)
const menuRow = ref<Shot | null>(null)
/** 菜单项随当前行状态动态生成；菜单项与层级与原自绘菜单保持一致 */
const menuItems = computed<CtxItem[]>(() => {
  const row = menuRow.value
  if (!row) return []
  const items: CtxItem[] = []
  if (row.status === 'failed') {
    items.push({ label: '重试', icon: RefreshLeft, action: (d) => void retryShot(d as Shot) })
  }
  if (row.status === 'rendering') {
    items.push({ label: '取消', icon: CircleClose, action: (d) => void cancelShot(d as Shot) })
  }
  if (row.status === 'rendering' || row.status === 'failed') {
    items.push({ label: '跳过此镜', icon: Remove, action: (d) => void skipShot(d as Shot) })
  }
  if (row.status === 'done') {
    items.push({ label: '预览', icon: VideoPlay, action: (d) => void previewShot(d as Shot) })
  }
  if (row.status !== 'pending') items.push({ divider: true })
  items.push({ label: '重置状态', icon: Refresh, action: (d) => void resetShot(d as Shot) })
  items.push({ divider: true })
  items.push({ label: '查看详情', icon: Document, action: (d) => viewDetails(d as Shot) })
  items.push({
    label: '打开输出目录',
    icon: FolderOpened,
    disabled: !row.segmentPath,
    action: (d) => openOutputFolder(d as Shot)
  })
  return items
})

const shots = computed(() => project.value?.shots || [])
/** 队列快照（REQ-01）：正渲哪镜/排队数/ETA，进页即可回答「还要等多久」 */
const taskBoard = useTaskBoard()
const taskActive = taskBoard.isActive
const etaText = taskBoard.etaText
const hasRendering = computed(() => shots.value.some(s => s.status === 'rendering'))
const doneCount = computed(() => shots.value.filter(s => s.status === 'done').length)
const renderingCount = computed(() => shots.value.filter(s => s.status === 'rendering').length)
const pendingCount = computed(() => shots.value.filter(s => s.status === 'pending').length)
const failedCount = computed(() => shots.value.filter(s => s.status === 'failed').length)
const allDone = computed(() =>
  shots.value.length > 0 && doneCount.value === shots.value.length
)

let unsubscribe: (() => void) | null = null
/** done/failed 事件的全量重载防抖：批量渲染 20 镜会连续触发 20 次，合并为一次 */
let reloadTimer: number | null = null

onMounted(async () => {
  taskBoard.subscribe()
  unsubscribe = window.api.onProgress((e: ProgressEvent) => {
    if (e.projectId !== projectId.value) return
    progressMap.value[e.shotId] = { percent: e.percent, message: e.message }
    const shot = project.value?.shots.find(s => s.id === e.shotId)
    if (shot && e.step !== 'done' && e.step !== 'failed') shot.status = 'rendering'
    if (e.step === 'done' || e.step === 'failed') {
      if (reloadTimer !== null) clearTimeout(reloadTimer)
      reloadTimer = window.setTimeout(() => {
        reloadTimer = null
        void loadProject()
      }, 300)
    }
  })
})

onUnmounted(() => {
  unsubscribe?.()
  taskBoard.unsubscribeAll()
  if (reloadTimer !== null) clearTimeout(reloadTimer)
})

async function loadProject(id?: string) {
  const pid = id ?? projectId.value
  const p = await window.api.project.get(pid).catch(() => null)
  // 项目已被删除（或 id 非法）：避免对 null 解引用白屏，回项目列表
  if (!p) {
    ElMessage.error('项目不存在或已被删除')
    void router.replace('/')
    return
  }
  project.value = p
  // 解析已完成镜头的分段 URL（预览/详情使用）
  const paths = project.value.shots
    .filter(s => s.status === 'done' && s.segmentPath)
    .map(s => s.segmentPath) as string[]
  await ensureFileUrls(paths)
}

async function refresh() {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await loadProject()
  } finally {
    refreshing.value = false
  }
}

// F5 刷新队列状态
useHotkeys([
  { keys: 'f5', handler: () => refresh() }
])

/**
 * 进度值：渲染中但尚未收到首个进度事件时返回 null，
 * 模板据此显示 indeterminate 进度条而不是「0% 卡死」（REQ-01 RC-14）。
 */
function getProgress(shot: Shot): number | null {
  const p = progressMap.value[shot.id]
  if (p) return p.percent
  if (shot.status === 'done') return 100
  if (shot.status === 'failed') return 0
  if (shot.status === 'rendering') return null
  return 0
}

function getMessage(shot: Shot) {
  const p = progressMap.value[shot.id]
  if (p) return p.message
  if (shot.status === 'done') return '完成'
  if (shot.status === 'failed') return '失败'
  if (shot.status === 'rendering') return '渲染中…'
  return '等待中'
}

// 右键菜单
function onRowContextMenu(row: Shot, column: unknown, event: MouseEvent) {
  event.preventDefault()
  menuRow.value = row
  menuRef.value?.open(event, row)
}

/** 菜单关闭：ContextMenu 自身在点击项/外部点击/Esc 时会关闭，这里保留显式关闭给表格按钮路径复用 */
function closeContextMenu() {
  menuRef.value?.close()
}

async function retryShot(shot: Shot) {
  closeContextMenu()
  if (!throttleTap('queue-retry-' + shot.id, 1500)) return
  if (project.value && !(await confirmUnreviewedRender(project.value, [shot.id]))) return
  retryingId.value = shot.id
  delete progressMap.value[shot.id]
  try {
    // R-10：先启动成功再改状态落盘——此前先改 pending 并保存，start 抛错时
    // 界面停留"排队中"的假状态，与主进程不一致
    const res = await window.api.render.start(projectId.value, [shot.id], false)
    shot.status = 'pending'
    shot.error = undefined
    if (project.value) await window.api.project.save(snapshot(project.value))
    if (res.warnedShots.length > 0) {
      ElMessage.warning(`第 ${shot.index} 镜尚未核对分镜图，已按「告警放行」入队渲染`)
    } else {
      ElMessage.success('已加入队列')
    }
  } catch (e) {
    ElMessage.error(`加入队列失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    retryingId.value = null
  }
}

async function cancelShot(shot: Shot) {
  closeContextMenu()
  const ok = await confirmAction('确定取消此镜头的渲染吗？', {
    title: '取消渲染',
    confirmText: '取消渲染',
    cancelText: '继续渲染'
  })
  if (!ok) return
  try {
    await window.api.render.cancel(projectId.value, shot.id)
    await loadProject()
    ElMessage.success('已取消')
  } catch (e) {
    ElMessage.error(`取消失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

async function skipShot(shot: Shot) {
  closeContextMenu()
  const ok = await confirmDanger(
    `跳过第 ${shot.index} 镜？将取消其渲染并标记「跳过」，拼接成片时不再包含该镜，队列继续后续镜头。`,
    { title: '跳过此镜', confirmText: '跳过', cancelText: '取消' }
  )
  if (!ok) return
  try {
    await window.api.render.skipCurrent(projectId.value, shot.id)
    delete progressMap.value[shot.id]
    await loadProject()
    ElMessage.success(`第 ${shot.index} 镜已跳过，队列继续后续镜头`)
  } catch (e) {
    ElMessage.error(`跳过失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

async function cancelRender() {
  const ok = await confirmAction('确定取消所有渲染任务吗？', {
    title: '取消全部',
    confirmText: '取消全部渲染',
    cancelText: '继续渲染'
  })
  if (!ok) return
  // REQ-16：暂存取消前在队列中的镜头，供撤销时重新入队
  const cancelledIds = shots.value
    .filter(s => s.status === 'pending' || s.status === 'rendering')
    .map(s => s.id)
  cancellingAll.value = true
  try {
    await window.api.render.cancel(projectId.value)
    // R-17：不再前端自行改写状态并整体保存项目（与主进程落盘竞态、后写者胜），
    // 取消后重新拉取，以主进程状态为准
    await loadProject()
    showUndoToast('已取消全部渲染任务', async () => {
      if (cancelledIds.length === 0) return
      try {
        await window.api.render.start(projectId.value, cancelledIds, false)
        await loadProject()
        ElMessage.success(`已撤销取消，${cancelledIds.length} 个镜头重新入队`)
      } catch (e) {
        ElMessage.error(`撤销失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }, () => {})
  } finally {
    cancellingAll.value = false
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
  closeContextMenu()
}

async function resetShot(shot: Shot) {
  closeContextMenu()
  // 仅对已完成/失败的镜头需确认重置（pending 本身无需确认）
  if (shot.status === 'done' || shot.status === 'failed') {
    const ok = await confirmDanger(
      '将该镜头重置为待渲染：已完成的产物保留，但下次渲染会重新生成并覆盖。确定重置？',
      { title: '重置状态', confirmText: '重置', cancelText: '取消' }
    )
    if (!ok) return
  }
  delete progressMap.value[shot.id]
  shot.status = 'pending'
  shot.error = undefined
  if (project.value) {
    try {
      await window.api.project.save(snapshot(project.value))
      ElMessage.success('已重置')
    } catch (e) {
      ElMessage.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

function sceneBoardName(id: string): string {
  return (project.value?.sceneBoards || []).find(b => b.id === id)?.name || id
}

function detailAssetPaths(shot: Shot): Array<{ label: string; path: string }> {
  const board = (project.value?.sceneBoards || []).find(b => b.id === shot.sceneBoardId)
  const items: Array<{ label: string; path: string }> = []
  if (shot.firstFramePath) items.push({ label: '首帧', path: shot.firstFramePath })
  if (shot.lastFramePath) items.push({ label: '尾帧', path: shot.lastFramePath })
  if (shot.sceneImagePath) items.push({ label: '场景图', path: shot.sceneImagePath })
  else if (board?.emptyPlatePath) items.push({ label: '场景板', path: board.emptyPlatePath })
  return items
}

async function viewDetails(shot: Shot) {
  detailShot.value = shot
  detailVisible.value = true
  closeContextMenu()
  await ensureFileUrls(detailAssetPaths(shot).map(a => a.path))
}

// 打开分镜产物所在文件夹（在系统资源管理器中定位）
async function openOutputFolder(shot: Shot) {
  const target = shot.segmentPath || shot.rawVideoPath || `projects/${projectId.value}/segments`
  try {
    await window.api.shell.showItem(target)
  } catch {
    ElMessage.warning('产物文件不存在')
  }
  closeContextMenu()
}

// 清除所有已完成镜头：重置状态 + 清理旧产物与成片，便于重新批量渲染
async function clearCompleted() {
  if (!project.value) return
  const doneShots = project.value.shots.filter(s => s.status === 'done')
  closeContextMenu()
  if (doneShots.length === 0) {
    ElMessage.info('没有已完成的镜头')
    return
  }
  const ok = await confirmDanger(
    `将重置 ${doneShots.length} 个已完成镜头并删除其渲染产物（成片也会失效），确定继续？`,
    { title: '清除已完成', confirmText: '清除', cancelText: '取消' }
  )
  if (!ok) return
  clearing.value = true
  try {
    for (const s of doneShots) {
      // R-16：清掉旧进度条目，避免重试后进度列显示旧 100% 与旧消息
      delete progressMap.value[s.id]
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
    const finalRel = `projects/${projectId.value}/final.mp4`
    await window.api.file.delete(finalRel).catch(() => {})
    clearFileUrlCache(finalRel)
    await window.api.project.save(snapshot(project.value))
    ElMessage.success(`已清除 ${doneShots.length} 个镜头`)
  } finally {
    clearing.value = false
  }
}

function statusText(status: string): string {
  return shotStatusText(status, '排队中')
}
</script>

<style scoped>
.done-banner { margin-bottom: 16px; }
.table-shell { padding: 8px 4px 4px; overflow: hidden; }

.summary {
  display: flex;
  gap: 8px;
  margin-bottom: 20px;
  padding: 16px 12px;
  flex-wrap: wrap;
}
.summary-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 1;
  min-width: 72px;
  padding: 8px;
  border-radius: var(--radius-sm);
  transition: background var(--dur-fast) var(--ease-out);
}
.summary-item:hover { background: var(--bg-hover); }
.summary-item .label { font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; }
.summary-item .value {
  font-family: var(--font-display);
  font-size: 26px;
  font-weight: 650;
  color: var(--text-primary);
}
.summary-item .value.success { color: var(--accent); }
.summary-item .value.warning { color: var(--warning); }
.summary-item .value.info { color: var(--text-muted); }
.summary-item .value.danger { color: var(--danger); }

.progress-cell { display: flex; flex-direction: column; gap: 4px; }
.progress-msg { font-size: 12px; color: var(--text-secondary); }
.error-guide { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 2px; }
.error-kind { font-size: 12px; color: var(--warning); }
.retry-badge { font-size: 12px; color: var(--danger); }
.detail-assets { display: flex; gap: 10px; flex-wrap: wrap; }
.detail-asset { display: flex; flex-direction: column; align-items: center; gap: 4px; font-size: 12px; color: var(--text-secondary); }
.detail-asset img {
  width: 72px; height: 96px; object-fit: cover; border-radius: 8px;
  border: 1px solid var(--border-strong); background: var(--bg-input);
}
</style>
