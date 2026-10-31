# 任务清单 — 时间轴提示词 + 转场硬切 + 验证

> **状态说明（2026-10-31）**：T0~T2 代码项已完成（见下）；T3~T5 为真实重渲与证据归集，
> 依赖 ComfyUI + GPU，执行步骤与当前结论见
> [render-and-pano-verification-2026-10-31.md](file:///e:/drama-studio/docs/audit/render-and-pano-verification-2026-10-31.md)。

## 阶段 0：材料核对（编辑前必读）
- [x] T0.1 完整读 [imagePrompts.ts](file:///e:/drama-studio/src/shared/imagePrompts.ts)：CINEMATIC_QUALITY_BLOCK、VIDEO_NEGATIVE_DIRECTIVES（L53-68）、sanitizeCinematicPrompt（L512 起）、videoMotionPrompt（L397 起），确认新块在 sanitize 后拼接可存活
- [x] T0.2 确认 wan 分支可拿到秒数（wanDurationSec 作用域可达 L945-964 ✓ 初步已见；H3 传参路径：renderShot 内 h3NeedSec/h3Length → buildH3Prompt）
- [x] T0.3 读 llmService.ts L590-700 分镜规范，确认 transition 条款现状，决定补充原文

## 阶段 1：提示词层
- [x] T1.1 imagePrompts.ts 新增 `timelineProtocolBlock(opts: { sec:number; fps:number; transition?:string; firstFrameEn?:string; midFrameEn?:string; lastFrameEn?:string; motionEn?:string }): string`，按 spec §2.1 实现（MID/END 时间戳自动计算，缺字段按优先级回落）
- [x] T1.2 VIDEO_NEGATIVE_DIRECTIVES 追加 7 个帧稳定/转场禁词（spec §2.2）
- [x] T1.3 taskQueue.buildH3Prompt 增加 sec 入参；空镜/人物镜统一在 finalMotion（已 sanitize）之后拼协议块（fps=24）；tablewareLock 仅 i2v 人物镜附加
- [x] T1.4 taskQueue wan 分支 prompt 组装：sanitize 后拼协议块（fps=16, sec=wanDurationSec）
- [x] T1.5 llmService 分镜规范补 transition 默认 hard 条款（如现状缺）

## 阶段 2：合成与参数链
- [x] T2.1 ffmpegService.fadeAt 改为仅 dissolve 叠化，其余硬切；更新注释
- [x] T2.2 taskQueue L669-679 规范化后回写 frameSeconds=finalSec
- [x] T2.3 H3 vars WIDTH/HEIGHT 按 shot 朝向交换 tier 值（横屏 864×480），编辑前确认 H3 工作流尺寸节点接受该网格

## 阶段 3：测试数据（仅 p_1792109110654_gaov）
- [ ] T3.1 通过 CDP/window.api 给两镜写入 spec §2.4 的 promptEn/firstFrameEn/midFrameEn/lastFrameEn/negativeEn，transition='hard'，frameSeconds=4、frames=65，width=720 height=480
- [ ] T3.2 typecheck 相关文件无新增错误（存量 83 错误不动）；GetDiagnostics 确认改动文件无红线

## 阶段 4：重渲与量化验证
- [ ] T4.1 重启/复用 Electron 使代码生效，重新渲染两镜（render.start，等待 done，记录耗时）
- [ ] T4.2 ComfyUI /history 抓实际提交的完整 PROMPT 原文（两镜），核对 TIMELINE PROTOCOL/LENGTH=107/864×480
- [ ] T4.3 ffprobe：raw fps=24/107 帧（17k+5）/4.46s±0.02；segments 25fps；分辨率朝向；project.json frameSeconds/frames/renderProfile 同步
- [ ] T4.4 每镜 0/1/2/3/4s 抽帧 + 相邻帧 SSIM/MAE 量化 + 末 0.4s settle 验证；产出 contact sheet
- [ ] T4.5 重新合成成片：切点 ±3 帧抽帧验证硬切无鬼影；总时长 = 两裁剪段之和；输出 final mp4
- [ ] T4.6 若 T4.4 发现模型侧残余抖动（与提示词/合成无关），如实记录，不扩大修改范围

## 阶段 5：交付
- [ ] T5.1 报告 `docs/audit/render-fix-2026-10-16.md`：问题标注表、完整 PROMPT 原文、ffprobe/SSIM/抽帧证据、残余风险
- [ ] T5.2 证据归集 `docs/audit/render-fix-2026-10-16/`（raw/segments/final/contact sheet/边界帧）
- [ ] T5.3 %TEMP% 临时脚本删除；向用户汇报结论与 computer:// 链接
