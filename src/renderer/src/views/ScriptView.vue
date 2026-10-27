<template>
  <div class="script-view page">
    <div class="page-header">
      <div>
        <h1>剧本</h1>
        <p class="subtitle">原始剧本回看与编辑 · 改后可重新拆分镜（保留资产库）</p>
      </div>
      <div class="page-actions">
        <el-button :loading="writingScript" @click="generateScript">
          <el-icon><MagicStick /></el-icon>AI 生成剧本
        </el-button>
        <el-button type="warning" plain :loading="reviewing" @click="reviewScript">
          <el-icon><FirstAidKit /></el-icon>AI 剧本医生
        </el-button>
        <el-button :loading="saving" @click="saveScript">
          <el-icon><EditPen /></el-icon>保存
        </el-button>
        <el-button type="danger" plain :loading="reanalyzing" @click="reanalyze">
          <el-icon><Refresh /></el-icon>重新拆分镜
        </el-button>
      </div>
    </div>

    <el-empty
      v-if="project && !hasScript"
      class="glass-panel empty-panel"
      description="还没有剧本。可直接在下方输入框撰写，或点「AI 生成剧本」用一句想法扩写成完整剧本；也可到首页用「AI 导演」发起制作（剧本会自动保存到这里）"
    >
      <el-button type="primary" @click="generateScript">
        <el-icon><MagicStick /></el-icon>AI 生成剧本
      </el-button>
      <el-button @click="router.push({ path: '/', query: { openDirector: '1' } })">去 AI 导演</el-button>
    </el-empty>

    <div v-if="project" class="script-editor glass-panel">
      <div class="editor-head">
        <span class="editor-title">{{ project.title }} · {{ sceneCount }} 场 · {{ shotCount }} 镜</span>
        <span class="editor-tip">支持格式：第N场标题行 + 括号动作行 + 「角色：台词」对白行</span>
      </div>
      <el-input
        v-model="scriptText"
        type="textarea"
        :rows="18"
        placeholder="【第1场 · 场景名】..."
        resize="vertical"
      />
      <div class="editor-foot">
        <span class="form-tip">保存后分镜不会自动变化；点「重新拆分镜」会用新剧本重建分镜（角色/场景/道具资产保留，新角色自动建档）</span>
      </div>
    </div>

    <el-alert
      v-if="notice"
      :type="notice.type"
      :title="notice.message"
      show-icon
      :closable="false"
      style="margin-top: 16px"
    />

    <!-- 剧本医生审查结果 -->
    <el-dialog
      v-model="reviewVisible"
      title="AI 剧本医生 · 审查报告"
      width="680px"
      append-to-body
    >
      <div v-if="reviewIssues.length === 0" class="doctor-ok">
        <el-icon :size="40" color="#67c23a"><CircleCheckFilled /></el-icon>
        <div>剧本逻辑没有发现问题，可直接进入制作</div>
      </div>
      <template v-else>
        <div class="doctor-summary">
          共发现 <b>{{ blockCount }}</b> 个必改问题、<b>{{ warnCount }}</b> 个优化建议
        </div>
        <el-card
          v-for="(it, i) in reviewIssues"
          :key="i"
          class="doctor-issue"
          :class="it.severity"
          shadow="never"
        >
          <div class="issue-head">
            <el-tag :type="it.severity === 'block' ? 'danger' : 'warning'" size="small">
              {{ it.severity === 'block' ? '必改' : '建议' }}
            </el-tag>
            <span class="issue-scene">{{ it.scene || '通篇' }}</span>
          </div>
          <div class="issue-problem">{{ it.problem }}</div>
          <div class="issue-suggestion">修改建议：{{ it.suggestion }}</div>
        </el-card>
      </template>
      <template #footer>
        <el-button @click="reviewVisible = false">关闭</el-button>
        <el-button
          type="primary"
          :disabled="!revisedScript"
          @click="applyRevision"
        >
应用修改后剧本
</el-button>
      </template>
    </el-dialog>

    <!-- 重新拆分镜确认 -->
    <el-dialog v-model="reanalyzeVisible" title="重新拆分镜" width="480px" append-to-body>
      <p style="line-height: 1.8">
        将用当前剧本重新分析并<strong>替换全部分镜</strong>（含渲染产物记录）。<br>
        已生成的角色/场景/道具资产保留，新角色会自动建档。确定继续吗？
      </p>
      <template #footer>
        <el-button @click="reanalyzeVisible = false">取消</el-button>
        <el-button type="danger" :loading="reanalyzing" @click="confirmReanalyze">重新拆分</el-button>
      </template>
    </el-dialog>

    <!-- AI 生成剧本：想法 + 题材模板/输入 -->
    <el-dialog
      v-model="genVisible"
      title="AI 生成剧本"
      width="560px"
      append-to-body
    >
      <el-form label-width="80px">
        <el-form-item label="标题">
          <el-input
            v-model="genTitle"
            clearable
            placeholder="如：雨夜退婚（留空则用项目标题）"
          />
        </el-form-item>
        <el-form-item label="题材">
          <div class="genre-row">
            <el-input
              v-model="genGenre"
              clearable
              placeholder="输入或选择题材，如：古装仙侠"
              style="flex: 1"
            />
            <el-select
              v-model="genGenreQuick"
              placeholder="常用题材"
              style="width: 200px"
              @change="pickGenGenre"
            >
              <el-option
                v-for="t in GENRE_TEMPLATES"
                :key="t.key"
                :label="t.label"
                :value="t.key"
              />
            </el-select>
          </div>
          <div class="form-tip">下拉选模板题材（自动注入风格提示词），或直接输入任意自定义题材</div>
        </el-form-item>
        <el-form-item label="想法" required>
          <el-input
            v-model="genIdea"
            type="textarea"
            :rows="5"
            placeholder="如：重生千金在婚礼上被退婚，三年后带着双胞胎杀回商场，与前夫正面交锋"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="genVisible = false">取消</el-button>
        <el-button type="primary" :loading="writingScript" @click="doGenerateScript">
          <el-icon><MagicStick /></el-icon>生成剧本
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter, onBeforeRouteLeave } from 'vue-router'
import { ElMessage } from 'element-plus'
import { EditPen, Refresh, MagicStick, FirstAidKit, CircleCheckFilled } from '@element-plus/icons-vue'
import type { Project } from '../../../shared/ipcTypes'
import { GENRE_TEMPLATES } from '../../../shared/ipcTypes'
import { snapshot } from '../utils/snapshot'
import { throttleTap } from '../utils/throttle'
import { useRouteProjectId } from '../composables/useRouteProjectId'
import { useHotkeys } from '../composables/useHotkeys'
import { confirmAction } from '../utils/confirm'

const router = useRouter()
const projectId = useRouteProjectId((id) => { void loadProject(id) })

const project = ref<Project | null>(null)
const scriptText = ref('')
const saving = ref(false)
const reanalyzing = ref(false)
const writingScript = ref(false)
const notice = ref<{ type: 'success' | 'error' | 'info'; message: string } | null>(null)
const genVisible = ref(false)
const genTitle = ref('')
const genGenre = ref('')
const genGenreQuick = ref('')
const genIdea = ref('')
const reviewing = ref(false)
const reviewVisible = ref(false)
const reviewIssues = ref<Array<{ severity: 'block' | 'warn'; scene: string; problem: string; suggestion: string }>>([])
const revisedScript = ref('')
const reanalyzeVisible = ref(false)

// ===== 自动保存（设置 general.autoSave，默认 true）=====
const autoSaveEnabled = ref(true)
let autoSaveTimer: number | null = null

onMounted(async () => {
  try {
    const s = await window.api.settings.get()
    autoSaveEnabled.value = s?.general?.autoSave ?? true
  } catch {
    // 读取失败按默认 true 处理
  }
})

onUnmounted(() => {
  if (autoSaveTimer !== null) clearTimeout(autoSaveTimer)
})

// 开启自动保存时，停止输入 800ms 后静默落盘（保留防抖，避免逐键写盘）
watch(scriptText, () => {
  if (!autoSaveEnabled.value || !project.value) return
  if (autoSaveTimer !== null) clearTimeout(autoSaveTimer)
  autoSaveTimer = window.setTimeout(async () => {
    autoSaveTimer = null
    if (!project.value) return
    if (scriptText.value === (project.value.script || '')) return
    try {
      project.value.script = scriptText.value
      project.value.updatedAt = Date.now()
      await window.api.project.save(snapshot(project.value))
    } catch {
      // 自动保存失败不打扰用户，留给手动保存 / 离开守卫提示
    }
  }, 800)
})

// 有未保存改动时拦截路由离开；选「保存并离开」先落盘再放行，取消则阻止离开
onBeforeRouteLeave(async () => {
  if (!project.value) return true
  if (scriptText.value === (project.value.script || '')) return true
  const ok = await confirmAction('剧本有未保存的修改，离开将丢失。是否保存后再离开？', {
    title: '未保存的修改',
    confirmText: '保存并离开',
    cancelText: '留在本页'
  })
  if (!ok) return false
  project.value.script = scriptText.value
  project.value.updatedAt = Date.now()
  try {
    await window.api.project.save(snapshot(project.value))
  } catch {
    // 离开时保存失败不阻塞导航
  }
  return true
})

// Ctrl+S 保存（输入框内也生效，handler 内由 saveScript 的 throttleTap 防抖）
useHotkeys([
  { keys: 'ctrl+s', allowInInput: true, handler: () => { void saveScript() } }
])

const blockCount = computed(() => reviewIssues.value.filter(i => i.severity === 'block').length)
const warnCount = computed(() => reviewIssues.value.filter(i => i.severity === 'warn').length)

const hasScript = computed(() => (project.value?.script || '').trim().length > 0)
const sceneCount = computed(() => (scriptText.value.match(/^【.*场/mg) || []).length)
const shotCount = computed(() => project.value?.shots.length || 0)

async function loadProject(id?: string) {
  const pid = id ?? projectId.value
  const p = await window.api.project.get(pid).catch(() => null)
  if (!p) {
    ElMessage.error('项目不存在或已被删除')
    void router.replace('/')
    return
  }
  project.value = p
  scriptText.value = p.script || ''
}

/** AI 剧本医生：审查当前剧本逻辑 bug */
async function reviewScript(): Promise<void> {
  const s = scriptText.value.trim()
  if (!s) { ElMessage.warning('还没有剧本内容，请先点「AI 生成剧本」或直接撰写'); return }
  if (!project.value) return
  if (!throttleTap('script-review', 2000)) return
  reviewing.value = true
  reviewVisible.value = false
  notice.value = null
  try {
    const r = await window.api.llm.reviewScript(s, project.value.genre, project.value.title)
    reviewIssues.value = r.issues
    revisedScript.value = r.revisedScript
    reviewVisible.value = true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    ElMessage.error(`剧本医生诊断失败：${msg.length > 200 ? msg.slice(0, 200) + '…' : msg}`)
  } finally {
    reviewing.value = false
  }
}

/** 应用修改后剧本：替换编辑器内容并保存 */
async function applyRevision(): Promise<void> {
  if (!revisedScript.value || !project.value) return
  scriptText.value = revisedScript.value
  project.value.script = revisedScript.value
  project.value.updatedAt = Date.now()
  try {
    await window.api.project.save(snapshot(project.value))
    reviewVisible.value = false
    notice.value = { type: 'success', message: '已应用剧本医生的修改并保存，可继续编辑或「重新拆分镜」' }
    ElMessage.success('已应用修改后剧本')
  } catch (e) {
    ElMessage.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 打开生成剧本弹窗（题材默认取项目题材，可改） */
function generateScript(): void {
  if (!project.value) return
  genTitle.value = project.value.title || ''
  genGenre.value = project.value.genre || ''
  genGenreQuick.value = ''
  genIdea.value = ''
  genVisible.value = true
}

/** 预设题材下拉 → 填入题材输入框 */
function pickGenGenre(key: string): void {
  if (key) {
    genGenre.value = key
    genGenreQuick.value = ''
  }
}

/** 确认生成：想法 + 题材 → 完整分场剧本，生成后自动保存 */
async function doGenerateScript(): Promise<void> {
  const idea = genIdea.value.trim()
  if (!idea) { ElMessage.warning('请输入创作想法'); return }
  const genre = genGenre.value.trim()
  if (!genre) { ElMessage.warning('请输入或选择题材'); return }
  if (!throttleTap('script-generate', 3000)) return
  writingScript.value = true
  notice.value = null
  ElMessage.info('正在 AI 生成剧本（约 1-2 分钟），完成后自动保存…')
  try {
    const title = genTitle.value.trim()
    const script = await window.api.llm.writeScript(idea, genre, title || undefined)
    genVisible.value = false
    scriptText.value = script
    if (project.value) {
      project.value.script = script
      project.value.genre = genre
      if (title) project.value.title = title
      project.value.updatedAt = Date.now()
      await window.api.project.save(snapshot(project.value))
    }
    notice.value = { type: 'success', message: `剧本已按「${genre}」题材${title ? `《${title}》` : ''}生成并保存，可继续编辑或直接「重新拆分镜」` }
    ElMessage.success('剧本已生成并保存')
  } catch (e) {
    ElMessage.error(`生成失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    writingScript.value = false
  }
}

async function saveScript(): Promise<void> {
  if (!project.value) return
  if (!throttleTap('script-save', 800)) return
  saving.value = true
  try {
    project.value.script = scriptText.value
    project.value.updatedAt = Date.now()
    await window.api.project.save(snapshot(project.value))
    notice.value = { type: 'success', message: '剧本已保存（分镜未变，点「重新拆分镜」生效）' }
    ElMessage.success('剧本已保存')
  } catch (e) {
    ElMessage.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    saving.value = false
  }
}

async function reanalyze(): Promise<void> {
  if (!project.value) return
  if (!scriptText.value.trim()) { ElMessage.warning('还没有剧本内容，请先点「AI 生成剧本」或直接撰写'); return }
  reanalyzeVisible.value = true
}

/** 确认重拆：保存当前剧本 → 调导演重拆 → 刷新 */
async function confirmReanalyze(): Promise<void> {
  if (!project.value) return
  if (!throttleTap('script-reanalyze', 3000)) return
  reanalyzeVisible.value = false
  reanalyzing.value = true
  notice.value = null
  try {
    // 先保存当前编辑内容，再重拆
    if (project.value.script !== scriptText.value) {
      project.value.script = scriptText.value
      await window.api.project.save(snapshot(project.value))
    }
    const r = await window.api.director.reanalyze(projectId.value)
    await loadProject(projectId.value)
    notice.value = {
      type: 'success',
      message: `重拆完成：${r.shots} 镜（角色 ${r.characters} 人 · 道具 ${r.props} 个）。去分镜编辑页调整后即可渲染`
    }
    ElMessage.success(`重拆完成：${r.shots} 镜`)
  } catch (e) {
    ElMessage.error(`重拆失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    reanalyzing.value = false
  }
}
</script>

<style scoped>
.empty-panel { padding: 36px 16px; }
.genre-row { display: flex; align-items: center; gap: 8px; width: 100%; }
.script-editor { padding: 16px 18px; }
.doctor-ok { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 28px 0; color: var(--text-secondary); }
.doctor-summary { margin-bottom: 12px; font-size: 13px; color: var(--text-primary); }
.doctor-issue { margin-bottom: 10px; border-left: 3px solid var(--el-color-warning); }
.doctor-issue.block { border-left-color: var(--el-color-danger); }
.issue-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.issue-scene { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.issue-problem { font-size: 13px; color: var(--text-primary); margin-bottom: 4px; }
.issue-suggestion { font-size: 12px; color: var(--text-secondary); }
.editor-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 12px;
  flex-wrap: wrap;
  gap: 8px;
}
.editor-title {
  font-family: var(--font-display);
  font-size: 15px;
  color: var(--text-primary);
  font-weight: 600;
}
.editor-tip { font-size: 12px; color: var(--text-muted); }
.editor-foot { margin-top: 10px; }
</style>
