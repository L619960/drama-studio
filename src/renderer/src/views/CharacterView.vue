<template>
  <div class="character-view">
    <div class="header">
      <h1>角色库</h1>
      <el-button type="primary" @click="showAddDialog = true">
        <el-icon><Plus /></el-icon>添加角色
      </el-button>
    </div>

    <div class="character-grid">
      <el-card
        v-for="char in characters"
        :key="char.id"
        class="character-card"
        @contextmenu.prevent="onCardContextMenu(char, $event)"
      >
        <div class="char-image" @click="previewImage(char)">
          <img v-if="char.refImagePath" :src="urlCache[char.refImagePath]" alt="定妆图" />
          <div v-else class="no-image">暂无定妆图</div>
        </div>
        <div class="char-info">
          <h3>{{ char.name }}</h3>
          <p>{{ char.description || '暂无描述' }}</p>
          <p class="voice">音色: {{ voiceName(char.voice) }}</p>
        </div>
        <div class="char-actions">
          <el-button size="small" @click="importImage(char.id)">
            <el-icon><Upload /></el-icon>定妆图
          </el-button>
          <el-button size="small" :loading="generatingImage === char.id" @click="generatePortrait(char)">
            <el-icon><MagicStick /></el-icon>AI 生成
          </el-button>
          <el-button size="small" @click="editCharacter(char)">
            <el-icon><Edit /></el-icon>编辑
          </el-button>
          <el-button size="small" type="danger" @click="deleteCharacter(char)">
            <el-icon><Delete /></el-icon>
          </el-button>
        </div>
      </el-card>
    </div>

    <!-- 右键菜单 -->
    <teleport to="body">
      <div
        v-if="contextMenu.visible"
        class="context-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
        @click.stop
      >
        <div class="menu-item" @click="importImage(contextMenu.char!.id)">
          <el-icon><Upload /></el-icon>更换定妆图
        </div>
        <div class="menu-item" @click="editCharacter(contextMenu.char!)">
          <el-icon><Edit /></el-icon>编辑信息
        </div>
        <div class="menu-item" @click="previewVoice(contextMenu.char!)">
          <el-icon><VideoPlay /></el-icon>试听音色
        </div>
        <div class="menu-divider" />
        <div class="menu-item" @click="copyCharacter(contextMenu.char!)">
          <el-icon><CopyDocument /></el-icon>复制角色
        </div>
        <div class="menu-divider" />
        <div
          class="menu-item danger"
          :class="{ disabled: isCharUsed(contextMenu.char!.id) }"
          @click="!isCharUsed(contextMenu.char!.id) && deleteCharacter(contextMenu.char!)"
        >
          <el-icon><Delete /></el-icon>删除角色
          <span v-if="isCharUsed(contextMenu.char!.id)" class="menu-tip">被分镜使用</span>
        </div>
      </div>
    </teleport>

    <!-- 添加/编辑对话框 -->
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
            <el-option label="小晓 (女声)" value="zh-CN-XiaoxiaoNeural" />
            <el-option label="云健 (男声)" value="zh-CN-YunjianNeural" />
            <el-option label="小艺 (女声)" value="zh-CN-XiaoyiNeural" />
            <el-option label="云野 (男声)" value="zh-CN-YunyeNeural" />
            <el-option label="云杰 (男声)" value="zh-CN-YunjieNeural" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddDialog = false">取消</el-button>
        <el-button type="primary" @click="saveCharacter">保存</el-button>
      </template>
    </el-dialog>

    <!-- 图片预览 -->
    <el-dialog v-model="previewVisible" title="定妆图预览" width="600px">
      <img :src="urlCache[previewPath]" style="width: 100%" />
    </el-dialog>

    <!-- 音色试听 -->
    <el-dialog v-model="voicePreviewVisible" title="音色试听" width="420px">
      <p style="color:var(--text-secondary); margin-bottom: 12px">{{ voicePreviewName }}</p>
      <audio v-if="voicePreviewUrl" :src="voicePreviewUrl" controls autoplay style="width: 100%" />
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Upload, Edit, Delete, VideoPlay, CopyDocument, MagicStick } from '@element-plus/icons-vue'
import type { Project, Character } from '../../../shared/ipcTypes'
import { useFileUrl } from '../composables/useFileUrl'
import { snapshot } from '../utils/snapshot'

const { urlCache, ensureFileUrl, ensureFileUrls } = useFileUrl()

const route = useRoute()
const projectId = route.params.id as string

const project = ref<Project | null>(null)
const showAddDialog = ref(false)
const editingChar = ref<Character | null>(null)
const charForm = ref({ name: '', description: '', voice: 'zh-CN-XiaoxiaoNeural' })
const previewVisible = ref(false)
const previewPath = ref('')
// TTS 默认音色（从设置加载，新建角色时使用）
const defaultVoice = ref('zh-CN-XiaoxiaoNeural')

// 音色试听
const voicePreviewVisible = ref(false)
const voicePreviewUrl = ref('')
const voicePreviewName = ref('')

// 右键菜单
const contextMenu = ref({ visible: false, x: 0, y: 0, char: null as Character | null })

// AI 生成定妆图
const generatingImage = ref('')

const characters = computed(() => project.value?.characters || [])

// 角色是否被任意分镜引用（用于右键菜单删除项置灰）
function isCharUsed(charId: string): boolean {
  return (project.value?.shots || []).some(s => s.characterIds.includes(charId))
}

onMounted(async () => {
  loadProject()
  document.addEventListener('click', closeContextMenu)
  try {
    const s = await window.api.settings.get()
    if (s?.tts?.defaultVoice) defaultVoice.value = s.tts.defaultVoice
  } catch {
    // 保持默认
  }
})

onUnmounted(() => {
  document.removeEventListener('click', closeContextMenu)
})

async function loadProject() {
  project.value = await window.api.project.get(projectId)
  // 解析全部定妆图 URL
  const paths = project.value.characters.map(c => c.refImagePath).filter(Boolean)
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
  contextMenu.value.visible = false
}

async function saveCharacter() {
  if (!project.value || !charForm.value.name.trim()) {
    ElMessage.warning('请输入名称')
    return
  }

  if (editingChar.value) {
    // 编辑
    editingChar.value.name = charForm.value.name
    editingChar.value.description = charForm.value.description
    editingChar.value.voice = charForm.value.voice
  } else {
    // 新增
    const char: Character = {
      id: `char_${Date.now()}`,
      name: charForm.value.name,
      description: charForm.value.description,
      voice: charForm.value.voice,
      refImagePath: ''
    }
    project.value.characters.push(char)
  }

  await window.api.project.save(snapshot(project.value))
  showAddDialog.value = false
  ElMessage.success('保存成功')
}

async function importImage(charId: string) {
  if (!project.value) return
  try {
    const imagePath = await window.api.character.importImage(projectId)
    const char = project.value.characters.find(c => c.id === charId)
    if (char) {
      char.refImagePath = imagePath
      await window.api.project.save(snapshot(project.value))
      // 解析新图 URL，否则卡片无 src 显示破图
      await ensureFileUrl(imagePath)
      ElMessage.success('导入成功')
    }
  } catch (e) {
    ElMessage.error('导入失败')
  }
  contextMenu.value.visible = false
}

/** AI 生成定妆图：用角色名+描述构建提示词，调 ComfyUI T2I 生成 */
async function generatePortrait(char: Character) {
  if (!project.value) return
  generatingImage.value = char.id
  try {
    const desc = char.description || char.name
    // 固定指定中国面孔：文生图模型默认西方面孔，中文短剧必须显式声明
    const prompt = `cinematic portrait, upper body shot, chinese person, ${desc}, beautiful face, detailed eyes, soft lighting, high quality, 8k`
    const rel = `projects/${projectId}/characters/${char.id}_ai.png`
    await window.api.image.generate(prompt, rel)
    char.refImagePath = rel
    await window.api.project.save(snapshot(project.value))
    await ensureFileUrl(rel)
    ElMessage.success('定妆图生成成功')
  } catch (e) {
    ElMessage.error(`生成失败: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    generatingImage.value = ''
  }
}

async function previewImage(char: Character) {
  if (!char.refImagePath) return
  await ensureFileUrl(char.refImagePath)
  previewPath.value = char.refImagePath
  previewVisible.value = true
}

async function previewVoice(char: Character) {
  try {
    const rel = await window.api.tts.preview(char.voice)
    voicePreviewUrl.value = await ensureFileUrl(rel)
    voicePreviewName.value = `${voiceName(char.voice)} · ${char.voice}`
    voicePreviewVisible.value = true
  } catch {
    ElMessage.error('试听生成失败，请稍后重试')
  }
  contextMenu.value.visible = false
}

function copyCharacter(char: Character) {
  if (!project.value) return
  const copy: Character = {
    ...char,
    id: `char_${Date.now()}`,
    name: `${char.name} (副本)`,
    refImagePath: char.refImagePath
  }
  project.value.characters.push(copy)
  window.api.project.save(snapshot(project.value))
  ElMessage.success('已复制')
  contextMenu.value.visible = false
}

async function deleteCharacter(char: Character) {
  if (!project.value) return

  // 检查是否被分镜引用
  const usedBy = project.value.shots.filter(s => s.characterIds.includes(char.id))
  if (usedBy.length > 0) {
    ElMessage.warning(`角色被 ${usedBy.length} 个分镜引用，无法删除`)
    return
  }

  try {
    await ElMessageBox.confirm(`确定删除角色「${char.name}」吗？`, '删除确认', { type: 'warning' })
    project.value.characters = project.value.characters.filter(c => c.id !== char.id)
    await window.api.project.save(snapshot(project.value))
    ElMessage.success('删除成功')
  } catch {
    // 取消
  }
  contextMenu.value.visible = false
}

// 右键菜单
function onCardContextMenu(char: Character, event: MouseEvent) {
  event.preventDefault()
  contextMenu.value = { visible: true, x: event.clientX, y: event.clientY, char }
}

function closeContextMenu() {
  contextMenu.value.visible = false
}

function voiceName(voice: string) {
  const map: Record<string, string> = {
    'zh-CN-XiaoxiaoNeural': '小晓',
    'zh-CN-YunjianNeural': '云健',
    'zh-CN-XiaoyiNeural': '小艺',
    'zh-CN-YunyeNeural': '云野',
    'zh-CN-YunjieNeural': '云杰'
  }
  return map[voice] || voice
}
</script>

<style scoped>
.character-view { padding: 20px; }
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
.header h1 { font-size: 24px; color: var(--text-primary); }

.character-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 16px; }
.character-card { background: var(--bg-card); border: 1px solid var(--border); cursor: context-menu; }
.char-image { height: 150px; background: var(--bg-sidebar); display: flex; align-items: center; justify-content: center; overflow: hidden; cursor: pointer; }
.char-image img { max-width: 100%; max-height: 100%; object-fit: cover; }
.no-image { color: var(--text-muted); }
.char-info { padding: 12px 0; }
.char-info h3 { color: var(--text-primary); margin-bottom: 4px; }
.char-info p { color: var(--text-secondary); font-size: 12px; margin: 2px 0; }
.voice { color: #67c23a !important; }
.char-actions { display: flex; gap: 8px; flex-wrap: wrap; }

/* 右键菜单 */
.context-menu {
  position: fixed;
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  padding: 4px 0;
  min-width: 160px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  z-index: 9999;
}
.menu-item {
  padding: 8px 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: var(--text-primary);
  font-size: 14px;
}
.menu-item:hover { background: var(--border-strong); }
.menu-item.danger { color: #f56c6c; }
.menu-divider { height: 1px; background: var(--border-strong); margin: 4px 0; }
</style>
