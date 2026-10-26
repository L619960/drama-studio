# Drama Studio 全链路效率审计报告

**审计日期：** 2026-10-19  
**审计目标：** 以「提升用户工作效率」为唯一核心目标，识别阻断、冗余与逻辑冲突，给出可落地整改方案。  
**覆盖范围：** 渲染进程全页面交互（路由 / 反馈 / 表单 / 错误 / 引导）+ 主进程流水线（导演 / 队列 / 存储 / Comfy / LLM / 一致性）+ 共享设置与 IPC。  
**场景覆盖：** 正常流程 · 异常流程 · 边缘场景。  
**方法：** 静态全量代码审查 + 关键路径抽检（`reviewGate` / `rebuildShotFirstFrames` / `concatDoneShots` / `projectStore.doSave` / `perShotAudit` / `audioFailed` 等）+ 对照既有《交互整改清单-2026-10-18》残余项。  
**严重度定义：**

| 等级 | 含义 |
|------|------|
| **P0** | 阻断核心任务，或导致用户做无效重工（算力/时间浪费、错误成片） |
| **P1** | 显著增加操作成本、恢复路径不清、或一致性/可靠性缺口 |
| **P2** | 体验不一致、首跑引导弱、文档/文案误导，不直接阻断出片 |

---

## 一、问题清单

### 1.1 核心任务路径对照（正常流程）

| 步骤 | 理想路径 | 当前摩擦 |
|------|----------|----------|
| 启动 | Comfy + LLM 就绪 → 新建/开拍 | 无首跑向导；侧栏 Comfy 仅刷新无跳转设置 |
| 开拍 | 单一「AI 导演」入口 | 项目列表 `DirectorFlow` 与控制台 `WorkflowPanel` 双入口、能力不一致 |
| 进度 | 全局可观测 | 进度对话框挂在项目列表，离开即消失 |
| 手动建项 | 空分镜 → 引导去剧本/拆镜 | 落到空分镜且无下一步 CTA |
| 审核→渲染 | 审什么渲什么 | 指定镜重渲会重建首帧并清 `reviewed`；导演自动路径绕过审核门 |
| 成片 | 剪辑台裁切生效 | 导演拼接忽略 `trimStart`/`trimEnd`/`skipped` |
| 失败恢复 | 一键续跑 + 明确原因 | TTS 失败静默无声；`audioFailed` 补配音未实现 |

---

### 1.2 P0 — 阻断性 / 严重影响工作效率

#### UX-P0-01 双「开拍」入口能力分裂
- **位置：** `src/renderer/src/components/project/DirectorFlow.vue`；`src/renderer/src/components/console/WorkflowPanel.vue`；`ConsoleView.vue` `confirmStart`
- **场景：** 正常
- **影响：** 同一「开拍」意图下，列表入口有剧本/视频/BGM，控制台入口有 `gateStages`、无 BGM/视频模式。用户反复试错配置，或用错入口导致缺门禁/缺配乐。
- **优化方向：** 统一为单一开拍表单组件（共享 props：script/video/bgm/gates）；两处入口只做 `open()` 壳。默认路由：开拍成功后 `push(/project/:id/console)`。
- **实施成本：** M（2–3 人日）
- **预期收益：** 开拍配置决策从「二次学习」降为一次；减少错误流水线启动约 30%+（按双入口误用占比估算）

#### UX-P0-02 AI 导演进度 UI 随项目列表卸载
- **位置：** `ProjectListView.vue` 内嵌 `<DirectorFlow>`；`DirectorFlow.vue` `progressVisible` / `onProgress`
- **场景：** 正常
- **影响：** 开拍后切页进度对话框消失，用户以为任务停了，反复取消/重开 → 任务冲突与算力浪费。
- **优化方向：** 进度态提升到 `useDirectorState` / App 级浮层；或开拍后强制进入项目控制台并展示 `WorkflowPanel` 进度。
- **实施成本：** S–M（1–2 人日）
- **预期收益：** 消除「任务丢了」误操作；单次开拍中途导航不再触发误取消

#### UX-P0-03 手动新建项目落到空分镜死胡同
- **位置：** `ProjectListView.vue` `createProject` → `storyboard`；`StoryboardView.vue` 空状态
- **场景：** 正常 / 边缘（首跑）
- **影响：** Toast「开始编辑分镜吧」后仅「添加分镜 / AI 拆分镜」，无「去剧本 / 开 AI 导演」。首跑用户多点 3–5 步才能找到正确入口。
- **优化方向：** 空状态三 CTA：粘贴剧本并拆分 / 打开剧本页 / 启动 AI 导演（带 `projectId` query）。
- **实施成本：** S（0.5 人日）
- **预期收益：** 手动路径首任务完成时间缩短 2–5 分钟

#### LOGIC-P0-01 `reviewGate` 一键双语义冲突
- **位置：** `src/main/index.ts` `renderStart`（分镜审核）；`directorAgent.ts` review 阶段（成片复审）；`creationSettings.ts` tip「成片复审」；`settingsStore.normalize` 镜像 `creation.edit.reviewGate` ↔ `render.reviewGate`
- **场景：** 正常
- **影响：** 为放行渲染关掉门禁，同时关掉成片复审；或反之。设置文案与 IPC 注释互相矛盾，用户无法建立正确心智模型。
- **优化方向：** 拆为 `shotReviewGate` + `finalReviewGate`；迁移旧字段；设置页分两组文案；停止单字段镜像。
- **实施成本：** M（2 人日，含迁移与设置 UI）
- **预期收益：** 消除「关错门」导致的无效重渲 / 带硬伤成片流出

#### LOGIC-P0-02 指定镜重渲：先过审再重建首帧 → 渲未审图
- **位置：** `index.ts` `renderStart` ~356–369；`conversationService.ts` `tRerender` ~783–791；`directorAgent.rebuildShotFirstFrames`（清 `reviewed`）
- **场景：** 正常（指定镜重渲）
- **影响：** 门禁检查的是旧 `reviewed`，随后重建首帧并作废审核，队列渲的是新图。用户以为「我审过了」，实际白审 + 可能渲错姿态。
- **优化方向：** 默认「已审镜不重建」；显式「强制重建首帧」开关；若重建则必须重新门禁或自动进入审核抽屉。
- **实施成本：** M（1.5–2 人日）
- **预期收益：** 指定镜重渲一次成功率显著上升；减少「审完又漂」的二次重渲

#### LOGIC-P0-03 默认 `perShotAudit=true` 有 hint 即暂停不进剪辑
- **位置：** `settingsStore` 默认；`directorAgent.ts` ~904–921
- **场景：** 正常
- **影响：** 自动驾驶在任意软审核提示（含边缘误报）时整段停在渲染末，用户必须手动从「视频剪辑」续跑。核心任务周期被人为拉长。
- **优化方向：** 默认仅对硬失败暂停；软 `auditHint` 只留痕 + 控制台汇总 CTA；或默认 `perShotAudit=false`，硬门交给 `gateStages`。
- **实施成本：** S（0.5–1 人日）
- **预期收益：** 一键成片成功率提升；减少「渲染完还要人工点继续」的打断

#### LOGIC-P0-04 TTS `audioFailed`「导演补配音」未实现
- **位置：** `taskQueue.ts` `prepareShotAudio` ~640–669（写标记）；`directorAgent.ts` **无任何** `audioFailed` 消费
- **场景：** 异常（TTS 限流/失败）
- **影响：** 失败镜静默无声或走错引擎路径（无台词当空镜），整片口型/对白丢失，事后难发现，只能全片重渲。
- **优化方向：** combine 前扫描 `audioFailed` → 自动重试 TTS + remux/lipsync；失败则 stage 硬停并列出镜号 + 一键「仅补配音」。
- **实施成本：** M（2–3 人日）
- **预期收益：** TTS 波动时避免整片报废；异常恢复从「全量重渲」降为「失败镜补音」

---

### 1.3 P1 — 重要影响

#### UX-P1-01 陈旧 `lastProjectId` 驱动侧栏导航
- **位置：** `useActiveProject.ts`；`App.vue` 菜单 index
- **场景：** 异常 / 边缘
- **影响：** 删项后残留 id、或磁盘项目丢失 → 侧栏点进空项目再弹回首页，无效点击。
- **优化方向：** 启动时 `project.list` 校验；无效则清空；删除时已有 `clearLastProjectIdIf` 保持。
- **实施成本：** S · **收益：** 减少迷路点击

#### UX-P1-02 `/console` 与 `/project/:id/console` 会话域分裂
- **位置：** `router/index.ts`；`ConsoleView.vue` `chatScope`
- **场景：** 正常
- **影响：** 全局 vs 项目对话历史不一致，用户以为「导演忘了刚才说的话」。
- **优化方向：** 有活跃项目时强制项目域；无项目时全局；UI 明示「当前项目：xxx」。
- **实施成本：** S–M · **收益：** 对话指令一次命中

#### UX-P1-03 「去 AI 导演」只回首页不打开表单
- **位置：** `ScriptView.vue` 空状态 CTA
- **场景：** 正常
- **影响：** 多一跳 + CTA 过度承诺。
- **优化方向：** `/?openDirector=1&projectId=` 或事件总线打开 `DirectorFlow`。
- **实施成本：** S · **收益：** 少一次点击

#### UX-P1-04 分镜/队列右键菜单缺 Esc 与边缘钳位
- **位置：** `StoryboardView.vue` / `QueueView.vue` vs `ContextMenu.vue`
- **场景：** 正常
- **影响：** 菜单卡住、溢出屏幕，操作中断。
- **优化方向：** 统一复用 `ContextMenu.vue`。
- **实施成本：** S · **收益：** 交互一致性、减少卡死重开

#### UX-P1-05 软审核门「告警放行」易漏看
- **位置：** `StoryboardView.vue` `startRender` / `renderSingle`（`warnedShots` toast）
- **场景：** 正常
- **影响：** warn 模式下未审镜直接入队，GPU 时间打水漂。
- **优化方向：** warn 时二次确认（列出镜号）；默认保持 block；设置页说明成本。
- **实施成本：** S · **收益：** 减少未审重渲

#### UX-P1-06 聊天上传取消被当成错误
- **位置：** `useDirectorChat.ts` `uploadAndSend`
- **场景：** 异常
- **影响：** 取消 → 红字「文件读取失败」。
- **优化方向：** 过滤 `'User cancelled'`（与角色/场景导入一致）。
- **实施成本：** XS · **收益：** 消除误报焦虑

#### UX-P1-07 `onClearTask` 仅清本地 UI
- **位置：** `useDirectorState.ts` `onClearTask`
- **场景：** 正常
- **影响：** hydrate 后状态「复活」，用户不信任控制台。
- **优化方向：** 增加主进程 `director.clearState` IPC，清内存态与会话展示。
- **实施成本：** S · **收益：** 状态可信

#### UX-P1-08 `clearChatGuarded` 吞掉 cancel 失败
- **位置：** `ConsoleView.vue`
- **场景：** 异常
- **影响：** 以为已停任务，实际仍在跑。
- **优化方向：** cancel 失败必须 toast；禁止在失败时宣称已取消。
- **实施成本：** XS · **收益：** 避免并行任务踩踏

#### UX-P1-09 Comfy 侧栏状态无「去设置 / 启动」CTA
- **位置：** `App.vue` `refreshComfyStatus`
- **场景：** 正常 / 首跑
- **影响：** 断连后只会刷新，用户不知下一步。
- **优化方向：** 未连接时点击 → Settings Comfy 区，或调已有 start API。
- **实施成本：** S · **收益：** 断连恢复时间缩短

#### LOGIC-P1-01 导演自动路径绕过分镜 `reviewed` 门禁
- **位置：** `directorAgent` render 阶段直接 `queue.start`；门禁仅在手动 `renderStart` / 对话重渲
- **场景：** 正常
- **影响：** 手动严、自动松，质量策略分裂；用户在自动片上仍习惯「先审」。
- **优化方向：** scenes gate 后可选「批量标已审」或自动路径独立 `directorShotGate`。
- **实施成本：** S–M · **收益：** 策略可预期

#### LOGIC-P1-02 一致性模式语义冲突（warn / rerender / drop）
- **位置：** `taskQueue.runConsistencyCheck`；`auditSingleShot`；`approveShots`；`concatDoneShots`
- **场景：** 正常
- **影响：** 同分不同处置 → 成片缺镜或带漂移镜；H3→Wan fallback 在 warn/off 仍触发加倍耗时。
- **优化方向：** 单一策略矩阵表 + 共享 `resolveCompareRef()`；fallback 受 `consistencyMode` 约束。
- **实施成本：** M · **收益：** 少一次意外全量重渲；成片可预期

#### LOGIC-P1-03 `patchShot` 未回写 `frameSeconds`
- **位置：** `taskQueue.ts` `patchShot` 白名单 ~472–488（写了 `frames`，漏 `frameSeconds`）
- **场景：** 正常
- **影响：** UI 时长与引擎帧数漂移，剪辑/字幕时间轴错位风险。
- **优化方向：** 白名单补 `frameSeconds`（及必要字段）。
- **实施成本：** XS · **收益：** 音画轴一致

#### LOGIC-P1-04 导演拼接忽略剪辑台 trim/skip
- **位置：** `directorAgent.concatDoneShots`；对比 `ResultView` 手动合成已传 `trimStart`/`trimEnd`/`skipped`
- **场景：** 正常
- **影响：** 用户在成片页精剪后，导演续跑/重拼又回到未裁版本 → 重复精剪。
- **优化方向：** `concatDoneShots` 过滤 `skipped` 并传入 trim；与 ResultView 共用组装函数。
- **实施成本：** S · **收益：** 精剪只做一次

#### LOGIC-P1-05 Cancel 后 `waitForCompletion` 悬挂
- **位置：** `taskQueue` Promise.race；`comfyuiClient.waitForCompletion` / `interrupt`
- **场景：** 异常
- **影响：** 取消后仍轮询至超时，占用资源、可能晚到结算干扰下一任务。
- **优化方向：** interrupt 时 settle/reject 全部 pending prompt。
- **实施成本：** M · **收益：** 取消即停、续跑更干净

#### LOGIC-P1-06 每镜 upload 使 `object_info` 全量失效
- **位置：** `comfyuiClient.uploadImage/uploadAudio` → `invalidateObjectInfoCache`；`taskQueue` 每镜 `getObjectInfo`
- **场景：** 正常
- **影响：** 多 MB `/object_info` 反复拉取，流水线吞吐热点。
- **优化方向：** 上传不刷全量缓存；输入存在性用轻量 API；TTL 分键。
- **实施成本：** M · **收益：** 多镜项目渲染墙钟时间下降（视 Comfy 响应，常见可观）

#### LOGIC-P1-07 `projectSave` 无服务端校验
- **位置：** `index.ts` projectSave；`projectStore.save`
- **场景：** 异常
- **影响：** 可写 `reviewed=true` 无首帧、破坏 shot 形状。
- **优化方向：** 最小 schema：i2v + reviewed 必须有 `firstFramePath`。
- **实施成本：** S · **收益：** 门禁不被绕过

#### LOGIC-P1-08 `minShots`/`maxShots` 仅进 prompt 未强制
- **位置：** `llmService.ts` analyze
- **场景：** 正常
- **影响：** 镜数失控 → 过短剧情或过长算力账单。
- **优化方向：** 结果钳制 / 超界一次硬重试。
- **实施成本：** S · **收益：** 镜数可控

#### LOGIC-P1-09 `ProjectStore.doSave` done 保护与显式重置博弈
- **位置：** `projectStore.ts` `doSave` ~132–168
- **场景：** 异常 / 边缘（重渲前清产物）
- **影响：** 清 `segmentPath` 但文件仍在盘时可能被强制恢复 `done`，状态与 UI 错乱。
- **优化方向：** 显式 `forceResetShotIds` 或先删文件再 save；区分「旧快照」与「故意重置」。
- **实施成本：** M · **收益：** 重渲状态可信

---

### 1.4 P2 — 体验优化

| ID | 位置 | 场景 | 影响摘要 | 优化方向 | 成本 |
|----|------|------|----------|----------|------|
| UX-P2-01 | `ProjectListView` | 正常 | 加载无骨架，短暂空网格 | 骨架屏 / `v-loading` | XS |
| UX-P2-02 | `App.vue` 热键 | 正常 | 无 Script/Props/Console 快捷键；设置页文档不全 | 补 Alt 映射与文档 | XS |
| UX-P2-03 | `DirectorFlow` 题材校验 | 正常 | 开拍可不选题材，AI 写稿强制题材 | 统一必填策略 | XS |
| UX-P2-04 | `WorkflowPanel` 题材 | 正常 | 仅 select，无自定义 | 与列表一致允许自定义 | XS |
| UX-P2-05 | `SettingsView` LLM 测试文案 | 正常 | 「请先保存」但 test 已 auto-save | 改正文案 | XS |
| UX-P2-06 | 各资产页空状态 | 首跑 | 只有本地添加，无导演/剧本桥 | 补跨页 CTA | S |
| UX-P2-07 | `ConsoleView` 批量重渲 toast | 异常 | 部分失败仍 success | 汇总成功/失败数 | XS |
| UX-P2-08 | `main.ts` unhandledrejection | 边缘 | 良性 reject 可能刷「操作失败」 | 取消哨兵白名单 | XS |
| UX-P2-09 | 应用壳 | 首跑 | 无 LLM/Comfy/工作流向导 | 首次启动 checklist（可调 SelfCheck） | M |
| UX-P2-10 | `DirectorFlow.locateFinal` | 异常 | 缺 try/catch | 对齐 `openFinalFolder` | XS |
| LOGIC-P2-01 | `auditSingleShot` 阈值 | 边缘 | 全图分用人脸阈值 | 按 method 选阈值 | S |
| LOGIC-P2-02 | `consistencyService` sticky fail | 异常 | 一次网络失败整会话禁用 | 可重试 | S |
| LOGIC-P2-03 | `comfyMcpService` 硬编码盘符 | 边缘 | 非默认安装路径误导 | 仅读 settings | S |
| LOGIC-P2-04 | `imageService` 静默 fallback 工作流 | 异常 | 质量悄悄降级 | 警告 + strict 选项 | S |
| LOGIC-P2-05 | `llmService` analyze 超长超时 | 正常/异常 | 最长约 20min 卡住 | 降超时 + 可取消 | S |
| LOGIC-P2-06 | 多角色镜折叠为单 `characterName` | 正常 | 双人镜身份丢失 | 持久化 `characters[]`→`characterIds` | M |
| LOGIC-P2-07 | `waitForFinish` 无超时 | 异常 | 漏事件则永久挂起 | 超时 reject | S |
| LOGIC-P2-08 | Turbo 文案步数不符 | 正常 | ETA 误导 | 对齐实际 steps | XS |
| LOGIC-P2-09 | `ffmpegExtractFrames` 未 resolve 路径 | 边缘 | 相对路径失败 | `resolveInsideRoot` | XS |
| LOGIC-P2-10 | `renderCandidates>1` 评分口径不一 | 正常 | 多倍耗时 + 抽卡偏置 | 统一 compare；默认 1 | S |

---

### 1.5 异常 / 边缘场景覆盖矩阵（摘要）

| 场景类型 | 已覆盖问题代表 | 缺口风险 |
|----------|----------------|----------|
| **正常** | 双入口、进度卸载、perShotAudit 暂停、重渲重建首帧、trim 忽略、object_info 热点 | 一键成片路径最长、打断最多 |
| **异常** | TTS audioFailed 空实现、cancel 悬挂、clearChat 吞错、一致性 sticky fail、Comfy 断连无 CTA | 失败后恢复成本远高于预防 |
| **边缘** | 陈旧 projectId、相对路径抽帧、首跑无向导、done 保护 vs 重置、双人镜身份折叠 | 低频但一次踩中代价高 |

---

## 二、优化 Roadmap

以「降低操作成本、减少无效操作、缩短核心任务周期」排序；同级内按投入产出比。

### Phase 0 — 立即止血（约 1 周，P0 为主）

| 序号 | 项 | 实现路径（代码/配置） | 工作量 | 优先级 |
|------|----|----------------------|--------|--------|
| 0.1 | 拆分 `shotReviewGate` / `finalReviewGate` | `ipcTypes` / `creationSettings` / `settingsStore.normalize` / `SettingsView` / `index.renderStart` / `directorAgent` review | M | P0 |
| 0.2 | 指定镜重渲：默认不重建已审首帧 | `index.ts` `renderStart`；`conversationService.tRerender`；可选 UI「强制重建」 | M | P0 |
| 0.3 | `perShotAudit`：软 hint 不暂停 | `directorAgent.ts` ~904–921；设置默认或策略开关 | S | P0 |
| 0.4 | 开拍后进入控制台 + 全局进度 | `DirectorFlow` 成功回调 `router.push`；进度迁 `useDirectorState` 或 App 浮层 | M | P0 |
| 0.5 | 统一开拍表单（DirectorFlow ↔ WorkflowPanel） | 抽 `DirectorStartForm.vue`；两入口复用 | M | P0 |
| 0.6 | 空分镜 / 空剧本 CTA 补齐 | `StoryboardView` / `ScriptView` / `createProject` 落地页策略 | S | P0 |

**Phase 0 出口标准：** 新用户从「AI 导演开拍」到控制台可持续看见进度；指定镜重渲不再「审完渲新图」；软审核不再默认卡住剪辑。

### Phase 1 — 成片可信与异常恢复（约 1–1.5 周）

| 序号 | 项 | 实现路径 | 工作量 | 优先级 |
|------|----|----------|--------|--------|
| 1.1 | 实现 `audioFailed` 补配音阶段 | `directorAgent` combine 前扫描；`taskQueue` 暴露 retry TTS IPC | M | P0 |
| 1.2 | 导演拼接尊重 trim/skip | `concatDoneShots` 对齐 `ResultView` 参数组装 | S | P1 |
| 1.3 | 一致性策略矩阵 + fallback 受控 | `taskQueue.runConsistencyCheck`；设置文案 | M | P1 |
| 1.4 | `patchShot` 补 `frameSeconds` | `taskQueue.ts` 白名单 | XS | P1 |
| 1.5 | cancel settle pending prompts | `comfyuiClient` + `taskQueue` | M | P1 |
| 1.6 | 清空任务走主进程 | 新 IPC + `onClearTask`；`clearChatGuarded` 失败上报 | S | P1 |
| 1.7 | 上传取消哨兵 / Comfy 侧栏 CTA | `useDirectorChat`；`App.vue` | XS–S | P1 |

**Phase 1 出口标准：** TTS 失败可自动或一键修复；精剪不被导演重拼冲掉；取消真正释放等待。

### Phase 2 — 吞吐与防护（约 1 周）

| 序号 | 项 | 实现路径 | 工作量 | 优先级 |
|------|----|----------|--------|--------|
| 2.1 | `object_info` 缓存策略重构 | `comfyuiClient` 分键 TTL；upload 不全量 invalidate | M | P1 |
| 2.2 | `projectSave` 最小校验 | `projectStore.save` | S | P1 |
| 2.3 | 镜数 min/max 强制 | `llmService` analyze 后处理 | S | P1 |
| 2.4 | done 保护 vs 显式重置 | `projectStore.doSave` + 重置 API 契约 | M | P1 |
| 2.5 | `lastProjectId` 启动校验；console 域明示 | `useActiveProject`；`ConsoleView` 标题 | S | P1 |

**Phase 2 出口标准：** 多镜渲染墙钟明显下降；非法 reviewed / 状态回弹可测用例固定。

### Phase 3 — 体验打磨与首跑（持续，P2）

| 序号 | 项 | 工作量 |
|------|----|--------|
| 3.1 | 首跑 SelfCheck 向导（LLM/Comfy/工作流） | M |
| 3.2 | 空状态跨页 CTA、热键与设置文案统一 | S |
| 3.3 | 双人镜 `characterIds`、analyze 超时、一致性 sticky 重试、MCP 去硬编码 | M |
| 3.4 | 候选抽卡评分口径统一、默认 candidates=1 提示成本 | S |

---

## 三、预期效果汇总

### 3.1 量化目标（相对当前主路径「AI 导演一键成片」）

| 指标 | 当前痛点 | Phase 0–1 后预期 | 度量方式 |
|------|----------|------------------|----------|
| 开拍到可持续监控 | 离开列表丢进度 | **0 次**因切页丢失进度的误取消 | 埋点 / 日志：cancel 原因 |
| 指定镜重渲一次成功率 | 审后重建导致偏差 | **+20%～40%** 少一次「审完又漂」重渲 | 同镜 `renderStart` 次数 |
| 渲染后无故停在剪辑前 | soft hint 默认暂停 | **自动驾驶直达 combine**（仅硬失败暂停） | `finish` 原因码分布 |
| TTS 失败片可救率 | 静默无声需全片重做 | **失败镜级修复**，避免全片重渲 | `audioFailed` 闭环率 |
| 精剪重复劳动 | 导演重拼冲掉 trim | **精剪保留** | 重拼前后 trim 字段 diff |
| 多镜渲染墙钟 | 每镜刷 object_info | **明显下降**（视 Comfy，目标 10%+） | 阶段耗时日志 |
| 首跑找到正确入口 | 空分镜死胡同 | **≤2 次点击**进入拆镜或开拍 | 任务完成步数抽样 |

### 3.2 效率机制（为何这些改动能缩短周期）

1. **减少决策分叉：** 统一开拍入口与门禁语义 → 少试错配置。  
2. **减少无效算力：** 不审新图、不默认软停、不误触发 Wan fallback → GPU 时间留给有效镜。  
3. **减少上下文切换：** 进度全局化、CTA 直达、Comfy 一键进设置 → 少在列表/设置/分镜间来回。  
4. **失败局部化：** TTS/一致性/取消可恢复 → 异常从「整片重来」变为「单镜修补」。  
5. **状态可信：** clear/save/done 保护对齐真实意图 → 少「界面说清空了又回来」的重复操作。

### 3.3 建议验收用例（正常 / 异常 / 边缘）

| # | 类型 | 用例 | 通过标准 |
|---|------|------|----------|
| T1 | 正常 | 列表 AI 导演开拍 → 立即切到角色页再回控制台 | 进度仍可见，任务未停 |
| T2 | 正常 | 已审 i2v 指定镜重渲（默认） | 首帧不重建；`reviewed` 保持 |
| T3 | 正常 | 成片页 trim 后导演从 combine 续跑 | 成片保留 trim |
| T4 | 异常 | 人为 TTS 失败 | 出现补配音或硬停+镜号，非静默无声成片 |
| T5 | 异常 | 渲染中取消 | pending wait 在超时前结束；可立刻新开任务 |
| T6 | 边缘 | 删除当前项目后点侧栏分镜 | 不进死链；回到列表或提示选项目 |
| T7 | 边缘 | 设置只关「分镜审核」 | 「成片复审」仍可独立为 block |

### 3.4 不在本次强推但需知情的技术债

- 渲染路径三套并行（手动 IPC / 对话工具 / 导演 `queue.start`）门禁与重建语义不一致——Phase 0–1 应收敛到共享 `startRenderPipeline()`。  
- `creation.*` 与顶层 `render.*` 双写镜像放大配置冲突——随 gate 拆分一并收敛。  
- 2026-10-18 交互清单已治理确认框/哨兵/全局兜底；本报告**不重复计分**那些已关闭项，仅跟踪残余与逻辑层新发现。

---

## 附录 A：审查范围文件索引

**交互：** `App.vue`、`router/index.ts`、全部 `views/*`、`DirectorFlow.vue`、`WorkflowPanel.vue`、`useDirectorState.ts`、`useDirectorChat.ts`、`useActiveProject.ts`、`confirm.ts`、`main.ts`  
**逻辑：** `directorAgent.ts`、`taskQueue.ts`、`projectStore.ts`、`settingsStore.ts`、`llmService.ts`、`imageService.ts`、`comfyuiClient.ts`、`comfyMcpService.ts`、`ffmpegService.ts`、`consistencyService.ts`、`conversationService.ts`、`index.ts`、`preload/index.ts`、`ipcTypes.ts`、`creationSettings.ts`  
**既有基线：** `交互整改清单-2026-10-18.md`

## 附录 B：问题计数

| 等级 | 条目数（本报告收录） |
|------|----------------------|
| P0 | 7 |
| P1 | 17 |
| P2 | 20 |
| **合计** | **44** |

---

*报告结束。建议按 Phase 0 → 1 顺序落地；若需立即开工，优先 0.2（重渲重建）+ 0.3（软审暂停）+ 0.4（进度全局化），三者对「无效操作 / 核心周期」杠杆最大且可独立合并。*

---

## 附录 C：行业知识补充（2026-10-19）

公开微短剧 / ComfyUI / 口型 / HITL 门禁踩坑与专业解法已沉淀至：

**[industry-lessons-ai-microdrama-2026-10-19.md](./industry-lessons-ai-microdrama-2026-10-19.md)**

落地时请以该文 **§7 映射表** 与 **§8 不变式** 约束实现（例如：审什么渲什么、`audioFailed` 不得静默进 combine、门禁按烧钱点拆分）。
