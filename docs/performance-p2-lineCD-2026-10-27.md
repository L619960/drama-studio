# P2 重构 · 线 CD 交付笔记（包体积 / 启动 / 打包 / coverage / E2E）

日期：2026-10-27　范围：renderer 包体积分析、启动速度、electron-builder 配置、coverage 落地、E2E 起步。
约束：未改 `src/main/core/*.ts` 业务逻辑；改动仅限 vite 配置、electron-builder.yml、renderer 入口（非业务）、新建分析脚本与 e2e/。

---

## 1. renderer 包体积分析

### 基线（改动前）
- renderer JS：**3535.67 KB**　CSS：**454.95 KB**
- main：760.8 KB　preload：14.4 KB

### 大头（rollup-plugin-visualizer，ANALYZE=1 门控生成 out/renderer-stats.html）
按顶层包聚合（合计 3121 KB）：

| 包 | 体积 | 占比 |
|---|---|---|
| **element-plus** | **1686.7 KB** | **54.0%** |
| src 内部（views/components） | 732.8 KB | 23.5% |
| @vue/runtime-core + reactivity + dom | ~226 KB | ~7% |
| lodash-es（element-plus 拖入） | 141.0 KB | 4.5% |
| @element-plus/icons-vue | 62.0 KB | 2.0% |
| vue-router | 59.1 KB | 1.9% |
| async-validator / @floating-ui / @popperjs / dayjs 等（均 element-plus 依赖） | 各 <36 KB | — |

### 关键排查结论
- **element-plus 全量引入**：`src/renderer/src/main.ts` 原先 `import ElementPlus from 'element-plus'` + `import 'element-plus/dist/index.css'` + `app.use(ElementPlus)`，导致全部组件打进 bundle。
- **@xenova/transformers 未进 renderer**（正确）。它只在 main 进程 `consistencyService.ts` 动态 `await import()`，被 externalize。
- onnxruntime-node、msedge-tts、pinyin、fluent-ffmpeg、ffmpeg-static、ws、axios、@modelcontextprotocol **全部不在 renderer**（main 进程依赖，已正确 externalize）。
- icons 已按需命名导入（tree-shake 正常），无需处理。

### 优化动作（已实施）
- 装 `unplugin-vue-components` + `unplugin-auto-import`（auto-import 装了但未启用 vue API 自动导入，避免行为漂移；实际只挂 `Components({ resolvers:[ElementPlusResolver()] })`）。
- `electron.vite.config.ts` renderer 段加按需 resolver；`main.ts` 去掉全量 `app.use(ElementPlus)` 与全量 CSS，改为手动引入程序化组件样式（message / message-box / loading，供 confirm.ts、ConsoleView、CharacterView、PresetBar 使用）。

### 优化后
- renderer JS：**2263.93 KB**（**-1271 KB，-36%**）
- renderer CSS：**268.14 KB**（**-187 KB，-41%**）
- 截图（e2e/smoke-window.png）确认 Element Plus 组件样式渲染正常，无样式丢失。

> 后续可再压：src 内部 732 KB 里 `ShotEditDialog.vue`(40KB)、`CreationGroup.vue`(39KB)、`SettingsView.vue`(36KB) 等大组件可考虑路由级/组件级 code-split，但属业务重构，本次未动。

---

## 2. 启动速度

### 实测冷启动
- 方式：`npm run build` 后从源码 `electron .`，轮询 CDP 9222 page target。
- **进程启动 → 窗口页面就绪：约 1483 ms**（含 CDP 就绪）。
- 启动日志：SkillLibrary 在窗口出现后 ~300 ms 才加载，证实延迟启动块生效。

### main 进程初始化阻塞评估（只记录，未改）
- 模块顶层同步 `new` 了 20+ 个 service，但构造函数只存引用，无重 fs / 无模型加载。
- `settingsStore.get()` 异步 fire-and-forget。
- `app.whenReady()` 后立即 `registerIpc()` + `createWindow()`。
- **断点续渲（recoverStaleRenders）与 rules.json 预热已推迟到首绘后**（`runDeferredStartup`），不阻塞窗口。
- 结论：无明显同步阻塞；架构已是首屏优先。ComfyUI WebSocket ECONNREFUSED 是后台重连，不影响窗口。

---

## 3. electron-builder 配置检查

- ✅ **已修 bug：onnxruntime-node 未解包**。`faceDetector.ts:207` 注释写明"打包后在 app.asar.unpacked 内解析"，但原 `asarUnpack` 只解包 ffmpeg/ffprobe。onnxruntime-node 原生 `onnxruntime.dll`(14MB)/`DirectML.dll`(18MB)/`onnxruntime_binding.node` 在 asar 内无法 dlopen（ERR_DLOPEN_FAILED），打包版人脸检测/一致性比对会直接不可用（dev 走普通 node_modules 故未暴露）。已追加：
  - `node_modules/onnxruntime-node/**`
  - `node_modules/@xenova/transformers/node_modules/onnxruntime-node/**`（transformers 内嵌一份 onnxruntime）
- nsis：oneClick=false、可改安装目录、perMachine=false（per-user）、建桌面/开始菜单快捷方式——合理。未配 `deleteAppDataOnUninstall`（可选，非问题）。
- extraResources：仅分发 `workflows/*.json`，与 main/index.ts `process.resourcesPath/workflows` 读取一致；ffmpeg/ffprobe/onnx 走 node_modules asarUnpack，方式正确。
- files 白名单：`out/**` + `package.json`，生产依赖由 electron-builder 自动纳入，正确。
- ⚠️ 体积提示（未改）：onnxruntime-node 打包了全平台原生二进制（darwin/linux/win-arm64 等），而 win target 仅 x64，多余 ~50MB+ 会被打进包。后续可用 files 过滤只留 `win32/x64`，属体积优化，本次未做。

---

## 4. coverage（v8）

- `npx vitest run --coverage` 跑通（v8 provider 正常）。
- 总体（Stmts / Branch / Funcs / Lines）：
  - **Lines 24.81%　Statements 23.56%　Functions 22.13%　Branches 18.06%**
- branches 18.06% 略低于 vitest.config.ts 里上一轮设的全局阈值 20%（故 `--coverage` 以非零退出）。这是上一轮设的护栏，如实记录；本次改动不影响 node 侧覆盖率。`npm test`（不带 coverage）仍全过。
- 覆盖率最低（0%）：conversationTools 系列（toolsDirector/File/Memory/Project/Workflow）、llmAudit、llmPostProcess、llmScriptOps、taskQueueRefs、shared/imagePrompts、promptUtils。
- 极低：ffmpegService 7.6%、ttsService 2.0%、faceDetector 8.8%、taskQueueAudio 0.9%、taskQueueConsistency 0.6%（多为原生/IO 重服务，单测难覆盖）。

---

## 5. E2E 起步

- 装 `@playwright/test`，建 `e2e/`，加 script `"test:e2e": "playwright test --config=e2e/playwright.config.ts"`。
- 写了 **1 个 smoke 用例**（`e2e/smoke.spec.ts`）：`_electron.launch` 启动应用 → `firstWindow()` → 等 `#app` 挂载 → 截图 → 收集 pageerror（过滤已知 ECONNREFUSED/WebSocket 网络错误）→ 断言无致命错误。
- **实跑通过**：`1 passed (3.3s)`，窗口标题"短剧工坊 · Drama Studio"，截图 `e2e/smoke-window.png` 确认真实渲染。
- 备注：ESM 项目里 `__dirname` 不可用，已改 `fileURLToPath(import.meta.url)`。

---

## 验收

| 项 | 结果 |
|---|---|
| `npm run typecheck:web`（renderer，本次改动面） | **0 错误** ✅ |
| `npm run typecheck:node` | **71 错误，全部在上一轮新建的 `directorStateMachine.ts` / `directorProgressBridge.ts`**（访问 `DirectorAgent` private 成员），**与本次 CD 改动无关**，属上一轮重构遗留；受"不动 src/main/core"约束未改 ⚠️ |
| `npm test` | **250 passed / 30 files** ✅ |
| `npm run build`（三端） | 通过，renderer JS 2264KB / CSS 268KB ✅ |
| `npm run test:e2e` | 1 passed ✅ |

### 需要上游（core 所有者）跟进
1. `npm run typecheck:node` 71 个 private 访问错误：把 `DirectorAgent` 被外部模块函数引用的成员（store/states/waiters/settings/baseDir/logSeq 等）可见性放开或补公共访问器——这是上一轮 P0/P1 抽取重构的收尾债务，非本线引入。
