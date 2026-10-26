# AI 微短剧流水线：行业踩坑与开发知识补充

**日期：** 2026-10-19  
**目的：** 把公开实践与失败案例沉淀为本仓库可执行的设计原则，指导 [efficiency-audit-2026-10-19.md](./efficiency-audit-2026-10-19.md) 中 P0/P1 的**专业解法**（而非只改 UI 文案）。  
**范围：** 角色一致性 · 首尾帧/I2V · ComfyUI API/VRAM · TTS/口型 · 导演 HITL 门禁 · 可观测性与恢复。

---

## 0. 一句话结论

业界成熟做法不是「多加提示词」，而是：

1. **先锁资产（Character Pack / Visual Bible），再渲运动**  
2. **人审的是「即将被渲染的那张静帧」**，审完就不要偷偷换图  
3. **门禁按「烧钱点」拆开**（拆镜 / 首帧 / 开渲 / 成片），一键多义会逼用户关错开关  
4. **失败当常态**：OOM、TTS、无人脸、音视频不等长 → 局部降级/重试，禁止静默无声成片  
5. **产物可复现**：seed / 工作流 / 参考图版本 / 门禁状态一起落盘  

下面按主题展开，并直接映射到本仓库代码。

---

## 1. 角色一致性（Character Consistency）

### 1.1 行业共识（踩坑来源）

| 坑 | 现象 | 业界对策 |
|----|------|----------|
| 纯文本锁脸 | 每镜换一张「像」的脸 | 必须有 **head-only 正脸** + **全身造型图**（Character Pack） |
| 一张图塞脸+姿态+服装 | 模型学乱，易「双胞胎」 | 脸与全身分图；多视角不要强塞进一张 sheet（Seedance 2.0 明确警告） |
| 参考图脸太小 | 身份锚点弱 | 正脸特写、均匀光、少肩部背景 |
| 中途改定妆 | 已渲镜全部漂 | Visual Bible **冻结**；换造型 = 新 look + 新参考，不覆盖旧文件 |
| 口型/超分后再检 | 后处理改脸 | 口型、face repair、upscale **之后再跑一次身份检查** |
| 靠 seed 保脸 | seed 只减随机，不能锁身份 | seed 用于 A/B，身份靠参考图/LoRA |

来源：
- [OpenMicroDrama · Character Consistency](https://openmicrodrama.com/guides/character-consistency)（2026-10）
- [ai-cinematic-pipeline · consistency techniques](https://github.com/billpar/ai-cinematic-pipeline/blob/refs/heads/main/docs/04-consistency-techniques.md)
- IP-Adapter FaceID 实践：权重约 0.7–0.85，过高糊脸（[Sozee FaceID 教程](https://www.sozee.ai/resources/ip-adapter-faceid-tutorial-2026/)）

### 1.2 对本项目的含义

我们已有：`faceImagePath` / `bodySheetPath` / `appearanceLock` / 场景板 — **方向正确**。

专业补强（相对审计 LOGIC-P1-02 / P2 双人镜）：

| 原则 | 落地建议 |
|------|----------|
| Character Pack 契约 | 定妆未齐（无正脸）时 casting 阶段不得标 done；UI 阻断「开渲」并列出缺项 |
| 描述句冻结 | `appearanceLock` 一经用户确认即只读；改外观走「新造型」分支，不原地改字符串 |
| 参考优先级 | 渲染回退链保持 **首帧 > face > ref > bodySheet**；重渲不得在无用户同意时换首帧 |
| 一致性检查时机 | 在 **口型/LatentSync 之后** 再记 `consistencyScore`（或分前/后两分），避免「渲时过、口型后漂」 |
| 组镜防双胞胎 | 负向提示 + 限制同框人数（我们已有红线）；双人镜必须落 `characterIds[]`，禁止折叠成单名 |

---

## 2. 关键帧 → 视频（Keyframe / FLF / 连镜）

### 2.1 行业共识

- **主路径 = 已审静帧 + I2V**，视频提示写 **运动与运镜**，不要重写外貌（图已经锁了）。  
- **精确落点** 用 FLF2V（首尾帧）；**镜间连续** 用上镜尾帧作下镜首帧。  
- Wan 2.2：竖屏建议 720×1280；默认约 **81 帧 @ 16fps ≈ 5s**；有创作者反馈 **24fps 易异常**，工作流回到 16fps。  
- 拼接时业界会 **切掉接合处几帧**（例如 Seedance：尾切 6、头切 1）减跳切感。  
- MiniMax H3：**FL2VA（首尾）与 Ref2VA（多参考）不能同一次生成**，每镜二选一。

来源：
- [OpenMicroDrama · ComfyUI for Micro Drama](https://openmicrodrama.com/guides/comfyui-for-micro-drama)
- [ComfyUI Wan / FLF / S2V 官方教程](https://docs.comfy.org/tutorials/video/wan/wan2_2)
- [NVIDIA ComfyUI Troubleshooting](https://build.nvidia.com/playbooks/comfyui/troubleshooting)

### 2.2 对本项目的致命对齐点（审计 LOGIC-P0-02）

> **审查门禁的对象必须等于入队渲染的首帧字节。**

行业没有「先过审再偷偷换 keyframe」这种流程——那等于烧钱渲未审片。

**专业解法（推荐实现契约）：**

```
renderStart(shotIds):
  if shotIds 指定（局部重渲）:
    if user.forceRebuildFirstFrame:
      rebuild → clear reviewed → 返回「需重新审核」错误（不入队）
    else:
      使用现有 firstFramePath（已审则保持）
  else:
    全量：不重建已审镜
  gate(reviewed) → queue.start
```

同时：导演自动路径若跳过人工审，应在 scenes gate 后提供 **「批量确认首帧」** 或显式 `autopilot: skipShotReview`，而不是静默绕过——与 commercial-creator / spark-video 的「烧钱前显式批准」一致。

---

## 3. ComfyUI / VRAM / API 吞吐

### 3.1 常见失败

| 坑 | 证据 | 对策 |
|----|------|------|
| I2V OOM | WanWrapper issues、社区 ROCm/VRAM 贴 | 降分辨率/帧数；Tiled VAE；FP8/GGUF；OOM 后清缓存再降档重试 |
| OOM 后 VRAM 泄漏 | ComfyUI PR #10141 Wan VAE cache leak（2025-10 已合） | 要求本机 Comfy **跟上版本**；我们侧 catch OOM 后 `interrupt` + 短 sleep + 降档 |
| UI JSON 当 API POST | NVIDIA playbook | 只提交 **API format** workflow（我们已做，需保持） |
| `/object_info` 过大 | 官方前端亦会拉全量；上传后若每次 invalidate | **不要每镜上传就全量 invalidate**；输入文件存在性用轻量检查；object_info TTL 分键缓存 |
| 取消后仍 wait | 常见托管封装坑 | interrupt 必须 settle 对应 `prompt_id` 的 wait Promise |

来源：
- [kijai/ComfyUI-WanVideoWrapper#110](https://github.com/kijai/ComfyUI-WanVideoWrapper/issues/110)
- [ComfyUI PR #10141](https://github.com/comfyanonymous/ComfyUI/pull/10141)
- [ComfyUI API /prompt](https://docs.comfy.org/development/comfyui-server/api-examples)
- [9elements · Hosting ComfyUI via API](https://9elements.com/blog/hosting-a-comfyui-workflow-via-api/)

### 3.2 对本项目

对齐审计 **LOGIC-P1-05 / P1-06**：

1. `upload*` → 不要调用会迫使每镜重下数 MB `object_info` 的全量失效；改为「文件名集合」本地账本或 Comfy input 列表轻量接口。  
2. `waitForCompletion` 在 `interrupt`/`cancel` 时 **立即 reject**，禁止挂到硬超时。  
3. OOM 降档（我们已有）应记入 `renderProfile.oomDowngraded`，并在 UI 明示「本镜已降质」，避免用户以为设置坏了。  
4. **Draft small / finish big**：低分辨草稿定运动，再对「中选镜」720p 终渲——可做成创作设置「草稿模式」，砍无效高清重试。

---

## 4. TTS · 口型 · 音画对齐

### 4.1 踩坑清单

| 坑 | 后果 | 专业对策 |
|----|------|----------|
| TTS 失败仍出片 | 静默「说话人」、口型崩 | **硬失败或强制补音阶段**；禁止默认静默成片（正是我们 `audioFailed` 空实现的业界反例） |
| 音视频时长不等 | LatentSync 按较短裁切；口型截断 | 渲前按台词定帧；口型前 **归一化 fps + 16kHz mono WAV**；不等长则循环/补黑或重渲加长 |
| 侧脸/遮挡/多人 | 检测失败崩溃或乱嘴 | 口型前 `isLipsyncable`；不过检则 **pass-through 原片**（质量 > 强行同步） |
| 静音段仍张嘴 | 观感假 | VAD：静音段跳过口型 |
| 口型后再漂脸 | 成片身份变 | 口型后二次一致性；失败则回退原片并写 `lipSyncFallback`（我们已有字段，需保证路径必达） |

来源：
- [LatentSync 生产踩坑指南](https://tomodahinata.com/en/blog/latentsync-lip-sync-diffusion-model-production-guide)
- [LatentSync#99 音视频时长](https://github.com/bytedance/LatentSync/issues/99)、[#28 静音张嘴](https://github.com/bytedance/LatentSync/issues/28)、[#296 人脸检测](https://github.com/bytedance/LatentSync/issues/296)
- Wan S2V vs InfiniteTalk：[创作者对比](https://note.com/ultracrab/n/n3dfe8759578d) — 大动作宜 **I2V + 后口型**；纯说话可考虑原生 S2V（16fps）
- [HF 讨论：本地口型路径选择](https://discuss.huggingface.co/t/nvidia-driver-update-reactor-node/176221/10)

### 4.2 对本项目（审计 LOGIC-P0-04）

推荐流水线阶段（专业命名）：

```
prepareAudio → (audioFailed?) retryTTS(n) → else mark shot.failed(AUDIO)
renderVideo
maybeLipSync:
  if !faceOK → pass-through + lipSync='none' + reason
  if durationMismatch → normalize or fail soft
  on lip fail → fallback raw + lipSyncFallback
postIdentityCheck  // 可选但推荐
```

导演 `combine` **之前**必须消费 `audioFailed`；注释里的「渲染完成后再补配音」应变成真实 stage 或硬停 + 一键「仅补配音」。

---

## 5. 导演 Agent · HITL 门禁（Human-in-the-Loop）

### 5.1 业界模板

成熟 agent 成片管线共同点：

1. **门禁按「决策类型」拆分**，不是一个总开关  
2. **烧算力 / 烧钱之前必须显式批准**（commercial-creator：video generation never without approval）  
3. **上游一改，下游标 stale**，而不是静默覆盖已批准产物  
4. **进度与审批 UI 全局常驻**，不绑在入口页  
5. 软质检（hint）**留痕不阻断**；硬失败才停

参考：
- [commercial-creator](https://github.com/cxbxmxcx/commercial-creator) — brief* / shots* / animatic* / generate†  
- [spark-video SKILL · 4+2 gates](https://github.com/modelstudioai/skills/blob/main/skills/spark-video/SKILL.md)  
- [GreenLight Motion · approval gates](https://greenlightdash.pro/documentation/greenlight-motion/the-film-pipeline/)  
- [AgentsCamp · storyboard director review gate](https://agentscamp.com/guides/design/ai-storyboard-from-script)

### 5.2 建议的门禁矩阵（替换当前 `reviewGate` 双义）

| 门禁 ID | 卡点 | 用户批准什么 | 默认 |
|---------|------|--------------|------|
| `gate.script` | analyze 后 | 角色表 + 镜数 + 对白 | 可选 |
| `gate.assets` | casting/scenes 后 | 定妆 / 场景板 | 可选 |
| `gate.keyframes` | 首帧生成后 | **每镜首帧静帧**（= 渲染输入） | 精品模式 on |
| `gate.spendRender` | 入队前 | 「确认开渲 N 镜」 | 自动驾驶可 off |
| `gate.final` | BGM 前 | 技术硬伤 / 缺镜 / 无声镜 | on |

对应审计 **LOGIC-P0-01 / UX-P0-01 / LOGIC-P0-03**：

- `shotReviewGate` ≠ `finalReviewGate`  
- `perShotAudit` 的 soft hint → **只写 `auditHint`，默认不 `finish(暂停)`**；硬失败才暂停  
- 开拍入口统一；进度在 **项目控制台 / App 浮层**，禁止仅挂在 `ProjectListView`

### 5.3 「批准后失效」规则（行业标准）

| 用户动作 | 下游状态 |
|----------|----------|
| 改 action / 强制重建首帧 | `reviewed=false`，禁止入队直至再审 |
| 改定妆图 | 依赖该角色的未渲镜标 stale；已渲镜提示「身份可能过期」 |
| 剪辑台 trim/skip | 导演 `concat` **必须读取**（审计 LOGIC-P1-04）；否则等于丢弃人工剪辑 |

这比「done 保护 vs 重置」更干净：用 **显式 artifact 版本号 / stale 标记**，而不是靠「磁盘文件还在就强制 done」。

---

## 6. 可观测性 · 幂等 · 恢复（生产级）

来自 LatentSync/Comfy 托管实践的原则，直接可搬：

| 原则 | 做法 |
|------|------|
| **幂等** | job key = hash(workflow + 输入文件 + seed + 关键设置)；相同不重渲 |
| **局部失败** | 单镜 fail 不拖死整集；自愈换 seed；超限则列镜号等人 |
| **结构化日志** | 已有 `DirectorLogEntry`；补 `reasonCode`：`AUDIO_FAIL` / `OOM_DOWN` / `GATE_BLOCK` / `STALE_KEYFRAME` |
| **取消即停** | WS + history；interrupt 结算 wait |
| **草稿/终稿两档** | 先 480 定运动，再 720 终渲（省算力） |

---

## 7. 映射：审计问题 → 专业解法（执行优先级）

| 审计 ID | 行业原则 | 推荐实现（比「改 toast」更专业） |
|---------|----------|----------------------------------|
| LOGIC-P0-01 | 门禁按烧钱点拆分 | `shotReviewGate` + `finalReviewGate`；设置文案对齐 |
| LOGIC-P0-02 | 审什么渲什么 | 局部重渲默认不重建；强制重建 → 清审 + **拒入队** |
| LOGIC-P0-03 | soft QC 不阻断主路径 | hint 留痕；仅 hard fail / 用户 gate 暂停 |
| LOGIC-P0-04 | 失败非静默 | combine 前 `repairAudio` stage 或硬停 |
| UX-P0-01/02 | 单入口 + 全局进度 | 统一 StartForm；进度进 console/App |
| LOGIC-P1-04 | 人工剪辑是一等公民 | `concatDoneShots` 传 trim/skip |
| LOGIC-P1-06 | API 缓存分层 | 上传不失效全量 object_info |
| LOGIC-P1-02 | 一致性策略矩阵 | warn/rerender/drop 一张表；口型后复检 |
| LOGIC-P1-09 | stale vs done | 显式 reset / artifact version，替代「文件在就 done」 |

---

## 8. 建议写进代码的「不变式」（Invariants）

实现与 Code Review 可用检查清单：

1. **`reviewed === true` ⇒ `firstFramePath` 存在且内容哈希未变**（变则自动 `reviewed=false`）。  
2. **`status=done` 且无 `segmentPath` 非法**；故意重置必须先删产物或带 `forceReset`。  
3. **`dialogue` 非空 ⇒ 不得带着 `audioFailed` 进入 combine**（除非用户勾选「允许无声」）。  
4. **导演 concat 的镜头集合 ⊆ 剪辑台未 skip 且 trim 已应用**。  
5. **同一 `prompt_id` 取消后，对应 wait 必须在 T 秒内结束**。  
6. **开拍成功 ⇒ 导航到可观察进度的表面**（项目 console）。  

---

## 9. 主要参考链接

- OpenMicroDrama: [Character Consistency](https://openmicrodrama.com/guides/character-consistency), [ComfyUI Micro Drama](https://openmicrodrama.com/guides/comfyui-for-micro-drama)  
- ComfyUI: [API examples](https://docs.comfy.org/development/comfyui-server/api-examples), [Wan 2.2](https://docs.comfy.org/tutorials/video/wan/wan2_2), [VAE OOM leak fix](https://github.com/comfyanonymous/ComfyUI/pull/10141)  
- Pipeline HITL: [commercial-creator](https://github.com/cxbxmxcx/commercial-creator), [spark-video gates](https://github.com/modelstudioai/skills/blob/main/skills/spark-video/SKILL.md)  
- Lip-sync: [LatentSync production guide](https://tomodahinata.com/en/blog/latentsync-lip-sync-diffusion-model-production-guide), [LatentSync issues](https://github.com/bytedance/LatentSync/issues)  
- Consistency chaining: [ai-cinematic-pipeline](https://github.com/billpar/ai-cinematic-pipeline/blob/refs/heads/main/docs/04-consistency-techniques.md)  
- NVIDIA Comfy troubleshooting: [playbook](https://build.nvidia.com/playbooks/comfyui/troubleshooting)

---

## 10. 下一步（研发动作）

1. 用本文 **§7 / §8** 修订 Phase 0 实现方案（先改契约，再改 UI）。  
2. 在 `docs/efficiency-audit-2026-10-19.md` Phase 0 条目上挂「遵循 industry-lessons §x」。  
3. 开工顺序不变，但验收标准升级为 **不变式测试**（例如：强制重建首帧后 `renderStart` 必须 reject）。

*本文为开发知识补充，不替代审计报告；冲突时以「审什么渲什么 / 失败不静默 / 门禁单义」三条硬原则为准。*
