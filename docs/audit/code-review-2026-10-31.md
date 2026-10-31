# drama-studio 全量代码审查与架构检查报告

- 审查日期：2026-10-31
- 代码基线：`ec49b00`（feat/agent-autonomy，拆镜提示词规范层已合入）
- 审查方式：按「安全与 IPC / 主进程链路 / 渲染层 / 共享层·测试·依赖·配置」四路并行只读审查，再对全部 P0 与关键 P1 逐行人工复核
- 当前基线：130 个 vitest spec / 1949 用例全绿；typecheck、lint 全绿；CI 三平台 verify 全绿
- 证据级别：✅ = 本次已逐行复核；其余为代码证据（给出文件:行号，未做运行时复现）
- 本文只列问题与整改方案，未改动任何代码

## 一、结论摘要

| 级别 | 数量 | 含义 |
|---|---|---|
| P0 | 5 | 数据损坏/安全边界击穿/主流程卡死，必须立即修 |
| P1 | 33 | 明确缺陷、资源泄漏、性能瓶颈、发布与测试缺口，本迭代内修 |
| P2 | 20 | 可维护性、一致性、体验优化，排期清理 |
| 已达标 | 12 项 | 见第八章，避免重复返工 |

总体判断：**安全边界整体设计正确（contextIsolation + sandbox + preload 白名单 + 对话框会话校验），但 IPC 入参的"最后一厘米"校验缺失**；主进程链路的异常兜底存在多处"只记日志不落状态"的半成品；渲染层功能完整但缺少防抖、产物失效与失败兜底；工程侧最大债务是 **12 份零引用类型副本 + 测试未纳入类型检查**。

## 二、P0（立即修复，阻断交付）

### SEC-01 项目 id 未校验，可路径穿越读写任意 project.json ✅
- 证据：`src/main/core/projectStore.ts:34-40`（`getProjectDir` 直接 `path.join(userDataPath, id)`）；`src/main/ipc/project.ts:20-26` 原样透传渲染层 id
- 影响：id 传 `../..` 可读写数据根之外的文件；`delete` 可删除任意目录（受限于 fs.rm 语义）或覆盖任意 project.json
- 整改：所有入口统一 `assertProjectId(id)`（`/^p_[0-9a-z_-]{4,40}$/`），`getProjectDir` 内做 `resolve` 后校验仍在 `userDataPath` 之下
- 验收：新增单测覆盖 `../`、绝对路径、含盘符 `C:\`、URL 编码四类输入

### SEC-02 fileDelete 可删除数据根内任意单个文件 ✅
- 证据：`src/main/ipc/fileShell.ts:39-45`（仅拦截 `abs === DATA_ROOT_RESOLVED`，随后直接 `fs.rm(abs,{force:true})`）
- 影响：`projects/<id>/project.json`、素材、日志等任意单文件可被渲染层删除；传 `projects` 目录因未加 `recursive` 会抛 EISDIR（目录未被清空，但单文件删除足以毁掉项目）
- 整改：白名单化——仅允许删除"项目产物文件"（路径必须匹配 `projects/<id>/(shots|scenes|audio|final_*|temp)/...`），拒绝任何名为 `project.json`、`settings.json` 及目录路径
- 验收：单测覆盖 `project.json`、`projects`、``、`../`、正常产物文件五类

### CORE-01 磁盘预检抛错逃逸，镜头永久停在 rendering ✅
- 证据：`src/main/core/taskQueue.ts:684-701`（先置 `status='rendering'` 并落盘，693/699 的 throw 位于 708 的主 try 之外）；`taskQueue.ts:458-465` 仅 `log.error` 不置 failed
- 影响：磁盘 <0.5GB 时镜头状态永久 `rendering`，队列看似空闲但项目状态错乱，用户只能重建
- 整改：把预检并入主 try；catch 内 `status='failed'` + 错误原因写入 shot，再抛出；或在 458 的 catch 里统一 `markShotFailed(task, e)`
- 验收：mock `fs.statfs` 返回 0.2GB，断言 shot.status==='failed' 且 error 字段有值

### CORE-02 done 状态不校验产物，假成功可进成片 ✅
- 证据：`src/main/core/taskQueue.ts:1329-1339`（copyFile 失败被吞）；`src/main/core/comfyuiClient.ts:431-439`（下载不校验 0 字节）
- 影响：成片拼接引用缺失/0 字节文件，最终视频缺镜或合成失败，且 UI 显示已完成
- 整改：置 done 前统一 `stat` 产物并校验文件大小 >0（视频再加 ffprobe 时长校验），失败则 failed
- 验收：单测模拟 0 字节产物与 copy 抛错，断言不进 done

### STAGE-01 重跑分镜整体替换 shots/sceneBoards，手工编辑与已生成产物丢失 ✅
- 证据：`src/main/core/directorStageShots.ts:646-649`（`project.shots = shots` 全量替换）；`src/main/ipc/render.ts:236`
- 影响：用户在分镜表里改过的提示词、审核通过的 `reviewed`、已生成的 `firstFramePath/segmentPath` 在重跑该阶段时全部丢失（若 UI 无二次确认，属静默数据丢失）
- 整改：重跑时按 `shot.id`/`index` 合并：保留用户编辑字段与已 done 产物路径，只刷新 LLM 新产出的字段；确实要整体重建则加显式二次确认与快照备份
- 验收：构造 3 镜项目（含 reviewed + 产物路径），重跑后断言这些字段仍在

## 三、P1 · 安全与 IPC（9 项）

### SEC-03 启动命令可被渲染层改写，形成任意程序执行 ✅
- 证据：`src/main/ipc/comfy.ts:54-57`、`src/main/core/comfyuiClient.ts:134-167`（仅校验 argv[0] 为存在的绝对文件）；`src/main/ipc/settings.ts:31-35`（`settings:save` 只做字符串检查）
- 影响：渲染层一旦被远程内容/XSS 击穿，可把启动命令改成 `cmd.exe` 执行任意命令
- 整改：主进程维护允许清单（python.exe + main.py 特征、禁止 cmd/powershell/wscript/curl 等解释器），路径必须在用户配置的 ComfyUI 目录内

### SEC-04 API Key 明文回传渲染层 ✅
- 证据：`src/main/ipc/settings.ts:30`（safeStorage 解密后直接返回）；`LlmSection.vue:8` 直接绑定
- 影响：密钥进入渲染进程内存与 Vue devtools/日志，任意渲染层代码可读
- 整改：`settings:get` 只回 `{ hasKey: true, masked: '****abcd' }`；保存时用「未修改则沿用旧值」协议

### SEC-05 错误原文跨 IPC 外泄 ✅
- 证据：`src/main/ipc/shared.ts:92-96`、`src/main/core/childProcessManager.ts:150`、`src/main/core/ffmpegService.ts:1080-1081`
- 影响：绝对路径、完整 argv、stderr 回传 UI 并可能进日志导出包
- 整改：跨 IPC 错误统一 `sanitizeError`（DATA_ROOT→`<DATA_ROOT>`、截断 500 字、移除密钥样式串）

### SEC-06 SSRF 重定向未复查 ✅
- 证据：`src/main/core/conversationToolsNetwork.ts:39-52`（仅首跳 hostname 校验，注释自述未覆盖重定向）
- 影响：经 302 可访问内网/本机敏感服务
- 整改：`maxRedirects:0`，或每跳复检 `isBlockedFetchHost`

### SEC-07 CSP connect-src 过宽 ✅
- 证据：`src/renderer/index.html:9`（放开任意 `ws:/wss:/https:`）
- 影响：渲染层可向任意主机外发数据，削弱 CSP 兜底
- 整改：`connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*`，dev 通过独立模板注入 HMR 源

### SEC-08 未注册权限请求处理器 ✅
- 证据：`src/main/index.ts:140-155`
- 影响：摄像头/麦克风/通知等权限请求走默认放行
- 整改：`setPermissionRequestHandler` 全拒（通知已由主进程 Notification 实现）

### SEC-09 app-file 协议开启 bypassCSP ✅
- 证据：`src/main/index.ts:96-108`
- 影响：本地文件协议绕过 CSP，与 SEC-07 叠加放大风险
- 整改：保留 `stream:true`，去掉 `bypassCSP`（路径校验已在 `shared.ts:34-51`）

### SEC-10 exportLogs 可写任意内容/任意子路径 ✅
- 证据：`src/main/ipc/render.ts:247-253`
- 影响：payload.content 原样写 `projects/<projectId>/logs-*.txt`，可写超大内容、可借 projectId 穿越
- 整改：先 `assertProjectId` + `store.get` 校验存在，内容限 5MB 并过滤控制字符

### SEC-11 ComfyUI 停止误杀其它进程 ✅
- 证据：`src/main/core/comfyuiClient.ts:191-207`（PowerShell 匹配所有 `python main.py --port 8188`）
- 影响：会杀掉用户其它窗口的 ComfyUI/同参进程
- 整改：优先 kill 记录的 `launchedPid`，命令行匹配仅作兜底并要求端口归属校验

## 四、P1 · 主进程链路（12 项）

### CORE-03 串台检测正则 lastIndex 复用，命中后漏检 ✅
- 证据：`src/main/core/llmPostProcess.ts:48,135-139`（`gi` 正则跨字段重复 `exec`，不清 `lastIndex`）
- 影响：一旦前一字段命中，后一字段可能从残余 lastIndex 起搜而漏判——正好漏掉"跨项目串台"这类高危漂移
- 整改：每个字段执行前 `CROSS_RE.lastIndex = 0`，或改用非全局正则 + `test`
- 验收：单测两字段同时含串台词，断言两处都能检

### CORE-04 patchShot 用 `??` 无法清空字段 ✅
- 证据：`src/main/core/taskQueue.ts:581-583`；`src/main/core/taskQueueAudio.ts:57-60`
- 影响：想置空 `dialogue`/产物路径时被旧值回填，旧音频继续参与合轨
- 整改：白名单字段直接赋值（含 undefined），其余字段才用 `??`

### CORE-05 取消后 waitForCompletion 不 settle ✅
- 证据：`src/main/core/imageService.ts:285-298`、`src/main/core/comfyuiClient.ts:528-542`
- 影响：interrupt 后 pending 未清理，残留 5s 轮询与最长 30 分钟 timer，重试时误判在途
- 整改：取消分支调用 `rejectPending(promptId)` 并清理 timer

### CORE-06 fluent-ffmpeg run 绕过子进程管理
- 证据：`src/main/core/ffmpegService.ts:1060-1085`（不登记、无超时；对照 151-154 的受管路径）
- 影响：ffmpeg 卡死不可取消，退出应用后可能残留进程
- 整改：统一走 `childProcessManager`（登记 pid + 超时 kill）

### CORE-07 字幕阶段续跑二次烧录 ✅（逻辑已确认）
- 证据：`src/main/core/directorPipeline.ts:437-439`（from>combine 且 subtitle done 时输入取 `final_subtitled`），字幕阶段再次烧录该输入
- 影响：字幕重影/双重描边
- 整改：`fromIdx === subtitle` 时输入固定取 `final.mp4`；仅当跳过字幕阶段才用 `final_subtitled`

### CORE-08 splitScript 解析无兜底 ✅
- 证据：`src/main/core/llmScriptOps.ts:428`（`JSON.parse` 直接抛）
- 影响：LLM 输出一次不合法即整段失败，无修复重试与原始文本落盘
- 整改：复用 analyze 的「修复提示词重试 + 原文落盘 debug」机制

### CORE-09 镜头级取消只比 shotId ✅
- 证据：`src/main/core/taskQueue.ts:250`
- 影响：同号跨项目会死等/误放行
- 整改：比较 `(projectId, shotId)`，并加最大等待超时

### CORE-10 道具分配校验按首词匹配 ✅
- 证据：`src/main/core/llmPostProcess.ts:299`
- 影响：多词道具（brown paper bag）退化为 `bag` 前缀匹配，误判"已分配"
- 整改：按 propList 完整 key（含 description 主名）匹配

### CORE-11 ComfyUI 子进程日志 fd 泄漏 + 同步阻塞 ✅
- 证据：`src/main/core/comfyuiClient.ts:159`（`openSync` 后未 close）、`196-198`（`execFileSync` 最长阻塞主线程 15s）
- 整改：spawn 后关闭父进程 fd 副本；停止逻辑改 `execFile` 异步

### CORE-12 readImageSize 同步整文件读 ✅
- 证据：`src/main/core/taskQueueShared.ts:18-40`
- 影响：热路径每镜同步读整张图，只为取头部 32 字节
- 整改：`open` + `read` 固定 64KB 后关闭，异步化

## 五、P1 · 渲染层（7 项）

### UI-01 切换项目后对话发送态卡死 ✅
- 证据：`src/renderer/src/composables/useDirectorChat.ts:332-355`（scope 变化时清掉 `sendingPoll` 但未复位 `sending`）；`syncSending` 见 `sending=true` 直接 return
- 影响：新项目对话一直显示"发送中"，刷新才恢复
- 整改：`watch(chatScope)` 中复位 `sending=false` 并重建轮询
- 落地：`useDirectorChat.ts:44-54` 切换作用域时清 `sendingPoll`、复位 `sending` 并调用 `syncSending()` 重新判定新 scope；`sendMessage` 的 `finally` 增加 scope 守卫（218-224），旧 scope 收尾不再误清新 scope 发送态

### UI-02 每个进度事件全量重载项目 ✅
- 证据：`src/renderer/src/views/StoryboardView.vue:305-314`（done/failed/queued 均 `loadProject()`，无防抖）
- 影响：批量渲染收尾时连续 N 次 IPC + 整表重建，明显卡顿
- 整改：300ms 防抖合并，并按 `shotId` 只更新该行
- 落地：`StoryboardView.vue:304-312` 新增 `reloadTimer` + `scheduleReload()`（300ms 合并）；进度事件 `done/failed/queued`（322）与 `onProjectUpdated`（328-329）统一走防抖；非终态进度事件仍按 `shotId` 即时更新行状态；卸载时清理定时器（358）

### UI-03 编辑保存后旧产物未失效 ✅
- 证据：`StoryboardView.vue:436,448`（保存后 `shots[editingIndex]` 已是新 shot，旧路径丢失）
- 影响：旧音频/原片/分段成孤儿文件，磁盘持续膨胀
- 整改：用保存前的 `prev` 调 `invalidateArtifacts`
- 落地：`StoryboardView.vue:461` 改为 `const oldShot = isNew || wasPendingInsert ? undefined : prev`，保存后用保存前的 shot 作废旧音频/原片/分段

### UI-04 「清除已完成」先删文件后落盘且无 catch ✅
- 证据：`src/renderer/src/views/QueueView.vue:564-587`
- 影响：save 失败时文件已删、磁盘仍 done，刷新后指向缺失文件
- 整改：先保存成功再删文件；失败回滚并提示
- 落地：`QueueView.vue:549-623` 记录旧值 → 改内存态 → `project.save` 成功后才删产物；save 失败回滚内存态且不动磁盘文件并报错；单个产物删除失败收集后统一提示（可能被占用）

### UI-05 离开剧本页时吞掉保存失败 ✅
- 证据：`src/renderer/src/views/ScriptView.vue:262-279`（失败仍 `return true`；且先改 `project.script` 导致守卫误判无脏改动）
- 整改：失败 `return false` 保留脏态并提示
- 落地：`ScriptView.vue:262-287` 改为「先用 `script` 覆盖生成快照落盘 → 成功后才写回 `project.script`」；失败 `ElMessage.error` 并 `return false`，脏态保留、导航被拦

### UI-06 抽帧结果全分辨率 base64 进响应式状态 ✅
- 证据：`src/renderer/src/components/console/ShotRenderList.vue:279-311`
- 影响：每镜 3 张大图常驻内存，百镜级明显吃内存
- 整改：canvas 缩放到 320px 再 `toDataURL`，或写临时文件回 URL
- 落地：`ShotRenderList.vue:278-348` 按最长边 320px 等比缩放后再 `toDataURL`；新增已抽帧复用、元数据/跳转超时（8s）、`finally` 断开 video src 释放解码器

### UI-07 clearFileUrlCache 无前缀，清空全部项目缓存 ✅
- 证据：`CharacterView.vue:246-252`、`SceneBoardView.vue:246`、`PropsView.vue:231`、`StoryboardView.vue:316`
- 影响：其它项目页面缩略图立即失效重载
- 整改：按当前项目路径前缀定向清理
- 落地：`CharacterView.vue:250`、`SceneBoardView.vue:249`、`PropsView.vue:234`、`StoryboardView.vue:328` 全部改为 `clearFileUrlCache(`projects/${projectId}/`)`，只作废本项目前缀

## 六、P1 · 工程、测试、依赖与发布（7 项）

### ENG-01 12 份零引用类型副本 + ipcTypes 巨型文件 ✅
- 证据：`src/shared/project.ts`(15KB)、`director.ts`、`workflow.ts`、`settings.ts`(6.9KB)、`comfy.ts`、`conversation.ts`、`skill.ts`、`system.ts`、`memory.ts`、`genre.ts`、`ipc-api.ts`(12KB)、`ipc-channels.ts` 全仓零 import（grep 确认）；`ipcTypes.ts` 1395 行承载全部领域类型
- 影响：副本已漂移（`settings.ts` 的 AppSettings 缺 revision/creation/negatives；`ipc-channels.ts` 缺 queueList/queueSkipCurrent/directorFinished），新人极易改错文件
- 整改：删除死副本；`ipcTypes.ts` 按领域拆为 `shared/types/*.ts` 并保留 re-export；加 eslint「shared 内禁止 node 内置模块」边界（`zipArchive.ts` 引 `node:zlib`）

### ENG-02 tests 未纳入类型检查 ✅
- 证据：`tsconfig.node.json:16` exclude tests；`eslint.config.js:105-110` 对 tests 关闭 `no-explicit-any`；tests 中 125 处 any
- 影响：测试自身类型错误不阻断，mock 与真实接口漂移不可见
- 整改：新增 `tsconfig.test.json` 纳入 typecheck（any 规则可保留豁免，但类型错误必须拦）

### ENG-03 高风险模块无测试
- 证据：`src/main/ipc/` 18 个文件仅 `ipcSettings.spec` 有覆盖；`projectStore`、`comfyuiClient`（仅 pending 部分）、`directorAgent`（仅 cancelAll）、`shared/promptAuditFixes.applyAutoFixes` 无整模块 spec
- 影响：P0 的路径穿越、fileDelete 白名单、done 产物校验都没有回归护栏
- 整改：随 P0 修复同步补 spec（见各条验收）

### ENG-04 macOS 未配置签名与公证
- 证据：`electron-builder.yml:62-67` 无 hardenedRuntime/notarize/entitlements
- 影响：下载版被 Gatekeeper 拦截
- 整改：补 hardenedRuntime + entitlements + notarize（需 Apple 凭证走 CI secret）

### ENG-05 CI 缺超时、e2e 与发布步骤 ✅
- 证据：`.github/workflows/ci.yml`（无 `timeout-minutes`；`e2e/` 3 个 spec 从不执行；tag 只 `upload-artifact` 无 release publish）；`nightly.yml` 只 build + 启动指标，不跑 lint/test，失败无通知
- 整改：加 `timeout-minutes: 30`；PR 跑 e2e smoke；tag 加 `softprops/action-gh-release`；nightly 增加 lint/test 与失败通知

### ENG-06 双份 onnxruntime + @xenova 停维护
- 证据：`npm ls onnxruntime-node --all` → 顶层 1.20.1 + `@xenova/transformers@2.17.2` 内嵌 1.14.0；`faceDetector.ts` 用子进程隔离是有意设计（避免 DLOPEN 冲突）
- 影响：安装包体积翻倍、两套原生库升级耦合；@xenova 已停止维护
- 整改：评估升级 transformers.js 主线版（支持 onnxruntime 1.20+），或把 CLIP 比对改为外部服务/独立进程，最终收敛为一份 onnxruntime

### ENG-07 未使用依赖与包元数据缺失 ✅
- 证据：`unplugin-auto-import` 未在 `electron.vite.config.ts` 挂载（仅 unplugin-vue-components）；`package.json` 缺 engines/license/repository/private
- 整改：移除未用依赖；补元数据与 `engines.node >=22`

## 七、P2（排期优化，20 项）

**共享层与一致性**
1. prompt 模块 7 组重复实现（合并为单一来源）：室内/室外正则 `negatives.ts:93-96` vs `scenePrompts.ts:58-61` vs `promptSchema.ts:34`；皮肤瑕疵词 `promptConstants.ts:41-44` vs `negatives.ts:43-45` vs `castAppearance.ts:124`；发型正则 `castAppearance.ts:8/156/191`；OOC 服装词 `negatives.ts:17-23` vs `castAppearance.ts:44-58` vs `promptAuditRules.ts:46-49`；时代判定 `castAppearance.ts:113` vs `promptAuditRules.ts:41` vs `scenePrompts.ts:426`；老年词 `promptDrift.ts:11/19` vs `promptStrips.ts:44` vs `negatives.ts:134`；拼音包装 `llmParsers.ts:14` vs `roleBinding.ts:4`（2026-11-01 已全部收编到 `shared/promptLexicon.ts` 与 `main/core/pinyinName.ts`，见 §7.1 P2-1）
2. `PromptAuditTask` 未用 discriminated union（`ipcTypes.ts:352-366`），可构造 `scope='shot'` 而缺 id
3. `promptAuditFixes.ts:37/43/49/55` 以 `Record<string,unknown>` 写字段，拼错字段名无编译错误；`shared` 25 处 `as unknown as`
4. ComfyUI 默认地址硬编码 3 处（`settingsStore.ts:75`、`main/index.ts:208`、`comfyMcpService.ts:151`）
5. 日志目录混用：`comfyuiClient.ts:155`、`llmRequest.ts:16` 用 APPDATA 硬编码，其余用 `app.getPath('userData')`
6. 无 `.env` / 环境变量覆盖机制，代理配置全仓缺失（grep proxy 0 命中）
7. ~~tsconfig 未开 `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes`~~（2026-11-01 已开启：`tsconfig.node.json` / `tsconfig.web.json` 显式写入双旗标，`tsconfig.test.json` 经 `extends` 继承；`skipLibCheck:true` 保留，仅跳过第三方 `.d.ts` 内部实现检查，自有代码仍由三工程全量覆盖）
8. prettier 无 `--check` 门禁，`format` 仅覆盖 `src/**`（tests/scripts 未纳入）
9. `vue`/`vue-router`/`element-plus`/`icons` 在 dependencies，已被 vite 打包仍会进 asar（应移 devDependencies 或确认 electron-builder 排除）

**渲染层**
10. `ShotReviewDialog.vue:146/161/217/253` 直接改 `props.shot`，绕过父级唯一写入口
11. `StoryboardView.vue:255-266` deep watch 整个 project，每次变更 flatMap 全部产物路径并重复解析 URL
12. 图片/视频无 `@error` 兜底：`ShotTablePanel.vue:41-56`、`QueueView.vue:197`、`CharacterView.vue:82`（文件被移动后只显示破图，不落"未生成"态）
13. ~~长列表全量渲染原图缩略图：`ShotTablePanel.vue:11`、`QueueView.vue:79`（百镜时卡顿，需虚拟滚动 + 降采样）~~（2026-11-01 已落地：两表改 `el-table-v2` 行级虚拟滚动 + `file:thumbUrl` 160px 缩略图缓存，见 §7.1 P2-13）
14. 复制项目无防重入：`ProjectListView.vue:168,533-541`（连点产生多个副本）
15. 批量 AI 补写进度未按 `projectId` 过滤：`StoryboardView.vue:798-800`
16. 无焦点管理/键盘可达性设计（弹窗无焦点圈定、Esc 关闭不统一）

**主进程**
17. 调试日志每次 analyze 同步 append 全量分镜、无上限：`llmPostProcess.ts:273-281`
18. 复审阶段串行 ffprobe，百镜时明显拖慢（`directorPipeline` 复审链路，建议批量并发 2~4）
19. 全量 `JSON.parse(JSON.stringify(project))` 深拷贝在任务落盘热路径（建议按需拷贝）

**工程**
20. ~~依赖升级批次：axios 1.20→1.21、electron 44.5.1→45.2.1（major）、electron-vite 5→6（major）、typescript 5.9.3→7.0.2（major）、vue-router 4→5（major）、onnxruntime 1.20→1.31~~（2026-11-01 已落地：axios 1.21.0、electron 45.2.1、electron-vite 6.0.0、typescript **6.0.3**（TS 7.0.2 无公开 compiler API，vue-tsc 不可用）、vue-router 5.4.0、onnxruntime-node 1.31.1；vue-tsc 保持 3.3.12，见 §9.2 P2-20）

### 7.1 状态台账（2026-11-01 复核）

| 编号 | 结论 | 落地证据 / 未闭环原因 |
|---|---|---|
| P2-1 | ✅ | 新增词表单一来源 `src/shared/promptLexicon.ts`（叶子模块，仅词表/正则）：室内外空间、皮肤瑕疵、发型、OOC 服装、时代流派、老年身份六组词表集中维护，`negatives` / `scenePrompts` / `castAppearance` / `promptDrift` / `promptStrips` / `promptAuditRules` / `promptSchema` / `promptConstants` 全部改为引用，三处室内外正则与三处皮肤词表不再各自复制；拼音适配抽为 `src/main/core/pinyinName.ts`，`llmParsers` 与 `roleBinding` 共用。`PERIOD_CUE_RE` 由流派词表派生，顺带对齐 `玄幻`/`穿越` 的时代线索（此前体检漏判这两类古风题材）；`scenePrompts` 两处 `/民国/` 判定也收敛为 `REPUBLICAN_GENRE_RE`（民国时代锁继续单独走 1930 年代模板，语义不变）。三工程 typecheck、lint、2039 用例、build 全绿 |
| P2-2 | ✅ | `PromptAuditTask` 改为 `scope` 判别联合（shot/character/sceneBoard/prop 四个子接口），四个构造点与六个消费点全部收窄，`npm run typecheck` 通过 |
| P2-3 | ✅ | `promptAuditFixes` 用 `TextFieldOf<T>` + `satisfies` 生成字段白名单，`assignField` 只写白名单字段，越界字段（`status`/`seed`）返回 false；新增单测 |
| P2-4 | ✅ | ComfyUI 默认地址收敛到 `shared/comfyDefaults.ts::DEFAULT_COMFY_BASE_URL`，`settingsStore` / `main/index.ts` / `comfyMcpService` 均引用常量 |
| P2-5 | ✅ | 新增 `main/core/appPaths.ts` 统一 `userDataDir()` / `logsDir()`，`comfyuiClient`、`llmRequest`、`llmAudit` 不再直接读 `process.env.APPDATA` |
| P2-6 | ✅ | `llmRequest` 新增 `llmApiKey` / `llmBaseUrl`（`DS_LLM_API_KEY` / `DS_LLM_BASE_URL` 仅请求期生效、不写回 settings.json），并同步改造 `llmHttp`（3 个函数）、`llmAudit`、`selfCheckService`、`conversationToolsMemory`；代理由 axios 1.x 内置 `proxy-from-env` 接管（`HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`） |
| P2-7 | ✅ | 双旗标已固化：`tsconfig.node.json` / `tsconfig.web.json` 开启 `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`，`tsconfig.test.json` 经 `extends` 继承。node（`tsc`）、web（`vue-tsc`）、test 三工程均 **0 error**。修复策略：①落盘 JSON 模型（`Shot`/`SceneBoard`/`PropAsset`/`Character`/`GeneratedShot`/`AnalyzedShot`/`AnalyzedCharacter`/`AnalyzeScene`/`AnalyzeResult`/`PromptBulkFill*`）可选字段统一 `?: T \| undefined`，兼容 JSON 缺省 ≡ undefined 与整对象回写时显式清空；②内部 Options/Host/Ctx 接口（`ImageGenerateOptions`/`CloneOptions`/`FillPromptContext`/`shotFramePrompt` opts/`ConversationToolsHost`/`DirectorStartInput`/`PromptSchemaOptions`/`NarrativeShotLike`/`StoryboardPromptShot`）同样允许显式 `undefined`；③外部库与非持久化对象（axios `AxiosRequestConfig.signal` 等）用条件展开；④确需移除键时用 `delete`；⑤数值数组下标先受检再读，不用 `!` 批量消警 |
| P2-8 | ✅ | `.prettierrc.json` 对齐项目实际风格（`semi:false`、`printWidth:120`）；新增 `format:check` 与 `lint-staged`，husky 只格式化暂存文件（全仓 180+ 文件尚未合口径，不做整仓重排） |
| P2-9 | ✅ | `vue`/`vue-router`/`element-plus`/`@element-plus/icons-vue` 已移入 `devDependencies`，asar 不再重复打包 |
| P2-10 | ✅ | `ShotReviewDialog` 取消直接改 `props.shot`，全部走 `emit('update-review', …)`；`vue/no-mutating-props` 保持 error |
| P2-11 | ✅ | `StoryboardView` 的 deep watch 改为 `watch(shotAssetPathsToWarm)`（按去重后的路径集合触发），配合 `ensureFileUrls` 缓存，不再每次变更重复 flatMap + 解析 |
| P2-12 | ✅ | `ShotTablePanel`、`QueueView`、`CharacterView`、`ResultView` 图片/视频均补 `@error` 兜底（失效即作废缓存并落“未生成”态） |
| P2-13 | ✅ | 两张长表改 `el-table-v2` 行级虚拟滚动（只渲染视口行），列表缩略图走新增 `file:thumbUrl`（主进程 160px JPEG 降采样 + 按源 mtime 缓存 + `thumb-cache` 上限淘汰），不再同时解码原图；`el-table-v2` 无内置 selection，多选/全选/行高亮/拖拽排序在 `ShotTablePanel` 自管（id 集合 + `rowClass` + `rowkey` 反查），右键菜单改 `rowEventHandlers`；表高由页面竖向 flex 链撑满主区剩余高度（不再用 `calc(100vh - Npx)`）。三工程 typecheck、lint（0 warning）、2039 用例、build 全绿 |
| P2-14 | ✅ | `ProjectListView` 新增 `duplicatingId` 防重入 + 按钮 loading/禁用，连点不再产生多个副本 |
| P2-15 | ✅ | 批量 AI 补写进度回调校验 `e.projectId !== projectId` 直接丢弃，切项目不串进度 |
| P2-16 | ✅ | `ContextMenu` 补 `role="menu"/menuitem`、打开即聚焦、ArrowUp/Down 循环、Enter/Space 派发、Esc 关闭并归还焦点；`ShotReviewDialog` 的 Enter/Arrow 不再抢占输入框/按钮 |
| P2-17 | ✅ | `llmPostProcess` 调试日志加 2MB 上限，超限清空后再 append，长跑不再无限膨胀 |
| P2-18 | ✅ | `directorPipeline` 复审阶段 ffprobe 改 3 路并发，长集不再线性放大等待 |
| P2-19 | ✅ | 任务落盘热路径已无全量 `JSON.parse(JSON.stringify(project))`（仅保留在 `promptAuditFixes` 的非热路径纯函数里） |
| P2-20 | ✅ | 依赖六项全部升级：`axios` 1.21.0、`electron` 45.2.1、`electron-vite` 6.0.0、`typescript` 6.0.3、`vue-router` 5.4.0、`onnxruntime-node` 1.31.1（均 `--save-exact` 固定）。TypeScript 7.0.2 为 Go 原生移植版、不提供公开 compiler API，Vue 工具链（vue-tsc）无法工作，故停在保留 JS 编译器 API 的 6.0.3；`vue-tsc` 保持 3.3.12（3.3.14 对非 Ref 对象绑定生成 `.value` 访问，模板报 12 处 `TS2339`）。Electron 45 唯一 breaking change（沙箱 preload 移除 `Buffer`/`setImmediate`/`events`/`timers`/`url` shim）不影响本项目（preload 仅用 `electron` + `JSON`）；vue-router 5 在未用 `unplugin-vue-router` 的项目零 breaking change。三工程 typecheck、lint（0 warning）、2039 用例、build、e2e acceptance 全绿；`onnxruntime-node` 1.31.1 原生会话实跑通过 |

**统计**：✅ 20 项（P2-1/2/3/4/5/6/7/8/9/10/11/12/13/14/15/16/17/18/19/20），P2 清单全部闭环。

## 八、已达标（无需返工）

1. `contextIsolation:true / nodeIntegration:false / sandbox:true`（`src/main/index.ts:148-154`）
2. `setWindowOpenHandler` 全拒 + `will-navigate` 锁定（`index.ts:170-179`）
3. preload 固定通道白名单，无裸 `ipcRenderer` 暴露（`preload/index.ts:29-232`）
4. zip-slip 防护（`zipArchive.ts:46-57,198`）
5. 导出/导入目标必须来自原生对话框会话（`fileShell.ts:24-37`、`workflow.ts:14-19`）
6. API Key safeStorage 加密落盘（`settingsStore.ts:12-29`）
7. devtools/CDP 仅开发态开启（`index.ts:68-71`）
8. 项目级取消与队列收尾状态机有 finally 兜底（`taskQueue.ts:469-484`）
9. 渲染层未用 keep-alive，无缓存态残留；`useFileUrl/useRenderActivity/useTaskBoard` 监听与定时器均有卸载清理
10. 失败/取消分支测试覆盖充分（cancel/abort 285 处、rejects 247 处）
11. lockfile 与 package.json 一致
12. prompt 规范层（本轮新增）已有 27 条单测覆盖

## 九、建议整改批次与验收门槛

| 批次 | 内容 | 验收门槛 |
|---|---|---|
| 批次 1（P0 安全与数据完整性） | SEC-01、SEC-02、CORE-01、CORE-02、STAGE-01 | 新增 5 组回归 spec；typecheck/lint/test 全绿；手工场景：磁盘满、重跑分镜、fileDelete 越权 |
| 批次 2（主进程稳定性） | CORE-03 ~ CORE-12 | 每项至少 1 条 spec；取消/超时/0 字节产物三类故障注入通过 |
| 批次 3（渲染层体验） | UI-01 ~ UI-07 | 手工验收：切项目发消息、批量渲染、编辑保存、清理队列、离开保存失败 |
| 批次 4（工程债） | ENG-01 ~ ENG-07 | 删除死文件后 typecheck/build 全绿；tests 纳入 typecheck；CI 加 timeout 与 e2e smoke |
| 批次 5（P2 清理） | 第七章 20 项 | 按模块 PR 小步提交，回归全量 spec |

**建议先做批次 1**：其中 SEC-01/SEC-02 属安全边界缺口，CORE-01/CORE-02/STAGE-01 属静默数据一致性问题，修复成本低但收益最高。

### 9.1 验收记录（2026-10-31，批次 1 ~ 批次 3 已完成）

| 验证项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck`（node + web 双工程） | 通过，0 error |
| 静态检查 | `npm run lint` | 通过，0 error / 0 warning |
| 单元与集成测试 | `npm test` | 137 个 spec 文件 / 2023 个用例全绿 |
| 生产构建 | `npm run build` | main / preload / renderer 三段全部成功 |
| 交付验收 e2e | `npx playwright test --config=e2e/playwright.config.ts e2e/acceptance.spec.ts` | 1 passed（31.5s，全页面走查 + 按钮清点 + 错误采集，0 渲染层报错） |

**批次 3 关键落地点**
- UI-01：切换作用域复位 `sending` 并重建轮询，旧 scope 收尾带守卫，杜绝"新项目一直发送中"。
- UI-02：300ms 防抖合并全量重载，批量渲染 N 镜不再触发 N 次 IPC；非终态事件仍按 `shotId` 行内更新。
- UI-03：保存后用保存前 shot 作废旧录音/原片/分段，消除孤儿产物。
- UI-04：先 `project.save` 成功再删产物，失败回滚内存态并提示；单个删除失败聚合提示，不再静默。
- UI-05：离开守卫先落盘后写回内存，失败 `return false` 拦截导航并提示，改动不丢。
- UI-06：抽帧按 320px 最长边等比降采样，另加复用、8s 超时与 video 资源释放。
- UI-07：四处 `clearFileUrlCache` 改按 `projects/<id>/` 前缀定向清理，不再误伤其它项目缩略图。

**真实链路验收（E2E_REAL_CHAIN=1）**：本轮暴露并修复「analyze 阶段 error 但终态 `success=true`」假成功缺陷（`directorFinish.ts` 改为 `!wasCancelled && !doneMessage && !!state.finalPath`，`directorPipeline.ts` 所有失败分支补 `doneMessage`，新增 3 条回归断言）。真实成片产出仍受外部 LLM 账号订阅（HTTP 400 `InvalidSubscription`）阻塞，订阅恢复后需重跑该项。

**未完成（后续批次）**：ENG-03 高风险模块补测试、ENG-04 macOS 签名公证、ENG-06 双 onnxruntime 收敛。

### 9.2 验收记录（2026-11-01，批次 5 · P2 清理）

| 验证项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck`（node + web + test 三工程） | 通过，0 error |
| 静态检查 | `npm run lint` | 通过，0 error / 0 warning |
| 单元与集成测试 | `npm test` | 138 个 spec 文件 / **2039** 个用例全绿（较 9.1 新增 1 spec、16 用例） |
| 生产构建 | `npm run build` | main / preload / renderer 三段成功（依赖升级后 `✓ built in 6.05s`） |
| 交付验收 e2e | `npx playwright test --config=e2e/playwright.config.ts e2e/acceptance.spec.ts` | 1 passed（31.0s，10 页路由 + 全部可见按钮 + 弹窗/快捷键/右键菜单，0 渲染层报错） |
| 格式门禁 | `npm run format:check` | 新增脚本，按 `semi:false / printWidth:120` 口径可核查；因全仓尚未整体重排，暂不入 CI 阻塞，改由 `lint-staged` 只管暂存文件 |

**批次 5 关键落地点**
- P2-1：六组词表收归 `shared/promptLexicon.ts`（室内外空间、皮肤瑕疵、发型、OOC 服装、时代流派、老年身份），`negatives`/`scenePrompts`/`castAppearance`/`promptDrift`/`promptStrips`/`promptAuditRules`/`promptSchema` 不再各自维护副本；拼音适配由 `main/core/pinyinName.ts` 统一（`llmParsers`/`roleBinding` 共用）。语义面不变：`SUMMON_RE`/老年漂移正则/发型与皮肤清洗逐词等价，仅室内外判定与时代线索统一到较宽的一方（补齐 `地下室`/`化妆间`/`store`/`海边` 与 `玄幻`/`穿越` 等此前漏判场景），三工程 typecheck、lint、2039 用例、build 全绿。
- P2-2：`PromptAuditTask` 改判别联合，`scope` 与专属字段（`shotIndex` / `characterId` / `sceneBoardId` / `propId`）绑定，构造缺字段直接编译失败。
- P2-3：`TextFieldOf<T>` + `satisfies` 把「字段存在且为 string」前移到编译期，运行时白名单再拦一次越界写入（新增 `status`/`seed` 拒绝用例）。
- P2-6：环境变量覆盖落在唯一适配层 `llmRequest`，`llmHttp`（3 个函数）/ `llmAudit` / `selfCheckService` / `conversationToolsMemory` 全部改走 `llmApiKey`/`llmBaseUrl`，避免「只对部分请求生效 / 自检误报 key 未配置」；代理零配置（axios 1.x 内置 proxy-from-env）。
- P2-7：`noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` 落入 `tsconfig.node.json` / `tsconfig.web.json`（test 工程 `extends` 继承），原先一次开启 474 error 已全部按类型约定真实收敛为 0。核心约定：落盘 JSON 模型的可选字段统一声明 `?: T | undefined`（JSON 缺省即 undefined，整对象回写需要显式 undefined 表达「本轮清空」）；内部 Options/Host/Ctx 接口同样允许显式 undefined；仅第三方库类型与不落盘对象用条件展开；确需移除键用 `delete`；定长元组/受检下标替代批量 `!`。语义零变更——`projectStore.duplicate` 的产物重置、`conversationToolsDirector` 的显式传参、`llmScriptOps` 的归一化输出对象形状均按原样保留，2039 用例全绿。
- P2-8：Prettier 口径对齐实际代码风格，`lint-staged` 只格式化本次暂存文件，避免一次性 180+ 文件重排污染 diff。
- P2-16：`ContextMenu` 补齐菜单语义 + 焦点还原 + 方向键/回车/Esc；`ShotReviewDialog` 快捷键让位于输入控件与按钮。
- P2-13：`ShotTablePanel` / `QueueView` 改 `el-table-v2` 行级虚拟滚动（`el-auto-resizer` 定高宿主，只渲染视口 ± cache 行）；缩略图新增 `file:thumbUrl` 链路（`nativeImage.createThumbnailFromPath` 失败回落 `createFromPath().resize()` → 160px JPEG 78 质量 → `thumb-cache/<sha1(abs|mtime|size)>.jpg`，按 mtime 超 500 条淘汰到 400），渲染层 `ensureThumbUrl` 并发合并 + `invalidateFileUrl` 同生共死；多选/全选/行高亮/拖拽排序在 `el-table-v2` 之上自管（`id` 集合 + `rowClass` + `rowkey` 反查目标行），右键菜单与行点击经 `rowEventHandlers`；`theme.css` 为 `.el-table-v2` 补齐同一套玻璃变量。表高不再用 `calc(100vh - Npx)`：分镜页/队列页根节点竖向 flex + `height:100%`，`.table-shell` 与表宿主逐级 `flex:1`（矮窗口保底 320px / 280px）；Electron 1400×900 窗口实测宿主高 485px / 491px、80 行数据只渲染 9 行、主区 `scrollHeight === clientHeight`（无外层滚动、无多余留白）。行为面不变：列展示顺序、右键菜单项、批量操作条、渲染中锁定、10s 失败重试窗口均保持原口径。
- P2-20：六项依赖升级落地（`--save-exact` 固定）——`axios` 1.21.0、`electron` 45.2.1（Chromium 156 / V8 15.6 / Node 24.22）、`electron-vite` 6.0.0（peer `vite ^6|^7|^8`，项目 vite 7.x 满足）、`typescript` 6.0.3、`vue-router` 5.4.0、`onnxruntime-node` 1.31.1。**两处「升不上去」的真实原因**：①TypeScript 7.0.2 是 Go 原生移植版且不提供公开 compiler API，`vue-tsc` 无法工作，故停在保留 JS 编译器 API 的 6.0.3；②`vue-tsc` 3.3.14 存在模板回归——对 `useInputMemory()` 返回的普通对象（非 Ref）在模板中生成 `.value` 访问，`ComfyuiSection.vue`/`LlmSection.vue` 报 12 处 `TS2339`，且用 TS 5.9.3 复现证明与 TS 版本无关，故保持 3.3.12。**兼容性核查**：Electron 45 唯一 breaking change 是沙箱 preload 不再注入 `Buffer`/`setImmediate`/`clearImmediate` 与 `events`/`timers`/`url` 模块 shim，本项目 `preload/index.ts` 仅 import `electron` 与 `JSON`，不受影响；vue-router 5 在未使用 `unplugin-vue-router` 的项目无 breaking change。**onnxruntime 验证**：`require('onnxruntime-node')` 报 `{"common":"1.31.1","node":"1.31.1"}`，并用 Electron-as-node 用真实 YuNet 模型（232,589 字节）创建 `InferenceSession` 成功（`SESSION_OK … cls_8,cls_16,cls_32,obj_8,obj_16,obj_32,bbox_8,bbox_16,bbox_32,kps_8,kps_16,kps_32`）；未加 overrides 强行覆盖 transformers 的锁版本（`@huggingface/transformers@3.8.1` 精确锁 `onnxruntime-node:1.21.0`），代价是 `node_modules/onnxruntime-node/bin` 293.3MB + 嵌套副本 207.8MB 的双份原生库（`electron-builder.yml` 注释与 `asarUnpack` 已同步修正）。四门禁 + e2e acceptance（`1 passed`）全绿。

**未闭环（外部依赖或独立排期）**
- TypeScript 7 迁移：受 Vue 工具链（`vue-tsc` 依赖公开 compiler API）阻塞，需等 TS 7 开放 API 或 Vue 官方迁移方案，本轮停在 6.0.3。
- onnxruntime 单副本收敛：`@huggingface/transformers@3.8.1` 精确锁 `onnxruntime-node@1.21.0`，与顶层 1.31.1 形成双份原生库（约 501MB，win32/x64 单平台约 66MB 计入安装包）；收敛需等 transformers 4.x 升级窗口并用真实 CLIP 模型回归。
- 外部依赖项未变：Apple 签名公证、真实 GPU/LLM 订阅下的完整成片、远端 CI 实跑、真实 CLIP 模型下载推理。
