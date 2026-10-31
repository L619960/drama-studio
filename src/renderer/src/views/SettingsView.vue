<template>
  <div class="settings-view page">
    <div class="page-header">
      <div>
        <h1>设置</h1>
        <p class="subtitle">渲染、模型与外观偏好</p>
      </div>
      <div class="page-actions">
        <el-button @click="restoreDefaults">恢复默认</el-button>
        <el-button type="primary" @click="saveSettings" :loading="saving">
          <el-icon><Check /></el-icon>保存
        </el-button>
        <span v-if="dirty" class="dirty-tip">有未保存的修改</span>
      </div>
    </div>

    <div class="settings-body">
      <!-- 左侧导航 -->
      <div class="settings-nav glass-panel">
        <div
          v-for="item in navItems"
          :key="item.key"
          class="nav-item"
          :class="{ active: activeSection === item.key }"
          @click="activeSection = item.key"
        >
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
        </div>
      </div>

      <!-- 右侧内容 -->
      <div class="settings-content glass-panel">
        <!-- 通用 -->
        <div v-show="activeSection === 'general'" class="section">
          <h2>通用</h2>
          <el-form label-width="140px">
            <el-form-item label="自动保存">
              <el-switch v-model="settings.general.autoSave" />
              <span class="form-tip" style="margin-left: 8px">编辑分镜时自动保存项目</span>
            </el-form-item>
            <el-form-item label="自动学习">
              <el-switch v-model="settings.general.autoLearn" />
              <span class="form-tip" style="margin-left: 8px">启动后导演每周自动联网学习一次（约 15~30 万 tokens/次）；关闭后仅在聊天区手动触发</span>
            </el-form-item>
          </el-form>
        </div>

        <!-- 创作四模块（分镜生成/人物形象/场景图/视频剪辑） -->
        <CreationGroup ref="creationGroupRef" :settings="settings" :active-section="activeSection" />

        <!-- 环境检查：重新运行首跑三步向导（跳过引导后仍可从这里回来） -->
        <div v-show="activeSection === 'check'" class="section">
          <h2>环境检查</h2>
          <el-form label-width="140px">
            <el-form-item label="首跑引导">
              <el-button @click="openOnboarding">重新运行环境检查</el-button>
              <span class="form-tip" style="margin-left: 8px">检查 LLM / ComfyUI / 工作流库，并重新走一遍三步上手引导</span>
            </el-form-item>
          </el-form>
        </div>

        <!-- 渲染 -->
        <div v-show="activeSection === 'render'" class="section">
          <h2>渲染</h2>
          <el-form label-width="140px">
            <el-form-item label="默认宽度">
              <el-input-number v-model="settings.render.defaultWidth" :min="256" :max="1920" :step="16" />
            </el-form-item>
            <el-form-item label="默认高度">
              <el-input-number v-model="settings.render.defaultHeight" :min="256" :max="1080" :step="16" />
            </el-form-item>
            <el-form-item label="默认帧数">
              <el-select v-model="settings.render.defaultFrames" style="width: 200px">
                <el-option
                  v-for="f in frameOptions"
                  :key="f"
                  :label="`${f} 帧（约 ${((f - 1) / 16).toFixed(0)} 秒）`"
                  :value="f"
                />
              </el-select>
              <span class="form-tip" style="margin-left: 8px">须为 16n+1（Wan 约束）</span>
            </el-form-item>
            <el-form-item label="单镜超时(秒)">
              <el-input-number v-model="settings.render.timeout" :min="60" :max="3600" />
            </el-form-item>
            <el-form-item label="口型同步">
              <el-switch v-model="settings.render.lipSync" />
              <span class="form-tip" style="margin-left: 8px">有台词的人物镜用 LatentSync 让嘴型跟随语音（需已安装节点，失败自动回退原片）</span>
            </el-form-item>
            <el-form-item label="口型技术路线">
              <el-select v-model="settings.render.lipSyncMode" style="width: 320px">
                <el-option label="自动（推荐：H3 原生口型，失败回退 LatentSync）" value="auto" />
                <el-option label="强制 LatentSync（H3 也走图生视频+后期口型）" value="latentsync" />
                <el-option label="仅 H3 原生口型（不回退）" value="h3-native" />
              </el-select>
            </el-form-item>
            <el-form-item label="H3 turbo 加速">
              <el-switch v-model="settings.render.turboH3" />
              <span class="form-tip" style="margin-left: 8px">MiniMax H3 官方低步数 LoRA：i2v 挂 fl2v_turbo_8step（8步）、r2v 挂 ref2v_turbo_4step（4步），比无 LoRA 的同步数更快更稳，渲染慢的主要缓解</span>
            </el-form-item>
            <el-form-item label="OOM 自动降档">
              <el-switch v-model="settings.render.oomRetry" />
              <span class="form-tip" style="margin-left: 8px">显存不足时先减帧/时长，再降分辨率档位重试</span>
            </el-form-item>
            <el-form-item label="显存档位">
              <el-select v-model="settings.render.resolutionTier" style="width: 320px">
                <el-option label="自动（按显卡显存选择分辨率/帧长，推荐）" value="auto" />
                <el-option label="8GB 以下（448x800，单镜≤4.5秒）" value="low" />
                <el-option label="8–12GB（480x864，单镜≤5.2秒）" value="mid" />
                <el-option label="12–18GB（512x896，单镜≤9.3秒）" value="standard" />
                <el-option label="18–24GB（640x1136，单镜≤9.3秒）" value="high" />
                <el-option label="24GB 以上（768x1344 官方768p）" value="ultra" />
              </el-select>
              <span class="form-tip" style="margin-left: 8px">仅作用于 H3 引擎的初始档位，遇 OOM 仍会自动再降</span>
            </el-form-item>
            <el-form-item label="人物一致性校验">
              <el-select v-model="settings.render.consistencyMode" style="width: 320px">
                <el-option label="关闭" value="off" />
                <el-option label="仅告警（推荐：相似度低时提示，不重渲）" value="warn" />
                <el-option label="自动重渲（低相似度换 seed 重渲一次，审批硬门）" value="rerender" />
              </el-select>
              <span class="form-tip" style="margin-left: 8px">先检测人脸再比对末帧与参考首帧，拦截换脸/造型漂移；无人脸自动回退全图</span>
            </el-form-item>
            <el-form-item label="分镜首帧门">
              <el-select v-model="settings.render.shotReviewGate" style="width: 320px">
                <el-option label="阻断（未核对首帧不准开渲，推荐）" value="block" />
                <el-option label="告警放行（未核对仍入队）" value="warn" />
                <el-option label="关闭（不检查首帧审核）" value="off" />
              </el-select>
              <span class="form-tip" style="margin-left: 8px">开渲前的首帧核对门：只约束「能不能开始渲染」，与下方成片复审门无关</span>
            </el-form-item>
            <el-form-item label="成片复审门">
              <el-select v-model="settings.render.finalReviewGate" style="width: 320px">
                <el-option label="阻断（技术硬伤阻止配 BGM，推荐）" value="block" />
                <el-option label="告警放行（记录问题后继续）" value="warn" />
                <el-option label="关闭（仅跑技术探测，不干预）" value="off" />
              </el-select>
              <span class="form-tip" style="margin-left: 8px">成片拼好后的复审门：只约束「配不配 BGM」，与上方分镜首帧门无关</span>
            </el-form-item>
            <el-form-item label="逐镜即时审核（看守）">
              <el-switch v-model="settings.render.perShotAudit" />
              <span class="form-tip" style="margin-left: 8px">
                软提示只留痕不暂停；仅硬失败才暂停。关闭=全部渲完再统一审批
              </span>
            </el-form-item>
            <el-form-item label="资产生成并发">
              <el-select v-model="settings.render.assetConcurrency" style="width: 320px">
                <el-option :label="'1（串行，最稳）'" :value="1" />
                <el-option :label="'2（推荐）'" :value="2" />
                <el-option :label="'3（更快，显存紧张时慎用）'" :value="3" />
              </el-select>
              <span class="form-tip" style="margin-left: 8px">定妆/场景板/首帧的客户端并发；ComfyUI 侧仍排队执行</span>
            </el-form-item>
            <el-form-item label="i2i 参考图权重">
              <el-slider
                v-model="settings.render.i2iDenoise"
                :min="0.1"
                :max="1"
                :step="0.05"
                style="width: 320px"
              />
              <span class="form-tip" style="margin-left: 8px">
                首帧图生图的重绘强度：1=最大幅度重绘（默认），越低越贴近参考图、构图更死板；建议 0.55~0.8
              </span>
            </el-form-item>
            <el-form-item label="首帧人脸相似度阈值">
              <el-slider
                v-model="settings.render.firstFrameFaceThreshold"
                :min="0.3"
                :max="0.95"
                :step="0.05"
                style="width: 320px"
              />
              <span class="form-tip" style="margin-left: 8px">
                首帧与定妆照的人脸余弦相似度低于此值会自动重抽 1 次，仍低只告警不阻塞（默认 0.7）
              </span>
            </el-form-item>
          </el-form>
        </div>

        <!-- 工作流（含参数配置对话框） -->
        <WorkflowSection :settings="settings" :active-section="activeSection" />

        <!-- ComfyUI -->
        <ComfyuiSection ref="comfyuiSectionRef" :settings="settings" :active-section="activeSection" />

        <!-- TTS -->
        <div v-show="activeSection === 'tts'" class="section">
          <h2>TTS 语音</h2>
          <el-form label-width="140px">
            <el-form-item label="默认音色">
              <el-select v-model="settings.tts.defaultVoice" style="width: 200px">
                <el-option v-for="v in TTS_VOICES" :key="v.value" :label="v.label" :value="v.value" />
              </el-select>
            </el-form-item>
            <el-form-item label="语速">
              <el-slider v-model="settings.tts.rate" :min="50" :max="200" :format-tooltip="(v: number) => v + '%'" />
              <span class="form-tip" style="margin-left: 8px">推荐 85–92（略慢更有情感；100 为原速）</span>
            </el-form-item>
            <el-form-item label="音量">
              <el-slider v-model="settings.tts.volume" :min="0" :max="100" :format-tooltip="(v: number) => v + '%'" />
            </el-form-item>
          </el-form>
        </div>

        <!-- LLM -->
        <LlmSection ref="llmSectionRef" :settings="settings" :active-section="activeSection" />

        <!-- 外观 -->
        <div v-show="activeSection === 'appearance'" class="section">
          <h2>外观</h2>
          <el-form label-width="140px">
            <el-form-item label="主题">
              <el-radio-group v-model="settings.appearance.theme">
                <el-radio value="dark">深色</el-radio>
                <el-radio value="light">浅色</el-radio>
                <el-radio value="studio">深空导演棚</el-radio>
                <el-radio value="warm">暖色剪辑台</el-radio>
              </el-radio-group>
            </el-form-item>
          </el-form>
        </div>

        <!-- 快捷键 -->
        <div v-show="activeSection === 'hotkeys'" class="section">
          <h2>快捷键</h2>
          <el-alert
            type="info"
            :closable="false"
            title="Alt+1~6 快速切换页面；Ctrl+, 打开设置。"
            style="margin-bottom: 16px"
          />
          <table class="hotkey-table">
            <thead>
              <tr><th>操作</th><th>键位</th></tr>
            </thead>
            <tbody>
              <template v-for="group in hotkeyGroups" :key="group.scope">
                <tr class="hotkey-group-row">
                  <td colspan="2">{{ group.scope }}</td>
                </tr>
                <tr v-for="h in group.items" :key="h.keys.join('+')" class="hotkey-row">
                  <td class="hotkey-label">{{ h.label }}</td>
                  <td class="hotkey-keys">
                    <kbd v-for="(seg, i) in h.keys" :key="i" class="kbd">{{ seg }}</kbd>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  Setting, VideoCamera, Service, Microphone, Brush, Check, Folder, Key, MagicStick,
  Film, User, PictureFilled, Scissor, Odometer
} from '@element-plus/icons-vue'
import type { AppSettings } from '../../../shared/ipcTypes'
import { DEFAULT_CREATION, mirrorEditToRender, mirrorRenderToEdit } from '../../../shared/creationSettings'
import { TTS_VOICES, DEFAULT_TTS_VOICE } from '../../../shared/ttsVoices'
import { throttleTap } from '../utils/throttle'
import { confirmAction, confirmDanger } from '../utils/confirm'
import { ONBOARDING_OPEN_EVENT } from '../utils/onboarding'
import CreationGroup from '../components/settings/CreationGroup.vue'
import WorkflowSection from '../components/settings/WorkflowSection.vue'
import ComfyuiSection from '../components/settings/ComfyuiSection.vue'
import LlmSection from '../components/settings/LlmSection.vue'

const activeSection = ref('general')
const saving = ref(false)

// 子组件引用（保存前触发其输入框记忆落盘）
const creationGroupRef = ref<InstanceType<typeof CreationGroup> | null>(null)
const comfyuiSectionRef = ref<InstanceType<typeof ComfyuiSection> | null>(null)
const llmSectionRef = ref<InstanceType<typeof LlmSection> | null>(null)

const navItems = [
  { key: 'general', label: '通用', icon: Setting },
  { key: 'storyboard', label: '分镜生成', icon: Film },
  { key: 'character', label: '人物形象', icon: User },
  { key: 'scene', label: '场景图', icon: PictureFilled },
  { key: 'edit', label: '视频剪辑', icon: Scissor },
  { key: 'render', label: '渲染', icon: VideoCamera },
  { key: 'workflow', label: '工作流', icon: Folder },
  { key: 'comfyui', label: 'ComfyUI', icon: Service },
  { key: 'check', label: '环境检查', icon: Odometer },
  { key: 'tts', label: 'TTS 语音', icon: Microphone },
  { key: 'llm', label: 'LLM', icon: MagicStick },
  { key: 'appearance', label: '外观', icon: Brush },
  { key: 'hotkeys', label: '快捷键', icon: Key }
]

// 快捷键说明（与各视图 useHotkeys 注册保持一致）
// keys 为分段数组，渲染时每段包一个 <kbd class="kbd">
const hotkeyGroups = [
  {
    scope: '全局',
    items: [
      { keys: ['Alt', '1'], label: '项目列表' },
      { keys: ['Alt', '2'], label: '分镜编辑（需有当前项目）' },
      { keys: ['Alt', '3'], label: '角色库（需有当前项目）' },
      { keys: ['Alt', '4'], label: '场景板（需有当前项目）' },
      { keys: ['Alt', '5'], label: '渲染队列（需有当前项目）' },
      { keys: ['Alt', '6'], label: '成片预览（需有当前项目）' },
      { keys: ['Ctrl', ','], label: '打开设置' },
      { keys: ['Ctrl', 'Shift', 'Q'], label: '跳转到渲染队列（需有当前项目）' }
    ]
  },
  {
    scope: '项目列表',
    items: [{ keys: ['Ctrl', 'N'], label: '新建项目' }]
  },
  {
    scope: '分镜编辑',
    items: [
      { keys: ['Ctrl', 'N'], label: '新建分镜（渲染中不可用）' },
      { keys: ['Delete'], label: '删除选中分镜（渲染中或弹窗打开时不可用）' }
    ]
  },
  {
    scope: '剧本',
    items: [{ keys: ['Ctrl', 'S'], label: '保存剧本' }]
  },
  {
    scope: '渲染队列',
    items: [{ keys: ['F5'], label: '刷新队列状态' }]
  },
  {
    scope: '成片预览',
    items: [{ keys: ['Ctrl', 'E'], label: '导出成片' }]
  }
]

/** Wan 合法默认帧：17,33,…,113（16n+1） */
const frameOptions = [33, 49, 65, 81, 97, 113]

/** 默认设置（首屏初始值 + 「恢复默认」共用一份，避免两处默认值漂移） */
function createDefaultSettings(): AppSettings {
  return {
    revision: 0,
    general: {
      autoSave: true,
      autoLearn: true
    },
    render: {
      defaultWidth: 720,
      defaultHeight: 480,
      defaultFrames: 81,
      timeout: 600,
      lipSync: true,
      lipSyncMode: 'auto',
      oomRetry: true,
      consistencyMode: 'warn',
      resolutionTier: 'auto',
      shotReviewGate: 'block',
      reviewGate: 'block',
      finalReviewGate: 'block',
      assetConcurrency: 2,
      perShotAudit: true,
      turboH3: false,
      i2iDenoise: 1,
      firstFrameFaceThreshold: 0.7
    },
    creation: structuredClone(DEFAULT_CREATION),
    comfyui: {
      baseUrl: 'http://127.0.0.1:8188',
      modelsDir: '',
      startCommand: '',
      workflowLibraryDir: ''
    },
    tts: {
      defaultVoice: DEFAULT_TTS_VOICE,
      rate: 88,
      volume: 100
    },
    workflow: {
      default: 'wan22_i2v',
      casting: '',
      scene: '',
      shot: '',
      prop: ''
    },
    negatives: {
      casting: '',
      scene: '',
      shot: '',
      prop: ''
    },
    llm: {
      apiKey: '',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      baseUrlHistory: [] as string[]
    },
    appearance: {
      theme: 'dark'
    }
  }
}

const settings = reactive<AppSettings>(createDefaultSettings())

/** 已落盘快照：用于「有未保存修改」判定与离开拦截 */
const savedSnapshot = ref('')
const dirty = computed(() => savedSnapshot.value !== '' && savedSnapshot.value !== snapshotSettings())

function snapshotSettings(): string {
  return JSON.stringify(settings)
}

/** 双写收敛（RA-01）：creation.edit 与 render/tts 变更互相同步，任一处改都处处生效 */
watch(() => settings.creation.edit, () => mirrorEditToRender(settings), { deep: true })
watch(() => settings.render, () => mirrorRenderToEdit(settings), { deep: true })
watch(() => settings.tts, () => mirrorRenderToEdit(settings), { deep: true })

onMounted(async () => {
  await loadSettings()
  // ComfyUI 连接自检与工作流列表加载分别由 ComfyuiSection / WorkflowSection 自行 onMounted 触发
})

async function loadSettings() {
  try {
    const saved = await window.api.settings.get()
    if (!saved) {
      savedSnapshot.value = snapshotSettings()
      return
    }
    Object.assign(settings, saved)
    if (saved.creation) {
      settings.creation = {
        storyboard: { ...DEFAULT_CREATION.storyboard, ...saved.creation.storyboard },
        character: { ...DEFAULT_CREATION.character, ...saved.creation.character },
        scene: { ...DEFAULT_CREATION.scene, ...saved.creation.scene },
        edit: { ...DEFAULT_CREATION.edit, ...saved.creation.edit },
        presets: Array.isArray(saved.creation.presets) ? saved.creation.presets : []
      }
    }
    // 设置页每次进入都重读一次配置（对话内改 baseUrl 等设置也能在这里看到最新值，MP-11 本期口径）
    savedSnapshot.value = snapshotSettings()
  } catch (e) {
    // RA-10：读取失败不再静默——明确告知当前显示的是默认值，避免用户以为配置丢了
    savedSnapshot.value = snapshotSettings()
    ElMessage.warning(`配置读取失败，当前显示默认值：${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 通知 App 重新打开首跑向导（含环境检查 + 一键启动 ComfyUI） */
function openOnboarding(): void {
  window.dispatchEvent(new Event(ONBOARDING_OPEN_EVENT))
}

/** 恢复默认：重置通用/渲染/创作/语音/外观等默认值，保留 ComfyUI 与 LLM 连接配置 */
async function restoreDefaults(): Promise<void> {
  const ok = await confirmDanger(
    '将通用、渲染、创作四模块、TTS、外观恢复为默认值（保留 ComfyUI 地址与 LLM 配置，预设会被清空）。恢复后仍需点「保存」才生效。',
    { title: '恢复默认设置', confirmText: '恢复默认' }
  )
  if (!ok) return
  const defaults = createDefaultSettings()
  Object.assign(settings, {
    general: defaults.general,
    render: defaults.render,
    creation: defaults.creation,
    tts: defaults.tts,
    workflow: defaults.workflow,
    appearance: defaults.appearance
  })
  applyTheme()
  ElMessage.success('已恢复默认值，点「保存」后生效')
}

/** 即时应用主题（4 套：dark=无 class，其余挂 html.theme-xxx） */
function applyTheme(): void {
  const html = document.documentElement
  html.classList.remove('theme-light', 'theme-studio', 'theme-warm')
  if (settings.appearance.theme !== 'dark') html.classList.add(`theme-${settings.appearance.theme}`)
}

/** 落盘设置；返回是否成功（离开守卫复用，不弹成功 toast） */
async function persistSettings(showToast = true): Promise<boolean> {
  saving.value = true
  try {
    // 保存前把当前值记入各输入框记忆（去重置顶）
    creationGroupRef.value?.rememberInputs()
    comfyuiSectionRef.value?.rememberInputs()
    llmSectionRef.value?.rememberInputs()
    settings.revision = await window.api.settings.save(JSON.parse(JSON.stringify(settings)))
    applyTheme()
    // 通知侧栏立刻复查 ComfyUI（地址可能已变）
    window.dispatchEvent(new Event('comfyui:recheck'))
    savedSnapshot.value = snapshotSettings()
    if (showToast) ElMessage.success('保存成功')
    return true
  } catch (e) {
    if (showToast) ElMessage.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    return false
  } finally {
    saving.value = false
  }
}

async function saveSettings() {
  if (!throttleTap('settings-save', 800)) return
  await persistSettings()
}

// RA-11：有未保存改动时拦截路由离开；选「保存并离开」先落盘再放行
onBeforeRouteLeave(async () => {
  if (!dirty.value) return true
  const leave = await confirmAction('设置有未保存的修改，离开将丢失。是否保存后再离开？', {
    title: '未保存的修改',
    confirmText: '保存并离开',
    cancelText: '留在本页'
  })
  if (!leave) return false
  const ok = await persistSettings(false)
  if (!ok) {
    ElMessage.error('保存失败，已留在设置页，请检查后重试')
    return false
  }
  return true
})
</script>

<style scoped>
.settings-view {
  height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  max-width: 1200px;
}

.settings-body { display: flex; flex: 1; gap: 16px; overflow: hidden; min-height: 0; }
.settings-nav { width: 180px; padding: 8px; flex-shrink: 0; }
.nav-item {
  display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  border-radius: 10px; cursor: pointer; color: var(--text-secondary); font-size: 14px;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.nav-item:hover { background: var(--bg-hover); color: var(--text-primary); }
.nav-item.active {
  background: var(--bg-menu-active);
  color: var(--brand-strong);
  box-shadow: inset 0 0 0 1px rgba(212, 165, 116, 0.25);
}

.settings-content { flex: 1; padding: 22px 24px; overflow-y: auto; min-width: 0; }
.section h2 {
  font-family: var(--font-display);
  color: var(--text-primary);
  font-size: 18px;
  margin-bottom: 24px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-weak);
}

@media (max-width: 860px) {
  .settings-body { flex-direction: column; }
  .settings-nav { width: 100%; display: flex; gap: 4px; overflow-x: auto; }
  .nav-item { white-space: nowrap; }
}

.path-input { display: flex; gap: 8px; }
.path-input .el-input { flex: 1; }

.form-tip { font-size: 12px; color: var(--text-muted); margin-top: 4px; }

/* RA-11：脏态提示，提醒「改了但没保存」 */
.dirty-tip {
  font-size: 12px;
  color: var(--warning-text, #e6a23c);
  margin-left: 4px;
}

/* 快捷键说明 */
.hotkey-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.hotkey-table th {
  text-align: left;
  padding: 8px 10px;
  color: var(--text-secondary);
  font-weight: 600;
  border-bottom: 1px solid var(--border-weak);
}
.hotkey-table td {
  padding: 7px 10px;
  border-bottom: 1px solid var(--border-weak);
  color: var(--text-primary);
}
.hotkey-group-row td {
  padding-top: 14px;
  color: var(--text-muted);
  font-size: 12px;
  letter-spacing: 0.04em;
  border-bottom: none;
}
.hotkey-keys {
  display: flex;
  gap: 4px;
  align-items: center;
  flex-wrap: wrap;
}

:deep(.el-form-item__label) { color: var(--text-secondary); }
</style>
