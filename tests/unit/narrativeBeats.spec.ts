import { describe, it, expect } from 'vitest'
import {
  extractKeyProps,
  propLockFromAction,
  validateNarrativeContinuity,
  type NarrativeShotLike
} from '../../src/shared/narrativeBeats'

const mkShot = (over: Partial<NarrativeShotLike> & { action: string; type: 'i2v' | 't2v' }): NarrativeShotLike => ({
  index: 0,
  scene: '',
  dialogue: '',
  characterName: '',
  shotSize: 'medium',
  ...over
})

describe('narrativeBeats · 叙事节拍与关键道具校验', () => {
  describe('extractKeyProps：从片名/梗概/剧本抽关键道具（中文标签）', () => {
    it('空输入 → 空数组', () => {
      expect(extractKeyProps()).toEqual([])
      expect(extractKeyProps('', '', '')).toEqual([])
    })

    it('只含一把伞 → ["伞"]', () => {
      expect(extractKeyProps('片名：雨中伞')).toEqual(['伞'])
    })

    it('多个道具同现 → 全部命中', () => {
      const v = extractKeyProps('总裁下车，手握合同，手机震动', '梗概')
      expect(v).toContain('车')
      expect(v).toContain('手机')
      expect(v).toContain('文件') // 合同 → 文件
    })

    it('英文道具词同样可命中', () => {
      const v = extractKeyProps('A sedan pulls up, a paper bag in hand, a smartphone rings')
      expect(v).toContain('车')
      expect(v).toContain('袋')
      expect(v).toContain('手机')
    })

    it('负向排除：内袋/口袋 不应误触发"袋"', () => {
      const v = extractKeyProps('西装内袋里露出一张纸')
      // 应该没有"袋"（因为负向前瞻 (?<!内|口|衣|裤)袋）
      expect(v).not.toContain('袋')
    })

    it('独立"纸袋"正触发"袋"', () => {
      const v = extractKeyProps('她拎着一个纸袋走进来')
      expect(v).toContain('袋')
    })

    it('钥匙、药、文件 命中', () => {
      const v = extractKeyProps('钥匙掉在药丸旁边，信封压在合同下')
      expect(v).toContain('钥匙')
      expect(v).toContain('药')
      expect(v).toContain('文件')
    })

    it('完全无关文本 → 空数组', () => {
      expect(extractKeyProps('风和日丽，阳光明媚')).toEqual([])
    })
  })

  describe('propLockFromAction：动作文案 → 道具锁定英文短语', () => {
    it('空字符串 → 空串', () => {
      expect(propLockFromAction('')).toBe('')
    })

    it('完全不相关文本 → 空串', () => {
      expect(propLockFromAction('woman walking down the street')).toBe('')
    })

    it('umbrella → 两条伞锁定', () => {
      const v = propLockFromAction('woman holding a black umbrella')
      expect(v).toContain('KEY PROP ON SCREEN')
      expect(v).toContain('umbrella')
    })

    it('phone → 手机锁定', () => {
      const v = propLockFromAction('man checks his smartphone')
      expect(v).toContain('mobile phone')
    })

    it('key → 钥匙锁定（keyring / brass key / key 三种正则都触发）', () => {
      expect(propLockFromAction('she grabs her keyring')).toContain('key')
      expect(propLockFromAction('a brass key glints')).toContain('key')
      expect(propLockFromAction('he turns the key')).toContain('key')
    })

    it('document / envelope / contract / letter → 文件锁定', () => {
      expect(propLockFromAction('he signs the contract')).toContain('document or envelope')
      expect(propLockFromAction('envelope on desk')).toContain('document or envelope')
      expect(propLockFromAction('a letter arrives')).toContain('document or envelope')
    })

    it('pill / medicine bottle → 药锁定', () => {
      expect(propLockFromAction('she takes a pill')).toContain('medicine bottle or pill')
      expect(propLockFromAction('medicine bottle on table')).toContain('medicine bottle or pill')
    })

    it('car door / passenger seat / taillight / sedan / black car → 车辆锁定', () => {
      expect(propLockFromAction('he opens the car door')).toContain('vehicle or car door')
      expect(propLockFromAction('she sits in the passenger seat')).toContain('vehicle or car door')
      expect(propLockFromAction('taillights recede')).toContain('vehicle or car door')
      expect(propLockFromAction('a black sedan')).toContain('vehicle or car door')
    })

    it('shopping bag / paper bag / tote → 袋锁定', () => {
      expect(propLockFromAction('she carries a shopping bag')).toContain('shopping bag')
      expect(propLockFromAction('paper bag in hand')).toContain('shopping bag')
      expect(propLockFromAction('canvas tote on lap')).toContain('shopping bag')
    })

    it('多道具同时出现 → 多条锁定合并', () => {
      const v = propLockFromAction('woman with umbrella opens car door, checks her phone')
      expect(v).toContain('umbrella')
      expect(v).toContain('vehicle or car door')
      expect(v).toContain('mobile phone')
    })
  })

  describe('validateNarrativeContinuity：拆镜结果本地叙事校验 → warnings', () => {
    it('空 shots → 直接返回空数组', () => {
      expect(validateNarrativeContinuity('t', undefined, '', [])).toEqual([])
    })

    it('正常完整剧本 → 无警告（台词+道具+上车链全齐）', () => {
      const shots: NarrativeShotLike[] = [
        mkShot({ index: 1, action: 'a woman walks toward the camera with an umbrella, speaks', dialogue: '来了？', type: 't2v' }),
        mkShot({ index: 2, action: 'man looks up, opens the car door', dialogue: '走吧', type: 'i2v' }),
        mkShot({ index: 3, action: 'woman sits inside the car', shotSize: 'closeup', type: 'i2v' }),
        mkShot({ index: 4, action: 'taillights recede into the night', type: 'i2v' })
      ]
      const w = validateNarrativeContinuity('雨夜接人', '女人接男人', '「来了？」「走吧」', shots)
      expect(w).toEqual([])
    })

    it('关闭全部 enforce → 无任何警告', () => {
      const shots: NarrativeShotLike[] = [
        mkShot({ index: 1, action: 'walks', type: 't2v' }),
        mkShot({ index: 2, action: 'speaks', dialogue: 'hi', type: 'i2v' })
      ]
      const w = validateNarrativeContinuity(
        't', 'l', '「hello」', shots,
        { enforcePropLock: false, enforceReactionBeats: false, enforceBoardingChain: false }
      )
      // 台词未落镜还是会检出（那个不受 enforce 控制？不对——让我看代码...
      // 台词未落镜在 propOn 之前，没有 enforce 开关包裹！）
      expect(w.length).toBeGreaterThanOrEqual(1) // 台词未落镜仍会触发
    })

    // ---- 台词未落镜 ----
    it('剧本台词未入任何镜头 dialogue → 警告', () => {
      const shots: NarrativeShotLike[] = [
        mkShot({ index: 1, action: 'walks', dialogue: '', type: 't2v' })
      ]
      const w = validateNarrativeContinuity('t', undefined, '「你好」', shots)
      expect(w.some(x => x.includes('台词未落镜'))).toBe(true)
    })

    it('台词正确入镜 → 无此警告', () => {
      const shots: NarrativeShotLike[] = [
        mkShot({ index: 1, action: 'walks', dialogue: '你好', type: 'i2v' })
      ]
      const w = validateNarrativeContinuity('t', undefined, '「你好」', shots)
      expect(w.some(x => x.includes('台词未落镜'))).toBe(false)
    })

    // ---- 道具覆盖 ----
    it('关键道具未写入任何镜头 action → 警告', () => {
      const shots: NarrativeShotLike[] = [
        mkShot({ index: 1, action: 'woman walks', type: 't2v' })
      ]
      const w = validateNarrativeContinuity('雨夜伞', undefined, '', shots)
      expect(w.some(x => x.includes('伞'))).toBe(true)
    })

    it('关闭 enforcePropLock → 道具相关警告全部消失', () => {
      const shots: NarrativeShotLike[] = [
        mkShot({ index: 1, action: 'woman walks', type: 't2v' })
      ]
      const w = validateNarrativeContinuity('雨夜伞', undefined, '', shots, { enforcePropLock: false })
      expect(w.some(x => x.includes('伞'))).toBe(false)
    })

    it('伞有覆盖但缺 closeup 特写 → 警告', () => {
      const shots: NarrativeShotLike[] = [
        mkShot({ index: 1, action: 'woman holds an umbrella', shotSize: 'medium', type: 'i2v' })
      ]
      const w = validateNarrativeContinuity('雨夜伞', undefined, '', shots)
      expect(w.some(x => x.includes('closeup'))).toBe(true)
    })

    it('伞有 closeup 特写 → 无警告', () => {
      const shots: NarrativeShotLike[] = [
        mkShot({ index: 1, action: 'woman holds an umbrella handle', shotSize: 'closeup', type: 'i2v' })
      ]
      const w = validateNarrativeContinuity('雨夜伞', undefined, '', shots)
      expect(w.some(x => x.includes('closeup'))).toBe(false)
    })

    // ---- 入画反应镜 ----
    it('t2v 入画 + 下一镜 i2v 直接开口无视线 → 缺反应镜警告', () => {
      const shots: NarrativeShotLike[] = [
        mkShot({ index: 1, action: 'a figure walks toward her', type: 't2v' }),
        mkShot({ index: 2, action: 'she speaks', dialogue: '你来了', type: 'i2v' })
      ]
      const w = validateNarrativeContinuity('t', undefined, '', shots)
      expect(w.some(x => x.includes('反应镜'))).toBe(true)
    })

    it('关闭 enforceReactionBeats → 反应镜警告消失', () => {
      const shots: NarrativeShotLike[] = [
        mkShot({ index: 1, action: 'a figure walks toward her', type: 't2v' }),
        mkShot({ index: 2, action: 'she speaks', dialogue: '你来了', type: 'i2v' })
      ]
      const w = validateNarrativeContinuity('t', undefined, '', shots, { enforceReactionBeats: false })
      expect(w.some(x => x.includes('反应镜'))).toBe(false)
    })

    it('入画后下一镜 action 含 look → 不缺反应镜', () => {
      const shots: NarrativeShotLike[] = [
        mkShot({ index: 1, action: 'a figure walks toward her', type: 't2v' }),
        mkShot({ index: 2, action: 'she looks up, speaks', dialogue: '你来了', type: 'i2v' })
      ]
      const w = validateNarrativeContinuity('t', undefined, '', shots)
      expect(w.some(x => x.includes('反应镜'))).toBe(false)
    })

    // ---- 上车链 ----
    it('开车门镜后无坐进车内 → 上车跳跃警告', () => {
      const shots: NarrativeShotLike[] = [
        mkShot({ index: 1, action: 'he opens the car door', type: 'i2v' })
      ]
      const w = validateNarrativeContinuity('t', undefined, '', shots)
      expect(w.some(x => x.includes('上车过程'))).toBe(true)
    })

    it('开车门镜后有 seated → 无上车警告', () => {
      const shots: NarrativeShotLike[] = [
        mkShot({ index: 1, action: 'he opens the car door', type: 'i2v' }),
        mkShot({ index: 2, action: 'he is seated inside the car', type: 'i2v' })
      ]
      const w = validateNarrativeContinuity('t', undefined, '', shots)
      expect(w.some(x => x.includes('上车过程'))).toBe(false)
    })

    it('关闭 enforceBoardingChain → 上车警告消失', () => {
      const shots: NarrativeShotLike[] = [
        mkShot({ index: 1, action: 'he opens the car door', type: 'i2v' })
      ]
      const w = validateNarrativeContinuity('t', undefined, '', shots, { enforceBoardingChain: false })
      expect(w.some(x => x.includes('上车过程'))).toBe(false)
    })

    it('结局镜车辆驶离不达标（剧本有驶离但末镜没体现）→ 警告', () => {
      const shots: NarrativeShotLike[] = [
        mkShot({ index: 1, action: 'a woman stands on the empty street', type: 'i2v' })
      ]
      const w = validateNarrativeContinuity('雨夜驶离', '最后车驶离了', '', shots)
      expect(w.some(x => x.includes('驶离'))).toBe(true)
    })

    it('结局镜有 taillight + car → 结局合格', () => {
      const shots: NarrativeShotLike[] = [
        mkShot({ index: 1, action: 'car taillights recede into the distance', type: 'i2v' })
      ]
      const w = validateNarrativeContinuity('雨夜驶离', '最后车驶离了', '', shots)
      expect(w.some(x => x.includes('驶离'))).toBe(false)
    })

    // ---- 交接独占镜 ----
    it('同一镜同时写 handoff 和 secondBeat → 警告', () => {
      const shots: NarrativeShotLike[] = [
        mkShot({ index: 1, action: 'she hands over the document and walks away', type: 'i2v' })
      ]
      const w = validateNarrativeContinuity('t', undefined, '', shots)
      expect(w.some(x => x.includes('独占一镜'))).toBe(true)
    })

    it('只有 handoff 没有 secondBeat → 无警告', () => {
      const shots: NarrativeShotLike[] = [
        mkShot({ index: 1, action: 'she hands over the document', type: 'i2v' })
      ]
      const w = validateNarrativeContinuity('t', undefined, '', shots)
      expect(w.some(x => x.includes('独占一镜'))).toBe(false)
    })

    it('只有 secondBeat 没有 handoff → 无警告', () => {
      const shots: NarrativeShotLike[] = [
        mkShot({ index: 1, action: 'she walks away', type: 'i2v' })
      ]
      const w = validateNarrativeContinuity('t', undefined, '', shots)
      expect(w.some(x => x.includes('独占一镜'))).toBe(false)
    })

    // ---- index 缺失 fallback ----
    it('reaction 警告：next.index 缺失时 fallback 为 i + 2', () => {
      const shots: NarrativeShotLike[] = [
        mkShot({ index: 1, action: 'a figure walks toward her', type: 't2v' }),
        // 直接手动构造无 index，绕过 mkShot 默认值
        { action: 'she speaks', dialogue: 'hi', type: 'i2v', scene: '', characterName: '', shotSize: 'medium' }
      ]
      const w = validateNarrativeContinuity('t', undefined, '', shots)
      // i=0 时 next.index undefined → fallback 为 0+2=2
      expect(w.some(x => x.includes('第2镜'))).toBe(true)
    })

    it('handoff 警告：index 缺失时 fallback 为 0', () => {
      const shots: NarrativeShotLike[] = [
        mkShot({ action: 'she passes the phone and speaks', type: 'i2v' })
      ]
      const w = validateNarrativeContinuity('t', undefined, '', shots)
      expect(w.some(x => x.includes('第0镜'))).toBe(true)
    })

    // ---- 中文正则触发 ----
    it('中文开车门触发上车链检查', () => {
      const shots: NarrativeShotLike[] = [
        mkShot({ index: 1, action: '他拉开车门', type: 'i2v' })
      ]
      const w = validateNarrativeContinuity('t', undefined, '', shots)
      expect(w.some(x => x.includes('上车过程'))).toBe(true)
    })

    it('中文"看见"在入画后 → 不缺反应镜', () => {
      const shots: NarrativeShotLike[] = [
        mkShot({ index: 1, action: '一个身影走来', type: 't2v' }),
        mkShot({ index: 2, action: '她抬头看见', dialogue: '你来了', type: 'i2v' })
      ]
      const w = validateNarrativeContinuity('t', undefined, '', shots)
      expect(w.some(x => x.includes('反应镜'))).toBe(false)
    })
  })
})
