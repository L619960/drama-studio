# 分镜视频「跳帧 + 转场漂移」修复规范

日期：2026-10-16
测试项目：`p_1792109110654_gaov`（渲染验证·雨夜街巷，2 个 t2v 空镜）
证据目录：`docs/audit/render-test-2026-10-16/`（已存 raw/segments/final/ffprobe 结果）

---

## 1. 问题定性（均有实证，非推测）

### 1.1 「转场严重漂移」——合成端 0.3s 跨场景叠化鬼影（主因，与提示词无关）

- 用户两镜场景不同（雨后街巷 / 便利店门口），shot 上未指定 `transition`。
- [ffmpegService.ts](file:///e:/drama-studio/src/main/core/ffmpegService.ts#L491-L535) 的 `smartConcatSegments`：
  `transition` 缺省时，只要相邻镜 `scene` 不同就自动 `xfade=transition=fade:duration=0.3` + `acrossfade`。
- 两个画面内容、机位运动、光色均不同的竖屏镜叠化 0.3s，叠化区内双场景半透明交叠 = 用户看到的「转场画面严重漂移」。
- **结论**：模型提示词管不到这个问题，必须在合成端把「默认叠化」改为「默认硬切」，叠化只在分镜显式 `transition:'dissolve'` 时发生。

### 1.2 「跳帧」——提示词缺时间轴协议 + 时长数据不一致（提示词确有问题，用户判断成立）

提示词现状（[taskQueue.ts buildH3Prompt](file:///e:/drama-studio/src/main/core/taskQueue.ts#L376-L436)）逐条审计：

| # | 现状条款 | 问题标注 |
|---|---|---|
| 1 | 仅 `at 0.00 seconds <Picture 1> fully referenced` 一个首帧锚点 | **缺总时长声明、缺中段/尾段时间戳**。模型不知道要生成几秒、中段该发生什么、末帧该停在哪 → 自由插值，运动节奏随机 |
| 2 | `driftLockBlock` 空镜无 facing/continuity 时只剩一句通用「single atomic motion / no sudden movement」 | 无「恒速运动、逐帧连续、无重复帧/跳帧、镜内无剪辑」等帧序列稳定条款 |
| 3 | `VIDEO_NEGATIVE_DIRECTIVES` 有 no sudden movement/lighting flicker | 无 no in-clip cut / no crossfade / no freeze frame / no duplicated frames |
| 4 | 无末帧锚点（cut settle） | 硬切镜末段仍在大幅运动，切镜点两侧画面都在动 → 加剧跳变感 |
| 5 | 无镜间转场职责边界 | 模型可能自造 fade/黑场/甩镜头转场；转场本应由 ffmpeg 合成端负责 |
| 6 | t2v 空镜也无差别附加 `tablewareLock`（no chopsticks/no apron/no pushing the door/no reaching…） | 与空镜无关且会误伤空镜正常动作（推门/伸手类描述被负向压制），不规范 |
| 7 | 测试镜 promptEn 仅一句泛写，firstFrameEn/midFrameEn/lastFrameEn 全空 | Shot 已提供首/中/尾帧字段（[ipcTypes.ts](file:///e:/drama-studio/src/shared/ipcTypes.ts#L153) 附近）但组装链完全没用上 |

时长数据不一致（加重「慢动作/卡顿」观感，数据卫生问题）：

- 落盘 shot：`frameSeconds=2` 但 `frames=65`（渲染前 [taskQueue.ts L669-679](file:///e:/drama-studio/src/main/core/taskQueue.ts#L669-L679) 按 `SHOT_TIMING.minSec=4`（[ipcTypes.ts L93-101](file:///e:/drama-studio/src/shared/ipcTypes.ts#L93-L101)，产品方法论「无台词镜 4s 起」）改写 frames 后未回写 frameSeconds）。
- H3 链：sec=round((65-1)/16)=4 → 17k+5 网格 → LENGTH=107 → raw **24fps/107 帧/4.458s**（renderProfile.frames=107 证实）→ `normalizeSegment` 强制 `-vf fps=25`（[ffmpegService.ts L346-367](file:///e:/drama-studio/src/main/core/ffmpegService.ts#L346-L367)）→ 111 帧/4.48s → 智能裁剪 0.2+0.3s → 4.1s/镜。
- 即设计 2s、实际 4.46s：用户预期被违背；但 minSec=4 是既定方法论，**本次不改时长方法论**，只把 frameSeconds 与 frames 同步回写，测试镜按规范设 4s。

### 1.3 分辨率朝向错配（顺带坐实，纳入本次修复）

- shot 设计 720×480（横屏），H3 vars 直接用显存档位固定竖屏值 480×864（[comfyuiClient.ts VRAM_TIERS L63-71](file:///e:/drama-studio/src/main/core/comfyuiClient.ts#L63-L71)），完全忽略 shot 朝向 → 横屏构图被塞进竖屏裁切，也是「画面不对」的来源之一。

---

## 2. 权威提示词协议（单一 schema，H3 与 Wan 共用语义，按 fps 参数化）

### 2.1 新增「时间轴稳定块」`timelineProtocolBlock()`（英文，注入时在 sanitize 之后拼接，防被清洗）

```
TIMELINE PROTOCOL — target duration ~{SEC}s at {FPS} fps, one single continuous shot:
at 0.0s: opening frame matches the reference exactly, {firstFrameEn 或 "same subject, layout, lighting and tone as the reference"};
at {MID}s: {midFrameEn 或 promptEn 中的主动作}, moving at one constant smooth speed;
at {END}s: {lastFrameEn 或 "the motion completes and settles"}.
Frame rules: frame-to-frame incremental change only, constant motion speed, no sudden acceleration or stop,
no skipped frames, no duplicated frames, no frame hold, no interpolation jump, no in-clip cut,
no crossfade, no fade to black or white, no whip pan, no zoom punch, no new objects entering frame,
background geometry locked, lighting and exposure continuous with no flicker.
Ending rule({TRANSITION}):
- hard/smash/缺省 → final 0.4s the camera and all motion settle to a clean, stable final frame as a hard-cut point;
- dissolve → framing, color temperature and brightness stay steady through the last 0.5s for a clean dissolve.
```

参数：`{ sec, fps, transition, firstFrameEn?, midFrameEn?, lastFrameEn?, motionEn? }`
- MID = (sec-0.4)/2 四舍五入到 0.1；END = max(0, sec-0.4)。
- 三段文案优先级：shot 首/中/尾帧字段 > 从 promptEn/action 派生 > 通用兜底。
- H3：fps=24，块置于 H3 模板 `finalMotion` 之后、`Negative directives` 之前（沿用官方 `at N seconds` 格式）。
- Wan：fps=16，置于 qualityBlock 后、`. Negative directives:` 前。
- 时间轴块**不经过** sanitizeCinematicPrompt/sanitizeNeonPositive（先 sanitize 主体，后拼协议块）。

### 2.2 扩充 VIDEO_NEGATIVE_DIRECTIVES

追加：`no in-clip scene cut, no crossfade, no fade to black, no freeze frame, no duplicated frames, no frame skipping, no whip pan`

### 2.3 转场职责矩阵（落地边界）

| 层 | 职责 |
|---|---|
| 模型提示词（镜内） | 只描述本镜 0→END 的动作/运镜/光影；末帧按 transition 类型 settle；**禁止自造任何转场效果** |
| ffmpeg 合成端（镜间） | 仅 `transition:'dissolve'` 执行 0.3s xfade；`hard`/`smash`/缺省全部硬切 |
| LLM 分镜规范 | transition 必填语义：默认 hard；仅情绪转折/时间流逝用 dissolve；smash 用于强冲击 |

### 2.4 两个测试镜的完整标准 promptEn（重渲前写入，含首中尾三段）

**镜 1 雨后街巷（slow push-in，4s，hard out）**
- promptEn 主体：`slow push-in through a rainy night alley in an old town, stone pavement glistening with rainwater, red lanterns swaying gently, warm pools of lantern light shimmering on wet ground, fine rain falling continuously, shallow depth of field, photorealistic, cinematic color grading`
- firstFrameEn：`wide view of the empty narrow alley, nearest lantern at upper left, wet ground reflections fully visible`
- midFrameEn：`camera has pushed halfway in, lanterns grow slightly larger, rain streaks steady, reflections slide smoothly downward in frame`
- lastFrameEn：`push-in stops, alley held in steady framing, rain still falling at the same rate, lantern glow stable`

**镜 2 便利店门口（lateral dolly，4s，hard in/out）**
- promptEn 主体：`gentle lateral dolly past a glowing convenience store entrance on a rainy night, glass door condensation, fluorescent signboard light spilling across wet pavement, rain streaks sparkling as they cross the light, photorealistic, cinematic`
- firstFrameEn：`storefront seen from the left-front, signboard centered, empty sidewalk`
- midFrameEn：`camera has slid to the right by about one third, doorway shifts left in frame, light pool sweeps across the wet ground`
- lastFrameEn：`dolly stops with the entrance at frame left, framing locked, rain and sign light steady, no people entering`

两镜均：negativeEn 补 `extra people, cars passing, abrupt light change, text distortion`；transition='hard'；frameSeconds=4、frames=65 对齐；保持 width=720/height=480 横屏以同时验证朝向修复。

---

## 3. 代码变更清单（精确到文件/函数）

| 文件 | 变更 |
|---|---|
| [imagePrompts.ts](file:///e:/drama-studio/src/shared/imagePrompts.ts) | 新增导出 `timelineProtocolBlock(opts)`（§2.1）；`VIDEO_NEGATIVE_DIRECTIVES` 追加 §2.2 条款（编辑前先核对 sanitize 白名单不影响，本块设计为 sanitize 后拼接） |
| [taskQueue.ts](file:///e:/drama-studio/src/main/core/taskQueue.ts) | ① `buildH3Prompt(shot, project, withAudio, sec)` 增加 sec 参数，finalMotion sanitize 之后拼接 `timelineProtocolBlock({sec, fps:24, ...})`；② wan 分支 L945-964 prompt 拼接同样在 sanitize 后注入（fps:16, sec=wanDurationSec）；③ `tablewareLock` 收窄为仅 `shot.type==='i2v' && characterIds.length` 时附加；④ L669-679 frames 规范化后回写 `shot.frameSeconds = finalSec` |
| [ffmpegService.ts](file:///e:/drama-studio/src/main/core/ffmpegService.ts#L491-L496) | `fadeAt`：仅 `transition==='dissolve'` 返回 true；hard/smash/undefined 一律 false；同步更新函数注释（L469-472） |
| [comfyuiClient.ts](file:///e:/drama-studio/src/main/core/comfyuiClient.ts) 或 taskQueue H3 vars 处（L1003-1004） | H3 WIDTH/HEIGHT 按 shot 朝向：`shot.width >= shot.height` 时交换 tier 宽高（480×864 → 864×480，均为 32 倍数合法网格）；不新增配置项 |
| [llmService.ts](file:///e:/drama-studio/src/main/core/llmService.ts)（L600 附近分镜规范） | 补一条：transition 必填，默认 hard，dissolve 仅情绪转折/时间流逝（先读现状再最小改；如已有同义条款则跳过） |

**不做的事**：不改 SHOT_TIMING 时长方法论；不动 wan22_i2v.json / minimax_h3_i2v.json（帧率 16/24 与帧数网格已自洽）；不动 normalizeSegment 的 25fps 成片标准；不清理工作区改动、不 git commit；存量 typecheck 错误不处理。

## 4. 验收标准（全部需有证据，无证据不算完成）

1. **参数链**：从 ComfyUI /history 抓取实际提交 PROMPT 原文，含 TIMELINE PROTOCOL 全文与正确秒数/fps；LENGTH=107（17k+5）；分辨率 864×480 横屏。
2. **ffprobe**：raw 恒定 24fps、帧数 ∈ {17k+5}、时长=(N-1)/24±0.02s；segments 恒定 25fps；无帧率切换/重复 PTS 警告。
3. **帧稳定性**：每镜按 0/1/2/3/4s 抽 5 帧拼 contact sheet；相邻帧差用 ffmpeg `psnr`/`ssim` 或帧差 MAE 量化，背景区域无突变尖峰（报告数值）；末 0.4s 两帧 SSIM 显著高于运动段（验证 settle）。
4. **转场边界**：final 在切点前 3 帧/后 3 帧抽帧，硬切边界两侧场景各自纯净、无半透明鬼影；final 中检测不到 0.3s 叠化区间；成片总时长 = 镜1裁剪后 + 镜2裁剪后（无叠化扣减）。
5. **frameSeconds 同步**：重渲后 project.json 中两镜 frameSeconds=4、frames=65、renderProfile.frames=107。
6. 报告输出 `docs/audit/render-fix-2026-10-16.md`：问题标注表、提交给模型的完整 PROMPT 原文（两镜）、ffprobe JSON、抽帧图、SSIM 数值、转场边界图；归集副本放 `docs/audit/render-fix-2026-10-16/`；临时脚本放 %TEMP% 用完即删。
7. 仅操作测试项目 `p_1792109110654_gaov`，不碰真实用户项目。

## 5. 风险

- H3 8 步 turbo + 长协议文本：协议为官方 `at N seconds` 原生格式，已有台词镜先例（0.4s 锚点），风险低；若画面出现约束互斥，以时间轴块为准复测。
- 默认转场改硬切影响既有观感：LLM 显式 dissolve 路径保留；用户可在分镜上逐镜指定。
- 若重渲后模型仍有显著帧抖动（模型 8 步采样固有），报告中如实区分「提示词/合成问题已闭环」与「模型采样质量残余」，不宣称完美。
