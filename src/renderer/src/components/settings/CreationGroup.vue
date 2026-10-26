<template>
  <!-- 分镜生成 -->
  <div v-show="activeSection === 'storyboard'" class="section">
    <h2>分镜生成</h2>
    <PresetBar
      :presets="settings.creation.presets"
      @apply="applyPreset"
      @save-as="savePresetAs"
      @remove="removePreset"
    />
    <div class="module-layout">
      <el-form label-width="140px" class="module-form">
        <el-form-item label="最少镜头">
          <el-input-number v-model="settings.creation.storyboard.minShots" :min="4" :max="30" />
          <span class="form-tip">{{ tips.storyboard.minShots }}</span>
        </el-form-item>
        <el-form-item label="最多镜头">
          <el-input-number v-model="settings.creation.storyboard.maxShots" :min="4" :max="30" />
          <span class="form-tip">{{ tips.storyboard.maxShots }}</span>
        </el-form-item>
        <el-form-item label="拆镜温度">
          <el-slider v-model="settings.creation.storyboard.temperature" :min="0" :max="1" :step="0.05" style="width: 220px" />
          <span class="form-tip">{{ tips.storyboard.temperature }}</span>
        </el-form-item>
        <el-form-item label="角色上限">
          <el-input-number v-model="settings.creation.storyboard.maxCharacters" :min="2" :max="12" />
          <span class="form-tip">{{ tips.storyboard.maxCharacters }}</span>
        </el-form-item>
        <el-form-item label="道具落幅校验">
          <el-switch v-model="settings.creation.storyboard.enforcePropLock" />
          <span class="form-tip">{{ tips.storyboard.enforcePropLock }}</span>
        </el-form-item>
        <el-form-item label="反应镜校验">
          <el-switch v-model="settings.creation.storyboard.enforceReactionBeats" />
          <span class="form-tip">{{ tips.storyboard.enforceReactionBeats }}</span>
        </el-form-item>
        <el-form-item label="上车链校验">
          <el-switch v-model="settings.creation.storyboard.enforceBoardingChain" />
          <span class="form-tip">{{ tips.storyboard.enforceBoardingChain }}</span>
        </el-form-item>
      </el-form>
      <EffectPreview :lines="effectLines.storyboard" />
    </div>
  </div>

  <!-- 人物形象 -->
  <div v-show="activeSection === 'character'" class="section">
    <h2>人物形象</h2>
    <PresetBar
      :presets="settings.creation.presets"
      @apply="applyPreset"
      @save-as="savePresetAs"
      @remove="removePreset"
    />
    <div class="module-layout">
      <el-form label-width="140px" class="module-form">
        <el-form-item label="定妆宽×高">
          <el-input-number v-model="settings.creation.character.faceWidth" :min="256" :max="2048" :step="64" />
          <span style="margin: 0 6px">×</span>
          <el-input-number v-model="settings.creation.character.faceHeight" :min="256" :max="2048" :step="64" />
        </el-form-item>
        <el-form-item label="三视图宽×高">
          <el-input-number v-model="settings.creation.character.bodyWidth" :min="256" :max="2048" :step="64" />
          <span style="margin: 0 6px">×</span>
          <el-input-number v-model="settings.creation.character.bodyHeight" :min="256" :max="2048" :step="64" />
        </el-form-item>
        <el-form-item label="写实锁">
          <el-select v-model="settings.creation.character.realismLock" style="width: 160px">
            <el-option label="标准" value="standard" />
            <el-option label="强（推荐）" value="strong" />
          </el-select>
          <span class="form-tip">{{ tips.character.realismLock }}</span>
        </el-form-item>
        <el-form-item label="种子模式">
          <el-select v-model="settings.creation.character.seedMode" style="width: 160px">
            <el-option label="随机" value="random" />
            <el-option label="固定" value="fixed" />
          </el-select>
          <el-input-number
            v-if="settings.creation.character.seedMode === 'fixed'"
            v-model="settings.creation.character.seed"
            :min="0"
            style="margin-left: 8px"
          />
        </el-form-item>
        <el-form-item label="抽卡张数">
          <el-input-number v-model="settings.creation.character.candidates" :min="1" :max="4" />
          <span class="form-tip">{{ tips.character.candidates }}</span>
        </el-form-item>
        <el-form-item label="LLM 抽卡">
          <el-switch v-model="settings.creation.character.llmPick" />
          <span class="form-tip">{{ tips.character.llmPick }}</span>
        </el-form-item>
        <el-form-item label="试生成">
          <el-select
            v-model="previewLook"
            filterable
            allow-create
            default-first-option
            placeholder="lookEn 外观短语"
            style="max-width: 320px; margin-right: 8px"
            :no-data-text="'输入新短语后回车即加入记忆'"
            @contextmenu.prevent="openInputMenu($event, { el: $event.target as HTMLInputElement, onPick: (v) => { previewLook = v }, onClear: () => { previewLook = '' }, history: () => memPreviewLook.read(), clearHistory: () => memPreviewLook.clear() })"
          >
            <el-option
              v-for="u in memPreviewLook.read()"
              :key="u"
              :label="u"
              :value="u"
            />
          </el-select>
          <el-button :loading="previewing" @click="runPreview('character')">试生成预览</el-button>
        </el-form-item>
      </el-form>
      <EffectPreview :lines="effectLines.character" :image-url="previewUrl" />
    </div>
  </div>

  <!-- 场景图 -->
  <div v-show="activeSection === 'scene'" class="section">
    <h2>场景图</h2>
    <PresetBar
      :presets="settings.creation.presets"
      @apply="applyPreset"
      @save-as="savePresetAs"
      @remove="removePreset"
    />
    <div class="module-layout">
      <el-form label-width="140px" class="module-form">
        <el-form-item label="场景板尺寸">
          <el-input-number v-model="settings.creation.scene.plateWidth" :min="256" :max="2048" :step="64" />
          <span style="margin: 0 6px">×</span>
          <el-input-number v-model="settings.creation.scene.plateHeight" :min="256" :max="2048" :step="64" />
        </el-form-item>
        <el-form-item label="首尾帧尺寸">
          <el-input-number v-model="settings.creation.scene.frameWidth" :min="256" :max="2048" :step="64" />
          <span style="margin: 0 6px">×</span>
          <el-input-number v-model="settings.creation.scene.frameHeight" :min="256" :max="2048" :step="64" />
        </el-form-item>
        <el-form-item label="空镜禁人">
          <el-switch v-model="settings.creation.scene.emptyStrict" />
          <span class="form-tip">{{ tips.scene.emptyStrict }}</span>
        </el-form-item>
        <el-form-item label="天气偏向">
          <el-select v-model="settings.creation.scene.weatherHint" style="width: 160px">
            <el-option label="自动" value="auto" />
            <el-option label="雨夜" value="rainy" />
            <el-option label="晴/干" value="clear" />
          </el-select>
        </el-form-item>
        <el-form-item label="抽卡张数">
          <el-input-number v-model="settings.creation.scene.candidates" :min="1" :max="4" />
          <span class="form-tip">{{ tips.scene.candidates }}</span>
        </el-form-item>
        <el-form-item label="LLM 抽卡">
          <el-switch v-model="settings.creation.scene.llmPick" />
          <span class="form-tip">{{ tips.scene.llmPick }}</span>
        </el-form-item>
        <el-form-item label="试生成">
          <el-select
            v-model="previewScene"
            filterable
            allow-create
            default-first-option
            placeholder="英文场景描述"
            style="max-width: 320px; margin-right: 8px"
            :no-data-text="'输入新描述后回车即加入记忆'"
            @contextmenu.prevent="openInputMenu($event, { el: $event.target as HTMLInputElement, onPick: (v) => { previewScene = v }, onClear: () => { previewScene = '' }, history: () => memPreviewScene.read(), clearHistory: () => memPreviewScene.clear() })"
          >
            <el-option
              v-for="u in memPreviewScene.read()"
              :key="u"
              :label="u"
              :value="u"
            />
          </el-select>
          <el-button :loading="previewing" @click="runPreview('scene')">试生成预览</el-button>
        </el-form-item>
      </el-form>
      <EffectPreview :lines="effectLines.scene" :image-url="previewUrl" />
    </div>
  </div>

  <!-- 视频剪辑 -->
  <div v-show="activeSection === 'edit'" class="section">
    <h2>视频剪辑</h2>
    <PresetBar
      :presets="settings.creation.presets"
      @apply="applyPreset"
      @save-as="savePresetAs"
      @remove="removePreset"
    />
    <div class="module-layout">
      <el-form label-width="140px" class="module-form">
        <el-form-item label="默认分辨率">
          <el-input-number v-model="settings.creation.edit.defaultWidth" :min="256" :max="1920" :step="16" />
          <span style="margin: 0 6px">×</span>
          <el-input-number v-model="settings.creation.edit.defaultHeight" :min="256" :max="1080" :step="16" />
        </el-form-item>
        <el-form-item label="默认帧数">
          <el-select v-model="settings.creation.edit.defaultFrames" style="width: 200px">
            <el-option
              v-for="f in frameOptions"
              :key="f"
              :label="`${f} 帧（约 ${((f - 1) / 16).toFixed(0)} 秒）`"
              :value="f"
            />
          </el-select>
          <span class="form-tip">{{ tips.edit.defaultFrames }}</span>
        </el-form-item>
        <el-form-item label="渲染抽卡">
          <el-input-number v-model="settings.creation.edit.renderCandidates" :min="1" :max="3" />
          <span class="form-tip">{{ tips.edit.renderCandidates }}</span>
        </el-form-item>
        <el-form-item label="LLM 抽卡">
          <el-switch v-model="settings.creation.edit.llmPick" />
          <span class="form-tip">{{ tips.edit.llmPick }}</span>
        </el-form-item>
        <el-form-item label="Comfy 超时(秒)">
          <el-input-number v-model="settings.creation.edit.comfyTimeoutSec" :min="60" :max="3600" />
        </el-form-item>
        <el-form-item label="口型同步">
          <el-switch v-model="settings.creation.edit.lipSync" />
        </el-form-item>
        <el-form-item label="口型路线">
          <el-select v-model="settings.creation.edit.lipSyncMode" style="width: 280px">
            <el-option label="自动" value="auto" />
            <el-option label="强制 LatentSync" value="latentsync" />
            <el-option label="仅 H3 原生" value="h3-native" />
          </el-select>
        </el-form-item>
        <el-form-item label="复审门控">
          <el-select v-model="settings.creation.edit.reviewGate" style="width: 200px">
            <el-option label="阻断" value="block" />
            <el-option label="告警放行" value="warn" />
            <el-option label="关闭" value="off" />
          </el-select>
        </el-form-item>
        <el-form-item label="默认 BGM 音量">
          <el-slider v-model="settings.creation.edit.defaultBgmVolume" :min="0" :max="100" style="width: 220px" />
        </el-form-item>
        <el-form-item label="字幕字号/边距">
          <el-input-number v-model="settings.creation.edit.subtitleFontSize" :min="10" :max="48" />
          <span style="margin: 0 6px">/</span>
          <el-input-number v-model="settings.creation.edit.subtitleMarginV" :min="0" :max="120" />
        </el-form-item>
        <el-form-item label="TTS 语速/音量">
          <el-slider v-model="settings.creation.edit.ttsRate" :min="50" :max="200" style="width: 160px" />
          <el-slider v-model="settings.creation.edit.ttsVolume" :min="0" :max="100" style="width: 160px; margin-left: 12px" />
        </el-form-item>
      </el-form>
      <EffectPreview :lines="effectLines.edit" />
    </div>
  </div>

  <InputContextMenu ref="inputCtxMenu" />
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import type { AppSettings, CreationPreset } from '../../../../shared/ipcTypes'
import {
  CREATION_PARAM_TIPS,
  summarizeCreationEffects
} from '../../../../shared/creationSettings'
import EffectPreview from './EffectPreview.vue'
import PresetBar from './PresetBar.vue'
import { confirmDanger } from '../../utils/confirm'
import InputContextMenu from '../common/InputContextMenu.vue'
import { useInputMemory } from '../../utils/useInputMemory'

const props = defineProps<{
  settings: AppSettings
  activeSection: string
}>()

/** 输入框记忆实例（右键菜单 + 下拉记忆共用） */
const memPreviewLook = useInputMemory('preview-look')
const memPreviewScene = useInputMemory('preview-scene')

// 右键菜单实例（模板 ref）
const inputCtxMenu = ref<InstanceType<typeof InputContextMenu> | null>(null)
/** 输入框右键：打开通用菜单（剪切/复制/粘贴/全选/清空/历史） */
function openInputMenu(
  e: MouseEvent,
  ctx: {
    el: HTMLInputElement | HTMLTextAreaElement
    history?: () => string[]
    clearHistory?: () => void
    onClear?: () => void
    onPick?: (value: string) => void
  }
): void {
  inputCtxMenu.value?.open(e, {
    el: ctx.el,
    onClear: ctx.onClear,
    onPick: ctx.onPick,
    history: ctx.history ? ctx.history() : [],
    clearHistory: ctx.clearHistory
  })
}

const tips = CREATION_PARAM_TIPS
const previewLook = ref('chinese woman in her mid 20s, natural matte skin, long black hair, white hanfu robe with jade hairpin')
const previewScene = ref('ancient chinese courtyard at dusk, wet stone pavement, lantern light, wooden architecture')
const previewUrl = ref('')
const previewing = ref(false)

const effectLines = computed(() => summarizeCreationEffects(props.settings.creation))

/** Wan 合法默认帧：17,33,…,113（16n+1） */
const frameOptions = [33, 49, 65, 81, 97, 113]

function applyPreset(id: string) {
  const p = props.settings.creation.presets.find(x => x.id === id)
  if (!p) return
  props.settings.creation.storyboard = { ...p.modules.storyboard }
  props.settings.creation.character = { ...p.modules.character }
  props.settings.creation.scene = { ...p.modules.scene }
  props.settings.creation.edit = { ...p.modules.edit }
  ElMessage.success(`已应用预设「${p.name}」`)
}

function savePresetAs(name: string) {
  const preset: CreationPreset = {
    id: `preset_${Date.now()}`,
    name,
    updatedAt: Date.now(),
    modules: {
      storyboard: { ...props.settings.creation.storyboard },
      character: { ...props.settings.creation.character },
      scene: { ...props.settings.creation.scene },
      edit: { ...props.settings.creation.edit }
    }
  }
  props.settings.creation.presets = [...props.settings.creation.presets, preset]
  ElMessage.success(`已保存预设「${name}」`)
}

async function removePreset(id: string) {
  const preset = props.settings.creation.presets.find(p => p.id === id)
  if (!preset) return
  // UXA-P2-08：删除预设不可恢复（未导出），先弹危险确认
  const ok = await confirmDanger(`确定删除预设「${preset.name}」吗？`, { confirmText: '删除' })
  if (!ok) return
  props.settings.creation.presets = props.settings.creation.presets.filter(p => p.id !== id)
  ElMessage.success('已删除预设')
}

async function runPreview(kind: 'character' | 'scene') {
  previewing.value = true
  previewUrl.value = ''
  try {
    await window.api.settings.save(JSON.parse(JSON.stringify(props.settings)))
    const res = await window.api.settings.previewAsset({
      kind,
      promptHint: kind === 'character' ? previewLook.value : previewScene.value
    })
    previewUrl.value = res.mediaUrl
    ElMessage.success('试生成完成')
  } catch (e) {
    ElMessage.error((e as Error).message || '试生成失败')
  } finally {
    previewing.value = false
  }
}

/** 保存主流程调用：把当前试生成输入值记入记忆（与原父级 saveSettings 行为一致） */
function rememberInputs() {
  memPreviewLook.remember(previewLook.value)
  memPreviewScene.remember(previewScene.value)
}

defineExpose({ rememberInputs })
</script>

<style scoped>
.section h2 {
  font-family: var(--font-display);
  color: var(--text-primary);
  font-size: 18px;
  margin-bottom: 24px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-weak);
}

.form-tip { font-size: 12px; color: var(--text-muted); margin-top: 4px; }

:deep(.el-form-item__label) { color: var(--text-secondary); }

.module-layout {
  display: grid;
  grid-template-columns: 1fr minmax(220px, 280px);
  gap: 20px;
  align-items: start;
}
.module-form .form-tip { display: block; margin-left: 0; margin-top: 4px; }
@media (max-width: 960px) {
  .module-layout { grid-template-columns: 1fr; }
}
</style>
