<template>
  <div class="console">
    <!-- ===== 左栏：模块导航 + 项目概览 ===== -->
    <aside class="console-aside">
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
          <div v-for="(iss, i) in state.reviewIssues.slice(0, 5)" :key="i" class="issue-item">{{ iss }}</div>
        </div>
        <div v-if="state.finalPath" class="final-path">
          <el-button size="small" @click="openFinalFolder">
            <el-icon><FolderOpened /></el-icon>&nbsp;成片所在目录
          </el-button>
        </div>
      </div>
    </aside>

    <!-- ===== 中栏：按 activeModule 切换的 4 个面板 ===== -->
    <section class="console-main">
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
        @pause="onPause"
        @resume="onResume"
        @cancel="onCancel"
        @open-final-folder="openFinalFolder"
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
        @refresh="refreshComfy"
        @wf-expand="onWfExpand"
        @update-param="updateWfParam"
        @run-validate="runValidate"
        @update:node-query="val => nodeQuery = val"
      />
    </section>

    <!-- ===== 右栏：导演真实对话 ===== -->
    <aside class="console-right">
      <DirectorChat
        :messages="messages"
        :input-text="inputText"
        :sending="sending"
        :expanded-tools="expandedTools"
        :quick-prompts="quickPrompts"
        :scroll-tick="scrollTick"
        :render-md="renderMd"
        @toggle-tool="toggleTool"
        @use-quick="useQuick"
        @copy-msg="copyMsg"
        @resend-msg="resendMsg"
        @send="sendMessage"
        @clear="clearChat"
        @update:input-text="val => inputText = val"
      />
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { DataLine, MagicStick, Collection, Cpu, FolderOpened } from '@element-plus/icons-vue'
import type { DirectorStage } from '../../../shared/ipcTypes'
import { useDirectorState } from '../composables/useDirectorState'
import { useDirectorChat } from '../composables/useDirectorChat'
import { useSkillsManager } from '../composables/useSkillsManager'
import { useMemoryManager } from '../composables/useMemoryManager'
import { useComfyPanel } from '../composables/useComfyPanel'
import WorkflowPanel from '../components/console/WorkflowPanel.vue'
import SkillsPanel from '../components/console/SkillsPanel.vue'
import MemoryPanel from '../components/console/MemoryPanel.vue'
import ComfyPanel from '../components/console/ComfyPanel.vue'
import DirectorChat from '../components/console/DirectorChat.vue'

const route = useRoute()
const router = useRouter()
const projectId = computed(() => route.params.id as string | undefined)
/** 对话作用域：项目内对话带项目快照；无项目时为全局对话 */
const chatScope = computed(() => projectId.value || 'global')

const activeModule = ref('workflow')

// ===== 装配 5 个 composable =====
const {
  state, localLogs, expandedStages, gateOptions,
  running, paused,
  hydrate, subscribe, unsubscribeAll, resetForRouteSwitch,
  onPause, onResume, onCancel, openFinalFolder
} = useDirectorState(projectId)

const {
  messages, inputText, sending, expandedTools, scrollTick, quickPrompts,
  loadChat, toggleTool, useQuick, renderMd, copyMsg, resendMsg,
  sendMessage, clearChat,
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
  comfyStats, nodeNames, nodeQuery, comfyLoading, comfyLoaded,
  workflows, workflowParams, expandedWorkflows, matchedNodes,
  validateReports, validateLoading, validateRun, validateBadCount,
  runValidate, refreshComfy, onWfExpand, updateWfParam
} = useComfyPanel(activeModule)

// ===== 开拍弹窗（壳持有：confirmStart 需要路由切换 + hydrate） =====
const startDialogVisible = ref(false)
const starting = ref(false)

async function confirmStart(input: {
  title: string; genre: string; script: string; gateStages: DirectorStage[]
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

// ===== 生命周期：装配订阅与并行加载 =====
onMounted(async () => {
  if (projectId.value) await hydrate(projectId.value)
  await Promise.all([loadSkills(), loadMemories(), loadChat()])
  subscribe()
  subscribeChat()
})

onUnmounted(() => {
  unsubscribeAll()
  unsubscribeChat()
})

// 路由项目切换：同一组件复用时重新装载
watch(projectId, async (id, old) => {
  if (id === old) return
  resetForRouteSwitch()
  if (id) await hydrate(id)
  await loadChat()
})

function onModuleSelect(index: string): void {
  activeModule.value = index
}
</script>

<style scoped>
.console {
  display: flex;
  gap: 16px;
  height: calc(100vh - 80px);
}
.console-aside {
  width: 230px;
  flex-shrink: 0;
  background: var(--bg-card);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  padding: 12px 0;
}
.aside-title {
  padding: 4px 16px 12px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}
.aside-menu {
  border-right: none;
  --el-menu-bg-color: transparent;
  --el-menu-text-color: var(--text-secondary);
  --el-menu-active-color: #67c23a;
  --el-menu-hover-bg-color: var(--bg-input);
}
.aside-menu :deep(.el-menu-item) { height: 44px; }
.aside-menu :deep(.el-menu-item.is-active) { background: #1a2a1a; }
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
  color: #f56c6c;
  font-size: 12px;
  line-height: 1.5;
  margin-bottom: 4px;
}
.final-path { margin-top: 10px; }

.console-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;
}

.console-right {
  width: 360px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}
</style>
