<template>
    <!-- 分镜审核对话框：先分镜图后视频，逐镜核对踩坑点（视角/表情/人物数/场景/道具/构图） -->
    <el-dialog v-model="visible" title="分镜审核" width="880px" top="6vh">
      <div v-if="shot" class="review-layout">
        <div class="review-left">
          <img
            v-if="imageUrl"
            :src="imageUrl"
            class="review-img"
          />
          <div v-else class="review-img empty">该镜尚无分镜图（首帧/场景板），可先「重出首帧」或绑定场景板</div>
        </div>
        <div class="review-right">
          <div class="review-meta">
            <div class="review-meta-row"><span class="meta-label">场景</span><span class="meta-value">{{ shot.scene || '（未填）' }}</span></div>
            <div class="review-meta-row">
<span class="meta-label">角色</span>
              <span class="meta-value">
                <el-tag v-for="cid in shot.characterIds" :key="cid" size="small" style="margin-right:4px">
                  {{ getCharacterName(cid) }}
                </el-tag>
                <span v-if="!shot.characterIds.length" style="color:#c0504d">未绑定角色</span>
              </span>
            </div>
            <div class="review-meta-row"><span class="meta-label">景别</span><span class="meta-value">{{ shot.shotSize || '未设（默认中景）' }}</span></div>
            <div class="review-meta-row"><span class="meta-label">机位/运镜</span><span class="meta-value">{{ shot.camera || '未设' }}</span></div>
            <div class="review-meta-row"><span class="meta-label">情绪/表情</span><span class="meta-value">{{ shot.emotion || '未设' }}</span></div>
            <div class="review-meta-row"><span class="meta-label">关键道具</span><span class="meta-value">{{ shot.props?.length ? shot.props.join('、') : '未列' }}</span></div>
          </div>
          <div class="review-checklist">
            <div class="checklist-title">踩坑核对清单（对照生成的分镜图逐项看）</div>
            <div class="check-item" :class="{ ok: !!shot.camera, bad: !shot.camera }">
              <span class="check-dot">{{ shot.camera ? '✓' : '⚠' }}</span>
              <span class="check-text">{{ shot.camera ? '机位/视角已设定：' + shot.camera : '视角/机位未设定——看分镜图视角是否有代入感' }}</span>
            </div>
            <div class="check-item" :class="{ ok: !!shot.emotion, bad: !shot.emotion }">
              <span class="check-dot">{{ shot.emotion ? '✓' : '⚠' }}</span>
              <span class="check-text">{{ shot.emotion ? '表情/情绪已设定：' + shot.emotion : '表情/情绪未设定——看人物表情状态是否符合剧情' }}</span>
            </div>
            <div class="check-item" :class="{ ok: shot.characterIds.length > 0, bad: shot.characterIds.length === 0 }">
              <span class="check-dot">{{ shot.characterIds.length ? '✓' : '⚠' }}</span>
              <span class="check-text">
                {{ shot.characterIds.length
                  ? `人物数量=${shot.characterIds.length}，核对分镜图是否正好这些人数、无多余路人`
                  : '未绑定角色——人物镜必须建档绑定；核对分镜图人物数量' }}
              </span>
            </div>
            <div class="check-item" :class="{ ok: !!shot.sceneBoardId, bad: !shot.sceneBoardId }">
              <span class="check-dot">{{ shot.sceneBoardId ? '✓' : '⚠' }}</span>
              <span class="check-text">{{ shot.sceneBoardId ? '场景已挂场景板（场景风格统一）' : '未挂场景板——场景易穿帮，建议绑定场景资产' }}</span>
            </div>
            <div class="check-item" :class="{ ok: (shot.props?.length || 0) > 0, bad: !shot.props?.length }">
              <span class="check-dot">{{ shot.props?.length ? '✓' : '⚠' }}</span>
              <span class="check-text">{{ shot.props?.length ? '道具已锁定：' + shot.props.join('、') : '未列道具——本镜有道具的请补填，防止道具变样/消失' }}</span>
            </div>
            <div class="check-item" :class="{ ok: !!shot.shotSize, bad: !shot.shotSize }">
              <span class="check-dot">{{ shot.shotSize ? '✓' : '⚠' }}</span>
              <span class="check-text">{{ shot.shotSize ? '景别已设定：' + shot.shotSize + '，核对构图是否符合景别' : '景别未设定——核对构图与取景' }}</span>
            </div>
            <div class="check-confirm">
              <el-checkbox
                :model-value="shot ? !!shot.reviewed : false"
                @update:model-value="onCheckUpdate"
                @change="() => emit('reviewed')"
              >
我已核对本镜分镜图，确认无误
</el-checkbox>
              <div class="form-tip">确认后渲染前可据此跳过；发现问题点「重出首帧」或点「编辑」修改</div>
            </div>
          </div>
        </div>
      </div>
      <template #footer>
        <div style="display:flex;align-items:center;gap:8px;">
          <el-button
            :disabled="index <= 0"
            @click="index > 0 && emit('navigate', index - 1)"
          >
            <el-icon><ArrowLeft /></el-icon> 上一镜
          </el-button>
          <el-button
            :disabled="index >= total - 1"
            @click="index < total - 1 && emit('navigate', index + 1)"
          >
            下一镜 <el-icon><ArrowRight /></el-icon>
          </el-button>
          <span style="font-size:13px;color:var(--text-muted);margin:0 6px;">
            {{ total ? `第 ${index + 1} / ${total} 镜` : '' }}
          </span>
          <div style="flex:1" />
          <el-button :loading="regenerating" @click="regenerateFirst">
            <el-icon><MagicStick /></el-icon> 重出首帧（定妆图参考）
          </el-button>
          <el-button :loading="regenerating" @click="regenerateLast">
            <el-icon><RefreshLeft /></el-icon> 重出尾帧（首帧参考）
          </el-button>
          <el-button @click="emit('edit')">编辑本镜</el-button>
          <el-button type="primary" @click="visible = false">完成</el-button>
        </div>
      </template>
    </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { ArrowLeft, ArrowRight, MagicStick, RefreshLeft } from '@element-plus/icons-vue'
import { useFileUrl } from '../../composables/useFileUrl'
import type { Character, Shot } from '../../../../shared/ipcTypes'
import { characterPrimaryRef } from '../../../../shared/ipcTypes'
import { shotFramePrompt } from '../../../../shared/imagePrompts'

const props = defineProps<{
  shot: Shot | null
  imageUrl: string
  index: number
  total: number
  characters: Character[]
  projectId: string
  projectExists: boolean
  /** 持久化项目（父级实现：落盘 + 失败提示） */
  onPersist: () => Promise<boolean>
}>()

const emit = defineEmits<{
  navigate: [index: number]
  edit: []
  reviewed: []
}>()

// v-model:visible（:model-value + @update:model-value 语义，拆分后弹窗双向绑定不破）
const visible = defineModel<boolean>('visible', { default: false })

function getCharacterName(id: string) {
  return props.characters.find(c => c.id === id)?.name || '未知'
}

// 审核勾选：回写本镜 reviewed 标记（对象引用自父级，改动直接落回父级 reactive 状态）
function onCheckUpdate(v: string | number | boolean) {
  if (props.shot) props.shot.reviewed = Boolean(v)
}

// ===== 重出首帧/尾帧（本弹窗专属逻辑）=====
const { ensureFileUrls } = useFileUrl()
const regenerating = ref(false)

const reviewCharRef = computed(() => {
  const s = props.shot
  if (!s) return ''
  const c = props.characters.find((x: Character) => s.characterIds.includes(x.id))
  return c ? characterPrimaryRef(c) : ''
})

/** 重出首帧：i2v 镜用角色定妆图做参考图生（锁脸/发型/服装），注入场景/姿态/道具强约束 */
async function regenerateFirst(): Promise<void> {
  const s = props.shot
  if (!s || !props.projectExists) return
  if (s.type === 't2v') {
    ElMessage.warning('空镜没有首帧，请在编辑里生成场景图')
    return
  }
  regenerating.value = true
  try {
    const scene = s.scene || 'cinematic scene'
    const look = s.characterIds
      .map(id => props.characters.find(c => c.id === id))
      .filter((c): c is Character => Boolean(c))
      .map(c => c.appearanceLock || c.description)
      .filter(Boolean)
      .join('; ') || 'chinese person, natural everyday appearance'
    const refAbs = reviewCharRef.value
    const rel = `projects/${props.projectId}/shots/${s.id}_first_review.png`
    const propCue = s.props?.length
      ? `，关键道具必须原样出现：${s.props.join(', ')}`
      : ''
    let prompt: string
    const opts: Record<string, unknown> = { width: 768, height: 1152 }
    if (refAbs) {
      prompt = `把图1中的人物放入场景「${scene}」：${s.action}${propCue}。保持面部、发型、服装、肤色与图1完全一致，写实电影感，自然光影，背景符合场景氛围。`
      opts.workflowName = 'qwen2511_i2i_edit'
      // 参考图需绝对路径（imageService 直接上传），相对路径用 resolvePath 转绝对
      opts.referenceImagePath = await window.api.file.resolvePath(refAbs)
    } else {
      prompt = shotFramePrompt({
        phase: 'start',
        lookEn: look,
        scene,
        action: s.action || 'standing',
        characterCount: s.characterIds.length || 1,
        props: s.props,
        camera: s.camera || undefined,
        emotion: s.emotion || undefined
      })
    }
    await window.api.image.generate(prompt, rel, opts)
    s.firstFramePath = rel
    // 分镜图已更换，旧审核结论作废，须重新核对
    s.reviewed = undefined
    await props.onPersist()
    await ensureFileUrls([rel])
    ElMessage.success('首帧已重出（定妆图参考，锁脸锁服装），该镜需重新核对分镜图')
  } catch (e) {
    ElMessage.error(`重出首帧失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    regenerating.value = false
  }
}

/** 重出尾帧：以本镜首帧为参考（锁画面延续），按尾帧提示词生成连镜尾帧，供首尾帧工作流衔接 */
async function regenerateLast(): Promise<void> {
  const s = props.shot
  if (!s || !props.projectExists) return
  if (s.type === 't2v' || !s.firstFramePath) {
    ElMessage.warning('尾帧需要基于首帧生成，请先重出首帧')
    return
  }
  regenerating.value = true
  try {
    const rel = `projects/${props.projectId}/shots/${s.id}_last_review.png`
    const propCue = s.props?.length
      ? `，关键道具必须原样出现：${s.props.join(', ')}`
      : ''
    const endCue = s.lastFrameEn?.trim() || s.action
    const prompt = `以图1为起始画面，生成该镜头结束瞬间的画面：${endCue}${propCue}。保持同一人物、面部、发型、服装、肤色、场景与光线方向与图1完全一致，写实电影感，动作自然承接图1的进行状态，画面不穿帮。`
    await window.api.image.generate(prompt, rel, {
      width: 768,
      height: 1152,
      workflowName: 'qwen2511_i2i_edit',
      // 参考图需绝对路径（imageService 直接上传），首帧相对路径用 resolvePath 转绝对
      referenceImagePath: await window.api.file.resolvePath(s.firstFramePath)
    })
    s.lastFramePath = rel
    // 分镜图已更换，旧审核结论作废，须重新核对
    s.reviewed = undefined
    await props.onPersist()
    await ensureFileUrls([rel])
    ElMessage.success('尾帧已重出（首帧参考，衔接下一镜），该镜需重新核对分镜图')
  } catch (e) {
    ElMessage.error(`重出尾帧失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    regenerating.value = false
  }
}
</script>

<style scoped>
/* ===== 分镜审核 ===== */
.review-layout { display: flex; gap: 18px; min-height: 380px; }
.review-left { flex: 0 0 300px; }
.review-img {
  width: 300px; height: 450px; object-fit: cover; border-radius: 8px;
  border: 1px solid var(--border-strong); background: var(--bg-input);
}
.review-img.empty {
  display: flex; align-items: center; justify-content: center;
  color: var(--text-muted); font-size: 13px; text-align: center; padding: 0 12px;
}
.review-right { flex: 1; display: flex; flex-direction: column; gap: 12px; }
.review-meta { display: flex; flex-direction: column; gap: 6px; }
.review-meta-row { display: flex; font-size: 13px; }
.meta-label { flex: 0 0 72px; color: var(--text-muted); }
.meta-value { flex: 1; color: var(--text-primary); word-break: break-all; }
.review-checklist {
  background: var(--bg-input); border: 1px solid var(--border-strong);
  border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px;
}
.checklist-title { font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 2px; }
.check-item { display: flex; align-items: baseline; gap: 6px; font-size: 13px; }
.check-dot { font-weight: 700; }
.check-item.ok .check-dot { color: #2e7d46; }
.check-item.bad .check-dot { color: #c0504d; }
.check-item.ok .check-text { color: var(--text-secondary); }
.check-item.bad .check-text { color: #8a5a3c; }
.check-confirm { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border-strong); }
.check-confirm .form-tip { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
</style>
