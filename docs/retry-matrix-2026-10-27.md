# 重试策略矩阵（2026-10-27）

本文件盘点 drama-studio 主进程所有「可重试错误」的现有策略，作为后续稳定性增强的基线。
数据来源：`src/main/core/` 下 llmHttp / comfyuiClient / taskQueue / ttsService / ffmpegService / errorClassify。

## 矩阵

| 错误类型 | 来源 | 可重试？ | 最大次数 | 退避策略 | 直接 fail 的条件 |
|---|---|---|---|---|---|
| LLM HTTP 429/5xx | `llmHttp.ts:145-172` | 是 | 2 次（共 3 次尝试） | 指数退避 300ms → 600ms（`300 * 2^(attempt-1)`） | 非 429/5xx 状态码、3 次后仍失败 |
| LLM HTTP 400/422（thinking 参数不支持） | `llmHttp.ts:156-165` | 是（1 次降级） | 1 次 | 无退避，立即去掉 `thinking` 字段重试 | 降级后仍 400/422 |
| LLM 超时（axios timeout） | `llmHttp.ts` | 否（归入不可分类） | — | — | 直接抛错（外层 withTransientRetry 可能再兜） |
| LLM 返回空 content | `llmHttp.ts:187` | 否 | — | — | 直接抛错（落盘诊断 JSON） |
| ComfyUI 节点失败（execution_error） | `comfyuiClient.ts:590-593` | 是（OOM 降档） | OOM 最多 2 次（light + tier） | 第一次减帧/步/时长；第二次降 VRAM 档位 | 非 OOM 错误直接 throw |
| ComfyUI 超时（waitForCompletion） | `comfyuiClient.ts:519-522` | 是（瞬时重试） | 2 次（`transientRetries`） | 线性 4s → 8s（`transientRetries * 4000`），分片轮询取消标志 | 非瞬时错误、OOM 已降档、r2v 已回退 |
| ComfyUI WebSocket 断线 | `comfyuiClient.ts:463-471, 597-603` | 是（自动重连） | 无限 | 固定 5s 后 `scheduleReconnect` | `disposed=true`（主动断开/setBaseUrl） |
| ComfyUI 连接断（axios ECONNREFUSED） | `errorClassify.ts:10` | 是（瞬时重试） | 2 次 | 线性 4s → 8s | 非瞬时错误 |
| ComfyUI OOM | `errorClassify.ts:41-45` + `taskQueueRetry.ts` | 是（降档） | 2 级（light → tier） | 无退避，先 interrupt 再改参数重渲 | 已到最低档（low） |
| ComfyUI H3 r2v 口型失败（auto 路线） | `taskQueueRetry.ts` | 是（路线回退） | 1 次 | 无退避，切 h3-i2v + LatentSync | 已在 i2v 路线 |
| ffmpeg 非零退出（fluent-ffmpeg `run()`） | `ffmpegService.ts:1075-1080` | 否 | — | — | 直接 reject（带 stderr 末尾 12 行） |
| ffmpeg execFile 超时 | `childProcessManager.ts`（原 `ffmpegService.runFfmpeg`） | 否 | — | 10 分钟硬超时 kill | 超时即失败 |
| ffmpeg concat 流拷贝失败 | `ffmpegService.ts:530-553` | 是（回退重编码） | 1 次 | 无退避，自动切 concat filter | 重编码也失败 |
| TTS Edge 普通错误 | `ttsService.ts:93-104` | 是 | 2 次（共 3 次） | 固定 2.5s 退避 | 3 次后切本机 TTS |
| TTS Edge 风控 403/429 | `ttsService.ts:91-103` | 是 | 2 次（共 3 次） | 固定 15s 长退避（等风控窗口） | 3 次后切本机 TTS |
| TTS Qwen 克隆轮询超时 | `ttsService.ts:164-182, 340-359` | 否 | — | 600s 硬超时（1.5s 轮询） | 超时即失败 |
| TTS SAPI 兜底 | `ttsService.ts:195-215` | 否 | — | 60s 硬超时 | 失败即抛（最终抛 TTSRateLimitedError） |
| 导演阶段瞬时错误 | `directorPipeline.ts` `withTransientRetryImpl` | 是 | 可配置（默认 2） | 固定 400ms 间隔（`setTimeout(r, 200)` 分片检查取消） | 非瞬时错误、取消标志 |
| 导演 C 自愈（selfHealStage） | `directorPipeline.ts` `selfHealStageImpl` | 是 | 每项目每次流水线 1 次预算 | 无退避 | 预算耗尽 |
| 一致性检查失败（consistency gate） | `taskQueueConsistency.ts` | 是（兜底重渲） | 1 次 | 无退避，切引擎或换 seed 重渲 | 重渲仍低 → 标 lowConsistency 放行 |
| 抽卡候选失败（多 seed 渲染） | `taskQueue.ts:1137-1146` | 否 | — | — | 单个候选失败跳过，不影响主分段 |

## 关键发现与修复

### 已修复（本轮 P2）

1. **子进程超时无统一登记**：原 ffmpeg/tts 各自 execFile，崩溃后孤儿进程无法追溯。
   - 新增 `childProcessManager.ts`：统一登记 Map、自动 timeout kill、stdout/stderr 落盘到 `userData/logs/child-process-{pid}.log`、`killAll(reason)` 批量 kill。
   - 已接入：ffmpegService（runFfmpeg/canRun/probe/silencedetect）、ttsService（sapiSpeak/wavToMp3）。
   - ComfyUI spawn 保留原样（detached + taskkill /T /F 有独立生命周期）。

2. **崩溃后临时文件残留**：ffmpeg `*.part.mp4`、拼接 `concatfit_*` / `smartconcat_*`、RGB24 裸帧、qc_*.png 等崩溃时留在盘。
   - `taskQueue.recoverStaleRenders()` 启动时自动清理（`cleanupOrphanTmp()`）。

### 设计原则

- **瞬时错误才自动重试**：网络抖动/超时/5xx → 退避重试；参数错误/缺模型/内容拦截 → 直接 fail 交人工。
- **每类重试独立预算**：OOM 降档、瞬时重试、r2v 回退、抽卡候选互不挤占（见 `taskQueueRetry.decideRetryAction`）。
- **退避必须可取消**：长退避用分片 `setTimeout(200ms)` 轮询取消标志，避免 cancel 后还等满 8s。
- **OOM 不重试原参数**：先 `interrupt()` 再减帧/降档，否则旧 prompt 仍在跑、新提交双份浪费显存。

### 后续可优化（本轮未做）

- LLM 空 content 目前直接 fail，可考虑 1 次重试（某些 provider 偶发空响应）。
- ffmpeg execFile 失败后可按错误码区分（输入文件损坏 vs 合成中断），但当前调用方均不区分，收益有限。
