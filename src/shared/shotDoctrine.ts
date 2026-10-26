/**
 * 短剧单镜口径。拆镜提示、帧数钳制、台词尾白都读这里。
 * 对白镜留短尾白，全片最后一镜和情绪按钮镜留长尾白。
 */
export const SHOT_DOCTRINE = {
  minSec: 4,
  maxSec: 6,
  dialogueTailSec: 0.5,
  buttonTailSec: 1.2,
  stillTailSec: 0.4,
  readableFaces: 1
} as const

export function audioTailSecFor(opts: { dialogue?: string; emotion?: string; isLast?: boolean }): number {
  if (opts.isLast) return SHOT_DOCTRINE.buttonTailSec
  if (/climax|tear|sob|决裂|崩溃|痛哭/.test(opts.emotion || '')) return SHOT_DOCTRINE.buttonTailSec
  if ((opts.dialogue || '').trim()) return SHOT_DOCTRINE.dialogueTailSec
  return SHOT_DOCTRINE.stillTailSec
}

/** 放在拆镜系统提示最前，覆盖后文里互相冲突的时长和人数句子。 */
export function doctrinePromptBlock(): string {
  const d = SHOT_DOCTRINE
  return [
    '# 成片口径（高于后文任何冲突句子）',
    `单镜时长 ${d.minSec}~${d.maxSec} 秒。`,
    '一镜只允许一张可读人脸；对手戏拆成正反打，另一人只可背影或虚化过肩。',
    '对白镜和反应镜只拍动作完成态的微表演。递接、耳光、拥抱、上车各占一个独立短镜。',
    '对白镜说完留白约 0.5 秒；全片最后一镜留白 1.2 秒。'
  ].join('\n')
}
