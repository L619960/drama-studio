<template>
  <el-dialog v-model="visible" :title="editingShot ? '编辑分镜' : '添加分镜'" width="650px">
    <el-form :model="form" label-width="100px">
      <el-form-item label="场景">
        <el-input v-model="form.scene" placeholder="如：雨夜天台" />
      </el-form-item>
      <el-form-item label="动作提示词" required>
        <div class="prompt-row">
          <el-input
            v-model="form.action"
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
        <el-input v-model="form.dialogue" type="textarea" :rows="2" placeholder="中文台词，用于 TTS" />
      </el-form-item>
      <el-form-item label="类型">
        <el-radio-group v-model="form.type">
          <el-radio value="i2v">人物镜头(I2V)</el-radio>
          <el-radio value="t2v">空镜(T2V)</el-radio>
        </el-radio-group>
        <div v-if="form.type === 't2v'" class="form-tip" style="color:#e6a23c">空镜需上传场景参考图，否则无法渲染</div>
      </el-form-item>
      <el-form-item label="场景图" v-if="form.type === 't2v'">
        <div class="scene-image">
          <img v-if="form.sceneImagePath && urlCache[form.sceneImagePath]" :src="urlCache[form.sceneImagePath]" class="scene-thumb" />
          <div v-else class="scene-thumb empty">未选择场景图</div>
          <el-button size="small" @click="importSceneImage">
            <el-icon><Upload /></el-icon> {{ form.sceneImagePath ? '更换' : '导入' }}
          </el-button>
          <el-button size="small" :loading="generatingSceneImage" @click="generateSceneImage">
            <el-icon><MagicStick /></el-icon>AI 生成
          </el-button>
        </div>
      </el-form-item>
      <el-form-item label="角色" v-if="form.type === 'i2v'">
        <el-select v-model="form.characterIds" multiple placeholder="选择角色" style="width: 100%">
          <el-option v-for="c in characters" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="时长">
        <el-input-number v-model="form.frames" :min="33" :max="120" :step="16" style="width: 120px" />
        <span class="form-tip" style="margin-left: 12px">
          {{ form.frames }}帧 ≈ {{ ((form.frames - 1) / 16).toFixed(0) }}秒
        </span>
      </el-form-item>
      <el-form-item label="Seed">
        <el-input-number v-model="form.seed" :min="0" style="width: 150px" />
        <el-button size="small" style="margin-left: 8px" @click="randomizeSeed">随机</el-button>
      </el-form-item>
      <el-form-item label="工作流">
        <el-select v-model="form.workflow" placeholder="使用默认工作流" clearable style="width: 240px">
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
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<script lang="ts">
import type { Shot } from '../../../../shared/ipcTypes'

/** 保存草稿：完整 Shot 除去由父组件按插入位置决定的 id/index/status */
export type ShotDraft = Omit<Shot, 'id' | 'index' | 'status'>
</script>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { MagicStick, Upload } from '@element-plus/icons-vue'
import type { Character, WorkflowMeta } from '../../../../shared/ipcTypes'
import { useFileUrl } from '../../composables/useFileUrl'

const props = defineProps<{
  projectId: string
  projectGenre: string
  characters: Character[]
  workflows: WorkflowMeta[]
  defaultFrames: number
}>()

const emit = defineEmits<{ save: [draft: ShotDraft] }>()

const { urlCache, ensureFileUrl } = useFileUrl()

const visible = ref(false)
/** 正在编辑的镜头（null = 新增） */
const editingShot = ref<Shot | null>(null)
const optimizing = ref(false)
// AI 生成场景图
const generatingSceneImage = ref(false)

const form = ref({
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

/** 打开对话框：shot 为 null 时新增，否则编辑该镜头 */
function open(shot: Shot | null): void {
  editingShot.value = shot
  form.value = shot
    ? {
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
    : {
        scene: '', action: '', dialogue: '', type: 'i2v', characterIds: [],
        frames: props.defaultFrames, seed: Math.floor(Math.random() * 1000000),
        workflow: '', sceneImagePath: ''
      }
  if (shot?.sceneImagePath) {
    ensureFileUrl(shot.sceneImagePath)
  }
  visible.value = true
}

// AI 优化提示词（支持中英混合输入）
async function optimizePrompt() {
  if (!form.value.action.trim()) {
    ElMessage.warning('请先输入动作描述')
    return
  }
  optimizing.value = true
  try {
    const result = await window.api.llm.translatePrompt({
      scene: form.value.scene,
      action: form.value.action,
      dialogue: form.value.dialogue,
      genre: props.projectGenre
    })
    form.value.action = result
    ElMessage.success('提示词已优化')
  } catch (e) {
    ElMessage.error((e as Error).message || 'AI 优化失败')
  } finally {
    optimizing.value = false
  }
}

// 导入场景参考图
async function importSceneImage() {
  try {
    const relPath = await window.api.shot.importSceneImage(props.projectId)
    form.value.sceneImagePath = relPath
    await ensureFileUrl(relPath)
  } catch {
    // 用户取消
  }
}

/** AI 生成场景图：用场景描述构建提示词 */
async function generateSceneImage() {
  const scene = form.value.scene || 'cinematic scene'
  generatingSceneImage.value = true
  try {
    const prompt = `cinematic scene, ${scene}, wide angle, detailed environment, atmospheric lighting, high quality, 8k`
    const shotId = editingShot.value?.id ?? `new_${Date.now()}`
    const rel = `projects/${props.projectId}/shots/${shotId}_scene.png`
    await window.api.image.generate(prompt, rel)
    form.value.sceneImagePath = rel
    await ensureFileUrl(rel)
    ElMessage.success('场景图生成成功')
  } catch (e) {
    ElMessage.error(`生成失败: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    generatingSceneImage.value = false
  }
}

function randomizeSeed() {
  form.value.seed = Math.floor(Math.random() * 1000000)
}

function save() {
  if (!form.value.action.trim()) {
    ElMessage.warning('请输入动作提示词')
    return
  }
  emit('save', {
    scene: form.value.scene,
    action: form.value.action,
    dialogue: form.value.dialogue,
    type: form.value.type,
    characterIds: form.value.type === 't2v' ? [] : form.value.characterIds,
    width: 720,
    height: 480,
    frames: form.value.frames,
    seed: form.value.seed,
    workflow: form.value.workflow || undefined,
    sceneImagePath: form.value.type === 't2v' ? form.value.sceneImagePath || undefined : undefined
  })
  visible.value = false
}

defineExpose({ open, isVisible: visible })
</script>

<style scoped>
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
</style>
