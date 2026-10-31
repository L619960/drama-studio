<template>
  <div class="character-view page">
    <div class="page-header">
      <div>
        <h1>角色库</h1>
        <p class="subtitle">面部定妆锁身份，三视图锁体型与服装</p>
      </div>
      <div class="page-actions">
        <div class="wf-picker">
          <span class="wf-label">定妆工作流</span>
          <el-select
            v-model="charWorkflow"
            clearable
            placeholder="默认"
            size="small"
            style="width: 220px"
            @change="saveWorkflowChoice"
          >
            <el-option v-for="w in t2iWorkflows" :key="w.name" :label="w.name" :value="w.name" />
          </el-select>
        </div>
        <el-button type="primary" @click="addCharacter">
          <el-icon><Plus /></el-icon>添加角色
        </el-button>
      </div>
    </div>

    <div class="toolbar">
      <el-input
        v-model="searchQuery"
        clearable
        size="small"
        placeholder="搜索角色名称 / 描述"
        style="width: 240px"
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
    </div>

    <el-empty
      v-if="project && characters.length === 0"
      class="glass-panel empty-panel"
      description="还没有角色，添加后可绑定到分镜并生成面部定妆与三视图"
    >
      <el-button type="primary" @click="addCharacter">
        <el-icon><Plus /></el-icon>添加角色
      </el-button>
    </el-empty>

    <el-empty
      v-else-if="filteredCharacters.length === 0"
      class="glass-panel empty-panel"
      :description="`没有匹配「${searchQuery.trim()}」的角色`"
    />

    <div v-else class="character-grid">
      <el-card
        v-for="(char, i) in filteredCharacters"
        :key="char.id"
        class="character-card glass-card"
        :style="{ animationDelay: `${Math.min(i, 8) * 40}ms` }"
        @contextmenu="menu.open($event, char)"
      >
        <div class="asset-row">
          <div class="asset-slot" @click="previewPathOf(char, 'face')">
            <img v-if="faceOf(char) && urlCache[faceOf(char)]" :src="urlCache[faceOf(char)]" alt="面部定妆" />
            <div v-else class="no-image">{{ faceOf(char) ? '文件已移动' : '未生成' }}</div>
            <span class="asset-label">面部</span>
          </div>
          <div class="asset-slot wide" @click="previewPathOf(char, 'body')">
            <img v-if="char.bodySheetPath && urlCache[char.bodySheetPath]" :src="urlCache[char.bodySheetPath]" alt="三视图" />
            <div v-else class="no-image">{{ char.bodySheetPath ? '文件已移动' : '未生成' }}</div>
            <span class="asset-label">三视图</span>
          </div>
        </div>
        <div class="char-info">
          <h3>{{ char.name }}</h3>
          <p>{{ char.description || '暂无描述' }}</p>
          <p class="voice">音色: {{ voiceName(char.voice) }}</p>
        </div>
        <div class="char-actions">
          <el-button size="small" @click="importImage(char.id, 'face')">导入面部</el-button>
          <el-button size="small" @click="importImage(char.id, 'body')">导入三视图</el-button>
          <el-button size="small" :loading="generatingImage === char.id" @click="generateAssets(char)">
            <el-icon><MagicStick /></el-icon>{{ generatingImage === char.id ? '生成中...' : 'AI 生成' }}
          </el-button>
          <el-button size="small" @click="editCharacter(char)">
            <el-icon><Edit /></el-icon>编辑
          </el-button>
          <el-button size="small" type="danger" :disabled="isCharUsed(char.id)" @click="deleteCharacter(char)">
            <el-icon><Delete /></el-icon>
          </el-button>
        </div>
      </el-card>
    </div>

    <teleport to="body">
      <div
        v-if="menu.state.visible"
        class="context-menu"
        :style="{ left: menu.state.x + 'px', top: menu.state.y + 'px' }"
        @click.stop
      >
        <div class="menu-item" @click="importImage(menu.state.data!.id, 'face')">
          <el-icon><Upload /></el-icon>更换面部定妆
        </div>
        <div class="menu-item" @click="importImage(menu.state.data!.id, 'body')">
          <el-icon><Upload /></el-icon>更换三视图
        </div>
        <div class="menu-item" @click="editCharacter(menu.state.data!)">
          <el-icon><Edit /></el-icon>编辑信息
        </div>
        <div class="menu-item" @click="previewVoice(menu.state.data!)">
          <el-icon><VideoPlay /></el-icon>试听音色
        </div>
        <div class="menu-divider" />
        <div class="menu-item" @click="copyCharacter(menu.state.data!)">
          <el-icon><CopyDocument /></el-icon>复制角色
        </div>
        <div class="menu-divider" />
        <div
          class="menu-item danger"
          :class="{ disabled: isCharUsed(menu.state.data!.id) }"
          @click="!isCharUsed(menu.state.data!.id) && deleteCharacter(menu.state.data!)"
        >
          <el-icon><Delete /></el-icon>删除角色
          <span v-if="isCharUsed(menu.state.data!.id)" class="menu-tip">被分镜使用</span>
        </div>
      </div>
    </teleport>

    <el-dialog v-model="showAddDialog" :title="editingChar ? '编辑角色' : '添加角色'" width="500px">
      <el-form :model="charForm" label-width="80px">
        <el-form-item label="名称" required>
          <el-input v-model="charForm.name" placeholder="角色名称" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="charForm.description" type="textarea" :rows="2" placeholder="外貌特征、服装等" />
        </el-form-item>
        <el-form-item label="音色">
          <el-select v-model="charForm.voice" style="width: 100%">
            <el-option v-for="v in TTS_VOICES" :key="v.value" :label="v.label" :value="v.value" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddDialog = false">取消</el-button>
        <el-button type="primary" :loading="savingChar" @click="saveCharacter">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="previewVisible" title="角色资产预览" width="640px">
      <img :src="urlCache[previewPath]" style="width: 100%" />
    </el-dialog>

    <el-dialog v-model="voicePreviewVisible" title="音色试听" width="420px">
      <p style="color:var(--text-secondary); margin-bottom: 12px">{{ voicePreviewName }}</p>
      <audio v-if="voicePreviewUrl" :src="voicePreviewUrl" controls autoplay style="width: 100%" />
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElLoading, ElMessage } from 'element-plus'
import { Plus, Upload, Edit, Delete, VideoPlay, CopyDocument, MagicStick, Search } from '@element-plus/icons-vue'
import type { Project, Character, WorkflowMeta } from '../../../shared/ipcTypes'
import { findDuplicateByName } from '../../../shared/assetNames'
import { useFileUrl, clearFileUrlCache } from '../composables/useFileUrl'
import { useRouteProjectId } from '../composables/useRouteProjectId'
import { useContextMenu } from '../composables/useContextMenu'
import { snapshot } from '../utils/snapshot'
import { throttleTap } from '../utils/throttle'
import { confirmDanger } from '../utils/confirm'
import { TTS_VOICES, ttsVoiceName, DEFAULT_TTS_VOICE } from '../../../shared/ttsVoices'

const { urlCache, ensureFileUrl, ensureFileUrls } = useFileUrl()

const router = useRouter()
const projectId = useRouteProjectId((id) => { void loadProject(id) })

const project = ref<Project | null>(null)
const showAddDialog = ref(false)
const editingChar = ref<Character | null>(null)
const charForm = ref({ name: '', description: '', voice: DEFAULT_TTS_VOICE })
const previewVisible = ref(false)
const previewPath = ref('')
const defaultVoice = ref(DEFAULT_TTS_VOICE)

const voicePreviewVisible = ref(false)
const voicePreviewUrl = ref('')
const voicePreviewName = ref('')
const projectUpdatedUnsub = ref<(() => void) | null>(null)

const menu = useContextMenu<Character>(180, 200)
const generatingImage = ref('')
const t2iWorkflows = ref<WorkflowMeta[]>([])
const charWorkflow = ref('')

const characters = computed(() => project.value?.characters || [])
const searchQuery = ref('')
/** REQ-13 RA-09：按角色名 / 描述关键字过滤，不做排序与虚拟滚动 */
const filteredCharacters = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return characters.value
  return characters.value.filter(c =>
    c.name.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q)
  )
})

function faceOf(char: Character): string {
  return char.faceImagePath || char.refImagePath || ''
}

function isCharUsed(charId: string): boolean {
  return (project.value?.shots || []).some(s => s.characterIds.includes(charId))
}

onMounted(async () => {
  document.addEventListener('click', menu.close)
  document.addEventListener('keydown', onMenuKeydown)
  // 后台流程（导演流水线定妆/三视图/逐镜渲染）落盘后自动刷新面板，无需手动切页
  projectUpdatedUnsub.value = window.api.director.onProjectUpdated((e) => {
    if (e?.projectId === projectId.value) {
      // 先清 URL 缓存（同名文件已更新，旧 mtime 戳 URL 会让浏览器继续显示旧图）
      clearFileUrlCache()
      void loadProject(projectId.value)
    }
  })
  try {
    const s = await window.api.settings.get()
    if (s?.tts?.defaultVoice) defaultVoice.value = s.tts.defaultVoice
    const wf = await window.api.workflow.list()
    t2iWorkflows.value = wf.filter(w => w.capability === 't2i' || (!w.capability && !w.hasImageInput))
    if (project.value?.assetWorkflows?.character) {
      charWorkflow.value = project.value.assetWorkflows.character
    }
  } catch {
    // 工作流库加载失败不阻断页面
  }
})

onUnmounted(() => {
  document.removeEventListener('click', menu.close)
  document.removeEventListener('keydown', onMenuKeydown)
  projectUpdatedUnsub.value?.()
})

function onMenuKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') menu.close()
}

async function loadProject(id?: string) {
  const pid = id ?? projectId.value
  const p = await window.api.project.get(pid).catch(() => null)
  if (!p) {
    ElMessage.error('项目不存在或已被删除')
    void router.replace('/')
    return
  }
  project.value = p
  const paths = project.value.characters.flatMap(c =>
    [c.faceImagePath, c.bodySheetPath, c.refImagePath].filter(Boolean) as string[]
  )
  await ensureFileUrls(paths)
}

function addCharacter() {
  editingChar.value = null
  charForm.value = { name: '', description: '', voice: defaultVoice.value }
  showAddDialog.value = true
}

function editCharacter(char: Character) {
  editingChar.value = char
  charForm.value = { name: char.name, description: char.description, voice: char.voice }
  showAddDialog.value = true
  menu.close()
}

const savingChar = ref(false)
async function saveCharacter() {
  if (!throttleTap('char-save', 800)) return
  if (!project.value || !charForm.value.name.trim()) {
    ElMessage.warning('请输入名称')
    return
  }
  const name = charForm.value.name.trim()
  // REQ-13 RA-14：角色按名称去重（忽略大小写与多余空格）
  const dup = findDuplicateByName(project.value.characters, name, editingChar.value?.id)
  if (dup) {
    ElMessage.warning(`已存在同名角色「${dup.name}」，建议改名`)
    return
  }

  if (editingChar.value) {
    editingChar.value.name = name
    editingChar.value.description = charForm.value.description
    editingChar.value.voice = charForm.value.voice
  } else {
    const char: Character = {
      id: `char_${Date.now()}`,
      name,
      description: charForm.value.description,
      voice: charForm.value.voice,
      refImagePath: ''
    }
    project.value.characters.push(char)
  }

  savingChar.value = true
  try {
    await window.api.project.save(snapshot(project.value))
    showAddDialog.value = false
    editingChar.value = null
    ElMessage.success('保存成功')
  } catch (e) {
    ElMessage.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    savingChar.value = false
  }
}

async function importImage(charId: string, kind: 'face' | 'body') {
  if (!project.value) return
  try {
    const imagePath = await window.api.character.importImage(projectId.value)
    const char = project.value.characters.find(c => c.id === charId)
    if (char) {
      if (kind === 'face') {
        char.faceImagePath = imagePath
        char.refImagePath = imagePath
      } else {
        char.bodySheetPath = imagePath
        if (!char.refImagePath) char.refImagePath = imagePath
      }
      await window.api.project.save(snapshot(project.value))
      await ensureFileUrl(imagePath)
      ElMessage.success(kind === 'face' ? '面部定妆已导入' : '三视图已导入')
    }
  } catch (e) {
    // 主进程取消哨兵：'User cancelled' 静默；其余为真实导入错误，须提示
    const msg = e instanceof Error ? e.message : String(e)
    if (msg !== 'User cancelled') ElMessage.error(`导入失败：${msg}`)
  }
  menu.close()
}

/** 角色定妆工作流选择持久化到项目 */
async function saveWorkflowChoice(): Promise<void> {
  if (!project.value) return
  project.value.assetWorkflows = {
    ...(project.value.assetWorkflows || {}),
    character: charWorkflow.value || undefined
  }
  try {
    await window.api.project.save(snapshot(project.value))
  } catch (e) {
    ElMessage.error(`工作流选择保存失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

/** AI 生成面部定妆（抽卡）+ 全身三视图 */
async function generateAssets(char: Character) {
  if (!project.value) return
  // 同步防重入：generatingImage 在首个 handler 同步段已赋值，连点/双击第二击必然命中此守卫
  if (generatingImage.value) {
    ElMessage.info('已有角色正在生成，请等待完成')
    return
  }
  generatingImage.value = char.id
  try {
    const r = await window.api.character.casting(projectId.value, char.id)
    char.faceImagePath = r.faceRel
    char.refImagePath = r.faceRel
    char.bodySheetPath = r.bodyRel
    await ensureFileUrl(r.faceRel)
    await ensureFileUrl(r.bodyRel)
    ElMessage.success(`面部定妆与三视图已生成${r.pickNote ? `（${r.pickNote}）` : ''}`)
  } catch (e) {
    ElMessage.error(`生成失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    generatingImage.value = ''
  }
}

async function previewPathOf(char: Character, kind: 'face' | 'body') {
  const p = kind === 'face' ? faceOf(char) : (char.bodySheetPath || '')
  if (!p) return
  await ensureFileUrl(p)
  previewPath.value = p
  previewVisible.value = true
}

async function previewVoice(char: Character) {
  // B-03：TTS 试听生成可能耗时数十秒，全屏 loading 明示等待
  const loading = ElLoading.service({ text: '正在生成试听语音…', background: 'rgba(0,0,0,0.4)' })
  try {
    const rel = await window.api.tts.preview(char.voice)
    voicePreviewUrl.value = await ensureFileUrl(rel)
    voicePreviewName.value = `${voiceName(char.voice)} · ${char.voice}`
    voicePreviewVisible.value = true
  } catch (e) {
    ElMessage.error(`试听生成失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    loading.close()
  }
  menu.close()
}

async function copyCharacter(char: Character) {
  if (!project.value) return
  const copy: Character = {
    ...char,
    id: `char_${Date.now()}`,
    name: `${char.name} (副本)`,
    refImagePath: char.refImagePath,
    faceImagePath: char.faceImagePath,
    bodySheetPath: char.bodySheetPath
  }
  project.value.characters.push(copy)
  try {
    await window.api.project.save(snapshot(project.value))
    ElMessage.success('已复制')
  } catch (e) {
    ElMessage.error(`复制失败：${e instanceof Error ? e.message : String(e)}`)
  }
  menu.close()
}

async function deleteCharacter(char: Character) {
  if (!project.value) return
  if (!throttleTap('char-delete-' + char.id, 1000)) return

  const usedBy = project.value.shots.filter(s => s.characterIds.includes(char.id))
  if (usedBy.length > 0) {
    menu.close()
    ElMessage.warning(`角色被 ${usedBy.length} 个分镜引用，无法删除`)
    return
  }

  const ok = await confirmDanger(`确定删除角色「${char.name}」吗？此操作不可恢复。`, {
    title: '删除角色',
    confirmText: '删除'
  })
  menu.close()
  if (!ok) return
  try {
    project.value.characters = project.value.characters.filter(c => c.id !== char.id)
    await window.api.project.save(snapshot(project.value))
    ElMessage.success('删除成功')
  } catch (e) {
    ElMessage.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

/** REQ-12 RA-12：音色短名统一取 shared 清单，三处下拉与命名不再各自维护 */
function voiceName(voice: string) {
  return ttsVoiceName(voice)
}

</script>

<style scoped>
.empty-panel { padding: 36px 16px; }
.wf-picker { display: flex; align-items: center; gap: 6px; margin-right: 4px; }
.wf-label { font-size: 12px; color: var(--text-muted); }
.toolbar { margin-bottom: 12px; }
.character-grid {  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
}
.character-card {
  cursor: context-menu;
  animation: fade-up var(--dur-slow) var(--ease-out) both;
}
.character-card :deep(.el-card__body) { padding: 14px; }

.asset-row { display: flex; gap: 8px; }
.asset-slot {
  position: relative;
  flex: 1;
  height: 148px;
  background: rgba(0, 0, 0, 0.22);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  cursor: pointer;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-weak);
  transition: border-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.asset-slot:hover {
  border-color: var(--glass-border-strong);
  transform: translateY(-1px);
}
.asset-slot.wide { flex: 1.4; }
.asset-slot img {
  max-width: 100%;
  max-height: 100%;
  object-fit: cover;
  transition: transform var(--dur-slow) var(--ease-out);
}
.asset-slot:hover img { transform: scale(1.03); }
.asset-label {
  position: absolute;
  left: 8px;
  bottom: 6px;
  font-size: 11px;
  color: var(--text-primary);
  background: rgba(10, 14, 20, 0.55);
  backdrop-filter: blur(8px);
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid var(--border-weak);
}
.no-image { color: var(--text-muted); font-size: 12px; }
.char-info { padding: 12px 0 4px; }
.char-info h3 {
  font-family: var(--font-display);
  color: var(--text-primary);
  margin-bottom: 4px;
  font-size: 16px;
}
.char-info p { color: var(--text-secondary); font-size: 12px; margin: 2px 0; }
.voice { color: var(--accent) !important; }
.char-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.menu-tip { margin-left: auto; font-size: 11px; color: var(--text-muted); }
</style>


