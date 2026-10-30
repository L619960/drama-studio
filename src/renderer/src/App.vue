<template>
  <el-container class="app-shell">
    <el-aside :width="sidebarCollapsed ? '72px' : '220px'" class="sidebar glass-strong">
      <div class="logo" @click="router.push('/')">
        <div class="logo-mark">DS</div>
        <div v-if="!sidebarCollapsed" class="logo-text">
          <h2>短剧工坊</h2>
          <span>Drama Studio</span>
        </div>
      </div>

      <nav class="nav-scroll">
        <el-menu
          :default-active="activeMenu"
          :collapse="sidebarCollapsed"
          router
          class="sidebar-menu"
        >
          <el-menu-item-group v-if="!sidebarCollapsed">
            <template #title>工作台</template>
          </el-menu-item-group>
          <el-menu-item index="/">
            <el-icon><Folder /></el-icon>
            <template #title>项目列表</template>
          </el-menu-item>
          <el-menu-item :index="currentProjectId ? `/project/${currentProjectId}/console` : '/console'">
            <el-icon><Monitor /></el-icon>
            <template #title>导演控制台</template>
          </el-menu-item>

          <template v-if="currentProjectId">
            <el-menu-item-group v-if="!sidebarCollapsed">
              <template #title>项目资产</template>
            </el-menu-item-group>
            <el-menu-item :index="`/project/${currentProjectId}/storyboard`">
              <el-icon><Film /></el-icon>
              <template #title>分镜编辑</template>
            </el-menu-item>
            <el-menu-item :index="`/project/${currentProjectId}/characters`">
              <el-icon><User /></el-icon>
              <template #title>角色库</template>
            </el-menu-item>
            <el-menu-item :index="`/project/${currentProjectId}/scenes`">
              <el-icon><Picture /></el-icon>
              <template #title>场景板</template>
            </el-menu-item>
            <el-menu-item :index="`/project/${currentProjectId}/props`">
              <el-icon><Box /></el-icon>
              <template #title>道具库</template>
            </el-menu-item>
            <el-menu-item :index="`/project/${currentProjectId}/script`">
              <el-icon><Document /></el-icon>
              <template #title>剧本</template>
            </el-menu-item>
            <el-menu-item :index="`/project/${currentProjectId}/queue`">
              <el-badge
                :value="failed > 0 ? failed : rendering"
                :type="failed > 0 ? 'danger' : 'primary'"
                :hidden="rendering === 0 && failed === 0"
                :max="99"
                class="queue-activity-badge"
                :class="{ 'is-live': rendering > 0 }"
              >
                <el-icon><List /></el-icon>
              </el-badge>
              <template #title>渲染队列</template>
            </el-menu-item>
            <el-menu-item :index="`/project/${currentProjectId}/result`">
              <el-icon><VideoPlay /></el-icon>
              <template #title>成片预览</template>
            </el-menu-item>
          </template>

          <el-menu-item-group v-if="!sidebarCollapsed">
            <template #title>系统</template>
          </el-menu-item-group>
          <el-menu-item index="/settings">
            <el-icon><Setting /></el-icon>
            <template #title>设置</template>
          </el-menu-item>
        </el-menu>
      </nav>

      <div class="sidebar-foot">
        <button
          class="comfyui-status"
          :class="{ connected: comfyuiConnected, checking: comfyChecking }"
          type="button"
          :title="comfyuiConnected ? '点击刷新连接状态' : '未连接，点击前往设置'"
          @click="onComfyStatusClick"
        >
          <span class="status-dot" />
          <el-icon><Connection /></el-icon>
          <span v-if="!sidebarCollapsed">{{
            comfyChecking
              ? '检测中...'
              : (comfyuiConnected ? 'ComfyUI 已连接' : 'ComfyUI 未连接')
          }}</span>
        </button>
        <button class="collapse-btn" type="button" :title="sidebarCollapsed ? '展开侧栏' : '收起侧栏'" @click="sidebarCollapsed = !sidebarCollapsed">
          <el-icon><Fold v-if="!sidebarCollapsed" /><Expand v-else /></el-icon>
        </button>
      </div>
    </el-aside>

    <el-container class="work-shell">
      <el-main class="main-stage">
        <router-view v-slot="{ Component }">
          <component :is="Component" />
        </router-view>
      </el-main>
      <!-- REQ-05：底部常驻导演运行条，任何页面可见/可控 -->
      <DirectorRunBar />
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Folder, Film, User, List, VideoPlay, Connection, Setting, Monitor, Picture, Box, Document, Fold, Expand
} from '@element-plus/icons-vue'
import { useHotkeys } from './composables/useHotkeys'
import { useActiveProject, forgetLastProjectIfMissing } from './composables/useActiveProject'
import { useRenderActivity } from './composables/useRenderActivity'
import DirectorRunBar from './components/layout/DirectorRunBar.vue'

const route = useRoute()
const router = useRouter()
const { currentProjectId } = useActiveProject(route)
// 侧栏「渲染队列」全局活动徽标：render.onProgress + director.onProgress 双源计数
const {
  rendering, failed,
  subscribe: subscribeRenderActivity,
  unsubscribeAll: unsubscribeRenderActivity,
  acknowledge: acknowledgeRenderActivity,
  reset: resetRenderActivity
} = useRenderActivity(() => currentProjectId.value)
// 项目切换：清掉旧项目残留计数；进入队列页：失败徽标视为「已读」
watch(currentProjectId, () => resetRenderActivity())
watch(() => route.path, (p) => { if (p.endsWith('/queue')) acknowledgeRenderActivity() })
const comfyuiConnected = ref(false)
const comfyChecking = ref(false)
const sidebarCollapsed = ref(false)
let comfyTimer: ReturnType<typeof setInterval> | null = null
let dialogGuardTimer: number | null = null

const activeMenu = computed(() =>
  route.name === 'project-console'
    ? (currentProjectId.value ? `/project/${currentProjectId.value}/console` : '/console')
    : route.path
)

async function refreshComfyStatus(): Promise<void> {
  if (comfyChecking.value) return
  comfyChecking.value = true
  try {
    comfyuiConnected.value = await window.api.comfyui.healthCheck()
  } catch {
    comfyuiConnected.value = false
  } finally {
    comfyChecking.value = false
  }
}

function onComfyStatusClick(): void {
  if (!comfyuiConnected.value && !comfyChecking.value) {
    void router.push('/settings')
    return
  }
  void refreshComfyStatus()
}

function onComfyRecheck(): void {
  void refreshComfyStatus()
}

onMounted(async () => {
  // 渲染活动徽标常驻订阅（App 级，进程级生命周期；HMR 时 composable 内部先清旧再订阅）
  subscribeRenderActivity()
  // 首次 ComfyUI 健康检查不阻塞 App 渲染：ComfyUI 未启动时 healthCheck 会等 TCP
  // 超时（数秒），await 会拖住首次绘制。改为 fire-and-forget，侧栏状态稍后自动亮起。
  void refreshComfyStatus()
  void window.api.project.list()
    .then(list => forgetLastProjectIfMissing(list.map(p => p.id)))
    .catch(() => undefined)
  comfyTimer = setInterval(() => void refreshComfyStatus(), 15_000)
  window.addEventListener('comfyui:recheck', onComfyRecheck)
  // 弹窗关闭防线：theme.css 已让 is-closing 瞬态收尾（根治过渡中断卡死），
  // 此处兜底处理极端残留——closing 超 1.5s 未清理的节点强制移除，避免遮罩残留阻塞交互
  dialogGuardTimer = window.setInterval(() => {
    document.querySelectorAll('.el-overlay-dialog.is-closing').forEach((el) => {
      const node = el as HTMLElement
      if (!node.dataset.guardTs) {
        node.dataset.guardTs = String(Date.now())
        return
      }
      if (Date.now() - Number(node.dataset.guardTs) > 1500) node.remove()
    })
  }, 1000)

  try {
    const s = await window.api.settings.get()
    applyTheme(s?.appearance?.theme || 'dark')
  } catch {
    applyTheme('dark')
  }
})

onUnmounted(() => {
  if (comfyTimer) clearInterval(comfyTimer)
  if (dialogGuardTimer !== null) clearInterval(dialogGuardTimer)
  window.removeEventListener('comfyui:recheck', onComfyRecheck)
  unsubscribeRenderActivity()
})

function applyTheme(theme: 'dark' | 'light' | 'studio' | 'warm') {
  // 4 主题：dark=无 class（:root 默认）；其余 = <html class="theme-xxx">
  const html = document.documentElement
  html.classList.remove('theme-light', 'theme-studio', 'theme-warm')
  if (theme !== 'dark') html.classList.add(`theme-${theme}`)
}

useHotkeys([
  { keys: 'alt+1', handler: () => router.push('/') },
  { keys: 'alt+2', handler: () => { if (currentProjectId.value) router.push(`/project/${currentProjectId.value}/storyboard`) } },
  { keys: 'alt+3', handler: () => { if (currentProjectId.value) router.push(`/project/${currentProjectId.value}/characters`) } },
  { keys: 'alt+4', handler: () => { if (currentProjectId.value) router.push(`/project/${currentProjectId.value}/scenes`) } },
  { keys: 'alt+5', handler: () => { if (currentProjectId.value) router.push(`/project/${currentProjectId.value}/queue`) } },
  { keys: 'alt+6', handler: () => { if (currentProjectId.value) router.push(`/project/${currentProjectId.value}/result`) } },
  { keys: 'ctrl+comma', handler: () => router.push('/settings') },
  // Ctrl+Shift+Q 跳渲染队列（Q=Queue，避开 Ctrl+R 强制刷新语义；规范 4.1）
  { keys: 'ctrl+shift+q', handler: () => { if (currentProjectId.value) router.push(`/project/${currentProjectId.value}/queue`) } }
])
</script>

<style scoped>
.app-shell {
  height: 100vh;
  overflow: hidden;
}

.sidebar {
  display: flex;
  flex-direction: column;
  margin: 10px 0 10px 10px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--glass-border);
  overflow: hidden;
  transition: width var(--dur) var(--ease-out);
  z-index: 2;
}

.logo {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 16px 14px;
  cursor: pointer;
  border-bottom: 1px solid var(--border-weak);
  transition: background var(--dur-fast) var(--ease-out);
}
.logo:hover { background: var(--bg-hover); }

.logo-mark {
  width: 36px;
  height: 36px;
  border-radius: 11px;
  display: grid;
  place-items: center;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.02em;
  color: #1a1410;
  background: linear-gradient(145deg, var(--brand-strong), var(--brand));
  box-shadow: 0 6px 18px rgba(212, 165, 116, 0.35);
  flex-shrink: 0;
}

.logo-text h2 {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 650;
  color: var(--text-primary);
  line-height: 1.2;
}
.logo-text span {
  font-size: 11px;
  color: var(--text-muted);
  letter-spacing: 0.04em;
}

.nav-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 8px 8px 12px;
  scrollbar-width: thin;
}

.sidebar-menu {
  --el-menu-bg-color: transparent;
  --el-menu-text-color: var(--text-secondary);
  --el-menu-active-color: var(--brand-strong);
  --el-menu-hover-bg-color: var(--bg-hover);
  border-right: none !important;
}
.sidebar-menu :deep(.el-menu-item-group__title) {
  padding: 14px 12px 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--text-muted);
}
.sidebar-menu :deep(.el-menu-item) {
  height: 42px;
  line-height: 42px;
  margin: 2px 0;
  border-radius: 10px;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.sidebar-menu :deep(.el-menu-item:hover) {
  background: var(--bg-hover);
}
.sidebar-menu :deep(.el-menu-item.is-active) {
  background: var(--bg-menu-active);
  color: var(--brand-strong);
  box-shadow: inset 0 0 0 1px rgba(212, 165, 116, 0.25);
}
.sidebar-menu :deep(.el-menu-item .el-icon) {
  font-size: 18px;
}
/* 渲染中蓝徽标：呼吸脉冲（未读消息感）；失败红徽标不脉冲 */
.queue-activity-badge.is-live :deep(.el-badge__content) {
  animation: soft-pulse 1.6s var(--ease-out) infinite;
}

.sidebar-foot {
  padding: 10px;
  border-top: 1px solid var(--border-weak);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.comfyui-status {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--border-weak);
  background: var(--bg-input);
  color: var(--danger);
  font-size: 12px;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.comfyui-status:hover { background: var(--bg-hover); }
.comfyui-status.connected { color: var(--accent); }
.comfyui-status.checking { color: var(--text-secondary); }

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 25%, transparent);
  animation: soft-pulse 2.2s var(--ease-out) infinite;
}

.collapse-btn {
  display: grid;
  place-items: center;
  height: 34px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.collapse-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.main-stage {
  flex: 1;
  min-height: 0;
  padding: 14px 18px 18px;
  overflow-y: auto;
  overflow-x: hidden;
}

/* 右侧工作区纵向排布：内容区可滚动 + 底部运行条常驻 */
.work-shell {
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.view-fade-enter-active,
.view-fade-leave-active {
  transition: opacity var(--dur) var(--ease-out), transform var(--dur) var(--ease-out);
}
.view-fade-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
.view-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

@media (max-width: 860px) {
  .sidebar {
    margin: 6px 0 6px 6px;
    border-radius: var(--radius-md);
  }
  .main-stage { padding: 10px 12px 16px; }
  .logo-text { display: none; }
}
</style>
