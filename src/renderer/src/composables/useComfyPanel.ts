import { computed, reactive, ref, watch, type Ref } from 'vue'
import { ElMessage } from 'element-plus'
import type {
  ComfySystemStats, ComfyGpuDevice,
  WorkflowMeta, WorkflowParam, WorkflowCheckReport
} from '../../../shared/ipcTypes'

/**
 * ComfyUI 控制面板：服务/GPU/节点/工作流自检/参数编辑。
 * 首次切到 ComfyUI 面板时懒加载（object_info 体量大，避免启动时拖慢）。
 *
 * @param activeModule 当前激活模块名（壳视图的 ref），切到 'comfyui' 触发懒加载
 */

// ===== 纯工具函数（R-13：模块级导出，ComfyPanel 与 composable 共用，不再双份实现）=====

export function gb(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(1)
}
/** ComfyUI 0.3x 的 devices[].name 形如 "cuda:0 NVIDIA GeForce RTX x : cudaMallocAsync"，清洗成型号 */
export function gpuLabel(d: ComfyGpuDevice): string {
  const cleaned = (d.name || '')
    .replace(/^cuda:\d+\s*/i, '')
    .replace(/\s*:\s*cudaMalloc\w*\s*$/i, '')
    .trim()
  return cleaned || d.type || d.name
}
export function vramPercent(d: ComfyGpuDevice): number {
  if (!d.vramTotal) return 0
  return Math.min(100, Math.round(((d.vramTotal - d.vramFree) / d.vramTotal) * 100))
}
export function canEditParam(p: WorkflowParam): boolean {
  return !p.isPlaceholder && !p.isConnection
}

export function useComfyPanel(activeModule: Ref<string>) {
  const comfyStats = ref<ComfySystemStats | null>(null)
  const nodeNames = ref<string[]>([])
  const nodeQuery = ref('')
  const comfyLoading = ref(false)
  const comfyLoaded = ref(false)
  const workflows = ref<WorkflowMeta[]>([])
  const workflowParams = reactive<Record<string, WorkflowParam[]>>({})
  const expandedWorkflows = ref<string[]>([])

  const matchedNodes = computed(() => {
    const q = nodeQuery.value.trim().toLowerCase()
    if (!q) return []
    return nodeNames.value.filter(n => n.toLowerCase().includes(q))
  })

  // 工作流环境自检
  const validateReports = ref<WorkflowCheckReport[]>([])
  const validateLoading = ref(false)
  const validateRun = ref(false)
  const validateBadCount = computed(() =>
    validateReports.value.reduce((n, r) => n + r.issues.length, 0)
  )

  // F：models 目录解析结果（设置项 > ComfyUI input 同级），缺模型时引导用户打开目录放文件
  const modelsDir = ref<string | null>(null)

  async function openModelsDir(): Promise<void> {
    if (!modelsDir.value) {
      ElMessage.warning('未能定位 models 目录，请先在 设置 → ComfyUI 中配置')
      return
    }
    try {
      await window.api.shell.openPath(modelsDir.value)
    } catch (e) {
      ElMessage.error(`打开目录失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function runValidate(): Promise<void> {
    validateLoading.value = true
    try {
      validateReports.value = await window.api.comfyui.validateWorkflows()
      validateRun.value = true
    } catch (e) {
      ElMessage.error(`自检失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      validateLoading.value = false
    }
  }

  async function refreshComfy(): Promise<void> {
    comfyLoading.value = true
    try {
      const [stats, nodes, dir] = await Promise.all([
        window.api.comfyui.getSystemStats(),
        window.api.comfyui.getObjectNodeNames(),
        window.api.comfyui.getModelsDir().catch(() => null)
      ])
      comfyStats.value = stats
      nodeNames.value = nodes
      modelsDir.value = dir
      comfyLoaded.value = true
      // C-04：离线时主进程静默返回 null/[]，主动告知而非"刷新没反应"
      if (!stats) ElMessage.warning('ComfyUI 未连接，无法获取实时状态')
    } catch (e) {
      // R-11：失败给用户可理解的提示，而非空数据无解释
      ElMessage.error(`ComfyUI 状态加载失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      comfyLoading.value = false
    }
  }

  async function loadWorkflows(): Promise<void> {
    // R-11：自兜底 catch，与 runValidate/refreshComfy 对齐
    try {
      workflows.value = await window.api.workflow.list()
    } catch (e) {
      ElMessage.error(`工作流列表加载失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function onWfExpand(active: string | string[]): Promise<void> {
    const arr = Array.isArray(active) ? active : [active]
    for (const name of arr) {
      if (!workflowParams[name]) {
        try {
          workflowParams[name] = await window.api.workflow.getParams(name)
        } catch (e) {
          ElMessage.error(`参数加载失败：${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
  }

  async function updateWfParam(name: string, p: WorkflowParam, value: string | number | boolean): Promise<void> {
    try {
      await window.api.workflow.updateParam(name, p.nodeId, p.key, value)
      p.value = value
      ElMessage.success('参数已保存到工作流模板')
    } catch (e) {
      ElMessage.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 首次切到 ComfyUI 面板时懒加载
  watch(activeModule, async (m) => {
    if (m === 'comfyui' && !comfyLoaded.value) {
      await Promise.all([refreshComfy(), loadWorkflows()])
    }
  })

  return {
    comfyStats, nodeNames, nodeQuery, comfyLoading, comfyLoaded,
    workflows, workflowParams, expandedWorkflows,
    matchedNodes,
    validateReports, validateLoading, validateRun, validateBadCount,
    modelsDir, openModelsDir,
    runValidate,
    refreshComfy, loadWorkflows, onWfExpand, updateWfParam
  }
}
