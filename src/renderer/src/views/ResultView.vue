<template>
  <div class="result-view page">
    <div class="page-header">
      <div>
        <h1>成片预览</h1>
        <p class="subtitle">合成、字幕与 BGM 增强导出</p>
      </div>
      <div class="page-actions">
        <el-button @click="loadAll()" :loading="loadingFinal">
          <el-icon><Refresh /></el-icon>刷新
        </el-button>
        <el-button @click="combineVideo" :disabled="!canCombine" :loading="combining">
          <el-icon><VideoPlay /></el-icon>
          {{ combining ? '合成中...' : finalVideoPath ? '重新合成' : '合成成片' }}
        </el-button>
        <el-button type="primary" @click="exportVideo" :disabled="!finalVideoPath" :loading="exporting">
          <el-icon><Download /></el-icon>导出视频
        </el-button>
      </div>
    </div>

    <!-- 合成状态 -->
    <el-alert
      v-if="combineStatus"
      :type="combineStatus.type"
      :title="combineStatus.message"
      show-icon
      :closable="false"
      style="margin-bottom: 16px"
    />

    <!-- 成片播放器 -->
    <div class="video-container glass-panel" v-if="finalVideoPath">
      <video
        ref="mainVideoEl"
        controls
        playsinline
        preload="metadata"
        :src="urlCache[finalVideoPath] || undefined"
        style="max-width: 100%; max-height: 60vh"
        @error="onMainVideoError"
      />
      <div class="video-info">
        <span>时长: {{ finalDuration }}秒</span>
        <span>大小: {{ finalSize }}MB</span>
        <el-button size="small" type="primary" plain @click="playMainVideo">播放</el-button>
        <el-button size="small" @click="showInFolder(finalVideoPath!)">定位文件</el-button>
      </div>
      <p v-if="videoError" class="video-error">{{ videoError }}</p>
    </div>
    <el-empty v-else description="暂无成片，请先完成渲染并合成">
      <div class="empty-actions">
        <el-button @click="router.push(`/project/${projectId}/storyboard`)">去分镜编辑</el-button>
        <el-button type="primary" @click="router.push(`/project/${projectId}/queue`)">去渲染队列</el-button>
      </div>
    </el-empty>

    <!-- 增强导出（字幕 / BGM） -->
    <div class="enhance-card glass-panel" v-if="finalVideoPath">
      <h3>增强导出</h3>
      <div class="enhance-row">
        <div class="enhance-item">
          <span class="enhance-label">硬字幕</span>
          <el-button size="small" :loading="burningSubtitle" @click="burnSubtitles" :disabled="!hasDialogue">
            烧录字幕版
          </el-button>
          <span v-if="!hasDialogue" class="form-tip">无台词分镜，无需字幕</span>
        </div>
        <div class="enhance-item">
          <span class="enhance-label">BGM 混音</span>
          <el-button size="small" :loading="selectingBgm" @click="selectBgm">{{ project?.bgmPath ? '更换 BGM' : '选择 BGM' }}</el-button>
          <el-slider v-if="project?.bgmPath" v-model="bgmVolume" :min="0" :max="100" style="width: 120px" :format-tooltip="(v: number) => v + '%'" />
          <el-button v-if="project?.bgmPath" size="small" type="primary" :loading="mixingBgm" @click="mixBgm">
            混音导出
          </el-button>
          <span v-if="project?.bgmPath" class="form-tip">音量 {{ bgmVolume }}%</span>
        </div>
      </div>
      <div class="enhance-outputs">
        <div v-for="item in enhancedOutputs" :key="item.path" class="output-item">
          <span class="output-name">{{ item.label }}</span>
          <video :src="urlCache[item.path]" controls style="width: 240px; height: 135px" />
          <div class="output-actions">
            <el-button size="small" :disabled="exportBusy" @click="exportFile(item.path, item.label)">导出</el-button>
            <el-button size="small" @click="showInFolder(item.path)">定位</el-button>
          </div>
        </div>
      </div>
    </div>

    <!-- 分段列表 -->
    <div class="segments" v-if="doneShots.length > 0">
      <h3>剪辑台 ({{ doneShots.length }} 个镜头)</h3>
      <div class="segment-list">
        <div v-for="shot in doneShots" :key="shot.id" class="segment-item" @mouseenter="ensurePreviewLoaded(shot.id)">
          <div class="segment-preview" @click="previewSegment(shot)">
            <video
              v-if="shot.segmentPath"
              :src="loadedPreviewIds.has(shot.id) ? urlCache[shot.segmentPath] : undefined"
              :preload="loadedPreviewIds.has(shot.id) ? 'metadata' : 'none'"
              muted
              style="width: 160px; height: 90px; object-fit: cover"
            />
            <div v-else class="no-video">无视频</div>
          </div>
          <div class="segment-info">
            <span class="index">#{{ shot.index }}</span>
            <span class="scene">{{ shot.scene }}</span>
            <span class="duration">{{ (shot.frames / 16).toFixed(1) }}s</span>
          </div>
          <div class="segment-edit">
            <el-checkbox v-model="shot.skipped" @change="saveShotEdits(shot)">跳过</el-checkbox>
            <div class="trim-row">
              <span class="trim-label">入点(秒)</span>
              <el-input-number
                :model-value="shot.trimStart"
                :min="0"
                :step="0.1"
                size="small"
                controls-position="right"
                style="width: 80px"
                placeholder="自动"
                @change="(v?: number) => { shot.trimStart = v; saveShotEdits(shot) }"
              />
              <span class="trim-label">出点(秒)</span>
              <el-input-number
                :model-value="shot.trimEnd"
                :min="0"
                :step="0.1"
                size="small"
                controls-position="right"
                style="width: 80px"
                placeholder="自动"
                @change="(v?: number) => { shot.trimEnd = v; saveShotEdits(shot) }"
              />
            </div>
            <el-select
              :model-value="shot.transition || 'auto'"
              size="small"
              style="width: 96px"
              @change="(v: string) => { shot.transition = v === 'auto' ? undefined : (v as any); saveShotEdits(shot) }"
            >
              <el-option label="自动" value="auto" />
              <el-option label="硬切" value="hard" />
              <el-option label="叠化" value="dissolve" />
              <el-option label="强切" value="smash" />
            </el-select>
          </div>
        </div>
      </div>
      <div class="form-tip" style="margin-top: 8px">入点/出点留空=AI 智能裁剪（按台词起止）；填秒数=手动精确裁剪。修改后点「合成成片」生效。</div>
    </div>

    <!-- 预览对话框 -->
    <el-dialog v-model="previewVisible" :title="`镜头 #${previewShot?.index} - ${previewShot?.scene}`" width="800px">
      <video :src="previewUrl" controls autoplay style="width: 100%" />
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Download, VideoPlay, Refresh } from '@element-plus/icons-vue'
import type { Project, Shot } from '../../../shared/ipcTypes'
import { useFileUrl, clearFileUrlCache } from '../composables/useFileUrl'
import { useRouteProjectId } from '../composables/useRouteProjectId'
import { snapshot } from '../utils/snapshot'
import { useHotkeys } from '../composables/useHotkeys'
import { confirmDanger } from '../utils/confirm'

const { urlCache, ensureFileUrl, ensureFileUrls } = useFileUrl()

const router = useRouter()
const project = ref<Project | null>(null)
const finalVideoPath = ref<string | null>(null)
const finalDuration = ref(0)
const finalSize = ref(0)
const combining = ref(false)
const exporting = ref(false)
const combineStatus = ref<{ type: 'success' | 'error' | 'info'; message: string } | null>(null)
const previewVisible = ref(false)
const previewShot = ref<Shot | null>(null)
const previewUrl = ref('')
const loadingFinal = ref(false)
const mainVideoEl = ref<HTMLVideoElement | null>(null)
const videoError = ref('')

const projectId = useRouteProjectId((id) => { void loadAll(id) })

// Ctrl+E 导出成片（无成片时 exportVideo 内部直接忽略）
useHotkeys([
  { keys: 'ctrl+e', handler: () => { void exportVideo() } }
])

// 剪辑参数保存反馈防抖：连续调整入点/出点/转场只提示一次
let editToastTimer: number | null = null

function onMainVideoError(): void {
  const src = finalVideoPath.value ? urlCache[finalVideoPath.value] : ''
  videoError.value = src
    ? `窗口内加载失败。请完全重启应用后再点「刷新」（需加载 app-file 协议）。`
    : '视频地址未就绪，请点右上角「刷新」。'
}

async function playMainVideo(): Promise<void> {
  videoError.value = ''
  const el = mainVideoEl.value
  if (!el) return
  if (finalVideoPath.value) {
    clearFileUrlCache(`projects/${projectId.value}/`)
    const url = await ensureFileUrl(finalVideoPath.value)
    if (!url) {
      videoError.value = '无法解析媒体地址，请确认成片文件存在后刷新'
      ElMessage.error(videoError.value)
      return
    }
    if (el.src !== url) {
      el.src = url
      el.load()
    }
  }
  try {
    await el.play()
  } catch (e) {
    videoError.value = `窗口内无法播放：${e instanceof Error ? e.message : String(e)}（请完全退出并重启应用）`
    ElMessage.error(videoError.value)
  }
}

const doneShots = computed(() => project.value?.shots.filter(s => s.status === 'done') || [])
// 有已完成分镜即可合成；成片已存在时允许覆盖重新合成
const canCombine = computed(() => doneShots.value.length > 0)

// 剪辑台 video 懒挂载（建议 4）：进页零视频加载（preload=none 且不绑 src），
// 行 hover 后才置 src 并按 metadata 预取首帧缩略图；只动加载策略，不影响 previewSegment 独立链路
const loadedPreviewIds = ref(new Set<string>())
function ensurePreviewLoaded(shotId: string): void {
  if (loadedPreviewIds.value.has(shotId)) return
  loadedPreviewIds.value = new Set(loadedPreviewIds.value).add(shotId)
}

// 增强导出状态
const burningSubtitle = ref(false)
const mixingBgm = ref(false)
const selectingBgm = ref(false)
const bgmVolume = ref(30)
const enhancedOutputs = ref<{ path: string; label: string }[]>([])
const projectUpdatedUnsub = ref<(() => void) | null>(null)
const hasDialogue = computed(() => project.value?.shots.some(s => s.dialogue.trim() && s.status === 'done'))

async function loadAll(id = projectId.value) {
  if (!id) return
  loadingFinal.value = true
  try {
    const p = await window.api.project.get(id).catch(() => null)
    if (!p) {
      ElMessage.error('项目不存在或已被删除')
      void router.replace('/')
      return
    }
    project.value = p
    if (typeof p.bgmVolume === 'number') bgmVolume.value = p.bgmVolume
    await checkFinalVideo(id)
    await restoreEnhancedOutputs(id)
    await resolveSegmentUrls()
  } finally {
    loadingFinal.value = false
  }
}

onMounted(() => {
  // 路由 hash 未变时 watch 可能不触发，进页再拉一次成片
  if (projectId.value) void loadAll(projectId.value)
  // 后台逐镜渲染/合成落盘后自动刷新：出片即显示，无需手动点刷新
  projectUpdatedUnsub.value = window.api.director.onProjectUpdated((e) => {
    if (e?.projectId === projectId.value) {
      clearFileUrlCache(`projects/${projectId.value}/`)
      void loadAll(projectId.value)
    }
  })
})

onUnmounted(() => {
  projectUpdatedUnsub.value?.()
  if (editToastTimer !== null) clearTimeout(editToastTimer)
})

// R-19：字幕版/BGM 版产物持久存于磁盘（final_subtitled.mp4 / final_bgm.mp4），
// 此前仅内存态记录，重启后 UI"失踪"——启动时探测回填
async function restoreEnhancedOutputs(id = projectId.value) {
  const candidates = [
    { path: `projects/${id}/final_subtitled.mp4`, label: '字幕版' },
    { path: `projects/${id}/final_bgm.mp4`, label: 'BGM 混音版' },
    { path: `projects/${id}/final_master.mp4`, label: '成片（字幕+BGM）' }
  ]
  const checks = await Promise.all(candidates.map(c => window.api.file.exists(c.path)))
  const found = candidates.filter((_, i) => checks[i])
  if (found.length) {
    await ensureFileUrls(found.map(c => c.path))
    enhancedOutputs.value = found
  } else {
    enhancedOutputs.value = []
  }
}

// 分镜变化时重新解析分段 URL
watch(doneShots, () => resolveSegmentUrls())

async function resolveSegmentUrls() {
  const paths = doneShots.value.map(s => s.segmentPath).filter(Boolean) as string[]
  await ensureFileUrls(paths)
}

async function checkFinalVideo(id = projectId.value) {
  videoError.value = ''
  // 清掉该项目旧缓存（避免残留不可播的 file:// / 旧 dsmedia 形态）
  clearFileUrlCache(`projects/${id}/`)
  // 优先导演终稿 → 字幕版 → 拼接原片
  const candidates = [
    `projects/${id}/final_master.mp4`,
    `projects/${id}/final_subtitled.mp4`,
    `projects/${id}/final.mp4`
  ]
  for (const relative of candidates) {
    if (!(await window.api.file.exists(relative))) continue
    finalVideoPath.value = relative
    const url = await ensureFileUrl(relative)
    if (!url) continue
    try {
      finalDuration.value = Math.round(await window.api.ffmpeg.getDuration(relative))
      finalSize.value = await window.api.file.getSize(relative)
    } catch {
      finalDuration.value = 0
      finalSize.value = 0
    }
    return
  }
  finalVideoPath.value = null
}

async function combineVideo() {
  if (!project.value) return
  const outputPath = `projects/${projectId.value}/final.mp4`
  // final.mp4 已存在 = 覆盖重合成，先确认
  if (await window.api.file.exists(outputPath)) {
    const ok = await confirmDanger('已存在成片，将覆盖重新合成。确定继续？', {
      title: '覆盖成片',
      confirmText: '覆盖合成',
      cancelText: '取消'
    })
    if (!ok) return
  }
  combining.value = true
  combineStatus.value = { type: 'info', message: '正在智能合成（逐镜裁剪 + 场景转场）...' }

  try {
    const segments = doneShots.value
      .filter(s => !s.skipped && s.segmentPath)
      .map(s => ({
        path: s.segmentPath!,
        scene: s.scene,
        hasDialogue: !!s.dialogue.trim(),
        transition: s.transition,
        trimStart: s.trimStart,
        trimEnd: s.trimEnd
      }))
    if (segments.length === 0) throw new Error('没有可合成的分段（跳过或缺失）')

    const output = await window.api.ffmpeg.smartConcat(segments, outputPath)
    finalVideoPath.value = output
    await ensureFileUrl(output)
    finalDuration.value = Math.round(await window.api.ffmpeg.getDuration(output))
    finalSize.value = await window.api.file.getSize(output)
    combineStatus.value = { type: 'success', message: '智能合成完成！已按转场与裁剪拼接' }
    ElMessage.success('合成成功')
  } catch (e) {
    combineStatus.value = { type: 'error', message: `合成失败: ${e}` }
    ElMessage.error(`合成失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    combining.value = false
  }
}

/** 剪辑台参数变更即持久化到项目（入点/出点/转场/跳过） */
async function saveShotEdits(shot: Shot): Promise<void> {
  if (!project.value) return
  try {
    await window.api.project.save(snapshot(project.value))
    // 防抖 toast：连续调整只提示一次，单位为秒
    if (editToastTimer !== null) clearTimeout(editToastTimer)
    editToastTimer = window.setTimeout(() => {
      editToastTimer = null
      ElMessage.success('剪辑参数已保存（单位：秒）')
    }, 600)
  } catch (e) {
    ElMessage.error(`保存剪辑参数失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

async function previewSegment(shot: Shot) {
  if (!shot.segmentPath) return
  previewShot.value = shot
  await ensureFileUrl(shot.segmentPath)
  previewUrl.value = urlCache[shot.segmentPath]
  previewVisible.value = true
}

async function exportVideo() {
  if (!finalVideoPath.value) return
  exporting.value = true
  try {
    const defaultName = `${project.value?.title || '短剧'}.mp4`
    const target = await window.api.dialog.saveFile(defaultName)
    if (!target) return
    await window.api.file.copy(finalVideoPath.value, target)
    ElMessage.success(`已导出到：${target}`)
  } catch (e) {
    ElMessage.error(`导出失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    exporting.value = false
  }
}

// 字幕烧录
async function burnSubtitles() {
  if (!finalVideoPath.value || !project.value) return
  burningSubtitle.value = true
  try {
    const srtRel = await window.api.subtitle.generate(projectId.value)
    const output = `projects/${projectId.value}/final_subtitled.mp4`
    await window.api.ffmpeg.burnSubtitles(finalVideoPath.value, srtRel, output)
    await ensureFileUrl(output)
    enhancedOutputs.value = enhancedOutputs.value.filter(o => o.path !== output)
    enhancedOutputs.value.push({ path: output, label: '字幕版' })
    ElMessage.success('字幕烧录完成')
  } catch (e) {
    ElMessage.error(`烧录失败: ${(e as Error).message}`)
  } finally {
    burningSubtitle.value = false
  }
}

// 选择 BGM
async function selectBgm() {
  if (!project.value) return
  selectingBgm.value = true
  try {
    const relPath = await window.api.project.importBgm(projectId.value)
    project.value.bgmPath = relPath
    project.value.bgmVolume = bgmVolume.value
    await window.api.project.save(snapshot(project.value))
    ElMessage.success('BGM 已保存')
  } catch {
    // 用户取消
  } finally {
    selectingBgm.value = false
  }
}

// BGM 混音导出
async function mixBgm() {
  if (!project.value?.bgmPath || !finalVideoPath.value) return
  mixingBgm.value = true
  try {
    project.value.bgmVolume = bgmVolume.value
    await window.api.project.save(snapshot(project.value))
    const output = `projects/${projectId.value}/final_bgm.mp4`
    await window.api.ffmpeg.mixBgm(finalVideoPath.value, project.value.bgmPath, output, bgmVolume.value)
    await ensureFileUrl(output)
    enhancedOutputs.value = enhancedOutputs.value.filter(o => o.path !== output)
    enhancedOutputs.value.push({ path: output, label: 'BGM 混音版' })
    ElMessage.success('混音完成')
  } catch (e) {
    ElMessage.error(`混音失败: ${(e as Error).message}`)
  } finally {
    mixingBgm.value = false
  }
}

// 导出增强产物（导出中禁用全部导出按钮，防大文件复制期间重复点击）
const exportBusy = ref(false)
async function exportFile(relativePath: string, label: string) {
  if (exportBusy.value) return
  const defaultName = `${project.value?.title || '短剧'}_${label}.mp4`
  const target = await window.api.dialog.saveFile(defaultName)
  if (!target) return
  exportBusy.value = true
  try {
    await window.api.file.copy(relativePath, target)
    ElMessage.success(`已导出到：${target}`)
  } catch (e) {
    ElMessage.error(`导出失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    exportBusy.value = false
  }
}

async function showInFolder(relativePath: string) {
  try {
    await window.api.shell.showItem(relativePath)
  } catch {
    ElMessage.warning('文件不存在')
  }
}
</script>

<style scoped>
.enhance-card {
  padding: 16px 18px;
  margin-bottom: 24px;
}
.enhance-card h3 {
  font-family: var(--font-display);
  color: var(--text-primary);
  margin-bottom: 12px;
}
.enhance-row { display: flex; gap: 24px; margin-bottom: 16px; flex-wrap: wrap; }
.enhance-item { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.enhance-label { color: var(--text-secondary); font-size: 13px; min-width: 70px; }
.form-tip { font-size: 12px; color: var(--text-muted); }
.enhance-outputs { display: flex; gap: 16px; flex-wrap: wrap; }
.output-item {
  display: flex; flex-direction: column; gap: 6px; align-items: center;
}
.output-name { color: var(--text-secondary); font-size: 12px; }
.output-actions { display: flex; gap: 6px; }

.empty-actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
.video-container { margin-bottom: 24px; padding: 14px; }
.video-container video { background: #000; border-radius: var(--radius-md); width: 100%; }
.video-info { display: flex; gap: 16px; margin-top: 10px; color: var(--text-secondary); font-size: 14px; align-items: center; flex-wrap: wrap; }
.video-error { margin-top: 8px; color: var(--danger); font-size: 13px; }

.segments h3 { color: var(--text-primary); margin-bottom: 12px; font-family: var(--font-display); }
.segment-list { display: flex; flex-direction: column; gap: 8px; }
.segment-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px;
  border-radius: var(--radius-md);
  cursor: default;
  border: 1px solid var(--glass-border);
  background: var(--glass-bg);
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.segment-item:hover {
  background: var(--glass-bg-strong);
  border-color: var(--glass-border-strong);
}
.segment-edit {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
  flex-wrap: wrap;
}
.trim-row { display: flex; align-items: center; gap: 4px; }
.trim-label { font-size: 12px; color: var(--text-muted); }
.segment-preview { width: 160px; height: 90px; background: var(--bg-page-elevated); border-radius: 8px; overflow: hidden; }
.no-video { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-muted); }
.segment-info { display: flex; align-items: center; gap: 12px; color: var(--text-primary); }
.index { color: var(--brand); font-weight: 650; }
.scene { flex: 1; }
.duration { color: var(--text-secondary); font-size: 12px; }
</style>
