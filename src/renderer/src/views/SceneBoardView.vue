<template>
  <div class="scene-board-view page">
    <div class="page-header">
      <div>
        <h1>场景板</h1>
        <p class="subtitle">同名场景共用无人空场景基准图，避免环境风格漂移</p>
      </div>
      <div class="page-actions">
        <el-button @click="router.push(`/project/${projectId}/storyboard`)">分镜编辑</el-button>
        <div class="wf-picker">
          <span class="wf-label">场景工作流</span>
          <el-select
            v-model="sceneWorkflow"
            clearable
            placeholder="默认"
            size="small"
            style="width: 220px"
            @change="saveWorkflowChoice"
          >
            <el-option v-for="w in t2iWorkflows" :key="w.name" :label="w.name" :value="w.name" />
          </el-select>
        </div>
        <el-button type="primary" @click="addBoard">
          <el-icon><Plus /></el-icon>添加场景板
        </el-button>
      </div>
    </div>

    <div class="toolbar">
      <el-input v-model="searchQuery" clearable size="small" placeholder="搜索场景板名称 / 描述" style="width: 240px">
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
    </div>

    <!-- REQ-17 RA-16：项目数据未取回时先给骨架，不白屏 -->
    <PageSkeleton v-if="loading" variant="cards" :count="6" />

    <ErrorStateCard
      v-else-if="loadError"
      title="场景板加载失败"
      description="这不是空场景库，只是本次项目数据没读到；资产仍在磁盘上，可重试加载。"
      :detail="loadError"
      @retry="loadProject()"
    >
      <el-button size="small" @click="router.push('/')">回项目列表</el-button>
    </ErrorStateCard>

    <el-empty
      v-else-if="project && boards.length === 0"
      class="glass-panel empty-panel"
      description="还没有场景板。导演流水线会自动生成，也可手动添加"
    >
      <el-button type="primary" @click="addBoard">添加场景板</el-button>
      <el-button @click="router.push(`/project/${projectId}/storyboard`)">去分镜页看看</el-button>
    </el-empty>

    <el-empty
      v-else-if="filteredBoards.length === 0"
      class="glass-panel empty-panel"
      :description="`没有匹配「${searchQuery.trim()}」的场景板`"
    />

    <div v-else class="board-grid">
      <el-card
        v-for="(board, i) in filteredBoards"
        :key="board.id"
        class="board-card glass-card"
        :style="{ animationDelay: `${Math.min(i, 8) * 40}ms` }"
        @contextmenu="menu.open($event, board)"
      >
        <div class="board-image" @click="preview(board)">
          <img v-if="board.panoGrid && urlCache[board.panoGrid]" :src="urlCache[board.panoGrid]" alt="全景宫格看板" />
          <img
            v-else-if="board.emptyPlatePath && urlCache[board.emptyPlatePath]"
            :src="urlCache[board.emptyPlatePath]"
            alt="场景板"
          />
          <div v-else class="no-image">暂无场景图</div>
        </div>
        <div v-if="board.panoViews && board.panoViews.length > 1" class="pano-views">
          <div
            v-for="(v, vi) in board.panoViews"
            :key="v"
            class="pano-thumb"
            :class="{ active: previewPath === v }"
            @click.stop="previewView(v)"
          >
            <img v-if="urlCache[v]" :src="urlCache[v]" :alt="`方位${vi + 1}`" />
          </div>
        </div>
        <div class="board-info">
          <h3>{{ board.name }}</h3>
          <p class="meta">键：{{ board.key }} · 被 {{ usageCount(board.id) }} 个分镜引用</p>
          <p v-if="board.panoViews" class="meta">
            全景 {{ board.panoViews.length }} 方位<template v-if="board.panoGrid"> + 宫格</template>
          </p>
          <p v-if="board.description" class="desc">{{ board.description }}</p>
        </div>
        <div class="board-actions">
          <el-button size="small" @click="importPlate(board)">
            <el-icon><Upload /></el-icon>导入
          </el-button>
          <el-button size="small" :loading="generating === board.id" @click="generatePlate(board)">
            <el-icon><MagicStick /></el-icon
            >{{
              generating === board.id
                ? '生成中...'
                : panoramaMode
                  ? board.panoPath
                    ? '重出全景'
                    : '生成全景'
                  : board.emptyPlatePath
                    ? '重新生成'
                    : 'AI 生成'
            }}
          </el-button>
          <el-button size="small" @click="editBoard(board)">
            <el-icon><Edit /></el-icon>编辑
          </el-button>
          <el-button size="small" type="danger" :disabled="usageCount(board.id) > 0" @click="deleteBoard(board)">
            <el-icon><Delete /></el-icon>
          </el-button>
        </div>
      </el-card>
    </div>

    <teleport to="body">
      <div
        v-if="menu.state.visible"
        class="context-menu"
        :style="{ left: menu.state.x + 'px', top: menu.state.y + 'px' }"
        @click.stop
      >
        <div class="menu-item" @click="editBoard(menu.state.data!)">
          <el-icon><Edit /></el-icon>编辑信息
        </div>
        <div class="menu-item" @click="generatePlate(menu.state.data!)">
          <el-icon><MagicStick /></el-icon
          >{{
            panoramaMode
              ? menu.state.data?.panoPath
                ? '重出全景场景板'
                : '生成全景场景板'
              : menu.state.data?.emptyPlatePath
                ? '重出场景板图'
                : 'AI 生成场景板图'
          }}
        </div>
        <div class="menu-item" @click="importPlate(menu.state.data!)">
          <el-icon><Upload /></el-icon>导入本地图
        </div>
        <div class="menu-divider" />
        <div
          class="menu-item danger"
          :class="{ disabled: usageCount(menu.state.data!.id) > 0 }"
          @click="!(usageCount(menu.state.data!.id) > 0) && deleteBoard(menu.state.data!)"
        >
          <el-icon><Delete /></el-icon>删除场景板
          <span v-if="usageCount(menu.state.data!.id) > 0" class="menu-tip">被分镜引用</span>
        </div>
      </div>
    </teleport>

    <el-dialog v-model="showDialog" :title="editing ? '编辑场景板' : '添加场景板'" width="520px">
      <el-form :model="form" label-width="80px">
        <el-form-item v-if="editing && editing.emptyPlatePath && urlCache[editing.emptyPlatePath]" label="当前图">
          <div class="edit-preview" @click="preview(editing)">
            <img :src="urlCache[editing.emptyPlatePath]" alt="当前场景板" />
          </div>
          <span v-if="usageCount(editing.id) > 0" class="edit-usage"
            >被 {{ usageCount(editing.id) }} 个分镜引用，改名会同步更新这些分镜的场景名</span
          >
        </el-form-item>
        <el-form-item label="名称" required>
          <el-input v-model="form.name" placeholder="如：便利店雨夜" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="form.description" type="textarea" :rows="2" placeholder="环境氛围、灯光等" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveBoard">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="previewVisible" title="场景板预览" width="560px">
      <img v-if="previewPath" :src="urlCache[previewPath]" style="width: 100%" />
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Plus, Upload, Edit, Delete, MagicStick, Search } from '@element-plus/icons-vue'
import type { Project, SceneBoard, WorkflowMeta } from '../../../shared/ipcTypes'
import { normalizeSceneKey } from '../../../shared/ipcTypes'
import { findDuplicateSceneBoard } from '../../../shared/assetNames'
import { scenePlatePrompt, sceneNegativeFor } from '../../../shared/imagePrompts'
import { useFileUrl, clearFileUrlCache } from '../composables/useFileUrl'
import { useRouteProjectId } from '../composables/useRouteProjectId'
import { useContextMenu } from '../composables/useContextMenu'
import { snapshot } from '../utils/snapshot'
import { throttleTap } from '../utils/throttle'
import { confirmDanger } from '../utils/confirm'
import { showUndoToast } from '../utils/undoToast'
import PageSkeleton from '../components/common/PageSkeleton.vue'
import ErrorStateCard from '../components/common/ErrorStateCard.vue'

const { urlCache, ensureFileUrl, ensureFileUrls } = useFileUrl()
const router = useRouter()
const projectId = useRouteProjectId((id) => {
  void loadProject(id)
})

const project = ref<Project | null>(null)
/** REQ-17：三态区分——加载中 / 加载失败 / 已加载 */
const loading = ref(true)
const loadError = ref('')
const showDialog = ref(false)
const editing = ref<SceneBoard | null>(null)
const form = ref({ name: '', description: '' })
const saving = ref(false)
const generating = ref('')
const previewVisible = ref(false)
const previewPath = ref('')
const t2iWorkflows = ref<WorkflowMeta[]>([])
const sceneWorkflow = ref('')
let projectUpdatedUnsub: (() => void) | null = null
const menu = useContextMenu<SceneBoard>(180, 180)

const boards = computed(() => project.value?.sceneBoards || [])
const searchQuery = ref('')
/** REQ-13 RA-09：按名称 / 描述关键字过滤，不做排序与虚拟滚动 */
const filteredBoards = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return boards.value
  return boards.value.filter((b) => b.name.toLowerCase().includes(q) || (b.description || '').toLowerCase().includes(q))
})
/** 项目是否启用全景固定场景模式（重出/生成走全景链路而非旧单图） */
const panoramaMode = ref(false)

function onMenuKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') menu.close()
}

onMounted(async () => {
  document.addEventListener('click', menu.close)
  document.addEventListener('keydown', onMenuKeydown)
  // 后台流水线（导演 agent 场景板/逐镜渲染）落盘后自动刷新，无需手动切页
  projectUpdatedUnsub = window.api.director.onProjectUpdated((e) => {
    if (e?.projectId === projectId.value) {
      // UI-07：只清本项目前缀，避免误伤其它项目的 URL 缓存
      clearFileUrlCache(`projects/${projectId.value}/`)
      void loadProject(projectId.value)
    }
  })
  try {
    const [wf, s] = await Promise.all([window.api.workflow.list(), window.api.settings.get()])
    t2iWorkflows.value = wf.filter((w) => w.capability === 't2i' || (!w.capability && !w.hasImageInput))
    panoramaMode.value = s?.creation?.scene?.panorama !== false
    if (project.value?.assetWorkflows?.scene) {
      sceneWorkflow.value = project.value.assetWorkflows.scene
    }
  } catch {
    // 工作流库加载失败不阻断页面
  }
})

onUnmounted(() => {
  document.removeEventListener('click', menu.close)
  document.removeEventListener('keydown', onMenuKeydown)
  projectUpdatedUnsub?.()
})

/** 场景定妆工作流选择持久化到项目 */
async function saveWorkflowChoice(): Promise<void> {
  if (!project.value) return
  project.value.assetWorkflows = {
    ...(project.value.assetWorkflows || {}),
    ...(sceneWorkflow.value ? { scene: sceneWorkflow.value } : {}),
  }
  try {
    await window.api.project.save(snapshot(project.value))
  } catch (e) {
    ElMessage.error(`工作流选择保存失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

function usageCount(boardId: string): number {
  return (project.value?.shots || []).filter((s) => s.sceneBoardId === boardId).length
}

async function loadProject(id?: string) {
  const pid = id ?? projectId.value
  loading.value = true
  loadError.value = ''
  try {
    const p = await window.api.project.get(pid)
    if (!p) {
      ElMessage.error('项目不存在或已被删除')
      void router.replace('/')
      return
    }
    project.value = p
    if (!project.value.sceneBoards) project.value.sceneBoards = []
    const paths = project.value.sceneBoards.flatMap(
      (b) => [b.emptyPlatePath, b.panoGrid, ...(b.panoViews || [])].filter(Boolean) as string[],
    )
    await ensureFileUrls(paths)
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function addBoard() {
  editing.value = null
  form.value = { name: '', description: '' }
  showDialog.value = true
}

function editBoard(board: SceneBoard) {
  editing.value = board
  form.value = { name: board.name, description: board.description || '' }
  showDialog.value = true
  menu.close()
}

async function saveBoard() {
  if (!throttleTap('scene-save', 800)) return
  if (!project.value || !form.value.name.trim()) {
    ElMessage.warning('请输入场景名称')
    return
  }
  // REQ-13 RA-14：同名场景板会让分镜静默绑定旧板，保存前按 normalizeSceneKey 拒绝
  const dup = findDuplicateSceneBoard(project.value.sceneBoards || [], form.value.name, editing.value?.id)
  if (dup) {
    ElMessage.warning(`已存在同名场景板「${dup.name}」，分镜会绑定到旧板，建议改名`)
    return
  }
  saving.value = true
  try {
    if (!project.value.sceneBoards) project.value.sceneBoards = []
    if (editing.value) {
      const oldName = editing.value.name
      editing.value.name = form.value.name.trim()
      editing.value.key = normalizeSceneKey(form.value.name)
      editing.value.description = form.value.description || undefined
      // 改名时同步引用该板的全部 t2v 分镜场景名（sceneBoardId 不变，显示名一致）
      if (oldName !== editing.value.name && project.value.shots) {
        for (const s of project.value.shots) {
          if (s.sceneBoardId === editing.value.id && s.scene) {
            s.scene = editing.value.name
          }
        }
      }
    } else {
      const id = `scene_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      project.value.sceneBoards.push({
        id,
        key: normalizeSceneKey(form.value.name),
        name: form.value.name.trim(),
        description: form.value.description || undefined,
        emptyPlatePath: '',
      })
    }
    await window.api.project.save(snapshot(project.value))
    showDialog.value = false
    editing.value = null
    ElMessage.success('保存成功')
  } catch (e) {
    ElMessage.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    saving.value = false
  }
}

async function importPlate(board: SceneBoard) {
  if (!project.value) return
  menu.close()
  try {
    const rel = await window.api.shot.importSceneImage(projectId.value)
    board.emptyPlatePath = rel
    // 同步挂到同板分镜的空镜场景图（便于队列回退）
    for (const s of project.value.shots) {
      if (s.sceneBoardId === board.id && s.type === 't2v') {
        s.sceneImagePath = rel
      }
    }
    await window.api.project.save(snapshot(project.value))
    await ensureFileUrl(rel)
    ElMessage.success('场景板已导入')
  } catch (e) {
    // 主进程取消哨兵：'User cancelled' 静默；其余为真实导入错误，须提示
    const msg = e instanceof Error ? e.message : String(e)
    if (msg !== 'User cancelled') ElMessage.error(`导入失败：${msg}`)
  }
}

async function generatePlate(board: SceneBoard) {
  if (!project.value) return
  if (!throttleTap('scene-gen-' + board.id, 3000)) return
  menu.close()
  generating.value = board.id
  try {
    if (panoramaMode.value) {
      // 全景固定场景模式：生成 2:1 全景 → 裁方位图 → 拼宫格看板（复用导演流水线同款链路）
      const r = await window.api.scene.regeneratePano(projectId.value, board.id)
      if (!r.ok) throw new Error(r.text)
      ElMessage.success(r.text)
    } else {
      const sc = (await window.api.settings.get()).creation.scene
      const rel = `projects/${projectId.value}/scenes/${board.id}_plate.png`
      await window.api.image.generate(
        scenePlatePrompt(board.description || board.name, undefined, {
          weatherHint: sc.weatherHint,
          emptyStrict: sc.emptyStrict,
        }),
        rel,
        {
          width: sc.plateWidth,
          height: sc.plateHeight,
          negative: sceneNegativeFor('standard', project.value?.genre),
          ...(sceneWorkflow.value || sc.t2iWorkflow ? { workflowName: sceneWorkflow.value || sc.t2iWorkflow } : {}),
        },
      )
      board.emptyPlatePath = rel
      for (const s of project.value.shots) {
        if (s.sceneBoardId === board.id && s.type === 't2v') {
          s.sceneImagePath = rel
        }
      }
      await window.api.project.save(snapshot(project.value))
      await ensureFileUrl(rel)
      ElMessage.success('场景板已生成')
    }
  } catch (e) {
    ElMessage.error(`生成失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    generating.value = ''
  }
}

async function preview(board: SceneBoard) {
  const p = board.panoGrid || board.emptyPlatePath
  if (!p) return
  await ensureFileUrl(p)
  previewPath.value = p
  previewVisible.value = true
}

/** 预览指定方位图（全景宫格缩略图点击） */
async function previewView(v: string): Promise<void> {
  await ensureFileUrl(v)
  previewPath.value = v
  previewVisible.value = true
}

async function deleteBoard(board: SceneBoard) {
  if (!project.value) return
  if (!throttleTap('scene-del-' + board.id, 1000)) return
  menu.close()
  if (usageCount(board.id) > 0) {
    ElMessage.warning('仍有分镜引用该场景板，无法删除')
    return
  }
  const ok = await confirmDanger(`确定删除场景板「${board.name}」吗？删除后 5 秒内可撤销。`, {
    title: '删除场景板',
    confirmText: '删除',
  })
  if (!ok) return
  const at = (project.value.sceneBoards || []).findIndex((b) => b.id === board.id)
  if (at < 0) return
  // REQ-16：内存暂存 + 5 秒撤销窗，撤销即原位恢复
  project.value.sceneBoards = (project.value.sceneBoards || []).filter((b) => b.id !== board.id)
  try {
    await window.api.project.save(snapshot(project.value))
  } catch (e) {
    project.value.sceneBoards.splice(at, 0, board)
    ElMessage.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    return
  }
  showUndoToast(
    `场景板「${board.name}」已删除`,
    async () => {
      if (!project.value || !project.value.sceneBoards) return
      if (project.value.sceneBoards.some((b) => b.id === board.id)) return
      project.value.sceneBoards.splice(Math.min(at, project.value.sceneBoards.length), 0, board)
      try {
        await window.api.project.save(snapshot(project.value))
        ElMessage.success('已撤销删除')
      } catch (e) {
        ElMessage.error(`撤销失败：${e instanceof Error ? e.message : String(e)}`)
      }
    },
    () => {},
  )
}
</script>

<style scoped>
.empty-panel {
  padding: 36px 16px;
}
.wf-picker {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-right: 4px;
}
.wf-label {
  font-size: 12px;
  color: var(--text-muted);
}
.toolbar {
  margin-bottom: 12px;
}
.board-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 16px;
}
.board-card {
  animation: fade-up var(--dur-slow) var(--ease-out) both;
  cursor: context-menu;
}
.board-card :deep(.el-card__body) {
  padding: 14px;
}
.menu-tip {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-muted);
}
.board-image {
  height: 180px;
  background: rgba(0, 0, 0, 0.22);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  cursor: pointer;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-weak);
}
.board-image img {
  max-width: 100%;
  max-height: 100%;
  object-fit: cover;
  transition: transform var(--dur-slow) var(--ease-out);
}
.board-image:hover img {
  transform: scale(1.03);
}
.no-image {
  color: var(--text-muted);
  font-size: 13px;
}
.pano-views {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
  margin-top: 8px;
}
.pano-thumb {
  aspect-ratio: 480 / 864;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid var(--border-weak);
  cursor: zoom-in;
  background: rgba(0, 0, 0, 0.22);
  transition: border-color var(--dur-fast, 0.15s) var(--ease-out);
}
.pano-thumb:hover,
.pano-thumb.active {
  border-color: var(--brand-strong, #5b8cff);
}
.pano-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.board-info {
  padding: 12px 0;
}
.board-info h3 {
  font-family: var(--font-display);
  color: var(--text-primary);
  margin-bottom: 4px;
  font-size: 16px;
}
.meta {
  color: var(--text-muted);
  font-size: 12px;
}
.desc {
  color: var(--text-secondary);
  font-size: 12px;
  margin-top: 4px;
}
.board-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.edit-preview {
  width: 240px;
  height: 135px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--border-weak);
  cursor: zoom-in;
  background: rgba(0, 0, 0, 0.22);
  display: flex;
  align-items: center;
  justify-content: center;
}
.edit-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.edit-usage {
  font-size: 12px;
  color: var(--text-secondary);
  margin-left: 12px;
}
</style>
