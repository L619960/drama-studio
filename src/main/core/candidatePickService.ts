/**
 * 多候选抽卡：人物/场景/视频各生成 N 份，结合本地分数 + LLM 挑选最优。
 * 无视觉模型时 LLM 依据分数与简报做决策；分数优先保证可用性。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { LLMService } from './llmService'

export interface CandidateItem {
  id: string
  /** 相对项目根的路径（图片或视频分段） */
  relativePath: string
  seed: number
  /** 0–1，越高越好；缺失则仅靠 LLM/顺序 */
  score?: number
  /** 给 LLM 的短说明（检测结果、是否空镜等） */
  note?: string
}

export interface PickResult {
  winner: CandidateItem
  reason: string
  /** 落选候选（可保留供调试） */
  rejected: CandidateItem[]
}

export class CandidatePickService {
  constructor(private llm: LLMService) {}

  /**
   * 从候选中挑最优。candidates 至少 1 个。
   * llmPick=false 或仅 1 个：取分数最高（同分取先）。
   */
  async pick(opts: {
    kind: 'character' | 'scene' | 'render'
    brief: string
    candidates: CandidateItem[]
    llmPick: boolean
  }): Promise<PickResult> {
    const list = opts.candidates.filter(Boolean)
    const first = list[0]
    if (!first) throw new Error('抽卡失败：无可用候选')
    if (list.length === 1) {
      return { winner: first, reason: '唯一候选', rejected: [] }
    }

    const byScore = [...list].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    const top = byScore[0]
    if (!top) throw new Error('抽卡失败：无可用候选')
    if (!opts.llmPick) {
      return {
        winner: top,
        reason: `按分数取最高（${top.score ?? 'n/a'}）`,
        rejected: byScore.slice(1),
      }
    }

    try {
      const chosen = await this.llm.pickCandidate({
        kind: opts.kind,
        brief: opts.brief,
        candidates: list.map((c, i) => ({
          index: i + 1,
          seed: c.seed,
          ...(c.score !== undefined ? { score: c.score } : {}),
          note: c.note || '',
        })),
      })
      const winner = list[chosen.index - 1] ?? top
      return {
        winner,
        reason: chosen.reason || `LLM 选中候选 #${chosen.index}`,
        rejected: list.filter((c) => c.id !== winner.id),
      }
    } catch {
      return {
        winner: top,
        reason: `LLM 抽卡失败，回退分数最高（${top.score ?? 'n/a'}）`,
        rejected: byScore.slice(1),
      }
    }
  }

  /** 把胜出文件复制到正式路径，其余候选移到 candidates/ 旁路保留 */
  async promoteWinner(opts: {
    baseDir: string
    winnerRel: string
    finalRel: string
    rejectedRels: string[]
    keepRejected?: boolean
  }): Promise<void> {
    const winnerAbs = path.join(opts.baseDir, opts.winnerRel)
    const finalAbs = path.join(opts.baseDir, opts.finalRel)
    await fs.mkdir(path.dirname(finalAbs), { recursive: true })
    if (path.resolve(winnerAbs) !== path.resolve(finalAbs)) {
      await fs.copyFile(winnerAbs, finalAbs)
    }
    if (opts.keepRejected === false) {
      for (const rel of opts.rejectedRels) {
        try {
          await fs.unlink(path.join(opts.baseDir, rel))
        } catch {
          /* ignore */
        }
      }
      return
    }
    for (const rel of opts.rejectedRels) {
      try {
        const abs = path.join(opts.baseDir, rel)
        const dest = path.join(path.dirname(finalAbs), 'candidates', path.basename(rel))
        await fs.mkdir(path.dirname(dest), { recursive: true })
        await fs.rename(abs, dest).catch(async () => {
          await fs.copyFile(abs, dest)
          await fs.unlink(abs).catch(() => undefined)
        })
      } catch {
        /* ignore */
      }
    }
  }
}
