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
    <el-table
      ref="tableRef"
      :data="shots"
      style="width: 100%"
      highlight-current-row
      row-key="id"
      @selection-change="onSelectionChange"
      @row-contextmenu="onRowContextMenu"
      @current-change="(row: Shot | null) => emit('currentChange', row)"
      @dragover.prevent
      @drop="onDrop"
    >
      <el-table-column type="selection" width="42" :selectable="() => !isRendering" />
      <el-table-column prop="index" label="#" width="60" align="center">
        <template #default="{ row, $index }">
          <span
            class="drag-handle"
            :draggable="!isRendering"
            @dragstart="onDragStart($index)"
            @dragend="dragIndex = -1"
            title="拖拽排序"
          >⋮⋮</span>
          <span>{{ row.index }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="scene" label="场景" width="120" show-overflow-tooltip />
      <el-table-column label="资产" width="120" align="center">
        <template #default="{ row }">
          <div class="asset-thumbs">
            <img
              v-if="row.firstFramePath && assetUrls[row.firstFramePath]"
              :src="assetUrls[row.firstFramePath]"
              class="asset-thumb"
              title="首帧"
            />
            <img
              v-else-if="row.sceneImagePath && assetUrls[row.sceneImagePath]"
              :src="assetUrls[row.sceneImagePath]"
              class="asset-thumb"
              title="场景图"
            />
            <img
              v-else-if="boardPlate(row) && assetUrls[boardPlate(row)!]"
              :src="assetUrls[boardPlate(row)!]"
              class="asset-thumb"
              title="场景板"
            />
            <span v-else class="asset-missing">—</span>
            <img
              v-if="row.lastFramePath && assetUrls[row.lastFramePath]"
              :src="assetUrls[row.lastFramePath]"
              class="asset-thumb last"
              title="尾帧"
            />
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="action" label="动作提示词" show-overflow-tooltip>
        <template #default="{ row }">
          <span class="prompt-text">{{ row.action }}</span>
        </template>
      </el-table-column>
      <el-table-column label="时长" width="70" align="center">
        <template #default="{ row }">
          <span>{{ row.frameSeconds ? row.frameSeconds + 's' : '—' }}</span>
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
      <el-table-column label="审核提示" width="130" show-overflow-tooltip>
        <template #default="{ row }">
          <el-tooltip
            v-if="row.auditHint"
            :content="`点击编辑修正：${row.auditHint}`"
            placement="top"
          >
            <el-tag
              type="warning"
              size="small"
              class="audit-tag"
              @click.stop="emit('edit', shots.indexOf(row))"
            >
              ⚠ 待整改
            </el-tag>
          </el-tooltip>
          <span v-else class="wf-default">—</span>
        </template>
      </el-table-column>
      <el-table-column prop="status" label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="statusType(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="190" align="center">
        <template #default="{ row, $index }">
          <el-button link type="primary" size="small" @click.stop="emit('edit', $index)" :disabled="isRendering">编辑</el-button>
          <el-button link type="warning" size="small" @click.stop="emit('review', $index)" :disabled="isRendering">审核</el-button>
          <el-button link type="success" size="small" @click.stop="emit('render', row)" :disabled="row.status === 'rendering' || isRendering">渲染</el-button>
          <el-button link type="danger" size="small" @click.stop="emit('delete', $index)" :disabled="isRendering">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 右键菜单（REQ-14：复用全局 ContextMenu，自带 Esc/失焦/边缘钳位） -->
    <ContextMenu ref="menuRef" :items="menuItems" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  VideoPlay, CopyDocument, DocumentCopy, Top, Bottom, Edit, RefreshLeft, Delete
} from '@element-plus/icons-vue'
import type { Character, SceneBoard, Shot } from '../../../../shared/ipcTypes'
import { statusTagType as statusType, shotStatusText as statusText } from '../../utils/status'
import ContextMenu, { type CtxItem } from '../ContextMenu.vue'

const props = defineProps<{
  shots: Shot[]
  assetUrls: Record<string, string>
  isRendering: boolean
  characters: Character[]
  sceneBoards: SceneBoard[]
  hasClipboard: boolean
}>()

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

function boardPlate(shot: Shot): string | undefined {
  if (!shot.sceneBoardId) return undefined
  return props.sceneBoards.find(b => b.id === shot.sceneBoardId)?.emptyPlatePath
}

function getCharacterName(id: string) {
  return props.characters.find(c => c.id === id)?.name || '未知'
}

// 右键菜单（REQ-14：全局 ContextMenu 组件）
const menuRef = ref<InstanceType<typeof ContextMenu> | null>(null)
/** 菜单作用于哪一行：打开时按 id 锚定，后台事件重排后仍能定位正确镜头 */
const menuRowId = ref('')
const menuIndex = computed(() => props.shots.findIndex(s => s.id === menuRowId.value))
const menuRow = computed(() => menuIndex.value >= 0 ? props.shots[menuIndex.value] : null)

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
    { label: '下移', icon: Bottom, disabled: index === props.shots.length - 1 || props.isRendering, action: () => actMove(1) },
    { divider: true },
    { label: '编辑', icon: Edit, disabled: props.isRendering, action: actEdit },
    { label: '重置状态', icon: RefreshLeft, disabled: props.isRendering, action: actReset },
    { divider: true },
    { label: '删除', icon: Delete, danger: true, disabled: props.isRendering, action: actDelete }
  ]
})

function onRowContextMenu(row: Shot, _column: unknown, event: MouseEvent) {
  event.preventDefault()
  menuRowId.value = row.id
  menuRef.value?.open(event, row)
}

// 菜单动作：ContextMenu 在点击项后自动关闭，这里直接上抛给父级处理数据
function actRender() { const r = menuRow.value; if (r) emit('render', r) }
function actCopyPrompt() { const r = menuRow.value; if (r) emit('copyPrompt', r) }
function actCopyShot() { if (menuIndex.value >= 0) emit('copyShot', menuIndex.value) }
function actPasteShot() { if (menuIndex.value >= 0) emit('pasteShot', menuIndex.value) }
function actInsert(position: 'above' | 'below') { if (menuIndex.value >= 0) emit('insert', menuIndex.value, position) }
function actMove(direction: number) { if (menuIndex.value >= 0) emit('move', menuIndex.value, direction) }
function actEdit() { if (menuIndex.value >= 0) emit('edit', menuIndex.value) }
function actReset() { const r = menuRow.value; if (r) emit('reset', r) }
function actDelete() { if (menuIndex.value >= 0) emit('delete', menuIndex.value) }

// REQ-14 RA-20：批量选择
const tableRef = ref<{ clearSelection: () => void } | null>(null)
const selectedShots = ref<Shot[]>([])

function onSelectionChange(rows: Shot[]): void {
  selectedShots.value = rows
}

function clearSelection(): void {
  tableRef.value?.clearSelection()
  selectedShots.value = []
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
const dragIndex = ref(-1)
function onDragStart(index: number) {
  if (props.isRendering) return
  dragIndex.value = index
}
function onDrop(e: DragEvent) {
  if (props.isRendering || dragIndex.value === -1) return
  // 通过鼠标 Y 坐标定位目标行
  const rows = Array.from(document.querySelectorAll<HTMLElement>('.el-table__body-wrapper .el-table__row'))
  const targetRow = rows.find(r => {
    const rect = r.getBoundingClientRect()
    return e.clientY >= rect.top && e.clientY <= rect.bottom
  })
  const targetIndex = targetRow ? rows.indexOf(targetRow) : -1
  const from = dragIndex.value
  dragIndex.value = -1
  if (targetIndex === -1 || targetIndex === from) return
  emit('reorder', from, targetIndex)
}
</script>

<style scoped>
.table-shell { padding: 8px 4px 4px; overflow: hidden; }

.batch-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 10px 10px;
  flex-wrap: wrap;
}
.batch-info { font-size: var(--font-sm); color: var(--text-secondary); margin-right: var(--space-2); }

.asset-thumbs { display: flex; align-items: center; justify-content: center; gap: 4px; }
.asset-thumb {
  width: 40px; height: 56px; object-fit: cover; border-radius: 6px;
  border: 1px solid var(--border-strong); background: var(--bg-input);
  transition: transform var(--dur-fast) var(--ease-out);
}
.asset-thumb:hover { transform: scale(1.08); }
.asset-thumb.last { outline: 1px solid var(--accent); }
.asset-missing { color: var(--text-muted); font-size: 12px; }
.prompt-text { font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: var(--text-secondary); }
.wf-tag { font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: var(--warning); }
.wf-default { font-size: 12px; color: var(--text-muted); }
.audit-tag { cursor: pointer; }
.drag-handle {
  cursor: grab;
  color: var(--text-muted);
  margin-right: 4px;
  user-select: none;
  font-size: 14px;
  letter-spacing: -2px;
}
.drag-handle:hover { color: var(--brand); }
.drag-handle:active { cursor: grabbing; }
.menu-item.disabled { opacity: 0.4; cursor: not-allowed; }
.menu-item.disabled:hover { background: transparent; }
</style>
