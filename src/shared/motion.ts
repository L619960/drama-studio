/**
 * 视频动作/运动域：动作清洗、中文→英文动作 cue、动作判定正则、渲染工作流选型。
 * 依赖：promptStrips（单人化/对人名剥离）。
 */

import { soloizeAction, stripOtherPersonClauses } from './promptStrips'

/** 位移动作判定（llmService 尾帧必填判定 与 taskQueue flf2v 切换判定 共用，
 *  两处必须同语义——一份正则，禁止各自维护导致漂移判定口径分裂） */
export const DISPLACEMENT_ACTION_RE =
  /walk|run|approach|advance|strides?|steps? (forward|across|toward|away)|moves? (across|toward|forward|away|to)|trot|jog|enter|leave|rush|dash|走近|走进|走出|进入|离开|退回|后退|位移/i

/** 强动作判定（词表取自 llmService 动作忠实铁律与自检18）：
 *  摔砸 slam/hurl/smash、踢倒 kick/knock over、跺脚 stomp、撞肩 bump into、挥/掷/碎 punch/throw/crash/shatter。
 *  「拿起/塞进/转身」不收录——属常规原子动作，不应跳过动作压制。 */
export const STRONG_ACTION_RE =
  /slam|hurl|smash|kick|knock over|stomp|punch|throw|crash|shatter|bump into|摔砸|踢倒|踢翻|跺脚|撞肩|猛掷|猛砸/i

/**
 * 清洗 LLM 分镜 action 里的"身份锁定套话"（LLM 偶发把外貌锁定措辞写进动作字段，
 * 会挤占真实动作指令、削弱表演）。删除后再交给图生视频提示词组装。
 */
export function cleanAction(action: string): string {
  if (!action) return action
  return action
    .replace(/\b(the\s+(?:young\s+)?(?:woman|man|person|girl|boy)\s+from\s+the\s+reference\s+image\s+keeps?\s+(?:identical\s+)?(?:face|appearance|outfit|clothing|wardrobe|hair)\s*(?:and\s+outfit|and\s+clothing|and\s+appearance)?[^,.;]*)/gi, '')
    .replace(/\b(keep(?:ing)?\s+(?:identical|same)\s+(?:face|appearance|outfit|clothing|look)[^,.;]*)/gi, '')
    .replace(/\b(do\s+not\s+(?:change|redesign|modify)\s+(?:the\s+)?(?:face|appearance|outfit|wardrobe)[^,.;]*)/gi, '')
    .replace(/,\s*,\s*/g, ',')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[,.\s]+|[,.\s]+$/g, '')
}

/** 动作用中文写、提示词用英文写时，无法核对是不是同一场戏。这种提示词不能进视频模型。 */
export function actionLacksEnglish(action: string): boolean {
  const latin = (action.match(/[a-z]{4,}/gi) || []).length
  const cjk = (action.match(/[\u4e00-\u9fff]/g) || []).length
  return cjk >= 4 && latin < 4
}

/** 中文动作改成一句英文动作。整段中文说明进视频模型会被当成旁白念出来。
 *  英文复合动作也只留第一拍，并去掉对戏人名/肢体接触（否则单人镜画双人）。 */
export function motionCueFromAction(action: string): string {
  const a = (action || '').replace(/\s+/g, ' ').trim()
  if (!a) return 'holds the pose from the first frame, one small motion, costume and place unchanged'
  if (!actionLacksEnglish(a)) {
    let e = a.replace(/[\u4e00-\u9fff]/g, ' ').replace(/\s+/g, ' ').trim()
    e = e.split(/\bthen\b|; |\band then\b/i)[0] || e
    e = soloizeAction(stripOtherPersonClauses(e))
    e = e.replace(/^(?:the\s+subject|the\s+same\s+person(?:\s+from\s+the\s+reference\s+image)?)\s*,?\s*/i, '')
    if (e.length > 110) e = e.slice(0, 110).replace(/,\s*[^,]*$/, '').trim()
    return e || 'holds the pose from the first frame, one small motion, costume and place unchanged'
  }
  const table: Array<[RegExp, string]> = [
    [/拔剑|抽出|出剑|剑尖指向/, 'draws the sword once and holds the point forward'],
    [/收剑/, 'sheathes the sword in one motion'],
    [/侧身|避开|躲过|让过/, 'sidesteps once, weapon stays in hand'],
    [/格开|格挡|抵住|相交/, 'parries once, the blades meet and hold'],
    [/按剑|立在|静止|站在/, 'holds still, one hand on the sword'],
    [/退回|后退|退一步/, 'steps back once and stops'],
    [/开口|说话/, 'speaks the line, mouth moves']
  ]
  return table.find(([re]) => re.test(a))?.[1]
    || 'holds the pose from the first frame, one small motion, costume and place unchanged'
}

/** 武打/持械动作判定（工作流选型 与 道具数量约束 共用，两处必须同语义——一份正则） */
export const COMBAT_ACTION_RE =
  /拔剑|抽出|出剑|收剑|按剑|格开|格挡|交格|交手|拼斗|过招|兵刃|相击|侧身|刺|劈|parr(?:y|ies)|sidestep|draws? (?:the |a )?sword|pull(?:ing|s)? out (?:a |the )?(?:long )?sword|sheath|pointing the blade|sword thrust|持剑|持刀|执剑|提剑|横剑|挥剑|剑指|举剑/i

export type RenderWorkflowChoice = { workflow: string; reason: string }

/** 出视频前选定工作流。交手镜留在首帧图生，不走首尾帧插值。
 *  录音回放/画外音有台词也不走口型——否则本镜角色会对口型念别人的录音。 */
export function chooseRenderWorkflow(opts: {
  pinned?: string
  dialogue?: string
  action?: string
  hasEndFrame?: boolean
  defaultWorkflow?: string
}): RenderWorkflowChoice {
  if (opts.pinned?.trim()) return { workflow: opts.pinned.trim(), reason: '分镜已指定工作流' }
  const action = opts.action || ''
  const combat = COMBAT_ACTION_RE.test(action)
  const playback = /plays?\s+a\s+recording|playback|录音|播放录音|画外音|voice-?over/i.test(action)
  if (opts.dialogue?.trim() && !playback) return { workflow: 'minimax_h3_r2v', reason: '有台词，走口型参考视频' }
  if (playback && opts.dialogue?.trim()) return { workflow: 'minimax_h3_i2v', reason: '录音/画外音，不走本角色口型' }
  if (combat) return { workflow: 'minimax_h3_i2v', reason: '单次交手，首帧锁定，不走首尾帧插值' }
  if (DISPLACEMENT_ACTION_RE.test(action) && opts.hasEndFrame) {
    return { workflow: 'wan22_remix_flf2v', reason: '跨镜位移且有尾帧，走首尾帧' }
  }
  const fallback = opts.defaultWorkflow || 'minimax_h3_i2v'
  return { workflow: fallback, reason: '按项目默认工作流' }
}
