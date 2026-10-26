# Drama Studio 设计缺陷审查报告

**审查日期：** 2026-10-20
**审查对象：** `E:\drama-studio` 全仓源码与配置（主进程 20+ 核心服务、preload、shared 契约、renderer 46 文件、workflows、skills、构建配置）
**审查方法：** 静态全量代码走读（核心文件全文 + 渲染层抽样），每条结论带 `文件:行号` 证据；触发面不确定的结论明确标注为「风险面」，不夸大。

## 一、与既有审计的关系

本仓已有三份基线文档，本报告**不重复罗列**其已收录问题，仅在其基础上增量审查：

| 基线 | 覆盖维度 | 本报告关系 |
|------|----------|-----------|
| `交互整改清单-2026-10-18.md` | UI 交互（确认框/哨兵/全局兜底） | 已治理项视为关闭 |
| `docs/efficiency-audit-2026-10-19.md` | 44 项效率/逻辑问题（P0×7 / P1×17 / P2×20） | 引用其编号，不重复计分 |
| `docs/industry-lessons-ai-microdrama-2026-10-19.md` | 行业经验映射 | 引用 §7/§8 不变式 |

**本报告增量聚焦三类基线未覆盖的维度：安全与信任边界、数据完整性与正确性、架构与工程质量**，另补可靠性/资源管理缺口。

**本次新增合计 20 项：P1×3、P2×10、P3×7。**

---

## 二、新增问题清单

### A. 安全与信任边界（基线审计未覆盖）

#### S-01【P1】IPC 任意本地视频读取 + 帧数据外发链：`videoPath` 未做路径校验
- **位置：** `src/main/index.ts:413-416`（`ffmpegExtractFrames`）、`:1314-1317`（`llmWriteScriptFromVideo`）→ `ffmpegService.extractFrames(videoPath, …)` → `llmService.writeScriptFromFrames`（远程 LLM）
- **证据：** 同文件其余文件类 IPC 均做路径收敛——`fileCopy` 要求对话框会话（`:441-455`）、`workflowImport` 要求对话框会话（`:1236-1242`）、图片输出 `relativeOutput` 过 `resolveInsideRoot`（`:548`）；唯独这两处把渲染层传入的 `videoPath` **原样**交给 ffmpeg 抽帧，抽出的帧随后发给 LLM API。
- **影响：** 正常使用路径（`dialogSelectVideo` 用户显式选文件）无越权；但渲染进程一旦失陷（恶意项目 JSON、被注入网页内容等任何前端代码执行），即可让主进程读取磁盘**任意**视频文件并外发帧数据——数据外发通道。属「主进程信任渲染层绝对路径」的边界不一致，且新 IPC 极易复制此错误模式。
- **整改：** ① `videoPath` 必须来自 `dialogSelectVideo` 的会话注册（与 `dialogSavedFiles` 同机制）；② 或限制在 `DATA_ROOT` 内；③ `ffmpegExtractFrames` 的 `videoPath` 同样 resolve；④ `llmWriteScriptFromVideo` 的 `%TEMP%\drama-studio-frames\vid_*` 目录用 `finally` 清理。

#### S-02【P2】`ttsClone` 的 `refAudioPath` 任意绝对路径
- **位置：** `src/main/index.ts:522-531` → `ttsService.generateClone(text, refAudioPath, …)`（refAudioPath 原样传入，未校验）
- **影响：** 任意本地音频文件被读取并上传至 ComfyUI 音色克隆工作流。目标服务为本地，影响面小于 S-01，但同样违反信任边界。
- **整改：** 与 S-01 相同：对话框会话校验或 `resolveInsideRoot`。

#### S-03【P2】`settingsSave` 无 schema 校验 → 可写任意 `comfyui.startCommand`（命令执行面）
- **位置：** `src/main/index.ts:1250-1256`（`settingsSave` 全量透传）；`comfyuiClient.start()`（解析 `startCommand` 后经 PowerShell 启动任意进程）；`settingsStore.ts:94`（`atomicWriteJson` 明文落盘，含 `llm.apiKey`，默认值见 `:48`）
- **影响：** ① 渲染层可写任意字段，其中 `comfyui.startCommand` 是任意命令行字符串——渲染层失陷 = 主进程任意命令执行（RCE 升级面）；② LLM API Key 明文存于 `settings.json`（Windows 上建议用 Electron `safeStorage` 加密）。正常使用路径无越权，属纵深防御缺口。
- **整改：** ① 主进程侧对 `settingsSave` 做白名单 schema 校验（字段/类型/枚举/范围），未知字段拒绝；② `startCommand` 白名单化（仅允许指定目录下 `python.exe` + 参数白名单），或改为只允许「启动/停止」布尔开关 + 预设配置；③ `apiKey` 迁 `safeStorage`，旧明文字段做迁移。

#### S-04【P2】对话 Agent `fetch_url` 无 SSRF 防护
- **位置：** `src/main/core/conversationService.ts:1378`（`tFetchUrl`）；工具定义 `skillService.ts:682-685`；系统提示词授权自主调用 `conversationService.ts:1496`
- **影响：** Agent 可被对话内容或所读网页内容诱导 fetch **回环/内网地址**（`127.0.0.1:8188`、`192.168.x`、路由器管理页、其他本地服务），返回体（含 JSON/文本）进入 LLM 上下文并可被转述——形成不受用户控制的内网探测与本地服务数据外泄通道。此为本地工具 + 官方 LLM 的组合，但 SSRF 属于设计性缺口。
- **整改：** `tFetchUrl` 内建防护：解析 host，禁止回环/私有/链路本地网段（或解析后解析回 IP 复核），仅允许公网 https；对非预期协议拒绝。

#### S-05【P2】每周「自主学习」在启动时自动执行完整工具循环（成本 + 注入持久化）
- **位置：** `src/main/core/conversationService.ts:1462-1479`（`ensureDailyAutoLearn`，每周、应用启动即触发、`void this.send('global', SELF_LEARN_PROMPT)` 不等待不确认）；`buildSystemPrompt`（`:1485+`）把用户/LLM 写入的 memory 注入系统提示词
- **影响：** ① 每次自动学习走 3–5 轮工具循环 ≈ 15–30 万 tokens 纯自动开销（代码注释自述），且自动执行 `web_search`/`fetch_url`/`create_skill`/`save_memory`；② LLM 可把指令写进 memory/skill，后续被注入系统提示词——形成**自我强化的提示注入持久化通道**（注入内容获得「必须遵守」级权威）。
- **整改：** ① 增加「启用自动学习」设置项，默认关闭，或改为仅用户手动触发（聊天区已有按钮）；② 对注入系统提示词的 memory/skill 内容标注来源与「仅供参考」语义，不赋予规则级权威；③ 自动学习增加预算上限与失败静默策略。

#### S-06【P3】对话工具 `render_quick` / `set_project_bgm` 接受任意绝对路径参数
- **位置：** `conversationService.ts:561`（`render_quick` 分支，`ref_image`/`end_image` 原样使用）；工具定义 `skillService.ts:104-105`
- **影响：** LLM（受提示注入影响时）可指定任意本地文件上传 ComfyUI / 复制进项目。目标为本地服务，影响有限。
- **整改：** 统一 `resolveInsideRoot` + 显式校验；`set_project_bgm` 限定来自对话框会话。

---

### B. 数据完整性与正确性

#### D-01【P1】`projectStore.duplicate()` 复制分镜时静默丢字段
- **位置：** `src/main/core/projectStore.ts:214-269+`（分镜仅拷贝 `scene/action/dialogue/characterIds/type/width/height/frames/seed/shotSize/camera/emotion/sceneBoardId` 子集）
- **证据：** 对比 `Shot` 契约（`shared/ipcTypes.ts:128+`），**丢失**：`promptEn`、`negativeEn`、`firstFrameEn`/`midFrameEn`/`lastFrameEn`、`transition`/`transitionEn`、`lighting`、`facing`、`continuity`、`frameSeconds`、`handoffToNext`、`props`、`reviewed`、`renderProfile` 等。
- **影响：** 副本虽标记 draft，但用户打开分镜页看到的是「有分镜、提示词全空、时长错乱（保留 `frames` 却丢 `frameSeconds`）」——静默数据损失，恢复需重新跑剧本分析（额外一次完整 LLM 拆镜成本）。`duplicate` 是列表页显式功能，用户可直接踩中。
- **整改：** 二选一：① 全字段复制（除 `id`/`index`/产物路径/`status` 重置为 draft），保留提示词工程成果；② 若意图是「重新创作」，则显式清空全部生成字段并在 UI 提示「副本需重新拆镜分析」，不得保留半套字段。

#### D-02【P3】`llmService` 调试 dump 目录双重嵌套
- **位置：** `src/main/core/llmService.ts:225、831`：`path.join(APPDATA, 'drama-studio', 'drama-studio', 'tmp')`
- **影响：** 错误响应/请求 JSON 落在 `%APPDATA%\drama-studio\drama-studio\tmp`，与数据根（`drama-studio`）不一致；两处 dump 逻辑重复且路径相同，排查故障时目录深一层、易漏。
- **整改：** 提取统一常量 `DUMP_DIR`，与 `DATA_ROOT` 对齐。

#### D-03【P2】`sanitizeCameraForFrame` 硬编码示例剧本角色名
- **位置：** `src/main/core/directorAgent.ts:2144-2146`：正则含 `Su Wan|Lin Chuan|李强|苏晚|林川`（示例剧本角色）
- **影响：** 首帧 prompt 净化只对示例角色生效；任何其他角色名的双人镜（如「王芳 across the counter from 陈默」）不会被净化，camera 残留「配角/剪影」描述 → 画面可能出现双人穿帮。属产品级硬编码（把一次性调试名单留进了核心管线）。
- **整改：** 由 `project.characters` 动态生成角色名名单注入净化器；或删除名单、仅保留通用从句规则（`another/other person/background figure/…`）。

#### D-04【P3】`imageService` 质量条款注入用「字符串包含」判断
- **位置：** `src/main/core/imageService.ts:68`：`prompt.toLowerCase().includes('cinematic vfx discipline')` 命中则整块质量条款跳过
- **影响：** 用户 prompt 恰含该短语（从模板/素材复制）时质量块被整体跳过；脆弱启发式。注入应返回「是否已注入」的结构化结果，而非扫字符串。

#### D-05【P3】`WorkflowLoader.updateParam` 读-改-写无串行化
- **位置：** `src/main/core/workflowLoader.ts`（`updateParam`：load → 改 → 单次 writeFile）
- **影响：** UI 滑块/参数面板连续快速保存（防抖后仍可能并发）时存在读改写竞态，最后一次写入覆盖前一次更新，极端情况写坏 JSON。建议 per-file 写队列或原子写 + 版本号校验。

---

### C. 可靠性与资源管理

#### R-01【P2】应用退出不中止在途任务、不清理临时文件
- **位置：** `src/main/index.ts:1520-1523`（`before-quit` 仅 `comfyMcpService.dispose()`）
- **影响：** 渲染中退出：taskQueue 在途 Comfy 任务不中断（ComfyUI 侧继续跑 GPU）、ffmpeg/TTS 子进程不 kill、`llmWriteScriptFromVideo` 的临时帧目录（`%TEMP%\drama-studio-frames\vid_*`，`:1315`）不清理。重启虽靠 `recoverStaleRenders` 兜底状态，但临时文件持续泄漏、退出时 GPU 白跑。
- **整改：** 退出钩子统一：abort taskQueue 等待态（reject pending）、kill 受管子进程、清理 temp；`llmWriteScriptFromVideo` 用 `finally` 删目录。

#### R-02【P3】`settingsPreviewAsset` 预览产物无清理策略
- **位置：** `src/main/index.ts:1257+`（写 `DATA_ROOT/preview`）
- **影响：** 每次设置预览生成图片，长期累积磁盘占用。
- **整改：** 固定文件名覆盖写，或定期清理超过 N 天的 preview 文件。

#### R-03【P2】主进程日志仅 console，无文件落盘
- **位置：** `src/main/core/logger.ts`（全部 console.*）
- **影响：** 崩溃/重启后日志全部丢失（`scripts/restart-app.ps1` 也未重定向），故障追溯只能靠 llmService 的 JSON dump；与「本地重负载工具」的排障需求不匹配。
- **整改：** 增加文件 sink（滚动大小 + 保留 N 份），或开发期环境变量开关落盘。

#### R-04【P3】`comfyuiClient.start` 无并发防抖
- **位置：** `src/main/core/comfyuiClient.ts` `start()`（无 starting promise 复用，`ensureClient` 已示范该模式）
- **影响：** IPC 层连点可重复 spawn 多个 ComfyUI 进程（UI 有 disable 但主进程无保护）。
- **整改：** 复用 `starting` promise 模式。

---

### D. 架构与工程质量

#### A-01【P2】核心类/文件超长、职责过载
- **位置：** `directorAgent.ts` ≈2600 行、`taskQueue.ts` ≈1656 行（`renderShot` 单函数 600+ 行嵌套闭包）、`llmService.ts` ≈1598 行（含 ≈8000 字 `analyze` 系统提示词）、`conversationService.ts` ≈1429 行；渲染层 `SettingsView.vue` 56KB、`WorkflowPanel.vue` 55KB、`StoryboardView.vue` 50KB
- **影响：** ① 单点修改风险高，审查/测试成本大；② `analyze` 巨型 prompt 每次拆镜固定消耗大量 token；③ 三套渲染入口（手动 IPC / 对话工具 / 导演 `queue.start`）门禁与重建语义不一致——基线 §3.4 已列为技术债，本报告确认。
- **整改（分期）：** 先抽纯函数层（prompt 构建、shot 校验、时间轴计算、渲染决策）为独立模块并补单测；再按职责拆类（audit / asset / pipeline 状态机）；渲染入口收敛到共享 `startRenderPipeline()`。

#### A-02【P1】全仓无自动化测试
- **证据：** 全仓无任何 `*.spec.ts` / `*.test.ts`；仅有一次性脚本（`scripts/run-*.mjs`、`verify-*.mjs`、`smoke-ui.mjs`、`verify-pipeline-guards.ts`）。
- **影响：** taskQueue 状态机、`projectStore.doSave` 快照合并、字幕时间轴（`subtitleService`）、prompt 构建、`errorClassify` 等核心逻辑无回归保护；基线 44 项修复后极易复发（如 `patchShot` 漏 `frameSeconds` 这类问题）。
- **整改：** 对纯逻辑层建立 vitest 单测，优先覆盖已修复问题与高风险函数：`projectStore.normalize/doSave/duplicate`、`subtitleService.generate`（含毫秒取整边界）、`workflowLoader`、`creationSettings.resolveCreation`、`errorClassify`、prompt 构建纯函数。

#### A-03【P3】一次性调试产物入库
- **位置：** `scripts/run-bridge-fight.log`（34KB）、`run-costume-fight.log`、`scripts/shot-check/*.jpg|*.png`（含 1.5MB 级对比图）、`resume-shot4.log` 等
- **影响：** 仓库膨胀、噪音；无保留价值。
- **整改：** `.gitignore` 追加 `scripts/*.log`、`scripts/shot-check/`；确有价值的示例另建目录。

---

## 三、整改优先级建议

按「先堵信任边界、再护数据、后补工程」排序：

| 阶段 | 条目 | 工作量 | 说明 |
|------|------|--------|------|
| **P0（立即，1 周内）** | S-01、S-03、S-04 | S–M | 任意路径读取/命令执行面/SSRF 三处安全边界先收敛；S-03 的 schema 校验可先做字段白名单 |
| **P1（1–2 周）** | D-01、A-02、R-01、S-02 | M | duplicate 丢字段先改（用户可直接踩中）；退出清理；测试从纯函数层起步 |
| **P2（持续）** | S-05、D-03、R-03、A-01、D-05、D-04 | M | 自动学习默认关 + 注入语义降权；硬编码角色名改动态；日志落盘；巨型类分期拆 |
| **P3（顺手）** | S-06、D-02、R-02、R-04、A-03 | XS–S | 零散一致性收口 |

**关键取舍说明：**
- S-01/S-03 的利用前提是渲染层失陷；本报告定为 P1/P2 而非 P0 高，是因为当前渲染层防护（CSP + `renderMd` 白名单转义 + contextIsolation）已封死已知注入路径——但**纵深防御不允许在边界上留不一致**，且 S-01 的模式极易在新 IPC 上复制。
- A-02 定为 P1：本仓已迭代出 44+20 项问题清单，无测试回归保护是后续一切整改的地基风险。

---

## 四、验证方法与遗留缺口

**验证方式：** 静态全量走读（主进程核心服务全文读取、渲染层抽样 + 模式扫描：v-html/eval/事件泄漏/路径校验）；关键结论均回链 `文件:行号` 证据；与两份基线文档逐条比对去重。
**未覆盖：** 渲染层大视图（SettingsView/WorkflowPanel/StoryboardView）未逐行精读（基线已覆盖其交互语义）；运行期行为（实际渲染、ComfyUI 交互）未做动态验证；`docs/specs/2026-10-16-timeline-transition-fix` 所涉时间轴过渡修复未核验实现与 spec 的一致性。
**遗留缺口（建议下次补）：** ① `conversationService` 上下文裁剪（`trimByBudget`）与 UI 消息列表的一致性（用户视角「导演忘了之前说的」）；② ComfyUI 工作流模板中 `$REF_IMAGE$`/seed 占位符与 `WorkflowLoader` 替换逻辑的逐模板核对；③ 运行期渲染/审计链路的动态抽检。

---

*报告结束。建议与 `efficiency-audit-2026-10-19.md` 合并成统一整改看板；安全条目优先，因为它们决定了后续所有改动的最小权限基线。*

---

## 五、整改落地状态（2026-10-20 实施记录）

> 本文档建议按「资深评估修正」后落地，修正点覆盖原报告建议：
> - **S-03 不做 startCommand 白名单化**（会打死用户自定义安装路径；`comfyuiClient.start` 用 `spawn(exe, argv数组)` 无 shell 拼接面）→ 改为 settingsSave 类型/形状校验（数值钳制 + 枚举白名单 + 字符串守卫，未知字段透传、不整包拒收，避免静默丢旧配置）。
> - **A-01 不重构** directorAgent/taskQueue 巨型类（无测试、回归风险最高）→ 仅补 A-02 测试层。
> - **D-01 抄创作字段、重置状态字段**（全量照抄会触发 doSave 的 done 保护，把无文件镜头复活成 done）；D-03 因 `Character` 结构无英文名，无法动态生成净化名单，不在实施范围。
> - **S-01 走对话框会话校验**（视频在数据根外，resolveInsideRoot 会拒绝一切外部视频）。
> - **R-01 退出不 interrupt ComfyUI**（用户自有常驻服务，退出后继续跑是特性）；只清临时帧目录 + 状态标记。

| 条目 | 状态 | 落地内容 |
|------|------|------|
| S-01 | ✅ 已落地 | `dialogSelectVideo` 注册会话（index.ts）；`ffmpegExtractFrames`、`llmWriteScriptFromVideo` 加 `hasDialogSession` 校验；`llmWriteScriptFromVideo` 补 finally 清理临时帧目录 |
| S-02 | ✅ 已落地 | `dialogSelectAudio` 注册会话；`ttsClone` 加 `hasDialogSession` 校验（当前渲染层无调用方，无破坏） |
| S-03 | ✅ 已落地（修正版） | settingsStore.normalize 全字段归一：数值钳制、枚举白名单（shotReviewGate/reviewGate/lipSyncMode/consistencyMode/resolutionTier）、字符串守卫；unknown 字段仍透传 |
| S-04 | ⏸ 未实施 | 仅记录：需在 fetch_url 入口做回环/私有网段字面量拦截（不追 DNS rebinding）；本轮未动对话工具链 |
| S-05 | ✅ 已落地 | `AppSettings.general.autoLearn`（默认 true）+ SettingsView 开关 + `ensureDailyAutoLearn` 门控（false 时跳过） |
| S-06 | ⏸ 未实施 | 未纳入本批范围（渲染层调用均为内部生成路径） |
| D-01 | ✅ 已落地 | projectStore.duplicate：创作/提示词字段全量复制（promptEn/negativeEn/首尾帧三件套/transition/transitionEn/lighting/facing/frameSeconds/handoffToNext/props/sceneEn/workflow/voice 等）；运行时/产物字段显式重置（status='pending'、路径清空、reviewed/renderProfile/consistency 清空） |
| D-02 | ✅ 已落地 | llmService 统一 `LLM_DUMP_DIR = APPDATA/drama-studio/tmp`，两处双重嵌套消除 |
| D-03 | ⏸ 未实施 | 阻塞：`Character` 结构无英文名，无法动态生成净化名单；需先扩数据结构（另立条目） |
| D-04 | ✅ 已落地 | imageService 改为整块 `CINEMATIC_QUALITY_BLOCK` 常量匹配，消除单句嗅探误判 |
| D-05 | ✅ 已落地 | workflowLoader 按工作流文件串行化「读-改-写」（per-file write queue），并发保存不丢更新/不写坏 JSON |
| R-01 | ✅ 部分落地 | 退出时清理 `%TEMP%/drama-studio-frames`（before-quit）+ llmWriteScriptFromVideo finally 清理；**不** interrupt ComfyUI（用户自有常驻服务） |
| R-02 | ✅ 已落地 | settingsPreviewAsset 生成成功后清理同类型旧预览图，只留最新一张 |
| R-03 | ⏸ 未实施 | 未纳入本批范围（console 日志 → 文件落盘为独立工程） |
| R-04 | ✅ 已落地 | comfyuiClient.start 并发去抖（starting promise，重复调用复用进行中的启动） |
| A-01 | ⏸ 明确不做 | 无测试前不拆巨型类；待 A-02 覆盖后抽纯函数（另立条目） |
| A-02 | ✅ 已落地 | vitest 基建：`npm test`，6 个 spec 28 用例（errorClassify/creationSettings/subtitleService/settingsStore/workflowLoader/projectStore.duplicate） |
| A-03 | ⏸ 未实施 | `.gitignore` 补 log/调试产物目录（低风险，随手可做） |

**测试回归期间额外修正（测试驱动发现）：**
1. `resolveCreation` 的 render→creation 镜像对旧配置实际不生效——`c = settings.creation || DEFAULT_CREATION` 使「缺省」与「默认值」无法区分，旧 render 值会被默认值静默覆盖。新增 `pickEdit`（显式值（≠默认）优先，否则镜像 render/tts）修正（creationSettings.ts）。
2. `isOomError` 正则漏 `torch.OutOfMemoryError` 类名（无空格），补 `outofmemory` 匹配（errorClassify.ts）。

**验证结果：** `npm run typecheck`（vue-tsc 全仓）0 错误；`npm test`（vitest）28/28 通过。

**遗留与说明：**
- 对话框会话 TTL=10 分钟：超过需重新选择文件（安全边界优先，重选成本 2 次点击）。
- settings.json 明文 apiKey 的 safeStorage 迁移未做（仅备注，涉及读取路径改造，另立条目）。
- 测试未覆盖：electron 强耦合模块（taskQueue/directorAgent/conversationService 等）的运行期行为；渲染层 UI 交互（建议 smoke-ui.mjs 手动回归）。