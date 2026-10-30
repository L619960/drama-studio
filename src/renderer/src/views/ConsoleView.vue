<template>
  <div class="console-shell">
    <!-- REQ-07 / RC-02：会话域面包屑，任何控制台界面都能确认「指令落到哪个会话」 -->
    <div class="console-crumb glass-panel">
      <el-icon><ChatDotRound /></el-icon>
      <span class="crumb-domain">{{ domainLabel }}</span>
      <template v-if="!projectId && suggestProject">
        <span class="crumb-suggest">你在《{{ suggestProject.title }}》项目中，要不要切到项目对话？</span>
        <el-button link type="primary" size="small" @click="switchToProjectChat">切到项目对话</el-button>
      </template>
    </div>

    <div class="console page">
    <!-- ===== 左栏：模块导航 + 项目概览 ===== -->
    <aside class="console-aside glass-panel">
      <div class="aside-title">导演控制台</div>
      <el-menu :default-active="activeModule" class="aside-menu" @select="onModuleSelect">
        <el-menu-item index="workflow">
          <el-icon><DataLine /></el-icon><span>工作流监控</span>
        </el-menu-item>
        <el-menu-item index="skills">
          <el-icon><MagicStick /></el-icon><span>技能管理</span>
        </el-menu-item>
        <el-menu-item index="memory">
          <el-icon><Collection /></el-icon><span>记忆库</span>
        </el-menu-item>
        <el-menu-item index="comfyui">
          <el-icon><Cpu /></el-icon><span>ComfyUI</span>
        </el-menu-item>
        <el-menu-item index="selfcheck">
          <el-icon><Odometer /></el-icon><span>系统自检</span>
          <el-tag v-if="selfBadCount" size="small" type="danger" effect="plain" class="selfcheck-badge">
            {{ selfBadCount }}
          </el-tag>
        </el-menu-item>
      </el-menu>

      <div v-if="state" class="aside-project">
        <div class="aside-subtitle">项目概览</div>
        <div class="kv"><span class="k">片名</span><span class="v">{{ state.title }}</span></div>
        <div class="kv">
          <span class="k">镜头</span>
          <span class="v">{{ state.doneShots }}/{{ state.totalShots }} 完成
            <el-tag v-if="state.failedShotIds.length" size="small" type="danger" effect="plain">
              {{ state.failedShotIds.length }} 失败
            </el-tag>
          </span>
        </div>
        <div v-if="state.reviewIssues?.length" class="review-issues">
          <div class="aside-subtitle">复审问题</div>
          <div v-for="(iss, i) in (reviewExpanded ? state.reviewIssues : state.reviewIssues.slice(0, 5))" :key="i" class="issue-item">{{ iss }}</div>
          <div v-if="state.reviewIssues.length > 5" class="review-more">
            <el-button link type="danger" size="small" @click="reviewExpanded = !reviewExpanded">
              {{ reviewExpanded ? '收起' : `查看更多（共 ${state.reviewIssues.length} 条问题）` }}
            </el-button>
          </div>
        </div>
        <div v-if="state.finalPath" class="final-path">
          <el-button size="small" @click="openFinalFolder">
            <el-icon><FolderOpened /></el-icon>&nbsp;成片所在目录
          </el-button>
        </div>
      </div>
    </aside>

    <!-- ===== 中栏：按 activeModule 切换的面板 ===== -->
    <section class="console-main glass-panel">
      <WorkflowPanel
        v-if="activeModule === 'workflow'"
        :state="state"
        :local-logs="localLogs"
        :expanded-stages="expandedStages"
        :gate-options="gateOptions"
        :running="running"
        :paused="paused"
        :start-dialog-visible="startDialogVisible"
        :starting="starting"
        :project="project"
        :asset-urls="assetUrls"
        :rerendering-shot-id="rerenderingShotId"
        @pause="onPause"
        @resume="onResume"
        @cancel="onCancel"
        @clear="onClearTask"
        @open-final-folder="openFinalFolder"
        @resume-from="onResumeFrom"
        @retry-failed="retryFailedShots"
        @retry-pending="retryPendingShots"
        @rerender-shot="onRerenderShot"
        @rerender-shots="onRerenderShots"
        @regenerate-asset="onAssetRegenerate"
        @asset-refreshed="() => loadProjectData(project?.id)"
        @update:expanded-stages="val => expandedStages = val"
        @update:start-dialog-visible="val => startDialogVisible = val"
        @start="confirmStart"
      />
      <SkillsPanel
        v-else-if="activeModule === 'skills'"
        :skills="skills"
        :skill-dialog="skillDialog"
        :editing-skill="editingSkill"
        :skill-saving="skillSaving"
        @toggle="toggleSkill"
        @remove="removeSkill"
        @open-dialog="openSkillDialog"
        @save-dialog="saveSkill"
        @close-dialog="closeSkillDialog"
      />
      <MemoryPanel
        v-else-if="activeModule === 'memory'"
        :memories="memories"
        :memory-kind="memoryKind"
        :memory-kind-options="memoryKindOptions"
        :memory-dialog="memoryDialog"
        :editing-memory="editingMemory"
        :memory-saving="memorySaving"
        @update:memory-kind="val => memoryKind = val"
        @remove="removeMemory"
        @open-dialog="openMemoryDialog"
        @save-dialog="saveMemory"
        @close-dialog="closeMemoryDialog"
      />
      <ComfyPanel
        v-else-if="activeModule === 'comfyui'"
        :comfy-stats="comfyStats"
        :node-names="nodeNames"
        :node-query="nodeQuery"
        :matched-nodes="matchedNodes"
        :comfy-loading="comfyLoading"
        :workflows="workflows"
        :workflow-params="workflowParams"
        :expanded-workflows="expandedWorkflows"
        :validate-reports="validateReports"
        :validate-loading="validateLoading"
        :validate-run="validateRun"
        :validate-bad-count="validateBadCount"
        :models-dir="modelsDir"
        @refresh="refreshComfy"
        @wf-expand="onWfExpand"
        @update-param="updateWfParam"
        @run-validate="runValidate"
        @open-models-dir="openModelsDir"
        @update:node-query="val => nodeQuery = val"
      />
      <SelfCheckPanel
        v-else-if="activeModule === 'selfcheck'"
        :items="selfItems"
        :loading="selfLoading"
        @rerun="runSelfcheck"
      />
    </section>

    <!-- ===== 右栏：导演真实对话 ===== -->
    <aside class="console-right glass-panel">
      <DirectorChat
        :messages="messages"
        :input-text="inputText"
        :sending="sending"
        :expanded-tools="expandedTools"
        :quick-prompts="quickPrompts"
        :scroll-tick="scrollTick"
        :render-md="renderMd"
        :task-running="running"
        :task-paused="paused"
        @toggle-tool="toggleTool"
        @use-quick="useQuick"
        @copy-msg="copyMsg"
        @resend-msg="resendMsg"
        @rollback-msg="rollbackMsg"
        @regenerate="regenerateMsg"
        @send="sendMessage()"
        @stop="stopSend"
        @upload="uploadAndSend"
        @self-learn="selfLearn"
        @clear="clearChatGuarded"
        @cancel-task="onCancel"
        @update:input-text="val => inputText = val"
      />
    </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { DataLine, MagicStick, Collection, Cpu, FolderOpened, Odometer, ChatDotRound } from '@element-plus/icons-vue'
import type { DirectorStage, Project, SelfCheckItem, AssetRegenerateInput } from '../../../shared/ipcTypes'
import { useDirectorState } from '../composables/useDirectorState'
import { useDirectorChat } from '../composables/useDirectorChat'
import { useSkillsManager } from '../composables/useSkillsManager'
import { useMemoryManager } from '../composables/useMemoryManager'
import { useComfyPanel } from '../composables/useComfyPanel'
import { useFileUrl } from '../composables/useFileUrl'
import { snapshot } from '../utils/snapshot'
import { confirmUnreviewedRender } from '../utils/renderGate'
import { readConsoleModule, saveConsoleModule } from '../utils/consoleLayout'
import { useActiveProject } from '../composables/useActiveProject'
import WorkflowPanel from '../components/console/WorkflowPanel.vue'
import SkillsPanel from '../components/console/SkillsPanel.vue'
import MemoryPanel from '../components/console/MemoryPanel.vue'
import ComfyPanel from '../components/console/ComfyPanel.vue'
import DirectorChat from '../components/console/DirectorChat.vue'
import SelfCheckPanel from '../components/console/SelfCheckPanel.vue'

const route = useRoute()
const router = useRouter()
const projectId = computed(() => route.params.id as string | undefined)
/** 对话作用域：项目内对话带项目快照；无项目时为全局对话 */
const chatScope = computed(() => projectId.value || 'global')

// REQ-07 / RC-10：中栏模块选择持久化，切页/切项目后回来仍停在原模块
const activeModule = ref<string>(readConsoleModule())

// REQ-07 / RC-02：会话域提示。全局控制台可一键切到最近项目对话，未发送内容按域保留
const { currentProjectId } = useActiveProject(route)
const suggestProject = ref<{ id: string; title: string } | null>(null)
const domainLabel = computed(() => {
  if (!projectId.value) return '全局对话'
  const title = state.value?.title || project.value?.title || '当前项目'
  return `《${title}》项目对话`
})

async function loadSuggestProject(): Promise<void> {
  const id = currentProjectId.value
  if (!id || projectId.value) { suggestProject.value = null; return }
  try {
    const p = await window.api.project.get(id)
    suggestProject.value = p ? { id: p.id, title: p.title } : null
  } catch {
    suggestProject.value = null
  }
}

function switchToProjectChat(): void {
  const p = suggestProject.value
  if (!p) return
  if (inputText.value.trim()) {
    ElMessage.info('未发送内容已按会话域保留，切回来后仍在输入框')
  }
  void router.push(`/project/${p.id}/console`)
}

// ===== 装配 5 个 composable =====
const {
  state, localLogs, expandedStages, gateOptions,
  running, paused,
  hydrate, hydrateLatest, subscribe, unsubscribeAll, resetForRouteSwitch,
  onPause, onResume, onCancel, onClearTask, openFinalFolder,
  onResumeFrom, retryFailedShots
} = useDirectorState(projectId)

const {
  messages, inputText, sending, expandedTools, scrollTick, quickPrompts,
  loadChat, toggleTool, useQuick, renderMd, copyMsg, resendMsg,
  sendMessage, stopSend, rollbackMsg, regenerateMsg, uploadAndSend, selfLearn, clearChat,
  subscribe: subscribeChat, unsubscribeAll: unsubscribeChat
} = useDirectorChat(chatScope, state)

const {
  skills, editingSkill, skillSaving, skillDialog,
  loadSkills, toggleSkill, openSkillDialog, closeSkillDialog, saveSkill, removeSkill
} = useSkillsManager()

const {
  memories, memoryKind, memoryKindOptions, memoryDialog, editingMemory, memorySaving,
  loadMemories, openMemoryDialog, closeMemoryDialog, saveMemory, removeMemory
} = useMemoryManager()

const {
  comfyStats, nodeNames, nodeQuery, comfyLoading,
  workflows, workflowParams, expandedWorkflows, matchedNodes,
  validateReports, validateLoading, validateRun, validateBadCount,
  modelsDir, openModelsDir,
  runValidate, refreshComfy, onWfExpand, updateWfParam
} = useComfyPanel(activeModule)

// ===== 项目产物数据（工作流面板实时预览用） =====
const { urlCache: assetUrls, ensureFileUrls } = useFileUrl()
const project = ref<Project | null>(null)

/** 加载项目快照并预取全部产物 URL（角色图/三视图/场景板/首尾帧/分段视频/成片） */
async function loadProjectData(pid: string | undefined): Promise<void> {
  project.value = null
  if (!pid) return
  try {
    const p = await window.api.project.get(pid)
    if (!p) return
    project.value = p
    const paths = [
      ...(p.characters || []).flatMap(c => [c.faceImagePath, c.refImagePath, c.bodySheetPath]),
      ...(p.sceneBoards || []).map(b => b.emptyPlatePath),
      ...(p.shots || []).flatMap(s => [s.firstFramePath, s.lastFramePath, s.sceneImagePath, s.rawVideoPath, s.segmentPath])
    ].filter(Boolean) as string[]
    await ensureFileUrls(paths)
  } catch {
    // 产物预览不可用时面板显示空态提示，不阻塞控制台其余功能
  }
}

/** 复审问题列表：默认折叠为 5 条，超出可展开查看全部 / 收起 */
const reviewExpanded = ref(false)

/** 渲染阶段「改提示词/工作流重渲此镜」：更新分镜并作废旧产物 → 重新入队 */
const rerenderingShotId = ref('')
type RerenderPayload = { shotId: string; prompt: string; dialogue: string; negative: string; workflow: string }
async function rerenderOneShot(payload: RerenderPayload, opts: { skipGate?: boolean } = {}): Promise<void> {
  const p = project.value
  if (!p) return
  const shot = p.shots.find(s => s.id === payload.shotId)
  if (!shot) return
  // 重渲会作废首帧审核：warn 模式下先确认，取消则不改动分镜状态
  if (!opts.skipGate && !(await confirmUnreviewedRender(p, [shot.id], {
    reason: '提示词/工作流已改动，首帧审核会作废。',
    treatAllAsUnreviewed: true
  }))) return
  // 工作台编辑的是渲染实际使用的 promptEn（留空则渲染时回退 action 模板）；
  // 不覆盖 shot.action——它还承担分镜动作/首帧 cue，避免工作台改动污染分镜数据
  shot.promptEn = payload.prompt || undefined
  shot.dialogue = payload.dialogue
  shot.negativeEn = payload.negative || undefined
  shot.workflow = payload.workflow || undefined
  shot.status = 'pending'
  shot.reviewed = undefined
  shot.error = undefined
  shot.audioPath = undefined
  shot.rawVideoPath = undefined
  shot.segmentPath = undefined
  shot.renderProfile = undefined
  shot.consistencyScore = undefined
  await window.api.project.save(snapshot(p))
  const res = await window.api.render.start(p.id, [shot.id], false)
  if (res.warnedShots.length > 0) {
    ElMessage.warning(`第 ${shot.index} 镜已按「告警放行」重新入队渲染（内容已改，渲染前建议先核对分镜图）`)
  }
}
async function onRerenderShot(payload: RerenderPayload): Promise<void> {
  if (rerenderingShotId.value) return
  rerenderingShotId.value = payload.shotId
  try {
    await rerenderOneShot(payload)
    ElMessage.success(`第 ${payload.shotId} 镜已重新入队渲染`)
  } catch (e) {
    ElMessage.error(`重渲失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    rerenderingShotId.value = ''
  }
}
/** 批量重渲：逐镜串行入队（render.start 内部已有队列/去重） */
async function onRerenderShots(payloads: RerenderPayload[]): Promise<void> {
  if (rerenderingShotId.value) return
  if (project.value && !(await confirmUnreviewedRender(project.value, payloads.map(pl => pl.shotId), {
    reason: '提示词/工作流已改动，首帧审核会作废。',
    treatAllAsUnreviewed: true
  }))) return
  rerenderingShotId.value = payloads[0]?.shotId || 'batch'
  try {
    for (const pl of payloads) {
      try { await rerenderOneShot(pl, { skipGate: true }) } catch (e) { ElMessage.error(`镜 ${pl.shotId} 重渲失败：${e instanceof Error ? e.message : String(e)}`) }
    }
    ElMessage.success(`${payloads.length} 镜已重新入队渲染`)
  } finally {
    rerenderingShotId.value = ''
  }
}

/** 工作台产物「编辑提示词/工作流后重新生成」：主进程落盘新产物 → 刷新快照与预览 URL */
async function onAssetRegenerate(payload: AssetRegenerateInput): Promise<void> {
  const p = project.value
  if (!p) return
  try {
    const r = await window.api.asset.regenerate(payload)
    ElMessage.success('产物已重新生成')
    await loadProjectData(p.id)
    if (r?.path) await ensureFileUrls([r.path])
  } catch (e) {
    ElMessage.error(`重新生成失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

// ===== 开拍弹窗（壳持有：confirmStart 需要路由切换 + hydrate） =====
const startDialogVisible = ref(false)
const starting = ref(false)

async function confirmStart(input: {
  title: string; genre: string; script: string; gateStages?: DirectorStage[]; bgmAbsolutePath?: string
}): Promise<void> {
  starting.value = true
  try {
    const newId = await window.api.director.start(input)
    startDialogVisible.value = false
    localLogs.value = []
    ElMessage.success('任务已启动')
    if (!projectId.value || projectId.value !== newId) {
      router.replace(`/project/${newId}/console`)
    } else {
      await hydrate(newId)
    }
  } catch (e) {
    ElMessage.error(`启动失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    starting.value = false
  }
}

/** 续渲全部待渲染镜头（残留任务提示的入口）：入队后由影子任务同步进度 */
async function retryPendingShots(): Promise<void> {
  const p = project.value
  if (!p) return
  const pendingIds = p.shots.filter(s => s.status === 'pending').map(s => s.id)
  if (!pendingIds.length) return
  try {
    await window.api.render.start(p.id, pendingIds, false)
    ElMessage.success(`已重新入队 ${pendingIds.length} 个待渲染镜头，进度在下方实时更新`)
  } catch (e) {
    ElMessage.error(`续渲失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

// ===== 系统自检：启动即跑一次，异常数显示在侧栏徽标 =====
const selfItems = ref<SelfCheckItem[]>([])
const selfLoading = ref(false)
const selfBadCount = computed(() => selfItems.value.filter(i => !i.ok).length)

async function runSelfcheck(): Promise<void> {
  if (selfLoading.value) return
  selfLoading.value = true
  try {
    selfItems.value = await window.api.system.selfcheck()
    if (selfItems.value.some(i => !i.ok)) {
      ElMessage.warning('系统自检发现异常项，请查看「系统自检」面板')
    }
  } catch (e) {
    ElMessage.error(`自检失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    selfLoading.value = false
  }
}

// ===== 生命周期：装配订阅与并行加载 =====
onMounted(async () => {
  // R-8：先建立订阅再异步加载——hydrate 期间主进程发出的 progress/log 不再丢失；
  // 各加载步骤独立 catch（loadSkills/loadMemories/loadChat 自兜底），任一失败不连坐其余初始化。
  // 冷启动优化（UXA-P2-03）：hydrate 与 loadSkills/loadMemories/loadChat 互相独立，
  // 改为并行 await，缩短首次进入控制台的阻塞时间（此前串行总耗时 ≈ 三者相加）。
  subscribe()
  subscribeChat()
  const hydrateTask = (async () => {
    try {
      if (projectId.value) await hydrate(projectId.value)
      else await hydrateLatest()
    } catch (e) {
      ElMessage.error(`加载导演状态失败：${e instanceof Error ? e.message : String(e)}`)
    }
  })()
  await Promise.all([hydrateTask, loadSkills(), loadMemories(), loadChat()])
  void loadProjectData(projectId.value)
  void loadSuggestProject()
  void runSelfcheck()
})

onUnmounted(() => {
  unsubscribeAll()
  unsubscribeChat()
})

// 路由项目切换：同一组件复用时重新装载
watch(projectId, async (id, old) => {
  if (id === old) return
  // R-9：加载失败不再产生 unhandled rejection，且后续 loadChat 不被连坐跳过
  resetForRouteSwitch()
  const hydrateTask = (async () => {
    try {
      if (id) await hydrate(id)
      else await hydrateLatest()
    } catch (e) {
      ElMessage.error(`加载项目状态失败：${e instanceof Error ? e.message : String(e)}`)
    }
  })()
  await Promise.all([hydrateTask, loadChat()])
  void loadProjectData(id)
  void loadSuggestProject()
})

function onModuleSelect(index: string): void {
  activeModule.value = index
  saveConsoleModule(index)
  // agent 工具可在后台增删技能/记忆，切到对应面板时拉最新，避免显示旧数据
  if (index === 'skills') void loadSkills()
  else if (index === 'memory') void loadMemories()
}

/**
 * 清空对话守卫：导演任务仍在执行时，清空对话并不会停止任务（此前用户误解为
 * "清空=任务没了"，导致后台渲染继续）。弹确认框让用户选择是否一并取消任务。
 */
async function clearChatGuarded(): Promise<void> {
  if (running.value || paused.value) {
    // 双分支选择框：确认=清空并取消任务，取消=仅清空对话，ESC/遮罩=放弃整个操作
    const action = await ElMessageBox.confirm(
      '导演任务仍在执行中，清空对话不会停止任务。是否同时取消当前任务？',
      '清空对话 · 任务运行中',
      {
        type: 'warning',
        confirmButtonText: '清空并取消任务',
        cancelButtonText: '仅清空对话',
        distinguishCancelAndClose: true
      }
    )
      .then(() => 'confirm' as const)
      .catch((a: unknown) => (a === 'cancel' ? 'cancel' as const : 'close' as const))
    if (action === 'close') return
    if (action === 'confirm') {
      const pid = state.value?.projectId || projectId.value
      if (pid) {
        try {
          await window.api.director.cancel(pid)
          ElMessage.warning('已请求取消')
        } catch (e) {
          ElMessage.error('取消失败：' + (e instanceof Error ? e.message : String(e)))
        }
      }
    }
  }
  await clearChat()
}
</script>

<style scoped>
.console-shell {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: calc(100vh - 48px);
  animation: page-enter var(--dur-slow) var(--ease-out);
}
.console-crumb {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  font-size: 12px;
  color: var(--text-secondary);
  flex-shrink: 0;
}
.crumb-domain {
  font-weight: 600;
  color: var(--text-primary);
}
.crumb-suggest { color: var(--text-muted); }
.console {
  display: flex;
  gap: 14px;
  flex: 1;
  min-height: 0;
  max-width: none;
  padding: 0;
}
.console-aside {
  width: 230px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 12px 0;
  /* 项目概览（含复审问题列表）过长时纵向滚动，避免 hidden 硬裁剪 */
  overflow-y: auto;
  overflow-x: hidden;
}
.aside-title {
  padding: 4px 16px 12px;
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 650;
  color: var(--text-primary);
}
.aside-menu {
  border-right: none;
  --el-menu-bg-color: transparent;
  --el-menu-text-color: var(--text-secondary);
  --el-menu-active-color: var(--brand-strong);
  --el-menu-hover-bg-color: var(--bg-hover);
}
.aside-menu :deep(.el-menu-item) {
  height: 42px;
  margin: 2px 8px;
  border-radius: 10px;
}
.aside-menu :deep(.el-menu-item.is-active) {
  background: var(--bg-menu-active);
  box-shadow: inset 0 0 0 1px rgba(212, 165, 116, 0.22);
}
.selfcheck-badge { margin-left: auto; margin-right: 8px; }
.aside-project {
  margin-top: auto;
  border-top: 1px solid var(--border-weak);
  padding: 12px 16px;
  font-size: 12px;
}
.aside-subtitle {
  color: var(--text-muted);
  font-size: 12px;
  margin-bottom: 8px;
}
.kv { display: flex; justify-content: space-between; margin-bottom: 6px; color: var(--text-secondary); }
.kv .v { color: var(--text-primary); display: flex; align-items: center; gap: 6px; }
.review-issues { margin-top: 10px; }
.issue-item {
  color: var(--danger);
  font-size: 12px;
  line-height: 1.5;
  margin-bottom: 4px;
}
.review-more { margin-top: 2px; }
.review-more .el-button.is-link { padding: 0; height: auto; font-size: 12px; }
.final-path { margin-top: 10px; }

.console-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;
  padding: 12px;
}

.console-right {
  width: min(380px, 34vw);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow: hidden;
  padding: 4px;
}

@media (max-width: 1100px) {
  .console-shell {
    height: auto;
    min-height: calc(100vh - 48px);
  }
  .console {
    flex-direction: column;
    min-height: 0;
  }
  .console-aside { width: 100%; }
  .console-right {
    width: 100%;
    min-height: 420px;
  }
}
</style>
