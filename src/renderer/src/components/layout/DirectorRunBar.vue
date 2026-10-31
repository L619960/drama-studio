<template>
  <transition name="run-bar">
    <div v-if="visible" class="director-run-bar glass-strong">
      <!-- REQ-15 DC-OPEN-22：低磁盘警告 + 清理临时产物入口 -->
      <div v-if="diskLow" class="disk-warn">
        <el-icon><WarningFilled /></el-icon>
        <span class="disk-text">数据盘剩余 {{ diskFreeText }}，低于 5 GB 可能影响渲染</span>
        <el-button size="small" type="warning" plain :loading="cleaningTmp" @click="onCleanTmp">清理临时产物</el-button>
        <el-button v-if="!primary && !terminal" size="small" text @click="dismissDisk">关闭</el-button>
      </div>
      <!-- 终态反馈：完成变绿「查看成片」，失败变红「查看日志」 -->
      <template v-if="terminal && tasks.length === 0">
        <span class="run-dot" :class="terminal.success ? 'is-success' : (terminal.cancelled ? 'is-idle' : 'is-error')" />
        <div class="run-main">
          <div class="run-title" :title="terminal.title">{{ terminal.title }}</div>
          <div class="run-sub">{{ terminalText }}</div>
        </div>
        <div class="run-actions">
          <el-button v-if="terminal.success" type="success" size="small" @click="goResult(terminal.projectId)">
            查看成片
          </el-button>
          <el-button v-else-if="!terminal.cancelled" type="danger" size="small" plain @click="goLogs(terminal.projectId)">
            查看日志
          </el-button>
          <el-button size="small" text @click="dismissTerminal">关闭</el-button>
        </div>
      </template>

      <!-- 活跃任务：任意页面常驻，显示当前阶段/进度并可暂停/继续/停止 -->
      <template v-else-if="primary">
        <span class="run-dot" :class="primary.paused ? 'is-warn' : (comfyConnected ? 'is-running' : 'is-error')" />
        <div class="run-main">
          <div class="run-line">
            <span class="run-title" :title="primary.title">{{ primary.title }}</span>
            <span class="run-stage" :class="{ 'is-offline': !comfyConnected }">{{
              !comfyConnected
                ? 'ComfyUI 已断开，等待恢复…'
                : (primary.paused ? '已暂停 · 等待确认' : stageLabel)
            }}</span>
            <span class="run-percent">{{ percent }}%</span>
            <span v-if="primary.totalShots" class="run-shots">镜头 {{ primary.doneShots || 0 }}/{{ primary.totalShots }}</span>
          </div>
          <el-progress
            :percentage="percent"
            :status="primary.paused ? 'warning' : (percent >= 100 ? 'success' : '')"
            :stroke-width="4"
            :show-text="false"
            class="run-progress"
          />
        </div>
        <div class="run-actions">
          <el-tooltip
            v-if="!primary.paused"
            content="当前镜头渲染完成后暂停推进，不会中断正在渲染的帧"
            placement="top"
          >
            <el-button size="small" :icon="VideoPause" @click="onPause(primary.projectId)">暂停</el-button>
          </el-tooltip>
          <el-button v-else size="small" type="success" :icon="VideoPlay" @click="onResume(primary.projectId)">继续</el-button>
          <el-button size="small" type="danger" plain :icon="CircleCloseFilled" @click="onCancel(primary.projectId)">停止</el-button>
          <el-button size="small" text @click="goConsole(primary.projectId)">控制台</el-button>
          <el-popover v-if="tasks.length > 1" placement="top-end" :width="320" trigger="click">
            <template #reference>
              <el-button size="small" text>任务 {{ tasks.length }}</el-button>
            </template>
            <div class="task-list">
              <div
                v-for="t in tasks"
                :key="t.projectId"
                class="task-row"
                @click="goConsole(t.projectId)"
              >
                <span class="task-name">{{ t.title }}</span>
                <span class="task-stage">{{ taskStageLabel(t) }}</span>
                <span class="task-percent">{{ taskPercent(t) }}%</span>
              </div>
            </div>
          </el-popover>
        </div>
      </template>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { VideoPause, VideoPlay, CircleCloseFilled, WarningFilled } from '@element-plus/icons-vue'
import { confirmDanger } from '../../utils/confirm'
import { STAGE_ORDER, STAGE_LABELS } from '../../composables/useDirectorState'
import { isLowDiskSpace, formatFreeSpace } from '../../../../shared/diskSpace'
import type {
  DirectorState, DirectorStage, DirectorFinishedEvent
} from '../../../../shared/ipcTypes'

/**
 * REQ-05：应用底部常驻导演运行条。
 * 任何页面都能看到当前任务阶段/进度，一键暂停/继续/停止；多项目并行时 Popover 列出全部任务；
 * 任务完成/失败由主进程 director:finished 事件驱动终态反馈（绿=查看成片 / 红=查看日志）。
 */
const router = useRouter()
const tasks = ref<DirectorState[]>([])
const terminal = ref<DirectorFinishedEvent | null>(null)
const comfyConnected = ref(true)
const diskLow = ref(false)
const diskFreeText = ref('')
const diskDismissed = ref(false)
const cleaningTmp = ref(false)
let offProgress: (() => void) | null = null
let offFinished: (() => void) | null = null
let offComfyStatus: (() => void) | null = null
let terminalTimer: number | null = null

const primary = computed(() => tasks.value[0] ?? null)
const visible = computed(() =>
  tasks.value.length > 0 || terminal.value !== null || (diskLow.value && !diskDismissed.value)
)

function stageOf(state: DirectorState): DirectorStage {
  for (const st of STAGE_ORDER) {
    const s = state.stages?.[st]
    if (s && (s.status === 'running' || s.status === 'paused')) return st
  }
  return 'done'
}
function stageLabelOf(state: DirectorState): string {
  const st = stageOf(state)
  return STAGE_LABELS[st] || st
}
function percentOf(state: DirectorState): number {
  return Math.max(0, Math.min(100, state.stages?.[stageOf(state)]?.percent ?? 0))
}
const stageLabel = computed(() => primary.value ? stageLabelOf(primary.value) : '')
const percent = computed(() => primary.value ? percentOf(primary.value) : 0)
const terminalText = computed(() => {
  const t = terminal.value
  if (!t) return ''
  if (t.cancelled) return '任务已取消，已完成产物保留'
  if (t.success) return t.finalPath ? '全部完成，成片已产出' : '任务完成（本次未产出成片）'
  const failed = t.failedShotIds.length
  return t.message || (failed > 0 ? `任务结束：${failed} 镜未产出` : '任务结束，请查看日志')
})

function taskStageLabel(state: DirectorState): string {
  return state.paused ? '已暂停' : stageLabelOf(state)
}
function taskPercent(state: DirectorState): number {
  return percentOf(state)
}

function upsert(state: DirectorState): void {
  const active = state.running || state.paused
  const idx = tasks.value.findIndex(t => t.projectId === state.projectId)
  if (!active) {
    if (idx >= 0) tasks.value.splice(idx, 1)
    return
  }
  if (idx >= 0) {
    tasks.value.splice(idx, 1)
    tasks.value.unshift(state)
  } else {
    tasks.value.unshift(state)
  }
}

async function refreshActive(): Promise<void> {
  try {
    tasks.value = await window.api.director.getActiveStates()
  } catch {
    // 主进程暂不可用时保留当前列表
  }
}

function showTerminal(e: DirectorFinishedEvent): void {
  terminal.value = e
  tasks.value = tasks.value.filter(t => t.projectId !== e.projectId)
  if (terminalTimer !== null) clearTimeout(terminalTimer)
  // 终态反馈停留 10 秒，用户也可手动关闭
  terminalTimer = window.setTimeout(() => { terminal.value = null }, 10_000)
  // REQ-15：任务完成后复查磁盘空间（与启动检查对齐）
  void refreshDisk()
}

/** REQ-15 DC-OPEN-22：启动/任务完成时检查数据盘空间，<5GB 出现警告与清理入口 */
async function refreshDisk(): Promise<void> {
  try {
    const { freeBytes } = await window.api.system.diskSpace()
    diskFreeText.value = formatFreeSpace(freeBytes)
    diskLow.value = isLowDiskSpace(freeBytes)
  } catch {
    // 读取失败不打扰用户：保留上次检查结果
  }
}

async function onCleanTmp(): Promise<void> {
  if (cleaningTmp.value) return
  cleaningTmp.value = true
  try {
    await window.api.system.cleanupTmp()
    await refreshDisk()
    if (diskLow.value) {
      ElMessage.warning('已清理临时产物，但磁盘空间仍然紧张，请手动清理其他大文件')
    } else {
      diskDismissed.value = true
      ElMessage.success('已清理临时产物')
    }
  } catch (e) {
    ElMessage.error(`清理失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    cleaningTmp.value = false
  }
}

function dismissDisk(): void {
  diskDismissed.value = true
}

function dismissTerminal(): void {
  terminal.value = null
  if (terminalTimer !== null) {
    clearTimeout(terminalTimer)
    terminalTimer = null
  }
}

async function onPause(projectId: string): Promise<void> {
  try { await window.api.director.pause(projectId) } catch (e) {
    ElMessage.error(`暂停失败：${e instanceof Error ? e.message : String(e)}`)
  }
}
async function onResume(projectId: string): Promise<void> {
  try { await window.api.director.resume(projectId) } catch (e) {
    ElMessage.error(`继续失败：${e instanceof Error ? e.message : String(e)}`)
  }
}
async function onCancel(projectId: string): Promise<void> {
  const ok = await confirmDanger('停止导演任务？已完成阶段的产物全部保留，可稍后从断点继续。', {
    title: '停止导演任务',
    confirmText: '停止'
  })
  if (!ok) return
  try { await window.api.director.cancel(projectId) } catch (e) {
    ElMessage.error(`停止失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

function goConsole(projectId: string): void {
  void router.push(`/project/${projectId}/console`)
}
function goResult(projectId: string): void {
  void router.push(`/project/${projectId}/result`)
}
function goLogs(projectId: string): void {
  void router.push(`/project/${projectId}/console`)
}

onMounted(() => {
  void refreshActive()
  void refreshDisk()
  offProgress = window.api.director.onProgress((e) => upsert(e.state))
  offFinished = window.api.director.onFinished((e) => showTerminal(e))
  // REQ-15 MP-07：ComfyUI 连接状态翻转 → 运行条红色「已断开」态
  offComfyStatus = window.api.comfyui.onStatusChanged((connected) => {
    comfyConnected.value = connected
  })
})

onUnmounted(() => {
  offProgress?.()
  offFinished?.()
  offComfyStatus?.()
  offProgress = null
  offFinished = null
  offComfyStatus = null
  if (terminalTimer !== null) clearTimeout(terminalTimer)
  terminalTimer = null
})
</script>

<style scoped>
.director-run-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin: 0 18px 12px;
  padding: 10px 14px;
  border-radius: var(--radius-md);
  border: 1px solid var(--glass-border);
  flex-shrink: 0;
}
.disk-warn {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-basis: 100%;
  font-size: 12px;
  color: var(--warning, #e6a23c);
}
.disk-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--text-muted);
  flex-shrink: 0;
}
.run-dot.is-running { background: var(--brand); animation: soft-pulse 1.6s var(--ease-out) infinite; }
.run-dot.is-warn { background: var(--warning, #e6a23c); }
.run-dot.is-success { background: var(--accent); }
.run-dot.is-error { background: var(--danger); }
.run-main { flex: 1; min-width: 0; }
.run-line { display: flex; align-items: center; gap: 10px; min-width: 0; }
.run-title {
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 260px;
}
.run-stage { font-size: 12px; color: var(--text-secondary); }
.run-stage.is-offline { color: var(--danger); }
.run-percent { font-size: 12px; color: var(--brand-strong); font-variant-numeric: tabular-nums; }
.run-shots { font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.run-progress { margin-top: 4px; }
.run-sub { font-size: 12px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.task-list { display: flex; flex-direction: column; gap: 6px; }
.task-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
}
.task-row:hover { background: var(--bg-hover); }
.task-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.task-stage { font-size: 12px; color: var(--text-secondary); }
.task-percent { font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums; }

.run-bar-enter-active,
.run-bar-leave-active { transition: opacity var(--dur) var(--ease-out), transform var(--dur) var(--ease-out); }
.run-bar-enter-from,
.run-bar-leave-to { opacity: 0; transform: translateY(10px); }

@media (max-width: 860px) {
  .director-run-bar { margin: 0 12px 10px; }
  .run-shots { display: none; }
}
</style>
