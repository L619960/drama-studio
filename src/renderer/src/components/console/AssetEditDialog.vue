<template>
  <el-dialog
    v-model="assetDialogVisible"
    :title="assetDialogTitle"
    width="760px"
    top="6vh"
    append-to-body
    :close-on-click-modal="false"
    destroy-on-close
  >
    <div class="asset-dialog" v-if="assetEditing">
      <div class="asset-dialog-row">
        <div class="asset-dialog-preview">
          <div class="asset-dialog-label">当前产物</div>
          <div class="asset-dialog-img">
            <img v-if="assetEditing.currentUrl" :src="assetEditing.currentUrl" />
            <el-empty v-else description="暂无产物" :image-size="60" />
          </div>
          <div class="asset-dialog-compare" v-if="assetEditing.previousUrl">
            <div class="asset-dialog-label">上一版（可回滚）</div>
            <img :src="assetEditing.previousUrl" />
            <el-button size="small" type="warning" plain :loading="rollbackBusy" @click="rollbackAsset">回滚到上一版</el-button>
          </div>
        </div>
        <div class="asset-dialog-form">
          <div class="prompt-label">正向提示词 <span class="prompt-hint">（英文为主，Ctrl+Enter 生成）</span></div>
          <PromptEditor v-model="assetEditing.prompt" :rows="5" placeholder="描述想要的画面" kind="positive" @ctrl-enter="confirmAssetRegenerate" />
          <div class="prompt-chips">
            <el-tag
              v-for="s in PROMPT_SNIPPETS"
              :key="s"
              size="small"
              effect="plain"
              class="chip"
              @click="appendSnippet(s)"
            >{{ s }}</el-tag>
          </div>
          <div class="prompt-label">追加负向提示词 <span class="prompt-hint">（追加到系统默认压制词之后，不会替换；留空仅用默认）</span></div>
          <PromptEditor v-model="assetEditing.negative" :rows="2" placeholder="追加要压制的元素，逗号分隔，如：crowd, vehicles（可留空）" kind="negative" />
          <div class="prompt-label">图像工作流 <span class="prompt-hint">（单次生效，不改项目默认）</span></div>
          <el-select v-model="assetEditing.workflow" placeholder="默认工作流" clearable class="wf-select">
            <el-option v-for="w in imageWorkflows" :key="w.name" :label="wfLabel(w)" :value="w.name" />
          </el-select>
        </div>
      </div>
    </div>
    <template #footer>
      <el-button @click="resetAssetDraft">重置为原值</el-button>
      <el-button @click="assetDialogVisible = false">取消</el-button>
      <el-button
        type="primary"
        :loading="assetBusySet.has(assetEditingKey)"
        :disabled="!assetEditing?.prompt.trim()"
        @click="confirmAssetRegenerate"
      >重新生成</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import PromptEditor from './PromptEditor.vue'
import {
  type Project, type WorkflowMeta,
  type AssetRegenerateKind, type AssetRegenerateInput
} from '../../../../shared/ipcTypes'

const props = defineProps<{
  project: Project | null
  assetUrls: Record<string, string>
  imageWorkflows: WorkflowMeta[]
}>()

const emit = defineEmits<{
  'asset-refreshed': []
}>()

// ===== 提示词模板片段：点击追加到当前 textarea =====
const PROMPT_SNIPPETS = [
  'cinematic lighting', 'soft natural light', 'volumetric fog',
  'shallow depth of field', 'wide angle', 'close-up shot',
  'highly detailed, 8k', 'film grain', 'golden hour'
]

// ===== 产物编辑（弹窗模式，编辑暂存，点「重新生成」才落盘） =====
interface AssetEditState {
  kind: AssetRegenerateKind
  id: string
  prompt: string
  negative: string
  workflow: string
  /** 打开 dialog 时的原始提示词，用于「重置」 */
  originalPrompt: string
  originalNegative: string
  originalWorkflow: string
  /** 当前产物预览 URL */
  currentUrl: string
  /** 上一版备份 URL（生成成功后由主进程返回 previousPath，经 assetUrls 映射） */
  previousUrl?: string
}
const assetBusySet = ref<Set<string>>(new Set())
const assetEditing = ref<AssetEditState | null>(null)
const assetDialogVisible = ref(false)
const rollbackBusy = ref(false)
const assetEditingKey = computed(() => assetEditing.value ? draftKey(assetEditing.value.kind, assetEditing.value.id) : '')
const assetDialogTitle = computed(() => {
  const k = assetEditing.value?.kind
  if (!k) return '编辑产物'
  return k === 'charFace' ? '编辑角色脸图' : k === 'charBody' ? '编辑角色三视图'
    : k === 'scenePlate' ? '编辑场景板空场景图' : k === 'firstFrame' ? '编辑首帧' : '编辑尾帧'
})
function draftKey(kind: AssetRegenerateKind, id: string): string {
  const head = kind === 'charFace' ? 'char:face' : kind === 'charBody' ? 'char:body' : kind === 'scenePlate' ? 'scene' : (kind === 'firstFrame' ? 'frame:first' : 'frame:last')
  return `${head}:${id}`
}
function openAssetDialog(kind: AssetRegenerateKind, id: string, seedPrompt: string, currentUrl: string): void {
  assetEditing.value = {
    kind, id,
    prompt: seedPrompt,
    negative: '',
    workflow: '',
    originalPrompt: seedPrompt,
    originalNegative: '',
    originalWorkflow: '',
    currentUrl
  }
  assetDialogVisible.value = true
}
function isBusy(kind: AssetRegenerateKind, id: string): boolean {
  return assetBusySet.value.has(draftKey(kind, id))
}
function resetAssetDraft(): void {
  if (!assetEditing.value) return
  assetEditing.value.prompt = assetEditing.value.originalPrompt
  assetEditing.value.negative = assetEditing.value.originalNegative
  assetEditing.value.workflow = assetEditing.value.originalWorkflow
}
function appendSnippet(snippet: string): void {
  if (!assetEditing.value) return
  const cur = assetEditing.value.prompt
  assetEditing.value.prompt = cur ? `${cur}, ${snippet}` : snippet
}
function wfLabel(w: WorkflowMeta): string {
  return w.capability ? `${w.name}  [${w.capability}]` : w.name
}
function buildAssetPayload(kind: AssetRegenerateKind, id: string, d: { prompt: string; negative: string; workflow: string }): AssetRegenerateInput | null {
  const p = props.project
  if (!p) return null
  const payload: AssetRegenerateInput = { projectId: p.id, kind, prompt: d.prompt.trim(), negative: d.negative.trim() || undefined, workflow: d.workflow || undefined }
  if (kind === 'charFace' || kind === 'charBody') payload.characterId = id
  else if (kind === 'scenePlate') payload.boardId = id
  else payload.shotId = id
  return payload
}
async function confirmAssetRegenerate(): Promise<void> {
  const s = assetEditing.value
  if (!s) return
  if (!s.prompt.trim()) { ElMessage.warning('提示词不能为空'); return }
  const k = draftKey(s.kind, s.id)
  if (assetBusySet.value.has(k)) return
  const payload = buildAssetPayload(s.kind, s.id, s)
  if (!payload) return
  assetBusySet.value = new Set(assetBusySet.value).add(k)
  try {
    const res = await window.api.asset.regenerate(payload)
    if (res.previousPath) {
      ;(s as AssetEditState & { _prevRel?: string })._prevRel = res.previousPath
      try { s.previousUrl = await window.api.file.mediaUrl(res.previousPath) } catch { s.previousUrl = '' }
    }
    ElMessage.success('已重新生成')
    emit('asset-refreshed')
  } catch (e) {
    ElMessage.error((e as Error)?.message || '生成失败')
  } finally {
    const next = new Set(assetBusySet.value)
    next.delete(k)
    assetBusySet.value = next
  }
}
async function rollbackAsset(): Promise<void> {
  const s = assetEditing.value
  if (!s) return
  const k = draftKey(s.kind, s.id)
  const payload = buildAssetPayload(s.kind, s.id, s)
  if (!payload) return
  rollbackBusy.value = true
  try {
    await window.api.asset.rollback(payload)
    ElMessage.success('已回滚到上一版')
    s.previousUrl = undefined
    ;(s as AssetEditState & { _prevRel?: string })._prevRel = undefined
    emit('asset-refreshed')
  } catch (e) {
    ElMessage.error((e as Error)?.message || '回滚失败')
  } finally {
    rollbackBusy.value = false
  }
}
// project 更新后刷新 dialog 内当前产物 URL（上一版图 URL 由 regenerate 返回时直接用 mediaUrl 取得）
watch(() => props.project, () => {
  const s = assetEditing.value
  if (!s) return
  const rel = currentAssetRelPath(s.kind, s.id)
  if (rel) s.currentUrl = props.assetUrls[rel] || s.currentUrl
}, { deep: true })
function currentAssetRelPath(kind: AssetRegenerateKind, id: string): string | undefined {
  const p = props.project
  if (!p) return undefined
  if (kind === 'charFace' || kind === 'charBody') {
    const c = p.characters.find(x => x.id === id)
    return kind === 'charFace' ? (c?.faceImagePath || c?.refImagePath) : c?.bodySheetPath
  }
  if (kind === 'scenePlate') {
    return (p.sceneBoards || []).find(b => b.id === id)?.emptyPlatePath
  }
  const shot = p.shots.find(s => s.id === id)
  return kind === 'firstFrame' ? shot?.firstFramePath : shot?.lastFramePath
}

defineExpose({
  open: openAssetDialog,
  isBusy
})
</script>

<style scoped>
.asset-dialog-row { display: flex; gap: 16px; }
.asset-dialog-preview { flex: 0 0 280px; display: flex; flex-direction: column; gap: 10px; }
.asset-dialog-label { font-size: 12px; color: var(--text-muted); margin-bottom: 4px; }
.asset-dialog-img {
  width: 100%; height: 180px; border-radius: 6px; background: var(--bg-input);
  display: flex; align-items: center; justify-content: center; overflow: hidden;
}
.asset-dialog-img img { width: 100%; height: 100%; object-fit: cover; }
.asset-dialog-compare { display: flex; flex-direction: column; gap: 6px; }
.asset-dialog-compare img { width: 100%; height: 120px; object-fit: cover; border-radius: 6px; border: 1px dashed var(--border-weak); }
.asset-dialog-form { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.prompt-label { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
.prompt-hint { font-size: 11px; color: var(--text-muted); font-weight: 400; }
.prompt-chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0 6px; }
.prompt-chips .chip { cursor: pointer; }
.prompt-chips .chip:hover { opacity: 0.8; }
.wf-select { width: 100%; }
</style>
