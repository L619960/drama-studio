<template>
  <div class="panel panel-fill comfy-panel">
    <div class="panel-title skills-title">
      ComfyUI 完全控制
      <el-button size="small" :icon="Refresh" :loading="comfyLoading" @click="emit('refresh')">刷新</el-button>
    </div>

    <div class="comfy-cards">
      <!-- 服务状态 -->
      <div class="comfy-card">
        <div class="comfy-card-title">服务状态</div>
        <div v-if="comfyStats" class="comfy-card-body">
          <div class="kv"><span class="k">连接</span>
            <span class="v"><el-tag size="small" type="success" effect="dark">在线</el-tag></span>
          </div>
          <div class="kv"><span class="k">版本</span><span class="v">ComfyUI {{ comfyStats.version || '未知' }}</span></div>
          <div class="kv"><span class="k">Python</span><span class="v">{{ comfyStats.pythonVersion || '未知' }}</span></div>
          <div class="kv"><span class="k">节点类</span><span class="v">{{ nodeNames.length }} 个已安装</span></div>
        </div>
        <div v-else class="comfy-offline">
          <el-tag size="small" type="danger" effect="dark">无法连接</el-tag>
          <span class="muted">请确认 ComfyUI 已启动（默认 http://127.0.0.1:8188）</span>
        </div>
      </div>

      <!-- GPU / 显存 -->
      <div class="comfy-card">
        <div class="comfy-card-title">GPU 与显存</div>
        <div v-if="comfyStats?.devices.length" class="comfy-card-body">
          <div v-for="(d, i) in comfyStats.devices" :key="i" class="gpu-block">
            <div class="gpu-name">{{ gpuLabel(d) }}</div>
            <el-progress
              :percentage="vramPercent(d)"
              :stroke-width="12"
              :status="vramPercent(d) > 90 ? 'exception' : undefined"
            />
            <div class="gpu-vram">{{ gb(d.vramTotal - d.vramFree) }} / {{ gb(d.vramTotal) }} GB 已用 · 剩余 {{ gb(d.vramFree) }} GB</div>
          </div>
        </div>
        <div v-else class="muted comfy-card-body">{{ comfyStats ? '未返回设备信息' : '离线状态下无数据' }}</div>
      </div>
    </div>

    <!-- 节点探测 -->
    <div class="comfy-card">
      <div class="comfy-card-title">节点健康探测</div>
      <el-input
        :model-value="nodeQuery"
        @update:model-value="onQueryChange"
        size="small"
        placeholder="输入节点类名关键字，如 Wan / LatentSync / VAE"
        clearable
        class="node-search"
      />
      <div v-if="nodeQuery && nodeNames.length" class="node-matches">
        <el-tag
          v-for="n in matchedNodes.slice(0, 30)"
          :key="n"
          size="small"
          :type="n.toLowerCase() === nodeQuery.trim().toLowerCase() ? 'success' : 'info'"
          effect="plain"
          class="node-tag"
        >{{ n }}</el-tag>
        <div v-if="!matchedNodes.length" class="muted">没有匹配的已安装节点（可能缺自定义节点包）</div>
        <div v-if="matchedNodes.length > 30" class="muted">…仅显示前 30 个（共 {{ matchedNodes.length }} 个匹配）</div>
      </div>
    </div>

    <!-- 工作流环境自检 -->
    <div class="comfy-card">
      <div class="comfy-card-title">
        工作流环境自检
        <el-button size="small" type="primary" plain :loading="validateLoading" @click="emit('runValidate')">
          {{ validateRun ? '重新自检' : '开始自检' }}
        </el-button>
      </div>
      <div v-if="!validateRun" class="muted">
        检查全部工作流模板需要的自定义节点与模型文件是否齐全（渲染前也会自动拦截缺失项）
      </div>
      <template v-else>
        <el-alert
          v-if="validateBadCount === 0"
          type="success"
          :closable="false"
          title="全部工作流环境就绪，未发现缺失节点或模型"
          style="margin-bottom: 10px"
        />
        <el-alert
          v-else
          type="error"
          :closable="false"
          :title="`发现 ${validateBadCount} 个问题（将在渲染时被拦截）`"
          style="margin-bottom: 10px"
        />
        <div v-if="validateBadCount > 0" class="models-dir-row">
          <el-button size="small" type="primary" plain :disabled="!modelsDir" @click="emit('openModelsDir')">
            <el-icon><FolderOpened /></el-icon>&nbsp;打开 models 目录
          </el-button>
          <el-button size="small" :loading="validateLoading" @click="emit('runValidate')">重新自检</el-button>
          <span class="muted models-dir-hint">
            {{ modelsDir ? `把缺失模型放入：${modelsDir}` : '未定位到 models 目录，可在 设置 → ComfyUI 中手动配置' }}
          </span>
        </div>
        <div v-for="r in validateReports.filter(x => !x.ok)" :key="r.workflow" class="validate-block">
          <div class="validate-wf">{{ r.workflow }}</div>
          <div v-for="(iss, i) in r.issues" :key="i" class="validate-issue">
            <el-tag size="small" :type="iss.kind === 'missing-node' ? 'danger' : 'warning'" effect="dark">
              {{ iss.kind === 'missing-node' ? '缺节点' : '缺模型' }}
            </el-tag>
            <span>{{ iss.message }}</span>
          </div>
        </div>
      </template>
    </div>

    <!-- 工作流模板 -->
    <div class="comfy-card">
      <div class="comfy-card-title">工作流模板与参数</div>
      <el-collapse
        :model-value="expandedWorkflows"
        @update:model-value="onWfExpand"
        class="wf-collapse"
      >
        <el-collapse-item v-for="w in workflows" :key="w.name" :name="w.name">
          <template #title>
            <span class="wf-name">{{ w.name }}</span>
            <el-tag size="small" type="success" effect="plain" v-if="w.hasImageInput">图生视频</el-tag>
            <el-tag size="small" type="primary" effect="plain" v-else>纯文生</el-tag>
            <el-tag size="small" type="warning" effect="plain" v-if="w.hasDuration">时长参数</el-tag>
            <el-tag size="small" type="danger" effect="plain" v-if="w.hasEndFrame">首尾帧</el-tag>
          </template>
          <div class="wf-params">
            <div v-for="p in workflowParams[w.name] || []" :key="`${p.nodeId}.${p.key}`" class="wf-param">
              <div class="wf-param-label">
                <span class="wf-param-title">{{ p.nodeTitle }} · {{ p.key }}</span>
                <span class="wf-param-class">{{ p.classType }}</span>
              </div>
              <div class="wf-param-input">
                <el-switch
                  v-if="p.type === 'boolean' && canEditParam(p)"
                  :model-value="Boolean(p.value)"
                  @change="(v: boolean) => emit('updateParam', w.name, p, v)"
                />
                <el-input-number
                  v-else-if="p.type === 'number' && canEditParam(p)"
                  :model-value="Number(p.value)"
                  size="small"
                  controls-position="right"
                  @change="(v?: number) => emit('updateParam', w.name, p, v ?? 0)"
                />
                <el-input
                  v-else-if="canEditParam(p)"
                  :model-value="String(p.value)"
                  size="small"
                  @change="(v: string) => emit('updateParam', w.name, p, v)"
                />
                <el-tag v-else size="small" type="info" effect="plain">
                  {{ p.isConnection ? '节点连接' : '占位符（运行时注入）' }}
                </el-tag>
              </div>
            </div>
          </div>
        </el-collapse-item>
      </el-collapse>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Refresh, FolderOpened } from '@element-plus/icons-vue'
import type {
  ComfySystemStats,
  WorkflowMeta, WorkflowParam, WorkflowCheckReport
} from '../../../../shared/ipcTypes'
// R-13：gb/gpuLabel/vramPercent/canEditParam 唯一实现在 useComfyPanel，不再本地重复
import { gb, gpuLabel, vramPercent, canEditParam } from '../../composables/useComfyPanel'

const props = defineProps<{
  comfyStats: ComfySystemStats | null
  nodeNames: string[]
  nodeQuery: string
  matchedNodes: string[]
  comfyLoading: boolean
  workflows: WorkflowMeta[]
  workflowParams: Record<string, WorkflowParam[]>
  expandedWorkflows: string[]
  validateReports: WorkflowCheckReport[]
  validateLoading: boolean
  validateRun: boolean
  validateBadCount: number
  modelsDir: string | null
}>()

const emit = defineEmits<{
  refresh: []
  wfExpand: [active: string | string[]]
  updateParam: [name: string, p: WorkflowParam, value: string | number | boolean]
  runValidate: []
  openModelsDir: []
  'update:nodeQuery': [v: string]
}>()

function onQueryChange(val: string): void {
  emit('update:nodeQuery', val)
}
function onWfExpand(active: string | string[]): void {
  emit('wfExpand', active)
}
</script>

<style scoped>
.panel {
  background: var(--bg-card);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  padding: 14px 16px;
}
.panel-fill {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}
.panel-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 10px;
  display: flex;
  align-items: center;
}

.comfy-panel { gap: 12px; }
.comfy-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.comfy-card {
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  padding: 12px 14px;
  background: var(--bg-app, transparent);
}
.comfy-panel > .comfy-card { margin-top: 0; }
.comfy-card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 10px;
}
.comfy-card-body { display: flex; flex-direction: column; gap: 8px; }
.comfy-card-body .kv { margin-bottom: 0; font-size: 12px; }
.kv { display: flex; justify-content: space-between; margin-bottom: 6px; color: var(--text-secondary); }
.kv .v { color: var(--text-primary); display: flex; align-items: center; gap: 6px; }
.comfy-offline { display: flex; align-items: center; gap: 10px; }
.muted { color: var(--text-muted); font-size: 12px; }
.gpu-block + .gpu-block { margin-top: 12px; }
.gpu-name { font-size: 12px; color: var(--text-secondary); margin-bottom: 6px; }
.gpu-vram { font-size: 11px; color: var(--text-muted); margin-top: 5px; font-variant-numeric: tabular-nums; }
.node-search { margin-bottom: 10px; }
.node-matches { display: flex; flex-wrap: wrap; gap: 6px; max-height: 180px; overflow-y: auto; }
.node-tag { font-family: monospace; }
.validate-block { margin-bottom: 10px; padding: 8px 10px; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; background: rgba(255,255,255,0.03); }
.validate-wf { font-weight: 600; margin-bottom: 6px; font-family: monospace; }
.validate-issue { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 1.7; color: rgba(255,255,255,0.75); }
.models-dir-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.models-dir-hint { word-break: break-all; }

.skills-title { justify-content: space-between; }

.wf-collapse {
  --el-collapse-border-color: var(--border-weak);
  --el-collapse-header-bg-color: transparent;
  --el-collapse-content-bg-color: transparent;
  --el-collapse-header-text-color: var(--text-primary);
}
.wf-name { font-size: 13px; font-weight: 500; margin-right: 8px; }
.wf-params { display: flex; flex-direction: column; gap: 8px; padding: 4px 0; }
.wf-param {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--bg-input);
}
.wf-param-label { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.wf-param-title { font-size: 12px; color: var(--text-primary); }
.wf-param-class { font-size: 11px; color: var(--text-muted); font-family: monospace; }
.wf-param-input { flex-shrink: 0; }
.wf-param-input .el-input-number { width: 150px; }
.wf-param-input .el-input { width: 200px; }
</style>
