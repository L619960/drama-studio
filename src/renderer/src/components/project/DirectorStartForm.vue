<template>
  <el-form label-width="88px">
    <el-form-item label="入口">
      <el-radio-group v-model="draft.mode">
        <el-radio value="idea">有想法</el-radio>
        <el-radio value="script">有剧本</el-radio>
        <el-radio value="video">有视频</el-radio>
      </el-radio-group>
    </el-form-item>
    <el-form-item label="片名" required>
      <el-input v-model="draft.title" maxlength="40" placeholder="如：总裁的隐婚新娘" />
    </el-form-item>
    <el-form-item label="题材" required>
      <div class="genre-row">
        <el-input v-model="draft.genre" clearable placeholder="输入或选择题材" style="flex: 1" />
        <el-select v-model="genreQuick" placeholder="常用题材" style="width: 180px" @change="pickGenre">
          <el-option v-for="t in GENRE_TEMPLATES" :key="t.key" :label="t.label" :value="t.key" />
        </el-select>
      </div>
    </el-form-item>
    <el-form-item v-if="draft.mode === 'idea'" label="想法" required>
      <div class="prompt-row">
        <el-input v-model="draft.idea" type="textarea" :rows="3" placeholder="写一句灵感，AI 扩写成剧本" style="flex: 1" />
        <el-button :loading="writingScript" size="small" @click="generateScript">AI 写剧本</el-button>
      </div>
    </el-form-item>
    <el-form-item v-if="draft.mode === 'video'" label="视频" required>
      <div class="prompt-row">
        <el-input :model-value="draft.videoPath" readonly placeholder="选择本地视频" style="flex: 1" />
        <el-button size="small" @click="selectVideo">选择视频</el-button>
        <el-button size="small" :loading="writingScript" :disabled="!draft.videoPath" @click="generateScriptFromVideo">
          AI 拆成剧本
        </el-button>
      </div>
    </el-form-item>
    <el-form-item label="剧本" required>
      <el-input v-model="draft.script" type="textarea" :rows="8" placeholder="粘贴完整剧本，或先用上方入口生成" />
    </el-form-item>
    <el-form-item label="BGM">
      <div class="bgm-row">
        <span class="bgm-name" :class="{ placeholder: !draft.bgmPath }">{{ draft.bgmPath || '可选：选择背景音乐' }}</span>
        <el-button size="small" @click="selectBgm">选择</el-button>
        <el-button v-if="draft.bgmPath" size="small" link @click="draft.bgmPath = ''">清除</el-button>
      </div>
    </el-form-item>
    <el-form-item label="确认点">
      <div class="gate-row">
        <el-switch v-model="noGates" active-text="一口气跑到底（不在任何阶段暂停）" />
      </div>
      <el-checkbox-group v-if="!noGates" v-model="draft.gateStages">
        <el-checkbox v-for="g in GATE_OPTIONS" :key="g.value" :label="g.value">
          {{ g.label }}完成后暂停
        </el-checkbox>
      </el-checkbox-group>
    </el-form-item>
  </el-form>
  <p class="director-tip">
    两个入口使用同一张开拍单。默认在剧本分析、首帧、成片复审后暂停。未勾选则该阶段结束后直接继续。人物镜未审首帧时，渲染阶段仍会停下。
  </p>
  <div class="form-actions">
    <el-button @click="emit('cancel')">取消</el-button>
    <el-button type="primary" :loading="starting" @click="submit">开始制作</el-button>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { GENRE_TEMPLATES, type DirectorStage, type DirectorStartInput } from '../../../../shared/ipcTypes'
import { DEFAULT_DIRECTOR_GATES } from '../../../../shared/pipelineGuards'
import { GATE_OPTIONS } from '../../composables/useDirectorState'

const props = defineProps<{ open: boolean; starting?: boolean }>()
const emit = defineEmits<{
  submit: [input: DirectorStartInput]
  cancel: []
}>()

const draft = ref(emptyDraft())
const genreQuick = ref('')
const writingScript = ref(false)
const noGates = ref(false)

function emptyDraft(): {
  mode: 'idea' | 'script' | 'video'
  title: string
  genre: string
  idea: string
  script: string
  videoPath: string
  bgmPath: string
  gateStages: DirectorStage[]
} {
  return {
    mode: 'script',
    title: '',
    genre: '',
    idea: '',
    script: '',
    videoPath: '',
    bgmPath: '',
    gateStages: [...DEFAULT_DIRECTOR_GATES]
  }
}

watch(() => props.open, (open) => {
  if (open) {
    const keep = draft.value
    noGates.value = false
    draft.value = {
      ...emptyDraft(),
      title: keep.title,
      genre: keep.genre,
      idea: keep.idea,
      script: keep.script,
      videoPath: keep.videoPath,
      bgmPath: keep.bgmPath
    }
  }
})

function pickGenre(key: string): void {
  if (!key) return
  draft.value.genre = key
  genreQuick.value = ''
}

async function generateScript(): Promise<void> {
  const idea = draft.value.idea.trim()
  if (!idea) { ElMessage.warning('请先写想法'); return }
  if (!draft.value.genre.trim()) { ElMessage.warning('请先填写题材'); return }
  writingScript.value = true
  try {
    draft.value.script = await window.api.llm.writeScript(idea, draft.value.genre.trim())
    ElMessage.success('剧本已生成，可继续编辑后开始制作')
  } catch (e) {
    ElMessage.error('生成失败：' + (e instanceof Error ? e.message : String(e)))
  } finally {
    writingScript.value = false
  }
}

async function selectVideo(): Promise<void> {
  try {
    const p = await window.api.dialog.selectVideo()
    if (p) draft.value.videoPath = p
  } catch (e) {
    ElMessage.error(`选择视频失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

async function generateScriptFromVideo(): Promise<void> {
  if (!draft.value.videoPath) return
  if (!draft.value.genre.trim()) { ElMessage.warning('请先填写题材'); return }
  writingScript.value = true
  try {
    draft.value.script = await window.api.llm.writeScriptFromVideo(draft.value.videoPath, draft.value.genre.trim())
    ElMessage.success('已根据视频生成剧本')
  } catch (e) {
    ElMessage.error('生成失败：' + (e instanceof Error ? e.message : String(e)))
  } finally {
    writingScript.value = false
  }
}

async function selectBgm(): Promise<void> {
  try {
    const p = await window.api.dialog.selectAudio()
    if (p) draft.value.bgmPath = p
  } catch (e) {
    ElMessage.error(`选择音频失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

function submit(): void {
  if (!draft.value.title.trim()) { ElMessage.warning('请填写片名'); return }
  if (!draft.value.genre.trim()) { ElMessage.warning('请填写题材'); return }
  if (!draft.value.script.trim()) { ElMessage.warning('请粘贴或生成剧本'); return }
  emit('submit', {
    title: draft.value.title.trim(),
    genre: draft.value.genre.trim(),
    script: draft.value.script.trim(),
    gateStages: noGates.value ? [] : [...draft.value.gateStages],
    bgmAbsolutePath: draft.value.bgmPath || undefined
  })
}
</script>

<style scoped>
.genre-row, .prompt-row, .bgm-row, .gate-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.bgm-name {
  flex: 1;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bgm-name.placeholder { color: var(--text-muted); }
.director-tip {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.7;
  margin: 0 0 12px;
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
