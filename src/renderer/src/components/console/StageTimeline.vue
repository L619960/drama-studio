<template>
  <div class="panel stage-panel">
    <div class="panel-title">
      工作流阶段
      <span class="stage-hint">点击阶段行展开/收起 · 已产出可直接预览</span>
    </div>

    <!-- 无任务态（state === null）：不渲染阶段骨架，改为居中引导空态 -->
    <div v-if="!state" class="stage-empty">
      <el-icon class="stage-empty-icon"><VideoPlay /></el-icon>
      <p class="stage-empty-text">还没有进行中的任务</p>
      <el-button type="primary" :icon="VideoPlay" class="stage-empty-btn" @click="emit('startTask')">开始任务</el-button>
    </div>

    <div v-else class="stage-list">
      <div
        v-for="stage in stageOrder"
        :key="stage"
        class="stage-row"
        :class="[`is-${state?.stages[stage]?.status || 'pending'}`, { 'row-open': isStageOpen(stage) }]"
      >
        <div
          class="stage-head"
          role="button"
          tabindex="0"
          :aria-expanded="isStageOpen(stage)"
          @click="toggleStage(stage)"
          @keydown.enter.prevent="toggleStage(stage)"
          @keydown.space.prevent="toggleStage(stage)"
        >
          <div class="stage-icon">
            <el-icon v-if="state?.stages[stage]?.status === 'running'" class="is-loading"><Loading /></el-icon>
            <el-icon v-else-if="state?.stages[stage]?.status === 'done'"><CircleCheckFilled /></el-icon>
            <el-icon v-else-if="state?.stages[stage]?.status === 'error'"><CircleCloseFilled /></el-icon>
            <el-icon v-else-if="state?.stages[stage]?.status === 'skipped'"><RemoveFilled /></el-icon>
            <el-icon v-else-if="isGate(stage)"><Timer /></el-icon>
            <el-icon v-else><MoreFilled /></el-icon>
          </div>
          <div class="stage-body">
            <div class="stage-headline">
              <span class="stage-name">{{ stageLabels[stage] }}</span>
              <el-tag v-if="isGate(stage)" size="small" type="warning" effect="plain" class="gate-tag">阶段后暂停</el-tag>
              <el-button
                v-if="canResumeFrom(stage)"
                size="small"
                link
                type="primary"
                class="resume-btn"
                @click.stop="emit('resumeFrom', stage)"
              >
从此重跑
</el-button>
            </div>
            <div v-if="state?.stages[stage]?.message" class="stage-msg" :title="state.stages[stage].message">{{ state.stages[stage].message }}</div>
            <el-progress
              v-if="state?.stages[stage]?.status === 'running'"
              :percentage="state.stages[stage].percent"
              :stroke-width="4"
              :show-text="false"
              class="stage-progress"
            />
          </div>
          <el-icon class="stage-arrow">
            <ArrowDown v-if="isStageOpen(stage)" />
            <ArrowRight v-else />
          </el-icon>
        </div>

        <!-- 阶段展开详情：按阶段实时预览产物 -->
        <div v-show="isStageOpen(stage)" class="stage-detail">
          <!-- 剧本分析 -->
          <div v-if="stage === 'analyze'" class="detail-block">
            <div v-if="state?.analysis" class="analysis-summary">
              <div v-if="state.analysis.logline" class="analysis-note">{{ state.analysis.logline }}</div>
              <div class="kv"><span class="k">角色</span><span class="v">{{ state.analysis.characters.length }} 个</span></div>
              <div class="kv"><span class="k">分镜</span><span class="v">{{ state.analysis.shots.length }} 镜 · 共 {{ state.totalShots }} 镜</span></div>
              <div v-if="state.analysis.warnings?.length" class="analysis-note" style="color: #e6a23c">
                <template v-for="(w, wi) in state.analysis.warnings" :key="wi">· {{ w }}<br /></template>
              </div>
            </div>
            <el-empty v-else description="本阶段无结构化产出，见阶段信息与执行日志" :image-size="60" />
          </div>

          <!-- 角色建档 -->
          <div v-else-if="stage === 'casting'" class="detail-block">
            <div v-if="project?.characters?.length" class="asset-grid">
              <div v-for="c in project.characters" :key="c.id" class="asset-card char-card">
                <div class="asset-media">
                  <img v-if="urlOf(c.faceImagePath) || urlOf(characterPrimaryRef(c))"
                       :src="urlOf(c.faceImagePath) || urlOf(characterPrimaryRef(c))" class="asset-img" />
                  <div v-if="isAssetBusy('charFace', c.id)" class="asset-mask">重新生成中…</div>
                </div>
                <div class="asset-media">
                  <img v-if="urlOf(c.bodySheetPath)" :src="urlOf(c.bodySheetPath)" class="asset-img" />
                  <div v-if="isAssetBusy('charBody', c.id)" class="asset-mask">重新生成中…</div>
                </div>
                <div class="asset-name">{{ c.name }}</div>
                <div v-if="c.appearanceLock" class="asset-note">{{ c.appearanceLock }}</div>
                <div class="asset-actions">
                  <el-button size="small" link type="primary" @click="openAsset('charFace', c.id, c.appearanceLock || c.description || c.name, urlOf(c.faceImagePath) || urlOf(characterPrimaryRef(c)))">编辑脸图</el-button>
                  <el-button size="small" link type="primary" @click="openAsset('charBody', c.id, c.appearanceLock || c.description || c.name, urlOf(c.bodySheetPath))">编辑三视图</el-button>
                </div>
              </div>
            </div>
            <el-empty v-else description="暂无角色产出" :image-size="60" />
          </div>

          <!-- 场景板与首尾帧 -->
          <div v-else-if="stage === 'scenes'" class="detail-block">
            <div v-if="project?.sceneBoards?.length" class="asset-grid">
              <div v-for="b in project.sceneBoards" :key="b.id" class="asset-card">
                <div class="asset-media">
                  <img v-if="urlOf(b.emptyPlatePath)" :src="urlOf(b.emptyPlatePath)" class="asset-img wide" />
                  <div v-if="isAssetBusy('scenePlate', b.id)" class="asset-mask">重新生成中…</div>
                </div>
                <div class="asset-name">{{ b.name }}</div>
                <div class="asset-actions">
                  <el-button size="small" link type="primary" @click="openAsset('scenePlate', b.id, b.description || b.name, urlOf(b.emptyPlatePath))">编辑场景图</el-button>
                </div>
              </div>
            </div>
            <div v-if="sceneFrames.length" class="asset-grid frames-grid">
              <div v-for="(f, i) in sceneFrames" :key="i" class="asset-card frame-card">
                <div class="asset-media">
                  <img v-if="urlOf(f.path)" :src="urlOf(f.path)" class="asset-img wide" />
                  <div v-if="isAssetBusy(f.kind === 'first' ? 'firstFrame' : 'lastFrame', f.shotId)" class="asset-mask">重新生成中…</div>
                </div>
                <div class="asset-name">第 {{ f.index }} 镜{{ f.kind === 'last' ? '尾帧' : '首帧' }}</div>
                <div class="asset-actions">
                  <el-button size="small" link type="primary" @click="openAsset(f.kind === 'first' ? 'firstFrame' : 'lastFrame', f.shotId, f.seed, urlOf(f.path))">编辑</el-button>
                </div>
              </div>
            </div>
            <div v-if="framesTruncated" class="frames-truncated-hint">
              仅显示前 {{ FRAME_PREVIEW_LIMIT }} 个镜头的首尾帧，共 {{ frameShots.length }} 个镜头
            </div>
            <el-empty v-if="!project?.sceneBoards?.length && !sceneFrames.length" description="暂无场景/首尾帧产出" :image-size="60" />
          </div>

          <!-- 逐镜渲染 -->
          <ShotRenderList
            v-else-if="stage === 'render'"
            :project="project"
            :asset-urls="assetUrls"
            :video-workflows="videoWorkflows"
            :rerendering-shot-id="rerenderingShotId"
            @rerender-shot="emit('rerenderShot', $event)"
            @rerender-shots="emit('rerenderShots', $event)"
          />

          <!-- 拼接/字幕/复审/BGM/完成：成片预览 -->
          <div v-else-if="['combine', 'subtitle', 'review', 'bgm', 'done'].includes(stage)" class="detail-block">
            <template v-if="state?.finalPath && urlOf(state.finalPath)">
              <video :src="urlOf(state.finalPath)" controls class="final-video" preload="metadata" />
              <div class="final-actions">
                <el-button size="small" @click="emit('openFinalFolder')">
                  <el-icon><FolderOpened /></el-icon>&nbsp;打开成片所在目录
                </el-button>
              </div>
            </template>
            <el-empty v-else description="成片尚未生成" :image-size="60" />
          </div>
        </div>
      </div>
    </div>

    <!-- 资产编辑弹窗：角色/场景/首尾帧统一入口；编辑暂存，点击「重新生成」才落盘 -->
    <AssetEditDialog
      ref="assetDialog"
      :project="project"
      :asset-urls="assetUrls"
      :image-workflows="imageWorkflows"
      @asset-refreshed="emit('asset-refreshed')"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  Loading, CircleCheckFilled, CircleCloseFilled, RemoveFilled, MoreFilled, Timer,
  ArrowDown, ArrowRight, FolderOpened, VideoPlay
} from '@element-plus/icons-vue'
import ShotRenderList from './ShotRenderList.vue'
import AssetEditDialog from './AssetEditDialog.vue'
import {
  characterPrimaryRef,
  type DirectorState, type DirectorStage, type Project, type WorkflowMeta,
  type AssetRegenerateKind
} from '../../../../shared/ipcTypes'
import {
  STAGE_ORDER, STAGE_LABELS, isGateStage
} from '../../composables/useDirectorState'

const props = defineProps<{
  state: DirectorState | null
  project: Project | null
  assetUrls: Record<string, string>
  videoWorkflows: WorkflowMeta[]
  imageWorkflows: WorkflowMeta[]
  rerenderingShotId: string
}>()

const emit = defineEmits<{
  resumeFrom: [stage: DirectorStage]
  rerenderShot: [payload: { shotId: string; prompt: string; dialogue: string; negative: string; workflow: string }]
  rerenderShots: [payloads: Array<{ shotId: string; prompt: string; dialogue: string; negative: string; workflow: string }>]
  openFinalFolder: []
  'asset-refreshed': []
  /** 空态引导按钮：复用 WorkflowPanel 既有「开始任务」弹窗通道 */
  startTask: []
}>()

const stageOrder = STAGE_ORDER
const stageLabels = STAGE_LABELS

// ===== 阶段折叠：running 阶段默认展开，其余收起；点击行头切换 =====
const openStages = ref<Set<DirectorStage>>(new Set())
function isStageOpen(stage: DirectorStage): boolean {
  return openStages.value.has(stage)
}
function toggleStage(stage: DirectorStage): void {
  const next = new Set(openStages.value)
  if (next.has(stage)) next.delete(stage)
  else next.add(stage)
  openStages.value = next
}
// 状态变化时：running 阶段自动展开，任务结束自动收起已完成阶段
watch(
  () => props.state?.stages,
  (stages, oldStages) => {
    if (!stages) return
    const next = new Set(openStages.value)
    for (const stage of stageOrder) {
      const st = stages[stage]?.status
      const prev = oldStages?.[stage]?.status
      if (st === 'running' && prev !== 'running') next.add(stage)
      if (st === 'done' && prev !== 'done') next.delete(stage)
    }
    openStages.value = next
  },
  { deep: true }
)

// ===== 产物 URL 助手 =====
function urlOf(rel?: string): string {
  if (!rel) return ''
  return props.assetUrls[rel] || ''
}

// ===== 场景阶段：首尾帧缩略（仅展示前 12 个镜头的首尾帧，超出给出截断提示）=====
const FRAME_PREVIEW_LIMIT = 12
type FrameEntry = { index: number; kind: 'first' | 'last'; path: string; shotId: string; seed: string }
const frameShots = computed(() =>
  (props.project?.shots || []).filter(s => s.firstFramePath || s.lastFramePath)
)
const sceneFrames = computed<FrameEntry[]>(() =>
  frameShots.value
    .slice(0, FRAME_PREVIEW_LIMIT)
    .flatMap(s => [
      s.firstFramePath ? { index: s.index, kind: 'first' as const, path: s.firstFramePath, shotId: s.id, seed: s.firstFrameEn || s.action } : null,
      s.lastFramePath ? { index: s.index, kind: 'last' as const, path: s.lastFramePath, shotId: s.id, seed: s.lastFrameEn || s.action } : null
    ])
    .filter((x): x is FrameEntry => x !== null)
)
const framesTruncated = computed(() => frameShots.value.length > FRAME_PREVIEW_LIMIT)

function isGate(stage: DirectorStage): boolean {
  return isGateStage(props.state, stage)
}

/**
 * A 断点续跑入口：任务结束且该阶段已有产出（成功/失败）时可从此重跑。
 * 「完成」是终态不是阶段；主进程还会做前置产物校验兜底。
 */
function canResumeFrom(stage: DirectorStage): boolean {
  if (props.state?.running || stage === 'done') return false
  const st = props.state?.stages[stage]?.status
  return st === 'done' || st === 'error'
}

// ===== 资产编辑弹窗：转发 open / 查询 busy 遮罩 =====
const assetDialog = ref<InstanceType<typeof AssetEditDialog> | null>(null)
// 首次渲染时 assetDialog ref 尚未赋值，isAssetBusy 会短路而错过对子组件 assetBusySet 的订阅；
// 挂载后触发一次重渲染，此刻 ref 已就绪，再读一次即可把跨边界订阅锁定。
const mountedTick = ref(0)
onMounted(() => { mountedTick.value++ })
function openAsset(kind: AssetRegenerateKind, id: string, seedPrompt: string, currentUrl: string): void {
  assetDialog.value?.open(kind, id, seedPrompt, currentUrl)
}
function isAssetBusy(kind: AssetRegenerateKind, id: string): boolean {
  void mountedTick.value
  return assetDialog.value?.isBusy(kind, id) ?? false
}
</script>

<style scoped>
.panel {
  background: var(--bg-card);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  padding: 14px 16px;
}
/* 工作流阶段：展开后内容超高时内部滚动，避免挤垮日志区或溢出被裁 */
.stage-panel {
  flex-shrink: 1;
  min-height: 0;
  max-height: 55vh;
  overflow-y: auto;
}
.stage-panel .panel-title {
  position: sticky;
  top: -14px;
  background: var(--bg-card);
  padding-top: 14px;
  margin-top: -14px;
  z-index: 1;
}
.panel-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 10px;
  display: flex;
  align-items: center;
}
.stage-list { display: flex; flex-direction: column; gap: 2px; }
/* 无任务态引导空态 */
.stage-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 36px 0 28px;
  color: var(--text-muted);
}
.stage-empty-icon { font-size: 34px; color: var(--text-muted); }
.stage-empty-text { margin: 0; font-size: 13px; color: var(--text-muted); }
.stage-empty-btn { margin-top: 4px; }
.stage-row {
  border-radius: 6px;
  border: 1px solid transparent;
}
.stage-row:hover { background: var(--bg-input); }
.stage-row.row-open { background: var(--bg-input); border-color: var(--border-weak); }
.stage-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 8px;
  cursor: pointer;
  user-select: none;
  border-radius: 6px;
  outline: none;
}
.stage-head:focus-visible {
  outline: 2px solid var(--brand, #d4a574);
  outline-offset: 1px;
}
.stage-icon { width: 22px; display: flex; justify-content: center; color: var(--text-muted); font-size: 18px; flex-shrink: 0; }
.stage-row.is-running .stage-icon { color: #409eff; }
.stage-row.is-done .stage-icon { color: #67c23a; }
.stage-row.is-error .stage-icon { color: #f56c6c; }
.stage-row.is-skipped .stage-icon { color: var(--text-muted); }
.is-loading { animation: spin 1.4s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.stage-body { flex: 1; min-width: 0; }
.stage-headline { display: flex; align-items: center; gap: 8px; }
.stage-name {
  font-size: 13px;
  color: var(--text-secondary);
}
.stage-row.is-running .stage-name,
.stage-row.is-done .stage-name,
.stage-row.is-error .stage-name { color: var(--text-primary); font-weight: 500; }
.gate-tag { transform: scale(0.9); }
.stage-msg {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stage-row.is-error .stage-msg { color: #f56c6c; }
.stage-progress { margin-top: 4px; max-width: 320px; }
.stage-arrow { color: var(--text-muted); font-size: 14px; flex-shrink: 0; }
.stage-hint { margin-left: 10px; font-size: 12px; font-weight: 400; color: var(--text-muted); }

/* ===== 阶段展开详情 ===== */
.stage-detail {
  padding: 4px 8px 12px 42px;
  border-top: 1px dashed var(--border-weak);
  margin-top: 2px;
}
.detail-block { display: flex; flex-direction: column; gap: 10px; }
.analysis-summary { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.analysis-note { color: var(--text-secondary); line-height: 1.7; white-space: pre-wrap; }
.kv { display: flex; gap: 8px; font-size: 13px; }
.kv .k { color: var(--text-muted); flex: 0 0 56px; }
.kv .v { color: var(--text-primary); }

.asset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.frames-grid { grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); }
.frames-truncated-hint { margin-top: 6px; font-size: 12px; color: var(--text-muted); }
.asset-card {
  background: var(--bg-card);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.asset-img {
  width: 100%;
  height: 150px;
  object-fit: cover;
  border-radius: 6px;
  background: var(--bg-input);
}
.asset-img.wide { height: 90px; }
.asset-name { font-size: 12px; color: var(--text-primary); font-weight: 500; }
.asset-note { font-size: 11px; color: var(--text-muted); word-break: break-all; line-height: 1.5; }
.char-card { min-height: 170px; }
.asset-actions { display: flex; gap: 4px; margin-top: 2px; flex-wrap: wrap; }
.asset-media { position: relative; }
.asset-mask {
  position: absolute; inset: 0;
  background: rgba(0,0,0,0.55); color: #fff;
  display: flex; align-items: center; justify-content: center;
  border-radius: 6px; font-size: 13px;
}
.resume-btn { margin-left: auto; padding: 0 4px; }
.final-video { width: 100%; max-height: 320px; border-radius: 6px; background: #000; }
.final-actions { display: flex; justify-content: flex-end; }
</style>
