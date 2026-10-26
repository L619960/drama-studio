import type {
  DirectorState, DirectorStage, StageState
} from '../../shared/ipcTypes'

export const STAGE_ORDER: DirectorStage[] = [
  'analyze', 'casting', 'scenes', 'render',
  'combine', 'subtitle', 'review', 'bgm', 'done'
]

export const STAGE_LABELS: Record<DirectorStage, string> = {
  analyze: '剧本分析',
  casting: '角色建档',
  scenes: '场景板与首尾帧',
  render: '逐镜渲染 · 审批',
  combine: '拼接成片',
  subtitle: '烧录字幕',
  review: '成片复审',
  bgm: 'BGM 混音',
  done: '完成'
}

/** 阶段序号（断点续跑的先后比较用） */
export function stageIndexOf(stage: DirectorStage): number {
  return STAGE_ORDER.indexOf(stage)
}

/** 找到当前正在运行的阶段（用于暂停提示归属） */
export function currentStageOf(state: DirectorState): DirectorStage {
  for (const stage of STAGE_ORDER) {
    if (state.stages[stage].status === 'running') return stage
  }
  return 'done'
}

export function freshState(projectId: string, title: string): DirectorState {
  const stages = {} as Record<DirectorStage, StageState>
  for (const stage of STAGE_ORDER) {
    stages[stage] = { status: 'pending', message: '', percent: 0 }
  }
  return {
    projectId,
    title,
    running: true,
    cancelled: false,
    paused: false,
    gateStages: [],
    stages,
    totalShots: 0,
    doneShots: 0,
    failedShotIds: [],
    startedAt: Date.now(),
    logs: []
  }
}
