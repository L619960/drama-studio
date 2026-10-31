# 重渲验证与 pano 裁切跟踪（2026-10-31）

> 对应审计项 **P2-12（时间轴修复交付物）** 与 **P2-04（全景裁切构图偏差）**。
> 两项都需要真实 ComfyUI + GPU + 真实全景图，**代码侧已完成的部分**在此记录；量化证据需在具备条件的机器上按本文步骤产出。

## 一、时间轴修复（P2-12）

### 1. 已完成（代码层，已由单测覆盖）

| 项 | 位置 | 说明 |
|---|---|---|
| T1.1 时间轴协议块 | `src/shared/scenePrompts.ts:368 timelineProtocolBlock` | 首/中/尾帧时间戳 + 总时长声明 |
| T1.2 帧稳定负向词 | `src/shared/promptConstants.ts` | no in-clip cut / no freeze / no duplicated frames 等 |
| T1.3 H3 提示词接入 | `src/main/core/taskQueuePrompts.ts:189`、`taskQueue.ts:899` | 协议块在 sanitize 之后拼接 |
| T2.1 默认硬切 | `src/main/core/ffmpegService.ts:590 fadeAt` | 仅 `transition='dissolve'` 叠化，hard/smash/未指定硬切 |
| T2.2 frameSeconds 回写 | `src/main/core/taskQueueAudio.ts:177` | 规范化后 `shot.frameSeconds = finalSec` |

### 2. 未完成（需真实重渲）

T3 测试数据、T4 重渲与量化、T5 证据归集，均依赖 ComfyUI 与测试项目 `p_1792109110654_gaov`。

### 3. 执行步骤（在有 ComfyUI 的机器上）

```powershell
# 0) 构建并启动（或 dev 模式）
npm run build; npm run dev

# 1) 通过 CDP / DevTools 控制台给两镜写入测试参数
#    promptEn/firstFrameEn/midFrameEn/lastFrameEn、transition='hard'、
#    frameSeconds=4、frames=65、width=720、height=480

# 2) 单镜重渲
await window.api.render.start('<项目id>', ['<镜1>', '<镜2>'], true)

# 3) 抓 ComfyUI 实际提交的 PROMPT
#    GET http://127.0.0.1:8188/history  核对 TIMELINE PROTOCOL / LENGTH / 分辨率

# 4) ffprobe 校验（脚本可用 scripts/ 下现有工具拼接）
#    raw: 24fps / 107 帧 / 4.46s±0.02；segment: 25fps；frameSeconds 与 frames 一致

# 5) 抽帧 + SSIM：每镜 0/1/2/3/4s 抽帧，相邻帧 SSIM 下降不应出现突变
#    切点 ±3 帧抽帧验证硬切无鬼影；输出 contact sheet
```

### 4. 证据目录与报告

产出到 `docs/audit/render-fix-2026-10-16/`：`raw/`、`segments/`、`final/`、`contact-sheet.png`、`边界帧/`；
报告 `docs/audit/render-fix-2026-10-16.md` 至少包含：问题标注表、完整 PROMPT 原文、ffprobe/SSIM 表格、残余风险。

> 2026-10-31 状态：**未产出**（本机无 ComfyUI/GPU 运行态）。上表代码项已闭环，T3~T5 待执行。

## 二、pano 裁切构图（P2-04）

### 1. 问题

`ffmpegService.cropPanoramaViews` 把全景图按四方位裁切；实测 `view_0` 容易落到墙根特写（主体不在画面中心），
导致首帧构图偏、后续 i2i 参考错位。

### 2. 调参方法（需真实 pano）

1. 取 3~5 张真实全景图（不同画幅、不同主体位置），放到临时目录；
2. 用脚本单独调 `cropPanoramaViews`（不跑完整流水线）：

```powershell
# 例：对每张图输出 4 个 view，人工比对主体位置
node -e "import('./out/main/index.js')" # 或直接用 vitest 临时 case 调用 ffmpegService
```

3. 重点检查：
   - 四方位裁切的水平/垂直偏移是否按画面比例而非固定像素；
   - 相邻 view 的重叠区是否足够（避免拼回全景时出现接缝）；
   - 主体（人/门/窗）是否落在安全区（中心 60%）。
4. 调整 `cropPanoramaViews` 的偏移/重叠常量后，重新跑同一组图，记录前后样张；
5. 真实开拍验证：首帧人物是否居中、场景板是否可读。

### 3. 记录模板

| 样张 | 画幅 | view_0 主体位置（前） | view_0 主体位置（后） | 结论 |
|---|---|---|---|---|
| pano-1 |  |  |  |  |
| pano-2 |  |  |  |  |
| pano-3 |  |  |  |  |

> 2026-10-31 状态：**待真实图调参**。代码未改动，避免无样张盲调引入回归。
