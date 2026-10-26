<template>
  <div>
    <div class="page-header">
      <div>
        <h1>分镜编辑</h1>
        <p class="subtitle">绑定角色与场景板，核对首尾帧后开渲</p>
      </div>
      <div class="page-actions">
        <el-button @click="router.push(`/project/${projectId}/characters`)">角色库</el-button>
        <el-button @click="router.push(`/project/${projectId}/scenes`)">场景板</el-button>
        <el-button type="primary" @click="emit('addShot')" :disabled="isRendering">添加分镜</el-button>
        <el-button @click="emit('openSplit')" :disabled="isRendering">
          <el-icon><MagicStick /></el-icon> AI 拆分镜
        </el-button>
        <el-button type="warning" @click="emit('openReview')" :disabled="isRendering" :plain="!reviewMode">
          <el-icon><View /></el-icon> 分镜审核
        </el-button>
        <el-tooltip
          content="批量检查全部文生图/文生视频任务的正向与负向提示词：完整性、格式规范性、敏感内容"
          placement="bottom"
        >
          <el-button
            type="info" plain
            :disabled="isRendering"
            :loading="auditLoading"
            @click="emit('openAudit')"
          >
            <el-icon><DocumentChecked /></el-icon> 提示词体检
          </el-button>
        </el-tooltip>
        <el-button type="success" @click="emit('startRender')" :disabled="!hasPendingShots || isRendering" :loading="rendering">
          {{ rendering ? '渲染中...' : '开始渲染' }}
        </el-button>
      </div>
    </div>

    <el-alert
      v-if="bannerVisible"
      type="warning"
      show-icon
      closable
      class="unbound-banner"
      :title="`${unboundShotCount} 个分镜尚未绑定角色，人物镜渲染前请先建档并绑定`"
      @close="unboundBannerDismissed = true"
    >
      <el-button type="warning" link size="small" @click="router.push(`/project/${projectId}/characters`)">
        去角色库
      </el-button>
    </el-alert>

    <el-empty
      v-if="projectExists && shots.length === 0"
      description="还没有分镜，添加一条、用 AI 从剧本拆分，或先去写剧本"
    >
      <div class="empty-actions">
        <el-button type="primary" :disabled="isRendering" @click="emit('addShot')">
          <el-icon><Plus /></el-icon> 添加分镜
        </el-button>
        <el-button :disabled="isRendering" @click="emit('openSplit')">
          <el-icon><MagicStick /></el-icon> AI 拆分镜
        </el-button>
        <el-button plain @click="router.push(`/project/${projectId}/script`)">
          <el-icon><EditPen /></el-icon> 去写剧本
        </el-button>
      </div>
    </el-empty>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { MagicStick, View, DocumentChecked, Plus, EditPen } from '@element-plus/icons-vue'
import type { Shot } from '../../../../shared/ipcTypes'

const props = defineProps<{
  projectId: string
  projectExists: boolean
  isRendering: boolean
  hasPendingShots: boolean
  rendering: boolean
  reviewMode: boolean
  auditLoading: boolean
  shots: Shot[]
}>()

const emit = defineEmits<{
  addShot: []
  openSplit: []
  openReview: []
  openAudit: []
  startRender: []
}>()

const router = useRouter()

/** AI 拆分后提示绑定角色；用户关闭后本会话不再打扰 */
const unboundBannerDismissed = ref(false)
const unboundShotCount = computed(() =>
  props.shots.filter(s => s.type === 'i2v' && s.characterIds.length === 0).length
)
const bannerVisible = computed(() =>
  !unboundBannerDismissed.value && unboundShotCount.value > 0
)
</script>

<style scoped>
.unbound-banner { margin-bottom: 16px; }
.empty-actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
</style>
