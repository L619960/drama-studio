import { computed, watch, type ComputedRef } from 'vue'
import { useRoute } from 'vue-router'

/**
 * 同一视图组件在项目间切换时复用实例，必须用计算属性跟路由，不能 setup 时捕获一次 id。
 */
export function useRouteProjectId(onIdChange?: (id: string) => void): ComputedRef<string> {
  const route = useRoute()
  const projectId = computed(() => String(route.params.id || ''))
  watch(
    projectId,
    (id, prev) => {
      if (!id || id === prev) return
      onIdChange?.(id)
    },
    { immediate: true }
  )
  return projectId
}
