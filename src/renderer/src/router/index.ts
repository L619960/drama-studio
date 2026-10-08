import { createRouter, createWebHashHistory } from 'vue-router'
import ProjectListView from '../views/ProjectListView.vue'
import StoryboardView from '../views/StoryboardView.vue'
import CharacterView from '../views/CharacterView.vue'
import QueueView from '../views/QueueView.vue'
import ResultView from '../views/ResultView.vue'
import SettingsView from '../views/SettingsView.vue'
import ConsoleView from '../views/ConsoleView.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'projects', component: ProjectListView },
    { path: '/console', name: 'console', component: ConsoleView },
    { path: '/project/:id/storyboard', name: 'storyboard', component: StoryboardView },
    { path: '/project/:id/characters', name: 'characters', component: CharacterView },
    { path: '/project/:id/queue', name: 'queue', component: QueueView },
    { path: '/project/:id/result', name: 'result', component: ResultView },
    { path: '/project/:id/console', name: 'project-console', component: ConsoleView },
    { path: '/settings', name: 'settings', component: SettingsView }
  ]
})

export default router
