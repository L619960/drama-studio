<template>
  <div class="props-view page">
    <div class="page-header">
      <div>
        <h1>道具库</h1>
        <p class="subtitle">分镜阶段提取的关键道具定妆图 · 渲染时锁形防变样</p>
      </div>
      <div class="page-actions">
        <div class="wf-picker">
          <span class="wf-label">道具工作流</span>
          <el-select
            v-model="propWorkflow"
            clearable
            placeholder="默认"
            size="small"
            style="width: 220px"
            @change="saveWorkflowChoice"
          >
            <el-option v-for="w in t2iWorkflows" :key="w.name" :label="w.name" :value="w.name" />
          </el-select>
        </div>
        <el-button type="primary" @click="addProp">
          <el-icon><Plus /></el-icon>添加道具
        </el-button>
      </div>
    </div>

    <el-empty
      v-if="project && propsList.length === 0"
      class="glass-panel empty-panel"
      description="还没有道具资产。导演流水线会自动从剧本提取并生成，也可手动添加"
    >
      <el-button type="primary" @click="addProp">
        <el-icon><Plus /></el-icon>添加道具
      </el-button>
    </el-empty>

    <div v-else class="prop-grid">
      <el-card
        v-for="(prop, i) in propsList"
        :key="prop.id"
        class="prop-card glass-card"
        :style="{ animationDelay: `${Math.min(i, 8) * 40}ms` }"
        @contextmenu="menu.open($event, prop)"
      >
        <div class="prop-image" @click="previewProp(prop)">
          <img v-if="prop.imagePath && urlCache[prop.imagePath]" :src="urlCache[prop.imagePath]" alt="道具定妆" />
          <div v-else class="no-image">
            <el-icon><Box /></el-icon>
            <span>未生成定妆图</span>
          </div>
        </div>
        <div class="prop-info">
          <h3>{{ prop.zh }}</h3>
          <p class="prop-en">{{ prop.en }}</p>
          <p v-if="usageCount(prop.en) > 0" class="prop-usage">被 {{ usageCount(prop.en) }} 个分镜引用</p>
          <p class="prop-desc">{{ prop.description || '暂无形态描述' }}</p>
        </div>
        <div class="prop-actions">
          <el-button size="small" :loading="generatingId === prop.id" @click="generateProp(prop)">
            <el-icon><MagicStick /></el-icon>{{ generatingId === prop.id ? '生成中...' : (prop.imagePath ? '重新生成' : 'AI 生成') }}
          </el-button>
          <el-button size="small" @click="importPropImage(prop)">
            <el-icon><Upload /></el-icon>上传
          </el-button>
          <el-button size="small" @click="editProp(prop)">
            <el-icon><Edit /></el-icon>编辑
          </el-button>
          <el-button size="small" type="danger" @click="deleteProp(prop)">
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
        <div class="menu-item" @click="editProp(menu.state.data!)">
          <el-icon><Edit /></el-icon>编辑信息
        </div>
        <div class="menu-item" @click="generateProp(menu.state.data!)">
          <el-icon><MagicStick /></el-icon>{{ menu.state.data?.imagePath ? '重生成定妆图' : 'AI 生成定妆图' }}
        </div>
        <div class="menu-item" @click="importPropImage(menu.state.data!)">
          <el-icon><Upload /></el-icon>上传本地图
        </div>
        <div class="menu-divider" />
        <div class="menu-item danger" @click="deleteProp(menu.state.data!)">
          <el-icon><Delete /></el-icon>删除道具
          <span v-if="usageCount(menu.state.data!.en) > 0" class="menu-tip">被分镜引用</span>
        </div>
      </div>
    </teleport>

    <el-dialog v-model="showEditDialog" :title="editingProp ? '编辑道具' : '添加道具'" width="520px">
      <el-form :model="propForm" label-width="90px">
        <el-form-item label="中文名" required>
          <el-input v-model="propForm.zh" placeholder="如：袋 / 伞 / 戒指" />
        </el-form-item>
        <el-form-item label="英文名" required>
          <el-input v-model="propForm.en" placeholder="如：paper bag / umbrella" />
        </el-form-item>
        <el-form-item label="形态描述">
          <el-input
            v-model="propForm.description"
            type="textarea"
            :rows="2"
            placeholder="英文形态锁定，如：brown paper bag with a rope handle, slightly worn"
          />
          <div class="form-tip">描述会注入渲染提示词并作为定妆图生成依据，锁道具形态防止变样</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditDialog = false">取消</el-button>
        <el-button type="primary" :loading="savingProp" @click="saveProp">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="previewVisible" title="道具定妆图预览" width="520px">
      <img :src="urlCache[previewPath]" style="width: 100%; border-radius: 8px" />
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Plus, Upload, Edit, Delete, MagicStick, Box } from '@element-plus/icons-vue'
import type { Project, PropAsset, WorkflowMeta } from '../../../shared/ipcTypes'
import { useFileUrl, clearFileUrlCache } from '../composables/useFileUrl'
import { useRouteProjectId } from '../composables/useRouteProjectId'
import { useContextMenu } from '../composables/useContextMenu'
import { snapshot } from '../utils/snapshot'
import { throttleTap } from '../utils/throttle'
import { confirmDanger } from '../utils/confirm'

const { urlCache, ensureFileUrl, ensureFileUrls } = useFileUrl()

const router = useRouter()
const projectId = useRouteProjectId((id) => { void loadProject(id) })

const project = ref<Project | null>(null)
const showEditDialog = ref(false)
const editingProp = ref<PropAsset | null>(null)
const propForm = ref({ zh: '', en: '', description: '' })
const previewVisible = ref(false)
const previewPath = ref('')
const generatingId = ref('')
const savingProp = ref(false)
const t2iWorkflows = ref<WorkflowMeta[]>([])
const propWorkflow = ref('')
let projectUpdatedUnsub: (() => void) | null = null
const menu = useContextMenu<PropAsset>(180, 180)

const propsList = computed(() => project.value?.props || [])

function onMenuKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') menu.close()
}

/** 该道具（按 en 匹配）被多少个分镜引用 */
function usageCount(en: string): number {
  if (!en || !project.value?.shots) return 0
  return project.value.shots.filter(s => Array.isArray(s.props) && s.props.includes(en)).length
}

onMounted(async () => {
  document.addEventListener('click', menu.close)
  document.addEventListener('keydown', onMenuKeydown)
  // 后台流水线（导演 agent 定妆/逐镜）落盘后自动刷新，无需手动切页
  projectUpdatedUnsub = window.api.director.onProjectUpdated((e) => {
    if (e?.projectId === projectId.value) {
      clearFileUrlCache()
      void loadProject(projectId.value)
    }
  })
  void loadProject(projectId.value)
  try {
    const wf = await window.api.workflow.list()
    t2iWorkflows.value = wf.filter(w => w.capability === 't2i' || (!w.capability && !w.hasImageInput))
  } catch {
    // 工作流库加载失败不阻断页面
  }
})

onUnmounted(() => {
  document.removeEventListener('click', menu.close)
  document.removeEventListener('keydown', onMenuKeydown)
  projectUpdatedUnsub?.()
})

async function loadProject(id?: string) {
  const pid = id ?? projectId.value
  const p = await window.api.project.get(pid).catch(() => null)
  if (!p) {
    ElMessage.error('项目不存在或已被删除')
    void router.replace('/')
    return
  }
  project.value = p
  const paths = (p.props || []).map(pr => pr.imagePath).filter(Boolean) as string[]
  await ensureFileUrls(paths)
}

/** 保存项目（props 数组变化后统一走这里持久化） */
async function persistProps(): Promise<void> {
  if (!project.value) return
  await window.api.project.save(snapshot(project.value))
}

function addProp(): void {
  editingProp.value = null
  propForm.value = { zh: '', en: '', description: '' }
  showEditDialog.value = true
}

function editProp(prop: PropAsset): void {
  editingProp.value = prop
  propForm.value = {
    zh: prop.zh,
    en: prop.en,
    description: prop.description || ''
  }
  showEditDialog.value = true
  menu.close()
}

async function saveProp(): Promise<void> {
  if (!throttleTap('prop-save', 800)) return
  if (!project.value) return
  if (!propForm.value.zh.trim() || !propForm.value.en.trim()) {
    ElMessage.warning('中文名和英文名必填')
    return
  }
  const oldEn = editingProp.value?.en
  if (editingProp.value) {
    editingProp.value.zh = propForm.value.zh.trim()
    editingProp.value.en = propForm.value.en.trim()
    editingProp.value.description = propForm.value.description.trim() || undefined
    // 英文名变更时同步分镜里的道具引用（props 按 en 关联），避免引用断裂
    if (oldEn && oldEn !== editingProp.value.en) {
      for (const s of project.value.shots) {
        if (Array.isArray(s.props)) {
          s.props = s.props.map(p => (p === oldEn ? editingProp.value!.en : p))
        }
      }
    }
  } else {
    const prop: PropAsset = {
      id: `prop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      zh: propForm.value.zh.trim(),
      en: propForm.value.en.trim(),
      description: propForm.value.description.trim() || undefined
    }
    project.value.props = [...(project.value.props || []), prop]
  }
  savingProp.value = true
  try {
    await persistProps()
    showEditDialog.value = false
    editingProp.value = null
    ElMessage.success('保存成功')
  } catch (e) {
    ElMessage.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    savingProp.value = false
  }
}

/** 上传本地图片作为道具定妆图 */
async function importPropImage(prop: PropAsset): Promise<void> {
  if (!project.value) return
  menu.close()
  try {
    const rel = await window.api.project.importPropImage(projectId.value, prop.id)
    // 清理旧图引用缓存后替换路径
    if (prop.imagePath) clearFileUrlCache(prop.imagePath)
    prop.imagePath = rel
    await persistProps()
    await ensureFileUrl(rel)
    ElMessage.success(`道具「${prop.zh}」已导入本地图片`)
  } catch (e) {
    if (e instanceof Error && e.message && e.message !== 'User cancelled') {
      ElMessage.error(`导入失败：${e.message}`)
    }
  }
}

/** 道具定妆工作流选择持久化到项目 */
async function saveWorkflowChoice(): Promise<void> {
  if (!project.value) return
  project.value.assetWorkflows = {
    ...(project.value.assetWorkflows || {}),
    prop: propWorkflow.value || undefined
  }
  try {
    await window.api.project.save(snapshot(project.value))
  } catch (e) {
    ElMessage.error(`工作流选择保存失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 生成/重新生成道具定妆图（文生图：中性背景孤立道具） */
async function generateProp(prop: PropAsset): Promise<void> {
  if (!project.value) return
  if (!throttleTap('prop-gen-' + prop.id, 3000)) return
  menu.close()
  generatingId.value = prop.id
  try {
    const rel = `projects/${projectId.value}/props/${prop.id}.png`
    const lookText = prop.description
      ? `${prop.en}, ${prop.description}`
      : prop.en
    await window.api.image.generate(
      `${lookText}, isolated prop asset for film production, centered on plain light-gray studio background, soft even lighting, subtle drop shadow, sharp focus, high detail, photorealistic, front three-quarter view, no person, no hands`,
      rel,
      { width: 768, height: 768, workflowName: propWorkflow.value || undefined }
    )
    prop.imagePath = rel
    await persistProps()
    await ensureFileUrl(rel)
    ElMessage.success(`道具「${prop.zh}」定妆图已生成`)
  } catch (e) {
    ElMessage.error(`生成失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    generatingId.value = ''
  }
}

async function deleteProp(prop: PropAsset): Promise<void> {
  if (!project.value) return
  if (!throttleTap('prop-del-' + prop.id, 1000)) return
  menu.close()
  const used = usageCount(prop.en)
  let message = `确定删除道具「${prop.zh}」吗？此操作不可恢复。`
  if (used > 0) {
    message = `道具「${prop.zh}」正被 ${used} 个分镜引用，删除后这些分镜的提示词仍保留道具文本，但定妆资产将失效，建议先移除分镜道具引用。仍要删除吗？`
  }
  const ok = await confirmDanger(message, { title: '删除道具', confirmText: '删除' })
  if (!ok) return
  project.value.props = (project.value.props || []).filter(p => p.id !== prop.id)
  try {
    await persistProps()
    ElMessage.success('已删除')
  } catch (e) {
    ElMessage.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

function previewProp(prop: PropAsset): void {
  if (!prop.imagePath) return
  previewPath.value = prop.imagePath
  previewVisible.value = true
}
</script>

<style scoped>
.wf-picker { display: flex; align-items: center; gap: 6px; margin-right: 4px; }
.wf-label { font-size: 12px; color: var(--text-muted); }
.prop-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 16px;
}
.prop-card {
  overflow: hidden;
  animation: card-in 0.35s var(--ease-out) both;
  cursor: context-menu;
}
.prop-image {
  height: 200px;
  overflow: hidden;
  display: grid;
  place-items: center;
  cursor: zoom-in;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--bg-elevated) 40%, transparent), var(--bg-elevated));
}
.prop-image img {
  width: 100%;
  height: 100%;
  max-height: 100%;
  object-fit: contain;
  display: block;
}
.no-image {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  font-size: 12px;
}
.prop-info {
  padding: 12px 14px 6px;
}
.prop-info h3 {
  font-size: 15px;
  font-weight: 650;
  color: var(--text-primary);
  margin: 0 0 2px;
}
.prop-en {
  font-size: 12px;
  color: var(--brand-strong);
  margin: 0 0 6px;
}
.prop-usage {
  font-size: 11px;
  color: var(--text-warning, #d9a13b);
  margin: 0 0 4px;
}
.prop-desc {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.prop-actions {
  padding: 8px 14px 14px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.form-tip {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
  line-height: 1.5;
}
.menu-tip { margin-left: auto; font-size: 11px; color: var(--text-muted); }
</style>
