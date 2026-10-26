import { computed, ref, watch, type ComputedRef } from 'vue'
import type { RouteLocationNormalizedLoaded } from 'vue-router'

const STORAGE_KEY = 'drama-studio:lastProjectId'

const lastProjectId = ref<string | null>(
  typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
)

export function setLastProjectId(id: string | null): void {
  lastProjectId.value = id
  if (id) localStorage.setItem(STORAGE_KEY, id)
  else localStorage.removeItem(STORAGE_KEY)
}

/** 启动时项目列表里已不存在则忘掉，避免侧栏点进死链 */
export function forgetLastProjectIfMissing(ids: string[]): void {
  if (lastProjectId.value && !ids.includes(lastProjectId.value)) setLastProjectId(null)
}

/** 删除项目后：若正是侧栏记住的项目则清除 */
export function clearLastProjectIdIf(id: string): void {
  if (lastProjectId.value === id) setLastProjectId(null)
}

/**
 * 侧栏「当前项目」：路由 :id 优先，否则回退 localStorage 上次项目。
 * 进入任意 /project/:id/* 时自动写入。
 */
export function useActiveProject(route: RouteLocationNormalizedLoaded): {
  currentProjectId: ComputedRef<string | undefined>
} {
  watch(
    () => route.params.id,
    (id) => {
      if (typeof id === 'string' && id) setLastProjectId(id)
    },
    { immediate: true }
  )

  const currentProjectId = computed(() => {
    const fromRoute = route.params.id
    if (typeof fromRoute === 'string' && fromRoute) return fromRoute
    return lastProjectId.value || undefined
  })

  return { currentProjectId }
}
