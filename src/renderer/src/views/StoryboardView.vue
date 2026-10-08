<template>
  <div class="storyboard">
    <div class="header">
      <h1>分镜编辑</h1>
      <div class="actions">
        <el-button @click="$router.push(`/project/${projectId}/characters`)">角色库</el-button>
        <el-button type="primary" @click="addShot" :disabled="isRendering">添加分镜</el-button>
        <el-button @click="splitDialogRef?.open()" :disabled="isRendering">
          <el-icon><MagicStick /></el-icon> AI 拆分镜
        </el-button>
        <el-button type="success" @click="startRender" :disabled="!hasPendingShots || isRendering" :loading="rendering">
          {{ rendering ? '渲染中...' : '开始渲染' }}
        </el-button>
      </div>
    </div>

    <el-table
      :data="shots"
      style="width: 100%"
      @row-contextmenu="onRowContextMenu"
      @dragover.prevent
      @drop="onDrop"
    >
      <el-table-column prop="index" label="#" width="60" align="center">
        <template #default="{ row, $index }">
          <span
            class="drag-handle"
            draggable="true"
            @dragstart="onDragStart($index)"
            @dragend="dragIndex = -1"
            title="拖拽排序"
          >⋮⋮</span>
          <span>{{ row.index }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="scene" label="场景" width="120" show-overflow-tooltip />
      <el-table-column prop="action" label="动作提示词" show-overflow-tooltip>
        <template #default="{ row }">
          <span class="prompt-text">{{ row.action }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="dialogue" label="台词" show-overflow-tooltip />
      <el-table-column label="角色" width="140">
        <template #default="{ row }">
          <el-tag v-for="cid in row.characterIds" :key="cid" size="small" style="margin-right:4px">
            {{ getCharacterName(cid) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="类型" width="80" align="center">
        <template #default="{ row }">
          <el-tag :type="row.type === 'i2v' ? 'primary' : 'success'" size="small">
            {{ row.type === 'i2v' ? '人物' : '空镜' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="工作流" width="110" show-overflow-tooltip>
        <template #default="{ row }">
          <span v-if="row.workflow" class="wf-tag">{{ row.workflow }}</span>
          <span v-else class="wf-default">默认</span>
        </template>
      </el-table-column>
      <el-table-column prop="status" label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="statusType(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="140" align="center">
        <template #default="{ row, $index }">
          <el-button link type="primary" size="small" @click.stop="editShot($index)" :disabled="isRendering">编辑</el-button>
          <el-button link type="success" size="small" @click.stop="renderSingle(row)" :disabled="row.status === 'rendering' || isRendering">渲染</el-button>
          <el-button link type="danger" size="small" @click.stop="deleteShot($index)" :disabled="isRendering">删除</el-button>
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
        <div class="menu-item" @click="!isRendering && renderSingle(contextMenu.row!)" :class="{ disabled: isRendering }">
          <el-icon><VideoPlay /></el-icon>渲染此镜
        </div>
        <div class="menu-item" @click="copyPrompt(contextMenu.row!)">
          <el-icon><CopyDocument /></el-icon>复制提示词
        </div>
        <div class="menu-item" @click="!isRendering && copyShot(contextMenu.index)" :class="{ disabled: isRendering }">
          <el-icon><DocumentCopy /></el-icon>复制分镜
        </div>
        <div class="menu-item" @click="!isRendering && clipboardShot && pasteShot(contextMenu.index)" :class="{ disabled: !clipboardShot || isRendering }">
          <el-icon><DocumentCopy /></el-icon>粘贴分镜
        </div>
        <div class="menu-divider" />
        <div class="menu-item" @click="!isRendering && insertShot(contextMenu.index, 'above')" :class="{ disabled: isRendering }">
          <el-icon><Top /></el-icon>上方插入
        </div>
        <div class="menu-item" @click="!isRendering && insertShot(contextMenu.index, 'below')" :class="{ disabled: isRendering }">
          <el-icon><Bottom /></el-icon>下方插入
        </div>
        <div class="menu-divider" />
        <div class="menu-item" @click="!isRendering && moveShot(contextMenu.index, -1)" :class="{ disabled: contextMenu.index === 0 || isRendering }">
          <el-icon><Top /></el-icon>上移
        </div>
        <div class="menu-item" @click="!isRendering && moveShot(contextMenu.index, 1)" :class="{ disabled: contextMenu.index === shots.length - 1 || isRendering }">
          <el-icon><Bottom /></el-icon>下移
        </div>
        <div class="menu-divider" />
        <div class="menu-item" @click="!isRendering && editShot(contextMenu.index)" :class="{ disabled: isRendering }">
          <el-icon><Edit /></el-icon>编辑
        </div>
        <div class="menu-item" @click="!isRendering && resetShot(contextMenu.row!)" :class="{ disabled: isRendering }">
          <el-icon><RefreshLeft /></el-icon>重置状态
        </div>
        <div class="menu-divider" />
        <div class="menu-item danger" @click="!isRendering && deleteShot(contextMenu.index)" :class="{ disabled: isRendering }">
          <el-icon><Delete /></el-icon>删除
        </div>
      </div>
    </teleport>

    <!-- 分镜编辑对话框（独立组件） -->
    <ShotEditDialog
      ref="editDialogRef"
      :project-id="projectId"
      :project-genre="project?.genre || ''"
      :characters="characters"
      :workflows="workflows"
      :default-frames="defaultFrames"
      @save="onSaveShot"
    />

    <!-- AI 拆分镜对话框（独立组件） -->
    <SplitScriptDialog
      ref="splitDialogRef"
      :project-genre="project?.genre || ''"
      @split="onSplitScript"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useHotkeys } from '../composables/useHotkeys'
import { clearFileUrlCache } from '../composables/useFileUrl'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  VideoPlay, CopyDocument, DocumentCopy, Top, Bottom, Edit, RefreshLeft, Delete, MagicStick
} from '@element-plus/icons-vue'
import type { Project, Shot, WorkflowMeta, GeneratedShot } from '../../../shared/ipcTypes'
import { snapshot } from '../utils/snapshot'
import ShotEditDialog, { type ShotDraft } from '../components/storyboard/ShotEditDialog.vue'
import SplitScriptDialog from '../components/storyboard/SplitScriptDialog.vue'

const route = useRoute()
const projectId = route.params.id as string

const project = ref<Project | null>(null)
const workflows = ref<WorkflowMeta[]>([])
const editingIndex = ref(-1)
const rendering = ref(false)
// 渲染默认帧数（从设置加载，新建分镜时使用）
const defaultFrames = ref(81)

// 对话框组件
const editDialogRef = ref<InstanceType<typeof ShotEditDialog> | null>(null)
const splitDialogRef = ref<InstanceType<typeof SplitScriptDialog> | null>(null)

const shots = computed(() => project.value?.shots || [])
const characters = computed(() => project.value?.characters || [])
const hasPendingShots = computed(() =>
  shots.value.some(s => s.status === 'pending' || s.status === 'failed')
)
// 渲染中锁定：有镜头正在渲染时，禁止编辑/删除/拖拽/添加
const isRendering = computed(() => shots.value.some(s => s.status === 'rendering'))

/**
 * 分镜内容变更/删除时使旧产物失效：
 * 删除该镜旧音频/原片/分段，并作废整集成片（final.mp4 包含旧内容）。
 * 各删除项静默忽略不存在的情况。
 */
async function invalidateArtifacts(oldShot: Shot | undefined): Promise<void> {
  if (oldShot) {
    for (const p of [oldShot.audioPath, oldShot.rawVideoPath, oldShot.segmentPath]) {
      if (p) {
        await window.api.file.delete(p).catch(() => {})
        clearFileUrlCache(p)
      }
    }
  }
  const finalRel = `projects/${projectId}/final.mp4`
  await window.api.file.delete(finalRel).catch(() => {})
  clearFileUrlCache(finalRel)
}

// 右键菜单
const contextMenu = ref({ visible: false, x: 0, y: 0, row: null as Shot | null, index: -1 })

// 拖拽排序
const dragIndex = ref(-1)
function onDragStart(index: number) {
  dragIndex.value = index
}
function onDrop(e: DragEvent) {
  if (dragIndex.value === -1 || !project.value) return
  // 通过鼠标 Y 坐标定位目标行
  const rows = Array.from(document.querySelectorAll<HTMLElement>('.el-table__body-wrapper .el-table__row'))
  const targetRow = rows.find(r => {
    const rect = r.getBoundingClientRect()
    return e.clientY >= rect.top && e.clientY <= rect.bottom
  })
  const targetIndex = targetRow ? rows.indexOf(targetRow) : -1
  if (targetIndex === -1 || targetIndex === dragIndex.value) return
  const item = project.value.shots.splice(dragIndex.value, 1)[0]
  project.value.shots.splice(targetIndex, 0, item)
  project.value.shots.forEach((s, i) => s.index = i + 1)
  window.api.project.save(snapshot(project.value))
  dragIndex.value = -1
}

onMounted(async () => {
  loadProject()
  document.addEventListener('click', closeContextMenu)
  // 加载渲染默认帧数与工作流列表
  try {
    const [s, wf] = await Promise.all([
      window.api.settings.get(),
      window.api.workflow.list()
    ])
    if (s?.render?.defaultFrames) defaultFrames.value = s.render.defaultFrames
    workflows.value = wf
  } catch {
    // 保持默认
  }
})

onUnmounted(() => {
  document.removeEventListener('click', closeContextMenu)
})

async function loadProject() {
  project.value = await window.api.project.get(projectId)
}

function addShot() {
  editingIndex.value = -1
  editDialogRef.value?.open(null)
}

// Ctrl+N 新建分镜（渲染中或编辑框已打开时忽略）
useHotkeys([
  {
    keys: 'ctrl+n',
    handler: () => {
      if (isRendering.value || editDialogRef.value?.isVisible) return
      addShot()
    }
  }
])

function editShot(index: number) {
  editingIndex.value = index
  editDialogRef.value?.open(shots.value[index])
  contextMenu.value.visible = false
}

/** 编辑对话框保存：按 editingIndex 组装完整 Shot 并持久化 */
async function onSaveShot(draft: ShotDraft) {
  if (!project.value) return
  const isNew = editingIndex.value === -1
  const shot: Shot = {
    ...draft,
    id: isNew ? `shot_${Date.now()}` : shots.value[editingIndex.value].id,
    index: isNew ? shots.value.length + 1 : shots.value[editingIndex.value].index,
    status: 'pending'
  }

  // 作废旧产物与整集成片（编辑/新增均会改变成片内容）
  const oldShot = isNew ? undefined : shots.value[editingIndex.value]
  await invalidateArtifacts(oldShot)

  if (isNew) {
    project.value.shots.push(shot)
  } else {
    project.value.shots[editingIndex.value] = shot
  }

  await window.api.project.save(snapshot(project.value))
  ElMessage.success('保存成功')
}

/** AI 拆分镜完成：追加到分镜列表并持久化 */
async function onSplitScript(generated: GeneratedShot[]) {
  if (!project.value) return
  const startIndex = project.value.shots.length
  const newShots: Shot[] = generated.map((s, i) => ({
    id: `shot_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
    index: startIndex + i + 1,
    scene: s.scene,
    action: s.action,
    dialogue: s.dialogue,
    type: s.type,
    characterIds: [],
    width: 720,
    height: 480,
    frames: defaultFrames.value,
    seed: Math.floor(Math.random() * 1000000),
    status: 'pending'
  }))
  project.value.shots.push(...newShots)
  await window.api.project.save(snapshot(project.value))
  ElMessage.success(`AI 拆分完成，新增 ${newShots.length} 个分镜`)
}

async function deleteShot(index: number) {
  if (!project.value) return
  try {
    await ElMessageBox.confirm('确定删除这个分镜吗？', '删除确认', { type: 'warning' })
    await invalidateArtifacts(shots.value[index])
    project.value.shots.splice(index, 1)
    project.value.shots.forEach((s, i) => s.index = i + 1)
    await window.api.project.save(snapshot(project.value))
    ElMessage.success('删除成功')
  } catch {
    // 取消
  }
  contextMenu.value.visible = false
}

async function renderSingle(shot: Shot) {
  if (!project.value) return
  rendering.value = true
  try {
    await window.api.render.start(projectId, [shot.id])
    ElMessage.success('开始渲染')
  } catch (e) {
    ElMessage.error('启动渲染失败')
  } finally {
    rendering.value = false
  }
  contextMenu.value.visible = false
}

async function startRender() {
  rendering.value = true
  try {
    await window.api.render.start(projectId)
    ElMessage.success('开始批量渲染')
  } catch (e) {
    ElMessage.error('启动渲染失败')
  } finally {
    rendering.value = false
  }
}

// 右键菜单
function onRowContextMenu(row: Shot, column: unknown, event: MouseEvent) {
  event.preventDefault()
  const index = shots.value.findIndex(s => s.id === row.id)
  contextMenu.value = { visible: true, x: event.clientX, y: event.clientY, row, index }
}

function closeContextMenu() {
  contextMenu.value.visible = false
}

function copyPrompt(shot: Shot) {
  navigator.clipboard.writeText(shot.action)
  ElMessage.success('已复制')
  contextMenu.value.visible = false
}

// 分镜剪贴板（模块级，跨右键菜单存活）
const clipboardShot = ref<Shot | null>(null)

function copyShot(index: number) {
  if (!project.value) return
  clipboardShot.value = { ...shots.value[index] }
  ElMessage.success('已复制')
  contextMenu.value.visible = false
}

function pasteShot(index: number) {
  if (!project.value || !clipboardShot.value) {
    ElMessage.warning('剪贴板为空，请先复制分镜')
    return
  }
  const insertAt = index + 1
  const copy: Shot = {
    ...clipboardShot.value,
    id: `shot_${Date.now()}`,
    index: insertAt + 1,
    status: 'pending',
    audioPath: undefined,
    rawVideoPath: undefined,
    segmentPath: undefined,
    error: undefined
  }
  project.value.shots.splice(insertAt, 0, copy)
  project.value.shots.forEach((s, i) => s.index = i + 1)
  window.api.project.save(snapshot(project.value))
  ElMessage.success('已粘贴')
  contextMenu.value.visible = false
}

// 上方/下方插入空白分镜并立即打开编辑
function insertShot(index: number, position: 'above' | 'below') {
  if (!project.value) return
  const insertAt = position === 'above' ? index : index + 1
  const shot: Shot = {
    id: `shot_${Date.now()}`,
    index: insertAt + 1,
    scene: '',
    action: '',
    dialogue: '',
    type: 'i2v',
    characterIds: [],
    width: 720,
    height: 480,
    frames: defaultFrames.value,
    seed: Math.floor(Math.random() * 1000000),
    status: 'pending'
  }
  project.value.shots.splice(insertAt, 0, shot)
  project.value.shots.forEach((s, i) => s.index = i + 1)
  window.api.project.save(snapshot(project.value))
  // 直接打开编辑框编辑这个新分镜
  editingIndex.value = insertAt
  editDialogRef.value?.open(shot)
  contextMenu.value.visible = false
}

function moveShot(index: number, direction: number) {
  if (!project.value) return
  const newIndex = index + direction
  if (newIndex < 0 || newIndex >= shots.value.length) return
  const temp = project.value.shots[index]
  project.value.shots[index] = project.value.shots[newIndex]
  project.value.shots[newIndex] = temp
  project.value.shots.forEach((s, i) => s.index = i + 1)
  window.api.project.save(snapshot(project.value))
  contextMenu.value.visible = false
}

async function resetShot(shot: Shot) {
  if (!project.value) return
  shot.status = 'pending'
  shot.error = undefined
  await window.api.project.save(snapshot(project.value))
  ElMessage.success('已重置')
  contextMenu.value.visible = false
}

function getCharacterName(id: string) {
  return characters.value.find(c => c.id === id)?.name || '未知'
}

function statusType(status: string) {
  const map: Record<string, string> = { pending: 'info', rendering: 'warning', done: 'success', failed: 'danger' }
  return map[status] || 'info'
}

function statusText(status: string) {
  const map: Record<string, string> = { pending: '待渲染', rendering: '渲染中', done: '完成', failed: '失败' }
  return map[status] || status
}
</script>

<style scoped>
.storyboard { padding: 20px; }
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
.header h1 { font-size: 24px; color: var(--text-primary); }
.actions { display: flex; gap: 10px; }

.prompt-text { font-family: monospace; font-size: 12px; color: var(--text-secondary); }
.wf-tag { font-family: monospace; font-size: 12px; color: #e6a23c; }
.wf-default { font-size: 12px; color: var(--text-muted); }
.drag-handle {
  cursor: grab;
  color: var(--text-muted);
  margin-right: 4px;
  user-select: none;
  font-size: 14px;
  letter-spacing: -2px;
}
.drag-handle:hover { color: #409eff; }
.drag-handle:active { cursor: grabbing; }

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
.menu-item.disabled { opacity: 0.4; cursor: not-allowed; }
.menu-item.disabled:hover { background: transparent; }
.menu-item.danger { color: #f56c6c; }
.menu-divider { height: 1px; background: var(--border-strong); margin: 4px 0; }
</style>
