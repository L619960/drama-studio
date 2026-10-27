<template>
  <div class="detail-block">
    <div v-if="project?.shots?.length" class="shot-list">
      <!-- 批量操作栏 -->
      <div class="batch-bar" v-if="selectedShotIds.length">
        <el-checkbox
          :model-value="allShotsSelected"
          @change="toggleSelectAll"
        >
全选
</el-checkbox>
        <span class="batch-count">已选 {{ selectedShotIds.length }} / {{ project?.shots.length }} 镜</span>
        <el-select v-model="batchWorkflow" placeholder="统一工作流（留空不改）" clearable size="small" style="width: 220px">
          <el-option v-for="w in videoWorkflows" :key="w.name" :label="wfLabel(w)" :value="w.name" />
        </el-select>
        <el-button size="small" @click="applyBatchWorkflow">应用工作流</el-button>
        <el-button
          size="small"
          type="primary"
          :disabled="batchRerendering"
          :loading="batchRerendering"
          @click="rerenderSelected"
        >
批量重渲 ({{ selectedShotIds.length }})
</el-button>
        <el-button size="small" link @click="selectedShotIds = []">清空选择</el-button>
      </div>
      <div v-for="shot in project.shots" :key="shot.id" class="shot-card" :class="[`st-${shot.status}`, { 'is-selected': selectedShotIds.includes(shot.id) }]">
        <div class="shot-head">
          <el-checkbox :model-value="selectedShotIds.includes(shot.id)" @change="toggleSelectShot(shot.id)" />
          <span class="shot-idx">第 {{ shot.index }} 镜 · {{ shot.type === 'i2v' ? '人物镜' : '空镜' }}</span>
          <el-tag size="small" :type="shotStatusTag(shot)" effect="plain">{{ shotStatusText(shot) }}</el-tag>
          <el-tag v-if="shot.reviewed" size="small" type="success" effect="plain">已审核</el-tag>
        </div>
        <div class="shot-media">
          <video
            v-if="urlOf(shot.segmentPath) || urlOf(shot.rawVideoPath)"
            :src="urlOf(shot.segmentPath) || urlOf(shot.rawVideoPath)"
            controls preload="metadata" class="shot-video"
          />
          <img v-else-if="urlOf(shot.firstFramePath)" :src="urlOf(shot.firstFramePath)" class="shot-frame" />
          <div v-else class="shot-no-media">暂无产物（首帧/视频）</div>
        </div>
        <!-- 抽帧预览：视频存在时展示首中尾三帧缩略 -->
        <div v-if="(urlOf(shot.segmentPath) || urlOf(shot.rawVideoPath)) && shotFrames[shot.id]" class="shot-frame-strip">
          <img v-for="(src, idx) in shotFrames[shot.id]" :key="idx" :src="src" class="strip-thumb" />
        </div>
        <div v-else-if="urlOf(shot.segmentPath) || urlOf(shot.rawVideoPath)" class="shot-frame-strip">
          <el-button size="small" link type="primary" @click="extractShotFrames(shot)">抽帧预览</el-button>
        </div>
        <!-- 实时进度条（重渲该镜时：真实事件驱动；事件到达前显示诚实的不定态条纹，不编数字） -->
        <div v-if="liveProgress[shot.id]" class="live-progress">
          <el-progress
            :percentage="liveProgress[shot.id].percent"
            :stroke-width="4"
            :text-inside="true"
            :status="liveProgress[shot.id].failed ? 'exception' : (liveProgress[shot.id].percent >= 100 ? 'success' : '')"
          />
          <div class="live-progress-message">{{ liveProgress[shot.id].message }}</div>
        </div>
        <el-progress
          v-else-if="pendingShots[shot.id]"
          :percentage="100"
          :stroke-width="4"
          :show-text="false"
          striped
          striped-flow
          duration="2"
        />
        <div class="shot-fields">
          <div class="prompt-label">正向提示词 <span class="prompt-hint">（视频渲染实际使用；留空则回退动作模板）</span></div>
          <PromptEditor
            v-model="shotDrafts[shot.id].prompt"
            :rows="2"
            placeholder="英文动作/镜头描述，改后点「重渲此镜」"
            kind="positive"
          />
          <div class="prompt-label">负向提示词 <span class="prompt-hint">（本镜专属追加，自动并入通用压制）</span></div>
          <PromptEditor
            v-model="shotDrafts[shot.id].negative"
            :rows="1"
            placeholder="追加本镜要压制的画面元素，逗号分隔（可留空）"
            kind="negative"
          />
          <div class="prompt-label">台词</div>
          <el-input
            v-model="shotDrafts[shot.id].dialogue"
            type="textarea"
            :rows="1"
            placeholder="本镜台词（可留空）"
          />
          <div class="prompt-label">渲染工作流</div>
          <el-select v-model="shotDrafts[shot.id].workflow" placeholder="默认（项目/全局）" clearable size="small" class="wf-select">
            <el-option v-for="w in videoWorkflows" :key="w.name" :label="wfLabel(w)" :value="w.name" />
          </el-select>
          <div class="shot-actions">
            <el-button
              size="small"
              type="primary"
              :loading="rerenderingShotId === shot.id"
              :disabled="!!rerenderingShotId && rerenderingShotId !== shot.id"
              @click="rerenderShot(shot)"
            >
重渲此镜
</el-button>
          </div>
        </div>
      </div>
    </div>
    <el-empty v-else description="暂无分镜数据（开始任务或打开分镜页生成）" :image-size="60" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import PromptEditor from './PromptEditor.vue'
import {
  type Project, type ProgressEvent, type Shot, type WorkflowMeta
} from '../../../../shared/ipcTypes'

const props = defineProps<{
  project: Project | null
  assetUrls: Record<string, string>
  videoWorkflows: WorkflowMeta[]
  rerenderingShotId: string
}>()

const emit = defineEmits<{
  rerenderShot: [payload: { shotId: string; prompt: string; dialogue: string; negative: string; workflow: string }]
  rerenderShots: [payloads: Array<{ shotId: string; prompt: string; dialogue: string; negative: string; workflow: string }>]
}>()

// ===== 产物 URL 助手 =====
function urlOf(rel?: string): string {
  if (!rel) return ''
  return props.assetUrls[rel] || ''
}

// ===== 工作流能力标签：下拉项显示 [t2i]/[i2v] 等，帮助选择 =====
function wfLabel(w: WorkflowMeta): string {
  return w.capability ? `${w.name}  [${w.capability}]` : w.name
}

// ===== 渲染阶段：镜头提示词/工作流草稿（改后重渲） =====
const shotDrafts = reactive<Record<string, { prompt: string; dialogue: string; negative: string; workflow: string }>>({})
watch(
  () => props.project?.shots,
  (shots) => {
    if (!shots) return
    for (const s of shots) {
      if (!shotDrafts[s.id]) {
        shotDrafts[s.id] = {
          prompt: s.promptEn || s.action,
          dialogue: s.dialogue,
          negative: s.negativeEn || '',
          workflow: s.workflow || ''
        }
      }
    }
  },
  { immediate: true, deep: true }
)

function shotStatusText(shot: Shot): string {
  return shot.status === 'pending' ? '待渲染'
    : shot.status === 'rendering' ? '渲染中'
    : shot.status === 'done' ? '已完成'
    : '失败'
}
function shotStatusTag(shot: Shot): 'info' | 'warning' | 'success' | 'danger' {
  return shot.status === 'pending' ? 'info'
    : shot.status === 'rendering' ? 'warning'
    : shot.status === 'done' ? 'success'
    : 'danger'
}
function rerenderShot(shot: Shot): void {
  const draft = shotDrafts[shot.id]
  if (!draft) return
  startShotProgress(shot.id)
  emit('rerenderShot', {
    shotId: shot.id,
    prompt: draft.prompt.trim(),
    dialogue: draft.dialogue.trim(),
    negative: draft.negative.trim(),
    workflow: draft.workflow
  })
}

// ===== 逐镜批量选择 / 批量重渲 =====
const selectedShotIds = ref<string[]>([])
const batchWorkflow = ref('')
const batchRerendering = ref(false)
const allShotsSelected = computed(() =>
  !!props.project?.shots.length && selectedShotIds.value.length === props.project.shots.length
)
function toggleSelectShot(id: string): void {
  const i = selectedShotIds.value.indexOf(id)
  if (i >= 0) selectedShotIds.value.splice(i, 1)
  else selectedShotIds.value.push(id)
}
function toggleSelectAll(): void {
  if (allShotsSelected.value) selectedShotIds.value = []
  else selectedShotIds.value = (props.project?.shots || []).map(s => s.id)
}
function applyBatchWorkflow(): void {
  if (!batchWorkflow.value) { ElMessage.warning('请先选择工作流'); return }
  for (const id of selectedShotIds.value) {
    if (shotDrafts[id]) shotDrafts[id].workflow = batchWorkflow.value
  }
  ElMessage.success(`已为 ${selectedShotIds.value.length} 镜设置工作流`)
}
function rerenderSelected(): void {
  if (!selectedShotIds.value.length) return
  const payloads = selectedShotIds.value
    .map(id => {
      const d = shotDrafts[id]
      if (!d) return null
      return { shotId: id, prompt: d.prompt.trim(), dialogue: d.dialogue.trim(), negative: d.negative.trim(), workflow: d.workflow }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
  if (!payloads.length) return
  batchRerendering.value = true
  payloads.forEach(p => startShotProgress(p.shotId))
  emit('rerenderShots', payloads)
  // 完成由父组件 project 更新触发；此处兜底复位
  setTimeout(() => { batchRerendering.value = false }, 2000)
}

// ===== 重渲实时进度条（真实事件驱动：render.onProgress 按 shotId 映射 percent/message；
// 已点重渲但事件未到达期间显示诚实的不定态条纹，不再编数字；完成 100→淡出保留） =====
interface ShotLiveProgress { percent: number; message: string; failed?: boolean }
const liveProgress = reactive<Record<string, ShotLiveProgress>>({})
// 已请求重渲、但首个进度事件尚未到达的镜头：只显示转动条纹，不编数字
const pendingShots = reactive<Record<string, true>>({})
const fadeTimers = new Map<string, ReturnType<typeof setTimeout>>()
function startShotProgress(shotId: string): void {
  pendingShots[shotId] = true
}
function finishShotProgress(shotId: string, message?: string, failed = false): void {
  liveProgress[shotId] = { percent: 100, message: message || '完成', failed }
  delete pendingShots[shotId]
  if (fadeTimers.has(shotId)) clearTimeout(fadeTimers.get(shotId)!)
  fadeTimers.set(shotId, setTimeout(() => {
    fadeTimers.delete(shotId)
    delete liveProgress[shotId]
  }, 1500))
}

let unsubscribe: (() => void) | null = null
onMounted(() => {
  // 先清旧再订阅（HMR 安全）；按本组件 project.id 过滤事件
  unsubscribe?.()
  unsubscribe = window.api.onProgress((e: ProgressEvent) => {
    if (!props.project || e.projectId !== props.project.id) return
    delete pendingShots[e.shotId]
    if (e.step === 'done') { finishShotProgress(e.shotId, '完成', false); return }
    if (e.step === 'failed') { finishShotProgress(e.shotId, e.message || '渲染失败', true); return }
    liveProgress[e.shotId] = { percent: e.percent, message: e.message }
  })
})
onUnmounted(() => {
  unsubscribe?.()
  unsubscribe = null
  for (const t of fadeTimers.values()) clearTimeout(t)
  fadeTimers.clear()
})
// 监听 project shots 状态变化：done/failed 即完成（project 重载后的兜底收口）
watch(() => props.project?.shots, (shots) => {
  if (!shots) return
  for (const s of shots) {
    if (liveProgress[s.id] !== undefined && (s.status === 'done' || s.status === 'failed')) {
      finishShotProgress(s.id, s.status === 'done' ? '完成' : (s.error || '渲染失败'), s.status === 'failed')
    }
  }
}, { deep: true })

// ===== 视频抽帧预览：从 video 元素抽首中尾三帧 =====
const shotFrames = reactive<Record<string, string[]>>({})
function extractShotFrames(shot: Shot): void {
  const src = urlOf(shot.segmentPath) || urlOf(shot.rawVideoPath)
  if (!src) return
  const video = document.createElement('video')
  video.src = src
  video.crossOrigin = 'anonymous'
  video.muted = true
  video.preload = 'auto'
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  const result: string[] = []
  const seek = (t: number) => new Promise<void>((resolve) => {
    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve() }
    video.addEventListener('seeked', onSeeked)
    video.currentTime = t
  })
  ;(async () => {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('视频加载失败'))
    })
    const dur = video.duration || 1
    canvas.width = video.videoWidth || 320
    canvas.height = video.videoHeight || 180
    const points = [0, dur / 2, Math.max(0, dur - 0.1)]
    for (const p of points) {
      await seek(p)
      ctx?.drawImage(video, 0, 0, canvas.width, canvas.height)
      result.push(canvas.toDataURL('image/jpeg', 0.6))
    }
    shotFrames[shot.id] = result
  })().catch(() => ElMessage.error('抽帧失败'))
}
</script>

<style scoped>
.detail-block { display: flex; flex-direction: column; gap: 10px; }
.batch-bar {
  display: flex; align-items: center; gap: 10px;
  background: var(--bg-input); border: 1px solid var(--border-weak);
  border-radius: 6px; padding: 8px 12px;
}
.batch-count { font-size: 12px; color: var(--text-secondary); }
.shot-list { display: flex; flex-direction: column; gap: 10px; }
.shot-card {
  background: var(--bg-card);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.shot-card.is-selected { border-color: #409eff; box-shadow: 0 0 0 1px rgba(64,158,255,0.25); }
.shot-card.st-failed { border-color: rgba(245,108,108,0.4); }
.shot-card.st-done { border-color: rgba(103,194,58,0.35); }
.shot-head { display: flex; align-items: center; gap: 8px; }
.shot-idx { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.shot-media { display: flex; align-items: center; justify-content: center; min-height: 60px; }
.shot-video { max-width: 420px; max-height: 236px; border-radius: 6px; background: #000; width: 100%; }
.shot-frame { max-width: 220px; max-height: 240px; border-radius: 6px; object-fit: cover; }
.shot-no-media { font-size: 12px; color: var(--text-muted); padding: 20px 0; }
.shot-frame-strip { display: flex; gap: 6px; align-items: center; min-height: 40px; }
.strip-thumb { width: 96px; height: 54px; object-fit: cover; border-radius: 4px; border: 1px solid var(--border-weak); }
.shot-fields { display: flex; flex-direction: column; gap: 4px; }
.live-progress { display: flex; flex-direction: column; gap: 4px; }
.live-progress-message { font-size: 11px; color: var(--text-muted); }
.prompt-label { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
.prompt-hint { font-size: 11px; color: var(--text-muted); font-weight: 400; }
.wf-select { width: 100%; }
.shot-actions { display: flex; justify-content: flex-end; margin-top: 6px; }
</style>
