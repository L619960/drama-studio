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
npm run build:win    # 打包 Windows 安装包
```

### 3. ComfyUI 模型部署

参考项目内 `项目记忆.md` 的「MiniMax H3 本地推理」章节，按目录放置以下模型：

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
│   ├── main/            主进程（业务逻辑中心）
│   │   ├── index.ts     IPC 注册 + 入口
│   │   ├── env.d.ts
│   │   └── core/        11 个核心服务
│   │       ├── taskQueue.ts          渲染队列编排
│   │       ├── directorAgent.ts     AI 导演（剧本→成片编排器）
│   │       ├── conversationService.ts 导演对话
│   │       ├── llmService.ts         LLM 调用
│   │       ├── comfyuiClient.ts      ComfyUI 客户端 + WS
│   │       ├── workflowLoader.ts     工作流模板加载
│   │       ├── ttsService.ts         TTS（msedge-tts）
│   │       ├── lipSyncService.ts     LatentSync 口型同步
│   │       ├── subtitleService.ts    字幕生成
│   │       ├── ffmpegService.ts      音视频处理
│   │       ├── consistencyService.ts 人物一致性比对
│   │       ├── faceDetector.ts       人脸检测独立子进程
│   │       ├── imageService.ts       定妆图/场景图生成
│   │       ├── projectStore.ts       项目存储
│   │       ├── settingsStore.ts      设置存储
│   │       ├── memoryStore.ts        跨项目记忆库
│   │       ├── skillService.ts       技能管理
│   │       └── logger.ts             统一日志工具
│   ├── preload/        预加载桥接（contextBridge）
│   ├── renderer/       Vue 3 渲染层
│   │   └── src/
│   │       ├── views/                7 个页面视图
│   │       ├── composables/          组合函数
│   │       ├── router/                路由
│   │       ├── utils/
│   │       └── assets/theme.css
│   └── shared/ipcTypes.ts  共享类型 + IPC 契约 + SHOT_TIMING 常量
├── workflows/          ComfyUI 工作流模板（h3_i2v/h3_r2v/wan22_i2v/latentsync/builtin_t2i）
├── build/              应用图标
├── test/               E2E smoke 测试
├── electron.vite.config.ts
├── electron-builder.yml
├── tsconfig.json
└── package.json
```

## 渲染引擎智能分流

- **有台词镜头** → `minimax_h3_r2v`（音频驱动口型 + 音色，免 LatentSync）
- **无台词镜头** → `minimax_h3_i2v`（图生视频，原生环境音）
- 切换方式：全局（设置→工作流）/ 单项目（编辑 project.json `defaultWorkflow`）/ 单镜头（编辑 shot JSON `workflow`）

## 关键约束（参见 `项目记忆.md`）

- LTX/Wan 视频帧数必须 25n+1（H3 不受此约束，用 17k+5 网格 @24fps）
- 关键交接动作（递接物品/开门上车/拥抱/转身离开）必须独立成镜
- 每镜只能一张可识别人脸；外观逐字取自同一份角色卡
- 镜头时长口径：`SHOT_TIMING` 常量（minSec=4 / maxSec=10 / audioLeadSec=0.4 / audioTailSec=1.2）
- 显存档位：auto / low(<8G) / mid(8-12G) / standard(12-18G) / high(18-24G) / ultra(≥24G)

## IPC 契约

渲染层通过 `window.api` 访问主进程能力，类型契约见 `src/shared/ipcTypes.ts` 中的 `IpcApi` interface。新增 IPC 通道时需同时更新 `IpcChannels` 常量与 `IpcApi` 接口。
