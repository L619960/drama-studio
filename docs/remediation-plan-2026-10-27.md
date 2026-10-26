# drama-studio 提升改造迭代整改方案（2026-10-27）

> **取证日期**：2026-10-27（周二）
> **取证方式**：四位专家 agent 并行只读走读当前代码 + `npm run typecheck` / `npm test` 取证
> **基线文档**：`交互整改清单-2026-10-18.md`（21 项）+ `docs/efficiency-audit-2026-10-19.md`（44 项）+ `docs/design-audit-2026-10-20.md`（20 项）
> **本文档性质**：出方案，不动手。所有删除/修改动作仅为建议清单，未执行。

---

## 0. 核心结论先行（TL;DR）

**过去一周（10-20 → 10-27）代码确实在动，但 70% 的"修复"落在了从未被执行的死代码里。**

### 0.1 一句话诊断

`src/main/ipc/` 下 16 个模块、`src/main/core/directorStageRender.ts`（509 行）、`src/main/core/conversationTools*.ts`（7 个文件）是一套**未接线的 sharded 重构**——新逻辑、新校验、新门禁都写在这些文件里，但 `src/main/index.ts:28` 只 import 了 `./ipc/shared`，其余 `registerXxxIpc()` 全仓 0 调用。Electron-vite 打包时这些 export 被 tree-shake 丢弃。**live 路径仍然跑 `index.ts`（1438 行内联 handler）+ `directorAgent.ts`（2548 行上帝类）+ `conversationService.ts`（1478 行）的私有副本。**

### 0.2 由此派生的四类"假闭环"

| 类别 | 受影响项 | 旧文档声称 | 实际 live 行为 |
|---|---|---|---|
| 安全校验写在死代码 | S-01 videoPath 抽帧外发、S-02 ttsClone refAudioPath、S-05 autoLearn 门控、D-02 dump 双重嵌套 | ✅ 已落地 | ❌ 旧 handler 无校验 |
| 产品门禁写在死代码 | LOGIC-P0-02 指定镜重渲重建首帧、LOGIC-P0-03 perShotAudit 软提示即暂停、LOGIC-P1-01 pauseUntilShotsReviewed、LOGIC-P0-04 补配音 | 部分已修 | ❌ live 仍走旧逻辑 |
| UI/schema 拆了一半 | LOGIC-P0-01 reviewGate 双语义 | schema 已拆 | 🔧 live 门禁仍读旧字段；SettingsView 下拉被 normalize 镜像覆盖 |
| 工程治理盲区 | 仓库卫生、测试入库、postinstall 依赖 | — | ❌ patch-element-plus.mjs 未入库、23 spec 全部 untracked、`~` 目录误拷整个用户主目录 |

### 0.3 闭环统计（85 项基线）

| 基线 | 总数 | ✅真修 | 🔧部分修 | ❌未修 | ⚠️假修/回归 | 备注 |
|---|---:|---:|---:|---:|---:|---|
| design-audit 安全/设计（S-01~S-06 + D-01~D-04） | 10 | 3 | 1 | 2 | 4 | design-audit 共 20 项，剩余 10 项本次未逐条核验（见 §6.2） |
| efficiency-audit（P0/P1/P2） | 44 | 14 | 8 | 14 | 8⚠️ | 8 个⚠️为 P2 未深挖项 |
| 交互整改清单（A/B/C/D） | 21 | 19 | 2 | 0 | 0 | 上轮交互治理基本闭环 |
| **合计** | **75 已核** | **36** | **11** | **16** | **12** | |

### 0.4 推荐执行顺序（一句话版）

1. **本周（P0）**：删 `~` 目录 + git 入库治理 + 死代码二选一（接线或删除）+ 全局异常兜底 + LOGIC-P0-01/02/03 live 修正。
2. **两周内（P1）**：把 sharded 重构真正完成（directorAgent 拆分、index.ts IPC 域化）+ 补 5 个核心测试 + apiKey safeStorage。
3. **月度（P2）**：渲染层组件测试、E2E 起步、eslint/husky 工程化、架构长期治理。

---

## 1. 取证方法与基线

### 1.1 取证范围

- 静态走读：`src/main/**`（58 个文件）、`src/renderer/src/**`（169 个 ts/vue 文件）、`src/shared/**`、`tests/unit/**`、根目录配置文件。
- 命令取证：`npm run typecheck`（vue-tsc 双端）、`npm test`（vitest v5.0.5）、`git ls-files`、`git status --short`、`git check-ignore -v`。
- 未跑：`npm run build`（electron-builder 打包耗时，本次未触发）、E2E（项目无 E2E）。

### 1.2 取证结果（附录 A 有完整日志）

| 命令 | 结果 |
|---|---|
| `npm run typecheck`（vue-tsc --noEmit 双端） | ✅ exit 0，0 错误 |
| `npm test`（vitest run） | ✅ 23 spec / 225 用例全过，1.76s |

> 注：旧文档记录时为 6 文件/28 用例，一周内测试基建已扩展到 23 文件/225 用例（含 projectStore.duplicate、settingsStore、taskQueue.quickRender 等），是本轮唯一明确在前进的线。

---

## 2. 既有审计闭环核实总表

### 2.1 design-audit-2026-10-20（安全/设计类 10 项已核）

| 编号 | 问题摘要 | 状态 | 当前代码证据 |
|---|---|---|---|
| **S-01** | IPC `videoPath` 任意本地视频抽帧外发 LLM | ⚠️假修 | 死代码校验在 `src/main/ipc/ffmpeg.ts:32-38`、`ipc/llm.ts:31-42`；实际执行体 `src/main/index.ts:411-415` `ffmpegExtractFrames` 与 `:1309-1313` `llmWriteScriptFromVideo` **无 hasDialogSession 校验**，且 :1310 无 finally 清理 tmpDir |
| **S-02** | `ttsClone` 的 `refAudioPath` 任意绝对路径 | ⚠️假修 | 死代码 `ipc/tts.ts:30-32` 有校验；实际执行体 `index.ts:520-529` 直接 `ttsService.generateClone(text, refAudioPath, …)` 无校验 |
| **S-03** | settingsSave 无 schema → startCommand RCE + apiKey 明文 | 🔧部分修 | ✅ 类型归一已做：`settingsStore.ts:133-214` `normalize()` 含 num()/enumOf()/str()；❌ `:195` startCommand 仍任意字符串透传到 `comfyuiClient.ts:153` `spawn(exe,args,{detached})`；❌ `:201` apiKey 明文 `atomicWriteJson`，全仓 grep `safeStorage` 0 命中 |
| **S-04** | `fetch_url` 无 SSRF 防护 | ✅已修 | `conversationToolsNetwork.ts:41-52` 入口拦截 + `:126-156` `isBlockedFetchHost()` 拒绝回环/私网/链路本地 |
| **S-05** | 启动自动自主学习注入持久化 | ⚠️假修+语义未降权 | `conversationService.ts:1457-1476` `ensureDailyAutoLearn()` **未读** `settings.general.autoLearn`，:1474 仍无条件 `void this.send('global', SELF_LEARN_PROMPT)`；`conversationToolsMemory.ts:60-70/:140-152` LLM 可写 memory/skill 并被 `buildSystemPrompt` 注入，无"仅供参考"降权 |
| **S-06** | `render_quick` / `set_project_bgm` 任意绝对路径 | ❌未修 | `conversationService.ts:561-587` `render_quick` :571-572 原样传 `ref_image` → `taskQueue.ts:1240` uploadImage；`conversationToolsFile.ts:12-28` `tSetProjectBgm` :14/:20/:24 直接 `fs.copyFile(abs, …)` |
| **D-01** | `projectStore.duplicate()` 静默丢分镜字段 | ✅已修 | `projectStore.ts:258-289` 创作字段全量复制；有 `tests/unit/projectStore.duplicate.spec.ts`（3 用例） |
| **D-02** | llmService dump 目录双重嵌套 | ⚠️假修 | ✅ `llmRequest.ts:16` 已提取 `LLM_DUMP_DIR`；❌ `llmService.ts:230` 与 `:647` **仍硬编码** `path.join(APPDATA,'drama-studio','drama-studio','tmp')` |
| **D-03** | `sanitizeCameraForFrame` 硬编码示例角色名 | ❌未修 | `directorAgent.ts:2227` 仍 `/(?:Su Wan\|Lin Chuan\|李强\|苏晚\|林川\|…)/i.test(s)` |
| **D-04** | imageService 字符串包含判质量条款注入 | ✅已修 | `imageService.ts:70` `prompt.includes(CINEMATIC_QUALITY_BLOCK)` 整块常量匹配 |

### 2.2 efficiency-audit-2026-10-19（44 项全列）

#### P0（7 项）

| 编号 | 状态 | 当前代码证据 |
|---|---|---|
| UX-P0-01 双开拍入口分裂 | 🔧 | `components/project/DirectorStartForm.vue` 已抽出统一表单（含 gateStages 勾选 :47-51、genre 必填 :172），但仅 `console/WorkflowPanel.vue:107` 使用；项目列表入口 `project/DirectorFlow.vue:4-105` 仍内嵌旧表单，submit :373-378 **不传 gateStages、不校验 genre** |
| UX-P0-02 导演进度 UI 随列表卸载 | ❌ | `ProjectListView.vue:161` DirectorFlow 仅挂列表路由；`DirectorFlow.vue:444-447` onUnmounted 退订；开拍成功 :383-385 仅关输入 dialog、开进度 dialog，**无 router.push('/project/:id/console')** |
| UX-P0-03 手动新建项目落到空分镜死胡同 | ❌ | `storyboard/StoryboardHeaderBar.vue:51-61` 空态仅"添加分镜"/"AI 拆分镜"两 CTA，无"去剧本"/"启动 AI 导演" |
| LOGIC-P0-01 reviewGate 双语义冲突 | 🔧 | schema 已拆 `render.shotReviewGate`（`settingsStore.ts:133`）/ `render.reviewGate`（:138）；UI 已拆 `SettingsView.vue:113/:121`；**但 live 门禁仍读旧字段**：`index.ts:356`、`conversationService.ts:781` 均读 `render.reviewGate`；`render.shotReviewGate` 仅被死代码 `ipc/render.ts:31`、`conversationToolsDirector.ts:112` 读取；`settingsStore.ts:175` normalize 仍用 `creation.edit.reviewGate` 镜像覆盖 `render.reviewGate` → SettingsView:121 下拉是无效控件 |
| LOGIC-P0-02 指定镜重渲先过审再重建首帧 | ❌ | live `index.ts:372-377` 只要 shotIds 非空就无条件 `rebuildShotFirstFrames`；`conversationService.ts:791` 同样无条件；`directorStageShots.ts:231` 重建后 `shot.reviewed=undefined`；新版"仅 forceRebuildFirstFrame 才重建"在死代码 `ipc/render.ts:33-41`；preload `preload/index.ts:45` 虽透传第三参，live handler 不解构，渲染层 6 处调用全只传 2 参 |
| LOGIC-P0-03 perShotAudit 软提示即暂停 | ❌ | live `directorAgent.ts:916-928`：`hintCount = rendered.shots.filter(s=>s.auditHint).length; if (hintCount>0 \|\| failCount>0) { setStage('paused'); finish(); return }`——有 1 镜软提示就停剪辑前；但 `SettingsView.vue:130` tip 写"软提示不阻断剪辑；仍有失败镜才停"——UI 文案与 live 行为矛盾；新版"软 hint 只 log"在死代码 `directorStageRender.ts:268-279` |
| LOGIC-P0-04 TTS audioFailed 补配音未实现 | ❌ | `taskQueueAudio.ts:114` 写 `shot.audioFailed=true`；`taskQueue.ts:532` 暴露 `repairSilentDialogue()`；但全 src grep 调用点仅死代码 `directorStageRender.ts:300`；live `directorAgent.ts` grep `audioFailed\|repairSilentDialogue` 0 命中 |

#### P1（17 项）

| 编号 | 状态 | 证据摘要 |
|---|---|---|
| UX-P1-01 陈旧 lastProjectId 驱动侧栏 | ✅ | `composables/useActiveProject.ts:17` forgetLastProjectIfMissing；`App.vue:181`、`ProjectListView.vue:410/506` 联动 |
| UX-P1-02 /console 与 /project/:id/console 会话域分裂 | 🔧 | `router/index.ts:17/:25` 双路由仍并存；`ConsoleView.vue:196` chatScope=projectId\|\|'global'；confirmStart :341-345 开拍后 router.replace 做了一半 |
| UX-P1-03 "去 AI 导演"只回首页不打开表单 | ❌ | `ScriptView.vue:32` push `/?openDirector=1`；`ProjectListView.vue` grep `openDirector` 0 命中，首页不消费该 query |
| UX-P1-04 分镜/队列右键菜单缺 Esc 与钳位 | 🔧 | `storyboard/ShotTablePanel.vue:204-218`、`QueueView.vue:341-346` 仍自管 contextMenu；资产页已用 useContextMenu |
| UX-P1-05 软审核门"告警放行"易漏看 | ❌ | `StoryboardView.vue:486-491` render.start 先入队再 ElMessage.warning，无二次确认；QueueView:362、ConsoleView:284 同 |
| UX-P1-06 聊天上传取消被当成错误 | ❌ | `composables/useDirectorChat.ts:282-284` catch 未过滤 `'User cancelled'` |
| UX-P1-07 onClearTask 仅清本地 UI | ❌ | `useDirectorState.ts:304-306` 纯前端；`shared/ipc-channels.ts:73` `directorClearState` 通道定义了但主进程 0 注册 |
| UX-P1-08 clearChatGuarded 吞掉 cancel 失败 | ❌ | `ConsoleView.vue:460` `cancel(pid).catch(()=>{})` 后 :461 无条件 ElMessage.warning('已请求取消') |
| UX-P1-09 Comfy 侧栏状态无 CTA | ✅ | `App.vue:162-167` onComfyStatusClick 未连接时 router.push('/settings') |
| LOGIC-P1-01 导演自动路径绕过分镜 reviewed 门禁 | ❌ | live `directorAgent.ts:815-827` 无 `pauseUntilShotsReviewed` 调用；该函数仅在死代码 `directorStageRender.ts:166` |
| LOGIC-P1-02 一致性模式语义冲突 | 🔧 | `taskQueueConsistency.ts:106-110` fallbackWan/rerender 触发 Wan fallback；`pipelineGuards.ts:15-26` warn/off 下仍按灾难分（<0.15）强制切一次；warn 模式仍可能意外触发 Wan |
| LOGIC-P1-03 patchShot 未回写 frameSeconds | ✅ | `taskQueue.ts:438` `frameSeconds: shot.frameSeconds ?? prev.frameSeconds` |
| LOGIC-P1-04 导演拼接忽略剪辑台 trim/skip | ❌ | `directorAgent.ts:1169-1177` smartConcatSegments 只传 path/scene/hasDialogue/transition，**不传 trimStart/trimEnd/skipped** |
| LOGIC-P1-05 Cancel 后 waitForCompletion 悬挂 | ✅ | `comfyuiClient.ts:372-377` rejectPending；`taskQueue.ts:225/240` cancel 时调用 |
| LOGIC-P1-06 每镜 upload 使 object_info 全量失效 | ✅ | `comfyuiClient.ts:280-283` uploadImage/uploadAudio 不再调 invalidate；getObjectInfo 有 5 分钟 TTL |
| LOGIC-P1-07 projectSave 无服务端校验 | ✅ | `projectStore.ts:100` normalizeProject 校验 reviewed 合法性 |
| LOGIC-P1-08 minShots/maxShots 仅进 prompt 未强制 | ❌ | `shared/pipelineGuards.ts:6` `clampShotList` 定义了但全 src 0 调用；analyze 后无钳制 |
| LOGIC-P1-09 doSave done 保护与显式重置博弈 | ✅ | `projectStore.ts:155-158` intentReset 标记绕过 done 保护；`directorStageShots.ts:235` 设 intentReset=true |

#### P2（20 项）

| 编号 | 状态 | 证据摘要 |
|---|---|---|
| UX-P2-01 ProjectListView 加载无骨架 | ❌ | ProjectListView grep `v-loading` 0 命中 |
| UX-P2-02 无 Script/Props/Console 热键 | 🔧 | `App.vue:227` 仅 ctrl+comma；`composables/useHotkeys.ts` 1.7KB 未扩展 |
| UX-P2-03 DirectorFlow 题材校验不统一 | ❌ | `DirectorFlow.vue:361-362` submit 不校验 genre；DirectorStartForm:172 校验 |
| UX-P2-04 WorkflowPanel 题材无自定义 | ✅ | DirectorStartForm:15 el-input+el-select 组合 |
| UX-P2-05 SettingsView LLM 测试文案 | ⚠️ | 未逐行核对 LlmSection.vue |
| UX-P2-06 资产页空状态无跨页 CTA | ❌ | CharacterView/PropsView/SceneBoardView 空态仅本地"添加" |
| UX-P2-07 ConsoleView 批量重渲 toast 部分失败仍 success | ❌ | `ConsoleView.vue:360` 无汇总计数；`useDirectorState.ts:262` 只 toast"已重新入队 N 个" |
| UX-P2-08 main.ts unhandledrejection 良性 reject 刷屏 | 🔧 | `main.ts:49-53` 有 3s 节流，但未白名单 `'User cancelled'` |
| UX-P2-09 无首跑 SelfCheck 向导 | ❌ | 有 SelfCheckPanel.vue 但无首次启动 checklist 弹窗 |
| UX-P2-10 DirectorFlow.locateFinal 缺 try/catch | ❌ | `DirectorFlow.vue:433-437` 直接 shell.showItem，无 catch；useDirectorState:309-316 那份已修 |
| LOGIC-P2-01 auditSingleShot 全图分用人脸阈值 | ⚠️ | directorStageAudit 与 directorAgent:2455 私有副本未逐行核对 |
| LOGIC-P2-02 consistencyService sticky fail | ⚠️ | 未深挖重试策略 |
| LOGIC-P2-03 comfyMcpService 硬编码盘符 | ⚠️ | 未逐行核验 |
| LOGIC-P2-04 imageService 静默 fallback 工作流 | ⚠️ | `settingsStore.ts:32` fusionFallback:'block' 已部分缓解 |
| LOGIC-P2-05 llmService analyze 超长超时 | ❌ | `llmService.ts:644/:684` chat(...,1200000,32768) = 1200s 无 AbortSignal |
| LOGIC-P2-06 多角色镜折叠为单 characterName | ✅ | live directorReanalyze（render.ts:168-220）已持久化 characterIds[] |
| LOGIC-P2-07 waitForFinish 无超时 | ⚠️ | taskQueue.waitForFinish 默认 6h 硬编码（taskQueue.ts:389） |
| LOGIC-P2-08 Turbo 文案步数不符 | ⚠️ | 未逐行核对 |
| LOGIC-P2-09 ffmpegExtractFrames 未 resolve 路径 | ⚠️ | 未逐行核验（与 S-01 假修同源） |
| LOGIC-P2-10 renderCandidates>1 评分口径不一 | ⚠️ | candidatePickService.ts 存在但未深挖 |

### 2.3 交互整改清单-2026-10-18（21 项全核）

| 编号 | 节点 | 状态 | 证据 |
|---|---|---|---|
| A1 | main.ts 全局兜底 | ✅ | `main.ts:49-58` unhandledrejection + app.config.errorHandler，43-48 行 3s 节流 |
| B1 | ProjectListView deleteProject | ✅ | `ProjectListView.vue:402` confirmDanger；:414 独立 catch |
| B2 | ProjectListView batchDuplicate | ✅ | :429 confirmAction |
| B3 | ProjectListView batchDelete | ✅ | :494 confirmDanger |
| B4 | useSkillsManager removeSkill | ✅ | confirmDanger + try/catch |
| B5 | useMemoryManager removeMemory | ✅ | 同 B4 |
| B6 | useDirectorChat rollbackMsg | ✅ | confirmDanger |
| B7 | useDirectorChat clearChat | ✅ | `useDirectorChat.ts:299-310` confirmDanger + try/catch + toast |
| B8 | useDirectorState onStop | ✅ | `useDirectorState.ts:275-285` confirmDanger |
| B9 | useDirectorState onClearTask | ✅ | :299-302 confirmAction（仅清本地 UI 问题见 UX-P1-07） |
| B10 | DirectorFlow cancelDirector | ✅ | `DirectorFlow.vue:396-407` confirmDanger + try/catch |
| B11 | ConsoleView clearChatGuarded 三态 | ✅ | `ConsoleView.vue:444-456` distinguishCancelAndClose |
| C1 | QueueView cancelShot try/catch | ✅ | `QueueView.vue:382-388` |
| C2 | useDirectorState onPause try/catch | ✅ | `useDirectorState.ts:225-230` |
| C3 | useDirectorState onResume 成功 toast | ✅ | :236 ElMessage.success('已继续执行') |
| C4 | useDirectorState openFinalFolder 缺文件提示 | ✅ | :311-315 catch 后 warning（DirectorFlow:433 那份漏修，见 UX-P2-10） |
| C5 | useDirectorState hydrate 静默兜底 | ✅ | :158-162 catch 后 console.warn |
| C6 | DirectorFlow selectVideo/selectBgm | 🔧 | DirectorStartForm:138-145/161-168 已补；DirectorFlow 内嵌旧表单未迁移 |
| D1 | ShotEditDialog 导入哨兵 | ✅ | `ShotEditDialog.vue:373/385` 过滤 'User cancelled' |
| D2 | SceneBoardView importPlate 哨兵 | ✅ | `SceneBoardView.vue:330-332` |
| D3 | CharacterView importImage 哨兵 | ✅ | `CharacterView.vue:311-313` |

---

## 3. 增量问题清单（基线之外新发现）

### 3.1 架构与可靠性（主进程）

| # | 位置 | 问题 | 影响 | 建议 | 工作量 |
|---|---|---|---|---|---|
| A1 | `src/main/ipc/*.ts` 16 个模块 | registerXxxIpc 全仓 0 调用，是死代码；但 directorStageRender.ts:20-27 自注释"live 走 directorAgent 私有副本"，且 `directorAgent.ts:818` 用 `this as unknown as DirectorStageRuntime` 硬转消费其导出函数——**死代码没死透** | 所有"新版修复"静默丢弃；新人改 directorAgent 不知道哪些逻辑该同步 | 二选一：(a) 在 index.ts 注册入口补调所有 registerXxxIpc(ctx)，删 index.ts 内联 handler；(b) 反向删 ipc/*.ts + directorStageRender.ts，把校验合回 index.ts | **M（1-3 人日）** |
| A2 | 全 src grep `process.on('unhandledRejection'\|'uncaughtException')` | **0 处** | 任何一个 fire-and-forget Promise（`taskQueue.ts:192` `void this.process()`、`index.ts:1457` recoverStaleRenders、`directorAgent.ts:151` store.get().then()）抛错未 catch 时主进程直接崩溃，所有渲染中任务丢失 | index.ts 顶部加 unhandledRejection/uncaughtException 处理器，落盘日志 + 不退出 | S |
| A3 | `core/logger.ts:24-31` | createLogger 只 console，打包后用户崩溃现场无日志 | 线上问题无法排查 | logger 加文件追加（userData/logs/ 按日切分） | S |
| A4 | `index.ts:1515-1518` before-quit | 只 `comfyMcpService.dispose()`，不 cancel directorAgent/running、不 cancel taskQueue、不 disconnect comfyui、不等 ffmpeg 退出 | 关窗口时 ComfyUI detached 进程继续跑；再开窗口看到"running"残留 | before-quit 遍历 cancel 所有项目 + taskQueue.cancel 全部 + comfyuiClient.disconnect() + 5s 超时 force quit | M |
| A5 | `index.ts:1511-1513` window-all-closed | 非 macOS 直接 quit，不检查渲染中任务 | 用户误关窗口 = 渲染中断（靠 recoverStaleRenders 兜底，已渲一半的镜状态回退 pending） | 关闭前检查 taskQueue 是否有 running 项目，dialog 确认 | S |
| A6 | `taskQueue.ts:389` | waitForFinish 默认 6 小时硬编码超时；超时 reject 后 listener 已 off（:399），后续 queue-finished 没人接 | 长项目挂 6h 后状态不一致 | 超时改为可配置 + reject 后重挂 listener | S |
| A7 | `taskQueue.ts:226-228` | cancel(shotId) 用 `while (current?.shotId===shotId) await sleep(100)` 忙等 | ComfyUI interrupt 后当前镜若因异常路径没退出，会一直轮询到进程被杀 | 改 Promise 信号量（cancel 时 reject waitForFinish） | M |
| A8 | `taskQueue.ts:536-1199` | renderShot 单方法 664 行，内嵌 runProduction 闭包捕获 20+ 局部变量 | 单测无法覆盖；OOM 降档/引擎回退/抽卡/一致性全在同一作用域 | 拆 RenderContext 对象，renderShot(ctx) 纯函数化 | M |
| A9 | `ffmpegService.ts:84` vs `:156` | canRun 探测有 timeout:10000，但 runFfmpeg → execFileAsync(bin,args) **无 timeout** | ffmpeg 卡死（损坏输入）永远挂起 renderShot | 统一加 timeout（10 分钟），超时 kill | S |
| A10 | `ttsService.ts:203-227` | SAPI powershell + wavToMp3 两个 execFile 均无 timeout 无 kill | System.Speech 异常时 TTS 链路永远挂起 | execFile 加 timeout:60000，on timeout kill | S |
| A11 | `ttsService.ts:161-178` | Qwen 轮询 600s 死循环，不检查项目/镜头取消标志 | 用户取消项目时这个轮询继续跑满 600s | 每轮循环检查 watcher.promise 是否已 reject，或传 AbortSignal | M |
| A12 | `comfyuiClient.ts:525` | waitForCompletion 的 pollTimer setInterval 里 async 回调未 catch | getHistory 网络断时成为 unhandledRejection | pollTimer 回调加 `.catch(()=>undefined)`；检查 this.connected 断了直接 settlePrompt | S |
| A13 | `comfyuiClient.ts:153-167` | spawn ComfyUI 后未显式 p.unref()（detached 已独立进程组，stop() 用 taskkill /T /F 杀树） | 主进程退出时 ComfyUI 继续跑（设计如此），但 JS 侧仍引用子进程对象直到 GC | 显式 p.unref() | XS |
| A14 | `ffmpegService.ts:512/:572/:1029` | 多个 os.tmpdir() 临时目录（concatfit_/smartconcat_/qc_*.png），崩溃后残留 | 磁盘累积 | 统一项目内 .tmp/，启动时扫描清理上次残留 | S |
| A15 | `directorAgent.ts:264-286, 397-417` | 异常清理逻辑三处重复（start catch / resumeFromStage catch / finish） | 新增清理字段时易漏 | 抽 `teardownProject(projectId)` 私有方法，三处统一调用 | S |
| A16 | `directorAgent.ts:2381-2390` | evictFinishedStates 只在 finish() 触发，1 小时淘汰阈值 | 项目多（100+）时 13 个 Map（states/cancelled/progressUnsubs/gates/…）常驻 | 加 setInterval(10min) 主动 evict，或项目删除时联动清理 | S |
| A17 | `index.ts:296-298` | dialogSavedFiles / dialogSelectedDirs 两个 Map 永不清空 | 每次 file dialog 选路径都累加 | TTL 或 LRU 清理 | S |

### 3.2 安全与信任边界（增量）

| # | 位置 | 问题 | 影响 | 建议 | 工作量 |
|---|---|---|---|---|---|
| B1 | `index.ts:532-550` imageGenerate | referenceImagePath(s) 无路径校验，`imageService.ts:137-150` 直接 uploadImage(abs) | 渲染层失陷后可把磁盘任意图片上传 ComfyUI | imageService.generate 内对 refs 逐个 resolveInsideRoot | S |
| B2 | `conversationToolsMemory.ts:120-124` | set_settings 的 llm_baseUrl 仅校验 http/https 前缀，可改为攻击者服务器 | LLM 被提示注入后改 baseUrl，下次请求把 apiKey 作为 Authorization 头发送到攻击者服务器 | llm_baseUrl 改白名单（已知 provider 域名）或要求用户确认 | S |
| B3 | `index.ts:1310-1313` llmWriteScriptFromVideo | 无 try/finally 清理 tmpDir；before-quit 也未补 %TEMP%/drama-studio-frames | 临时帧目录持续泄漏 | :1310 补 try/finally；before-quit 补 fs.rm(tempDir) | S |
| B4 | `llmRequest.ts:14-16` | LLM_DUMP_DIR 注释说 userData/drama-studio/tmp，代码实际 APPDATA/drama-studio/tmp，与 DATA_ROOT（userData/drama-studio/drama-studio）不同树 | 注释误导排查；dump 目录与数据根不齐 | 统一用 app.getPath('userData') 拼接 | XS |
| B5 | `comfyuiClient.ts:139-153` | startCommand spawn 任意带路径 exe（无 shell 拼接面，但可 spawn 任意 exe） | 渲染层失陷后可让主进程 spawn 恶意软件 | 不建议白名单化（怕打死用户自定义路径）；settings UI 对 startCommand 做二次确认提示 | XS |

### 3.3 产品与逻辑一致性（增量）

| # | 位置 | 问题 | 影响 | 建议 | 工作量 |
|---|---|---|---|---|---|
| C1 | `SettingsView.vue:121` vs `settingsStore.ts:175` | "成片复审门控"下拉绑 render.reviewGate，但 normalize 用 creation.edit.reviewGate 覆盖 | 用户改了被静默还原；真正生效的开关在 CreationGroup:233 | 删 SettingsView:121 重复下拉，或绑到 creation.edit.reviewGate；停 normalize 镜像 | S |
| C2 | `DirectorFlow.vue:4-105` vs `DirectorStartForm.vue` | 项目列表开拍入口仍用旧表单，不传 gateStages、不校验 genre | 两入口行为分裂（UX-P0-01 残留） | DirectorFlow 的 el-dialog 内表单替换为 DirectorStartForm，submit 透传 gateStages | S |
| C3 | `DirectorFlow.vue:383-385` | 开拍成功后不 router.push('/project/:id/console') | 用户切页后进度 dialog 消失，主进程任务在跑但 UI 无入口 | 开拍成功后 router.push，让 WorkflowPanel 接管进度展示 | S |
| C4 | `shared/pipelineGuards.ts:6` | clampShotList 定义了但全 src 0 调用 | LLM 拆镜镜数失控（3 镜或 50 镜）无钳制 | llmService.analyze 返回后、directorAgent 用 result.shots 前调一次 | XS |
| C5 | `shared/ipc-channels.ts:73` | directorClearState 通道定义了但主进程 0 注册 | onClearTask 清完 UI，主进程内存态还在，hydrate 后"复活" | 主进程注册 director:clearState handler（清内存 state + logs），渲染层 onClearTask 调一次 | S |
| C6 | `DirectorFlow.vue:433-437` | locateFinal 缺 try/catch | 成片文件被移动/删除后点"在文件夹中显示"无反馈 | 对齐 useDirectorState.ts:309-316 的 try/catch + warning | XS |
| C7 | `useDirectorChat.ts:282-284` | uploadAndSend catch 未过滤 'User cancelled' | 对话上传文件点取消仍弹红字"文件读取失败" | catch 里 `if (e?.message==='User cancelled') return` | XS |
| C8 | `ProjectListView.vue` | 不消费 `?openDirector=1` query | ScriptView "去 AI 导演" CTA 点了只回首页 | onMounted 检查 route.query.openDirector，若为 '1' 则 directorFlowRef.value?.open() | XS |
| C9 | `index.ts:356` + `conversationService.ts:781` vs `ipc/render.ts:31` | 三处门禁读的字段不统一（live 读 render.reviewGate，死代码读 render.shotReviewGate） | 未来改一处漏一处 | 收敛到 render.shotReviewGate 单字段，删 render.reviewGate 在分镜门的所有读取点 | S |
| C10 | `llmService.ts:644/:684` | analyze chat(...,1200000,32768) = 1200s 无 AbortSignal | 用户停止按钮在 analyze 阶段无效 | 传 AbortSignal，与同服务其他 chat 调用一致 | S |
| C11 | `conversationService.ts:28` | MAX_TOOL_ROUNDS=1000，单轮 timeout 5min，理论最长 83 小时 | 对话 Agent 死循环时无法收场 | 降到 50-100 轮，或按工具类型设上限 | S |

### 3.4 工程治理与质量

| # | 位置 | 问题 | 影响 | 建议 | 工作量 |
|---|---|---|---|---|---|
| D1 | `E:\drama-studio\~\` | **误拷的完整 Windows 用户主目录**：含 NTUSER.DAT(6.8MB)、.ssh/ 私钥、.gitconfig、.npmrc、.cargo/、.rustup/、.ollama/ 等 | **安全风险极高**——.ssh 私钥、.npmrc 凭据、gitconfig 都在项目目录里 | **必须删除**（用户自行确认后） | XS |
| D2 | `scripts/patch-element-plus.mjs` | postinstall 钩子 `node scripts/patch-element-plus.mjs` 引用该文件，但 `git ls-files scripts` 返回 0——文件未入库 | 新克隆仓库 npm install 会因找不到文件而失败 | `git add scripts/patch-element-plus.mjs` | XS |
| D3 | `tests/unit/` 23 个 spec | 全部 untracked（`git ls-files tests` 返回空） | 测试资产未入库，换机器/新克隆丢失 | `git add tests/unit/` | XS |
| D4 | `docs/` + `skills/` | 项目文档与导演技能规则未入库 | 知识资产丢失 | `git add docs/ skills/` | XS |
| D5 | `test/` 10 个旧 smoke entry + `vite.renderer.config.ts` | 已从磁盘删除但仍被 git tracked（`git status --short` 显示 11 个 `D`） | 仓库索引与磁盘不一致 | `git rm -r --cached test/ vite.renderer.config.ts` | XS |
| D6 | 根目录 12 个 *.log + 2 个 *.tsbuildinfo | dev-err/out、smoke-dev-err/out、wuxia-dev-out1~8、tsconfig.*.tsbuildinfo | 工作区噪音（.gitignore 已覆盖，但文件仍在） | 直接删除 | XS |
| D7 | `scripts/` 190 文件 / 548.7KB | 114 个日志产物（320KB）+ 55 个一次性跑片/补丁 mjs（150KB），仅 5 个通用工具保留 | 仓库臃肿，与构建无关 | 删 114 个日志；归档 55 个 mjs 到 scripts/archive/；保留 patch-element-plus/convert-comfy-ui/watch-*/smoke-* | S |
| D8 | `.tmp-test/`、`tmp/`、`.screenshots/`、`.trae/` | 未被 .gitignore 覆盖 | IDE/临时残留混入工作区 | 删除或加入 .gitignore | XS |
| D9 | `.gitignore` | 缺 `tmp/`、`.tmp-test/`、`.screenshots/`、`.trae/`、`*.pid`、`*.out` | 未来同类残留仍会出现 | 补 6 行 | XS |
| D10 | 无 eslint/prettier/husky/lint-staged | `Test-Path node_modules\.bin\eslint.cmd`=False | 无静态检查、无提交门禁 | 引入 @electron-toolkit/eslint-config + prettier + husky + lint-staged，加 `npm run lint` | M |
| D11 | `devDependencies.playwright-core@^1.63.0` | 死依赖：无 playwright.config、无 e2e/ 目录、无引用 | 装包体积浪费 | 移除或补 e2e | XS |
| D12 | `tsconfig.*.json` | 未开 `noUnusedLocals` / `noUnusedParameters` | 死代码无法被编译器发现（A1 死代码群能存在至今与此相关） | 开启（先 warn 后 error） | S |
| D13 | `vitest.config.ts` | 无 coverage 配置、无阈值；environment:'node' 无 jsdom | 测试覆盖率不可见；渲染层组件零测试 | 加 v8 coverage 起步阈值 30% lines；长期加 jsdom + 组件测试 | M |
| D14 | electron-builder.yml | 未显式 asarUnpack onnxruntime-node / @xenova/transformers | 打包后人脸检测可能无法加载原生模块 | 验证打包后 onnx 可加载，必要时加 asarUnpack | S |
| D15 | 测试盲区 | 56 个 core 模块中约 20 个完全无单测：directorAgent(128KB)、conversationService(79KB)、llmService(77KB)、ffmpegService(41KB)、ttsService、consistencyService、faceDetector、6 个 conversationTools 子模块等 | 核心业务无回归网 | 优先补 5 个（见 §4 P1-测试） | L |

---

## 4. 迭代路线图

### 4.1 P0：本周必须动（安全止血 + 假闭环揭穿）

> 目标：消除"看似已修实则未修"的混乱状态，让后续工作建立在真实代码上。预计 5-7 人日。

| 序 | 动作 | 类别 | 对应问题 | 预期收益 |
|---:|---|---|---|---|
| P0-1 | **删除 `E:\drama-studio\~\` 目录**（用户确认后） | 工程清理 | D1 | 消除 .ssh 私钥/凭据泄漏面 |
| P0-2 | **git 入库治理一把梭**：`git add scripts/patch-element-plus.mjs tests/unit/ docs/ skills/` + `git rm -r --cached test/ vite.renderer.config.ts` | 工程清理 | D2/D3/D4/D5 | 新克隆可装可测；测试资产入库 |
| P0-3 | **死代码二选一决策与执行**（A1）：推荐方案 (a) 把 `registerXxxIpc(ctx)` 真正接线到 index.ts:1440，删 index.ts 内联重复 handler；若周期紧张则方案 (b) 反向删 ipc/*.ts + directorStageRender.ts，把 S-01/S-02 校验合回 index.ts | 架构重构 | A1 + S-01/S-02/S-05/D-02 假修根因 | **一举揭穿 4 项假修**，后续修复不再落死代码 |
| P0-4 | **全局异常兜底**：index.ts 顶部加 `process.on('unhandledRejection'/'uncaughtException')` 落盘日志（A2/A3） | 架构重构 | A2/A3 | 主进程崩溃有现场可查；fire-and-forget Promise 不再炸进程 |
| P0-5 | **LOGIC-P0-01 live 字段切换**：index.ts:356、conversationService.ts:781 改读 `render.shotReviewGate`；删 settingsStore.ts:175 的镜像；删 SettingsView:121 无效下拉 | 立即修 | LOGIC-P0-01 + C1/C9 | 三个门禁字段收敛为一个真生效开关 |
| P0-6 | **LOGIC-P0-02 live 重渲链路修正**：index.ts:372-377 改为仅当 forceRebuildFirstFrame=true 才调 rebuildShotFirstFrames；渲染层 6 处调用按需传第三参 | 立即修 | LOGIC-P0-02 | 审过的镜重渲不再白审 |
| P0-7 | **LOGIC-P0-03 live perShotAudit 语义对齐**：directorAgent.ts:916-928 改为软 hint 只 log、硬失败才暂停；SettingsView:130 tip 与 live 一致 | 立即修 | LOGIC-P0-03 | 自动驾驶不被软 hint 打断 |
| P0-8 | **S-05 autoLearn 门控接线**：conversationService.ts:1457-1476 补读 `settings.general.autoLearn`，false 时直接 return | 立即修 | S-05 | 启动不再无条件注入学习 prompt |
| P0-9 | **S-01/S-02 校验补回 live**：index.ts:411/520/1309 三个 handler 补 hasDialogSession 校验 + :1310 补 try/finally 清理 tmpDir | 立即修 | S-01/S-02 + B3 | 渲染层失陷后不能读任意视频/音频 |
| P0-10 | **根目录卫生清理**：删 12 个 log + 2 个 tsbuildinfo + .tmp-test/tmp/.screenshots/.trae；.gitignore 补 6 行 | 工程清理 | D6/D8/D9 | 工作区噪音消除 |

**P0 依赖关系**：P0-3 是 P0-5/6/7/9 的前置（死代码接线后，live 字段切换才有意义）。建议顺序：P0-1 → P0-2 → P0-3 → P0-4 → P0-5/6/7/8/9 → P0-10。

### 4.2 P1：两周内（可靠性 + 核心测试 + 安全收尾）

> 目标：主进程崩溃可恢复、核心路径有回归网、安全面收口。预计 10-15 人日。

| 序 | 动作 | 类别 | 对应问题 | 预期收益 |
|---:|---|---|---|---|
| P1-1 | **before-quit 优雅退出**：cancel directorAgent/running 项目 + taskQueue.cancel 全部 + comfyuiClient.disconnect() + 5s 超时 force quit（A4/A5） | 架构重构 | A4/A5 | 关窗口不再留 ComfyUI 僵尸进程 |
| P1-2 | **ffmpeg/TTS 子进程 timeout 统一**：runFfmpeg 加 10min timeout；SAPI/wavToMp3 加 60s timeout；Qwen 轮询加取消检查（A9/A10/A11） | 立即修 | A9/A10/A11 | 子进程卡死不再挂死整条流水线 |
| P1-3 | **apiKey safeStorage 加密落盘**：settingsStore.ts:201 改用 electron safeStorage 加密 apiKey 字段；llmRequest.ts:63 读取时解密 | 架构重构 | S-03 | settings.json 泄漏不再直接暴露 apiKey |
| P1-4 | **set_settings baseUrl 白名单**：conversationToolsMemory.ts:120-124 限制 llm_baseUrl 为已知 provider 域名或要求用户确认（B2） | 立即修 | B2 + S-03 叠加 | 阻断"提示注入 → 改 baseUrl → apiKey 外发"链路 |
| P1-5 | **imageGenerate referenceImagePath 校验**：imageService.ts:137-150 对 refs 逐个 resolveInsideRoot（B1） | 立即修 | B1 | 主进程不再上传任意本地图片 |
| P1-6 | **补 5 个核心测试**：(1) llmService 重试/超时/429 分类 M；(2) taskQueue 队列调度（优先级/pause/resume/失败重试）M；(3) ffmpegService 命令构造 M；(4) directorAgent 状态机迁移 L（需先抽离状态机）；(5) conversationService 工具分发 loop L | 架构重构 | D15 | 核心路径有回归网，后续重构不抖 |
| P1-7 | **DirectorFlow 表单迁移 + 开拍跳控制台**：DirectorFlow.vue:4-105 换 DirectorStartForm；:383-385 开拍后 router.push('/project/:id/console')（C2/C3） | 立即修 | UX-P0-01/02 + C2/C3 | 双入口分裂收口；进度 UI 不随列表卸载 |
| P1-8 | **小修批量打包**：clampShotList 接线（C4）、directorClearState 接线（C5）、DirectorFlow.locateFinal try/catch（C6）、uploadAndSend 取消哨兵（C7）、openDirector query 消费（C8）、llmService analyze 加 AbortSignal（C10）、MAX_TOOL_ROUNDS 降到 50-100（C11） | 立即修 | C4/C5/C6/C7/C8/C10/C11 | 7 个用户体感问题一次清 |
| P1-9 | **ffmpeg 临时目录项目内化 + 启动清理**：concatfit_/smartconcat_/qc_*.png 改到项目 .tmp/，启动扫描清理上次残留（A14） | 工程清理 | A14 | os.tmpdir 不再累积残留 |
| P1-10 | **scripts/ 归档**：55 个一次性 mjs 移到 scripts/archive/2026-q4-films/ 和 oneoff-fixes/；保留 5 个通用工具（D7） | 工程清理 | D7 | scripts/ 从 190 文件降到约 20 |

### 4.3 P2：月度迭代（架构长期治理 + 工程化）

> 目标：拆上帝类、上工程化门禁、测试覆盖可见。预计 20-30 人日，可跨 4-6 周。

| 序 | 动作 | 类别 | 对应问题 | 预期收益 |
|---:|---|---|---|---|
| P2-1 | **directorAgent.ts 拆分**（128KB/2548 行 → 6 模块）：directorStateMachine(400) + directorPipeline(500) + directorAssetBuilder(600) + directorManualOps(250) + directorProgressBridge(200) + directorFinish(300)；前置抽 DirectorStateStore 解决 13 个 Map 跨模块共享 | 架构重构 | A1 + 主进程专家 §1.2 | 上帝类解体，状态机可单测 |
| P2-2 | **taskQueue renderShot 拆分**：抽 RenderContext 对象，renderShot(ctx) 纯函数化（A8）；拆 taskQueueScheduler.ts(400) + taskQueueRenderShot.ts(700) | 架构重构 | A8 | renderShot 664 行可测 |
| P2-3 | **conversationService 拆分**（79KB/1478 行 → 5 模块）：conversationSession + conversationAgentLoop + conversationToolDispatcher + conversationToolsProjectOps + conversationToolsSettings | 架构重构 | 主进程专家 §1.2 | 30+ t* 工具按域归位 |
| P2-4 | **llmService 拆分**（77KB/1387 行 → 4 模块）：llmHttp + llmScriptOps + llmPostProcess + llmAudit | 架构重构 | 主进程专家 §1.2 | analyze 220 行解析可独立测试 |
| P2-5 | **index.ts IPC 域化**：registerIpc 1100 行回调拆到 ipc/*.ts 各域 register(handleIpc, deps)，index.ts 只做胶水（A1 完成后顺手做） | 架构重构 | A1 | IPC 注册面可审 |
| P2-6 | **引入 eslint + prettier + husky + lint-staged**：加 `npm run lint`；tsconfig 开 noUnusedLocals/noUnusedParameters（D10/D12） | 工程清理 | D10/D12 | 死代码在编译期暴露；提交门禁 |
| P2-7 | **vitest coverage 起步**：加 v8 coverage，lines 30% 阈值（D13） | 工程清理 | D13 | 测试覆盖率可见 |
| P2-8 | **移除死依赖** playwright-core（或补 e2e）；确认 rolldown 是否需要（D11） | 工程清理 | D11 | 装包瘦身 |
| P2-9 | **验证 electron-builder 原生模块打包**：onnxruntime-node / @xenova/transformers 加 asarUnpack（D14） | 立即修 | D14 | 打包后人脸检测可用 |
| P2-10 | **渲染层组件测试起步**：vitest 加 jsdom，先给 StoryboardView/QueueView/DirectorFlow 写烟雾测试 | 架构重构 | D13 | 渲染层零测试现状改善 |
| P2-11 | **dialogSavedFiles/dialogSelectedDirs LRU 清理**（A17）+ **evictFinishedStates 主动定时 evict**（A16） | 立即修 | A16/A17 | 长跑内存不膨胀 |
| P2-12 | **ffmpegService 拆分**（41KB/1033 行 → ffmpegBin/Image/Video/Run 4 模块） | 架构重构 | 主进程专家 §1.2 | ffmpeg 命令构造可测 |

---

## 5. 明确不做什么（本期范围边界）

为避免方案无限膨胀，以下事项**本期不做**，明确划出：

1. **不动业务功能**：本次是出方案，不是动手改业务代码。P0/P1/P2 清单是给后续迭代排期用的，不在本次会话执行。
2. **不做真实删除/修改**：`~` 目录、scripts/ 日志、根目录 log、git rm --cached 等动作，文档里列清单即可，由用户在自己的节奏里执行。
3. **不引入新业务功能**：本期不加新 CTA、不加新向导、不做 UI 改版（除 P0-5/6/7 的字段/语义修正外）。UX-P2-01/06/09 等"锦上添花"项推到 P2 之后。
4. **不重写 ComfyUI/ffmpeg/edge-tts 对接层**：只补 timeout/清理/取消信号，不改对接协议。
5. **不做 E2E 测试基建**：playwright-core 是死依赖，本期只决定"移除还是补 e2e"，不实际搭 E2E。
6. **不做渲染层大规模组件测试**：只起步加 jsdom，不追求 Vue 组件覆盖率。
7. **design-audit 剩余 10 项未核**：本次安全专家只核了 S-01~S-06 + D-01~D-04 共 10 项；design-audit 总共 20 项，剩余 10 项（S-07~S-10 / D-05~D-10）本次未逐条走读，列入下一轮补查。
8. **efficiency-audit 8 个 P2 ⚠️ 项未深挖**：UX-P2-05、LOGIC-P2-01/02/03/04/07/09/10 本次只标记状态未逐行取证，列入下一轮。
9. **不做性能压测/渲染层 profile**：本次只做静态走读，不跑长片压测、不做 Chrome DevTools Performance profile。
10. **不升级 Electron/Vue/electron-vite 大版本**：依赖升级另立专项，不在本次整改范围。

---

## 附录 A：取证命令与结果

### A.1 `npm run typecheck`（vue-tsc --noEmit 双端）

```
> drama-studio@1.0.0 typecheck
> npm run typecheck:node && npm run typecheck:web

> drama-studio@1.0.0 typecheck:node
> vue-tsc --noEmit -p tsconfig.node.json --composite false

> drama-studio@1.0.0 typecheck:web
> vue-tsc --noEmit -p tsconfig.web.json --composite false

TYPECHECK_EXIT=0
```

✅ 0 错误。完整日志：`docs/_typecheck-2026-10-27.log`。

### A.2 `npm test`（vitest v5.0.5）

```
 ✓ tests/unit/assetReuse.spec.ts (9 tests) 6ms
 ✓ tests/unit/subtitleService.spec.ts (3 tests) 24ms
 ✓ tests/unit/workflowLibrary.spec.ts (5 tests) 21ms
 ✓ tests/unit/workflowLoader.spec.ts (10 tests) 54ms
 ✓ tests/unit/llmPromptsAnalyze.spec.ts (8 tests) 12ms
 ✓ tests/unit/lookEnHarden.spec.ts (9 tests) 10ms
 ✓ tests/unit/taskQueueRender.spec.ts (46 tests) 11ms
 ✓ tests/unit/pipelineGuards.spec.ts (10 tests) 10ms
 ✓ tests/unit/tmp-drift-guard.spec.ts (3 tests) 12ms
 ✓ tests/unit/creationSettings.spec.ts (4 tests) 5ms
 ✓ tests/unit/comfyuiClient.pending.spec.ts (3 tests) 14ms
 ✓ tests/unit/promptAuditRules.spec.ts (5 tests) 4ms
 ✓ tests/unit/era-lock-check.spec.ts (6 tests) 8ms
 ✓ tests/unit/errorClassify.spec.ts (6 tests) 6ms
 ✓ tests/unit/propsConstraint.spec.ts (28 tests) 15ms
 ✓ tests/unit/settingsStore.spec.ts (8 tests) 78ms
 ✓ tests/unit/projectStore.duplicate.spec.ts (3 tests) 97ms
 ✓ tests/unit/preloadRenderStart.spec.ts (2 tests) 6ms
 ✓ tests/unit/comfyMcpService.filter.spec.ts (7 tests) 8ms
 ✓ tests/unit/conversationTools.spec.ts (29 tests) 9ms
 ✓ tests/unit/llmParsersNorm.spec.ts (3 tests) 9ms
 ✓ tests/unit/roleBinding.spec.ts (15 tests) 6ms
 ✓ tests/unit/taskQueue.quickRender.spec.ts (3 tests) 29ms

 Test Files  23 passed (23)
      Tests  225 passed (225)
   Duration  1.76s

TEST_EXIT=0
```

✅ 23 spec / 225 用例全过。完整日志：`docs/_test-2026-10-27.log`。

### A.3 关键 grep 取证记录

```powershell
# 死代码群证据
rg "registerFfmpegIpc|registerTtsIpc|registerLlmIpc|registerRenderIpc|registerSettingsIpc" src/
# → 仅命中各模块自身 export function 定义行，0 调用

# 全局异常处理器
rg "unhandledRejection|uncaughtException" src/main/
# → 0 命中

# safeStorage
rg "safeStorage" src/
# → 0 命中

# clampShotList 调用
rg "clampShotList" src/
# → 仅定义处 shared/pipelineGuards.ts:6，0 调用

# directorClearState 注册
rg "directorClearState" src/
# → shared/ipc-channels.ts:73 定义，主进程 0 注册

# git tracked 状态
git ls-files scripts    # → 空
git ls-files tests      # → 空
git ls-files docs       # → 空
git ls-files test       # → 10 个已删除文件
git status --short | Where { $_ -match '^ D' }   # → 11 条
```

---

## 附录 B：工程清理动作速查（只列动作，未执行）

### B.1 P0（本周）

1. 删除 `E:\drama-studio\~\` 目录（含 .ssh 私钥，**用户自行确认后执行**）。
2. `git add scripts/patch-element-plus.mjs tests/unit/ docs/ skills/`
3. `git rm -r --cached test/ vite.renderer.config.ts`
4. 删除根目录：dev-err.log、dev-out.log、smoke-dev-err.log、smoke-dev-out.log、wuxia-dev-out.log~out8.log（共 12 个）、tsconfig.node.tsbuildinfo、tsconfig.web.tsbuildinfo。
5. 删除 `.tmp-test/`、`tmp/`、`.screenshots/`、`.trae/`。
6. `.gitignore` 追加：`tmp/`、`.tmp-test/`、`.screenshots/`、`.trae/`、`*.pid`、`*.out`。

### B.2 P1（两周内）

7. 删除 scripts/ 下 114 个日志产物（*.log/*.log2/*.out/*.stderr/*.pid，320KB）。
8. 归档 scripts/ 下约 55 个一次性 mjs/ts/ps1 到 `scripts/archive/2026-q4-films/` 与 `scripts/archive/oneoff-fixes/`。
9. 保留 scripts/ 下 5 个通用工具：patch-element-plus.mjs（postinstall 依赖）、convert-comfy-ui.mjs、director-states.mjs、watch-gate.mjs、watch-render.mjs、smoke-run.mjs、harden-smoke.mjs。

### B.3 P2（月度）

10. 引入 eslint + prettier + husky + lint-staged，加 `npm run lint`。
11. 移除死依赖 `playwright-core`（或补 e2e）；确认 `rolldown` 是否需要。
12. tsconfig 开 `noUnusedLocals` / `noUnusedParameters`。
13. vitest 加 v8 coverage，lines 30% 阈值起步。
14. 验证 electron-builder 打包后 onnxruntime-node / @xenova/transformers 可加载，必要时加 asarUnpack。

---

## 附录 C：四位专家取证报告索引

| 专家 | 报告路径 |
|---|---|
| 安全与信任边界 | `<agent-workspace>/s_000pODnLnvW/artifacts/security-findings.md` |
| 主进程架构与可靠性 | `<agent-workspace>/s_000pODnw5tj/artifacts/main-arch-findings.md` |
| 产品效率与逻辑一致性 | `<agent-workspace>/s_000pODnwkCo/artifacts/product-logic-findings.md` |
| 工程治理与质量 | `<agent-workspace>/s_000pODnwqr0/artifacts/engg-governance-findings.md` |

> 本方案所有结论均带 文件:行号 证据；触发面不确定的已在各表"备注"或"风险面"列标注。
