import { LLMService } from './llmService'
import { ImageService } from './imageService'
import { TaskQueue } from './taskQueue'
import { FFmpegService } from './ffmpegService'
import { SubtitleService } from './subtitleService'
import { ProjectStore } from './projectStore'
import { SettingsStore } from './settingsStore'
import type {
  DirectorState, DirectorStage, StageStatus
} from '../../shared/ipcTypes'
import {
  repairCastText, chooseRenderWorkflow, safeMotionFromAction
} from '../../shared/imagePrompts'
import { CandidatePickService } from './candidatePickService'
import { SkillLibrary } from './skillLibrary'

/**
 * 阶段方法的运行时依赖：DirectorAgent 类自身满足此接口，
 * 拆出去的阶段函数以参数注入方式使用（不改变任何行为）。
 */
export interface DirectorStageRuntime {
  baseDir: string
  states: Map<string, DirectorState>
  gates: Map<string, Set<DirectorStage>>
  healBudget: Map<string, number>
  visionWarned: Set<string>
  picker: CandidatePickService
  store: ProjectStore
  llm: LLMService
  image: ImageService
  queue: TaskQueue
  ffmpeg: FFmpegService
  subtitles: SubtitleService
  settings: SettingsStore
  skills: SkillLibrary
  isCancelled(projectId: string): boolean
  log(projectId: string, stage: DirectorStage, level: 'info' | 'success' | 'warn' | 'error', message: string): void
  setStage(projectId: string, stage: DirectorStage, status: StageStatus, message?: string, percent?: number): void
  finish(projectId: string, doneMessage?: string): void
  maybeGate(projectId: string, afterStage: DirectorStage): Promise<void>
  pauseUntilShotsReviewed(projectId: string): Promise<boolean>
  subscribeRenderProgress(projectId: string): void
  unsubscribeRenderProgress(projectId: string): void
  ensureShadowState(projectId: string): DirectorState
  emitProgressEvent(projectId: string): void
  notifyProjectUpdated(projectId: string): void
}

/** 出视频前：串戏提示词改成一句英文动作，并写上选定的工作流。 */
export async function lockPromptsAndWorkflow(rt: DirectorStageRuntime, projectId: string): Promise<void> {
  const project = await rt.store.get(projectId)
  const settings = await rt.settings.get()
  const notes: string[] = []
  for (const shot of project.shots) {
    const char = project.characters.find(c => c.id === shot.characterIds[0])
    const look = char?.appearanceLock || ''
    const fields = ['promptEn', 'firstFrameEn', 'midFrameEn', 'lastFrameEn', 'transitionEn', 'handoffToNext'] as const
    for (const field of fields) {
      let next = repairCastText(shot[field], shot.action || '', look, field === 'promptEn' ? 'motion' : 'frame')
      // 对戏英文名/肢体接触即使没触发定妆中毒，也必须压成单人单拍（成片镜1/6 根因）
      if (field === 'promptEn' && next && (
        /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/.test(next) ||
        /\b(?:collides?|leans?\s+close|gripping|embraces?|hugs?)\b/i.test(next)
      )) {
        next = safeMotionFromAction(shot.action || '', look)
      }
      if (shot[field] && next && next !== shot[field]) {
        shot[field] = next
        notes.push(`第${shot.index}镜 ${field} 已改成动作句`)
      }
    }
    if (!shot.workflow) {
      const choice = chooseRenderWorkflow({
        dialogue: shot.dialogue,
        action: shot.action,
        hasEndFrame: Boolean(shot.lastFramePath),
        defaultWorkflow: project.defaultWorkflow || settings.workflow.default
      })
      shot.workflow = choice.workflow
      notes.push(`第${shot.index}镜工作流 ${choice.workflow}（${choice.reason}）`)
    }
  }
  await rt.store.save(project)
  if (notes.length) {
    rt.log(projectId, 'render', 'warn', `出视频前核对 ${notes.length} 处：${notes.slice(0, 8).join('；')}`)
  }
}

// ===== 以下为子域模块的兼容再导出（原导出面保持不变）=====
export { buildCharacters, buildPropAssets, rerunCasting } from './directorStageCharacters'
export {
  generateShotFirstFrame, buildShots, rebuildShotFirstFrames, regenerateScenePano
} from './directorStageShots'
