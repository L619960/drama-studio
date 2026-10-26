<template>
  <!-- ComfyUI -->
  <div v-show="activeSection === 'comfyui'" class="section">
    <h2>ComfyUI</h2>
    <el-form label-width="140px">
      <el-form-item label="服务地址">
        <el-select
          v-model="settings.comfyui.baseUrl"
          filterable
          allow-create
          default-first-option
          placeholder="http://127.0.0.1:8188"
          style="max-width: 380px; width: 380px"
          :no-data-text="'输入新地址后回车，保存即加入下拉记忆'"
          @contextmenu.prevent="openInputMenu($event, { el: $event.target as HTMLInputElement, onPick: (v) => { settings.comfyui.baseUrl = v }, onClear: () => { settings.comfyui.baseUrl = '' }, history: () => memComfyBase.read(), clearHistory: () => memComfyBase.clear() })"
        >
          <el-option
            v-for="u in memComfyBase.read()"
            :key="u"
            :label="u"
            :value="u"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="models 目录">
        <el-select
          v-model="settings.comfyui.modelsDir"
          filterable
          allow-create
          default-first-option
          placeholder="留空自动定位（ComfyUI 的 models 目录）"
          style="max-width: 100%; width: 100%"
          :no-data-text="'输入新路径后回车，保存即加入下拉记忆'"
          @contextmenu.prevent="openInputMenu($event, { el: $event.target as HTMLInputElement, onPick: (v) => { settings.comfyui.modelsDir = v }, onClear: () => { settings.comfyui.modelsDir = '' }, history: () => memModelsDir.read(), clearHistory: () => memModelsDir.clear() })"
        >
          <el-option
            v-for="u in memModelsDir.read()"
            :key="u"
            :label="u"
            :value="u"
          />
        </el-select>
        <div class="form-tip">
          工作流自检发现缺模型时，会引导打开此目录放置模型文件；留空则自动按 ComfyUI 安装位置解析
        </div>
      </el-form-item>
      <el-form-item label="连接状态">
        <el-tag :type="comfyuiConnected ? 'success' : 'danger'">
          {{ comfyuiConnected ? '已连接' : comfyuiStarting ? '启动中…' : '未连接' }}
        </el-tag>
        <el-button size="small" style="margin-left: 12px" :loading="testingComfy" @click="testComfyUI">测试连接</el-button>
        <el-button
          size="small"
          type="primary"
          :loading="comfyuiStarting"
          :disabled="comfyuiConnected"
          style="margin-left: 8px"
          @click="startComfyUI"
        >启动 ComfyUI</el-button>
        <el-button size="small" type="danger" plain :loading="stoppingComfy" :disabled="!comfyuiConnected || comfyuiStarting" style="margin-left: 8px" @click="stopComfyUI">
          {{ stoppingComfy ? '停止中...' : '停止 ComfyUI' }}
        </el-button>
      </el-form-item>
      <el-form-item label="启动命令">
        <el-select
          v-model="settings.comfyui.startCommand"
          filterable
          allow-create
          default-first-option
          placeholder="填写本机 python.exe 与 main.py 的完整启动命令"
          style="max-width: 100%; width: 100%"
          :no-data-text="'输入新命令后回车，保存即加入下拉记忆'"
          @contextmenu.prevent="openInputMenu($event, { el: $event.target as HTMLInputElement, onPick: (v) => { settings.comfyui.startCommand = v }, onClear: () => { settings.comfyui.startCommand = '' }, history: () => memStartCmd.read(), clearHistory: () => memStartCmd.clear() })"
        >
          <el-option
            v-for="u in memStartCmd.read()"
            :key="u"
            :label="u"
            :value="u"
          />
        </el-select>
        <div class="form-tip">
          一键启动用的完整命令行，路径用英文引号包裹；留空自动用本机秋叶整合包默认路径启动
        </div>
      </el-form-item>
      <el-form-item label="工作流库目录">
        <el-select
          v-model="settings.comfyui.workflowLibraryDir"
          filterable
          allow-create
          default-first-option
          placeholder="填写工作流 JSON 所在目录，留空则库为空"
          style="max-width: 100%; width: 100%"
          :no-data-text="'输入新路径后回车，保存即加入下拉记忆'"
          @contextmenu.prevent="openInputMenu($event, { el: $event.target as HTMLInputElement, onPick: (v) => { settings.comfyui.workflowLibraryDir = v }, onClear: () => { settings.comfyui.workflowLibraryDir = '' }, history: () => memWfLib.read(), clearHistory: () => memWfLib.clear() })"
        >
          <el-option
            v-for="u in memWfLib.read()"
            :key="u"
            :label="u"
            :value="u"
          />
        </el-select>
        <div class="form-tip">
          你收集的 ComfyUI 工作流全集目录（UI 格式）。导演对话可用「导入工作流库」把其中任意工作流转成 API 模板使用；修改后需重启应用生效
        </div>
      </el-form-item>
    </el-form>
  </div>

  <InputContextMenu ref="inputCtxMenu" />
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import type { AppSettings } from '../../../../shared/ipcTypes'
import InputContextMenu from '../common/InputContextMenu.vue'
import { useInputMemory } from '../../utils/useInputMemory'

const props = defineProps<{
  settings: AppSettings
  activeSection: string
}>()

/** 输入框记忆实例（右键菜单 + 下拉记忆共用） */
const memComfyBase = useInputMemory('comfyui-baseurl')
const memModelsDir = useInputMemory('comfyui-modelsdir')
const memStartCmd = useInputMemory('comfyui-startcmd')
const memWfLib = useInputMemory('comfyui-wflib')

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

const comfyuiConnected = ref(false)
const comfyuiStarting = ref(false)
/** 测试连接 / 停止 ComfyUI / 导入工作流 按钮 loading（UXA-P1-05） */
const testingComfy = ref(false)
const stoppingComfy = ref(false)

onMounted(async () => {
  await testComfyUI()
})

async function testComfyUI() {
  if (testingComfy.value) return
  testingComfy.value = true
  try {
    comfyuiConnected.value = await window.api.comfyui.healthCheck()
  } catch {
    comfyuiConnected.value = false
  } finally {
    testingComfy.value = false
    window.dispatchEvent(new Event('comfyui:recheck'))
  }
}

/** 一键启动 ComfyUI：spawn 后台进程后轮询 healthCheck 直到就绪（或失败），期间按钮呈「启动中」 */
async function startComfyUI() {
  if (comfyuiStarting.value || comfyuiConnected.value) return
  comfyuiStarting.value = true
  try {
    const r = await window.api.comfyui.start()
    if (!r.ok) {
      ElMessage.error(`启动失败：${r.error ?? '未知错误'}`)
      return
    }
    // 后台就绪轮询：最长 180s，每 2s 一次
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 2000))
      const up = await window.api.comfyui.healthCheck()
      if (up) {
        comfyuiConnected.value = true
        window.dispatchEvent(new Event('comfyui:recheck'))
        ElMessage.success('ComfyUI 已启动')
        return
      }
    }
    ElMessage.warning('启动命令已执行，但 180 秒内未就绪，请查看 ComfyUI 日志')
  } catch (e) {
    ElMessage.error(`启动异常：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    comfyuiStarting.value = false
  }
}

/** 停止 ComfyUI：按端口定位进程结束（含子进程树） */
async function stopComfyUI() {
  if (comfyuiStarting.value || stoppingComfy.value) return
  stoppingComfy.value = true
  try {
    const r = await window.api.comfyui.stop()
    if (r.ok) {
      comfyuiConnected.value = false
      window.dispatchEvent(new Event('comfyui:recheck'))
      ElMessage.success(r.killed > 0 ? `ComfyUI 已停止（结束 ${r.killed} 个进程）` : 'ComfyUI 已停止')
    } else {
      ElMessage.error(`停止失败：${r.error ?? '未找到对应进程'}`)
    }
  } catch (e) {
    ElMessage.error(`停止异常：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    stoppingComfy.value = false
  }
}

/** 保存主流程调用：把当前 ComfyUI 输入值记入记忆（与原父级 saveSettings 行为一致） */
function rememberInputs() {
  memComfyBase.remember(props.settings.comfyui.baseUrl)
  memModelsDir.remember(props.settings.comfyui.modelsDir ?? '')
  memStartCmd.remember(props.settings.comfyui.startCommand ?? '')
  memWfLib.remember(props.settings.comfyui.workflowLibraryDir ?? '')
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
</style>
