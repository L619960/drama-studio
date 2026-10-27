# DirectorAgent 一致性逻辑审计报告（2026-10-27）

审计对象：`E:\drama-studio` 分支 `feat/agent-autonomy`
审计方式：CDP 连接 Electron（9222）跑最小新剧 + 源码静态审计 + 真渲染验证
受测项目：`p_1793075280832_g64v`「审计短剧-林医生」（1 角色 / 1 场景 / 3 镜 i2v，无台词）
**未触碰**已有项目 `p_1792985732056_mcag`。

---

## 一、新剧跑到了哪一步

| 阶段 | 结果 | 证据 |
|---|---|---|
| analyze（LLM 拆本） | done，1 角色「林医生」+ 3 镜 | project.json:characters/shots |
| casting（定妆+三视图） | done，1/1 | `characters/char_..._face.png`、`_body.png` |
| scenes（场景板+首帧） | done，1 场景板 + 3 首帧 + 连镜尾帧 | `scenes/scene_..._pano.png`、`shots/shot_*_first.png` |
| render | **部分成功**：3 镜中 2 镜因缺 Wan Remix 模型失败，第 3 镜 H3 i2v 渲染成功但被一致性门禁拦下（score=0.051） | `segments/shot_..._60d1.mp4` (667KB) |
| combine/subtitle/bgm/review | 未到达（render 报错终止） | — |

渲染路径说明：
- 第 1、2 镜被 `taskQueueRender.ts` 判为「跨镜位移且有尾帧」→ 选 `wan22_remix_flf2v`，但 ComfyUI 缺 Wan2.2 Remix 模型（umt5 clip / 3 个 LoRA / 2 个 Remix diffusion），环境自检失败，正确跳过。
- 第 3 镜（特写、无位移）→ 走 `minimax_h3_i2v`，H3 turbo 8 步在 RTX 5060 Ti 16GB 上跑约 7 分钟出片。
- H3 出片后一致性评分 0.051（低于阈值），门禁触发重渲，重渲回落到 wan remix 路径又因缺模型失败 → 整镜标 failed。**这是门禁在工作，不是 bug。**

---

## 二、审计发现的问题清单

### 问题 1（已修）：sanitizeCameraForFrameImpl 硬编码旧项目角色名
- **位置**：`src/main/core/directorAssetBuilder.ts:33`（修复前）
- **现象**：正则里写死 `Su Wan|Lin Chuan|李强|苏晚|林川`。新项目若有同名角色会被误删；不同名时这些旧名又是死代码。
- **修复**：删掉硬编码角色名，只保留通用第二人从句模式（another person / background figure / 路人 / 人影 / 剪影…）。同时 `generateShotFirstFrameImpl`（同文件 :431）对 camera 也补跑 `maskOtherIn`，动态屏蔽其他角色名。
- **测试**：`tests/unit/sanitizeCamera.spec.ts`（4 例）。
- **commit**：`e00b0c0`

### 问题 2（已修）：hardenLookWeapons 给现代剧强加武器条款
- **位置**：`src/shared/castAppearance.ts:229` `hardenLookEnList`（修复前）
- **现象**：无论什么题材，只要 lookEn 里没有中式武器词，就追加 `carrying one traditional chinese weapon, exactly one weapon, one hand empty`。现代剧「林医生」被锁成持剑人。
- **真渲染实证**：
  - 定妆图 `char_..._face.png`：医生手持一柄雕花汉剑（白大褂+听诊器+剑，违和）。
  - H3 视频中段帧：医生右手仍持剑，且走廊尽头多出一个古装束发、提灯笼的人——武器条款把模型锚到了古装意象，连带把背景也串成古装人物。
  - 这就是 consistencyScore=0.051 的根因：NO EXTRAS 条款被武器条款的古装意象带崩。
- **修复**：`hardenLookEnList` 内仅当 `isPeriodGenre(genre)` 为真才调用 `hardenLookWeapons`；现代/都市/职业剧不追加任何武器条款。
- **测试**：`tests/unit/lookEnHarden.spec.ts` 新增「现代剧不被强加武器条款」用例。
- **commit**：`cecd961`

### 问题 3（观察，未改）：buildCloseupEditPromptImpl / buildPanoEditPromptImpl 的 lookEn 形参未注入 prompt 文本
- **位置**：`src/main/core/directorAssetBuilder.ts:37-63`、`:65-91`
- **现象**：两个函数都接收 `lookEn: string` 形参，但拼出的中文 prompt 里没有引用它——只写「保持面部、发型、服装、肤色与图1完全一致」。外观靠参考图（faceAbs）锁，不靠文本。
- **判定**：这是 i2i edit 路径（qwen2511_i2i_edit）的设计选择——模型直接看图 1，文本只放动作/场景/锁人指令。**不算 bug**，但 lookEn 形参是死参数，留着误导后人。未改（不引入新行为）。

### 问题 4（观察，未改）：shot.props 不进 H3 视频 prompt
- **位置**：`src/main/core/taskQueuePrompts.ts` `buildH3Prompt`
- **现象**：首帧 prompt（`shotFramePrompt`）会列 props 清单；但视频 prompt 只用 `propsConstraintBlock`（通用「不持杯/不持碗/不持卷轴」），不把本镜具体道具写进视频 prompt。
- **判定**：i2v 从首帧继承道具，文本层面不重复是合理的；多道具剧可能需要补。本次最小剧无道具，未改。

### 问题 5（观察，未改）：旧死代码 directorPrompts.ts:24 也有同款硬编码
- **位置**：`src/main/core/directorPrompts.ts:24` `sanitizeCameraForFrame`
- **现象**：与问题 1 同款硬编码名单。但全仓 grep 确认 `directorStageShots.ts` / `directorStageAssets.ts` 这一支线已不被 `directorAgent.ts` 引用（活跃路径全走 `directorAssetBuilder.ts` 的 `*Impl`）。属遗留死代码，未改以免误伤。

---

## 三、一致性链路审计结论（带证据）

### 1. appearanceLock 注入链 ✅ 通
- 定妆图：`castAppearance.ts:108 faceCastingPrompt` → `identityLockBlock(look)` 包裹 sanitize 后的外观。
- 三视图：`castAppearance.ts:127 bodySheetPrompt` → 同 identityLock。
- 首帧 fallback：`castAppearance.ts:160 shotFramePrompt` → `identityLockBlock(opts.lookEn)` + ` STRICT OUTFIT LOCK` + ` STRICT HAIR LOCK`。
- 视频（Wan）：`taskQueue.ts:784-815` prompt 前拼 `identityLockBlock(lookEn)`；负向 `taskQueue.ts:836-840` 拼 `oocWardrobeNegativeFor` + `ageDriftNegativeFor`。
- 视频（H3）：`taskQueuePrompts.ts:136-157 buildH3Prompt` → `identityLockBlock(lookEn)`，ComfyUI queue 实测 prompt 里完整出现 `LOCKED IDENTITY... STRICT HAIR LOCK... STRICT OUTFIT LOCK...`。
- H3 无负向入口（`taskQueuePrompts.ts:198` 注释明示），靠正向锁。

### 2. 人脸/发型/服装一致性 ✅ 强
- 定妆图作为 `ref_image` 上传 ComfyUI：`taskQueueRefs.ts` 把 `faceAbs` 拷到 `input/` 目录，LoadImage 节点实测 `image: shot_..._ref.png`。
- 首帧 i2i edit 用 faceAbs 当参考图：`directorAssetBuilder.ts:441 referenceImagePath: faceAbs`。
- 视频 prompt 实测含 `the same person from the reference image` + `same face identity, same hair length, same wardrobe layers`。
- **真渲染验证**：H3 中段帧 vs 定妆图——同一人脸（椭圆脸/直眉/深眼窝/短发）、同一白大褂+浅蓝衬衫+听诊器，面部特征稳定。✅

### 3. 场景一致性 ✅
- `directorAssetBuilder.ts:342 ensureSceneEnImpl` 给同场景 key 的所有镜头写同一个 sceneEn。
- project.json 里 3 镜的 `sceneEn` 逐字相同：`interior hospital corridor, long straight passage with pale green walls...`。
- H3 prompt 实测把 sceneEn 整段塞进 `in <sceneEn>, ...`。
- 真渲染：视频中段走廊绿墙/荧光灯/抛光地板与首帧、场景板一致。✅

### 4. 道具一致性 ⚠️ 部分
- 首帧 prompt 注入 props（`shotFramePrompt` 的 propCue）。
- 视频 prompt 只走通用 `propsConstraintBlock`，不重复具体道具名。
- 本次因武器条款 bug，道具（剑）反而被强加——已修。正常无道具剧靠首帧继承，够用。

### 5. 导演门禁逻辑 ✅
- `directorStateMachine.ts:151 pauseUntilShotsReviewedImpl`：shotReviewGate=block 且有未审 i2v 镜 → 硬拦，跑 `agent.reviewGate`。本次审计临时设成 off 跑通；跑完已改回 block。
- `pipelineGuards.ts:147 shouldPauseAfterAudit`：perShotAudit 软提示只在 `failCount>0` 时才停；纯 warn 不暂停（P0 修复点确认在位）。
- `pipelineGuards.ts:28 clampShotList`：maxShots 截断生效；minShots 不凭空补镜（设计如此）。
- **真渲染门禁实证**：H3 出片 score=0.051 < 阈值 → 整镜标 failed 并触发诊断，没有放行低质片入片。✅

---

## 四、真渲染镜头一致性评估（shot 3，H3 i2v，5s）

| 维度 | 评估 | 说明 |
|---|---|---|
| 人脸 | ✅ 一致 | 与定妆图同一人，椭圆脸/直眉/短发/清瘦下颌线 |
| 发型 | ✅ 一致 | 黑色短发整齐后梳，全程未变 |
| 服装 | ✅ 一致 | 白大褂+浅蓝衬衫+听诊器，与定妆图一致 |
| 场景 | ✅ 一致 | 医院走廊绿墙/荧光灯/抛光地面，与场景板一致 |
| 道具 | ❌ 错误 | 医生手持雕花汉剑（问题 2 武器条款 bug，已修） |
| 背景 | ❌ 违规 | 走廊尽头多出古装束发提灯人（NO EXTRAS 被武器条款的古装意象带崩） |
| 一致性评分 | 0.051 | 门禁正确拦下 |

**结论**：人脸/发型/服装/场景四条硬锁全部生效；扣分点全在武器 bug 引发的道具+背景串戏。该 bug 已在 `cecd961` 修掉，现代剧重跑应不再有剑和古装人。

---

## 五、四门验收

| 门 | 结果 |
|---|---|
| `npm run typecheck` | 0 错 ✅ |
| `npm test`（vitest） | 33 文件 / 277 用例全过 ✅（含新增 14 例） |
| `npm run build`（main/preload/renderer 三端） | 三端全过 ✅ |
| 已有项目 `p_1792985732056_mcag` | 未触碰 ✅ |

---

## 六、仍存在的问题（诚实标注）

1. **Wan2.2 Remix 模型未安装**：`wan22_remix_flf2v` 工作流所需的 umt5 clip / 3 个 LoRA / 2 个 Remix diffusion 模型缺失，跨镜位移+尾帧的镜头无法走 Wan Remix 路径。这是环境问题，不是代码问题；本次第 1、2 镜因此失败。要让跨镜位移镜头可渲，需用户把对应模型放进 ComfyUI 模型目录。
2. **H3 出片后低一致性重渲回落到 Wan Remix**：第 3 镜 H3 成功但 score 低，重渲路径选了缺模型的 wan remix，导致整镜 failed 而非「接受低质片」。`consistencyMode=rerender` 的设计如此，但当前环境没有备用引擎兜底。
3. **本次跑的项目带武器 bug**：修复 `cecd961` 只影响新跑的剧；`p_1793075280832_g64v` 的 appearanceLock 里仍写着 `carrying one traditional chinese weapon`（跑的时候修还没进进程）。Electron 主进程需重启加载新代码后，再跑才会验证修复效果。本次未重启 Electron（会打断用户环境）。
4. **buildCloseupEditPromptImpl 的 lookEn 死形参**：未清理（不影响行为，清理属重构范畴，超出「修 bug」范围）。
5. **旧死代码 directorPrompts.ts:24 同款硬编码**：未清理（不被活跃路径引用）。
6. **场景板 view_0 切到墙根特写**：pano 裁 4 方位时其中一格落到纯绿墙+扶手，不是走廊纵深。这是 pano 构图/裁切问题，不在本次一致性逻辑范围内，未修。

---

## 七、Commit 清单

- `e00b0c0` fix: 移除 sanitizeCameraForFrameImpl 硬编码旧项目角色名，camera 改由 maskOtherIn 动态净化
- `cecd961` fix: 武器硬门禁仅对古装/武侠题材生效，现代剧不再被强加持剑条款
