<template>
  <div class="settings-view">
    <div class="header">
      <h1>设置</h1>
      <el-button type="primary" @click="saveSettings" :loading="saving">
        <el-icon><Check /></el-icon>保存
      </el-button>
    </div>

    <div class="settings-body">
      <!-- 左侧导航 -->
      <div class="settings-nav">
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
      <div class="settings-content">
        <!-- 通用 -->
        <div v-show="activeSection === 'general'" class="section">
          <h2>通用</h2>
          <el-form label-width="140px">
            <el-form-item label="项目数据目录">
              <div class="path-input">
                <el-input v-model="settings.general.dataDir" readonly />
                <el-button @click="selectDataDir">浏览</el-button>
              </div>
              <div class="form-tip">所有项目数据保存在此目录</div>
            </el-form-item>
            <el-form-item label="自动保存">
              <el-switch v-model="settings.general.autoSave" />
              <span class="form-tip" style="margin-left: 8px">编辑分镜时自动保存项目</span>
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
              <el-input-number v-model="settings.render.defaultFrames" :min="33" :max="120" :step="16" />
              <span class="form-tip" style="margin-left: 8px">16fps 时约 {{ ((settings.render.defaultFrames - 1) / 16).toFixed(0) }} 秒</span>
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
            <el-form-item label="OOM 自动降档">
              <el-switch v-model="settings.render.oomRetry" />
              <span class="form-tip" style="margin-left: 8px">显存不足时自动减帧/降步数重试一次</span>
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
                <el-option label="自动重渲（低相似度换 seed 重渲一次）" value="rerender" />
              </el-select>
              <span class="form-tip" style="margin-left: 8px">先检测人脸再比对末帧与参考首帧，拦截换脸/造型漂移；无人脸自动回退全图（首次下载约 0.2MB 人脸检测 + 14MB 人脸识别模型，另需约 90MB CLIP 全图模型）</span>
            </el-form-item>
          </el-form>
        </div>

        <!-- 工作流 -->
        <div v-show="activeSection === 'workflow'" class="section">
          <h2>工作流</h2>
          <el-form label-width="140px">
            <el-form-item label="默认工作流">
              <el-select v-model="settings.workflow.default" placeholder="选择默认工作流" style="width: 280px">
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
              <span class="form-tip" style="margin-left: 8px">未指定工作流的分镜使用此默认值</span>
            </el-form-item>
          </el-form>

          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 24px">
            <h3 style="color: var(--text-secondary); font-size: 14px; margin: 0">可用工作流（{{ workflows.length }}）</h3>
            <el-button size="small" @click="importWorkflow">
              <el-icon><Folder /></el-icon>导入工作流
            </el-button>
          </div>
          <div v-if="workflows.length === 0" class="empty-tip">未发现工作流文件，点击「导入工作流」添加</div>
          <div v-for="w in workflows" :key="w.name" class="workflow-card">
            <div class="workflow-card-header">
              <div class="workflow-name">{{ w.name }}</div>
              <el-button size="small" @click="openParamsDialog(w.name)">参数配置</el-button>
            </div>
            <div class="workflow-tags">
              <el-tag size="small" :type="w.hasImageInput ? 'success' : 'info'">
                {{ w.hasImageInput ? '图生视频' : '文生视频' }}
              </el-tag>
              <el-tag v-if="w.hasDuration" size="small" type="warning">支持时长</el-tag>
            </div>
            <div class="workflow-ph">占位符：{{ w.placeholders.map(p => '$' + p + '$').join('、') }}</div>
          </div>
        </div>

        <!-- 工作流参数配置对话框 -->
        <el-dialog v-model="paramsDialog.visible" :title="`参数配置：${paramsDialog.workflowName}`" width="680px" top="6vh">
          <div v-if="paramsDialog.loading" style="text-align: center; padding: 40px; color: var(--text-secondary)">加载中...</div>
          <div v-else-if="paramsDialog.params.length === 0" class="empty-tip">无可编辑参数</div>
          <div v-else class="params-scroll">
            <div v-for="group in paramsGroups" :key="group.nodeId" class="param-node-group">
              <div class="param-node-title">
                <span>{{ group.nodeTitle }}</span>
                <span class="param-node-id">#{{ group.nodeId }} · {{ group.classType }}</span>
              </div>
              <div v-for="p in group.params" :key="p.key" class="param-row">
                <span class="param-key">{{ p.key }}</span>
                <template v-if="p.isConnection">
                  <el-input :model-value="String(p.value)" disabled size="small" class="param-input" />
                  <el-tag size="small" type="info">连接</el-tag>
                </template>
                <template v-else-if="p.isPlaceholder">
                  <el-input :model-value="String(p.value)" disabled size="small" class="param-input" />
                  <el-tag size="small" type="warning">占位符</el-tag>
                </template>
                <template v-else-if="p.type === 'boolean'">
                  <el-switch v-model="p.value" @change="saveParam(p)" />
                </template>
                <template v-else-if="p.type === 'number'">
                  <el-input-number
                    :model-value="p.value"
                    controls-position="right"
                    size="small"
                    class="param-input"
                    @change="(v: number) => saveParam({ ...p, value: v })"
                  />
                </template>
                <template v-else>
                  <el-input
                    :model-value="String(p.value)"
                    size="small"
                    class="param-input"
                    @change="(v: string) => saveParam({ ...p, value: v })"
                  />
                </template>
              </div>
            </div>
          </div>
          <template #footer>
            <el-button @click="paramsDialog.visible = false">关闭</el-button>
          </template>
        </el-dialog>

        <!-- ComfyUI -->
        <div v-show="activeSection === 'comfyui'" class="section">
          <h2>ComfyUI</h2>
          <el-form label-width="140px">
            <el-form-item label="服务地址">
              <el-input v-model="settings.comfyui.baseUrl" placeholder="http://127.0.0.1:8188" />
            </el-form-item>
            <el-form-item label="工作流目录">
              <div class="path-input">
                <el-input v-model="settings.comfyui.workflowDir" readonly />
                <el-button @click="selectWorkflowDir">浏览</el-button>
              </div>
            </el-form-item>
            <el-form-item label="连接状态">
              <el-tag :type="comfyuiConnected ? 'success' : 'danger'">
                {{ comfyuiConnected ? '已连接' : '未连接' }}
              </el-tag>
              <el-button size="small" style="margin-left: 12px" @click="testComfyUI">测试连接</el-button>
            </el-form-item>
          </el-form>
        </div>

        <!-- TTS -->
        <div v-show="activeSection === 'tts'" class="section">
          <h2>TTS 语音</h2>
          <el-form label-width="140px">
            <el-form-item label="默认音色">
              <el-select v-model="settings.tts.defaultVoice" style="width: 200px">
                <el-option label="小晓 (女声)" value="zh-CN-XiaoxiaoNeural" />
                <el-option label="云健 (男声)" value="zh-CN-YunjianNeural" />
                <el-option label="小艺 (女声)" value="zh-CN-XiaoyiNeural" />
                <el-option label="云野 (男声)" value="zh-CN-YunyeNeural" />
              </el-select>
            </el-form-item>
            <el-form-item label="语速">
              <el-slider v-model="settings.tts.rate" :min="50" :max="200" :format-tooltip="(v: number) => v + '%'" />
            </el-form-item>
            <el-form-item label="音量">
              <el-slider v-model="settings.tts.volume" :min="0" :max="100" :format-tooltip="(v: number) => v + '%'" />
            </el-form-item>
          </el-form>
        </div>

        <!-- LLM -->
        <div v-show="activeSection === 'llm'" class="section">
          <h2>LLM（OpenAI 兼容）</h2>
          <el-form label-width="140px">
            <el-form-item label="API Key">
              <el-input v-model="settings.llm.apiKey" type="password" show-password placeholder="sk-..." style="max-width: 380px" />
            </el-form-item>
            <el-form-item label="接口地址">
              <el-input v-model="settings.llm.baseUrl" placeholder="https://api.deepseek.com" style="max-width: 380px" />
              <div class="form-tip">DeepSeek: https://api.deepseek.com；火山方舟: https://ark.cn-beijing.volces.com/api/v3</div>
            </el-form-item>
            <el-form-item label="模型">
              <el-input v-model="settings.llm.model" placeholder="deepseek-chat" style="max-width: 380px" />
              <div class="form-tip">DeepSeek: deepseek-chat；火山方舟: 推理接入点 ID（ep-xxx）</div>
            </el-form-item>
            <el-form-item label="连接状态">
              <el-tag :type="llmStatus.type">{{ llmStatus.text }}</el-tag>
              <el-button size="small" style="margin-left: 12px" :loading="llmTesting" @click="testLLM">测试连接</el-button>
              <span class="form-tip" style="margin-left: 8px">测试前请先保存</span>
            </el-form-item>
          </el-form>
        </div>

        <!-- 外观 -->
        <div v-show="activeSection === 'appearance'" class="section">
          <h2>外观</h2>
          <el-form label-width="140px">
            <el-form-item label="主题">
              <el-radio-group v-model="settings.appearance.theme">
                <el-radio value="dark">深色</el-radio>
                <el-radio value="light">浅色</el-radio>
              </el-radio-group>
            </el-form-item>
          </el-form>
        </div>

        <!-- 快捷键 -->
        <div v-show="activeSection === 'hotkeys'" class="section">
          <h2>快捷键</h2>
          <div v-for="group in hotkeyGroups" :key="group.scope" class="hotkey-group">
            <h3>{{ group.scope }}</h3>
            <div v-for="h in group.items" :key="h.keys" class="hotkey-row">
              <span class="hotkey-label">{{ h.label }}</span>
              <el-tag class="hotkey-keys" size="small">{{ h.keys }}</el-tag>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Setting, VideoCamera, Service, Microphone, Brush, Check, Folder, Key, MagicStick
} from '@element-plus/icons-vue'
import type { WorkflowMeta, WorkflowParam } from '../../../shared/ipcTypes'

const activeSection = ref('general')
const saving = ref(false)
const comfyuiConnected = ref(false)
const workflows = ref<WorkflowMeta[]>([])

// 工作流参数配置对话框
const paramsDialog = reactive({
  visible: false,
  workflowName: '',
  loading: false,
  params: [] as WorkflowParam[]
})

// 按节点分组参数
const paramsGroups = computed(() => {
  const map = new Map<string, { nodeId: string; nodeTitle: string; classType: string; params: WorkflowParam[] }>()
  for (const p of paramsDialog.params) {
    if (!map.has(p.nodeId)) {
      map.set(p.nodeId, { nodeId: p.nodeId, nodeTitle: p.nodeTitle, classType: p.classType, params: [] })
    }
    map.get(p.nodeId)!.params.push(p)
  }
  return [...map.values()]
})

const navItems = [
  { key: 'general', label: '通用', icon: Setting },
  { key: 'render', label: '渲染', icon: VideoCamera },
  { key: 'workflow', label: '工作流', icon: Folder },
  { key: 'comfyui', label: 'ComfyUI', icon: Service },
  { key: 'tts', label: 'TTS 语音', icon: Microphone },
  { key: 'llm', label: 'LLM', icon: MagicStick },
  { key: 'appearance', label: '外观', icon: Brush },
  { key: 'hotkeys', label: '快捷键', icon: Key }
]

// 快捷键说明（与各视图 useHotkeys 注册保持一致）
const hotkeyGroups = [
  {
    scope: '全局',
    items: [
      { keys: 'Alt + 1~5', label: '切换页面（项目列表 / 分镜编辑 / 角色库 / 渲染队列 / 成片预览）' },
      { keys: 'Ctrl + ,', label: '打开设置' }
    ]
  },
  {
    scope: '项目列表',
    items: [{ keys: 'Ctrl + N', label: '新建项目' }]
  },
  {
    scope: '分镜编辑',
    items: [{ keys: 'Ctrl + N', label: '新建分镜（渲染中不可用）' }]
  },
  {
    scope: '渲染队列',
    items: [{ keys: 'F5', label: '刷新队列状态' }]
  }
]

const settings = reactive({
  general: {
    dataDir: '',
    autoSave: true
  },
  render: {
    defaultWidth: 720,
    defaultHeight: 480,
    defaultFrames: 81,
    timeout: 600,
    lipSync: true,
    lipSyncMode: 'auto' as 'auto' | 'latentsync' | 'h3-native',
    oomRetry: true,
    consistencyMode: 'warn' as 'off' | 'warn' | 'rerender',
    resolutionTier: 'auto' as 'auto' | 'low' | 'mid' | 'standard' | 'high' | 'ultra'
  },
  comfyui: {
    baseUrl: 'http://127.0.0.1:8188',
    workflowDir: ''
  },
  tts: {
    defaultVoice: 'zh-CN-XiaoxiaoNeural',
    rate: 100,
    volume: 100
  },
  workflow: {
    default: 'wan22_i2v'
  },
  llm: {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat'
  },
  appearance: {
    theme: 'dark'
  }
})

// LLM 连接测试
const llmTesting = ref(false)
const llmStatus = ref<{ type: 'success' | 'danger' | 'info'; text: string }>({ type: 'info', text: '未测试' })

async function testLLM() {
  llmTesting.value = true
  try {
    // 先保存再测试，确保主进程拿到最新 Key
    await window.api.settings.save(JSON.parse(JSON.stringify(settings)))
    const model = await window.api.llm.test()
    llmStatus.value = { type: 'success', text: `已连接（${model}）` }
  } catch (e) {
    llmStatus.value = { type: 'danger', text: `连接失败：${(e as Error).message}` }
  } finally {
    llmTesting.value = false
  }
}

onMounted(async () => {
  await loadSettings()
  await testComfyUI()
  await loadWorkflows()
})

async function loadWorkflows() {
  try {
    workflows.value = await window.api.workflow.list()
  } catch {
    workflows.value = []
  }
}

async function importWorkflow() {
  try {
    const filePath = await window.api.dialog.selectFile()
    if (!filePath) return
    const name = await window.api.workflow.import(filePath)
    ElMessage.success(`已导入工作流：${name}`)
    await loadWorkflows()
    // 若当前默认工作流为空，自动设为新导入的
    if (!settings.workflow.default) {
      settings.workflow.default = name
    }
  } catch (e) {
    ElMessage.error((e as Error).message || '导入失败')
  }
}

// 打开工作流参数配置对话框
async function openParamsDialog(workflowName: string) {
  paramsDialog.workflowName = workflowName
  paramsDialog.visible = true
  paramsDialog.loading = true
  paramsDialog.params = []
  try {
    paramsDialog.params = await window.api.workflow.getParams(workflowName)
  } catch (e) {
    ElMessage.error((e as Error).message || '加载参数失败')
  } finally {
    paramsDialog.loading = false
  }
}

// 保存单个参数修改
async function saveParam(param: WorkflowParam) {
  try {
    await window.api.workflow.updateParam(paramsDialog.workflowName, param.nodeId, param.key, param.value)
    // 同步更新本地列表中的值
    const idx = paramsDialog.params.findIndex(p => p.nodeId === param.nodeId && p.key === param.key)
    if (idx !== -1) paramsDialog.params[idx].value = param.value
    ElMessage.success('已保存')
  } catch (e) {
    ElMessage.error((e as Error).message || '保存失败')
    // 重新加载恢复正确值
    await openParamsDialog(paramsDialog.workflowName)
  }
}

async function loadSettings() {
  try {
    const saved = await window.api.settings.get()
    if (saved) Object.assign(settings, saved)
  } catch {
    // 使用默认
  }
}

async function saveSettings() {
  saving.value = true
  try {
    await window.api.settings.save(JSON.parse(JSON.stringify(settings)))
    // 即时应用主题
    document.documentElement.classList.toggle('theme-light', settings.appearance.theme === 'light')
    ElMessage.success('保存成功')
  } catch (e) {
    ElMessage.error('保存失败')
  } finally {
    saving.value = false
  }
}

async function selectDataDir() {
  const dir = await window.api.dialog.selectDirectory()
  if (dir) settings.general.dataDir = dir
}

async function selectWorkflowDir() {
  const dir = await window.api.dialog.selectDirectory()
  if (dir) settings.comfyui.workflowDir = dir
}

async function testComfyUI() {
  comfyuiConnected.value = await window.api.comfyui.healthCheck()
}
</script>

<style scoped>
.settings-view { padding: 20px; height: 100%; display: flex; flex-direction: column; }
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
.header h1 { font-size: 24px; color: var(--text-primary); }

.settings-body { display: flex; flex: 1; gap: 20px; overflow: hidden; }
.settings-nav { width: 180px; background: var(--bg-card); border-radius: 8px; padding: 8px; }
.nav-item {
  display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  border-radius: 6px; cursor: pointer; color: var(--text-secondary); font-size: 14px;
}
.nav-item:hover { background: var(--bg-input); color: var(--text-primary); }
.nav-item.active { background: #409eff; color: #fff; }

.settings-content { flex: 1; background: var(--bg-card); border-radius: 8px; padding: 24px; overflow-y: auto; }
.section h2 { color: var(--text-primary); font-size: 18px; margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }

.path-input { display: flex; gap: 8px; }
.path-input .el-input { flex: 1; }

.form-tip { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
.workflow-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px 16px;
  margin-bottom: 10px;
}
.workflow-name { font-size: 14px; color: var(--text-primary); font-weight: 600; margin-bottom: 6px; }
.workflow-tags { display: flex; gap: 6px; margin-bottom: 6px; }
.workflow-ph { font-size: 12px; color: var(--text-secondary); font-family: monospace; }
.workflow-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.empty-tip { color: var(--text-muted); font-size: 13px; padding: 16px; }

/* 快捷键说明 */
.hotkey-group { margin-bottom: 20px; }
.hotkey-group h3 { font-size: 14px; color: var(--text-secondary); margin-bottom: 10px; }
.hotkey-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 6px 0;
}
.hotkey-label { font-size: 13px; color: var(--text-primary); flex: 1; }
.hotkey-keys { font-family: monospace; min-width: 90px; text-align: center; }

/* 工作流参数配置对话框 */
.params-scroll { max-height: 65vh; overflow-y: auto; padding-right: 6px; }
.param-node-group {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-bottom: 12px;
  padding: 10px 14px;
}
.param-node-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 13px;
  color: var(--text-primary);
  font-weight: 600;
}
.param-node-id { font-size: 11px; color: var(--text-muted); font-weight: 400; }
.param-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
}
.param-key {
  width: 130px;
  font-size: 12px;
  color: var(--text-secondary);
  flex-shrink: 0;
}
.param-input { flex: 1; max-width: 280px; }

:deep(.el-form-item__label) { color: var(--text-secondary); }
</style>
