<template>
  <div class="glass-panel table-shell">
    <el-table
      :data="shots"
      style="width: 100%"
      highlight-current-row
      @row-contextmenu="onRowContextMenu"
      @current-change="(row: Shot | null) => emit('currentChange', row)"
      @dragover.prevent
      @drop="onDrop"
    >
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

    <!-- 右键菜单 -->
    <teleport to="body">
      <div
        v-if="contextMenu.visible"
        class="context-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
        @click.stop
      >
        <div class="menu-item" @click="!isRendering && actRender()" :class="{ disabled: isRendering }">
          <el-icon><VideoPlay /></el-icon>渲染此镜
        </div>
        <div class="menu-item" @click="actCopyPrompt()">
          <el-icon><CopyDocument /></el-icon>复制提示词
        </div>
        <div class="menu-item" @click="!isRendering && actCopyShot()" :class="{ disabled: isRendering }">
          <el-icon><DocumentCopy /></el-icon>复制分镜
        </div>
        <div class="menu-item" @click="!isRendering && hasClipboard && actPasteShot()" :class="{ disabled: !hasClipboard || isRendering }">
          <el-icon><DocumentCopy /></el-icon>粘贴分镜
        </div>
        <div class="menu-divider" />
        <div class="menu-item" @click="!isRendering && actInsert('above')" :class="{ disabled: isRendering }">
          <el-icon><Top /></el-icon>上方插入
        </div>
        <div class="menu-item" @click="!isRendering && actInsert('below')" :class="{ disabled: isRendering }">
          <el-icon><Bottom /></el-icon>下方插入
        </div>
        <div class="menu-divider" />
        <div class="menu-item" @click="!isRendering && actMove(-1)" :class="{ disabled: contextMenu.index === 0 || isRendering }">
          <el-icon><Top /></el-icon>上移
        </div>
        <div class="menu-item" @click="!isRendering && actMove(1)" :class="{ disabled: contextMenu.index === shots.length - 1 || isRendering }">
          <el-icon><Bottom /></el-icon>下移
        </div>
        <div class="menu-divider" />
        <div class="menu-item" @click="!isRendering && actEdit()" :class="{ disabled: isRendering }">
          <el-icon><Edit /></el-icon>编辑
        </div>
        <div class="menu-item" @click="!isRendering && actReset()" :class="{ disabled: isRendering }">
          <el-icon><RefreshLeft /></el-icon>重置状态
        </div>
        <div class="menu-divider" />
        <div class="menu-item danger" @click="!isRendering && actDelete()" :class="{ disabled: isRendering }">
          <el-icon><Delete /></el-icon>删除
        </div>
      </div>
    </teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import {
  VideoPlay, CopyDocument, DocumentCopy, Top, Bottom, Edit, RefreshLeft, Delete
} from '@element-plus/icons-vue'
import type { Character, SceneBoard, Shot } from '../../../../shared/ipcTypes'
import { statusTagType as statusType, shotStatusText as statusText } from '../../utils/status'

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
}>()

function boardPlate(shot: Shot): string | undefined {
  if (!shot.sceneBoardId) return undefined
  return props.sceneBoards.find(b => b.id === shot.sceneBoardId)?.emptyPlatePath
}

function getCharacterName(id: string) {
  return props.characters.find(c => c.id === id)?.name || '未知'
}

// 右键菜单
const contextMenu = ref({ visible: false, x: 0, y: 0, row: null as Shot | null, index: -1 })

function onRowContextMenu(row: Shot, _column: unknown, event: MouseEvent) {
  event.preventDefault()
  const index = props.shots.findIndex(s => s.id === row.id)
  contextMenu.value = { visible: true, x: event.clientX, y: event.clientY, row, index }
}

function closeContextMenu() {
  contextMenu.value.visible = false
}

onMounted(() => {
  document.addEventListener('click', closeContextMenu)
})
onUnmounted(() => {
  document.removeEventListener('click', closeContextMenu)
})

// 菜单动作：先关菜单（与原父级各 handler 末尾关菜单等价），再上抛给父级处理数据
function actRender() { const r = contextMenu.value.row; if (!r) return; closeContextMenu(); emit('render', r) }
function actCopyPrompt() { const r = contextMenu.value.row; if (!r) return; closeContextMenu(); emit('copyPrompt', r) }
function actCopyShot() { closeContextMenu(); emit('copyShot', contextMenu.value.index) }
function actPasteShot() { closeContextMenu(); emit('pasteShot', contextMenu.value.index) }
function actInsert(position: 'above' | 'below') { closeContextMenu(); emit('insert', contextMenu.value.index, position) }
function actMove(direction: number) { closeContextMenu(); emit('move', contextMenu.value.index, direction) }
function actEdit() { closeContextMenu(); emit('edit', contextMenu.value.index) }
function actReset() { const r = contextMenu.value.row; if (!r) return; closeContextMenu(); emit('reset', r) }
function actDelete() { closeContextMenu(); emit('delete', contextMenu.value.index) }

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
