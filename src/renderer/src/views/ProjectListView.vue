<template>
  <div class="project-list">
    <div class="header">
      <h1>项目列表</h1>
      <div class="actions">
        <el-button @click="checkComfyUI">
          <el-icon><Connection /></el-icon>检测 ComfyUI
        </el-button>
        <el-button type="success" @click="openDirectorDialog">
          <el-icon><VideoCamera /></el-icon>AI 导演
        </el-button>
        <el-button type="primary" @click="showCreateDialog = true">
          <el-icon><Plus /></el-icon>新建项目
        </el-button>
      </div>
    </div>

    <!-- ComfyUI 状态提示 -->
    <el-alert
      v-if="comfyuiStatus !== null"
      :type="comfyuiStatus ? 'success' : 'error'"
      :title="comfyuiStatus ? 'ComfyUI 连接正常' : 'ComfyUI 未连接，请启动后点击检测'"
      show-icon
      :closable="false"
      style="margin-bottom: 16px"
    />

    <!-- 批量操作栏 -->
    <div v-if="selectedProjects.length > 0" class="batch-bar">
      <span class="batch-info">已选 {{ selectedProjects.length }} 个项目</span>
      <el-button size="small" @click="batchDuplicate">
        <el-icon><CopyDocument /></el-icon>批量复制
      </el-button>
      <el-button size="small" @click="batchExport">
        <el-icon><Download /></el-icon>批量导出成片
      </el-button>
      <el-button size="small" type="danger" @click="batchDelete">
        <el-icon><Delete /></el-icon>批量删除
      </el-button>
      <el-button size="small" @click="clearSelection">取消选择</el-button>
    </div>

    <el-table
      ref="tableRef"
      :data="projects"
      style="width: 100%"
      @row-click="openProject"
      @row-contextmenu="onRowContextMenu"
      @selection-change="onSelectionChange"
    >
      <el-table-column type="selection" width="42" align="center" />
      <el-table-column label="封面" width="90" align="center">
        <template #default="{ row }">
          <img
            v-if="urlCache[`projects/${row.id}/thumbnail.jpg`]"
            :src="urlCache[`projects/${row.id}/thumbnail.jpg`]"
            class="thumb"
          />
          <div v-else class="thumb-placeholder">无</div>
        </template>
      </el-table-column>
      <el-table-column prop="title" label="标题" min-width="150" />
      <el-table-column prop="genre" label="题材" width="120" />
      <el-table-column prop="episode" label="集数" width="80" align="center" />
      <el-table-column label="分镜数" width="80" align="center">
        <template #default="{ row }">{{ row.shots.length }}</template>
      </el-table-column>
      <el-table-column prop="status" label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="statusType(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="创建时间" width="160">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="120" align="center">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click.stop="openProject(row)">编辑</el-button>
          <el-button link type="danger" size="small" @click.stop="deleteProject(row)">删除</el-button>
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
        <div class="menu-item" @click="openProject(contextMenu.row!)">
          <el-icon><Edit /></el-icon>打开编辑
        </div>
        <div class="menu-item" @click="renameProject(contextMenu.row!)">
          <el-icon><EditPen /></el-icon>重命名
        </div>
        <div class="menu-item" @click="duplicateProject(contextMenu.row!)">
          <el-icon><CopyDocument /></el-icon>复制项目
        </div>
        <div class="menu-divider" />
        <div class="menu-item" @click="exportProject(contextMenu.row!)">
          <el-icon><Download /></el-icon>导出项目
        </div>
        <div class="menu-item" @click="showInFolder(contextMenu.row!)">
          <el-icon><FolderOpened /></el-icon>在文件夹中显示
        </div>
        <div class="menu-divider" />
        <div class="menu-item danger" @click="deleteProject(contextMenu.row!)">
          <el-icon><Delete /></el-icon>删除项目
        </div>
      </div>
    </teleport>

    <!-- 新建项目对话框 -->
    <el-dialog v-model="showCreateDialog" title="新建项目" width="400px">
      <el-form :model="newProject" label-width="80px">
        <el-form-item label="标题" required>
          <el-input v-model="newProject.title" placeholder="如：第一集 重生" />
        </el-form-item>
        <el-form-item label="题材">
          <el-select v-model="newProject.genre" placeholder="选择或输入题材" filterable allow-create style="width: 100%">
            <el-option
              v-for="t in GENRE_TEMPLATES"
              :key="t.key"
              :label="t.label"
              :value="t.key"
            >
              <span>{{ t.label }}</span>
              <el-tag size="small" style="margin-left: 8px">模板</el-tag>
            </el-option>
          </el-select>
          <div class="form-tip">选择模板题材将在渲染时自动注入风格提示词</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreateDialog = false">取消</el-button>
        <el-button type="primary" @click="createProject">创建</el-button>
      </template>
    </el-dialog>

    <!-- 重命名对话框 -->
    <el-dialog v-model="renameDialog.visible" title="重命名项目" width="300px">
      <el-input v-model="renameDialog.title" placeholder="新标题" />
      <template #footer>
        <el-button @click="renameDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="confirmRename">确定</el-button>
      </template>
    </el-dialog>

    <!-- AI 导演对话框 -->
    <el-dialog v-model="directorDialog.visible" title="AI 导演 · 剧本一键成片" width="640px">
      <el-form label-width="80px">
        <el-form-item label="片名" required>
          <el-input v-model="directorDialog.title" placeholder="如：总裁的隐婚新娘" />
        </el-form-item>
        <el-form-item label="题材">
          <el-select v-model="directorDialog.genre" filterable allow-create style="width: 100%">
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
            v-model="directorDialog.script"
            type="textarea"
            :rows="10"
            placeholder="粘贴完整剧本（含场景、动作、台词），AI 将自动拆分分镜、创建角色、生成定妆图与场景图，逐镜渲染后拼接为成片"
          />
        </el-form-item>
        <el-form-item label="BGM">
          <div class="bgm-row">
            <span class="bgm-name" :class="{ placeholder: !directorDialog.bgmPath }">
              {{ directorDialog.bgmPath || '可选：选择背景音乐' }}
            </span>
            <el-button size="small" @click="selectBgm">选择</el-button>
            <el-button v-if="directorDialog.bgmPath" size="small" link @click="directorDialog.bgmPath = ''">
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
        <el-button @click="directorDialog.visible = false">取消</el-button>
        <el-button
          type="success"
          :loading="directorStarting"
          @click="startDirector"
        >开始制作</el-button>
      </template>
    </el-dialog>

    <!-- AI 导演进度面板 -->
    <el-dialog
      v-model="directorProgressVisible"
      title="AI 导演 · 制作进度"
      width="640px"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
      :show-close="!directorState?.running"
    >
      <div v-if="directorState" class="director-panel">
        <div
          v-for="stage in directorStageList"
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

        <div v-if="!directorState.running" class="director-summary">
          <template v-if="directorState.finalPath">
            <el-alert
              :title="`成片已生成（成功 ${directorState.doneShots}/${directorState.totalShots} 镜，复审已通过）`"
              type="success"
              :closable="false"
              show-icon
              style="margin: 8px 0 12px"
            />
            <div v-if="directorState.failedShotIds.length" class="failed-list">
              失败镜头编号：
              <el-tag
                v-for="id in directorState.failedShotIds"
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
            <div v-if="directorState.reviewIssues?.length" class="failed-list">
              <div style="margin-bottom: 4px">复审意见：</div>
              <div
                v-for="(issue, i) in directorState.reviewIssues"
                :key="i"
                class="review-issue"
              >{{ issue }}</div>
            </div>
          </template>
        </div>
      </div>
      <template #footer>
        <el-button
          v-if="directorState?.running"
          type="danger"
          @click="cancelDirector"
        >取消制作</el-button>
        <template v-else>
          <el-button
            v-if="directorState?.finalPath"
            @click="locateFinal"
          >在文件夹中显示</el-button>
          <el-button
            type="primary"
            @click="goResult"
          >前往成片页</el-button>
        </template>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useHotkeys } from '../composables/useHotkeys'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Plus, Edit, EditPen, CopyDocument, Download, FolderOpened, Delete, Connection,
  VideoCamera, CircleCheckFilled, CircleCloseFilled, Loading, RemoveFilled, MoreFilled
} from '@element-plus/icons-vue'
import type { Project, DirectorState, DirectorStage, DirectorProgressEvent } from '../../../shared/ipcTypes'
import { GENRE_TEMPLATES } from '../../../shared/ipcTypes'
import { snapshot } from '../utils/snapshot'
import { useFileUrl, clearFileUrlCache } from '../composables/useFileUrl'

const { urlCache, ensureFileUrl, ensureFileUrls } = useFileUrl()

const router = useRouter()
const projects = ref<Project[]>([])
const showCreateDialog = ref(false)

// Ctrl+N 新建项目
useHotkeys([
  { keys: 'ctrl+n', handler: () => { showCreateDialog.value = true } }
])
const newProject = ref({ title: '', genre: '' })
const comfyuiStatus = ref<boolean | null>(null)
const selectedProjects = ref<Project[]>([])
const tableRef = ref()

// 右键菜单
const contextMenu = ref({ visible: false, x: 0, y: 0, row: null as Project | null })
const renameDialog = ref({ visible: false, title: '', project: null as Project | null })

// ===== AI 导演 =====
const directorDialog = ref({
  visible: false,
  title: '',
  genre: '',
  script: '',
  bgmPath: ''
})
const directorStarting = ref(false)
const directorProgressVisible = ref(false)
const directorState = ref<DirectorState | null>(null)
const currentDirectorId = ref('')
let unsubDirector: (() => void) | null = null

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

const directorStageList = computed(() =>
  STAGE_LABEL_LIST.map(s => ({
    ...s,
    data: directorState.value!.stages[s.key]
  }))
)

function openDirectorDialog(): void {
  directorDialog.value = {
    visible: true,
    title: '',
    genre: '',
    script: '',
    bgmPath: ''
  }
}

async function selectBgm(): Promise<void> {
  const p = await window.api.dialog.selectAudio()
  if (p) directorDialog.value.bgmPath = p
}

async function startDirector(): Promise<void> {
  const d = directorDialog.value
  if (!d.title.trim()) { ElMessage.warning('请输入片名'); return }
  if (!d.script.trim()) { ElMessage.warning('请粘贴剧本'); return }

  // 订阅进度：先清理上一次的订阅，避免重复发起时监听器叠加
  unsubDirector?.()
  unsubDirector = window.api.director.onProgress((e: DirectorProgressEvent) => {
    if (e.projectId !== currentDirectorId.value) return
    directorState.value = e.state
  })

  directorStarting.value = true
  try {
    const projectId = await window.api.director.start({
      title: d.title.trim(),
      genre: d.genre,
      script: d.script,
      bgmAbsolutePath: d.bgmPath || undefined
    })
    currentDirectorId.value = projectId
    // 主进程在 start 返回前已发出首个事件（此时还拿不到 projectId 会被过滤），
    // 主动拉取一次当前状态补齐，避免进度面板首阶段空白
    directorState.value = await window.api.director.getState(projectId)
    directorDialog.value.visible = false
    directorProgressVisible.value = true
    loadProjects()
  } catch (e) {
    ElMessage.error('启动失败：' + (e instanceof Error ? e.message : String(e)))
    unsubDirector?.()
    unsubDirector = null
  } finally {
    directorStarting.value = false
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
  await window.api.director.cancel(currentDirectorId.value)
}

/** 失败镜头 id → 镜头序号（用于汇总展示） */
function shotIndexById(id: string): number {
  const p = projects.value.find(x => x.id === currentDirectorId.value)
  const idx = p?.shots.find(s => s.id === id)?.index
  return idx ?? 0
}

function locateFinal(): void {
  if (directorState.value?.finalPath) {
    window.api.shell.showItem(directorState.value.finalPath)
  }
}

function goResult(): void {
  directorProgressVisible.value = false
  router.push(`/project/${currentDirectorId.value}/result`)
}

onMounted(() => {
  loadProjects()
  checkComfyUI()
  document.addEventListener('click', closeContextMenu)
})

onUnmounted(() => {
  document.removeEventListener('click', closeContextMenu)
  unsubDirector?.()
  unsubDirector = null
})

async function loadProjects() {
  try {
    projects.value = await window.api.project.list()
    // 仅对存在的缩略图解析 URL，避免破图
    const checks = await Promise.all(
      projects.value.map(p => window.api.file.exists(`projects/${p.id}/thumbnail.jpg`))
    )
    const existingThumbs = projects.value
      .filter((_, i) => checks[i])
      .map(p => `projects/${p.id}/thumbnail.jpg`)
    await ensureFileUrls(existingThumbs)
  } catch (e) {
    ElMessage.error('加载项目失败')
  }
}

async function checkComfyUI() {
  comfyuiStatus.value = await window.api.comfyui.healthCheck()
}

async function createProject() {
  if (!newProject.value.title.trim()) {
    ElMessage.warning('请输入标题')
    return
  }
  try {
    await window.api.project.create(newProject.value.title, newProject.value.genre)
    showCreateDialog.value = false
    newProject.value = { title: '', genre: '' }
    loadProjects()
    ElMessage.success('创建成功')
  } catch (e) {
    ElMessage.error('创建失败')
  }
}

function openProject(row: Project, column?: { type?: string }) {
  // 点击选择列时不打开项目
  if (column?.type === 'selection') return
  contextMenu.value.visible = false
  router.push(`/project/${row.id}/storyboard`)
}

// 右键菜单
function onRowContextMenu(row: Project, column: unknown, event: MouseEvent) {
  event.preventDefault()
  contextMenu.value = { visible: true, x: event.clientX, y: event.clientY, row }
}

function closeContextMenu() {
  contextMenu.value.visible = false
}

async function renameProject(project: Project) {
  renameDialog.value = { visible: true, title: project.title, project }
}

async function confirmRename() {
  const { project, title } = renameDialog.value
  if (!project || !title.trim()) return
  project.title = title
  await window.api.project.save(snapshot(project))
  renameDialog.value.visible = false
  loadProjects()
  ElMessage.success('重命名成功')
}

async function duplicateProject(project: Project) {
  try {
    await window.api.project.duplicate(project.id)
    loadProjects()
    ElMessage.success('复制成功')
  } catch {
    ElMessage.error('复制失败')
  }
}

async function exportProject(project: Project) {
  const finalRel = `projects/${project.id}/final.mp4`
  if (!(await window.api.file.exists(finalRel))) {
    ElMessage.warning('该项目尚无成片，请先渲染并在「成片预览」中合成')
    return
  }
  const target = await window.api.dialog.saveFile(`${project.title}.mp4`)
  if (!target) return
  try {
    await window.api.file.copy(finalRel, target)
    ElMessage.success('导出成功')
  } catch {
    ElMessage.error('导出失败')
  }
}

async function showInFolder(project: Project) {
  await window.api.shell.showItem(`projects/${project.id}/project.json`)
}

async function deleteProject(project: Project) {
  try {
    await ElMessageBox.confirm(`确定删除「${project.title}」吗？此操作不可恢复。`, '删除确认', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
    await window.api.project.delete(project.id)
    clearFileUrlCache(`projects/${project.id}/`)
    loadProjects()
    ElMessage.success('删除成功')
  } catch {
    // 用户取消
  }
}

// ===== 批量操作 =====
function onSelectionChange(rows: Project[]) {
  selectedProjects.value = rows
}

function clearSelection() {
  tableRef.value?.clearSelection()
}

async function batchDuplicate() {
  const n = selectedProjects.value.length
  if (n === 0) return
  try {
    await ElMessageBox.confirm(`确定复制选中的 ${n} 个项目吗？`, '批量复制', {
      confirmButtonText: '复制',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  let ok = 0
  for (const p of selectedProjects.value) {
    try {
      await window.api.project.duplicate(p.id)
      ok++
    } catch (e) {
      console.error('批量复制失败:', p.title, e)
    }
  }
  clearSelection()
  loadProjects()
  if (ok === n) {
    ElMessage.success(`成功复制 ${ok} 个项目`)
  } else {
    ElMessage.warning(`成功复制 ${ok}/${n} 个项目，部分失败`)
  }
}

async function batchExport() {
  const targets = selectedProjects.value.filter(p => p.status === 'done')
  const noFinal = selectedProjects.value.filter(p => p.status !== 'done')
  if (noFinal.length > 0) {
    ElMessage.warning(`${noFinal.length} 个项目无成片，已跳过`)
  }
  if (targets.length === 0) {
    ElMessage.warning('选中项目均无成片可导出')
    return
  }
  const dir = await window.api.dialog.selectDirectory()
  if (!dir) return
  let ok = 0
  for (const p of targets) {
    try {
      const finalRel = `projects/${p.id}/final.mp4`
      const safeName = p.title.replace(/[\\/:*?"<>|]/g, '_')
      await window.api.file.copy(finalRel, `${dir}\\${safeName}.mp4`)
      ok++
    } catch {
      // 单个失败继续
    }
  }
  ElMessage.success(`成功导出 ${ok}/${targets.length} 个成片`)
}

async function batchDelete() {
  const n = selectedProjects.value.length
  if (n === 0) return
  try {
    await ElMessageBox.confirm(
      `确定删除选中的 ${n} 个项目吗？所有角色、分镜、渲染产物将被永久删除，此操作不可恢复。`,
      '批量删除确认',
      { confirmButtonText: '全部删除', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  let ok = 0
  for (const p of selectedProjects.value) {
    try {
      await window.api.project.delete(p.id)
      clearFileUrlCache(`projects/${p.id}/`)
      ok++
    } catch {
      // 单个失败继续
    }
  }
  clearSelection()
  loadProjects()
  ElMessage.success(`成功删除 ${ok}/${n} 个项目`)
}

function statusType(status: string) {
  const map: Record<string, string> = { draft: 'info', rendering: 'warning', done: 'success', failed: 'danger' }
  return map[status] || 'info'
}

function statusText(status: string) {
  const map: Record<string, string> = { draft: '草稿', rendering: '渲染中', done: '完成', failed: '失败' }
  return map[status] || status
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleString('zh-CN')
}
</script>

<style scoped>
.project-list { padding: 20px; }

.batch-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--bg-card);
  border: 1px solid #2a4a6a;
  border-radius: 6px;
  padding: 10px 16px;
  margin-bottom: 16px;
}
.batch-info { color: #6ea8d8; font-size: 13px; margin-right: 8px; }
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
.header h1 { font-size: 24px; color: var(--text-primary); }
.actions { display: flex; gap: 12px; }

.thumb {
  width: 72px;
  height: 48px;
  object-fit: cover;
  border-radius: 4px;
  display: block;
  margin: 0 auto;
}
.thumb-placeholder {
  width: 72px;
  height: 48px;
  border-radius: 4px;
  background: var(--bg-card);
  color: var(--text-muted);
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto;
}

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
.menu-item.danger { color: #f56c6c; }
.menu-divider { height: 1px; background: var(--border-strong); margin: 4px 0; }

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
