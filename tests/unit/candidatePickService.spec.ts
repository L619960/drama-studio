import { describe, it, expect, vi } from 'vitest'
import { CandidatePickService } from '../../src/main/core/candidatePickService'

function makeCandidates() {
  return [
    { id: 'c1', relativePath: 'a.png', seed: 11, score: 0.6, note: '空镜' },
    { id: 'c2', relativePath: 'b.png', seed: 22, score: 0.8, note: '好' },
    { id: 'c3', relativePath: 'c.png', seed: 33, score: 0.7, note: '一般' }
  ]
}

describe('CandidatePickService.pick', () => {
  const llm = { pickCandidate: vi.fn() }
  const svc = new CandidatePickService(llm as any)

  it('唯一候选直接返回', async () => {
    const only = { id: 'x', relativePath: 'x.png', seed: 99 }
    const res = await svc.pick({
      kind: 'character', brief: '', candidates: [only], llmPick: true
    })
    expect(res.winner).toBe(only)
    expect(res.reason).toBe('唯一候选')
    expect(res.rejected).toEqual([])
  })

  it('空候选抛错', async () => {
    await expect(svc.pick({
      kind: 'scene', brief: '', candidates: [], llmPick: false
    })).rejects.toThrow('抽卡失败：无可用候选')
  })

  it('llmPick=false 时按分数取最高', async () => {
    const res = await svc.pick({
      kind: 'character', brief: '',
      candidates: makeCandidates(), llmPick: false
    })
    expect(res.winner.id).toBe('c2') // score 0.8
    expect(res.rejected.map(r => r.id)).toEqual(['c3', 'c1'])
    expect(res.reason).toContain('按分数取最高')
  })

  it('同分取先到的那个', async () => {
    const res = await svc.pick({
      kind: 'character', brief: '',
      candidates: [
        { id: 'a', relativePath: 'a.png', seed: 1, score: 0.5 },
        { id: 'b', relativePath: 'b.png', seed: 2, score: 0.5 },
      ],
      llmPick: false
    })
    expect(res.winner.id).toBe('a')
  })

  it('无分数时按顺序取第一个', async () => {
    const res = await svc.pick({
      kind: 'render', brief: '',
      candidates: [
        { id: 'a', relativePath: 'a.png', seed: 1 },
        { id: 'b', relativePath: 'b.png', seed: 2 },
      ],
      llmPick: false
    })
    expect(res.winner.id).toBe('a')
  })

  it('llmPick=true 时调用 LLM.pickCandidate', async () => {
    llm.pickCandidate.mockReset()
    llm.pickCandidate.mockResolvedValue({ index: 2, reason: 'LLM 选了 2 号' })
    const cands = makeCandidates()
    const res = await svc.pick({
      kind: 'character', brief: 'brief text',
      candidates: cands, llmPick: true
    })
    expect(llm.pickCandidate).toHaveBeenCalledWith({
      kind: 'character', brief: 'brief text',
      candidates: [
        { index: 1, seed: 11, score: 0.6, note: '空镜' },
        { index: 2, seed: 22, score: 0.8, note: '好' },
        { index: 3, seed: 33, score: 0.7, note: '一般' }
      ]
    })
    expect(res.winner).toBe(cands[1]) // index=2 → c2
    expect(res.reason).toBe('LLM 选了 2 号')
    expect(res.rejected.map(r => r.id).sort()).toEqual(['c1', 'c3'])
  })

  it('LLM 抽卡失败时回退到分数最高', async () => {
    llm.pickCandidate.mockReset()
    llm.pickCandidate.mockRejectedValue(new Error('LLM 挂了'))
    const res = await svc.pick({
      kind: 'character', brief: '',
      candidates: makeCandidates(), llmPick: true
    })
    expect(res.winner.id).toBe('c2') // 分数 0.8 最高
    expect(res.reason).toContain('LLM 抽卡失败')
    expect(res.reason).toContain('0.8')
  })

  it('LLM 返回越界 index 时回退到分数最高', async () => {
    llm.pickCandidate.mockReset()
    llm.pickCandidate.mockResolvedValue({ index: 999, reason: '越界' })
    const res = await svc.pick({
      kind: 'character', brief: '',
      candidates: makeCandidates(), llmPick: true
    })
    expect(res.winner.id).toBe('c2') // 回退最高分
  })

  it('过滤 undefined/空值候选', async () => {
    const res = await svc.pick({
      kind: 'scene', brief: '',
      candidates: [
        { id: 'a', relativePath: 'a.png', seed: 1, score: 0.3 },
        undefined as any,
        { id: 'b', relativePath: 'b.png', seed: 2, score: 0.9 },
      ],
      llmPick: false
    })
    expect(res.winner.id).toBe('b')
  })
})
