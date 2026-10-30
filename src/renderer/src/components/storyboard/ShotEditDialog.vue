<template>
  <el-dialog v-model="visible" :title="editingShot ? '编辑分镜' : '添加分镜'" width="720px">
    <el-form :model="form" label-width="100px">
      <el-form-item label="场景">
        <el-input v-model="form.scene" placeholder="如：雨夜天台" />
      </el-form-item>
      <el-form-item label="镜头语言">
        <div class="meta-row">
          <el-select v-model="form.shotSize" clearable placeholder="景别（未设定）" style="width: 130px">
            <el-option v-for="o in SHOT_SIZE_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
          <el-select
            v-model="form.camera"
            clearable
            filterable
            allow-create
            default-first-option
            placeholder="机位/运镜（未设定）"
            style="flex: 1"
          >
            <el-option v-for="o in CAMERA_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
          <el-select
            v-model="form.emotion"
            clearable
            filterable
            allow-create
            default-first-option
            placeholder="情绪（未设定）"
            style="width: 150px"
          >
            <el-option v-for="o in EMOTION_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </div>
        <div class="form-tip">景别/机位/情绪会注入首帧与视频提示词；未设定时按默认中景、平视、自然表演生成</div>
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
      <el-divider style="margin:8px 0">分镜级提示词（AI 拆分镜自动生成，可手动修改）</el-divider>
      <el-form-item label="镜头时长">
        <el-input-number v-model="form.frameSeconds" :min="3" :max="10" :step="1" style="width: 120px" />
        <span class="form-tip" style="margin-left: 12px">秒（3~6 秒短镜最稳，按台词长度+动作复杂度）</span>
      </el-form-item>
      <el-form-item label="首帧构图">
        <el-input v-model="form.firstFrameEn" type="textarea" :rows="2"
          placeholder="英文：动作起点姿态/站位/景别/表情/光线，如 flashlight beam entering from left, blood trail on wet concrete" />
        <div class="form-tip">图生视频首帧与上下镜衔接的构图依据；留空则用动作提示词推断</div>
      </el-form-item>
      <el-form-item label="中帧姿态">
        <el-input v-model="form.midFrameEn" type="textarea" :rows="2"
          placeholder="英文（可选）：动作进行中的关键过渡姿态；纯静态镜可留空" />
      </el-form-item>
      <el-form-item label="尾帧构图">
        <el-input v-model="form.lastFrameEn" type="textarea" :rows="2"
          placeholder="英文：动作完成态/离开方向/光效收束/道具状态，供下一镜承接" />
        <div class="form-tip">本镜尾帧 = 下一镜首帧的起点，姿态必须连续（防止瞬移/倒放/过程断裂）</div>
      </el-form-item>
      <el-form-item label="下镜衔接">
        <el-input v-model="form.handoffToNext" type="textarea" :rows="1"
          placeholder="英文短语：本镜结束时人物位置/姿态/道具归属，如 officer at west exit, call received" />
      </el-form-item>
      <el-form-item label="渲染正向">
        <el-input v-model="form.promptEn" type="textarea" :rows="3"
          placeholder="英文完整正向提示词（场景+光线+运镜+动作弧线+衔接），留空则由系统按分镜字段自动拼装" />
      </el-form-item>
      <el-form-item label="渲染负向">
        <el-input v-model="form.negativeEn" type="textarea" :rows="2"
          placeholder="英文本镜专属负向（多余人物/道具穿帮/背景位移/衔接断裂），留空用通用负向" />
      </el-form-item>
      <el-form-item label="音色" v-if="form.type === 'i2v'">
        <div class="prompt-row">
          <el-select
            v-model="form.voice"
            clearable
            placeholder="跟随角色音色"
            style="flex:1"
          >
            <el-option label="小晓 (女声)" value="zh-CN-XiaoxiaoNeural" />
            <el-option label="小艺 (女声)" value="zh-CN-XiaoyiNeural" />
            <el-option label="云健 (男声)" value="zh-CN-YunjianNeural" />
            <el-option label="云野 (男声)" value="zh-CN-YunyeNeural" />
            <el-option label="云杰 (男声)" value="zh-CN-YunjieNeural" />
          </el-select>
          <el-button
            size="small"
            style="margin-left:8px"
            :disabled="!form.voice"
            :loading="previewingVoice"
            @click="previewVoice"
          >
            <el-icon><VideoPlay /></el-icon>试听
          </el-button>
        </div>
        <div class="form-tip">留空使用角色音色；试听用当前台词（无台词试听固定句）</div>
      </el-form-item>
      <el-form-item label="类型">
        <el-radio-group v-model="form.type">
          <el-radio value="i2v">人物镜头(I2V)</el-radio>
          <el-radio value="t2v">空镜(T2V)</el-radio>
        </el-radio-group>
        <div v-if="form.type === 't2v'" class="form-tip" style="color:#e6a23c">空镜需场景板或场景图，否则无法渲染</div>
      </el-form-item>
      <el-form-item label="场景板">
        <el-select
          v-model="form.sceneBoardId"
          clearable
          placeholder="选择场景资产（同场景复用）"
          style="width: 100%"
          :disabled="!sceneBoards.length"
        >
          <el-option
            v-for="b in sceneBoards"
            :key="b.id"
            :label="b.name"
            :value="b.id"
          />
        </el-select>
        <div v-if="!sceneBoards.length" class="form-tip">暂无场景板，请先在「场景板」页添加或跑导演流水线</div>
      </el-form-item>
      <el-form-item label="场景图" v-if="form.type === 't2v'">
        <div class="scene-image">
          <img v-if="scenePreview && urlCache[scenePreview]" :src="urlCache[scenePreview]" class="scene-thumb" />
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
      <el-form-item label="关键道具">
        <el-select
          v-model="form.props"
          multiple
          filterable
          allow-create
          default-first-option
          placeholder="输入道具英文名回车添加，如 umbrella / sedan"
          style="width: 100%"
        >
          <el-option v-for="p in form.props" :key="p" :label="p" :value="p" />
        </el-select>
        <div class="form-tip">道具会强约束进首帧与视频提示词，防止"藤条变绳子"类穿帮</div>
      </el-form-item>
      <el-form-item label="首帧" v-if="form.type === 'i2v'">
        <div class="scene-image">
          <img v-if="form.firstFramePath && urlCache[form.firstFramePath]" :src="urlCache[form.firstFramePath]" class="scene-thumb" />
          <div v-else class="scene-thumb empty">未设置首帧</div>
          <el-button size="small" @click="importFrame('first')">
            <el-icon><Upload /></el-icon> {{ form.firstFramePath ? '更换' : '导入' }}
          </el-button>
          <el-button size="small" :loading="generatingFirst" @click="generateFrame('first')">
            <el-icon><MagicStick /></el-icon>AI 生成
          </el-button>
        </div>
      </el-form-item>
      <el-form-item label="尾帧" v-if="form.type === 'i2v'">
        <div class="scene-image">
          <img v-if="form.lastFramePath && urlCache[form.lastFramePath]" :src="urlCache[form.lastFramePath]" class="scene-thumb" />
          <div v-else class="scene-thumb empty">未设置尾帧</div>
          <el-button size="small" @click="importFrame('last')">
            <el-icon><Upload /></el-icon> {{ form.lastFramePath ? '更换' : '导入' }}
          </el-button>
          <el-button size="small" :loading="generatingLast" @click="generateFrame('last')">
            <el-icon><MagicStick /></el-icon>AI 生成
          </el-button>
        </div>
        <div class="form-tip">填写尾帧后，渲染会自动走本机 Wan2.2 Remix 首尾帧工作流；未填则仅用首帧/定妆</div>
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
import { ref, watch, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { MagicStick, Upload, VideoPlay } from '@element-plus/icons-vue'
import type { Character, WorkflowMeta, SceneBoard, ShotSize } from '../../../../shared/ipcTypes'
import { characterPrimaryRef, normalizeSceneKey } from '../../../../shared/ipcTypes'
import { scenePlatePrompt, shotFramePrompt, sceneNegativeFor } from '../../../../shared/imagePrompts'
import { useFileUrl } from '../../composables/useFileUrl'
import { SHOT_SIZE_OPTIONS, CAMERA_OPTIONS, EMOTION_OPTIONS } from '../../utils/shotMeta'

const props = defineProps<{
  projectId: string
  projectGenre: string
  characters: Character[]
  sceneBoards?: SceneBoard[]
  workflows: WorkflowMeta[]
  defaultFrames: number
}>()

const emit = defineEmits<{ save: [draft: ShotDraft]; cancel: [] }>()

const { urlCache, ensureFileUrl } = useFileUrl()

const visible = ref(false)
const editingShot = ref<Shot | null>(null)
const optimizing = ref(false)
const generatingSceneImage = ref(false)
const generatingFirst = ref(false)
const generatingLast = ref(false)
let savedThisOpen = false

const sceneBoards = computed(() => props.sceneBoards || [])

function matchSceneBoardId(scene: string): string {
  if (!scene.trim()) return ''
  const key = normalizeSceneKey(scene)
  return sceneBoards.value.find(b => normalizeSceneKey(b.name) === key)?.id || ''
}

function selectedChars(): Character[] {
  return props.characters.filter(c => form.value.characterIds.includes(c.id))
}

function appearanceHint(): string {
  const locks = selectedChars()
    .map(c => c.appearanceLock || c.description)
    .filter(Boolean)
  return locks.length ? locks.join('; ') : ''
}

watch(visible, (v) => {
  if (!v && !savedThisOpen) emit('cancel')
})

const form = ref({
  scene: '',
  shotSize: '' as '' | ShotSize,
  camera: '',
  emotion: '',
  action: '',
  dialogue: '',
  type: 'i2v' as 'i2v' | 't2v',
  characterIds: [] as string[],
  props: [] as string[],
  frames: 81,
  seed: 42,
  workflow: '',
  voice: '',
  sceneBoardId: '' as string,
  sceneImagePath: '',
  firstFramePath: '',
  lastFramePath: '',
  frameSeconds: 4,
  firstFrameEn: '',
  midFrameEn: '',
  lastFrameEn: '',
  handoffToNext: '',
  promptEn: '',
  negativeEn: ''
})
const previewingVoice = ref(false)

const scenePreview = computed(() => {
  if (form.value.sceneImagePath) return form.value.sceneImagePath
  const board = sceneBoards.value.find(b => b.id === form.value.sceneBoardId)
  return board?.emptyPlatePath || ''
})

function open(shot: Shot | null): void {
  savedThisOpen = false
  editingShot.value = shot
  form.value = shot
    ? {
        scene: shot.scene,
        shotSize: shot.shotSize || '',
        camera: shot.camera || '',
        emotion: shot.emotion || '',
        action: shot.action,
        dialogue: shot.dialogue,
        type: shot.type,
        characterIds: [...shot.characterIds],
        props: shot.props ? [...shot.props] : [],
        frames: shot.frames,
        seed: shot.seed,
        workflow: shot.workflow || '',
        voice: shot.voice || '',
        sceneBoardId: shot.sceneBoardId || matchSceneBoardId(shot.scene),
        sceneImagePath: shot.sceneImagePath || '',
        firstFramePath: shot.firstFramePath || '',
        lastFramePath: shot.lastFramePath || '',
        frameSeconds: shot.frameSeconds || 4,
        firstFrameEn: shot.firstFrameEn || '',
        midFrameEn: shot.midFrameEn || '',
        lastFrameEn: shot.lastFrameEn || '',
        handoffToNext: shot.handoffToNext || '',
        promptEn: shot.promptEn || '',
        negativeEn: shot.negativeEn || ''
      }
    : {
        scene: '', shotSize: '', camera: '', emotion: '',
        action: '', dialogue: '', type: 'i2v', characterIds: [], props: [],
        frames: props.defaultFrames, seed: Math.floor(Math.random() * 1000000),
        workflow: '', voice: '', sceneBoardId: matchSceneBoardId(''), sceneImagePath: '',
        firstFramePath: '', lastFramePath: '', frameSeconds: 4,
        firstFrameEn: '', midFrameEn: '', lastFrameEn: '', handoffToNext: '',
        promptEn: '', negativeEn: ''
      }
  const paths = [
    form.value.sceneImagePath,
    form.value.firstFramePath,
    form.value.lastFramePath,
    scenePreview.value
  ].filter(Boolean)
  for (const p of paths) ensureFileUrl(p)
  visible.value = true
}

/** 试听分镜音色：用当前台词（无台词用固定句）走 tts.preview */
async function previewVoice(): Promise<void> {
  if (!form.value.voice) return
  previewingVoice.value = true
  try {
    await window.api.tts.preview(form.value.voice)
  } catch (e) {
    ElMessage.error(`试听失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    previewingVoice.value = false
  }
}

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

async function importSceneImage() {
  try {
    const relPath = await window.api.shot.importSceneImage(props.projectId)
    form.value.sceneImagePath = relPath
    await ensureFileUrl(relPath)
  } catch (e) {
    // 主进程取消哨兵：'User cancelled'；其余为真实导入错误，须提示
    const msg = e instanceof Error ? e.message : String(e)
    if (msg !== 'User cancelled') ElMessage.error(`导入失败：${msg}`)
  }
}

async function importFrame(kind: 'first' | 'last') {
  try {
    const relPath = await window.api.shot.importSceneImage(props.projectId)
    if (kind === 'first') form.value.firstFramePath = relPath
    else form.value.lastFramePath = relPath
    await ensureFileUrl(relPath)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg !== 'User cancelled') ElMessage.error(`导入失败：${msg}`)
  }
}

async function generateSceneImage() {
  if (!form.value.sceneBoardId) {
    const auto = matchSceneBoardId(form.value.scene)
    if (auto) form.value.sceneBoardId = auto
  }
  const board = sceneBoards.value.find(b => b.id === form.value.sceneBoardId)
  const scene = form.value.scene || board?.name || 'cinematic scene'
  generatingSceneImage.value = true
  try {
    const shotId = editingShot.value?.id ?? `new_${Date.now()}`
    const rel = `projects/${props.projectId}/shots/${shotId}_scene.png`
    await window.api.image.generate(
      scenePlatePrompt([scene, board?.description].filter(Boolean).join(', ')),
      rel,
      { width: 768, height: 1152, negative: sceneNegativeFor() }
    )
    form.value.sceneImagePath = rel
    await ensureFileUrl(rel)
    ElMessage.success('场景图生成成功')
  } catch (e) {
    ElMessage.error(`生成失败: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    generatingSceneImage.value = false
  }
}

async function generateFrame(kind: 'first' | 'last') {
  const scene = form.value.scene || 'cinematic scene'
  // 分镜级首/尾帧构图提示词优先（LLM 按动作起点/完成态定制）；无则回退动作推断
  const frameCue = kind === 'first'
    ? (form.value.firstFrameEn.trim() || form.value.action || 'standing')
    : (form.value.lastFrameEn.trim() || form.value.action || 'standing')
  const look = appearanceHint() || 'chinese person, natural everyday appearance'
  const refs = selectedChars().map(c => characterPrimaryRef(c)).filter(Boolean)
  const loading = kind === 'first' ? generatingFirst : generatingLast
  loading.value = true
  try {
    const shotId = editingShot.value?.id ?? `new_${Date.now()}`
    const rel = `projects/${props.projectId}/shots/${shotId}_${kind}.png`
    // 图生：以角色定妆图为参考，锁脸/发型/服装/肤色，注入场景/姿态/情绪/景别
    const refAbs = refs[0] || ''
    const opts = refAbs
      ? { workflowName: 'qwen2511_i2i_edit' as string, referenceImagePath: refAbs }
      : {}
    const propCue = form.value.props.length
      ? `，关键道具必须原样出现：${form.value.props.join(', ')}`
      : ''
    const editPrompt = refAbs
      ? `把图1中的人物放入场景「${scene}」：${form.value.type === 'i2v' ? `，${frameCue}` : ''}${propCue}。保持面部、发型、服装、肤色与图1完全一致，写实电影感，自然光影，背景符合场景氛围。`
      : ''
    const prompt = refAbs
      ? editPrompt
      : shotFramePrompt({
          phase: kind === 'first' ? 'start' : 'end',
          lookEn: look,
          scene,
          action: frameCue,
          characterCount: form.value.type === 'i2v' ? (form.value.characterIds.length || 1) : 1,
          props: form.value.props.length ? form.value.props : undefined,
          continuity: refs.length
            ? 'same identity as character reference sheet, consistent face and wardrobe'
            : undefined
        })
    await window.api.image.generate(
      prompt,
      rel,
      { width: 768, height: 1152, ...opts }
    )
    if (kind === 'first') form.value.firstFramePath = rel
    else form.value.lastFramePath = rel
    await ensureFileUrl(rel)
    ElMessage.success(kind === 'first' ? '首帧已生成（定妆图参考）' : '尾帧已生成')
  } catch (e) {
    ElMessage.error(`生成失败: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    loading.value = false
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
  savedThisOpen = true
  emit('save', {
    scene: form.value.scene,
    shotSize: form.value.shotSize || undefined,
    camera: form.value.camera.trim() || undefined,
    emotion: form.value.emotion.trim() || undefined,
    action: form.value.action,
    dialogue: form.value.dialogue,
    type: form.value.type,
    characterIds: form.value.type === 't2v' ? [] : form.value.characterIds,
    props: form.value.props.length ? [...form.value.props] : undefined,
    width: 720,
    height: 480,
    frames: form.value.frames,
    seed: form.value.seed,
    workflow: form.value.workflow || undefined,
    voice: form.value.voice || undefined,
    sceneBoardId: form.value.sceneBoardId || undefined,
    sceneImagePath: form.value.type === 't2v'
      ? (form.value.sceneImagePath || undefined)
      : undefined,
    firstFramePath: form.value.type === 'i2v'
      ? (form.value.firstFramePath || undefined)
      : undefined,
    lastFramePath: form.value.type === 'i2v'
      ? (form.value.lastFramePath || undefined)
      : undefined,
    frameSeconds: form.value.frameSeconds || undefined,
    firstFrameEn: form.value.firstFrameEn.trim() || undefined,
    midFrameEn: form.value.midFrameEn.trim() || undefined,
    lastFrameEn: form.value.lastFrameEn.trim() || undefined,
    handoffToNext: form.value.handoffToNext.trim() || undefined,
    promptEn: form.value.promptEn.trim() || undefined,
    negativeEn: form.value.negativeEn.trim() || undefined
  })
  visible.value = false
}

defineExpose({ open, isVisible: visible })
</script>

<style scoped>
.prompt-row { display: flex; width: 100%; }
.meta-row { display: flex; gap: 8px; width: 100%; flex-wrap: wrap; }
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
