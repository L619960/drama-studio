<template>
  <div class="panel panel-fill">
    <div class="panel-title skills-title">
      技能管理
      <el-button type="primary" size="small" :icon="Plus" @click="emit('openDialog')">新建技能</el-button>
    </div>
    <p class="skills-tip">
      技能是导演在对话中可调用的能力。<b>内置操作</b>绑定真实功能（开拍、暂停、重渲等），开关即授权；
      <b>自定义技能</b>是提示词模板，可把你的常用指令沉淀为一键能力，模板中用
      <code v-text="'{{input}}'" /> 代表对话里的具体要求。
    </p>
    <div class="skill-list">
      <div v-for="s in skills" :key="s.id" class="skill-item">
        <div class="skill-main">
          <div class="skill-head">
            <span class="skill-name">{{ s.name }}</span>
            <el-tag size="small" :type="s.builtin ? 'success' : 'warning'" effect="plain">
              {{ s.builtin ? '内置操作' : '自定义' }}
            </el-tag>
          </div>
          <div class="skill-desc">{{ s.description }}</div>
        </div>
        <div class="skill-ops">
          <el-button v-if="!s.builtin" link size="small" :icon="EditPen" @click="emit('openDialog', s)">编辑</el-button>
          <el-button v-if="!s.builtin" link size="small" type="danger" :icon="Delete" @click="emit('remove', s)">删除</el-button>
          <el-switch :model-value="s.enabled" @change="(v: boolean) => emit('toggle', s, v)" />
        </div>
      </div>
    </div>
  </div>

  <!-- 自定义技能编辑弹窗 -->
  <el-dialog
    :model-value="skillDialog.visible"
    @update:model-value="onVisibleChange"
    :title="editingSkill ? '编辑技能' : '新建技能'"
    width="560px"
    :close-on-click-modal="false"
  >
    <el-form label-width="84px">
      <el-form-item label="技能名称" required>
        <el-input v-model="skillDialog.name" maxlength="20" show-word-limit placeholder="例如：古风润色师" />
      </el-form-item>
      <el-form-item label="能力说明" required>
        <el-input
          v-model="skillDialog.description"
          type="textarea"
          :rows="2"
          maxlength="120"
          show-word-limit
          placeholder="告诉导演什么时候该用这个技能"
        />
      </el-form-item>
      <el-form-item label="提示词模板">
        <el-input
          v-model="skillDialog.promptTemplate"
          type="textarea"
          :rows="7"
          placeholder="例如：你是资深古风编剧，请把用户的台词改写为半文言风格，保留原意。用户要求：{{input}}"
        />
      </el-form-item>
      <div class="skill-dialog-hint">用 <code v-text="'{{input}}'" /> 引用对话里的具体要求；导演调用时会按模板走一次大模型生成。</div>
    </el-form>
    <template #footer>
      <el-button @click="emit('closeDialog')">取消</el-button>
      <el-button type="primary" :loading="skillSaving" @click="emit('saveDialog')">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { Plus, EditPen, Delete } from '@element-plus/icons-vue'
import type { Skill } from '../../../../shared/ipcTypes'

const props = defineProps<{
  skills: Skill[]
  skillDialog: { visible: boolean; name: string; description: string; promptTemplate: string }
  editingSkill: Skill | null
  skillSaving: boolean
}>()

const emit = defineEmits<{
  toggle: [skill: Skill, enabled: boolean]
  remove: [skill: Skill]
  openDialog: [skill?: Skill]
  saveDialog: []
  closeDialog: []
}>()

// el-dialog v-model 在父子分离下用 :model-value + @update；壳内部更新 visible
function onVisibleChange(val: boolean | string): void {
  // 关闭时（false）通知壳以便同步 composable 内的 skillDialog.visible
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
.skills-tip code, .skill-dialog-hint code {
  background: var(--bg-input);
  border-radius: 3px;
  padding: 0 5px;
  color: #67c23a;
  font-size: 12px;
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
.skill-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.skill-ops { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.skill-dialog-hint {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
  padding-left: 84px;
}
</style>
