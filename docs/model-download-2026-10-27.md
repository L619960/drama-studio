# drama-studio 模型缺口补齐报告（2026-10-27）

## 背景

上一轮一致性审计发现第 1、2 镜（跨镜位移 flf2v）因 Wan2.2 Remix 模型缺失，环境自检在渲染前 `validateBuiltGraph` 阶段报 `missing-model`。本报告记录代码引用盘点、缺口分级、下载过程与验证结果。

---

## 1. drama-studio 代码硬编码引用的模型清单

代码实际只硬编码 4 个工作流（见 `src/shared/motion.ts:86-92`、`src/main/core/taskQueue.ts:854`、`src/main/core/taskQueueRender.ts:158-170`）：

| 工作流名 | 触发条件 | 文件 |
|---|---|---|
| `wan22_remix_flf2v` | 跨镜位移且有尾帧 | `workflows/wan22_remix_flf2v.json` |
| `minimax_h3_i2v` | H3 图生视频（默认/录音/画外音/交手） | `workflows/minimax_h3_i2v.json` |
| `minimax_h3_r2v` | H3 参考图生视频（有台词，口型） | `workflows/minimax_h3_r2v.json` |
| `wan22_i2v` | wan 引擎 fallback | `workflows/wan22_i2v.json` |

### 1.1 `wan22_remix_flf2v.json` 引用的模型（第 1、2 镜用）

| 节点 | 键 | 值 | 文件:行号 |
|---|---|---|---|
| CLIPVisionLoader | clip_name | `wan2.2\clip_vision_h.safetensors` | wan22_remix_flf2v.json:40 |
| CLIPLoader | clip_name | `wan2.2\umt5_xxl_fp8_e4m3fn_scaled.safetensors` | wan22_remix_flf2v.json:276 |
| LoraLoaderModelOnly | lora_name | `wan2.2\Wan2.2-Fun-A14B-InP-low-noise-HPS2.1.safetensors` | wan22_remix_flf2v.json:303 |
| LoraLoaderModelOnly | lora_name | `wan2.2\Wan2.2-Fun-A14B-InP-high-noise-MPS.safetensors` | wan22_remix_flf2v.json:317 |
| VAELoader | vae_name | `wan2.1\wan_2.1_vae.safetensors` | wan22_remix_flf2v.json:339 |
| LoraLoaderModelOnly | lora_name | `wan2.2\lightx2v_I2V_14B_480p_cfg_step_distill_rank128_bf16.safetensors` | wan22_remix_flf2v.json:352 |
| DiffusionModelLoaderKJ | model_name | `Wan2.2_Remix\Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v3.0.safetensors` | wan22_remix_flf2v.json:447 |
| DiffusionModelLoaderKJ | model_name | `Wan2.2_Remix\Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v3.0.safetensors` | wan22_remix_flf2v.json:461 |

### 1.2 `wan22_i2v.json` 引用的模型（与 flf2v 完全同套）

- `wan2.2\umt5_xxl_fp8_e4m3fn_scaled.safetensors`（:96）
- `wan2.2\clip_vision_h.safetensors`（:167）
- `wan2.1\wan_2.1_vae.safetensors`（:107）
- `wan2.2\lightx2v_I2V_14B_480p_cfg_step_distill_rank128_bf16.safetensors`（:17）
- `wan2.2\Wan2.2-Fun-A14B-InP-high-noise-MPS.safetensors`（:31）
- `wan2.2\Wan2.2-Fun-A14B-InP-low-noise-HPS2.1.safetensors`（:45）
- `Wan2.2_Remix\Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v3.0.safetensors`（:391）
- `Wan2.2_Remix\Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v3.0.safetensors`（:405）

### 1.3 `minimax_h3_i2v.json` / `minimax_h3_r2v.json` 引用的模型（H3 主链路）

- `minimax_h3_fl2va_pruned_int8_convrot.safetensors`（i2v，minimax_h3_i2v.json:9）
- `minimax_h3_ref2va_pruned_int8_convrot.safetensors`（r2v，minimax_h3_r2v.json:17）
- `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`（text_encoder，两者都要）
- `minimax_h3_video_vae_int8_convrot.safetensors`
- `minimax_h3_audio_vae_fp32.safetensors`
- `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors`（i2v turbo，代码常量 `taskQueueShared.ts:14`）
- `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors`（r2v turbo，代码常量 `taskQueueShared.ts:15`）

---

## 2. 现有模型清单（2026-10-27 盘点）

### diffusion_models/
- ✅ `minimax_h3_fl2va_pruned_int8_convrot.safetensors`（19.6GB）
- ✅ `minimax_h3_ref2va_pruned_int8_convrot.safetensors`（19.6GB）
- ✅ `QW2511\qwen_image_edit_2511_fp8mixed.safetensors`（19.6GB，用户手动模板用）
- Flux2-Klein 3 个、MelBandRoformer（与 drama-studio 主链路无关）

### loras/
- ✅ `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors`（1.8GB）
- ✅ `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors`（1.8GB）
- Qwen2511 3 个（与主链路无关）

### text_encoders/
- ✅ `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`（14.9GB）
- flux2_klein\qwen_3_8b_fp8mixed（与主链路无关）

### vae/
- ✅ `wan2.1\wan_2.1_vae.safetensors`（242MB）
- ✅ `minimax_h3_video_vae_int8_convrot.safetensors`（2.7GB）
- ✅ `minimax_h3_audio_vae_fp32.safetensors`（577MB）
- Qwen/qwen_image_vae、flux2-vae（与主链路无关）

### clip_vision/
- 盘点时目录不存在。

---

## 3. 真正缺失清单（按 drama-studio 代码引用）

### P0 — 主链路必备（flf2v / wan i2v 跑不起来）

| # | 文件 | 归属目录 | 大小 | 状态 |
|---|---|---|---|---|
| 1 | `wan2.2\umt5_xxl_fp8_e4m3fn_scaled.safetensors` | text_encoders | 6.27GB | ✅ 本次已下 |
| 2 | `wan2.2\clip_vision_h.safetensors` | clip_vision | 1.18GB | ✅ 本次已下 |
| 3 | `wan2.2\Wan2.2-Fun-A14B-InP-high-noise-MPS.safetensors` | loras | 0.80GB | ✅ 本次已下 |
| 4 | `wan2.2\Wan2.2-Fun-A14B-InP-low-noise-HPS2.1.safetensors` | loras | 0.80GB | ✅ 本次已下 |
| 5 | `wan2.2\lightx2v_I2V_14B_480p_cfg_step_distill_rank128_bf16.safetensors` | loras | 1.37GB | ✅ 本次已下 |
| 6 | `Wan2.2_Remix\Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v3.0.safetensors` | diffusion_models | 13.31GB | ✅ 本次已下 |
| 7 | `Wan2.2_Remix\Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v3.0.safetensors` | diffusion_models | 13.31GB | ✅ 本次已下 |

`wan2.1\wan_2.1_vae.safetensors` 原本就在，未重下。

### P1 — 代码未引用（不下，仅记录）

以下文件只出现在用户手动收集的 workflow 模板里，`src/` 下没有任何代码路径加载它们：

- `wan2.2\wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors` / `low_noise`（仅 `remix_t2v.json`，t2v 模板，drama-studio 主链路走 i2v/flf2v，不跑 t2v）
- `wan2.2\lightx2v_I2V_14B_480p_cfg_step_distill_rank256_bf16.safetensors`（仅 `2_Wan_2_2REMIX_V3图生视频.json`，手动模板）
- `wan2.2\umt5_xxl_fp16.safetensors`（仅 V3 手动模板；代码用 fp8_scaled 版）
- `wan2.2\clip_vision_vit_h.safetensors`（仅 V3 手动模板；代码用 clip_vision_h）

### P2 — 备用引擎（代码完全不引用，不下）

- LTX 系列 8 个：`ltx\ltx-2.3-22b-*.safetensors`、`ltx\gemma_3_12B_it*.safetensors`、`ltx\LTX23_*_vae_bf16.safetensors`、`ltx-2.3-spatial-upscaler-x2-1.1.safetensors`（仅 `1_LTX2_3文生视频稳定版.json`、`ltx_t2v_720p.json`、`2_参考图生多视频_短剧制作_.json`）
- Z-image 3 个：`Z-image\*.safetensors`（仅 `1_Z-Image文生图.json`）
- FireRed 2 个：`FireRed1.1\*.safetensors`（仅 `firered_i2i_*.json`）
- Wan2.2_Remix t2v 4 个：`Wan2.2_Remix\Wan2.2_Remix_NSFW_t2v_14b_high/low_lighting_v2.0.safetensors`（仅 `remix_t2v*.json`、`1_Wan2_2_REMIX_V2_*.json`，drama-studio 不跑 t2v）

---

## 4. 磁盘空间

```
D: total=1024.0GB  used=347.7GB  free=676.3GB
```

本次下载合计 ~37GB，空间充裕。

---

## 5. 下载记录

- 镜像：`HF_ENDPOINT=https://hf-mirror.com`
- 工具：`huggingface_hub.hf_hub_download`（resume_download=True）
- 脚本：`E:\drama-studio\scripts\download-p0-models.py`
- 日志：`E:\drama-studio\tmp\download-p0.log`
- 起止：13:20:26 → 13:28:26，总耗时 **8 分 0 秒**

| # | 文件 | 仓库 | 大小 | 耗时 | 速度 |
|---|---|---|---|---|---|
| 1 | umt5_xxl_fp8_e4m3fn_scaled | `Comfy-Org/Wan_2.1_ComfyUI_repackaged` | 6.74GB | 57s | 118 MB/s |
| 2 | clip_vision_h | `Comfy-Org/Wan_2.1_ComfyUI_repackaged` | 1.26GB | 10s | 132 MB/s |
| 3 | Fun-A14B-InP-high-noise-MPS | `RunningHubAI/rh-wan2.2-fun-a14b-inp-high-noise-mps-lora` | 0.86GB | 6s | 143 MB/s |
| 4 | Fun-A14B-InP-low-noise-HPS2.1 | `RunningHubAI/rh-wan2.2-fun-a14b-inp-low-noise-hps2.1.safetensors-lora` | 0.86GB | 11s | 77 MB/s |
| 5 | lightx2v I2V rank128 bf16 | `RunningHubAI/rh-lightx2v-i2v-14b-480p-cfg-step-distill-rank128-lora` | 1.47GB | 17s | 85 MB/s |
| 6 | Remix i2v high lighting fp8 | `DanielMarius/Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v3.0.safetensors` | 14.29GB | 196s | 73 MB/s |
| 7 | Remix i2v low lighting fp8 | `DanielMarius/Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v3.0.safetensors` | 14.29GB | 183s | 78 MB/s |

**说明：**
- Wan2.2_Remix_NSFW 是民间二创，官方无仓库；选用 `DanielMarius` 的镜像（文件名与代码引用完全一致，fp8_e4m3fn v3.0）。
- Fun-A14B-InP 两个 LoRA 选 RunningHubAI 镜像（文件名与代码引用一致），未走 `alibaba-pai` 官方仓（官方仓是全量权重，不是 LoRA）。
- lightx2v rank128 选 RunningHubAI 镜像（文件名与代码引用一致）；社区其他镜像只有 rank32/64。
- 未做文件 hash 校验（hf-mirror 与 HF 主站同源，hf_hub_download 自带 ETag 校验）。

---

## 6. 重启 ComfyUI 与自检结果

**未重启 ComfyUI 进程**（PID 36364 仍在跑，9:45 启动）。原因：

- 调用 `POST http://127.0.0.1:8188/refresh` 后，ComfyUI 重新扫描 models 目录，无需重启。
- 已通过 `/object_info/<NodeType>` 接口逐一确认新文件出现在枚举列表中：

| 节点.键 | 期望条目 | 实测 |
|---|---|---|
| `DiffusionModelLoaderKJ.model_name` | `Wan2.2_Remix\Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v3.0.safetensors` | ✅ |
| `DiffusionModelLoaderKJ.model_name` | `Wan2.2_Remix\Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v3.0.safetensors` | ✅ |
| `CLIPLoader.clip_name` | `wan2.2\umt5_xxl_fp8_e4m3fn_scaled.safetensors` | ✅ |
| `CLIPVisionLoader.clip_name` | `wan2.2\clip_vision_h.safetensors` | ✅ |
| `LoraLoaderModelOnly.lora_name` | `wan2.2\Wan2.2-Fun-A14B-InP-high-noise-MPS.safetensors` | ✅ |
| `LoraLoaderModelOnly.lora_name` | `wan2.2\Wan2.2-Fun-A14B-InP-low-noise-HPS2.1.safetensors` | ✅ |
| `LoraLoaderModelOnly.lora_name` | `wan2.2\lightx2v_I2V_14B_480p_cfg_step_distill_rank128_bf16.safetensors` | ✅ |
| `VAELoader.vae_name` | `wan2.1\wan_2.1_vae.safetensors` | ✅（原有） |

按 `workflowLoader.ts:400-425` 的 `inspect()` 逻辑，`wan22_remix_flf2v.json` 与 `wan22_i2v.json` 引用的全部模型文件现在都在 ComfyUI 枚举列表内，**`missing-model` 问题应清零**。

> 注：应用自身的"环境自检"（`selfCheckService.ts`）只检查 ComfyUI 在线状态和模板可读性，不直接列缺失模型；真正的 `missing-model` 报错发生在渲染前 `taskQueue.ts:913/1330` 的 `validateBuiltGraph`。上述 /object_info 枚举比对等价于该检查。

---

## 7. 仍缺失的模型（诚实标注）

**drama-studio 代码硬编码引用的 P0 模型：0 个缺失。**

未下载项及原因：

1. **P1（代码未引用）**：`wan2.2_t2v_lightx2v_4steps_lora_v1.1_high/low_noise`、`lightx2v_I2V_14B_480p_cfg_step_distill_rank256_bf16`、`umt5_xxl_fp16`、`clip_vision_vit_h` —— 只出现在用户手动收集的模板里，代码路径不加载，按"不要为凑齐下一堆没用的模型"原则跳过。
2. **P2（备用引擎）**：LTX 8 个、Z-image 3 个、FireRed 2 个、Wan2.2_Remix t2v 4 个 —— 代码完全不引用，跳过。如后续要在 UI 里手动跑这些模板，再按需下载。

---

## 8. 后续建议

- 下次启动 drama-studio 应用后，第 1、2 镜（跨镜位移 flf2v）应能直接进渲染队列，不再报 `missing-model`。
- 若要跑一个最小 flf2v 镜头实测，建议先用 480p、17 帧（1s）压一遍 high/low lighting 双模型切换是否正常。
- 下载缓存留在 `D:\ComfyUI-V20\hf_cache\`，可手动清理（已 move 走的 .safetensors 不会重复占空间，但 .no_hash 等小文件可清）。
