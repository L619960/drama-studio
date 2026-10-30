<template>
  <div class="project-list page">
    <div class="page-header">
      <div>
        <h1>项目</h1>
        <p class="subtitle">从剧本到成片的本地短剧工作台</p>
      </div>
      <div class="page-actions">
        <el-select v-model="sortMode" style="width: 124px" title="排序方式">
          <el-option v-for="o in PROJECT_SORT_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
        <el-input v-model="searchKw" placeholder="搜索片名/剧本关键词" clearable style="width: 220px" :prefix-icon="Search" />
        <el-button :loading="checkingComfy" @click="checkComfyUI">
          <el-icon><Connection /></el-icon>{{ checkingComfy ? '检测中...' : '检测 ComfyUI' }}
        </el-button>
        <el-button type="success" @click="directorFlowRef?.open()">
          <el-icon><VideoCamera /></el-icon>AI 导演
        </el-button>
        <el-button type="primary" @click="showCreateDialog = true">
          <el-icon><Plus /></el-icon>新建项目
        </el-button>
      </div>
    </div>

    <el-alert
      v-if="comfyuiStatus !== null"
      :type="comfyuiStatus ? 'success' : 'error'"
      :title="comfyuiStatus ? 'ComfyUI 连接正常' : 'ComfyUI 未连接，请启动后点击检测'"
      show-icon
      :closable="false"
      class="page-section"
    />

    <!-- REQ-03：重启后中断的任务可一键从断点继续 -->
    <el-alert
      v-if="interruptedTasks.length > 0"
      class="page-section interrupted-banner"
      type="warning"
      :closable="false"
      show-icon
      title="以下任务在应用重启时中断，已完成的产物均保留，可从断点继续"
    >
      <div v-for="t in interruptedTasks" :key="t.projectId" class="interrupted-item">
        <span class="interrupted-name">{{ t.projectName }}</span>
        <span class="interrupted-reason">{{ t.reason }}</span>
        <el-button
          v-if="t.interruptedStage"
          size="small"
          type="primary"
          :icon="RefreshRight"
          :loading="resumingId === t.projectId"
          @click="resumeInterrupted(t)"
        >
          从「{{ STAGE_LABELS[t.interruptedStage] }}」继续
        </el-button>
        <el-button
          v-else
          size="small"
          type="primary"
          :icon="RefreshRight"
          :loading="resumingId === t.projectId"
          @click="resumeInterrupted(t)"
        >
          去项目页继续
        </el-button>
        <el-button
          v-if="t.interruptedStage"
          size="small"
          link
          type="primary"
          :disabled="resumingId === t.projectId"
          @click="openProjectById(t.projectId)"
        >
          打开项目
        </el-button>
      </div>
    </el-alert>

    <!-- 加载中：骨架屏替代裸转圈 -->
    <div v-if="!projectsLoaded" class="project-grid">
      <div v-for="i in 6" :key="i" class="glass-card skeleton-card">
        <el-skeleton variant="rect" style="width: 100%; height: 130px" />
        <div style="padding: 12px 14px">
          <el-skeleton variant="text" style="width: 60%" :rows="2" />
        </div>
      </div>
    </div>

    <div v-else-if="selectedProjects.length > 0" class="batch-bar glass-panel page-section">
      <span class="batch-info">已选 {{ selectedProjects.length }} 个项目</span>
      <el-button size="small" :disabled="batchBusy" @click="batchDuplicate">
        <el-icon><CopyDocument /></el-icon>批量复制
      </el-button>
      <el-button size="small" :disabled="batchBusy" @click="batchExport">
        <el-icon><Download /></el-icon>批量导出成片
      </el-button>
      <el-button size="small" type="danger" :disabled="batchBusy" @click="batchDelete">
        <el-icon><Delete /></el-icon>批量删除
      </el-button>
      <el-button size="small" @click="clearSelection">取消选择</el-button>
    </div>

    <EmptyState
      v-if="projectsLoaded && projects.length === 0"
      title="还没有项目"
      description="从这里开始制作短剧：新建一个空白项目，或用 AI 导演一键从想法/剧本生成成片。"
      :icon="FolderOpened"
      class="page-section"
    >
      <el-button type="primary" @click="showCreateDialog = true">
        <el-icon><Plus /></el-icon>新建项目
      </el-button>
      <el-button type="success" @click="directorFlowRef?.open()">
        <el-icon><VideoCamera /></el-icon>AI 导演
      </el-button>
    </EmptyState>

    <EmptyState
      v-else-if="projectsLoaded && filteredProjects.length === 0"
      title="没有匹配的项目"
      description="换个片名关键词试试，或清空搜索查看全部项目。"
      :icon="Search"
      class="page-section"
    />

    <div v-else class="project-grid">
      <article
        v-for="(row, i) in filteredProjects"
        :key="row.id"
        class="glass-card project-card is-interactive"
        :class="{ selected: isSelected(row) }"
        :style="{ animationDelay: `${Math.min(i, 8) * 40}ms` }"
        @click="openProject(row)"
        @contextmenu.prevent="onCardContextMenu(row, $event)"
      >
        <div class="card-select" @click.stop>
          <el-checkbox :model-value="isSelected(row)" @change="toggleSelect(row)" />
        </div>
        <div class="card-cover">
          <img
            v-if="coverRel[row.id]"
            :src="urlCache[coverRel[row.id]]"
            alt=""
          />
          <div v-else class="cover-fallback">
            <span>{{ (row.title || '?').slice(0, 1) }}</span>
          </div>
          <el-tag class="status-chip" :type="statusType(row.status)" size="small" effect="dark">
            {{ statusText(row.status) }}
          </el-tag>
        </div>
        <div class="card-body">
          <h3>{{ row.title }}</h3>
          <p class="meta">
            <span>{{ row.genre || '未定题材' }}</span>
            <span>·</span>
            <span>{{ row.shots.length }} 镜</span>
            <span>·</span>
            <span>第 {{ row.episode }} 集</span>
          </p>
          <p class="time">{{ formatTime(row.createdAt) }}</p>
        </div>
        <div class="card-foot" @click.stop>
          <el-button link type="primary" size="small" @click="openProject(row)">打开</el-button>
          <el-button link type="primary" size="small" @click="void duplicateProject(row)">复制</el-button>
          <el-button link type="danger" size="small" @click="deleteProject(row)">删除</el-button>
        </div>
      </article>
    </div>

    <!-- 右键菜单（全局组件：Esc/失焦/边缘防溢出/点击外部自动关闭） -->
    <ContextMenu ref="projectMenuRef" :items="projectMenuItems" />

    <!-- 新建项目对话框 -->
    <el-dialog v-model="showCreateDialog" title="新建项目" width="400px">
      <el-form :model="newProject" label-width="80px">
        <el-form-item label="标题" required>
          <el-input
            v-model="newProject.title"
            placeholder="如：第一集 重生"
            @keyup.enter="onCreateEnter"
          />
        </el-form-item>
        <el-form-item label="题材">
          <div class="genre-row">
            <el-input
              v-model="newProject.genre"
              clearable
              placeholder="输入或选择题材，如：古装仙侠"
              style="flex: 1"
            />
            <el-select
              v-model="newProject.genreQuick"
              placeholder="常用题材"
              style="width: 180px"
              @change="pickGenre"
            >
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
          </div>
          <div class="form-tip">下拉选择模板题材（渲染时自动注入风格提示词），也可直接输入任意自定义题材</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreateDialog = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="createProject">创建</el-button>
      </template>
    </el-dialog>

    <!-- 重命名对话框 -->
    <el-dialog v-model="renameDialog.visible" title="重命名项目" width="300px">
      <el-input v-model="renameDialog.title" placeholder="新标题" />
      <template #footer>
        <el-button @click="renameDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="renaming" @click="confirmRename">确定</el-button>
      </template>
    </el-dialog>

    <!-- AI 导演：开始对话框 + 进度面板（独立组件） -->
    <DirectorFlow ref="directorFlowRef" :projects="projects" @started="loadProjects" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useHotkeys } from '../composables/useHotkeys'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { confirmDanger, confirmAction } from '../utils/confirm'
import {
  Plus, Edit, EditPen, CopyDocument, Download, FolderOpened, Delete, Connection, VideoCamera, Search, RefreshRight
} from '@element-plus/icons-vue'
import type { Project, InterruptedTask, DirectorProgressEvent } from '../../../shared/ipcTypes'
import { GENRE_TEMPLATES } from '../../../shared/ipcTypes'
import {
  PROJECT_SORT_OPTIONS,
  type ProjectSortMode,
  filterProjects,
  sortProjects,
  projectCoverPath,
  markProjectOpened,
  directorProjectStatus
} from '../utils/projectList'
import { snapshot } from '../utils/snapshot'
import {
  statusTagType as statusType,
  projectStatusText as statusText,
  formatLocaleTime as formatTime
} from '../utils/status'
import { useFileUrl, clearFileUrlCache } from '../composables/useFileUrl'
import { clearLastProjectIdIf, setLastProjectId } from '../composables/useActiveProject'
import DirectorFlow from '../components/project/DirectorFlow.vue'
import { STAGE_LABELS } from '../composables/useDirectorState'
import ContextMenu, { type CtxItem } from '../components/ContextMenu.vue'
import EmptyState from '../components/common/EmptyState.vue'

const { urlCache, ensureFileUrls } = useFileUrl()

const router = useRouter()
const route = useRoute()
const projects = ref<Project[]>([])
const searchKw = ref('')
/** REQ-08：排序方式（最近打开/创建时间/完成状态） */
const sortMode = ref<ProjectSortMode>('recent')
/** REQ-08：卡片封面相对路径（首镜首帧优先，回退缩略图） */
const coverRel = ref<Record<string, string>>({})
const filteredProjects = computed(() =>
  sortProjects(filterProjects(projects.value, searchKw.value), sortMode.value)
)
const projectsLoaded = ref(false)
const showCreateDialog = ref(false)
const creating = ref(false)
/** 检测 ComfyUI 按钮 loading（UXA-P1-01） */
const checkingComfy = ref(false)
/** 重命名确认按钮 loading（UXA-P1-12） */
const renaming = ref(false)

// Ctrl+N 新建项目
useHotkeys([
  { keys: 'ctrl+n', handler: () => { showCreateDialog.value = true } }
])
const newProject = ref({ title: '', genre: '', genreQuick: '' })
const comfyuiStatus = ref<boolean | null>(null)
const selectedProjects = ref<Project[]>([])

// 右键菜单（全局 ContextMenu 组件）
const projectMenuRef = ref<InstanceType<typeof ContextMenu> | null>(null)
const currentMenuRow = ref<Project | null>(null)
const projectMenuItems = computed<CtxItem[]>(() => {
  const row = currentMenuRow.value
  if (!row) return []
  return [
    { label: '打开编辑', icon: Edit, action: () => openProject(row) },
    { label: '重命名', icon: EditPen, action: () => renameProject(row) },
    { label: '复制项目', icon: CopyDocument, action: () => void duplicateProject(row) },
    { divider: true },
    { label: '导出项目', icon: Download, action: () => void exportProject(row) },
    { label: '在文件夹中显示', icon: FolderOpened, action: () => void showInFolder(row) },
    { divider: true },
    { label: '删除项目', icon: Delete, danger: true, action: () => void deleteProject(row) }
  ]
})

function isSelected(p: Project): boolean {
  return selectedProjects.value.some(x => x.id === p.id)
}

function toggleSelect(p: Project): void {
  if (isSelected(p)) {
    selectedProjects.value = selectedProjects.value.filter(x => x.id !== p.id)
  } else {
    selectedProjects.value = [...selectedProjects.value, p]
  }
}

function onCardContextMenu(row: Project, event: MouseEvent): void {
  currentMenuRow.value = row
  projectMenuRef.value?.open(event, row)
}
const renameDialog = ref({ visible: false, title: '', project: null as Project | null })

// AI 导演流程组件
const directorFlowRef = ref<InstanceType<typeof DirectorFlow> | null>(null)

/** REQ-03：磁盘上未跑完的任务（应用重启中断），顶部横幅展示并支持一键继续 */
const interruptedTasks = ref<InterruptedTask[]>([])
const resumingId = ref('')

// ===== REQ-08：卡片状态随导演任务实时刷新（进度事件改徽章 + 落盘事件节流拉表） =====
let unsubProgress: (() => void) | null = null
let unsubProjectUpdated: (() => void) | null = null
let reloadTimer: ReturnType<typeof setTimeout> | null = null

/** 整表刷新节流：onProgress/onProjectUpdated 高频，合并成一次拉取 */
function scheduleReload(delay = 400): void {
  if (reloadTimer !== null) return
  reloadTimer = setTimeout(() => {
    reloadTimer = null
    void loadProjects()
  }, delay)
}

function handleDirectorProgress(e: DirectorProgressEvent): void {
  const row = projects.value.find(p => p.id === e.projectId)
  if (!row) { scheduleReload(); return }
  // 徽章原地更新：渲染中/完成无需整表重渲染；高频进度事件也不会每帧刷新列表
  const next = directorProjectStatus(e.state)
  if (next && next !== row.status) row.status = next
  // 任务进入终态时再拉一次磁盘数据，保证标题/更新时间与落盘一致
  if (!e.state.running) scheduleReload(500)
}

async function loadInterrupted(): Promise<void> {
  try {
    interruptedTasks.value = await window.api.director.listInterrupted()
  } catch {
    interruptedTasks.value = []
  }
}

function openProjectById(projectId: string): void {
  markProjectOpened(projectId)
  router.push(`/project/${projectId}/storyboard`)
}

async function resumeInterrupted(task: InterruptedTask): Promise<void> {
  if (!task.interruptedStage) {
    openProjectById(task.projectId)
    return
  }
  resumingId.value = task.projectId
  try {
    await window.api.director.resumeFrom(task.projectId, task.interruptedStage)
    interruptedTasks.value = interruptedTasks.value.filter(t => t.projectId !== task.projectId)
    ElMessage.success(`已从「${STAGE_LABELS[task.interruptedStage]}」继续，可在项目页查看进度`)
    openProjectById(task.projectId)
    loadProjects()
  } catch (e) {
    ElMessage.error(`继续失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    resumingId.value = ''
  }
}

onMounted(() => {
  loadProjects()
  loadInterrupted()
  checkComfyUI()
  unsubProgress = window.api.director.onProgress(handleDirectorProgress)
  unsubProjectUpdated = window.api.director.onProjectUpdated((e) => {
    if (e?.projectId) scheduleReload()
  })
  // 剧本页「去 AI 导演」会 push /?openDirector=1：这里自动打开导演表单，
  // 消费后清掉 query，避免刷新/返回时重复弹窗
  if (route.query.openDirector === '1') {
    router.replace({ query: {} })
    directorFlowRef.value?.open()
  }
})

onUnmounted(() => {
  // 无全局 listener：ContextMenu 组件自管 Esc/失焦/外部点击关闭
  unsubProgress?.()
  unsubProjectUpdated?.()
  unsubProgress = null
  unsubProjectUpdated = null
  if (reloadTimer !== null) {
    clearTimeout(reloadTimer)
    reloadTimer = null
  }
})

async function loadProjects() {
  try {
    projects.value = await window.api.project.list()
    // REQ-08：封面取首镜首帧，缺失回退缩略图；仅解析真实存在的文件，避免破图
    const candidates = projects.value.map(p => projectCoverPath(p))
    const checks = await Promise.all(candidates.map(rel => window.api.file.exists(rel)))
    const relMap: Record<string, string> = {}
    projects.value.forEach((p, i) => {
      if (checks[i]) relMap[p.id] = candidates[i]
    })
    coverRel.value = relMap
    await ensureFileUrls(Object.values(relMap))
  } catch {
    ElMessage.error('加载项目失败')
  } finally {
    projectsLoaded.value = true
  }
}

async function checkComfyUI() {
  if (checkingComfy.value) return
  checkingComfy.value = true
  // R-12：健康检查失败不再产生 unhandled rejection
  try {
    comfyuiStatus.value = await window.api.comfyui.healthCheck()
  } catch {
    comfyuiStatus.value = false
  } finally {
    checkingComfy.value = false
  }
  window.dispatchEvent(new Event('comfyui:recheck'))
}

/**
 * 新建项目弹窗 Enter 提交（交互规范 1.4）。
 * 中文输入法组词期间（isComposing=true）Enter 不应触发创建，否则会把未上屏
 * 的拼音截断成项目名。keydown.enter 不带 .exact 时 IME 合成中也会触发，
 * 这里通过 KeyboardEvent.isComposing 兜底。
 */
function onCreateEnter(e: KeyboardEvent): void {
  if (e.isComposing) return
  void createProject()
}

async function createProject() {
  if (!newProject.value.title.trim()) {
    ElMessage.warning('请输入标题')
    return
  }
  creating.value = true
  try {
    const created = await window.api.project.create(newProject.value.title, newProject.value.genre)
    showCreateDialog.value = false
    newProject.value = { title: '', genre: '', genreQuick: '' }
    setLastProjectId(created.id)
    ElMessage.success('创建成功，开始编辑分镜吧')
    await router.push(`/project/${created.id}/storyboard`)
  } catch (e) {
    ElMessage.error(`创建失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    creating.value = false
  }
}

/** 预设题材下拉 → 填入题材输入框（可继续手动改） */
function pickGenre(key: string): void {
  if (key) {
    newProject.value.genre = key
    newProject.value.genreQuick = ''
  }
}

function openProject(row: Project) {
  markProjectOpened(row.id)
  router.push(`/project/${row.id}/storyboard`)
}

async function renameProject(project: Project) {
  renameDialog.value = { visible: true, title: project.title, project }
}

async function confirmRename() {
  const { project, title } = renameDialog.value
  if (!project || renaming.value) return
  if (!title.trim()) {
    ElMessage.warning('请输入标题')
    return
  }
  // R-12：保存失败回滚内存标题并提示，不再"误以为成功"
  const prevTitle = project.title
  project.title = title
  renaming.value = true
  try {
    await window.api.project.save(snapshot(project))
    renameDialog.value.visible = false
    loadProjects()
    ElMessage.success('重命名成功')
  } catch (e) {
    project.title = prevTitle
    ElMessage.error(`重命名失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    renaming.value = false
  }
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
  // R-12：前置检查失败单独提示，不产生 unhandled rejection
  let exists: boolean
  try {
    exists = await window.api.file.exists(finalRel)
  } catch {
    ElMessage.error('检查成片文件失败')
    return
  }
  if (!exists) {
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
  // R-12：目标不存在时 shell.showItem 会 reject，给出可理解的提示
  try {
    await window.api.shell.showItem(`projects/${project.id}/project.json`)
  } catch {
    ElMessage.warning('项目文件不存在，可能已被删除')
  }
}

async function deleteProject(project: Project) {
  const ok = await confirmDanger(`确定删除「${project.title}」吗？此操作不可恢复。`, {
    title: '删除确认',
    confirmText: '删除'
  })
  if (!ok) return
  try {
    await window.api.project.delete(project.id)
    clearFileUrlCache(`projects/${project.id}/`)
    clearLastProjectIdIf(project.id)
    loadProjects()
    ElMessage.success('删除成功')
  } catch (e) {
    ElMessage.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

// ===== 批量操作 =====
function clearSelection() {
  selectedProjects.value = []
}

// 批量操作忙碌锁：复制/导出/删除是异步循环，防快速连点重复执行
const batchBusy = ref(false)

async function batchDuplicate() {
  const n = selectedProjects.value.length
  if (n === 0 || batchBusy.value) return
  const okCopy = await confirmAction(`确定复制选中的 ${n} 个项目吗？`, {
    title: '批量复制',
    confirmText: '复制'
  })
  if (!okCopy) return
  batchBusy.value = true
  try {
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
  } finally {
    batchBusy.value = false
  }
}

async function batchExport() {
  if (batchBusy.value) return
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
  batchBusy.value = true
  try {
    let ok = 0
    for (const p of targets) {
      try {
        const finalRel = `projects/${p.id}/final.mp4`
        const safeName = p.title.replace(/[\\/:*?"<>|]/g, '_')
        // 目录尾部可能自带分隔符（根盘符如 E:\），避免拼出双反斜杠
        const sep = dir.endsWith('\\') || dir.endsWith('/') ? '' : '\\'
        await window.api.file.copy(finalRel, `${dir}${sep}${safeName}.mp4`)
        ok++
      } catch {
        // 单个失败继续
      }
    }
    ElMessage.success(`成功导出 ${ok}/${targets.length} 个成片`)
  } finally {
    batchBusy.value = false
  }
}

async function batchDelete() {
  const n = selectedProjects.value.length
  if (n === 0 || batchBusy.value) return
  const okDel = await confirmDanger(
    `确定删除选中的 ${n} 个项目吗？所有角色、分镜、渲染产物将被永久删除，此操作不可恢复。`,
    { title: '批量删除确认', confirmText: '全部删除' }
  )
  if (!okDel) return
  batchBusy.value = true
  try {
    let ok = 0
    for (const p of selectedProjects.value) {
      try {
        await window.api.project.delete(p.id)
        clearFileUrlCache(`projects/${p.id}/`)
        clearLastProjectIdIf(p.id)
        ok++
      } catch {
        // 单个失败继续
      }
    }
    clearSelection()
    loadProjects()
    ElMessage.success(`成功删除 ${ok}/${n} 个项目`)
  } finally {
    batchBusy.value = false
  }
}

</script>

<style scoped>
.genre-row { display: flex; align-items: center; gap: 8px; width: 100%; }
.empty-actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
.empty-panel { padding: 40px 20px; }
.skeleton-card { padding: 0; }
.skeleton-card .el-skeleton { transform: none; }

.batch-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 16px;
}
.batch-info { color: var(--info); font-size: 13px; margin-right: 4px; }

.interrupted-item {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 4px 0;
}
.interrupted-name { font-weight: 600; }
.interrupted-reason { color: var(--info); font-size: 13px; }

.project-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
}

.project-card {
  display: flex;
  flex-direction: column;
  animation: fade-up var(--dur-slow) var(--ease-out) both;
}
.project-card.selected {
  border-color: color-mix(in srgb, var(--brand) 55%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--brand) 40%, transparent), var(--glass-shadow);
}

.card-select {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 2;
}

.card-cover {
  position: relative;
  aspect-ratio: 16 / 10;
  background: var(--bg-page-elevated);
  overflow: hidden;
}
.card-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform var(--dur-slow) var(--ease-out);
}
.project-card:hover .card-cover img { transform: scale(1.04); }

.cover-fallback {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  background:
    linear-gradient(145deg, rgba(212, 165, 116, 0.25), transparent 55%),
    var(--bg-page-elevated);
  font-family: var(--font-display);
  font-size: 42px;
  font-weight: 650;
  color: var(--brand-strong);
}

.status-chip {
  position: absolute;
  right: 10px;
  bottom: 10px;
}

.card-body { padding: 14px 14px 6px; }
.card-body h3 {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta, .time {
  font-size: 12px;
  color: var(--text-secondary);
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.time { color: var(--text-muted); margin-top: 4px; }

.card-foot {
  padding: 4px 10px 12px;
  display: flex;
  gap: 4px;
  margin-top: auto;
}

@media (max-width: 640px) {
  .project-grid { grid-template-columns: 1fr; }
}
</style>
