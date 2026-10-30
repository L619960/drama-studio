<template>
  <div class="storyboard page">
    <!-- 页头操作 / 未绑定告警 / 空态（StoryboardHeaderBar） -->
    <StoryboardHeaderBar
      :project-id="projectId"
      :project-exists="!!project"
      :is-rendering="isRendering"
      :has-pending-shots="hasPendingShots"
      :rendering="rendering"
      :review-mode="reviewMode"
      :audit-loading="auditLoading"
      :shots="shots"
      @add-shot="addShot"
      @open-split="openSplitDialog"
      @open-review="openReview"
      @open-audit="openPromptAudit"
      @start-render="startRender"
      @approve-all="approveAll"
    />

    <!-- 分镜列表 + 右键菜单 + 拖拽排序（ShotTablePanel） -->
    <ShotTablePanel
      v-if="shots.length > 0"
      :shots="shots"
      :asset-urls="assetUrls"
      :is-rendering="isRendering"
      :characters="characters"
      :scene-boards="sceneBoards"
      :has-clipboard="!!clipboardShot"
      @edit="editShot"
      @review="openReviewAt"
      @render="renderSingle"
      @delete="deleteShot"
      @current-change="onCurrentChange"
      @reorder="onShotsReorder"
      @copy-prompt="copyPrompt"
      @copy-shot="copyShot"
      @paste-shot="pasteShot"
      @insert="insertShot"
      @move="moveShot"
      @reset="resetShot"
    />

    <!-- 分镜审核对话框（先分镜图后视频，逐镜核对踩坑点） -->
    <ShotReviewDialog
      v-model:visible="reviewVisible"
      :shot="reviewingShot"
      :image-url="reviewImageUrl"
      :index="reviewIndex"
      :total="shots.length"
      :characters="characters"
      :project-id="projectId"
      :project-exists="!!project"
      :on-persist="persistProject"
      @navigate="openReviewAt"
      @edit="editReviewingShot"
      @reviewed="onReviewToggle"
    />

    <!-- 分镜编辑对话框（独立组件） -->
    <ShotEditDialog
      ref="editDialogRef"
      :project-id="projectId"
      :project-genre="project?.genre || ''"
      :characters="characters"
      :scene-boards="sceneBoards"
      :workflows="workflows"
      :default-frames="defaultFrames"
      @save="onSaveShot"
      @cancel="onEditDialogCancel"
    />

    <!-- AI 拆分镜对话框（独立组件） -->
    <SplitScriptDialog
      ref="splitDialogRef"
      :project-genre="project?.genre || ''"
      :initial-script="project?.script || ''"
      @split="onSplitScript"
    />

    <!-- 提示词批量体检：全部文生图/文生视频任务的正向+负向提示词检查结果 -->
    <PromptAuditDrawer
      v-model="auditVisible"
      :report="auditReport"
      :loading="auditLoading"
      :fixing="auditFixing"
      :bulk-filling="auditBulkFilling"
      :bulk-progress="auditBulkProgress"
      @recheck="runPromptAudit"
      @fix-all="fixPrompts()"
      @fix-one="fixPrompts"
      @bulk-fill-all="bulkFillPrompts()"
      @bulk-fill-one="bulkFillPrompts"
      @edit="editAuditTask"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useHotkeys } from '../composables/useHotkeys'
import { clearFileUrlCache, useFileUrl } from '../composables/useFileUrl'
import { useRouteProjectId } from '../composables/useRouteProjectId'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { Project, Shot, WorkflowMeta, ProgressEvent, PromptAuditReport, PromptAuditTask, PromptBulkFillProgress } from '../../../shared/ipcTypes'
import { snapshot } from '../utils/snapshot'
import { throttleTap } from '../utils/throttle'
import { confirmDanger } from '../utils/confirm'
import { confirmUnreviewedRender } from '../utils/renderGate'
import ShotEditDialog, { type ShotDraft } from '../components/storyboard/ShotEditDialog.vue'
import SplitScriptDialog from '../components/storyboard/SplitScriptDialog.vue'
import PromptAuditDrawer from '../components/storyboard/PromptAuditDrawer.vue'
import StoryboardHeaderBar from '../components/storyboard/StoryboardHeaderBar.vue'
import ShotTablePanel from '../components/storyboard/ShotTablePanel.vue'
import ShotReviewDialog from '../components/storyboard/ShotReviewDialog.vue'

const { urlCache: assetUrls, ensureFileUrls } = useFileUrl()

const router = useRouter()
const route = useRoute()
const projectId = useRouteProjectId((id) => { void loadProject(id) })

const project = ref<Project | null>(null)
const workflows = ref<WorkflowMeta[]>([])
const editingIndex = ref(-1)
/** insertShot 预插的占位分镜下标：用户取消编辑时移除该占位（R-18） */
const pendingInsertIndex = ref<number | null>(null)
// R3：占位镜按 id 锚定（下标在弹窗期间可能因后台刷新而漂移），取消时按 id 精准移除
const pendingInsertId = ref<string | null>(null)
const rendering = ref(false)
// 渲染默认帧数/尺寸（从设置加载，新建分镜时使用）
const defaultFrames = ref(81)
const defaultShotSize = ref({ width: 720, height: 480 })
// 设置里的自动保存开关（默认 true）。分镜页编辑均为弹窗草稿制、结构变更即时 persistProject，
// 此项随设置读取保持口径一致（无自由文本脏态，不额外接线）。
const autoSaveEnabled = ref(true)
// 当前选中行（Delete 快捷键删行用；点击行后记录）
const currentShotId = ref<string | null>(null)

// ===== 分镜审核（先分镜图后视频：逐镜核对踩坑点）=====
// 展示与重出首帧/尾帧逻辑已内聚到 ShotReviewDialog，本页仅持有弹窗开关与下标导航
const reviewVisible = ref(false)
const reviewIndex = ref(-1)
const reviewMode = ref(false)
const reviewingShot = computed(() =>
  reviewIndex.value >= 0 && reviewIndex.value < shots.value.length
    ? shots.value[reviewIndex.value]
    : null
)
const reviewImageUrl = computed(() => {
  const s = reviewingShot.value
  if (!s) return ''
  return (s.firstFramePath && assetUrls[s.firstFramePath])
    || (s.sceneImagePath && assetUrls[s.sceneImagePath])
    || (boardPlate(s) && assetUrls[boardPlate(s)!])
    || ''
})

function openReview(): void {
  reviewMode.value = true
  openReviewAt(0)
}

function openReviewAt(index: number): void {
  reviewIndex.value = index
  reviewVisible.value = true
}

/**
 * REQ-02：控制台门禁卡片「去审看」会带 ?review=<shotId> 跳转过来，
 * 定位该镜并自动打开审核弹窗；消费后清理 query，避免刷新重复弹出。
 */
function consumeReviewQuery(): void {
  const target = route.query.review
  if (typeof target !== 'string' || !project.value) return
  void router.replace({ query: { ...route.query, review: undefined } })
  const idx = project.value.shots.findIndex(s => s.id === target)
  if (idx < 0) {
    ElMessage.warning('该镜头已不存在，请手动选择需要审核的镜头')
    return
  }
  reviewMode.value = true
  openReviewAt(idx)
}

// REQ-04：已在分镜页时（如队列页确认框选「去审看」）再次收到 ?review=... 也要立即定位
watch(() => route.query.review, (v) => {
  if (typeof v === 'string') consumeReviewQuery()
})

function editReviewingShot(): void {
  if (reviewIndex.value < 0) return
  reviewVisible.value = false
  editShot(reviewIndex.value)
}

async function onReviewToggle(): Promise<void> {
  if (!reviewingShot.value) return
  await persistProject()
}

/** 全部通过：把所有 i2v 镜的 reviewed 设为 true，跳过逐镜审核 */
async function approveAll(): Promise<void> {
  if (!project.value) return
  let count = 0
  for (const s of project.value.shots) {
    if (s.type === 'i2v' && !s.reviewed) {
      s.reviewed = true
      count++
    }
  }
  await persistProject()
  ElMessage.success(`已通过 ${count} 个分镜审核`)
}

// 对话框组件
const editDialogRef = ref<InstanceType<typeof ShotEditDialog> | null>(null)
const splitDialogRef = ref<InstanceType<typeof SplitScriptDialog> | null>(null)

/** 打开 AI 拆分镜对话框（组件未就绪时给出明确反馈，避免"点了没反应"） */
function openSplitDialog(): void {
  if (splitDialogRef.value) {
    splitDialogRef.value.open()
  } else {
    ElMessage.warning('拆分镜组件尚未就绪，请稍候重试')
  }
}

const shots = computed(() => project.value?.shots || [])
const characters = computed(() => project.value?.characters || [])
const sceneBoards = computed(() => project.value?.sceneBoards || [])
const hasPendingShots = computed(() =>
  shots.value.some(s => s.status === 'pending' || s.status === 'failed')
)

function boardPlate(shot: Shot): string | undefined {
  if (!shot.sceneBoardId) return undefined
  return sceneBoards.value.find(b => b.id === shot.sceneBoardId)?.emptyPlatePath
}

watch(
  () => project.value,
  async (p) => {
    if (!p) return
    const paths = [
      ...p.shots.flatMap(s => [s.firstFramePath, s.lastFramePath, s.sceneImagePath]),
      ...(p.sceneBoards || []).map(b => b.emptyPlatePath)
    ].filter(Boolean) as string[]
    await ensureFileUrls(paths)
  },
  { deep: true }
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
  const finalRel = `projects/${projectId.value}/final.mp4`
  await window.api.file.delete(finalRel).catch(() => {})
  clearFileUrlCache(finalRel)
}

/** 项目持久化（R-6）：保存失败提示并返回 false，杜绝 fire-and-forget 静默丢数据 */
async function persistProject(): Promise<boolean> {
  if (!project.value) return false
  try {
    await window.api.project.save(snapshot(project.value))
    return true
  } catch (err) {
    ElMessage.error(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

let unsubProgress: (() => void) | null = null
let unsubProjectUpdated: (() => void) | null = null

onMounted(async () => {
  unsubProgress = window.api.onProgress((e: ProgressEvent) => {
    if (e.projectId !== projectId.value) return
    const shot = project.value?.shots.find(s => s.id === e.shotId)
    if (shot && e.step !== 'done' && e.step !== 'failed') {
      shot.status = 'rendering'
    }
    if (e.step === 'done' || e.step === 'failed' || e.step === 'queued') {
      void loadProject()
    }
  })
  // 后台资产（首帧/尾帧/场景板/定妆）落盘后自动刷新本页，无需手动切页
  unsubProjectUpdated = window.api.director.onProjectUpdated((e) => {
    if (e?.projectId === projectId.value) {
      clearFileUrlCache()
      void loadProject()
    }
  })
  try {
    const [s, wf] = await Promise.all([
      window.api.settings.get(),
      window.api.workflow.list()
    ])
    if (s?.render?.defaultFrames) defaultFrames.value = s.render.defaultFrames
    autoSaveEnabled.value = s?.general?.autoSave ?? true
    if (s?.creation?.edit) {
      defaultFrames.value = s.creation.edit.defaultFrames
      defaultShotSize.value = {
        width: s.creation.edit.defaultWidth,
        height: s.creation.edit.defaultHeight
      }
    } else if (s?.render) {
      defaultShotSize.value = {
        width: s.render.defaultWidth,
        height: s.render.defaultHeight
      }
    }
    workflows.value = wf
  } catch {
    // 保持默认
  }
})

onUnmounted(() => {
  unsubProgress?.()
  unsubProjectUpdated?.()
  unsubscribeBulkProgress?.()
})

async function loadProject(id?: string) {
  try {
    const pid = id ?? projectId.value
    const p = await window.api.project.get(pid)
    if (!p) {
      ElMessage.error('项目不存在或已被删除')
      void router.replace('/')
      return
    }
    project.value = p
    consumeReviewQuery()
  } catch {
    ElMessage.error('项目不存在或已被删除')
    void router.replace('/')
  }
}

function addShot() {
  pendingInsertIndex.value = null
  editingIndex.value = -1
  editDialogRef.value?.open(null)
}

// Ctrl+N 新建分镜（渲染中或编辑框已打开时忽略）；Delete 删除选中行（无选中时忽略）
useHotkeys([
  {
    keys: 'ctrl+n',
    handler: () => {
      if (isRendering.value || editDialogRef.value?.isVisible) return
      addShot()
    }
  },
  {
    keys: 'delete',
    handler: () => {
      // R1：审核/编辑弹窗打开时禁用 Delete 删镜——reviewingShot 按下标锚定，
      // 弹窗期间删镜会导致审核中的镜头错位（审核结论落到错误的镜头上）
      if (isRendering.value || reviewVisible.value || editDialogRef.value?.isVisible) return
      const idx = shots.value.findIndex(s => s.id === currentShotId.value)
      if (idx < 0) return
      void deleteShot(idx)
    }
  }
])

function onCurrentChange(row: Shot | null): void {
  currentShotId.value = row?.id ?? null
}

function editShot(index: number) {
  pendingInsertIndex.value = null
  pendingInsertId.value = null
  editingIndex.value = index
  editDialogRef.value?.open(shots.value[index])
}

/** 编辑对话框保存：按 editingIndex 组装完整 Shot 并持久化 */
async function onSaveShot(draft: ShotDraft) {
  if (!project.value) return
  if (!throttleTap('shot-save', 800)) return
  const wasPendingInsert = pendingInsertIndex.value !== null
  pendingInsertIndex.value = null
  pendingInsertId.value = null
  const isNew = editingIndex.value === -1
  const prev = isNew ? undefined : shots.value[editingIndex.value]
  // 被编辑镜头此前已渲完或已有产物 → 保存后旧产物失效，须明确告知需重新渲染
  const prevHadRender = !!prev && (prev.status === 'done' || !!prev.rawVideoPath || !!prev.segmentPath)
  const shot: Shot = {
    ...prev,
    ...draft,
    id: isNew ? `shot_${Date.now()}` : prev!.id,
    index: isNew ? shots.value.length + 1 : prev!.index,
    status: 'pending',
    // 编辑改变分镜内容后旧审核结论作废，须重新核对分镜图（渲染门禁依赖 reviewed）
    reviewed: undefined,
    audioPath: undefined,
    rawVideoPath: undefined,
    segmentPath: undefined,
    renderProfile: undefined,
    consistencyScore: undefined,
    error: undefined
  }

  if (isNew) {
    project.value.shots.push(shot)
  } else {
    project.value.shots[editingIndex.value] = shot
  }

  // 先落盘成功，再作废旧产物（R-7）：此前先删产物再保存，save 失败会留下
  // 指向已删除文件的悬空引用
  try {
    await window.api.project.save(snapshot(project.value))
  } catch (e) {
    ElMessage.error(`保存失败：${e instanceof Error ? e.message : String(e)}（内存态已更新，刷新后将恢复磁盘数据）`)
    return
  }
  // 作废旧产物与整集成片（编辑/新增均会改变成片内容）；清理失败不阻塞保存结果
  const oldShot = isNew || wasPendingInsert ? undefined : shots.value[editingIndex.value]
  await invalidateArtifacts(oldShot).catch(() => undefined)
  ElMessage.success(prevHadRender ? '已保存，旧产物已失效，需重新渲染' : '保存成功')
}

/** 编辑对话框关闭但未保存（R-18）：移除 insertShot 预插的占位分镜 */
async function onEditDialogCancel() {
  const placeholderId = pendingInsertId.value
  pendingInsertIndex.value = null
  pendingInsertId.value = null
  editingIndex.value = -1
  if (placeholderId === null || !project.value) return
  // 按 id 定位（R3）：弹窗期间后台进度事件可能触发 loadProject 重排，下标锚定会误删真实镜头
  const idx = project.value.shots.findIndex(s => s.id === placeholderId)
  if (idx < 0) return
  const placeholder = project.value.shots[idx]
  // 仅清理无内容的占位（scene/action 均空），防止误删已有数据
  if (placeholder && !placeholder.scene && !placeholder.action) {
    project.value.shots.splice(idx, 1)
    project.value.shots.forEach((s, i) => s.index = i + 1)
    // R3：移除后回写磁盘——占位镜若曾被其他保存路径顺带落盘，仅内存 splice 会留幽灵镜
    await persistProject()
  }
}

/** AI 拆分镜完成：剧本回写项目 → 完整剧本分析（角色/场景/道具建档 + 分镜绑定）→ 替换分镜 */
async function onSplitScript(scriptText: string) {
  if (!project.value) return
  const text = (scriptText || '').trim()
  if (!text) { ElMessage.warning('请输入剧本内容'); return }
  // ① 剧本回写并保存（reanalyze 从项目读取剧本）
  project.value.script = text
  if (!(await persistProject())) {
    splitDialogRef.value?.done()
    return
  }
  // ② 完整拆分：analyze 产出角色表/道具清单/场景提示词/完整分镜，统一建档并绑定。
  // analyze 为长调用（约 2-5 分钟），全程保持弹窗 loading 态，避免"点了没反应"
  ElMessage.info('正在 AI 拆分（约 2-5 分钟）…')
  try {
    const r = await window.api.director.reanalyze(projectId.value)
    await loadProject(projectId.value)
    ElMessage.success(`AI 拆分完成：${r.shots} 个分镜 · 角色 ${r.characters} 人 · 道具 ${r.props} 个（已绑定角色/场景/道具）`)
  } catch (e) {
    ElMessage.error(`AI 拆分失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    splitDialogRef.value?.done()
  }
}

async function deleteShot(index: number) {
  if (!project.value) return
  const shot = shots.value[index]
  if (!shot) return
  const ok = await confirmDanger(
    '确定删除这个分镜吗？该镜已生成的音频/视频产物和整集成片将一并删除，此操作不可恢复。',
    { title: '删除分镜', confirmText: '删除', cancelText: '取消' }
  )
  if (!ok) return
  if (!throttleTap('shot-del-' + shot.id, 1000)) return
  await invalidateArtifacts(shots.value[index])
  project.value.shots.splice(index, 1)
  project.value.shots.forEach((s, i) => s.index = i + 1)
  if (await persistProject()) ElMessage.success('删除成功')
}

async function renderSingle(shot: Shot) {
  if (!project.value) return
  if (!throttleTap('shot-render-' + shot.id, 1500)) return
  if (!(await confirmUnreviewedRender(project.value, [shot.id]))) return
  rendering.value = true
  try {
    const res = await window.api.render.start(projectId.value, [shot.id], false)
    if (res.warnedShots.length > 0) {
      ElMessage.warning(`第 ${shot.index} 镜尚未核对分镜图，已按「告警放行」入队渲染`)
    } else {
      ElMessage.success(`第 ${shot.index} 镜已入队渲染`)
    }
  } catch (e) {
    ElMessage.error(`启动渲染失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    rendering.value = false
  }
}

async function startRender() {
  if (!throttleTap('shot-render-all', 1500)) return
  if (project.value && !(await confirmUnreviewedRender(project.value))) return
  rendering.value = true
  try {
    const res = await window.api.render.start(projectId.value, undefined, false)
    if (res.warnedShots.length > 0) {
      // R4：告警须给出具体镜号，只报数量用户无法定位需补审的镜头
      const list = res.warnedShots.slice(0, 8).map(i => `第${i}镜`).join('、')
      const more = res.warnedShots.length > 8 ? ` 等 ${res.warnedShots.length} 镜` : ''
      ElMessage.warning(`未核对分镜图的人物镜：${list}${more}，已按「告警放行」入队渲染`)
    } else {
      ElMessage.success('已入队，正在跳转队列监控…')
    }
    await router.push(`/project/${projectId.value}/queue`)
  } catch (e) {
    ElMessage.error(`启动渲染失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    rendering.value = false
  }
}

function copyPrompt(shot: Shot) {
  navigator.clipboard.writeText(shot.action)
    .then(() => ElMessage.success('已复制'))
    .catch(() => ElMessage.error('复制失败，请手动选择复制'))
}

// 分镜剪贴板（模块级，跨右键菜单存活）
const clipboardShot = ref<Shot | null>(null)

function copyShot(index: number) {
  if (!project.value) return
  clipboardShot.value = { ...shots.value[index] }
  ElMessage.success('已复制')
}

async function pasteShot(index: number) {
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
    // 粘贴产生的是新镜，须重新审核，不得继承源镜的已审核标记
    reviewed: undefined,
    audioPath: undefined,
    rawVideoPath: undefined,
    segmentPath: undefined,
    error: undefined
  }
  project.value.shots.splice(insertAt, 0, copy)
  project.value.shots.forEach((s, i) => s.index = i + 1)
  await persistProject()
  ElMessage.success('已粘贴')
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
    width: defaultShotSize.value.width,
    height: defaultShotSize.value.height,
    frames: defaultFrames.value,
    seed: Math.floor(Math.random() * 1000000),
    status: 'pending'
  }
  project.value.shots.splice(insertAt, 0, shot)
  project.value.shots.forEach((s, i) => s.index = i + 1)
  // R-18：占位镜仅入内存不落盘，保存成功才持久化，取消由 onEditDialogCancel 移除
  pendingInsertIndex.value = insertAt
  pendingInsertId.value = shot.id
  // 直接打开编辑框编辑这个新分镜
  editingIndex.value = insertAt
  editDialogRef.value?.open(shot)
}

/** 拖拽排序落点：由 ShotTablePanel 定位目标行后上抛，父级执行换位与持久化 */
async function onShotsReorder(from: number, to: number) {
  if (!project.value) return
  const item = project.value.shots.splice(from, 1)[0]
  project.value.shots.splice(to, 0, item)
  project.value.shots.forEach((s, i) => s.index = i + 1)
  if (await persistProject()) ElMessage.success('已保存排序')
}

async function moveShot(index: number, direction: number) {
  if (!project.value) return
  const newIndex = index + direction
  if (newIndex < 0 || newIndex >= shots.value.length) return
  const temp = project.value.shots[index]
  project.value.shots[index] = project.value.shots[newIndex]
  project.value.shots[newIndex] = temp
  project.value.shots.forEach((s, i) => s.index = i + 1)
  if (await persistProject()) ElMessage.success('已保存排序')
}

async function resetShot(shot: Shot) {
  if (!project.value) return
  // 仅对已完成/失败的镜头需确认重置（pending 本身无需确认）
  if (shot.status === 'done' || shot.status === 'failed') {
    const ok = await confirmDanger(
      '将该镜头重置为待渲染：已完成的产物保留，但下次渲染会重新生成并覆盖。确定重置？',
      { title: '重置状态', confirmText: '重置', cancelText: '取消' }
    )
    if (!ok) return
  }
  shot.status = 'pending'
  shot.error = undefined
  if (await persistProject()) {
    ElMessage.success('已重置')
  }
}

// ===== 提示词批量体检（全部文生图/文生视频任务的正向+负向提示词）=====
const auditVisible = ref(false)
const auditReport = ref<PromptAuditReport | null>(null)
const auditLoading = ref(false)
const auditFixing = ref(false)
const auditBulkFilling = ref(false)
const auditBulkProgress = ref<{ done: number; total: number } | null>(null)
let unsubscribeBulkProgress: (() => void) | null = null

/** 打开体检抽屉并立即执行一次全量检查（主进程纯本地确定性校验，不调 LLM） */
async function openPromptAudit(): Promise<void> {
  auditVisible.value = true
  await runPromptAudit()
}

async function runPromptAudit(): Promise<void> {
  if (!project.value) return
  auditLoading.value = true
  try {
    auditReport.value = await window.api.prompt.auditPrompts(projectId.value)
  } catch (e) {
    ElMessage.error(`提示词体检失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    auditLoading.value = false
  }
}

/** 一键修正：taskId 缺省=修正全部任务的可自动修复项；只改提示词文本，不动产物与渲染状态 */
async function fixPrompts(taskId?: string): Promise<void> {
  if (!project.value) return
  auditFixing.value = true
  try {
    const res = await window.api.prompt.fixPrompts({
      projectId: projectId.value,
      taskIds: taskId ? [taskId] : undefined
    })
    auditReport.value = res.report
    if (res.applied > 0) {
      await loadProject()
      ElMessage.success(`已自动修正 ${res.applied} 个提示词字段（需重新渲染才会生效）`)
    } else {
      ElMessage.info('没有可自动修正的字段：剩余问题属语义类，请点「跳转编辑」人工处理')
    }
  } catch (e) {
    ElMessage.error(`一键修正失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    auditFixing.value = false
  }
}

/** 批量 AI 补写：taskId 缺省=全部任务；对缺失/过短/串戏字段调 LLM 重写，
 *  进度逐字段推送；单字段失败不影响其他。 */
async function bulkFillPrompts(taskId?: string): Promise<void> {
  if (!project.value) return
  auditBulkFilling.value = true
  auditBulkProgress.value = null
  if (!unsubscribeBulkProgress) {
    unsubscribeBulkProgress = window.api.prompt.onBulkFillProgress((e: PromptBulkFillProgress) => {
      auditBulkProgress.value = { done: e.done, total: e.total }
    })
  }
  try {
    const res = await window.api.prompt.bulkFillPrompts({
      projectId: projectId.value,
      taskIds: taskId ? [taskId] : undefined,
      concurrency: 2
    })
    auditReport.value = res.report
    if (res.filled > 0) {
      await loadProject()
      ElMessage.success(`AI 补写完成：成功 ${res.filled} 字段，失败 ${res.failed}，未变 ${res.skipped}`)
    } else if (res.failed > 0) {
      ElMessage.warning(`AI 补写 ${res.failed} 个字段失败，请检查 LLM 配置或稍后重试`)
    } else {
      ElMessage.info('没有可 AI 补写的字段')
    }
  } catch (e) {
    ElMessage.error(`AI 补写失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    auditBulkFilling.value = false
    setTimeout(() => { auditBulkProgress.value = null }, 1500)
  }
}

/** 跳转编辑：分镜→本页编辑弹窗；角色/场景板/道具→对应资产页自行编辑提示词 */
function editAuditTask(task: PromptAuditTask): void {
  auditVisible.value = false
  if (task.scope === 'shot') {
    const idx = shots.value.findIndex(s => s.id === task.id)
    if (idx < 0) {
      ElMessage.warning('该分镜已不存在，请重新加载后再试')
      return
    }
    editShot(idx)
    return
  }
  const routes: Record<string, string> = {
    character: `/project/${projectId.value}/characters`,
    sceneBoard: `/project/${projectId.value}/scenes`,
    prop: `/project/${projectId.value}/props`
  }
  const target = routes[task.scope]
  if (target) void router.push(target)
}
</script>
