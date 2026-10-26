// 复刻 llmService.backfillMissingProps 关键逻辑做行为验证（临时验证脚本）
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function backfill(props, shots) {
  const warnings = []
  for (const prop of props) {
    const en = prop.en || prop.zh
    const key = en.toLowerCase()
    const re = new RegExp('\\b' + esc(key).split(' ')[0], 'i')
    const assigned = shots.some(s => {
      const inProps = (s.props || []).some(p => p.toLowerCase().includes(key))
      const inAction = re.test(s.action)
      return inProps || inAction
    })
    if (assigned) continue
    const target = shots.find(s => s.type === 'i2v') || shots[0]
    if (!target) { warnings.push('no target'); continue }
    target.props = [...(target.props || []), en]
    const add = 'holding a ' + en + ', clearly visible'
    if (!re.test(target.action)) target.action = target.action.trim().replace(/[.,;]?\s*$/, '') + ', ' + add
    warnings.push('backfilled to shot ' + (shots.indexOf(target) + 1))
  }
  return warnings
}

let pass = 0, fail = 0
function check(name, cond) { cond ? pass++ : (fail++, console.log('FAIL:', name)) }

// 用例1：袋未分配 → 注入第一个 i2v
let shots = [
  { type: 'i2v', action: 'woman looks up, surprised', props: [] },
  { type: 'i2v', action: 'she speaks', props: ['phone'] },
  { type: 't2v', action: 'empty alley', props: [] }
]
let w = backfill([{ zh: '袋', en: 'paper bag' }], shots)
check('case1 注入到镜1', shots[0].props.includes('paper bag'))
check('case1 action 注入', /holding a paper bag/.test(shots[0].action))
check('case1 记录 warning', w.length === 1)

// 用例2：已在 action 出现 → 不注入
shots = [{ type: 'i2v', action: 'holding a paper bag, walking', props: [] }]
w = backfill([{ zh: '袋', en: 'paper bag' }], shots)
check('case2 不重复注入', w.length === 0 && shots[0].props.length === 0)

// 用例3：props 已有 → 不注入
shots = [{ type: 'i2v', action: 'she sits', props: ['paper bag'] }]
w = backfill([{ zh: '袋', en: 'paper bag' }], shots)
check('case3 不重复注入', w.length === 0)

// 用例4：全 t2v → 注入第一镜
shots = [{ type: 't2v', action: 'rainy street', props: [] }]
w = backfill([{ zh: '伞', en: 'black umbrella' }], shots)
check('case4 注入 t2v 镜', shots[0].props.includes('black umbrella'))

// 用例5：多道具，一个已分配一个未分配
shots = [{ type: 'i2v', action: 'handing over a ring', props: ['ring'] }]
w = backfill([{ zh: '戒指', en: 'ring' }, { zh: '袋', en: 'paper bag' }], shots)
check('case5 只补袋', w.length === 1 && shots[0].props.includes('paper bag'))

// 用例6：空列表直接返回
shots = [{ type: 'i2v', action: 'x', props: [] }]
w = backfill([], shots)
check('case6 空列表', w.length === 0 && shots[0].props.length === 0)

console.log(`PASS=${pass} FAIL=${fail}`)
process.exit(fail > 0 ? 1 : 0)
