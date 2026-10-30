import { createRouter, createWebHashHistory } from 'vue-router'

// P1-1 代码分割：路由组件全部懒加载（按页拆分 chunk，首屏只加载项目列表），
// vendor 库仍由 electron.vite.config.ts 的 manualChunks 独立成 vue-vendor / element-plus。
const ProjectListView = () => import('../views/ProjectListView.vue')
const StoryboardView = () => import('../views/StoryboardView.vue')
const CharacterView = () => import('../views/CharacterView.vue')
const SceneBoardView = () => import('../views/SceneBoardView.vue')
const PropsView = () => import('../views/PropsView.vue')
const ScriptView = () => import('../views/ScriptView.vue')
const QueueView = () => import('../views/QueueView.vue')
const ResultView = () => import('../views/ResultView.vue')
const SettingsView = () => import('../views/SettingsView.vue')
const ConsoleView = () => import('../views/ConsoleView.vue')

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'projects', component: ProjectListView },
    { path: '/console', name: 'console', component: ConsoleView },
    { path: '/project/:id/storyboard', name: 'storyboard', component: StoryboardView },
    { path: '/project/:id/characters', name: 'characters', component: CharacterView },
    { path: '/project/:id/scenes', name: 'scenes', component: SceneBoardView },
    { path: '/project/:id/props', name: 'props', component: PropsView },
    { path: '/project/:id/script', name: 'script', component: ScriptView },
    { path: '/project/:id/queue', name: 'queue', component: QueueView },
    { path: '/project/:id/result', name: 'result', component: ResultView },
    { path: '/project/:id/console', name: 'project-console', component: ConsoleView },
    { path: '/settings', name: 'settings', component: SettingsView },
    // 未匹配路由兜底：回项目列表，避免乱输 hash 白屏无提示
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
})

export default router
