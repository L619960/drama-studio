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

  function gb(bytes: number): string {
    return (bytes / 1024 / 1024 / 1024).toFixed(1)
  }
  /** ComfyUI 0.3x 的 devices[].name 形如 "cuda:0 NVIDIA GeForce RTX x : cudaMallocAsync"，清洗成型号 */
  function gpuLabel(d: ComfyGpuDevice): string {
    const cleaned = (d.name || '')
      .replace(/^cuda:\d+\s*/i, '')
      .replace(/\s*:\s*cudaMalloc\w*\s*$/i, '')
      .trim()
    return cleaned || d.type || d.name
  }
  function vramPercent(d: ComfyGpuDevice): number {
    if (!d.vramTotal) return 0
    return Math.min(100, Math.round(((d.vramTotal - d.vramFree) / d.vramTotal) * 100))
  }
  function canEditParam(p: WorkflowParam): boolean {
    return !p.isPlaceholder && !p.isConnection
  }

  async function refreshComfy(): Promise<void> {
    comfyLoading.value = true
    try {
      const [stats, nodes] = await Promise.all([
        window.api.comfyui.getSystemStats(),
        window.api.comfyui.getObjectNodeNames()
      ])
      comfyStats.value = stats
      nodeNames.value = nodes
      comfyLoaded.value = true
    } finally {
      comfyLoading.value = false
    }
  }

  async function loadWorkflows(): Promise<void> {
    workflows.value = await window.api.workflow.list()
  }

  async function onWfExpand(active: string | string[]): Promise<void> {
    const arr = Array.isArray(active) ? active : [active]
    for (const name of arr) {
      if (!workflowParams[name]) {
        workflowParams[name] = await window.api.workflow.getParams(name)
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
    runValidate,
    gb, gpuLabel, vramPercent, canEditParam,
    refreshComfy, loadWorkflows, onWfExpand, updateWfParam
  }
}
