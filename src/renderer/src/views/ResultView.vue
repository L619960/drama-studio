﻿﻿﻿﻿﻿<template>
  <div class="result-view">
    <div class="header">
      <h1>成片预览</h1>
      <div class="actions">
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
    <div class="video-container" v-if="finalVideoPath">
      <video controls :src="urlCache[finalVideoPath]" style="max-width: 100%; max-height: 60vh"></video>
      <div class="video-info">
        <span>时长: {{ finalDuration }}秒</span>
        <span>大小: {{ finalSize }}MB</span>
      </div>
    </div>
    <el-empty v-else description="暂无成片，请先完成渲染并合成" />

    <!-- 增强导出（字幕 / BGM） -->
    <div class="enhance-card" v-if="finalVideoPath">
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
          <el-button size="small" @click="selectBgm">{{ project?.bgmPath ? '更换 BGM' : '选择 BGM' }}</el-button>
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
            <el-button size="small" @click="exportFile(item.path, item.label)">导出</el-button>
            <el-button size="small" @click="showInFolder(item.path)">定位</el-button>
          </div>
        </div>
      </div>
    </div>

    <!-- 分段列表 -->
    <div class="segments" v-if="doneShots.length > 0">
      <h3>分段预览 ({{ doneShots.length }} 个镜头)</h3>
      <div class="segment-list">
        <div v-for="shot in doneShots" :key="shot.id" class="segment-item" @click="previewSegment(shot)">
          <div class="segment-preview">
            <video v-if="shot.segmentPath" :src="urlCache[shot.segmentPath]" muted style="width: 160px; height: 90px; object-fit: cover" />
            <div v-else class="no-video">无视频</div>
          </div>
          <div class="segment-info">
            <span class="index">#{{ shot.index }}</span>
            <span class="scene">{{ shot.scene }}</span>
            <span class="duration">{{ (shot.frames / 16).toFixed(1) }}s</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 预览对话框 -->
    <el-dialog v-model="previewVisible" :title="`镜头 #${previewShot?.index} - ${previewShot?.scene}`" width="800px">
      <video :src="previewUrl" controls autoplay style="width: 100%" />
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Download, VideoPlay } from '@element-plus/icons-vue'
import type { Project, Shot } from '../../../shared/ipcTypes'
import { useFileUrl } from '../composables/useFileUrl'
import { snapshot } from '../utils/snapshot'

const { urlCache, ensureFileUrl, ensureFileUrls } = useFileUrl()

const route = useRoute()
const projectId = route.params.id as string

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

const doneShots = computed(() => project.value?.shots.filter(s => s.status === 'done') || [])
// 有已完成分镜即可合成；成片已存在时允许覆盖重新合成
const canCombine = computed(() => doneShots.value.length > 0)

// 增强导出状态
const burningSubtitle = ref(false)
const mixingBgm = ref(false)
const bgmVolume = ref(30)
const enhancedOutputs = ref<{ path: string; label: string }[]>([])
const hasDialogue = computed(() => project.value?.shots.some(s => s.dialogue.trim() && s.status === 'done'))

onMounted(async () => {
  project.value = await window.api.project.get(projectId)
  await checkFinalVideo()
  await resolveSegmentUrls()
})

// 分镜变化时重新解析分段 URL
watch(doneShots, () => resolveSegmentUrls())

async function resolveSegmentUrls() {
  const paths = doneShots.value.map(s => s.segmentPath).filter(Boolean) as string[]
  await ensureFileUrls(paths)
}

async function checkFinalVideo() {
  const relative = `projects/${projectId}/final.mp4`
  const exists = await window.api.file.exists(relative)
  if (exists) {
    finalVideoPath.value = relative
    await ensureFileUrl(relative)
    finalDuration.value = Math.round(await window.api.ffmpeg.getDuration(relative))
    finalSize.value = await window.api.file.getSize(relative)
  }
}

async function combineVideo() {
  if (!project.value) return
  combining.value = true
  combineStatus.value = { type: 'info', message: '正在合成...' }

  try {
    const segments = doneShots.value.map(s => s.segmentPath).filter(Boolean) as string[]
    if (segments.length === 0) throw new Error('没有可合成的分段')

    const output = await window.api.ffmpeg.concat(segments, `projects/${projectId}/final.mp4`)
    finalVideoPath.value = output
    await ensureFileUrl(output)
    finalDuration.value = Math.round(await window.api.ffmpeg.getDuration(output))
    finalSize.value = await window.api.file.getSize(output)
    combineStatus.value = { type: 'success', message: '合成完成！' }
    ElMessage.success('合成成功')
  } catch (e) {
    combineStatus.value = { type: 'error', message: `合成失败: ${e}` }
    ElMessage.error('合成失败')
  } finally {
    combining.value = false
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
    ElMessage.success('导出成功')
  } catch (e) {
    ElMessage.error('导出失败')
  } finally {
    exporting.value = false
  }
}

// 字幕烧录
async function burnSubtitles() {
  if (!finalVideoPath.value || !project.value) return
  burningSubtitle.value = true
  try {
    const srtRel = await window.api.subtitle.generate(projectId)
    const output = `projects/${projectId}/final_subtitled.mp4`
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
  try {
    const relPath = await window.api.project.importBgm(projectId)
    project.value.bgmPath = relPath
    project.value.bgmVolume = bgmVolume.value
    await window.api.project.save(snapshot(project.value))
    ElMessage.success('BGM 已保存')
  } catch {
    // 用户取消
  }
}

// BGM 混音导出
async function mixBgm() {
  if (!project.value?.bgmPath || !finalVideoPath.value) return
  mixingBgm.value = true
  try {
    project.value.bgmVolume = bgmVolume.value
    await window.api.project.save(snapshot(project.value))
    const output = `projects/${projectId}/final_bgm.mp4`
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

// 导出增强产物
async function exportFile(relativePath: string, label: string) {
  const defaultName = `${project.value?.title || '短剧'}_${label}.mp4`
  const target = await window.api.dialog.saveFile(defaultName)
  if (!target) return
  try {
    await window.api.file.copy(relativePath, target)
    ElMessage.success('导出成功')
  } catch {
    ElMessage.error('导出失败')
  }
}

function showInFolder(relativePath: string) {
  window.api.shell.showItem(relativePath)
}
</script>

<style scoped>
.result-view { padding: 20px; }
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }

/* 增强导出卡片 */
.enhance-card {
  background: var(--bg-card);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 24px;
}
.enhance-card h3 { color: var(--text-primary); margin-bottom: 12px; }
.enhance-row { display: flex; gap: 24px; margin-bottom: 16px; flex-wrap: wrap; }
.enhance-item { display: flex; align-items: center; gap: 8px; }
.enhance-label { color: var(--text-secondary); font-size: 13px; min-width: 70px; }
.form-tip { font-size: 12px; color: var(--text-muted); }
.enhance-outputs { display: flex; gap: 16px; flex-wrap: wrap; }
.output-item {
  display: flex; flex-direction: column; gap: 6px; align-items: center;
}
.output-name { color: var(--text-secondary); font-size: 12px; }
.output-actions { display: flex; gap: 6px; }
.header h1 { font-size: 24px; color: var(--text-primary); }
.actions { display: flex; gap: 12px; }

.video-container { margin-bottom: 24px; }
.video-container video { background: #000; border-radius: 8px; }
.video-info { display: flex; gap: 16px; margin-top: 8px; color: var(--text-secondary); font-size: 14px; }

.segments h3 { color: var(--text-primary); margin-bottom: 12px; }
.segment-list { display: flex; flex-direction: column; gap: 8px; }
.segment-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px;
  background: var(--bg-card);
  border-radius: 8px;
  cursor: pointer;
}
.segment-item:hover { background: var(--bg-input); }
.segment-preview { width: 160px; height: 90px; background: var(--bg-sidebar); border-radius: 4px; overflow: hidden; }
.no-video { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-muted); }
.segment-info { display: flex; align-items: center; gap: 12px; color: var(--text-primary); }
.index { color: #409eff; font-weight: bold; }
.scene { flex: 1; }
.duration { color: var(--text-secondary); font-size: 12px; }
</style>
