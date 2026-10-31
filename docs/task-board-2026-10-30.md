# 任务看板 · 2026-10-30

> 基线：分支 `feat/agent-autonomy`，最新提交 `897a17f`
> 门禁现状：`typecheck` ✅ · `npm test` 1875/1875（124 文件）✅ · `npm run build` ✅ · `eslint` 0 warning（0 error）
> 本文以代码实测为准，已修正 `docs/remediation-plan-2026-10-27.md` / `docs/technical-audit-2026-10-30.md` 中过时结论。

## 优先级定义

| 级别 | 含义 | 处置原则 |
| --- | --- | --- |
| P0 | 阻断交付、数据/安全风险 | 本批次清零，不允许带入下批次 |
| P1 | 核心功能缺口、主要体验问题、稳定性 | 与 P0 同批推进，按依赖串行 |
| P2 | 工程质量、技术债、可维护性 | P0/P1 清零后按收益排序清理 |

工作量口径：S（单点改动 + 测试）· M（跨 2~3 文件 + 用例）· L（跨模块 + 回归面）。

## P0

| 编号 | 任务 | 状态 | 依赖 | 阻塞点 | 工作量 |
| --- | --- | --- | --- | --- | --- |
| P0-1 | 重启残留任务恢复（中断标记 + 从失败阶段继续） | ✅ 已交付 `34b2cf5` | — | — | — |
| P0-2 | 导演对话「继续」fallback 自动 resume | ✅ 已交付 `bb21f54` | P0-1 | — | — |
| P0-3 | `before-quit` 优雅退出全链路 | ✅ 已交付 `679f909` | — | — | — |
| P0-4 | 未捕获异常落盘 | ✅ 已交付 `679f909` | — | — | — |
| P0-B1 | 仓库根 `~` 家目录副本（约 515GB，含 `.ssh`/Cookies/NTUSER.DAT） | ✅ 已解除 | — | 实测 `e:\drama-studio\~` 已不存在 | — |
| P0-B2 | D-02 LLM 诊断落盘 `drama-studio/drama-studio` 双嵌套 | ✅ 已交付 `d45a11a` | — | — | — |
| P0-B3 | S-06 外部绝对路径无根约束（`render_quick` 参考图、`set_project_bgm`、`imageService` 参考图） | ✅ 已交付（白名单口径） | — | — | M |

## P1

| 编号 | 任务 | 状态 | 依赖 | 阻塞点 | 工作量 |
| --- | --- | --- | --- | --- | --- |
| P1-A1 | S-03 剩余：`comfyuiClient.doStart` 的 `startCommand` 无白名单/危险字符校验 | ✅ 已交付 `e7c69de` | — | — | S |
| P1-A2 | P1-5 `imageService` 参考图逐个上传前无 `resolveInsideRoot` 校验 | ✅ 已交付（扩展名白名单） | P0-B3 | — | S |
| P1-B1 | UX-P1-04 `QueueView` 自绘右键菜单无 Esc 关闭 | ✅ 已交付 `e7c69de` | — | — | S |
| P1-B2 | UX-P1-05 软审核「告警放行」无二次确认（Storyboard/Queue/Console 直接入队） | ✅ 已交付 `1ad1d80` | — | — | M |
| P1-C1 | R-01 `directorStateMachine.spec` 偶发 EBUSY（Windows 句柄未释放） | ✅ 已交付 `5704bd5` | — | — | S |
| P1-D1 | 测试缺口：74 个 core 模块中 23 个无对应 spec | ✅ 已交付 23/23（`26aee24` / `acabde7` / `1d7509e` / `8da793a` / `3653c75`） | — | — | L |

已覆盖（第一批 4）：`directorPipeline`、`directorStageShots`、`conversationSession`、`skillService`。
已覆盖（第二批 5）：`directorConstants`、`logger`、`directorPrompts`、`lipSyncService`、`skillLibrary`。
已覆盖（第三批 4）：`directorStageAssets`、`directorStageHealing`、`directorProgressBridge`、`directorFinish`。
已覆盖（第四批 5）：`builtinSkills`、`builtinToolSpecs`、`directorStageAudit`、`directorStageCharacters`、`directorManualOps`。
已覆盖（第五批 5）：`conversationService`、`conversationToolsDirector`、`llmPromptsOps`、`llmPromptsScript`、`selfCheckService`。

23 个缺口模块已全部补齐 spec（111 个测试文件 / 1788 用例）。

## P2

| 编号 | 任务 | 状态 | 依赖 | 阻塞点 | 工作量 |
| --- | --- | --- | --- | --- | --- |
| P2-1 | Q-03 ESLint 82 条 warning（unused / no-explicit-any / empty catch） | ✅ 已交付 `97ce4a0`（82 → 0） | — | — | M |
| P2-2 | D-01 README 模块数与目录结构过时 | ✅ 已交付 `d165c9e` | — | — | S |
| P2-3 | D-05 `scripts/archive` 存量脚本清理 | ✅ 已交付 `0f6f787`（15 脚本 + 空目录已删） | — | — | S |
| P2-4 | E-01 跨平台打包（electron-builder 仅 Windows 配置） | ✅ 已交付：`electron-builder.yml` 增加 mac(dmg/zip)/linux(AppImage/deb) 目标 + `build:mac`/`build:linux` 脚本；原生二进制需本平台 runner 打包，Windows 本机无法验证 mac/linux 产物 | — | — | M |
| P2-5 | E-02 依赖 `^` 版本范围锁定 | ✅ 已交付 `31958e6`（38 项全部锁定） | — | — | S |
| P2-6 | F-02 未引入 Pinia 状态管理 | ✅ 已评估：11 个 composables + `reactive` 已覆盖共享状态，引入 Pinia 收益低，不引入 | — | — | L |
| P2-7 | F-03 localStorage 输入记忆未加密 | ✅ 已评估：仅存 URL/路径/模型名/项目 id/时间戳，无敏感信息，不加密 | — | — | S |
| P2-8 | D-03 缺失跨平台 CI | ✅ 已交付 `.github/workflows/ci.yml`：三平台四门验证 + tag 触发的分平台打包（本机无法实跑，待 CI runner 验证） | P2-4 | — | M |

## 交互整改方案（REQ-01 ~ REQ-20，见 `docs/交互整改需求方案-2026-10-30.md`）

> 20 条需求：P0 × 5 / P1 × 9 / P2 × 6；按方案 Phase 1 → 2 → 3 推进，每批四门全绿后单一主题提交。

### Phase 1（P0，5 条）

| 编号 | 任务 | 状态 | 依赖 | 工作量 |
| --- | --- | --- | --- | --- |
| REQ-01 | 渲染队列可观测（`queue:list` 快照 + ETA + `director:listActiveStates` + `useTaskBoard` + 队列页 indeterminate） | ✅ 已交付：主进程队列快照/ETA/活跃任务通道 + `useTaskBoard` 聚合 + QueueView 不确定态与 ETA 展示，补 10 例单测 | — | M |
| REQ-02 | 门禁待处理结构化（`pendingGates` + 审看定位 CTA） | ✅ 已交付：`DirectorState.pendingGates`（完整镜号不截断）+ 暂停卡片带「去审看」CTA + 分镜页消费 `?review=id` 自动打开审核；补 3 例单测 | — | M |
| REQ-03 | 重启后中断任务「一键继续」入口 | ✅ 已交付：`director:listInterrupted` 扫描磁盘中断/残留任务 + 项目列表琥珀横幅逐项「从断点继续」，补 2 例单测 | — | M |
| REQ-04 | 门禁 warn 二次确认与「一口气跑到底」联动 | ✅ 已交付：warn 放行改「去审看/仍要渲染/取消」三选一 + 同批镜 30 分钟去重；控制台常驻「确认点已关闭」chip，点击恢复默认门禁（剩余阶段生效）；补 5 例单测 | REQ-02 | M |
| REQ-05 | 常驻导演运行条 / 全局任务面板 | ✅ 已交付：`director:finished` 终态事件 + App 底部 `DirectorRunBar`（任意页面阶段/进度/暂停/继续/停止、多任务 Popover、完成绿/失败红入口、暂停 tooltip 诚实化），补 2 例单测 | REQ-01、REQ-02 | L |

### Phase 2（P1，9 条）

| 编号 | 任务 | 状态 | 依赖 | 工作量 |
| --- | --- | --- | --- | --- |
| REQ-06 | 首跑引导向导（三步 + 一键启动 ComfyUI + 表单级校验 + 视频模式 tip） | ✅ 已交付：新增 `components/onboarding/FirstRunWizard.vue`（环境检查复用 `system.selfcheck`/`SelfCheckPanel`、ComfyUI 离线一键拉起 + 2s×30 轮询、示例片名/题材建项目后进控制台、可跳过）；设置页新增「环境检查 → 重新运行」入口；`DirectorStartForm` 改 el-form rules 红字定位 + 自动聚焦，视频模式补「视频不进成片」tip；补 5 例单测 | — | M |
| REQ-07 | 会话域收敛与控制台信息架构（面包屑 / activeModule 持久化 / 删死代码） | ✅ 已交付：控制台顶部会话域面包屑（项目对话显示片名、全局对话提示最近项目并可一键切换）、未发送草稿按作用域 localStorage 保留、中栏模块选择持久化（`consoleLayout` 白名单）；删除 `DirectorFlow` 进度弹窗死代码（RC-05）与 `WorkflowPanel` 死 emit（RC-13）；补 4 例单测 | — | M |
| REQ-08 | 项目列表自动刷新与检索（进度订阅 + 搜索排序 + 缩略图） | ✅ 已交付：项目列表订阅 `director.onProgress`/`onProjectUpdated`（徽章原地更新 + 终态节流拉表，卸载清理）；新增排序（最近打开/创建时间/完成状态，打开时间戳本地记录）、片名/剧模糊搜索、首镜首帧封面（缺失回退缩略图）、无匹配空态；补 10 例单测 | REQ-03 | M |
| REQ-09 | 审核字段录入闭环与审核效率（三字段 / 全部通过确认 / 快捷键） | ✅ 已交付：核实主进程 LLM 拆镜已写 `shotSize/camera/emotion`，仅补渲染层入口——`ShotEditDialog` 新增景别/机位/情绪三下拉（英文值注入提示词、中文标签展示，未设定走默认）；审核弹窗空值改「未设定」中性展示、`→/Enter` 快捷键（Esc 沿用弹窗）、「⚠ 待整改」点击直达编辑；「全部通过」改红色确认且门控 off 时隐藏；补 3 例单测 | REQ-02 | M |
| REQ-10 | 预览-修改-重渲闭环（重渲此镜 / 试听 / 批量结果如实） | ✅ 已交付：成片页剪辑台每镜新增「重渲此镜」（按当前分镜参数单独入队、完成后自动刷新）；分镜编辑弹窗音色试听改为「显式音色 > 角色音色」回退并就地内联播放（不弹全屏 loading、不打断编辑）；控制台批量重渲改为逐镜统计成功/失败、全失败报错且如实列出原因；RC-08「成片文件不存在」已有 try/catch 引导文案，核对通过无需改动 | REQ-09 | S |
| REQ-11 | 错误分层与可恢复性（errorKind / queue:skipCurrent / hydrate 错误态） | ✅ 已交付：`Shot.errorKind/retryCount/retryBudget` + `progress(failed)` 携带分层（`classifyError` 复用 OOM/瞬时判定，任务队列记录自动重试次数）；新增 `queue:skipCurrent`（取消在跑/排队任务并落盘 `skipped`，队列继续下镜），队列页右键「跳过此镜」与失败行引导/重试角标；控制台 hydrate 失败改独立错误卡片（重试加载 + 回项目列表，不再复用「没有任务」空态）；渲染层全局兜底白名单取消类 reject（`isCancelReject`）不再误弹「操作失败」；补 11 例单测 | REQ-01 | M |
| REQ-12 | 设置双写收敛与保存体验（RA-01/10/11/12/13/15/17/18 + MP-11） | ✅ 已交付：`creation.edit ↔ render/tts` 改为共享镜像函数双向同步（同值不写，防 watcher 回环），分镜默认尺寸/帧数只读 `render`；设置页新增脏态提示与 `onBeforeRouteLeave` 保存并离开拦截、「恢复默认」（保留 ComfyUI/LLM 连接配置）、读取失败明确提示「当前为默认值」；TTS 音色抽 `shared/ttsVoices` 三处下拉共用（补齐云杰）；分镜编辑弹窗新建尺寸改用设置默认值，t2v 无场景板/场景图保存前确认；ComfyUI「测试连接」先存后测；工作流参数保存 toast 3 秒合并；MP-11 记录级 revision 暂不引入（设置页每次进入重读已满足本期口径）；补 6 例单测 | — | L |
| REQ-13 | 资产一致性策略统一（RA-05/06/09/14） | ✅ 已交付：道具删除改「被引用即硬拦截」并列出引用镜号（卡片按钮/右键菜单同步 disabled，与角色、场景板口径一致）；角色卡面部/三视图 `<img>` 渲染前判 `urlCache`，缺失显示「未生成 / 文件已移动」占位（RA-06）；角色/道具/场景板三页新增关键字搜索框与无匹配空态（RA-09）；新增 `shared/assetNames`（`findDuplicateByName` / `findDuplicateSceneBoard`），三处保存前重名拒绝（场景板按 `normalizeSceneKey`，文案提示会绑定旧板）（RA-14）；补 3 例单测 | REQ-12 | M |
| REQ-17 | 空/加载/校验/边界态补齐（RA-16 / DC-OPEN-05） | ✅ 已交付：新增 `components/common/PageSkeleton.vue`（cards/editor 两种骨架）与 `ErrorStateCard.vue`（统一加载失败卡片）；角色/道具/场景板/剧本四视图 `loading` 骨架 → 失败卡片（重试 + 回项目列表）→ 空态/内容三态严格分离，`project.get` 异常不再与「项目已删除」混同；控制台 hydrate 失败改用同一 `ErrorStateCard`（删除旧 alert 与冗余样式）；资产三页空态补「去分镜页看看」跨页 CTA；四门全绿（1852 用例 / 118 文件） | REQ-11 | M |

### Phase 3（P2，6 条）

| 编号 | 任务 | 状态 | 依赖 | 工作量 |
| --- | --- | --- | --- | --- |
| REQ-14 | 右键菜单统一与快捷键体系（RC-07/RA-08/RA-19/RA-20/DC-OPEN-26） | ✅ 已交付：`QueueView` 与 `ShotTablePanel` 自绘菜单替换为全局 `ContextMenu`（Esc/失焦/边缘钳位继承，菜单项与原层级一致，ShotTablePanel 按 id 锚定行防后台重排错位）；设置页快捷键表补 `Delete`（分镜）、`Ctrl+S`（剧本）、`Ctrl+E`（成片）；分镜表新增 selection 列与批量条（加入渲染队列 / 标记已跳过 / 删除所选，渲染中锁定），批量删除一次确认并逐镜作废产物；导演对话固定 chip 改为「继续/暂停/重渲第X镜/看进度」，「重渲第X镜」弹窗输入镜号后按 `shared/quickCommands` 生成指令发送；补 2 例单测 | — | M |
| REQ-15 | 后台任务完成/失败通知（空白维度 3 + MP-12 + MP-07 + DC-OPEN-22） | ✅ 已交付：`director:finished` 追加 `totalShots/doneShots`，主进程 `Notification` 在窗口失焦时发系统通知（`shared/notify` 文案，取消不发，点击聚焦窗口）；新增 `comfyui:status-changed` 与 `comfyStatusWatcher` 健康轮询，运行条渲染中掉线显示红色「ComfyUI 已断开」；新增 `system:disk-space` / `system:cleanup-tmp`，启动与任务完成检查数据盘，<5GB 运行条出现警告与「清理临时产物」（复用 `taskQueue.cleanupTmpFiles`）；补 11 例单测 | REQ-05 | M |
| REQ-16 | 撤销/重做基础（空白维度 7） | ✅ 已交付：新增 `shared/undoWindow`（5 秒后悔窗，只结算一次）与 `utils/undoToast`（`ElMessage` + 撤销按钮）；分镜单个/批量删除改为软删除（撤销原位恢复且不丢引用，产物与整集成片延迟到窗口结束才作废）；角色/道具/场景板删除支持 5 秒撤销并回写项目；「取消全部渲染」撤销按快照重新入队；「清空任务」撤销恢复本地状态与日志；补 4 例单测 | — | M |
| REQ-18 | 日志面板信息架构（DC-OPEN-23） | ✅ 已交付：`DirectorLogEntry` 增加 `detail`/`errorKind`，主进程在自愈诊断、审核换种子重渲、失败镜头处写结构化明细；`LogPanel` warn 默认按阶段折叠并显示条数、单条日志点击展开 JSON/中文明细、errorKind 复用 `ERROR_KIND_TEXT` 着色；新增 `director:exportLogs` 将当前项目日志写入项目目录（`shared/logExport` 统一文本格式）；补 4 例单测 | REQ-11 | M |
| REQ-19 | 可用性走查（ACS-01 / ACS-02 / ACS-03） | ✅ 已交付：盘查确认基线已满足——`theme.css` 全局 `:focus-visible` 2px 品牌色描边（`StageTimeline` 另有自定义焦点环）、`.el-button.ds-danger-confirm` 深字浅红对比度约 6.5:1、`App.vue` 侧栏可折叠（220px/72px）且 `DirectorRunBar` 为 `work-shell` 独立 flex 行不重叠、860px 断点已收边距；补分镜表操作列「⋯」按钮（`MoreFilled`，`aria-label` + `title`，与行右键共用 `openRowMenu`，键盘触发按按钮矩形锚定菜单），触屏/无鼠标场景可打开全部行操作 | REQ-14 | S |

## 依赖关系

```
P0-B3（S-06 产品口径）
   ├─→ P1-A2（imageService 根校验）
   └─→ P1-D1 中相关 fixture 调整（假路径需改为数据根内临时文件）

P2-4（跨平台打包）─→ P2-8（跨平台 CI）
P1-C1（flake 修复）─→ P1-D1 大批量补测（避免新增用例继承同类 flake）
```

## 推进批次

| 批次 | 内容 | 准入条件 |
| --- | --- | --- |
| 批次 1 ✅ | P1-A1、P1-B1、P1-C1 | 无外部决策，立即可执行 |
| 批次 2 ✅ | P0-B3 决策 → P1-A2（白名单口径） | 用户确认路径口径 |
| 批次 3 ✅ | P1-B2、P1-D1 第一批（`directorPipeline` / `directorStageShots` / `conversationSession` / `skillService`） | 批次 1 门禁全绿 |
| 批次 4 ✅ | P2-1 ~ P2-8 | P0/P1 清零（`37b7940`） |

每批次收口标准：`npm run typecheck` + `npm test` + `npm run build` 全绿，`eslint` 无新增 error；提交按单一主题拆分。

## 进度记录

| 时间 | 事件 |
| --- | --- |
| 2026-10-30 22:32 | D-02 修复提交 `d45a11a`，四门验证通过（1548 用例全绿） |
| 2026-10-30 22:33 | 实测确认仓库根 `~` 目录已不存在，P0-B1 解除 |
| 2026-10-30 22:34 | 补齐 `llmHttp.spec.ts` / `llmScriptOpsOps.spec.ts` 对 `LLM_DUMP_DIR` 的 mock 导出 |
| 2026-10-30 22:36 | 批次 1 卡口：R-01 flake 修复 `5704bd5`；启动命令校验加固 + 队列菜单 Esc `e7c69de` |
| 2026-10-30 22:50 | 批次 2：素材路径白名单 `assetPathGuard` 接入 `taskQueue` / `imageService` / `set_project_bgm`，新增 10 条单测；全量 1558 用例全绿，build 通过 |
| 2026-10-30 23:05 | P1-B2 二次确认 `1ad1d80`：新增 `renderGate` 预判，接入 Storyboard/Queue/Console；抽 `renderTargetShots` 与主进程共用，1560 用例全绿 |
| 2026-10-30 23:11 | P1-D1 第一批 `26aee24`：4 个 core 模块补测 37 例，92 文件 / 1597 用例全绿，build 通过 |
| 2026-10-30 23:34 | P2-1 `97ce4a0`：ESLint 82 → 0 warning（tests 目录关闭 no-explicit-any，源码清理未用绑定/导入/无用赋值，行为不变）；四门全绿 |
| 2026-10-30 23:52 | P2-2 `d165c9e` README 对齐（75 core / 10 views / 92 测试文件）；P2-3 `0f6f787` 删除 `scripts/archive` 15 脚本；P2-5 `31958e6` 38 项依赖锁定精确版本（`npm ci --dry-run` 通过）；P2-7 评估为无敏感内容，不加密 |
| 2026-10-31 00:00 | P1-D1 第二批 `acabde7`：5 个 core 模块补测 38 例（97 文件 / 1635 用例全绿） |
| 2026-10-31 00:03 | P1-D1 第三批 `1d7509e`：4 个 core 模块补测 47 例（101 文件 / 1682 用例全绿） |
| 2026-10-31 00:10 | P1-D1 第四批 `8da793a`：5 个 core 模块补测 40 例（106 文件 / 1722 用例全绿，四门通过） |
| 2026-10-31 00:16 | P1-D1 第五批 `3653c75`：最后 5 个 core 模块补测 66 例，23/23 缺口清零（111 文件 / 1788 用例全绿，四门通过） |
| 2026-10-31 00:24 | 批次 4 收口 `37b7940`：P2-4 增加 mac(dmg/zip)/linux(AppImage/deb) 打包目标与 `build:mac`/`build:linux`；P2-8 新增三平台 CI（lint/typecheck/test/build + tag 分平台打包）；P2-6 评估不引入 Pinia。四门全绿（1788 用例），mac/linux 产物与 CI 实跑待对应 runner 验证 |
| 2026-10-31 00:56 | REQ-03 `fdba5dc`：新增 `director:listInterrupted`（扫描中断标记/残留 running，项目名回退 project.json）、项目列表琥珀横幅与逐项「从断点继续」，补 2 例单测。四门全绿（1803 用例） |
| 2026-10-31 01:10 | REQ-04 `f0b2d08`：warn 放行三选一确认与 30 分钟同批去重、`director:enableGates` 中途恢复默认门禁 + 控制台橙色 chip，补 5 例单测。四门全绿（1808 用例） |
| 2026-10-31 01:28 | REQ-05 `b7b31e3`：`director:finished` 终态事件 + 底部常驻 `DirectorRunBar`（任意页面控制/多任务面板/完成失败入口），补 2 例单测。四门全绿（1810 用例）；Phase 1（P0 5 条）全部交付 |
| 2026-10-31 02:20 | REQ-06：首跑三步向导 `FirstRunWizard`（环境检查/一键启动 ComfyUI 轮询/示例项目/跳过标记）+ 设置页「重新运行环境检查」入口 + 开拍单 el-form rules 定位聚焦与视频模式 tip，补 5 例单测。四门全绿（1815 用例） |
| 2026-10-31 02:40 | REQ-07：控制台会话域面包屑与全局→项目一键切换、按域草稿持久化、`activeModule` 持久化（`consoleLayout` 白名单 + 4 例单测）；删 `DirectorFlow` 进度弹窗死代码（RC-05）与 `WorkflowPanel` 死 emit（RC-13）。四门全绿（1819 用例 / 113 文件） |
| 2026-10-31 02:50 | REQ-08：项目列表订阅导演进度/落盘事件（徽章原地更新 + 终态节流拉表）、排序（最近打开/创建时间/完成状态）、片名/剧本模糊搜索、首镜首帧封面与无匹配空态（`projectList` + 10 例单测）。四门全绿（1829 用例 / 114 文件） |
| 2026-10-31 03:05 | REQ-09：核实 LLM 拆镜已写三字段，补编辑弹窗景别/机位/情绪录入（`shotMeta` 中英映射 + 3 例单测）、审核空值中性化、`→/Enter` 快捷键、「⚠ 待整改」点击直达编辑、「全部通过」红色确认与 gate=off 隐藏。四门全绿（1832 用例 / 115 文件） |
| 2026-10-31 07:25 | REQ-10：成片页剪辑台逐镜「重渲此镜」、分镜编辑音色试听回退角色音色并内联播放、控制台批量重渲成功/失败如实反馈；RC-08 核对为已满足。四门全绿（1832 用例 / 115 文件） |
| 2026-10-31 07:50 | REQ-11：失败分层 `errorKind/retryCount/retryBudget` + `queue:skipCurrent` 跳过卡死镜 + 控制台 hydrate 错误卡片 + 取消类 reject 白名单（`errorGuide` + 11 例单测）。四门全绿（1843 用例 / 116 文件） |
| 2026-10-31 08:30 | REQ-12：设置双写收敛（`mirrorEditToRender`/`mirrorRenderToEdit` 双向同值不写）+ 脏态离开拦截/恢复默认/读取失败提示 + 音色清单 `shared/ttsVoices` 三处共用 + 新建分镜尺寸读设置 + t2v 空镜保存确认 + ComfyUI 先存后测 + 参数保存 toast 合并（`ttsVoices`/`creationSettings` + 6 例单测）。四门全绿（1849 用例 / 117 文件） |
| 2026-10-31 08:35 | REQ-13：道具删除硬拦截并列出引用镜号、角色卡图片缺失占位、三页搜索过滤与无匹配空态、`shared/assetNames` 重名校验（角色/道具/场景板，场景板按 `normalizeSceneKey`）；补 3 例单测。四门全绿（1852 用例 / 118 文件） |
| 2026-10-31 09:40 | REQ-17：新增 `PageSkeleton`/`ErrorStateCard` 公共组件，角色/道具/场景板/剧本四视图补齐「骨架 → 错误卡片 → 空态/内容」三态，控制台 hydrate 失败复用同一错误卡片，资产空态补「去分镜页看看」CTA。四门全绿（1852 用例 / 118 文件）；Phase 2（P1 9 条）全部交付 |
| 2026-10-31 09:55 | REQ-14：`QueueView`/`ShotTablePanel` 右键菜单复用全局 `ContextMenu`（Esc/失焦/边缘钳位，分镜表按 id 锚定行）、设置快捷键表补 `Delete`/`Ctrl+S`/`Ctrl+E`、分镜表单选列 + 批量条（入队/标跳过/删除，渲染中锁定）、对话 chip 改「重渲第X镜」+ `shared/quickCommands`（2 例单测）。四门全绿（1854 用例 / 119 文件） |
| 2026-10-31 10:10 | REQ-15：`director:finished` 补镜头数，主进程失焦时发系统通知；`comfyui:status-changed` 健康轮询驱动运行条「ComfyUI 已断开」红色态；`system:disk-space`/`system:cleanup-tmp` + 运行条 <5GB 警告与清理入口（复用 `taskQueue.cleanupTmpFiles`）；补 11 例单测。四门全绿（1867 用例 / 122 文件） |
| 2026-10-31 10:40 | REQ-16：新增 `shared/undoWindow`（5 秒后悔窗纯状态机）与 `utils/undoToast`；分镜单个/批量删除软删除（撤销原位恢复、产物延迟作废）、角色/道具/场景板删除 5 秒撤销、「取消全部渲染」撤销重新入队、「清空任务」撤销恢复本地展示；补 4 例单测。四门全绿（1871 用例 / 123 文件） |
| 2026-10-31 11:05 | REQ-18：`DirectorLogEntry` 增加 `detail`/`errorKind`，自愈诊断/审核重渲/失败镜头写结构化明细；日志面板 warn 默认折叠 + 单条点击展开 + errorKind 着色；`director:exportLogs` 按项目导出到项目目录（`shared/logExport` + 4 例单测）。四门全绿（1875 用例 / 124 文件） |
| 2026-10-31 11:20 | REQ-19：可用性走查——确认全局 `:focus-visible` 描边、危险按钮对比度、侧栏折叠与运行条不重叠等基线已达标（无需改动）；分镜表操作列新增「⋯」按钮（与行右键共用 `openRowMenu`，触屏/键盘可达全部行操作）。四门全绿（1875 用例 / 124 文件，无新增用例） |
