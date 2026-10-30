<template>
  <!-- LLM -->
  <div v-show="activeSection === 'llm'" class="section">
    <h2>LLM（OpenAI 兼容）</h2>
    <el-form label-width="140px">
      <el-form-item label="API Key">
        <el-input
          v-model="settings.llm.apiKey"
          type="password"
          show-password
          placeholder="sk-..."
          style="max-width: 380px"
          @contextmenu.prevent="openInputMenu($event, { el: $event.target as HTMLInputElement })"
        />
      </el-form-item>
      <el-form-item label="接口地址">
        <el-select
          v-model="settings.llm.baseUrl"
          filterable
          allow-create
          default-first-option
          placeholder="https://api.deepseek.com"
          style="max-width: 380px; width: 380px"
          :no-data-text="'输入新地址后回车，保存即加入下拉记忆'"
        >
          <el-option
            v-for="u in settings.llm.baseUrlHistory || []"
            :key="u"
            :label="u"
            :value="u"
          />
        </el-select>
        <div class="form-tip">DeepSeek: https://api.deepseek.com；火山方舟: https://ark.cn-beijing.volces.com/api/v3；历史地址自动记忆（最多 12 条），点击下拉即可选择</div>
      </el-form-item>
      <el-form-item label="模型">
        <el-select
          v-model="settings.llm.model"
          filterable
          allow-create
          default-first-option
          placeholder="deepseek-chat"
          style="max-width: 380px; width: 380px"
          :no-data-text="'输入新模型后回车，保存即加入下拉记忆'"
          @contextmenu.prevent="openInputMenu($event, { el: $event.target as HTMLInputElement, onPick: (v) => { settings.llm.model = v }, onClear: () => { settings.llm.model = '' }, history: () => memModel.read(), clearHistory: () => memModel.clear() })"
        >
          <el-option
            v-for="u in memModel.read()"
            :key="u"
            :label="u"
            :value="u"
          />
        </el-select>
        <div class="form-tip">DeepSeek: deepseek-chat；火山方舟: 推理接入点 ID（ep-xxx）；历史模型自动记忆，点击下拉即可选择</div>
      </el-form-item>
      <el-form-item label="连接状态">
        <el-tag :type="llmStatus.type">{{ llmStatus.text }}</el-tag>
        <el-button size="small" style="margin-left: 12px" :loading="llmTesting" @click="testLLM">测试连接</el-button>
        <span class="form-tip" style="margin-left: 8px">测试前请先保存</span>
      </el-form-item>
    </el-form>
  </div>

  <InputContextMenu ref="inputCtxMenu" />
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { AppSettings } from '../../../../shared/ipcTypes'
import InputContextMenu from '../common/InputContextMenu.vue'
import { useInputMemory } from '../../utils/useInputMemory'

const props = defineProps<{
  settings: AppSettings
  activeSection: string
}>()

/** 输入框记忆实例（右键菜单 + 下拉记忆共用） */
const memModel = useInputMemory('llm-model')

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

// LLM 连接测试
const llmTesting = ref(false)
const llmStatus = ref<{ type: 'success' | 'danger' | 'info'; text: string }>({ type: 'info', text: '未测试' })

async function testLLM() {
  llmTesting.value = true
  try {
    // 先保存再测试，确保主进程拿到最新 Key
    await window.api.settings.save(JSON.parse(JSON.stringify(props.settings)))
    const model = await window.api.llm.test()
    llmStatus.value = { type: 'success', text: `已连接（${model}）` }
  } catch (e) {
    llmStatus.value = { type: 'danger', text: `连接失败：${(e as Error).message}` }
  } finally {
    llmTesting.value = false
  }
}

/** 保存主流程调用：把当前 LLM 模型值记入记忆（与原父级 saveSettings 行为一致） */
function rememberInputs() {
  memModel.remember(props.settings.llm.model)
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
