import assert from 'node:assert/strict'
import { clampShotList, orientVideoSize, reviewedIsValid, reviewFailureStops, shotsInCut, shouldFallbackToWan, trimmedDurationSec, unreviewedI2vShots } from '../src/shared/pipelineGuards'
import { validateNarrativeContinuity } from '../src/shared/narrativeBeats'
import { audioTailSecFor, SHOT_DOCTRINE } from '../src/shared/shotDoctrine'
import { ageDriftNegativeFor, ageLockFor, alignStoryboardPrompts, castPromptPoisoned, chooseRenderWorkflow, claimPerformer, extractOutfitLock, frameAppearanceLock, identityLockBlock, keepDialogueChinese, motionCueFromAction, negativeForSlot, repairCastText, scrubSummoningTerms, soloizeAction, stripEnglishCastNames, stripOtherPersonClauses, videoMotionPrompt } from '../src/shared/imagePrompts'

const over = clampShotList([1, 2, 3, 4, 5], 3)
assert.equal(over.shots.length, 3)
assert.equal(over.trimmed, 2)
assert.deepEqual(over.shots, [1, 2, 3])

const under = clampShotList(['a'], 8)
assert.equal(under.trimmed, 0)
assert.deepEqual(under.shots, ['a'])

assert.equal(shouldFallbackToWan('warn', 'h3-i2v', 0.1, 0.3), true)
assert.equal(shouldFallbackToWan('warn', 'h3-i2v', 0.2, 0.3), false)
assert.equal(shouldFallbackToWan('off', 'h3-r2v', 0.1, 0.3), false)
assert.equal(shouldFallbackToWan('rerender', 'wan', 0.1, 0.3), false)
assert.equal(shouldFallbackToWan('rerender', 'h3-i2v', 0.1, 0.3), true)
assert.equal(shouldFallbackToWan('rerender', 'h3-r2v', 0.4, 0.3), false)

assert.deepEqual(orientVideoSize(480, 864, true), { width: 480, height: 864 })
assert.deepEqual(orientVideoSize(480, 864, false), { width: 864, height: 480 })

assert.equal(reviewedIsValid('i2v', true, ''), false)
assert.equal(reviewedIsValid('i2v', true, 'projects/p/shot.png'), true)
assert.equal(reviewedIsValid('i2v', false, 'projects/p/shot.png'), false)
assert.equal(reviewedIsValid('t2v', true, undefined), true)

const cut = shotsInCut([
  { id: 'a', status: 'done', segmentPath: 'projects/a.mp4', lowConsistency: true },
  { id: 'b', status: 'done', segmentPath: 'projects/b.mp4', skipped: true },
  { id: 'c', status: 'failed', segmentPath: 'projects/c.mp4' },
  { id: 'd', status: 'done', segmentPath: '  ' }
])
assert.deepEqual(cut.map(s => s.id), ['a'])
assert.equal(trimmedDurationSec(6, 1, 4), 3)
assert.equal(trimmedDurationSec(6, 5, 2), 6)
assert.equal(reviewFailureStops('block'), true)
assert.equal(reviewFailureStops('warn'), true)
assert.equal(reviewFailureStops('off'), false)
assert.equal(unreviewedI2vShots([
  { type: 'i2v', reviewed: true, firstFramePath: '' },
  { type: 'i2v', reviewed: true, firstFramePath: 'projects/f.png' },
  { type: 't2v', reviewed: false }
]).length, 1)
assert.equal(audioTailSecFor({ dialogue: '你好' }), SHOT_DOCTRINE.dialogueTailSec)
assert.equal(audioTailSecFor({ dialogue: '你好', isLast: true }), SHOT_DOCTRINE.buttonTailSec)
assert.equal(audioTailSecFor({}), SHOT_DOCTRINE.stillTailSec)
assert.equal(SHOT_DOCTRINE.maxSec, 6)
assert.equal(SHOT_DOCTRINE.readableFaces, 1)
const handoffWarn = validateNarrativeContinuity('t', '', '', [{
  index: 2,
  action: 'hands over the umbrella then walks away',
  type: 'i2v'
}])
assert.ok(handoffWarn.some(w => w.includes('独占一镜')))

const youngWoman = 'chinese woman in her mid 20s, oval face, natural matte skin, shoulder-length black hair, grey knit cardigan over white shirt, dark jeans'
const windowAction = 'She stands at the night window, slowly turns her head toward the door, one hand resting on the windowsill, breath held.'
const poisoned = 'the same old man from the reference image, with his weathered face, white stubble, and worn brown coat, starts with his hand resting on the closed book, then slowly lifts the cover, fingers slide inside to touch a brass key'
assert.equal(castPromptPoisoned(
  'sidestepping to the left as the first sword thrust comes in, body turning slightly to avoid the blade, hand moving to the sword hilt',
  'the same young woman from the reference image, wearing a dark grey oversized hoodie and black leggings, her wet hair clinging to her face, she stands in a dim hallway',
  'chinese man in his late 20s, black hair tied in a topknot, plain indigo cotton short jacket and dark trousers'
), true)

assert.equal(castPromptPoisoned(
  '顾衡按剑立在桥头，目光直视桥对面的林昭',
  'the same Lin from the reference image, soaked white shirt clinging to torso, gripping the rusted iron doorknob',
  'chinese man, black cross-collar robe'
), true)

assert.equal(castPromptPoisoned(windowAction, poisoned, youngWoman), true)
const fixed = repairCastText(poisoned, windowAction, youngWoman, 'motion') || ''
assert.equal(/old man|stubble|weathered|brown coat/i.test(fixed), false)
assert.match(fixed, /window/i)
assert.match(fixed, /cardigan|shirt|jeans/i)

const aligned = 'the same person from the reference image, grey knit cardigan, stands at the night window, turns her head toward the door, hand resting on the windowsill, breath held, static camera'
assert.equal(castPromptPoisoned(windowAction, aligned, youngWoman), false)
assert.equal(repairCastText(aligned, windowAction, youngWoman, 'motion'), aligned)

const elderLook = 'chinese man in his 60s, short white hair, worn brown coat'
const elderPrompt = 'the same old man from the reference image, worn brown coat, lifts the brass key from the table, then looks at the key, holds still'
const elderAction = 'He lifts the brass key from the table, then looks at the key and holds still.'
assert.equal(castPromptPoisoned(elderAction, elderPrompt, elderLook), false)

const mid = "The old man's trembling hand pulls letters from a cabinet."
const midFixed = repairCastText(mid, windowAction, youngWoman, 'frame') || ''
assert.equal(/old man/i.test(midFixed), false)
assert.match(midFixed, /window/i)

const t2vAction = 'Chen Zhou raises the cup in a slight toast, turns around, walks into the night market crowd, cup still in hand'
const t2vPoison = 'The same Lin from the reference image, in his dark grey linen shirt, wet hair, inside the dim room. He reaches out with his left hand, fingers brush against a dusty bookshelf, he pulls his hand back, wipes dust on his trousers, then takes two slow steps deeper into the room, stopping beside an old wooden desk.'
assert.equal(castPromptPoisoned(t2vAction, t2vPoison, ''), true)
const t2vFixed = repairCastText(t2vPoison, t2vAction, '', 'motion') || ''
assert.equal(/bookshelf|wooden desk|linen shirt/i.test(t2vFixed), false)
assert.match(t2vFixed, /night market/i)

const claimed = claimPerformer({
  type: 't2v',
  action: 'Chen Zhou raises the cup in a slight toast, turns around, walks into the night market crowd',
  promptEn: t2vPoison,
  scene: '夜市奶茶摊',
  sceneEn: 'dim study room, dusty bookshelf, old wooden desk'
}, [{ name: '陈舟', pinyin: 'chenzhou' }, { name: '阿宁', pinyin: 'aning' }])
assert.equal(claimed.claimed, true)
assert.equal(claimed.shot.type, 'i2v')
assert.equal(claimed.shot.characterName, '陈舟')

const story = alignStoryboardPrompts([
  { type: 'i2v', scene: '夜市奶茶摊', action: windowAction, characterName: '阿宁', promptEn: aligned },
  claimed.shot
], (s) => s.characterName === '阿宁' ? youngWoman : 'chinese man in his late 20s, dark grey hoodie, black casual pants')
assert.equal(/bookshelf|old man|linen shirt/i.test(story.shots[1].promptEn || ''), false)
assert.match(story.shots[1].promptEn || '', /night market/i)
assert.equal(story.shots[1].sceneEn, undefined)
assert.match(story.shots[1].continuity || '', /previous shot/i)
assert.ok(story.notes.some(n => n.startsWith('提示词核对')))

assert.match(ageDriftNegativeFor(youngWoman), /old man/)
assert.equal(ageDriftNegativeFor(elderLook), '')
assert.equal(ageDriftNegativeFor(''), '')

const swordAction = '顾衡侧身避开林昭刺来的一剑，动作迅速而沉稳，衣角随风摆动。'
const wetShirt = 'the same Lin from the reference image, soaked white shirt clinging to torso, gripping the rusted iron doorknob, twisting it slowly'
const manLook = 'chinese man in his late 20s, black hair tied in a topknot, dark black cotton short robe, a long sword at his waist'
assert.equal(castPromptPoisoned(swordAction, wetShirt, manLook), true)
const repaired = repairCastText(wetShirt, swordAction, manLook, 'motion') || ''
assert.match(repaired, /sidesteps once/)
assert.doesNotMatch(repaired, /shirt|doorknob|[\u4e00-\u9fff]/)
assert.equal(motionCueFromAction('林昭从桥对面拔出长剑，剑尖指向顾衡'), 'draws the sword once and holds the point forward')
assert.equal(chooseRenderWorkflow({ action: swordAction, dialogue: '' }).workflow, 'minimax_h3_i2v')
assert.equal(chooseRenderWorkflow({ action: 'emerging from the alley, pulling out a long sword, then walking back', dialogue: '', hasEndFrame: true }).workflow, 'minimax_h3_i2v')
assert.equal(chooseRenderWorkflow({ action: '她走进店内', dialogue: '', hasEndFrame: true }).workflow, 'wan22_remix_flf2v')
assert.equal(chooseRenderWorkflow({ action: swordAction, dialogue: '让开。' }).workflow, 'minimax_h3_r2v')
assert.equal(chooseRenderWorkflow({
  action: 'Lu Hanzhou pulls out his smartphone, plays a recording of Su Tang voice',
  dialogue: '这瓶辣椒水喷雾真带劲'
}).workflow, 'minimax_h3_i2v')

const dual = 'Su Tang stumbles through the door and collides with Lu Hanzhou at the sink, her hands gripping his waist'
const solo = soloizeAction(stripOtherPersonClauses(stripEnglishCastNames(dual)))
assert.doesNotMatch(solo, /Su Tang|Lu Hanzhou|gripping|collides/i)
assert.doesNotMatch(motionCueFromAction(dual), /Su Tang|Lu Hanzhou|collides|gripping/i)

const sent = keepDialogueChinese(scrubSummoningTerms(videoMotionPrompt({
  action: swordAction,
  lookEn: manLook,
  scene: '竹林石桥',
  genreStyle: 'ancient costume'
})))
assert.equal(ageLockFor(manLook), 'face age matches the reference image')
assert.equal(negativeForSlot(false, ageDriftNegativeFor(manLook)), undefined)
assert.equal(negativeForSlot(true, 'blurry, low quality'), 'blurry, low quality')
assert.doesNotMatch(sent, /Negative directives|\b(car|cars|old man|elderly|vehicle|shirt|doorknob)\b/i)
assert.doesNotMatch(sent, /[\u4e00-\u9fff]/)
assert.match(sent, /mouth closed/)
assert.equal(keepDialogueChinese('scene 竹林 <d>[Chinese] 让开。</d>'), 'scene <d>[Chinese] 让开。</d>')

const shenLook = 'chinese man in his early 30s, black hair tied in a high bun, dark grey cotton short robe with black waist belt, long sword at hip'
const zhouLook = 'chinese man in his mid-20s, black hair in a low ponytail, grey-white cotton training outfit with hemp rope belt, holding a long sword'
assert.equal(extractOutfitLock(shenLook), 'dark grey cotton short robe with black waist belt')
assert.equal(extractOutfitLock(zhouLook), 'grey-white cotton training outfit with hemp rope belt')
const shenLock = identityLockBlock(shenLook)
assert.match(shenLock, /STRICT HAIR LOCK: black hair tied in a high bun/)
assert.match(shenLock, /STRICT OUTFIT LOCK: wear only dark grey cotton short robe with black waist belt/)
assert.doesNotMatch(shenLock, /no hat|马甲|围裙/)
const frameLock = frameAppearanceLock(zhouLook)
assert.match(frameLock, /low ponytail/)
assert.match(frameLock, /grey-white cotton training outfit with hemp rope belt/)
assert.doesNotMatch(frameLock, /帽子|马甲|围裙/)

console.log('pipeline-guards: ok')
