<template>
  <div class="glass-panel table-shell">
    <!-- REQ-14 RA-20：选中多镜后的批量操作条（渲染中全局锁定，与单镜操作约束一致） -->
    <div v-if="selectedShots.length > 0" class="batch-bar">
      <span class="batch-info">已选 {{ selectedShots.length }} 镜</span>
      <el-button size="small" type="success" :disabled="isRendering" @click="onBatchRender">加入渲染队列</el-button>
      <el-button size="small" :disabled="isRendering" @click="onBatchSkip">标记已跳过</el-button>
      <el-button size="small" type="danger" :disabled="isRendering" @click="onBatchDelete">删除所选</el-button>
      <el-button size="small" @click="clearSelection">取消选择</el-button>
    </div>
    <!-- P2-13：行级虚拟滚动（el-table-v2），只渲染视口内行；高度由外层容器决定 -->
    <div ref="tableWrapRef" class="virtual-table" @dragover.prevent @drop="onDrop">
      <el-auto-resizer>
        <template #default="{ height, width }">
          <el-table-v2
            :columns="columns"
            :data="shots"
            :width="width"
            :height="height"
            :row-height="ROW_HEIGHT"
            :header-height="HEADER_HEIGHT"
            row-key="id"
            :row-class="rowClassOf"
            :row-event-handlers="rowEventHandlers"
            :on-rows-rendered="onRowsRendered"
          >
            <!-- el-table-v2 无内置全选列头，这里自绘表头（选择列渲染全选框，其余列渲染列名） -->
            <template #header-cell="{ column }">
              <el-checkbox
                v-if="column.key === 'select'"
                :model-value="allSelected"
                :indeterminate="someSelected"
                :disabled="isRendering"
                aria-label="全选镜头"
                @change="toggleSelectAll"
              />
              <span v-else>{{ column.title }}</span>
            </template>
            <template #cell="{ column, rowData, rowIndex }">
              <template v-if="column.key === 'select'">
                <el-checkbox
                  :model-value="isSelected(shotOf(rowData))"
                  :disabled="isRendering"
                  aria-label="选择此镜"
                  @change="toggleSelect(shotOf(rowData))"
                />
              </template>
              <template v-else-if="column.key === 'index'">
                <span
                  class="drag-handle"
                  :draggable="!isRendering"
                  @dragstart="onDragStart(rowIndex)"
                  @dragend="dragIndex = -1"
                  title="拖拽排序"
                  >⋮⋮</span
                >
                <span>{{ shotOf(rowData).index }}</span>
              </template>
              <div v-else-if="column.key === 'assets'" class="asset-thumbs">
                <img
                  v-if="thumbOf(headAssetPath(shotOf(rowData)))"
                  :src="thumbOf(headAssetPath(shotOf(rowData)))"
                  class="asset-thumb"
                  :title="headAssetTitle(shotOf(rowData))"
                  decoding="async"
                  @error="onThumbError(headAssetPath(shotOf(rowData)))"
                />
                <span
                  v-else-if="!headAssetPath(shotOf(rowData)) || isThumbFailed(headAssetPath(shotOf(rowData)))"
                  class="asset-missing"
                  >—</span
                >
                <span v-else class="asset-pending">…</span>
                <img
                  v-if="thumbOf(tailAssetPath(shotOf(rowData)))"
                  :src="thumbOf(tailAssetPath(shotOf(rowData)))"
                  class="asset-thumb last"
                  title="尾帧"
                  decoding="async"
                  @error="onThumbError(tailAssetPath(shotOf(rowData)))"
                />
              </div>
              <span v-else-if="column.key === 'scene'" class="cell-ellipsis" :title="shotOf(rowData).scene">{{
                shotOf(rowData).scene
              }}</span>
              <span
                v-else-if="column.key === 'action'"
                class="prompt-text cell-ellipsis"
                :title="shotOf(rowData).action"
                >{{ shotOf(rowData).action }}</span
              >
              <span v-else-if="column.key === 'duration'">
                {{ shotOf(rowData).frameSeconds ? shotOf(rowData).frameSeconds + 's' : '—' }}
              </span>
              <span v-else-if="column.key === 'dialogue'" class="cell-ellipsis" :title="shotOf(rowData).dialogue">{{
                shotOf(rowData).dialogue
              }}</span>
              <template v-else-if="column.key === 'characters'">
                <el-tag v-for="cid in shotOf(rowData).characterIds" :key="cid" size="small" style="margin-right: 4px">
                  {{ getCharacterName(cid) }}
                </el-tag>
              </template>
              <el-tag
                v-else-if="column.key === 'type'"
                :type="shotOf(rowData).type === 'i2v' ? 'primary' : 'success'"
                size="small"
              >
                {{ shotOf(rowData).type === 'i2v' ? '人物' : '空镜' }}
              </el-tag>
              <template v-else-if="column.key === 'workflow'">
                <span v-if="shotOf(rowData).workflow" class="wf-tag">{{ shotOf(rowData).workflow }}</span>
                <span v-else class="wf-default">默认</span>
              </template>
              <template v-else-if="column.key === 'audit'">
                <el-tooltip
                  v-if="shotOf(rowData).auditHint"
                  :content="`点击编辑修正：${shotOf(rowData).auditHint}`"
                  placement="top"
                >
                  <el-tag type="warning" size="small" class="audit-tag" @click.stop="emit('edit', rowIndex)">
                    ⚠ 待整改
                  </el-tag>
                </el-tooltip>
                <span v-else class="wf-default">—</span>
              </template>
              <el-tag v-else-if="column.key === 'status'" :type="statusType(shotOf(rowData).status)" size="small">
                {{ statusText(shotOf(rowData).status) }}
              </el-tag>
              <template v-else-if="column.key === 'actions'">
                <el-button link type="primary" size="small" :disabled="isRendering" @click.stop="emit('edit', rowIndex)"
                  >编辑</el-button
                >
                <el-button
                  link
                  type="warning"
                  size="small"
                  :disabled="isRendering"
                  @click.stop="emit('review', rowIndex)"
                  >审核</el-button
                >
                <el-button
                  link
                  type="success"
                  size="small"
                  :disabled="shotOf(rowData).status === 'rendering' || isRendering"
                  @click.stop="emit('render', shotOf(rowData))"
                >
                  渲染
                </el-button>
                <el-button
                  link
                  type="danger"
                  size="small"
                  :disabled="isRendering"
                  @click.stop="emit('delete', rowIndex)"
                  >删除</el-button
                >
                <!-- REQ-19：触屏/键盘等价入口，打开与右键一致的菜单 -->
                <el-button
                  link
                  size="small"
                  class="more-btn"
                  title="更多操作（等同右键菜单）"
                  aria-label="更多操作"
                  @click.stop="openRowMenu(shotOf(rowData), $event)"
                >
                  <el-icon><MoreFilled /></el-icon>
                </el-button>
              </template>
            </template>
          </el-table-v2>
        </template>
      </el-auto-resizer>
    </div>

    <!-- 右键菜单（REQ-14：复用全局 ContextMenu，自带 Esc/失焦/边缘钳位） -->
    <ContextMenu ref="menuRef" :items="menuItems" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { Column, RowEventHandlers } from 'element-plus'
import {
  VideoPlay,
  CopyDocument,
  DocumentCopy,
  Top,
  Bottom,
  Edit,
  RefreshLeft,
  Delete,
  MoreFilled,
} from '@element-plus/icons-vue'
import type { Character, SceneBoard, Shot } from '../../../../shared/ipcTypes'
import { statusTagType as statusType, shotStatusText as statusText } from '../../utils/status'
import ContextMenu, { type CtxItem } from '../ContextMenu.vue'
import { ensureThumbUrl, invalidateFileUrl, useFileUrl } from '../../composables/useFileUrl'

const props = defineProps<{
  shots: Shot[]
  isRendering: boolean
  characters: Character[]
  sceneBoards: SceneBoard[]
  hasClipboard: boolean
}>()

/** 行高需容纳 56px 缩略图；表头与 el-table 视觉高度对齐 */
const ROW_HEIGHT = 64
const HEADER_HEIGHT = 44

const columns: Column<Shot>[] = [
  { key: 'select', title: '', width: 42, align: 'center' },
  { key: 'index', title: '#', width: 60, align: 'center' },
  { key: 'scene', title: '场景', width: 120 },
  { key: 'assets', title: '资产', width: 120, align: 'center' },
  { key: 'action', title: '动作提示词', width: 200, flexGrow: 2 },
  { key: 'duration', title: '时长', width: 70, align: 'center' },
  { key: 'dialogue', title: '台词', width: 160, flexGrow: 1 },
  { key: 'characters', title: '角色', width: 140 },
  { key: 'type', title: '类型', width: 80, align: 'center' },
  { key: 'workflow', title: '工作流', width: 110 },
  { key: 'audit', title: '审核提示', width: 130 },
  { key: 'status', title: '状态', width: 90 },
  { key: 'actions', title: '操作', width: 210, align: 'center' },
]

/**
 * P2-13：长列表缩略图不再挂原图。两层收敛：
 * 1) 主进程 `file:thumbUrl` 生成最长边 160px 的 JPEG（按源 mtime 缓存），列表只解码小图；
 * 2) 行级虚拟滚动只渲染视口行，这里再按 `onRowsRendered` 给出的缓存区间预热缩略图，
 *    百镜时 DOM 中图片数量与视口相关，不再等于镜数。
 */
const { thumbCache } = useFileUrl()
/** 失败路径 → 失败时刻：短时间内不重复请求，过了窗口再试（产物被重新生成后能自动恢复） */
const failedThumbs = ref<Record<string, number>>({})
const THUMB_RETRY_MS = 10_000

function isThumbFailed(relativePath?: string): boolean {
  if (!relativePath) return false
  const at = failedThumbs.value[relativePath]
  return typeof at === 'number' && Date.now() - at < THUMB_RETRY_MS
}

/** P2-12/P2-13：缩略图加载失败 → 失效源图与缩略图缓存并记为失效，模板回落「—」且短期内不再反复请求 */
function onThumbError(relativePath?: string): void {
  if (!relativePath) return
  failedThumbs.value[relativePath] = Date.now()
  invalidateFileUrl(relativePath)
}

function warmThumb(relativePath?: string): void {
  if (!relativePath || isThumbFailed(relativePath)) return
  void ensureThumbUrl(relativePath).then((url) => {
    if (url) {
      delete failedThumbs.value[relativePath]
      return
    }
    failedThumbs.value[relativePath] = Date.now()
  })
}

const emit = defineEmits<{
  edit: [index: number]
  review: [index: number]
  render: [shot: Shot]
  delete: [index: number]
  currentChange: [row: Shot | null]
  reorder: [from: number, to: number]
  copyPrompt: [shot: Shot]
  copyShot: [index: number]
  pasteShot: [index: number]
  insert: [index: number, position: 'above' | 'below']
  move: [index: number, direction: number]
  reset: [shot: Shot]
  batchRender: [shots: Shot[]]
  batchSkip: [shots: Shot[]]
  batchDelete: [shots: Shot[]]
}>()

/** 表格行数据由 data 数组传入（rowData 运行时即 Shot），显式标注避免模板链路使用 any */
function shotOf(rowData: Shot): Shot {
  return rowData
}

function boardPlate(shot: Shot): string | undefined {
  if (!shot.sceneBoardId) return undefined
  return props.sceneBoards.find((b) => b.id === shot.sceneBoardId)?.emptyPlatePath
}

/** 资产列首图优先级：首帧 → 场景图 → 场景板（与原展示顺序一致） */
function headAssetPath(shot: Shot): string | undefined {
  return shot.firstFramePath || shot.sceneImagePath || boardPlate(shot)
}

function headAssetTitle(shot: Shot): string {
  if (shot.firstFramePath) return '首帧'
  if (shot.sceneImagePath) return '场景图'
  return '场景板'
}

function tailAssetPath(shot: Shot): string | undefined {
  return shot.lastFramePath
}

/** 缩略图 URL；未取到或已失效时返回 undefined，模板据此显示「…」占位或「—」 */
function thumbOf(relativePath?: string): string | undefined {
  if (!relativePath || isThumbFailed(relativePath)) return undefined
  return thumbCache[relativePath]
}

/** 最近一次渲染的缓存区间：数据重载（例如渲染完成回填路径）后按同一区间补预热 */
const warmedRange = { from: 0, to: 0 }

function warmRange(from: number, to: number): void {
  for (let i = from; i <= to; i++) {
    const shot = props.shots[i]
    if (!shot) continue
    warmThumb(headAssetPath(shot))
    warmThumb(tailAssetPath(shot))
  }
}

function onRowsRendered(params: { rowCacheStart: number; rowCacheEnd: number }): void {
  warmedRange.from = params.rowCacheStart
  warmedRange.to = params.rowCacheEnd
  warmRange(params.rowCacheStart, params.rowCacheEnd)
}

// 镜头数据被整体替换（加载/保存后回填）时补预热当前可见区间，避免缩略图停在占位态
watch(
  () => props.shots,
  () => warmRange(warmedRange.from, warmedRange.to),
)

function getCharacterName(id: string) {
  return props.characters.find((c) => c.id === id)?.name || '未知'
}

// 当前行高亮（替代 el-table 的 highlight-current-row；同时供父级 Delete 快捷键定位）
const currentRowId = ref('')

function rowClassOf({ rowData }: { rowData: Shot }): string {
  return rowData.id === currentRowId.value ? 'is-current-row' : ''
}

const rowEventHandlers: RowEventHandlers = {
  onClick: ({ rowData }) => {
    const row = shotOf(rowData)
    currentRowId.value = row.id
    emit('currentChange', row)
  },
  onContextmenu: ({ event, rowData }) => {
    if (!(event instanceof MouseEvent)) return
    event.preventDefault()
    openRowMenu(shotOf(rowData), event)
  },
}

// 右键菜单（REQ-14：全局 ContextMenu 组件）
const menuRef = ref<InstanceType<typeof ContextMenu> | null>(null)
/** 菜单作用于哪一行：打开时按 id 锚定，后台事件重排后仍能定位正确镜头 */
const menuRowId = ref('')
const menuIndex = computed(() => props.shots.findIndex((s) => s.id === menuRowId.value))
const menuRow = computed(() => (menuIndex.value >= 0 ? props.shots[menuIndex.value] : null))

const menuItems = computed<CtxItem[]>(() => {
  if (!menuRow.value) return []
  const index = menuIndex.value
  return [
    { label: '渲染此镜', icon: VideoPlay, disabled: props.isRendering, action: actRender },
    { label: '复制提示词', icon: CopyDocument, action: actCopyPrompt },
    { label: '复制分镜', icon: DocumentCopy, disabled: props.isRendering, action: actCopyShot },
    { label: '粘贴分镜', icon: DocumentCopy, disabled: !props.hasClipboard || props.isRendering, action: actPasteShot },
    { divider: true },
    { label: '上方插入', icon: Top, disabled: props.isRendering, action: () => actInsert('above') },
    { label: '下方插入', icon: Bottom, disabled: props.isRendering, action: () => actInsert('below') },
    { divider: true },
    { label: '上移', icon: Top, disabled: index === 0 || props.isRendering, action: () => actMove(-1) },
    {
      label: '下移',
      icon: Bottom,
      disabled: index === props.shots.length - 1 || props.isRendering,
      action: () => actMove(1),
    },
    { divider: true },
    { label: '编辑', icon: Edit, disabled: props.isRendering, action: actEdit },
    { label: '重置状态', icon: RefreshLeft, disabled: props.isRendering, action: actReset },
    { divider: true },
    { label: '删除', icon: Delete, danger: true, disabled: props.isRendering, action: actDelete },
  ]
})

/** 打开行菜单：右键与「⋯」按钮共用；键盘触发（坐标 0,0）时锚定按钮右下角 */
function openRowMenu(row: Shot, event: MouseEvent): void {
  menuRowId.value = row.id
  const target = event.currentTarget as HTMLElement | null
  const hasPoint = event.clientX > 0 || event.clientY > 0
  const anchor =
    hasPoint || !target
      ? event
      : ({
          clientX: target.getBoundingClientRect().right,
          clientY: target.getBoundingClientRect().bottom,
        } as MouseEvent)
  menuRef.value?.open(anchor, row)
}

// 菜单动作：ContextMenu 在点击项后自动关闭，这里直接上抛给父级处理数据
function actRender() {
  const r = menuRow.value
  if (r) emit('render', r)
}
function actCopyPrompt() {
  const r = menuRow.value
  if (r) emit('copyPrompt', r)
}
function actCopyShot() {
  if (menuIndex.value >= 0) emit('copyShot', menuIndex.value)
}
function actPasteShot() {
  if (menuIndex.value >= 0) emit('pasteShot', menuIndex.value)
}
function actInsert(position: 'above' | 'below') {
  if (menuIndex.value >= 0) emit('insert', menuIndex.value, position)
}
function actMove(direction: number) {
  if (menuIndex.value >= 0) emit('move', menuIndex.value, direction)
}
function actEdit() {
  if (menuIndex.value >= 0) emit('edit', menuIndex.value)
}
function actReset() {
  const r = menuRow.value
  if (r) emit('reset', r)
}
function actDelete() {
  if (menuIndex.value >= 0) emit('delete', menuIndex.value)
}

// REQ-14 RA-20：批量选择（el-table-v2 无内置 selection，改用 id 集合自管）
const selectedIds = ref<string[]>([])

const selectedShots = computed(() => props.shots.filter((s) => selectedIds.value.includes(s.id)))
const allSelected = computed(() => props.shots.length > 0 && selectedShots.value.length === props.shots.length)
const someSelected = computed(() => selectedShots.value.length > 0 && !allSelected.value)

function isSelected(shot: Shot): boolean {
  return selectedIds.value.includes(shot.id)
}

function toggleSelect(shot: Shot): void {
  if (props.isRendering) return
  selectedIds.value = isSelected(shot)
    ? selectedIds.value.filter((id) => id !== shot.id)
    : [...selectedIds.value, shot.id]
}

function toggleSelectAll(): void {
  if (props.isRendering) return
  selectedIds.value = allSelected.value ? [] : props.shots.map((s) => s.id)
}

function clearSelection(): void {
  selectedIds.value = []
}

function onBatchRender(): void {
  const rows = [...selectedShots.value]
  if (rows.length === 0) return
  emit('batchRender', rows)
  clearSelection()
}

function onBatchSkip(): void {
  const rows = [...selectedShots.value]
  if (rows.length === 0) return
  emit('batchSkip', rows)
  clearSelection()
}

function onBatchDelete(): void {
  const rows = [...selectedShots.value]
  if (rows.length === 0) return
  emit('batchDelete', rows)
  clearSelection()
}

// 拖拽排序（R2：渲染中禁用——重排会改变镜头序号，与正在执行的队列/进度事件口径冲突）
const tableWrapRef = ref<HTMLElement | null>(null)
const dragIndex = ref(-1)

function onDragStart(index: number) {
  if (props.isRendering) return
  dragIndex.value = index
}

function onDrop(e: DragEvent) {
  if (props.isRendering || dragIndex.value === -1) return
  // 通过鼠标 Y 坐标定位目标行；虚拟滚动下用 rowkey 反查真实数据下标
  const rows = Array.from(tableWrapRef.value?.querySelectorAll<HTMLElement>('.el-table-v2__row') ?? [])
  const targetRow = rows.find((r) => {
    const rect = r.getBoundingClientRect()
    return e.clientY >= rect.top && e.clientY <= rect.bottom
  })
  const targetId = targetRow?.getAttribute('rowkey') ?? ''
  const targetIndex = props.shots.findIndex((s) => s.id === targetId)
  const from = dragIndex.value
  dragIndex.value = -1
  if (targetIndex === -1 || targetIndex === from) return
  emit('reorder', from, targetIndex)
}
</script>

<style scoped>
/* 竖向撑满分镜页剩余高度，虚拟表由其内部 flex 定高（不再依赖视口魔法数） */
.table-shell {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  padding: 8px 4px 4px;
  overflow: hidden;
}

.batch-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 10px 10px;
  flex-wrap: wrap;
}
.batch-info {
  font-size: var(--font-sm);
  color: var(--text-secondary);
  margin-right: var(--space-2);
}

/* el-auto-resizer 需要确定高度的宿主；占满批次条以下的剩余空间，矮窗口下保底 320px */
.virtual-table {
  flex: 1 1 auto;
  min-height: 320px;
}
.virtual-table :deep(.el-table-v2__row.is-current-row) {
  background: var(--brand-dim);
}

.cell-ellipsis {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.asset-thumbs {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
.asset-thumb {
  width: 40px;
  height: 56px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--border-strong);
  background: var(--bg-input);
  transition: transform var(--dur-fast) var(--ease-out);
}
.asset-thumb:hover {
  transform: scale(1.08);
}
.asset-thumb.last {
  outline: 1px solid var(--accent);
}
.asset-missing {
  color: var(--text-muted);
  font-size: 12px;
}
.asset-pending {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 56px;
  border-radius: 6px;
  border: 1px dashed var(--border-strong);
  background: var(--bg-input);
  color: var(--text-muted);
  font-size: 12px;
}
.prompt-text {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  color: var(--text-secondary);
}
.wf-tag {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  color: var(--warning);
}
.wf-default {
  font-size: 12px;
  color: var(--text-muted);
}
.audit-tag {
  cursor: pointer;
}
.drag-handle {
  cursor: grab;
  color: var(--text-muted);
  margin-right: 4px;
  user-select: none;
  font-size: 14px;
  letter-spacing: -2px;
}
.drag-handle:hover {
  color: var(--brand);
}
.drag-handle:active {
  cursor: grabbing;
}
.menu-item.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.menu-item.disabled:hover {
  background: transparent;
}
</style>
