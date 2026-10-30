# 任务看板 · 2026-10-30

> 基线：分支 `feat/agent-autonomy`，最新提交 `d45a11a`
> 门禁现状：`typecheck` ✅ · `npm test` 1548/1548 ✅ · `npm run build` ✅ · `eslint` 82 warning（0 error）
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
| P0-B3 | S-06 外部绝对路径无根约束（`render_quick` 参考图、`set_project_bgm`、`imageService` 参考图） | ⏸ 待决策 | 产品口径 | 需确认「是否允许引用数据根之外的合法素材」 | M |

## P1

| 编号 | 任务 | 状态 | 依赖 | 阻塞点 | 工作量 |
| --- | --- | --- | --- | --- | --- |
| P1-A1 | S-03 剩余：`comfyuiClient.doStart` 的 `startCommand` 无白名单/危险字符校验 | 🔜 本批次 | — | 无（LLM 无法写入该字段，风险已降级） | S |
| P1-A2 | P1-5 `imageService` 参考图逐个上传前无 `resolveInsideRoot` 校验 | ⏸ 待决策 | P0-B3 | 与 S-06 同一产品口径 | S |
| P1-B1 | UX-P1-04 `QueueView` 自绘右键菜单无 Esc 关闭 | 🔜 本批次 | — | 无 | S |
| P1-B2 | UX-P1-05 软审核「告警放行」无二次确认（Storyboard/Queue/Console 直接入队） | 🔜 次批次 | — | 需统一确认文案与三处入口 | M |
| P1-C1 | R-01 `directorStateMachine.spec` 偶发 EBUSY（Windows 句柄未释放） | 🔜 本批次 | — | 无（`fs.rm` 加 `maxRetries/retryDelay` 即可） | S |
| P1-D1 | 测试缺口：74 个 core 模块中 23 个无对应 spec | 🔜 分批 | — | 优先级需按调用面与回归价值排序 | L |

无 spec 的 23 个模块：`builtinSkills`、`builtinToolSpecs`、`conversationService`、`conversationSession`、`conversationToolsDirector`、`directorConstants`、`directorFinish`、`directorManualOps`、`directorPipeline`、`directorProgressBridge`、`directorPrompts`、`directorStageAssets`、`directorStageAudit`、`directorStageCharacters`、`directorStageHealing`、`directorStageShots`、`lipSyncService`、`llmPromptsOps`、`llmPromptsScript`、`logger`、`selfCheckService`、`skillLibrary`、`skillService`。

## P2

| 编号 | 任务 | 状态 | 依赖 | 阻塞点 | 工作量 |
| --- | --- | --- | --- | --- | --- |
| P2-1 | Q-03 ESLint 82 条 warning（unused / no-explicit-any / empty catch） | 🔜 | — | 需逐条判断，禁止为消警告改行为 | M |
| P2-2 | D-01 README 模块数与目录结构过时 | 🔜 | — | 需与当前 74 个 core 模块对齐 | S |
| P2-3 | D-05 `scripts/archive` 存量脚本清理 | 🔜 | — | 需确认无 CI 引用 | S |
| P2-4 | E-01 跨平台打包（electron-builder 仅 Windows 配置） | 🔜 | — | 需 mac/linux 目标声明与验证环境 | M |
| P2-5 | E-02 依赖 `^` 版本范围锁定 | 🔜 | — | 与 `package-lock.json` 协同，需回归安装 | S |
| P2-6 | F-02 未引入 Pinia 状态管理 | 🔜 | — | 属架构演进，需评估收益后再动 | L |
| P2-7 | F-03 localStorage 输入记忆未加密 | 🔜 | — | 需确认存储内容是否含敏感信息 | S |
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
| 批次 1 | P1-A1、P1-B1、P1-C1 | 无外部决策，立即可执行 |
| 批次 2 | P0-B3 决策 → P1-A2 | 用户确认路径口径 |
| 批次 3 | P1-B2、P1-D1 第一批（`directorPipeline` / `directorStageShots` / `conversationSession` / `skillService`） | 批次 1 门禁全绿 |
| 批次 4 | P2-1 ~ P2-8 | P0/P1 清零 |

每批次收口标准：`npm run typecheck` + `npm test` + `npm run build` 全绿，`eslint` 无新增 error；提交按单一主题拆分。

## 进度记录

| 时间 | 事件 |
| --- | --- |
| 2026-10-30 22:32 | D-02 修复提交 `d45a11a`，四门验证通过（1548 用例全绿） |
| 2026-10-30 22:33 | 实测确认仓库根 `~` 目录已不存在，P0-B1 解除 |
| 2026-10-30 22:34 | 补齐 `llmHttp.spec.ts` / `llmScriptOpsOps.spec.ts` 对 `LLM_DUMP_DIR` 的 mock 导出 |
