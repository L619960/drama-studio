# 任务看板 · 2026-10-30

> 基线：分支 `feat/agent-autonomy`，最新提交 `31958e6`
> 门禁现状：`typecheck` ✅ · `npm test` 1597/1597（92 文件）✅ · `npm run build` ✅ · `eslint` 0 warning（0 error）
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
| P1-D1 | 测试缺口：74 个 core 模块中 23 个无对应 spec | 🔄 第一批已交付 `26aee24`（4/23） | — | 剩余 19 个按调用面分批 | L |

已覆盖（第一批）：`directorPipeline`、`directorStageShots`、`conversationSession`、`skillService`。

无 spec 的 19 个模块：`builtinSkills`、`builtinToolSpecs`、`conversationService`、`conversationToolsDirector`、`directorConstants`、`directorFinish`、`directorManualOps`、`directorProgressBridge`、`directorPrompts`、`directorStageAssets`、`directorStageAudit`、`directorStageCharacters`、`directorStageHealing`、`lipSyncService`、`llmPromptsOps`、`llmPromptsScript`、`logger`、`selfCheckService`、`skillLibrary`。

## P2

| 编号 | 任务 | 状态 | 依赖 | 阻塞点 | 工作量 |
| --- | --- | --- | --- | --- | --- |
| P2-1 | Q-03 ESLint 82 条 warning（unused / no-explicit-any / empty catch） | ✅ 已交付 `97ce4a0`（82 → 0） | — | — | M |
| P2-2 | D-01 README 模块数与目录结构过时 | ✅ 已交付 `d165c9e` | — | — | S |
| P2-3 | D-05 `scripts/archive` 存量脚本清理 | ✅ 已交付 `0f6f787`（15 脚本 + 空目录已删） | — | — | S |
| P2-4 | E-01 跨平台打包（electron-builder 仅 Windows 配置） | 🔜 | — | 需 mac/linux 目标声明与验证环境 | M |
| P2-5 | E-02 依赖 `^` 版本范围锁定 | ✅ 已交付 `31958e6`（38 项全部锁定） | — | — | S |
| P2-6 | F-02 未引入 Pinia 状态管理 | 🔜 | — | 属架构演进，需评估收益后再动 | L |
| P2-7 | F-03 localStorage 输入记忆未加密 | ✅ 已评估：仅存 URL/路径/模型名/项目 id/时间戳，无敏感信息，不加密 | — | — | S |
| P2-8 | D-03 缺失跨平台 CI | 🔜 | P2-4 | 依赖打包目标先确定 | M |

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
| 批次 4 | P2-1 ~ P2-8 | P0/P1 清零 |

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
