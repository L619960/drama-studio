# 本地 AI 短剧工坊 (drama-studio)

基于 Electron + Vue 3 + ComfyUI 的本地短剧全自动生产工坊：剧本 → 拆镜 → 渲染 → 字幕 → 成片。

## 快速开始

### 1. 环境准备

- Node.js 18+
- ComfyUI 本地服务（默认 `http://127.0.0.1:8188`，可在应用设置中修改）
- NVIDIA GPU（推荐 ≥12GB 显存；H3 引擎需 ≥16GB）

### 2. 安装与启动

```bash
npm install
npm run dev          # 开发模式
npm run typecheck    # 类型检查
npm run lint         # ESLint（0 warning 基线）
npm run test         # Vitest 单测
npm run test:e2e     # Playwright 窗口 smoke
npm run build:win    # 打包 Windows 安装包
```

### 3. ComfyUI 模型部署

参考 `docs/model-download-2026-10-27.md` 的「H3 主链路」章节，按目录放置以下模型：

| 模型文件 | 大小 | ComfyUI 路径 |
|---|---|---|
| fl2va_pruned_int8 | 19.53G | models/... |
| ref2va_pruned_int8 | 19.53G | models/... |
| video_vae_int8 | 2.62G | models/... |
| audio_vae_fp32 | 0.56G | models/... |
| qwen3vl_32b_nvfp4_awq | 14.61G | models/... |

工作流模板已预置在 `workflows/`，应用启动时自动扫描并自检缺失节点/模型。

## 目录结构

```
drama-studio/
├── src/
│   ├── main/                     主进程（业务逻辑中心）
│   │   ├── index.ts              入口 + 窗口创建 + IPC 注册
│   │   ├── core/                 核心服务层（75 个模块）
│   │   │   ├── director*/        AI 导演子模块（状态机/流水线/资产/手动/完成）
│   │   │   ├── taskQueue*.ts     渲染队列（8 文件拆分：调度/重试/渲染/音频/一致性/提示词）
│   │   │   ├── conversation*/    AI 对话系统（session/service/agentLoop + 4 类 tool dispatcher）
│   │   │   ├── llm*.ts           LLM 层（HTTP/facade/后处理/审计/解析/脚本 ops/提示词）
│   │   │   ├── imageService.ts   定妆/场景图生成 + face restore
│   │   │   ├── comfyuiClient.ts  ComfyUI WS 客户端
│   │   │   ├── workflowLoader.ts / workflowLibrary.ts  工作流模板加载与扫描
│   │   │   ├── ttsService.ts     Edge TTS
│   │   │   ├── lipSyncService.ts LatentSync 口型同步
│   │   │   ├── subtitleService.ts SRT 字幕生成
│   │   │   ├── ffmpegService.ts  音视频合成 + 片段拼接
│   │   │   ├── consistencyService.ts  人物外观一致性
│   │   │   ├── faceDetector.ts   人脸检测独立子进程
│   │   │   ├── candidatePickService.ts  多候选抽卡（分数/LLM）
│   │   │   ├── asyncPool.ts      有限并发映射工具
│   │   │   ├── projectStore.ts   项目 CRUD + 复制
│   │   │   ├── settingsStore.ts  设置存储 + 归一化
│   │   │   ├── memoryStore.ts    跨项目记忆库
│   │   │   ├── skillLibrary.ts / builtinSkills.ts / builtinToolSpecs.ts  技能/工具库
│   │   │   ├── childProcessManager.ts  子进程生命周期管理
│   │   │   ├── errorHandler.ts / errorClassify.ts  全局异常兜底 + 临时/持久错误分类
│   │   │   └── logger.ts         统一日志工具（createLogger 封装）
│   │   ├── ipc/                  IPC handler（17 个文件：16 个 handler + shared.ts 统一包装）
│   │   └── agent/                MCP 协议桥接
│   ├── preload/index.ts          预加载桥接（contextBridge + sandbox CJS 输出）
│   ├── renderer/src/             Vue 3 渲染层（28 组件 + 11 composables）
│   │   ├── views/                10 个页面视图
│   │   ├── components/           业务组件（console/storyboard/settings/common）
│   │   ├── composables/          组合函数（directorState/directorChat/inputMemory 等）
│   │   ├── router/               vue-router
│   │   └── main.ts               Element Plus 按需引入 + ElMessage monkeypatch
│   └── shared/                   跨进程共享层
│       ├── ipcTypes.ts           主类型 + IpcApi 契约 + SHOT_TIMING 常量
│       ├── ipc-channels.ts       IPC 通道常量枚举（单一事实源）
│       ├── ipc-api.ts            preload 桥接接口类型声明
│       ├── promptAudit.ts / promptAuditTypes.ts  AI 提示词审计 facade + 类型
│       ├── pipelineGuards.ts     流水线门禁（FFmpeg 收尾/ComfyUI 根目录/成片入选）
│       ├── imagePrompts.ts       负面提示词预设
│       └── ...                   其他共享模块（castAppearance/scenePrompts/assetReuse 等）
├── workflows/                    ComfyUI 工作流模板（h3_i2v/h3_r2v/wan22_i2v/latentsync/builtin_t2i）
├── tests/unit/                   Vitest 单元测试（92 文件 / 1597 用例）
├── e2e/                          Playwright E2E smoke 测试
├── docs/                         技术文档（含 IPC 安全清单、技术审计报告）
├── electron.vite.config.ts       三分构建配置（main/preload/renderer）+ Element Plus 按需引入 + 代码分割
├── electron-builder.yml          NSIS Windows 打包配置
├── vitest.config.ts              Vitest 配置（Node environment + v8 coverage）
├── eslint.config.js              Flat ESLint 配置（@typescript-eslint + vue）
├── husky/                        Git pre-commit 钩子（lint-staged）
└── package.json
```

## 渲染引擎智能分流

- **有台词镜头** → `minimax_h3_r2v`（音频驱动口型 + 音色，免 LatentSync）
- **无台词镜头** → `minimax_h3_i2v`（图生视频，原生环境音）
- 切换方式：全局（设置→工作流）/ 单项目（编辑 project.json `defaultWorkflow`）/ 单镜头（编辑 shot JSON `workflow`）

## 关键约束（参见 `docs/` 内技术审计与治理文档）

- LTX/Wan 视频帧数必须 25n+1（H3 不受此约束，用 17k+5 网格 @24fps）
- 关键交接动作（递接物品/开门上车/拥抱/转身离开）必须独立成镜
- 每镜只能一张可识别人脸；外观逐字取自同一份角色卡
- 镜头时长口径：`SHOT_TIMING` 常量（minSec=4 / maxSec=10 / audioLeadSec=0.4 / audioTailSec=1.2）
- 显存档位：auto / low(<8G) / mid(8-12G) / standard(12-18G) / high(18-24G) / ultra(≥24G)

## IPC 契约

渲染层通过 `window.api` 访问主进程能力，类型契约见 `src/shared/ipcTypes.ts` 中的 `IpcApi` interface。新增 IPC 通道时需同时更新 `IpcChannels` 常量与 `IpcApi` 接口。
