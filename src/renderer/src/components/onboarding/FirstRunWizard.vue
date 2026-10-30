<template>
  <el-dialog
    :model-value="modelValue"
    width="680px"
    top="7vh"
    title="首次使用 · 三步上手"
    class="first-run-wizard"
    :close-on-click-modal="false"
    @update:model-value="onVisibleChange"
  >
    <el-steps :active="step" simple class="wizard-steps">
      <el-step title="检查环境" />
      <el-step title="建第一个项目" />
      <el-step title="知道去哪看进度" />
    </el-steps>

    <!-- ① 环境检查：复用系统自检结果，ComfyUI 离线时提供一键启动 -->
    <div v-if="step === 0" class="wizard-body">
      <SelfCheckPanel :items="items" :loading="checking" @rerun="runCheck" />
      <el-alert
        v-if="comfyOffline"
        type="warning"
        :closable="false"
        show-icon
        class="comfy-alert"
        title="ComfyUI 未连接，开渲前需要先启动它"
        description="可以点下方「一键启动 ComfyUI」由应用拉起本机服务；若启动失败，请到「设置 → ComfyUI」检查启动命令与地址。"
      />
      <div v-if="comfyOffline || comfyMessage" class="comfy-actions">
        <el-button v-if="comfyOffline" type="primary" :loading="startingComfy" @click="startComfyui">
          一键启动 ComfyUI
        </el-button>
        <span v-if="comfyMessage" class="comfy-state">{{ comfyMessage }}</span>
      </div>
      <p class="wizard-hint">
        LLM 未配置时不阻塞建项目，但 AI 拆镜与导演对话要先去「设置 → LLM」填 API Key。
      </p>
    </div>

    <!-- ② 建第一个项目：预填示例片名/题材，创建后引导到控制台开拍 -->
    <div v-else-if="step === 1" class="wizard-body">
      <p class="wizard-hint">
        先建一个示例项目。片名与题材已预填，创建后会带你到项目控制台，点「一键成片」打开开拍单（这两项会自动带入）。
      </p>
      <el-form label-width="72px">
        <el-form-item label="片名">
          <el-input v-model="draftTitle" maxlength="40" placeholder="如：总裁的隐婚新娘" />
        </el-form-item>
        <el-form-item label="题材">
          <el-input v-model="draftGenre" maxlength="20" placeholder="如：都市甜宠" />
        </el-form-item>
      </el-form>
      <div class="comfy-actions">
        <el-button type="primary" :loading="creating" @click="createProject">创建项目并去控制台</el-button>
        <span class="comfy-state">也可以跳过这步，稍后在项目列表里自己新建</span>
      </div>
    </div>

    <!-- ③ 进度去哪看 -->
    <div v-else class="wizard-body">
      <ul class="guide-list">
        <li><strong>底部运行条</strong>：任何页面都能看到当前阶段、进度与暂停/停止；完成变绿、失败变红。</li>
        <li><strong>导演控制台</strong>：阶段时间线、门禁确认和执行日志都在这里。</li>
        <li><strong>中断可续跑</strong>：应用重启后项目列表会提示「从断点继续」，不用从头再来。</li>
      </ul>
      <el-alert
        v-if="createdId"
        type="success"
        :closable="false"
        show-icon
        :title="`项目已创建，点「开始使用」后直接进入控制台`"
      />
      <el-alert
        v-else
        type="info"
        :closable="false"
        show-icon
        title="准备就绪：点「开始使用」回到项目列表，随时可以开拍"
      />
    </div>

    <template #footer>
      <div class="wizard-footer">
        <el-button text @click="skip">跳过引导</el-button>
        <div class="footer-actions">
          <el-button v-if="step > 0" @click="step -= 1">上一步</el-button>
          <el-button v-if="step < 2" type="primary" @click="step += 1">下一步</el-button>
          <el-button v-else type="primary" @click="finish">开始使用</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { SelfCheckItem } from '../../../../shared/ipcTypes'
import SelfCheckPanel from '../console/SelfCheckPanel.vue'
import { SAMPLE_PROJECT, isComfyOffline, markOnboarded } from '../../utils/onboarding'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const router = useRouter()

const step = ref(0)
const items = ref<SelfCheckItem[]>([])
const checking = ref(false)
const comfyOffline = ref(false)
const startingComfy = ref(false)
const comfyMessage = ref('')
const creating = ref(false)
const draftTitle = ref(SAMPLE_PROJECT.title)
const draftGenre = ref(SAMPLE_PROJECT.genre)
const createdId = ref('')

let pollTimer: ReturnType<typeof setInterval> | null = null
let pollAttempts = 0

const COMBO_POLL_MS = 2000
const COMBO_POLL_MAX = 30

watch(
  () => props.modelValue,
  (open) => {
    if (!open) {
      clearPoll()
      return
    }
    step.value = 0
    createdId.value = ''
    draftTitle.value = SAMPLE_PROJECT.title
    draftGenre.value = SAMPLE_PROJECT.genre
    comfyMessage.value = ''
    void runCheck()
  }
)

async function runCheck(): Promise<void> {
  if (checking.value) return
  checking.value = true
  try {
    items.value = await window.api.system.selfcheck()
    comfyOffline.value = isComfyOffline(items.value)
    if (comfyOffline.value) {
      // 自检的 ComfyUI 项可能是配置未保存时的旧结论，再用实时健康检查确认一次
      const online = await window.api.comfyui.healthCheck().catch(() => false)
      comfyOffline.value = !online
    }
  } catch (e) {
    ElMessage.error(`环境检查失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    checking.value = false
  }
}

async function startComfyui(): Promise<void> {
  if (startingComfy.value) return
  startingComfy.value = true
  comfyMessage.value = ''
  try {
    const r = await window.api.comfyui.start()
    if (r.ok) {
      comfyMessage.value = r.already
        ? 'ComfyUI 已在运行，等待连接…'
        : `已拉起 ComfyUI${r.pid ? `（PID ${r.pid}）` : ''}，等待连接…`
      pollComfy()
    } else {
      comfyMessage.value = `启动失败：${r.error || '未知原因'}。请到「设置 → ComfyUI」检查启动命令与地址。`
    }
  } catch (e) {
    comfyMessage.value = `启动失败：${e instanceof Error ? e.message : String(e)}。请到「设置 → ComfyUI」检查启动命令与地址。`
  } finally {
    startingComfy.value = false
  }
}

function pollComfy(): void {
  clearPoll()
  pollAttempts = 0
  pollTimer = setInterval(() => {
    pollAttempts += 1
    void window.api.comfyui.healthCheck()
      .catch(() => false)
      .then((online) => {
        if (online) {
          comfyOffline.value = false
          comfyMessage.value = 'ComfyUI 已连接'
          clearPoll()
          void runCheck()
          return
        }
        if (pollAttempts >= COMBO_POLL_MAX) {
          comfyMessage.value = '等待超时，ComfyUI 仍未连接。请到「设置 → ComfyUI」检查启动命令与地址。'
          clearPoll()
        }
      })
  }, COMBO_POLL_MS)
}

function clearPoll(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function createProject(): Promise<void> {
  if (creating.value) return
  const title = draftTitle.value.trim()
  const genre = draftGenre.value.trim()
  if (!title || !genre) {
    ElMessage.warning('片名和题材都填一下，创建后可在控制台里继续改')
    return
  }
  creating.value = true
  try {
    const project = await window.api.project.create(title, genre)
    createdId.value = project.id
    ElMessage.success('项目已创建，正在打开控制台')
    step.value = 2
  } catch (e) {
    ElMessage.error(`创建项目失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    creating.value = false
  }
}

function onVisibleChange(visible: boolean): void {
  if (!visible) {
    // 点右上角 × 与「跳过引导」同义：不写入完成标记会反复弹，跳过后不再骚扰
    markOnboarded()
    clearPoll()
  }
  emit('update:modelValue', visible)
}

function skip(): void {
  finish()
}

async function finish(): Promise<void> {
  markOnboarded()
  clearPoll()
  emit('update:modelValue', false)
  if (createdId.value) {
    await router.push(`/project/${createdId.value}/console`)
  }
}

onUnmounted(clearPoll)
</script>

<style scoped>
.wizard-steps {
  margin: 4px 0 16px;
}
.wizard-body {
  min-height: 260px;
}
.wizard-hint {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-muted);
}
.comfy-alert {
  margin-top: 12px;
}
.comfy-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.comfy-state {
  font-size: 12px;
  color: var(--text-secondary);
}
.guide-list {
  margin: 4px 0 14px;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.9;
  color: var(--text-primary);
}
.guide-list strong {
  color: var(--brand-strong);
}
.wizard-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.footer-actions {
  display: flex;
  gap: 8px;
}
</style>
