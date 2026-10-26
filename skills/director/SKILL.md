---
name: director
description: 导演看守技能库。流水线启动时注入画质、运镜、光效和分镜方法。逐镜技术审核只留痕；硬失败才停下。软提示不自动重渲。编辑 rules.json 后，下一次任务生效。
---

# 导演看守技能库（Director Watchdog Skill）

本技能由短剧工坊自动流水线（DirectorAgent）在任务开始时**自动读取并全程生效**，无需人工触发。

## 读取方式

机器规则在 `rules.json`（DirectorAgent 启动时解析注入）；本文件是给人看的说明。

## 生效范围

1. **生成端**：每一张图（定妆/场景/首帧/尾帧）与每一段视频的提示词自动追加电影级质量条款（画质/特效/运镜/光效/场景锁定）。
2. **审核端**：每镜渲完做技术留痕（产物、时长、黑帧、一致性分）。软提示写入分镜，不自动重渲，也不拦住剪辑。渲染失败才停在剪辑前。
3. **策划端**：剧本分析/分镜生成时，`methodRules` 注入 LLM 系统提示词（短镜化、身份铁律、钥匙交接独立成镜、单人一画等）。

## 修改规则

编辑 `rules.json` 后，下一次启动流水线自动生效；无需重启应用。

## ComfyUI-MCP 与本机工作流接入（2026-10 已部署，真实可用）

### MCP 桥接（drama-studio → 本机 comfy-mcp）

- 服务端：官方开源 comfy-mcp，独立 venv 于 `D:\ComfyUI-V20\mcp-server\venv`（`Scripts\comfy-mcp.exe`）。
- 应用接入：`settings.comfyui.mcpVenvDir = D:\ComfyUI-V20\mcp-server\venv`（显式路径，优先于旧推导）；
  `settings.comfyui.startCommand`、`inputDir`、`modelsDir`、`workflowLibraryDir` 已填本机真实路径。
- 对话导演侧：启用「ComfyUI-MCP 工具集」技能后，工具以 `mcp_comfy__` 前缀动态注入（server_info /
  run_workflow / job_status / wait_for_job / fetch_outputs / search_models / search_nodes / validate_workflow 等）。
- ComfyUI 本体：http://127.0.0.1:8188，工作区已 `comfy set-default` 注册为 `D:\ComfyUI-V20\ComfyUI`。
- 自检命令：`"D:\ComfyUI-V20\mcp-server\venv\Scripts\python.exe" "D:\ComfyUI-V20\mcp-server\check-mcp.py"`。

### 工作流接入（本机 H3 双采系全部入库）

- 应用内置模板 `E:\drama-studio\workflows\`：
  - `minimax_h3_i2v.json`（单路 I2V，无 turbo，20 步）——兼容旧例
  - `minimax_h3_i2v_turbo.json`（**双采高效，推荐**：同一首帧双路 I2V——直出 + 3D latent 放大精修，
    内置 fl2v_turbo_8step LoRA，8 步直出 + 6 步 0.3 denoise 精修，本机实测比无 LoRA 提速约 2×）
  - `minimax_h3_r2v.json`（REF2VA 参考生视频：参考图保身份 + 参考音频驱动口型与音色，台词镜首选）
  - `latentsync.json`（口型同步）、`builtin_t2i.json`（首帧文生图）等
- 本机工作流库（`settings.comfyui.workflowLibraryDir = D:\ComfyUI-V20\ComfyUI\user\default\was-node-suite\workflows`）
  含 145 个真实跑通过的 JSON：h3_双采_*（古装短剧 6 镜母版 + 跳舞母版 + 高效版）、h3_xw_*（修仙题材出片 5 镜）、
  qwen3tts_*（TTS 台词）、latentsync_*（口型）。均为 API 格式，MCP `run_workflow` 可直接提交。

### 出片规则（已写入 rules.json methodRules，导演与流水线自动遵守）

1. 台词镜 → `minimax_h3_r2v`（原生口型音色）；无台词镜 → `minimax_h3_i2v` / `minimax_h3_i2v_turbo`。
2. H3 参数铁律：width/height 必须 32 倍数；帧数走 17k+5 网格 @24fps（107≈4.5s … 175≈7.5s）；
   turbo LoRA 已内置在双采模板，勿重复挂载。
3. 自定义工作流：先 `mcp_comfy__server_info` 确认在线 → `run_workflow`（只收 API 格式 JSON，
   工作流库文件可直接用）→ `job_status` / `wait_for_job` 轮询 → `fetch_outputs` 取片。
4. 模型名/LoRA 名必须来自 `search_models` / `/object_info` 真实值；缺节点/缺模型先报中文错误，不硬提交。
5. 每镜渲完必须抽帧验证（人脸/服装/场景/道具/无文字伪字）后才算完成，不合格标记返工。

### 接线自检（改完配置后验证一遍）

1. ComfyUI 在线：`http://127.0.0.1:8188/system_stats` 返回 200。
2. MCP 握手：运行上面 check-mcp.py，输出无警告。
3. 应用内：对话导演 `list_workflows` 应能看到 `available` 里的 turbo 模板与 `library` 里 38 个本机工作流。
