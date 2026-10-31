/**
 * 多模态与审核层（从 llmService.ts 抽出）：
 * - reviewStory：成片叙事复审（本地硬规则 + 模型复审）
 * - diagnoseFailure：流水线故障自诊断
 * - auditImage：逐镜视觉审核（base64 图片上传）
 * 行为与原 LLMService 内联实现一字不差。
 */
import axios from 'axios'
import type { AppSettings } from '../../shared/ipcTypes'
import { resolveCreation } from '../../shared/creationSettings'
import { validateNarrativeContinuity } from '../../shared/narrativeBeats'
import { httpChat } from './llmHttp'
import { llmApiKey, llmBaseUrl } from './llmRequest'

/**
 * AI 导演·成片复审：以剧本统筹视角审查分镜叙事的完整性与音频匹配。
 * 输入：故事梗概 + 各镜摘要（场景/角色/台词/实际时长）；输出：是否通过 + 问题清单。
 * 低温度保证审批结论稳定。
 */
export async function reviewStoryOp(
  getSettings: () => Promise<AppSettings>,
  input: {
    title: string
    logline: string
    genre: string
    scriptHint?: string
    shots: Array<{
      index: number
      scene: string
      character: string
      dialogue: string
      durationSec: number
      action?: string
      type?: 'i2v' | 't2v'
      shotSize?: string | undefined
    }>
  },
): Promise<{ passed: boolean; issues: string[]; summary: string }> {
  const sb = resolveCreation(await getSettings()).storyboard
  // 本地硬规则：道具/反应/上车/驶离——不依赖模型是否记得审片维度
  const localIssues = validateNarrativeContinuity(
    input.title,
    input.logline,
    input.scriptHint || '',
    input.shots.map((s) => ({
      index: s.index,
      scene: s.scene,
      action: s.action || '',
      dialogue: s.dialogue,
      type: s.type || (s.character ? 'i2v' : 't2v'),
      ...(s.character ? { characterName: s.character } : {}),
      ...(s.shotSize !== undefined ? { shotSize: s.shotSize } : {}),
    })),
    {
      enforcePropLock: sb.enforcePropLock,
      enforceReactionBeats: sb.enforceReactionBeats,
      enforceBoardingChain: sb.enforceBoardingChain,
    },
  )

  const system = [
    '你是一名严苛的短剧成片审片导演，负责在剪辑完成后做最终复审，不通过则不允许配 BGM 出片。',
    '',
    '# 审查维度（逐镜逐条过）',
    '1. 剧情完整性：故事是否有开端（人物/冲突引入）、发展（冲突升级或转折）、结局（收束或钩子）；缺哪一环指出缺在哪',
    '2. 镜头衔接逻辑：相邻镜头的时空/动作是否连贯；有没有跳跃、重复、因果断裂',
    '3. 台词与剧情相符：每句台词是否贴合该镜场景与角色处境；是否存在台词与画面行为矛盾、或台词推进了与上下文无关的内容',
    '4. 音画匹配：某镜时长（秒）明显配不上其台词量或剧情分量时指出（如 1 秒塞了 30 字台词、5 秒却只有一个"嗯"）',
    '5. 角色行为一致性：角色动机是否前后矛盾',
    '6. 关键道具落幅：片名/梗概中的核心道具（如伞）是否在某镜 action 中明确出现；交接戏是否有 closeup；道具是否中途失踪',
    '7. 入画反应：对方走近/入画空镜后，是否存在等待方「看见」的无台词反应镜，再进入对白',
    '8. 上车与驶离：车旁→车内是否缺入座过程；结局是否明确「车辆驶离」而非纯街道空镜',
    '',
    '# 判定标准',
    '- passed=true：仅存在可忽略的小瑕疵（节奏偏好类），不阻碍出片',
    '- passed=false：存在剧情断裂、台词错位、关键情节缺失、关键道具与片名脱节、上车/结局跳跃等观众能感知的问题',
    '- issues 用中文一句话写清「问题 + 位置（第 N 镜）+ 修改方向」；没有问题给空数组',
    '- summary：两句话内给出总体评价',
    '',
    '# 输出格式：只输出一个 JSON 对象，禁止 markdown 围栏与解释',
    '{"passed": true 或 false, "issues": ["问题1", "问题2"], "summary": "总体评价"}',
  ].join('\n')

  const listing = input.shots
    .map(
      (s) =>
        `第${s.index}镜 [${s.durationSec}s] ${s.scene}｜${s.type || '?'}｜${s.shotSize || '-'}｜角色:${s.character || '空镜'}｜台词:${s.dialogue || '（无）'}｜action:${s.action || '（无）'}`,
    )
    .join('\n')

  const raw = await httpChat(
    getSettings,
    system,
    `片名《${input.title}》 题材:${input.genre}\n梗概:${input.logline || '（未提供）'}\n\n分镜清单:\n${listing}`,
    0.2,
    120000,
  )
  const cleaned = raw.replace(/```(?:json)?/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    return {
      passed: localIssues.length === 0,
      issues: [...localIssues, '剧情复审模型输出异常，已跳过模型剧情项（本地叙事规则仍有效）'].slice(0, 12),
      summary: '剧情复审部分跳过',
    }
  }
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
      passed?: unknown
      issues?: unknown
      summary?: unknown
    }
    const modelIssues = Array.isArray(parsed.issues) ? parsed.issues.map((x) => String(x)).filter(Boolean) : []
    const merged = [...localIssues]
    for (const i of modelIssues) {
      if (!merged.some((m) => m.includes(i.slice(0, 12)) || i.includes(m.slice(0, 12)))) {
        merged.push(i)
      }
    }
    const issues = merged.slice(0, 12)
    return {
      passed: parsed.passed !== false && localIssues.length === 0,
      issues,
      summary: String(parsed.summary || '').trim(),
    }
  } catch {
    return {
      passed: localIssues.length === 0,
      issues: [...localIssues, '剧情复审模型输出解析失败，已跳过模型剧情项（本地叙事规则仍有效）'].slice(0, 12),
      summary: '剧情复审部分跳过',
    }
  }
}

/**
 * 流水线故障自诊断（C：错误回流自愈）：阶段失败时把错误样本交回 LLM，
 * 判定失败根因、是否值得自动重试（canAutoFix）与人工修复建议。
 * 解析失败/超时直接抛错，由调用方降级为「不自愈、按原错误暂停」。
 */
export async function diagnoseFailureOp(
  getSettings: () => Promise<AppSettings>,
  input: {
    stageLabel: string
    errors: string[]
    context?: string
  },
): Promise<{ canAutoFix: boolean; diagnosis: string; suggestion: string }> {
  const system = [
    '你是 AI 视频生产流水线的故障诊断专家。流水线阶段失败后，系统会把错误样本交给你。',
    '你的职责：',
    '1. 判断失败根因属于哪一类：环境问题（缺模型/缺节点/服务未启动）、参数问题（时长/分辨率超限）、资源问题（显存/磁盘）、网络或服务瞬时故障、内容被安全策略拦截、或其他',
    '2. 判断「原样自动重试」是否有意义：瞬时故障/抖动类重试有意义；缺模型、参数非法、内容拦截类重试无意义，必须先人工处理',
    '3. 给出具体可执行的修复建议（中文，说清楚去哪里、改什么）',
    '',
    '# 输出格式：只输出一个 JSON 对象，禁止 markdown 围栏与解释',
    '{"canAutoFix": true 或 false, "diagnosis": "根因判断（一两句话）", "suggestion": "修复建议（具体可执行）"}',
  ].join('\n')

  const raw = await httpChat(
    getSettings,
    system,
    `失败阶段：${input.stageLabel}\n${input.context ? `上下文：${input.context}\n` : ''}错误样本（已去重）：\n${input.errors.map((e, i) => `${i + 1}. ${e}`).join('\n')}`,
    0.2,
    60000,
  )
  const cleaned = raw.replace(/```(?:json)?/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('诊断输出格式异常')
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
    canAutoFix?: unknown
    diagnosis?: unknown
    suggestion?: unknown
  }
  const diagnosis = String(parsed.diagnosis || '').trim()
  const suggestion = String(parsed.suggestion || '').trim()
  if (!diagnosis || !suggestion) throw new Error('诊断内容不完整')
  return { canAutoFix: parsed.canAutoFix === true, diagnosis, suggestion }
}

/**
 * 逐镜视觉审核（看守）：把渲染产物（图片/视频抽帧）交给 LLM 看图，
 * 按审核清单逐条判定，未过审给出英文修正指令（注入下次渲染提示词）。
 * 模型不支持视觉（请求报错）时返回 visionUnavailable=true，调用方降级为仅技术审核。
 */
export async function auditImageOp(
  getSettings: () => Promise<AppSettings>,
  input: {
    imagePath: string
    kind: 'keyframe' | 'video'
    checklist: Array<{ id: string; label: string; check: string; severity: 'block' | 'warn' }>
    context: {
      index: number
      scene: string
      character: string
      action: string
      shotSize: string
      camera: string
      lookEn?: string | undefined
    }
  },
): Promise<{
  visionUnavailable: boolean
  passed: boolean
  blockedProblems: string[]
  fixHint: string
}> {
  const s = await getSettings()
  const apiKey = llmApiKey(s)
  if (!apiKey) return { visionUnavailable: true, passed: true, blockedProblems: [], fixHint: '' }

  const dataUrl = await (async () => {
    try {
      const { readFile } = await import('node:fs/promises')
      const buf = await readFile(input.imagePath)
      const ext = input.imagePath.toLowerCase().match(/\.(\w+)$/)?.[1] || 'png'
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
      return `data:${mime};base64,${buf.toString('base64')}`
    } catch {
      return ''
    }
  })()
  if (!dataUrl) return { visionUnavailable: true, passed: true, blockedProblems: [], fixHint: '' }

  const checklistLines = input.checklist
    .map((c, i) => `${i + 1}. ${c.label}：${c.check}（${c.severity === 'block' ? '不过必须重渲' : '不过仅告警'}）`)
    .join('\n')
  const system = [
    '你是短剧画面质检导演（vision QC），逐张审核 AI 生成的画面/视频帧，发现漂移穿帮就拦下重渲。',
    '审核对象：真人写实竖屏短剧画面。',
    '# 审核清单（逐条过）',
    checklistLines,
    '',
    '# 判定',
    '- block 项任一不过 → passed=false；仅 warn 项不过 → passed=true（记入 fixHint 供下次生成时修正）',
    '- fixHint：英文一句话写出最重要的画面修正指令（身份/服装/场景/道具/表情/运镜），注入下次生成提示词；无问题给空字符串',
    '- blockedProblems：中文列出未通过的 block 项（含第几项），无则空数组',
    '',
    '# 输出格式：只输出 JSON，禁止 markdown 围栏',
    '{"passed": true 或 false, "blockedProblems": ["人脸身份与定妆不一致"], "fixHint": "keep exact face identity and outfit from reference, no outfit change"}',
  ].join('\n')

  const user = [
    `第${input.context.index}镜 ${input.kind === 'video' ? '视频抽帧' : '关键帧'}审核｜景别:${input.context.shotSize}｜机位:${input.context.camera}`,
    `场景:${input.context.scene}｜角色:${input.context.character}${input.context.lookEn ? `｜外观锁定:${input.context.lookEn}` : ''}`,
    `动作:${input.context.action}`,
    '请按清单审核这张画面。',
  ].join('\n')

  const body: Record<string, unknown> = {
    model: s.llm.model,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'text', text: user },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0.2,
    // 推理型多模态模型（如 deepseek-flash）默认把配额耗在 reasoning 上导致 content 空：
    // 用低推理档 + 大配额保证 JSON 落地；content 仍被挤占时自动重试一次
    effort: 'low',
    max_tokens: 2000,
  }
  const post = () =>
    axios.post(`${llmBaseUrl(s)}/chat/completions`, body, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 90000,
    })
  let resp = await post()
  let content: string = resp.data?.choices?.[0]?.message?.content?.trim() || ''
  const reasoning: string = resp.data?.choices?.[0]?.message?.reasoning_content || ''
  if (!content && reasoning) {
    // 模型看到了图但在推理，content 被挤空：加大配额重试一次
    body.max_tokens = 4000
    resp = await post()
    content = resp.data?.choices?.[0]?.message?.content?.trim() || ''
  }
  // 模型收到图片却忽略（如纯文本模型返回空 content / 说"没有图片"）→ 判为视觉不可用，
  // 禁止假装审过——宁降级为仅技术审核，也不放行未经视觉检查的画面。
  if (!content || /没有图片|no image|看不到|cannot see/i.test(content.slice(0, 200))) {
    return { visionUnavailable: true, passed: true, blockedProblems: [], fixHint: '' }
  }
  const cleaned = content.replace(/```(?:json)?/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    return { visionUnavailable: false, passed: true, blockedProblems: [], fixHint: '' }
  }
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
      passed?: unknown
      blockedProblems?: unknown
      fixHint?: unknown
    }
    return {
      visionUnavailable: false,
      passed: parsed.passed !== false,
      blockedProblems: Array.isArray(parsed.blockedProblems)
        ? parsed.blockedProblems
            .map((x) => String(x))
            .filter(Boolean)
            .slice(0, 6)
        : [],
      fixHint: String(parsed.fixHint || '')
        .trim()
        .slice(0, 300),
    }
  } catch {
    return { visionUnavailable: false, passed: true, blockedProblems: [], fixHint: '' }
  }
}
