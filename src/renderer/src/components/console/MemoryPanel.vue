<template>
  <div class="panel panel-fill">
    <div class="panel-title skills-title">
      导演记忆库
      <el-button type="primary" size="small" :icon="Plus" @click="emit('openDialog')">新增记忆</el-button>
    </div>
    <p class="skills-tip">
      跨项目长期记忆，会在每次对话时注入导演的系统上下文：<b>用户偏好</b>是你的创作喜好，
      <b>制作规则</b>是拆镜与生产规范，<b>经验教训</b>是踩坑后沉淀的避坑要点。导演在对话中也会用「沉淀记忆」技能自动记录。
    </p>
    <el-tabs
      :model-value="memoryKind"
      @update="onKindChange"
      class="memory-tabs"
    >
      <el-tab-pane v-for="k in memoryKindOptions" :key="k.value" :name="k.value">
        <template #label>{{ k.label }}（{{ memoryCountOf(k.value) }}）</template>
      </el-tab-pane>
    </el-tabs>
    <div class="skill-list">
      <div v-for="m in filteredMemories" :key="m.id" class="skill-item memory-item">
        <div class="skill-main">
          <div class="skill-head">
            <span class="skill-name">{{ m.title }}</span>
          </div>
          <div class="memory-content">{{ m.content }}</div>
          <div class="memory-time">更新于 {{ formatDateTime(m.updatedAt) }}</div>
        </div>
        <div class="skill-ops">
          <el-button link size="small" :icon="EditPen" @click="emit('openDialog', m)">编辑</el-button>
          <el-button link size="small" type="danger" :icon="Delete" @click="emit('remove', m)">删除</el-button>
        </div>
      </div>
      <el-empty v-if="!filteredMemories.length" :image-size="70" description="暂无记忆，新增一条或让导演在对话中沉淀" />
    </div>
  </div>

  <!-- 记忆编辑弹窗 -->
  <el-dialog
    :model-value="memoryDialog.visible"
    @update="onVisibleChange"
    :title="editingMemory ? '编辑记忆' : '新增记忆'"
    width="560px"
    :close-on-click-modal="false"
  >
    <el-form label-width="84px">
      <el-form-item label="分类" required>
        <el-select v-model="memoryDialog.kind" style="width: 200px">
          <el-option v-for="k in memoryKindOptions" :key="k.value" :label="k.label" :value="k.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="标题" required>
        <el-input v-model="memoryDialog.title" maxlength="30" show-word-limit placeholder="一句话标题，如：台词偏口语化" />
      </el-form-item>
      <el-form-item label="内容" required>
        <el-input
          v-model="memoryDialog.content"
          type="textarea"
          :rows="6"
          maxlength="500"
          show-word-limit
          placeholder="具体、可执行的记忆内容"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="emit('closeDialog')">取消</el-button>
      <el-button type="primary" :loading="memorySaving" @click="emit('saveDialog')">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Plus, EditPen, Delete } from '@element-plus/icons-vue'
import type { MemoryItem, MemoryKind } from '../../../../shared/ipcTypes'

const props = defineProps<{
  memories: MemoryItem[]
  memoryKind: MemoryKind
  memoryKindOptions: ReadonlyArray<{ value: MemoryKind; label: string }>
  memoryDialog: { visible: boolean; kind: MemoryKind; title: string; content: string }
  editingMemory: MemoryItem | null
  memorySaving: boolean
}>()

const emit = defineEmits<{
  'update:memoryKind': [kind: MemoryKind]
  remove: [memory: MemoryItem]
  openDialog: [memory?: MemoryItem]
  saveDialog: []
  closeDialog: []
}>()

const filteredMemories = computed(() =>
  props.memories.filter(m => m.kind === props.memoryKind)
)
function memoryCountOf(kind: MemoryKind): number {
  return props.memories.filter(m => m.kind === kind).length
}
function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function onKindChange(val: string | number): void {
  emit('update:memoryKind', val as MemoryKind)
}
function onVisibleChange(val: boolean | string): void {
  if (val === false) emit('closeDialog')
}
</script>

<style scoped>
.panel {
  background: var(--bg-card);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  padding: 14px 16px;
}
.panel-fill {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}
.panel-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 10px;
  display: flex;
  align-items: center;
}

.skills-title { justify-content: space-between; }
.skills-tip {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.7;
  margin: 0 0 14px;
}
.skill-list { display: flex; flex-direction: column; gap: 10px; }
.skill-item {
  display: flex;
  align-items: center;
  gap: 14px;
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  padding: 12px 14px;
  background: var(--bg-app, transparent);
}
.skill-main { flex: 1; min-width: 0; }
.skill-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.skill-name { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.skill-ops { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }

.memory-tabs { margin-bottom: 6px; }
.memory-tabs :deep(.el-tabs__header) { margin-bottom: 10px; }
.memory-item { align-items: flex-start; }
.memory-content {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}
.memory-time { font-size: 11px; color: var(--text-muted); margin-top: 6px; }
.memory-item .skill-ops { margin-top: 2px; }
</style>
