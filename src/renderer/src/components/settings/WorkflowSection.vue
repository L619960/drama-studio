<template>
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
      <el-form-item label="按阶段覆盖">
        <div class="stage-grid">
          <div v-for="stage in STAGES" :key="stage.key" class="stage-row">
            <span class="stage-label">{{ stage.label }}</span>
            <el-select
              v-model="settings.workflow[stage.key]"
              clearable
              placeholder="内置默认"
              style="width: 240px"
            >
              <el-option
                v-for="w in workflows"
                :key="w.name"
                :label="w.name"
                :value="w.name"
              />
            </el-select>
          </div>
        </div>
        <span class="form-tip">留空=用内置默认图片工作流（定妆/场景板/首尾帧是 t2i/i2i，不是上面的视频默认工作流）</span>
      </el-form-item>
      <el-form-item label="负向词补充">
        <div class="stage-grid">
          <div v-for="stage in STAGES" :key="stage.key" class="stage-row">
            <span class="stage-label">{{ stage.label }}</span>
            <el-input
              v-model="settings.negatives[stage.key]"
              type="textarea"
              :rows="2"
              resize="none"
              placeholder="逗号分隔，例如：水印、多余手指"
              style="width: 340px"
            />
          </div>
        </div>
        <span class="form-tip">按阶段追加到内置负向词（追加而非替换，画质/时代底线始终生效）</span>
      </el-form-item>
    </el-form>

    <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 24px">
      <h3 style="color: var(--text-secondary); font-size: 14px; margin: 0">可用工作流（{{ workflows.length }}）</h3>
      <el-button size="small" :loading="importingWf" @click="importWorkflow">
        <el-icon><Folder /></el-icon>{{ importingWf ? '导入中...' : '导入工作流' }}
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
        <el-tag v-if="w.hasEndFrame" size="small" type="danger">首尾帧</el-tag>
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
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Folder } from '@element-plus/icons-vue'
import type { AppSettings, WorkflowMeta, WorkflowParam } from '../../../../shared/ipcTypes'

const props = defineProps<{
  settings: AppSettings
  activeSection: string
}>()

const workflows = ref<WorkflowMeta[]>([])
/** P2-2 / P1-4：图片生成阶段（按阶段工作流覆盖 + 负向词补充） */
const STAGES = [
  { key: 'casting', label: '定妆照' },
  { key: 'scene', label: '场景板' },
  { key: 'shot', label: '首/尾帧' },
  { key: 'prop', label: '道具' }
] as const
/** 测试连接 / 停止 ComfyUI / 导入工作流 按钮 loading（UXA-P1-05） */
const importingWf = ref(false)

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

onMounted(async () => {
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
  if (importingWf.value) return
  importingWf.value = true
  try {
    const filePath = await window.api.dialog.selectFile()
    if (!filePath) return
    const name = await window.api.workflow.import(filePath)
    ElMessage.success(`已导入工作流：${name}`)
    await loadWorkflows()
    // 若当前默认工作流为空，自动设为新导入的
    if (!props.settings.workflow.default) {
      props.settings.workflow.default = name
    }
  } catch (e) {
    ElMessage.error((e as Error).message || '导入失败')
  } finally {
    importingWf.value = false
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

/**
 * RA-15：连续调参时 toast 防抖——3 秒内多条保存合并为一条「已保存」，
 * 避免拖动 spinner 连续弹十几个成功提示。
 */
let savedToastAt = 0
let savedToastTimer: ReturnType<typeof setTimeout> | null = null
function notifySaved(): void {
  const now = Date.now()
  if (now - savedToastAt >= 3000 && !savedToastTimer) {
    savedToastAt = now
    ElMessage.success('已保存')
    return
  }
  if (savedToastTimer) return
  savedToastTimer = setTimeout(() => {
    savedToastTimer = null
    savedToastAt = Date.now()
    ElMessage.success('已保存')
  }, Math.max(0, 3000 - (now - savedToastAt)))
}

// 保存单个参数修改
async function saveParam(param: WorkflowParam) {
  try {
    await window.api.workflow.updateParam(paramsDialog.workflowName, param.nodeId, param.key, param.value)
    // 同步更新本地列表中的值
    const idx = paramsDialog.params.findIndex(p => p.nodeId === param.nodeId && p.key === param.key)
    if (idx !== -1) paramsDialog.params[idx].value = param.value
    notifySaved()
  } catch (e) {
    ElMessage.error((e as Error).message || '保存失败')
    // 重新加载恢复正确值
    await openParamsDialog(paramsDialog.workflowName)
  }
}
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

.stage-grid { display: flex; flex-direction: column; gap: 8px; }
.stage-row { display: flex; align-items: flex-start; gap: 10px; }
.stage-label { width: 56px; flex-shrink: 0; font-size: 12px; color: var(--text-secondary); line-height: 32px; }

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
</style>
