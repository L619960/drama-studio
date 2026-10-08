﻿﻿﻿﻿﻿<template>
  <div class="storyboard">
    <div class="header">
      <h1>分镜编辑</h1>
      <div class="actions">
        <el-button @click="$router.push(`/project/${projectId}/characters`)">角色库</el-button>
        <el-button type="primary" @click="addShot" :disabled="isRendering">添加分镜</el-button>
        <el-button @click="openSplitDialog" :disabled="isRendering">
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

    <!-- 编辑对话框 -->
    <el-dialog v-model="showEditDialog" :title="editingIndex === -1 ? '添加分镜' : '编辑分镜'" width="650px">
      <el-form :model="editForm" label-width="100px">
        <el-form-item label="场景">
          <el-input v-model="editForm.scene" placeholder="如：雨夜天台" />
        </el-form-item>
        <el-form-item label="动作提示词" required>
          <div class="prompt-row">
            <el-input
              v-model="editForm.action"
              type="textarea"
              :rows="2"
              placeholder="英文动作描述，如：slowly turns head, gentle smile, cinematic lighting"
              style="flex:1"
            />
            <el-button :loading="optimizing" @click="optimizePrompt" size="small" style="margin-left:8px;align-self:flex-start">
              <el-icon><MagicStick /></el-icon> AI 优化
            </el-button>
          </div>
          <div class="form-tip">建议使用英文，逗号分隔多个动作；AI 优化可把中文描述转成专业英文提示词</div>
        </el-form-item>
        <el-form-item label="台词">
          <el-input v-model="editForm.dialogue" type="textarea" :rows="2" placeholder="中文台词，用于 TTS" />
        </el-form-item>
        <el-form-item label="类型">
          <el-radio-group v-model="editForm.type">
            <el-radio value="i2v">人物镜头(I2V)</el-radio>
            <el-radio value="t2v">空镜(T2V)</el-radio>
          </el-radio-group>
          <div v-if="editForm.type === 't2v'" class="form-tip" style="color:#e6a23c">空镜需上传场景参考图，否则无法渲染</div>
        </el-form-item>
        <el-form-item label="场景图" v-if="editForm.type === 't2v'">
          <div class="scene-image">
            <img v-if="editForm.sceneImagePath && urlCache[editForm.sceneImagePath]" :src="urlCache[editForm.sceneImagePath]" class="scene-thumb" />
            <div v-else class="scene-thumb empty">未选择场景图</div>
            <el-button size="small" @click="importSceneImage">
              <el-icon><Upload /></el-icon> {{ editForm.sceneImagePath ? '更换' : '导入' }}
            </el-button>
            <el-button size="small" :loading="generatingSceneImage" @click="generateSceneImage">
              <el-icon><MagicStick /></el-icon>AI 生成
            </el-button>
          </div>
        </el-form-item>
        <el-form-item label="角色" v-if="editForm.type === 'i2v'">
          <el-select v-model="editForm.characterIds" multiple placeholder="选择角色" style="width: 100%">
            <el-option v-for="c in characters" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="时长">
          <el-input-number v-model="editForm.frames" :min="33" :max="120" :step="16" style="width: 120px" />
          <span class="form-tip" style="margin-left: 12px">
            {{ editForm.frames }}帧 ≈ {{ ((editForm.frames - 1) / 16).toFixed(0) }}秒
          </span>
        </el-form-item>
        <el-form-item label="Seed">
          <el-input-number v-model="editForm.seed" :min="0" style="width: 150px" />
          <el-button size="small" style="margin-left: 8px" @click="randomizeSeed">随机</el-button>
        </el-form-item>
        <el-form-item label="工作流">
          <el-select v-model="editForm.workflow" placeholder="使用默认工作流" clearable style="width: 240px">
            <el-option
              v-for="w in workflows"
              :key="w.name"
              :label="w.name"
              :value="w.name"
            >
              <span>{{ w.name }}</span>
              <el-tag size="small" style="margin-left: 8px">{{ w.hasImageInput ? 'I2V' : 'T2V' }}</el-tag>
            </el-option>
          </el-select>
          <span class="form-tip" style="margin-left: 12px">留空使用项目/全局默认</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditDialog = false">取消</el-button>
        <el-button type="primary" @click="saveShot">保存</el-button>
      </template>
    </el-dialog>

    <!-- AI 拆分镜对话框 -->
    <el-dialog v-model="splitDialog.visible" title="AI 拆分镜" width="700px">
      <el-input
        v-model="splitDialog.script"
        type="textarea"
        :rows="12"
        placeholder="粘贴剧本内容（支持中文），AI 将自动拆分为分镜列表，包含场景名、英文动作提示词、台词和镜头类型（人物/空镜）"
      />
      <template #footer>
        <el-button @click="splitDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="splitDialog.loading" @click="doSplitScript">
          {{ splitDialog.loading ? '拆分中...' : '开始拆分' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useHotkeys } from '../composables/useHotkeys'
import { clearFileUrlCache, useFileUrl } from '../composables/useFileUrl'
const { urlCache, ensureFileUrl } = useFileUrl()
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  VideoPlay, CopyDocument, DocumentCopy, Top, Bottom, Edit, RefreshLeft, Delete, MagicStick, Upload
} from '@element-plus/icons-vue'
import type { Project, Shot, WorkflowMeta } from '../../../shared/ipcTypes'
import { snapshot } from '../utils/snapshot'

const route = useRoute()
const projectId = route.params.id as string

const project = ref<Project | null>(null)
const workflows = ref<WorkflowMeta[]>([])
const showEditDialog = ref(false)
const editingIndex = ref(-1)
const rendering = ref(false)
// 渲染默认帧数（从设置加载，新建分镜时使用）
const defaultFrames = ref(81)
const editForm = ref({
  scene: '',
  action: '',
  dialogue: '',
  type: 'i2v' as 'i2v' | 't2v',
  characterIds: [] as string[],
  frames: 81,
  seed: 42,
  workflow: '',
  sceneImagePath: ''
})

// AI 拆分镜对话框
const splitDialog = ref({ visible: false, loading: false, script: '' })
const optimizing = ref(false)
// AI 生成场景图
const generatingSceneImage = ref(false)

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
  editForm.value = { scene: '', action: '', dialogue: '', type: 'i2v', characterIds: [], frames: defaultFrames.value, seed: Math.floor(Math.random() * 1000000), workflow: '', sceneImagePath: '' }
  showEditDialog.value = true
}

// Ctrl+N 新建分镜（渲染中或编辑框已打开时忽略）
useHotkeys([
  {
    keys: 'ctrl+n',
    handler: () => {
      if (isRendering.value || showEditDialog.value) return
      addShot()
    }
  }
])

function editShot(index: number) {
  editingIndex.value = index
  const shot = shots.value[index]
  editForm.value = {
    scene: shot.scene,
    action: shot.action,
    dialogue: shot.dialogue,
    type: shot.type,
    characterIds: [...shot.characterIds],
    frames: shot.frames,
    seed: shot.seed,
    workflow: shot.workflow || '',
    sceneImagePath: shot.sceneImagePath || ''
  }
  if (shot.sceneImagePath) {
    ensureFileUrl(shot.sceneImagePath)
  }
  showEditDialog.value = true
  contextMenu.value.visible = false
}

// AI 优化提示词（支持中英混合输入）
async function optimizePrompt() {
  if (!project.value) return
  if (!editForm.value.action.trim()) {
    ElMessage.warning('请先输入动作描述')
    return
  }
  optimizing.value = true
  try {
    const result = await window.api.llm.translatePrompt({
      scene: editForm.value.scene,
      action: editForm.value.action,
      dialogue: editForm.value.dialogue,
      genre: project.value.genre
    })
    editForm.value.action = result
    ElMessage.success('提示词已优化')
  } catch (e) {
    ElMessage.error((e as Error).message || 'AI 优化失败')
  } finally {
    optimizing.value = false
  }
}

// 打开 AI 拆分镜对话框
function openSplitDialog() {
  splitDialog.value = { visible: true, loading: false, script: '' }
}

// 执行 AI 拆分镜并追加到分镜列表
async function doSplitScript() {
  if (!project.value) return
  if (!splitDialog.value.script.trim()) {
    ElMessage.warning('请输入剧本内容')
    return
  }
  splitDialog.value.loading = true
  try {
    const generated = await window.api.llm.splitScript(splitDialog.value.script, project.value.genre)
    if (generated.length === 0) throw new Error('未拆分出有效分镜')
    // 追加分镜
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
    splitDialog.value.visible = false
    ElMessage.success(`AI 拆分完成，新增 ${newShots.length} 个分镜`)
  } catch (e) {
    ElMessage.error((e as Error).message || '拆分失败')
  } finally {
    splitDialog.value.loading = false
  }
}

// 导入场景参考图
async function importSceneImage() {
  try {
    const relPath = await window.api.shot.importSceneImage(projectId)
    editForm.value.sceneImagePath = relPath
    await ensureFileUrl(relPath)
  } catch {
    // 用户取消
  }
}

/** AI 生成场景图：用场景描述构建提示词 */
async function generateSceneImage() {
  const scene = editForm.value.scene || 'cinematic scene'
  generatingSceneImage.value = true
  try {
    const prompt = `cinematic scene, ${scene}, wide angle, detailed environment, atmospheric lighting, high quality, 8k`
    const shotId = editingIndex.value >= 0 ? project.value!.shots[editingIndex.value].id : `new_${Date.now()}`
    const rel = `projects/${projectId}/shots/${shotId}_scene.png`
    await window.api.image.generate(prompt, rel)
    editForm.value.sceneImagePath = rel
    await ensureFileUrl(rel)
    ElMessage.success('场景图生成成功')
  } catch (e) {
    ElMessage.error(`生成失败: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    generatingSceneImage.value = false
  }
}

async function saveShot() {
  if (!project.value) return
  if (!editForm.value.action.trim()) {
    ElMessage.warning('请输入动作提示词')
    return
  }

  const shot: Shot = {
    id: editingIndex.value === -1 ? `shot_${Date.now()}` : shots.value[editingIndex.value].id,
    index: editingIndex.value === -1 ? shots.value.length + 1 : shots.value[editingIndex.value].index,
    scene: editForm.value.scene,
    action: editForm.value.action,
    dialogue: editForm.value.dialogue,
    type: editForm.value.type,
    characterIds: editForm.value.type === 't2v' ? [] : editForm.value.characterIds,
    width: 720,
    height: 480,
    frames: editForm.value.frames,
    seed: editForm.value.seed,
    workflow: editForm.value.workflow || undefined,
    sceneImagePath: editForm.value.type === 't2v' ? editForm.value.sceneImagePath || undefined : undefined,
    status: 'pending'
  }

  // 作废旧产物与整集成片（编辑/新增均会改变成片内容）
  const oldShot = editingIndex.value === -1 ? undefined : shots.value[editingIndex.value]
  await invalidateArtifacts(oldShot)

  if (editingIndex.value === -1) {
    project.value.shots.push(shot)
  } else {
    project.value.shots[editingIndex.value] = shot
  }

  await window.api.project.save(snapshot(project.value))
  showEditDialog.value = false
  ElMessage.success('保存成功')
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
  editForm.value = {
    scene: shot.scene, action: shot.action, dialogue: shot.dialogue,
    type: shot.type, characterIds: [...shot.characterIds],
    frames: shot.frames, seed: shot.seed, workflow: '', sceneImagePath: ''
  }
  showEditDialog.value = true
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

function randomizeSeed() {
  editForm.value.seed = Math.floor(Math.random() * 1000000)
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
.prompt-row { display: flex; width: 100%; }
.scene-image { display: flex; align-items: center; gap: 12px; }
.scene-thumb {
  width: 160px; height: 90px; object-fit: cover; border-radius: 6px;
  border: 1px solid var(--border-strong); background: var(--bg-input);
}
.scene-thumb.empty {
  display: flex; align-items: center; justify-content: center;
  color: var(--text-muted); font-size: 12px;
}
.form-tip { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
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
