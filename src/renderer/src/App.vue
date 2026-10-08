<template>
  <el-container class="app-container">
    <el-aside width="200px" class="sidebar">
      <div class="logo">
        <h2>短剧工坊</h2>
      </div>
      <el-menu
        :default-active="activeMenu"
        router
        class="sidebar-menu"
      >
        <el-menu-item index="/">
          <el-icon><Folder /></el-icon>
          <span>项目列表</span>
        </el-menu-item>
        <el-menu-item :index="currentProjectId ? `/project/${currentProjectId}/console` : '/console'">
          <el-icon><Monitor /></el-icon>
          <span>导演控制台</span>
        </el-menu-item>
        <el-menu-item v-if="currentProjectId" :index="`/project/${currentProjectId}/storyboard`">
          <el-icon><Film /></el-icon>
          <span>分镜编辑</span>
        </el-menu-item>
        <el-menu-item v-if="currentProjectId" :index="`/project/${currentProjectId}/characters`">
          <el-icon><User /></el-icon>
          <span>角色库</span>
        </el-menu-item>
        <el-menu-item v-if="currentProjectId" :index="`/project/${currentProjectId}/queue`">
          <el-icon><List /></el-icon>
          <span>渲染队列</span>
        </el-menu-item>
        <el-menu-item v-if="currentProjectId" :index="`/project/${currentProjectId}/result`">
          <el-icon><VideoPlay /></el-icon>
          <span>成片预览</span>
        </el-menu-item>
        <el-menu-item index="/settings">
          <el-icon><Setting /></el-icon>
          <span>设置</span>
        </el-menu-item>
      </el-menu>
      <div class="comfyui-status" :class="{ connected: comfyuiConnected }">
        <el-icon><Connection /></el-icon>
        <span>{{ comfyuiConnected ? 'ComfyUI 已连接' : 'ComfyUI 未连接' }}</span>
      </div>
    </el-aside>
    <el-main class="main-content">
      <router-view />
    </el-main>
  </el-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Folder, Film, User, List, VideoPlay, Connection, Setting, Monitor } from '@element-plus/icons-vue'
import { useHotkeys } from './composables/useHotkeys'

const route = useRoute()
const router = useRouter()
const currentProjectId = computed(() => route.params.id as string | undefined)
const comfyuiConnected = ref(false)

// 控制台有全局/项目两条路由，统一高亮同一菜单项
const activeMenu = computed(() =>
  route.name === 'project-console'
    ? (currentProjectId.value ? `/project/${currentProjectId.value}/console` : '/console')
    : route.path
)

onMounted(async () => {
  comfyuiConnected.value = await window.api.comfyui.healthCheck()
})

// 主题初始化：从设置读取外观主题并应用到 html class
onMounted(async () => {
  try {
    const s = await window.api.settings.get()
    applyTheme(s?.appearance?.theme || 'dark')
  } catch {
    applyTheme('dark')
  }
})

function applyTheme(theme: 'dark' | 'light') {
  document.documentElement.classList.toggle('theme-light', theme === 'light')
}

// 全局导航快捷键：Alt+1~5 切换页面，Ctrl+, 打开设置
useHotkeys([
  { keys: 'alt+1', handler: () => router.push('/') },
  { keys: 'alt+2', handler: () => { if (currentProjectId.value) router.push(`/project/${currentProjectId.value}/storyboard`) } },
  { keys: 'alt+3', handler: () => { if (currentProjectId.value) router.push(`/project/${currentProjectId.value}/characters`) } },
  { keys: 'alt+4', handler: () => { if (currentProjectId.value) router.push(`/project/${currentProjectId.value}/queue`) } },
  { keys: 'alt+5', handler: () => { if (currentProjectId.value) router.push(`/project/${currentProjectId.value}/result`) } },
  { keys: 'ctrl+comma', handler: () => router.push('/settings') }
])
</script>

<style scoped>
.app-container { height: 100vh; }
.sidebar {
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border-weak);
  display: flex;
  flex-direction: column;
}
.logo { padding: 20px; text-align: center; border-bottom: 1px solid var(--border-weak); }
.logo h2 { color: #67c23a; font-size: 18px; }
.sidebar-menu {
  flex: 1;
  border-right: none;
  --el-menu-bg-color: transparent;
  --el-menu-text-color: var(--text-secondary);
  --el-menu-active-color: #67c23a;
  --el-menu-hover-bg-color: var(--bg-card);
}
.sidebar-menu :deep(.el-menu-item) { height: 48px; line-height: 48px; }
.sidebar-menu :deep(.el-menu-item:hover) { background: var(--bg-card); }
.sidebar-menu :deep(.el-menu-item.is-active) { background: #1a2a1a; border-right: 2px solid #67c23a; }
.comfyui-status {
  padding: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: #f56c6c;
  font-size: 12px;
  border-top: 1px solid var(--border-weak);
}
.comfyui-status.connected { color: #67c23a; }
.main-content { padding: 20px; overflow-y: auto; }
</style>
