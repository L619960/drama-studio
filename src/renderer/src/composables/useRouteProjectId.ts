import { computed, onMounted, watch, type ComputedRef } from 'vue'
import { useRoute } from 'vue-router'

/**
 * 同一视图组件在项目间切换时复用实例，必须用计算属性跟路由，不能 setup 时捕获一次 id。
 *
 * 注意：首次加载回调必须延后到 onMounted，不能在 setup 阶段同步触发。
 * 视图通常写成 `const id = useRouteProjectId(loadProject)` 后再声明 `loading` 等 ref，
 * immediate watcher 会在 setup 中途同步调用 loadProject，此时后面的 const 尚未初始化，
 * 触发 "Cannot access 'loading' before initialization"（TDZ），页面卡在骨架屏。
 */
export function useRouteProjectId(onIdChange?: (id: string) => void): ComputedRef<string> {
  const route = useRoute()
  const projectId = computed(() => String(route.params.id || ''))
  watch(
    projectId,
    (id, prev) => {
      if (!id || id === prev) return
      onIdChange?.(id)
    }
  )
  onMounted(() => {
    const id = projectId.value
    if (id) onIdChange?.(id)
  })
  return projectId
}
