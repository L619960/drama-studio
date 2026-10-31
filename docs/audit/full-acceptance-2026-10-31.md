# Drama Studio 全链路交付验收报告（2026-10-31）

> **验收基线**：分支 `feat/agent-autonomy`，HEAD `f61b9c4`（已推送）；verify run `41195055356` / `41195810778` / `41196992891` 三平台全绿；tag `v1.0.0-rc.2` 的 run `41196992891` **三平台 package 全部 success**（rc.1 的 run `41196501451` 曾在隐式发布步骤失败，见 P1-03）
> **验收角色**：工业级交付测试（静态枚举 → 真实路径驱动 → 三平台 CI 交叉验证）
> **运行环境**：Windows 11 · Electron 44.5.1 · RTX 5060 Ti 16 GB · ComfyUI 0.39.0（白名单节点模式，8188 就绪）
> **证据目录**：[docs/audit/evidence/acceptance-2026-10-31](file:///e:/drama-studio/docs/audit/evidence/acceptance-2026-10-31)
> **自动化脚本**：[acceptance.spec.ts](file:///e:/drama-studio/e2e/acceptance.spec.ts)

---

## 一、结论摘要

| 维度 | 结论 |
|---|---|
| P0 阻断缺陷 | **1 项**：`useRouteProjectId` 初始化顺序触发的 TDZ，导致剧本 / 角色库 / 场景板首屏永久骨架屏、剧本页全部按钮无效。**已修复、已提交并复验**。 |
| P1 高优先级 | 3 项：ComfyUI 启动命令文案矛盾（已修复）；真实生成/渲染链路（**默认工作流曾整体 400，已修复；并已把默认出图切到 FLUX.2 Klein 降低 AI 塑料感**；剧本→成片仍受 LLM 配置限制）；CI tag 链路（**两层问题均已修复**：tag 不触发 workflow、tag 触发后隐式发布因缺 `GH_TOKEN` 失败；rc.2 三平台 package 全部 success）。 |
| P2 中优先级 | 4 项**全部闭环**：磁盘检查 ENOENT 回退（含 4 条单测）、跨平台启动命令示例、右键菜单自动化、快捷指令占位文案。 |
| 页面可用性 | 10 个一级页面全部可加载；首屏 351 ms，路由切换渲染 6–49 ms；0 pageerror / 0 console error。 |
| 按钮与隐藏入口 | 10 页共 80 个可见按钮完成清点；5 个新建类弹窗开/关通过；向导、Alt+1~6、Ctrl+,、侧栏折叠、**项目/角色右键菜单**全部实测通过。 |
| 门禁 | typecheck 0 错误 · lint 0 error/0 warning · vitest 128 文件 / **1921** 用例全过 · build 成功 · acceptance E2E 1 passed（31.6 s）。 |
| 真实链路 | 默认 `klein_t2i_clean`（FLUX.2 Klein，8 步 · cfg 4）经应用 IPC 出图：**32.3 s / 1024×1536 / 2.6 MB**，真实剧照质感（阴天平光、毛孔与不均匀色差、非对称五官、小巷投影逻辑成立）；回退链 `klein → qwen_t2i_hq（15.2 s）→ builtin_t2i（92.6 s）`。证据 [18-real-t2i.png](computer://e:\drama-studio\docs\audit\evidence\acceptance-2026-10-31\18-real-t2i.png)。 |
| CI 交叉验证 | verify run `41195055356`（`a7ecf66`）、`41195810778`（`f933147`）、`41196992891`（`f61b9c4`）ubuntu / windows / macos 全绿；tag run `41196992891`（`v1.0.0-rc.2`）package 三平台全部 success，产物已上传 artifact。 |

---

## 二、功能地图（一级模块 / 二级页面 / 交互与隐藏入口）

### 2.1 一级业务模块 → 二级页面

| 一级模块 | 二级页面 | 路由 | 页面文件 |
|---|---|---|---|
| 工作台 | 项目列表 | `#/` | [ProjectListView.vue](file:///e:/drama-studio/src/renderer/src/views/ProjectListView.vue) |
| 工作台 | 导演控制台（全局 / 项目） | `#/console`、`#/project/:id/console` | [ConsoleView.vue](file:///e:/drama-studio/src/renderer/src/views/ConsoleView.vue) |
| 项目资产 | 分镜编辑 | `#/project/:id/storyboard` | [StoryboardView.vue](file:///e:/drama-studio/src/renderer/src/views/StoryboardView.vue) |
| 项目资产 | 角色库 | `#/project/:id/characters` | [CharacterView.vue](file:///e:/drama-studio/src/renderer/src/views/CharacterView.vue) |
| 项目资产 | 场景板 | `#/project/:id/scenes` | [SceneBoardView.vue](file:///e:/drama-studio/src/renderer/src/views/SceneBoardView.vue) |
| 项目资产 | 道具库 | `#/project/:id/props` | [PropsView.vue](file:///e:/drama-studio/src/renderer/src/views/PropsView.vue) |
| 项目资产 | 剧本 | `#/project/:id/script` | [ScriptView.vue](file:///e:/drama-studio/src/renderer/src/views/ScriptView.vue) |
| 项目资产 | 渲染队列 | `#/project/:id/queue` | [QueueView.vue](file:///e:/drama-studio/src/renderer/src/views/QueueView.vue) |
| 项目资产 | 成片预览 | `#/project/:id/result` | [ResultView.vue](file:///e:/drama-studio/src/renderer/src/views/ResultView.vue) |
| 系统 | 设置 | `#/settings` | [SettingsView.vue](file:///e:/drama-studio/src/renderer/src/views/SettingsView.vue) |

### 2.2 二级功能分区

- **设置页 13 个分区**：通用、分镜生成、人物形象、场景图、视频剪辑、渲染、工作流、ComfyUI、环境检查、TTS 语音、LLM、外观、快捷键。
- **导演控制台 5 个模块**：工作流监控、技能管理、记忆库、ComfyUI、系统自检。
- **全局常驻**：[DirectorRunBar.vue](file:///e:/drama-studio/src/renderer/src/components/layout/DirectorRunBar.vue)（任务阶段/进度/暂停/继续/停止/清理临时产物/导入导出进度）。
- **首次运行**：[FirstRunWizard.vue](file:///e:/drama-studio/src/renderer/src/components/onboarding/FirstRunWizard.vue)（三步：检查环境 → 建第一个项目 → 知道去哪看进度）。

### 2.3 按钮清点（实测，非静态推断）

| 页面 | 可见按钮数 | 禁用按钮 | 代表入口 |
|---|---:|---:|---|
| 项目列表 | 10 | 0 | 新建项目、AI 导演、导入项目包、检测 ComfyUI、打开/复制/导出包/删除 |
| 导演控制台（全局） | 13 | 2 | 开始任务、停止任务、清空任务、导出日志、系统自检、清空 |
| 导演控制台（项目） | 12 | 2 | 开始任务、停止/清空任务、导出、清空、快捷指令 |
| 分镜编辑 | 13 | 1 | 添加分镜、AI 拆分镜、分镜审核、全部通过、提示词体检、开始渲染（禁用） |
| 角色库 | 5 | 0 | 添加角色、去分镜页看看 |
| 场景板 | 6 | 0 | 添加场景板、分镜编辑、去分镜页看看 |
| 道具库 | 5 | 0 | 添加道具、去分镜页看看 |
| 剧本 | 8 | 0 | AI 生成剧本、AI 剧本医生、保存、重新拆分镜、去 AI 导演 |
| 渲染队列 | 6 | 2 | 刷新、清除已完成（禁用）、取消全部（禁用） |
| 成片预览 | 7 | 2 | 刷新、合成成片（禁用）、导出视频（禁用） |
| 设置 | 4 | 0 | 恢复默认、保存 |

### 2.4 隐藏入口实测清单

| 入口 | 触发方式 | 实测结果 |
|---|---|---|
| 首次运行向导 | 首次启动自动弹出 | 出现；三步标题正确；可前进/后退/跳过 |
| 项目新建快捷键 | `Ctrl+N` | 由代码注册（[ProjectListView.vue](file:///e:/drama-studio/src/renderer/src/views/ProjectListView.vue#L292-L317)）；自动化未占用该按键 |
| 页面快捷键 | `Alt+1`~`Alt+6` | 全部正确跳转项目列表/分镜/角色/场景/队列/成片 |
| 设置快捷键 | `Ctrl+,` | 正确跳转设置页 |
| 侧栏折叠 | 点击底部折叠按钮 | 宽度 220 → 72 → 220 px，状态可恢复 |
| 右键菜单 | 项目卡片 / 素材卡片 | 已实测：项目卡片 7 项（打开编辑/重命名/复制项目/导出成片/导出项目包/在文件夹中显示/删除项目）；角色卡片 6 项；Esc 均可关闭 |
| 导演运行条 | 有任务/终态/归档进度时出现 | 无任务时正确隐藏，不遮挡页面 |
| 弹窗类入口 | 添加分镜 / 角色 / 场景板 / 道具 / AI 生成剧本 | 5 个弹窗均可打开并 Esc 关闭 |

---

## 三、真实路径实测结果

自动化以「临时 `userData`」隔离真实数据（`--user-data-dir`），完整走「首次向导 → 建项目 → 10 页巡检 → 设置/控制台切换 → 弹窗 → 快捷键 → 侧栏」。

| 指标 | 实测值 |
|---|---|
| 冷启动到 `#app` 挂载 | **351 ms** |
| 首次向导交互耗时 | 1 035 ms |
| 新建项目（含空标题校验） | 549 ms；空标题提示「请输入标题」 |
| 单页路由渲染耗时 | 6–49 ms（10 页全部 < 50 ms） |
| 设置页 13 分区切换 | 2 339 ms |
| 控制台 5 模块切换 | 2 540 ms |
| 5 个弹窗开关 | 1 272–1 790 ms / 个 |
| `pageerror` | **0** |
| 渲染层 `console.error/warn` | **0** |
| 主进程致命错误 | 0（仅 ComfyUI 离线时的 ECONNREFUSED 与磁盘 ENOENT，见 P2-01） |

> 完整机器可读记录：[walkthrough.json](file:///e:/drama-studio/docs/audit/evidence/acceptance-2026-10-31/walkthrough.json)

---

## 四、缺陷清单（P0 → P2）

### P0-01 · 剧本/角色库/场景板首屏永久骨架屏，剧本按钮全部失效（已修复）

**严重度**：P0（核心资产页不可用）
**影响页面**：剧本、角色库、场景板（三页复现）；同一初始化模式在道具/分镜/队列/成片页同样存在（潜在）
**现象**：进入页面后顶部弹出红色「操作失败：Cannot access 'loading' before initialization」，页面一直停留在骨架屏；剧本页「AI 生成剧本 / 保存 / 重新拆分镜」点击无任何反应。
**证据**：[修复前角色库](file:///e:/drama-studio/docs/audit/evidence/acceptance-2026-10-31/08-characters.png)、[修复前场景板](file:///e:/drama-studio/docs/audit/evidence/acceptance-2026-10-31/09-scenes.png)、[修复前剧本](file:///e:/drama-studio/docs/audit/evidence/acceptance-2026-10-31/11-script.png)

**复现步骤**：
1. `npm run build` 后用全新 `userData` 启动应用；
2. 跳过首次向导，新建任意项目；
3. 依次进入「角色库 → 场景板 → 剧本」；
4. 观察：页面骨架屏不消失，右上角出现红色提示；在剧本页点击「AI 生成剧本」无弹窗。

**根因**（代码证据）：
视图把 `useRouteProjectId()` 写在 `loading` 等 `ref` 声明之前：

```ts
// ScriptView.vue:204-209（Character/SceneBoard/Props 同型）
const projectId = useRouteProjectId((id) => { void loadProject(id) })
const project = ref<Project | null>(null)
const loading = ref(true)      // ← 尚未初始化
```

而 [useRouteProjectId.ts](file:///e:/drama-studio/src/renderer/src/composables/useRouteProjectId.ts#L7-L19) 的 `watch(..., { immediate: true })` 在 **setup 执行途中同步**调用 `loadProject`；`loadProject` 第一条语句即 `loading.value = true`，命中暂时性死区（TDZ），异常逃出函数（`loading.value` 在 `try` 之外），`loading` 永远为 `true`，页面卡骨架屏，`project` 永远为 `null`，所有依赖项目的按钮静默失败。

**修复**：将首次回调延后到 `onMounted`，`watch` 不再 `immediate`。这是对整类页面生效的根因修复，不依赖各视图声明顺序。

```ts
watch(projectId, (id, prev) => { if (!id || id === prev) return; onIdChange?.(id) })
onMounted(() => {
  const id = projectId.value
  if (id) onIdChange?.(id)
})
```

**修复后验证**：[角色库空态正常](file:///e:/drama-studio/docs/audit/evidence/acceptance-2026-10-31/08-characters.png)、[场景板空态正常](file:///e:/drama-studio/docs/audit/evidence/acceptance-2026-10-31/09-scenes.png)、[剧本编辑器正常](file:///e:/drama-studio/docs/audit/evidence/acceptance-2026-10-31/11-script.png)；「AI 生成剧本」弹窗打开/关闭通过；全量走查 0 pageerror。

**回归建议**：新增组件级回归用例（挂载一个「先调用 composable 后声明 ref」的最小视图，断言首帧不抛 TDZ），避免该类顺序回归再次进入发布。

---

### P1-01 · ComfyUI「启动命令」提示与实际行为矛盾（已修复）

**严重度**：P1（直接导致用户「启动 ComfyUI」按钮失败、误判为服务不可用）
**现象**：设置页提示「留空自动用本机秋叶整合包默认路径启动」，但实际 `startCommand` 为空时 [comfyuiClient.ts](file:///e:/drama-studio/src/main/core/comfyuiClient.ts#L134-L136) 直接返回错误「未配置 ComfyUI 启动命令，请在设置中填写 python.exe 与 main.py 的路径」。用户按提示留空点击，必然失败。
**复现步骤**：设置 → ComfyUI → 清空「启动命令」→ 点击「启动 ComfyUI」→ 出现上述错误，连接保持红色。
**修复**：把提示改为真实行为（[ComfyuiSection.vue](file:///e:/drama-studio/src/renderer/src/components/settings/ComfyuiSection.vue#L85-L87)），并给出 Windows 可复制的完整命令示例。
**实测补充**：本机 ComfyUI 0.39.0 在 8188 启动成功后，应用侧栏显示绿色「ComfyUI 已连接」（[设置页证据](file:///e:/drama-studio/docs/audit/evidence/acceptance-2026-10-31/14-settings.png)）。

---

### P1-02 · 真实生成链路：默认工作流曾整体 400，修复后文生图实测通过

**严重度**：P1（所有未显式指定工作流的图片生成都会失败）

**新发现（复核出图质量时暴露）**：默认工作流 `qwen_t2i_hq` 引用了自定义节点 `ReservedVRAMSetter`，但白名单模式下的本机 ComfyUI 没有该节点。`/prompt` 校验失败返回 400，`image.generate()` 直接抛 `AxiosError: Request failed with status code 400`；由于工作流文件存在、不会降级到 `builtin_t2i`，**角色 / 道具 / 场景板 / 首帧等所有走默认路径的生成都会失败**。这也解释了此前「出图假」的测试图：那张是显式指定 `builtin_t2i`（20 步 / cfg 7 / 512×512）的兜底路径产物，并非默认链路。

**修复**：`workflows/qwen_t2i_hq.json` 去掉 `ReservedVRAMSetter` 中转，`ModelSamplingAuraFlow` 直接接 `CheckpointLoaderSimple` 的 MODEL 输出，工作流回到全内置节点。

**修复后实测（默认路径，不传 `workflowName`）**：
- `window.api.image.generate(prompt, rel, { width: 1024, height: 1536, seed: 20261031 })`
- 命中 `klein_t2i_clean`（FLUX.2 Klein，8 步 · cfg 4），耗时 **32.3 s**，产物 **1024×1536 PNG / 2.6 MB**
- 画面写实：阴天平光、水泥墙真实肌理、皮肤毛孔与不均匀色差、五官轻微不对称、小巷空间与投影逻辑成立；证据 [18-real-t2i.png](computer://e:\drama-studio\docs\audit\evidence\acceptance-2026-10-31\18-real-t2i.png)
- 对照：`qwen_t2i_hq`（4 步蒸馏 + 1.5× 放大）15.2 s / 1152×1728，但脸部过度平整、光影戏剧化、会给室内场景凭空加雨；`builtin_t2i`（20 步 / cfg 7）92.6 s，插画感最重——**低分辨率 + 与蒸馏模型不匹配的采样参数是「假」的主因**。
- ComfyUI 完整自定义节点（112 个）冷启动 25 分钟未监听 8188 的问题已通过白名单收敛规避；`ComfyuiSection.vue` 的启动命令示例现在按平台渲染（P2-02）。

**仍属未验证**：
- 剧本 → 拆镜 → 首帧 → 渲染 → 成片 happy path：本机真实 profile 的 `settings.llm.apiKey` 为空，AI 写剧本/拆镜无法执行；图生视频与成片合成也未跑（单次耗时数分钟）。
- 需配置可用 LLM Key 后执行 `E2E_REAL_CHAIN=1 npm run test:e2e -- real-chain` 签收。

**结论**：「应用 ↔ ComfyUI ↔ 落盘」已闭环，默认工作流修复后真实感达到短剧首帧可用水平；「LLM → 剧本 → 分镜 → 视频」仍需可用模型与 Key。

**出图真实感升级（用户反馈「AI 感太重」后的二次复验）**：
- 复验对比 3 个模型路径（同题材提示词）：

| 路径 | 耗时 | 结果 | 真实感判断 |
|---|---:|---|---|
| FLUX.2 Klein `klein_t2i_clean`（8 步 / cfg 4） | 32.3 s | 1024×1536 | **最接近真实剧照**：阴天自然光、皮肤有毛孔与不均匀色差、五官轻微不对称、小巷投影逻辑成立、无招牌文字伪影 |
| Qwen Rapid `qwen_t2i_hq`（4 步蒸馏 + 1.5× 放大） | 15–41 s | 1152×1728 | 仍有塑料感：脸部过度平整、光影戏剧化、模型会给室内场景凭空加雨 |
| `builtin_t2i`（20 步 / cfg 7） | 92.6 s | 768×1152 | 插画感最重（采样参数与蒸馏模型不匹配） |

- 落地改动：`ImageService.DEFAULT_T2I_WORKFLOW = 'klein_t2i_clean'`，未显式指定工作流时按 `klein_t2i_clean → qwen_t2i_hq → builtin_t2i` 回退；显式指定但模板缺失时仍沿用旧语义回退 `builtin_t2i`（[imageService.ts](file:///e:/drama-studio/src/main/core/imageService.ts#L49-L53)）。
- 验证：默认路径（不传 `workflowName`）768×1152 实测 20.7 s、产物 768×1152（确认命中 Klein，而非 Qwen 的 1.5× 放大尺寸）；1024×1536 实测 32.3 s / 2.6 MB，即当前证据图。
- 提示词层复验：同模型下「霓虹招牌夜景」会生成无意义招牌文字（强 AI 感来源），改为「阴天自然光小巷」后伪影消失——已把该结论写进验收说明；霓虹/文字类场景属于模型固有短板。
- 剩余可继续调的方向：VAE 二次重绘（denoise 0.3）压蒸馏残留、或在设置里允许用户指定其他写实 checkpoint。

---

### P1-03 · CI tag 链路：先不触发 workflow，触发后又因隐式发布失败（两层均已修复）

**严重度**：P1（发布工程风险）

**第一层根因**：`.github/workflows/ci.yml` 的 `on.push` 只声明了 `branches`。GitHub Actions 在同时声明 `branches`/`tags` 时按各自过滤器匹配；只写 `branches` 意味着 **tag 推送不会触发 workflow**，因此 `if: startsWith(github.ref, 'refs/tags/v')` 的 package job 即使打了 tag 也永远 skipped。此前 run `41174040293` 的 skipped 并非「未打 tag」，而是配置不可达。
**修复**：`on.push` 增加 `tags: ['v*']`。

```yaml
on:
  push:
    branches: [main, master, feat/**]
    tags: ['v*']
```

**第二层根因（修复第一层后才暴露）**：tag run `41196501451` 三平台 verify 全绿，但 package job **全部失败**。日志显示 `Implicit publishing triggered by git tag`——electron-builder 26 在检测到 git tag 时隐式触发发布，随后报 `GitHub Personal Access Token is not set ... env "GH_TOKEN"`。三个平台都在产物构建完成后的发布步骤挂掉（macOS 的 dmg/zip、Linux 的 AppImage/deb、Windows 的 setup.exe 均已生成）。
**修复**：三个打包脚本显式关闭发布，产物只通过 artifact 上传（正式发布应另设显式 release 流程与 token）。

```json
"build:win": "electron-vite build && electron-builder --win --publish never",
"build:mac": "electron-vite build && electron-builder --mac --publish never",
"build:linux": "electron-vite build && electron-builder --linux --publish never"
```

**验证**：`v1.0.0-rc.2`（`f61b9c4`）→ run `41196992891`：verify 三平台 success，**package 三平台 success**；产物：
- Windows：`本地AI短剧工坊-1.0.0-setup.exe`（nsis，x64）
- macOS：`本地AI短剧工坊-1.0.0-arm64.dmg` + `.zip`
- Linux：`本地AI短剧工坊-1.0.0-x86_64.AppImage` + `本地AI短剧工坊-1.0.0-amd64.deb`

artifact 归档体积：windows 810.6 MB / macos 1306.1 MB / ubuntu 1578.9 MB（含未压缩目录，非安装包单体大小）。注意 `package.json` 版本仍为 `1.0.0`，该 tag 仅用于打包链路验证，非正式发布。

---

### P2-01 · 全新数据目录下磁盘空间检查 ENOENT（已修复）

**严重度**：P2（首次启动的可观测性噪声）
**证据**：主进程日志 `[IPC] system:disk-space 失败: ENOENT: no such file or directory, statfs '<DATA_ROOT>'`（[walkthrough.json](file:///e:/drama-studio/docs/audit/evidence/acceptance-2026-10-31/walkthrough.json) `mainLogTail`）。
**根因**：[diskSpace.ts](file:///e:/drama-studio/src/main/core/diskSpace.ts#L9-L26) 直接 `statfs(dir)`；新装/临时 profile 下 `userData/drama-studio` 尚不存在。
**修复**：`statfs` 遇 ENOENT 时逐级回退父目录（统计的仍是同一块盘），非 ENOENT 错误原样抛出；新增 4 条单测覆盖「存在 / ENOENT 回退 / EACCES 透传 / 回退到根仍失败」。
**验证**：重跑 acceptance 后 `mainLogTail` 中已无 `system:disk-space` ENOENT。

---

### P2-02 · 「启动命令」示例为 Windows 专属（已修复）

**严重度**：P2（跨平台适配）
**修复**：[ComfyuiSection.vue](file:///e:/drama-studio/src/renderer/src/components/settings/ComfyuiSection.vue#L135-L140) 按运行平台渲染示例：
- macOS：`"/Applications/ComfyUI/python/bin/python3" "/Applications/ComfyUI/main.py"`
- Linux：`"/path/to/python3" "/path/to/ComfyUI/main.py"`
- Windows：`"D:\ComfyUI\python\python.exe" "D:\ComfyUI\main.py"`

---

### P2-03 · 右键菜单未纳入自动化覆盖（已修复）

**严重度**：P2（覆盖率缺口）
**修复**：[acceptance.spec.ts](file:///e:/drama-studio/e2e/acceptance.spec.ts#L274-L308) 新增右键步骤：项目卡片菜单 7 项、角色卡片菜单 6 项断言（仅展开/关闭，不执行副作用项）。
**实测结果**：项目卡片 `打开编辑 / 重命名 / 复制项目 / 导出成片 / 导出项目包 / 在文件夹中显示 / 删除项目`；角色卡片 `更换面部定妆 / 更换三视图 / 编辑信息 / 试听音色 / 复制角色 / 删除角色`；Esc 关闭正常。

---

### P2-04 · 聊天快捷指令存在字面占位文案「重渲第X镜」（已修复）

**严重度**：P2（体验细节）
**修复**：按钮文案改为「重渲单镜」（[DirectorChat.vue](file:///e:/drama-studio/src/renderer/src/components/console/DirectorChat.vue#L91)）；点击后仍弹出「要重渲第几镜？」输入框并校验正整数，行为不变。
**说明**：原报告称「字面 X 无法替换」不准确——点击已有弹窗引导输入镜号，问题仅为按钮标签措辞。

---

## 五、三平台 CI 交叉验证

| Job | 平台 | 结果 | 说明 |
|---|---|---|---|
| verify | ubuntu-latest | ✅ success | run `41195055356` / `41195810778`：typecheck / lint / vitest / build |
| verify | windows-latest | ✅ success | 同上 |
| verify | macos-latest | ✅ success | 同上 |
| package | windows-latest | ✅ success | tag run `41196992891`：`本地AI短剧工坊-1.0.0-setup.exe` |
| package | macos-latest | ✅ success | 同上：`-arm64.dmg` + `-arm64.zip`（未签名，本地安装需绕过 Gatekeeper） |
| package | ubuntu-latest | ✅ success | 同上：`-x86_64.AppImage` + `-amd64.deb` |

**交叉验证结论**：
- CI 证明 **代码在三种 OS 的 Node/Electron 构建链上可编译、单测可过**，覆盖类型、lint、单元测试、构建四项；
- 本轮修复（TDZ、文案、磁盘回退、跨平台示例、右键覆盖、CI tag 触发、打包禁止隐式发布）均在 `a7ecf66`/`f933147`/`f61b9c4` 上通过三平台 verify；
- tag `v1.0.0-rc.2` 的 run `41196992891` 首次跑通 **package 三平台全绿**，安装包产物已上传 artifact；
- CI **不覆盖** Electron 运行时 UI、真实文件对话框、ComfyUI/GPU 渲染、安装包安装后启动；
- rc.1（run `41196501451`）三平台 package 曾在隐式发布步骤失败，已由 `f61b9c4` 修复并以 rc.2 复验。

---

## 六、本轮功能测试与门禁记录

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | ✅ 0 错误（node + web 双工程） |
| 静态检查 | `npm run lint` | ✅ 0 error / 0 warning |
| 单元/集成测试 | `npm test` | ✅ 128 个 spec / **1921** 用例全过（6.01 s） |
| 构建 | `npm run build` | ✅ main / preload / renderer 三产物成功 |
| 验收 E2E | `npx playwright test --config=e2e/playwright.config.ts e2e/acceptance.spec.ts` | ✅ 1 passed（31.6 s），含右键菜单新步骤 |
| 真实出图 | 应用 IPC → 默认 `klein_t2i_clean`（FLUX.2 Klein） | ✅ 32.3 s / 1024×1536 PNG / 2.6 MB；`qwen_t2i_hq` 15.2 s、`builtin_t2i` 92.6 s 对照 |
| 三平台打包 | tag `v1.0.0-rc.2` → run `41196992891` | ✅ package windows / macos / ubuntu 全部 success |

---

## 七、未覆盖项与阻塞（如实声明）

| 项 | 原因 | 状态 |
|---|---|---|
| AI 写剧本 / 拆镜 / 审稿 | 真实 profile 的 `settings.llm.apiKey` 为空 | 未执行（需配置 Key） |
| 文生图 | — | ✅ 已实测（默认 `klein_t2i_clean` 32.3 s / 1024×1536 / 2.6 MB；`qwen_t2i_hq` 15.2 s、`builtin_t2i` 92.6 s 对照） |
| 图生图 / 文生视频 / TTS | 需对应工作流与模型；单次耗时数分钟 | 未执行 |
| 成片合成 / 字幕 / BGM / 导出 | 依赖上游渲染产物 | 未执行 |
| 原生文件选择/保存对话框 | Playwright 无法操作系统级对话框 | 未执行（见 manual-ux 清单） |
| 系统通知、最小化后完成提醒 | 需真实窗口失焦 | 未执行 |
| macOS / Linux 运行时 UI | 本机仅 Windows | 未执行（CI 仅编译/单测） |
| 项目包导入导出（真实大包） | 需真实素材与长耗时 | 未执行 |
| 右键菜单 | — | ✅ 已覆盖（项目卡片 + 角色卡片） |
| 三平台安装包 | — | ✅ 已产出（run `41196992891`，package 三平台 success）；安装后启动冒烟未执行 |

---

## 八、代码变更清单（已提交并推送）

| 提交 | 文件 | 变更 | 目的 |
|---|---|---|---|
| `1df8428` | [useRouteProjectId.ts](file:///e:/drama-studio/src/renderer/src/composables/useRouteProjectId.ts) | 去除 `immediate`，首次加载延后到 `onMounted` | 修复 P0 TDZ，覆盖全部项目页 |
| `1df8428` | [ComfyuiSection.vue](file:///e:/drama-studio/src/renderer/src/components/settings/ComfyuiSection.vue) | 启动命令提示改为真实行为 | 修复 P1-01 文案矛盾 |
| `7a20a7b` | [acceptance.spec.ts](file:///e:/drama-studio/e2e/acceptance.spec.ts) | 新增全页面验收脚本 | 可重复回归：页面、按钮、弹窗、快捷键、耗时、错误采集 |
| `6003cc2` | [diskSpace.ts](file:///e:/drama-studio/src/main/core/diskSpace.ts) / [diskSpace.spec.ts](file:///e:/drama-studio/tests/unit/diskSpace.spec.ts) | ENOENT 回退父目录 + 4 条单测 | P2-01 |
| `6003cc2` | [ComfyuiSection.vue](file:///e:/drama-studio/src/renderer/src/components/settings/ComfyuiSection.vue) | 示例按平台渲染 | P2-02 |
| `6003cc2` | [DirectorChat.vue](file:///e:/drama-studio/src/renderer/src/components/console/DirectorChat.vue) | 「重渲第X镜」→「重渲单镜」 | P2-04 |
| `a7ecf66` | acceptance 脚本 + 证据 | 右键菜单步骤与重跑证据 | P2-03 |
| `f933147` | [ci.yml](file:///e:/drama-studio/.github/workflows/ci.yml) | `on.push.tags: ['v*']` | 修复 package job 死配置（P1-03 第一层） |
| `f61b9c4` | [package.json](file:///e:/drama-studio/package.json) | 三个打包脚本加 `--publish never` | 修复 tag 触发隐式发布失败（P1-03 第二层） |
| `a6b01bb` | [qwen_t2i_hq.json](file:///e:/drama-studio/workflows/qwen_t2i_hq.json) | 移除未安装的 `ReservedVRAMSetter`，MODEL 直连 Checkpoint | 修复默认工作流 400（P1-02） |
| `a967ef7` | [imageService.ts](file:///e:/drama-studio/src/main/core/imageService.ts) / [creationSettings.ts](file:///e:/drama-studio/src/shared/creationSettings.ts) / [promptConstants.ts](file:///e:/drama-studio/src/shared/promptConstants.ts) | 默认工作流改 `klein_t2i_clean`，回退 `qwen_t2i_hq → builtin_t2i` | 降低出图 AI 塑料感（P1-02） |
| `a7ecf66` / 本报告提交 | [docs/audit/evidence/acceptance-2026-10-31](file:///e:/drama-studio/docs/audit/evidence/acceptance-2026-10-31) | 17 张截图 + `walkthrough.json` + `18-real-t2i.png` | 验收留证 |

---

## 九、建议后续动作（按优先级）

1. ✅ 已提交并推送修复，三平台 verify 全绿（`41195055356` / `41195810778`）。
2. ✅ `v1.0.0-rc.2`（`f61b9c4`）tag run `41196992891` 三平台 package 全部 success，产物已上传 artifact；安装后启动冒烟仍未做（见第七节）。
3. ✅ P2-01/02/03/04 已修复并复验。
4. ⏳ 配置可用 LLM Key 后执行 `E2E_REAL_CHAIN=1 npm run test:e2e -- real-chain`，补齐剧本→成片签收。
5. ⏳ 生产发布前把 `package.json` 版本与正式 tag 对齐（当前 tag 仅用于打包验证）。

---

## 十、证据索引

| 文件 | 内容 |
|---|---|
| `01-launch.png` | 启动首屏 |
| `02-first-run-wizard.png` | 首次运行向导 |
| `03-storyboard-empty.png` | 新建项目后分镜空态 |
| `04-projects.png` | 项目列表 |
| `05/06-console-*.png` | 全局 / 项目导演控制台 |
| `07-storyboard.png` | 分镜编辑 |
| `08/09/10/11-*.png` | 角色库 / 场景板 / 道具库 / 剧本（修复后） |
| `12/13-*.png` | 渲染队列 / 成片预览 |
| `14-settings.png` | 设置页（ComfyUI 已连接） |
| `15-settings-render.png` | 渲染设置分区 |
| `16-console-selfcheck.png` | 系统自检面板 |
| `17-sidebar-collapsed.png` | 侧栏折叠态 |
| `18-real-t2i.png` | 真实出图产物（默认 `klein_t2i_clean`，1024×1536，2.6 MB） |
| `walkthrough.json` | 步骤、耗时、按钮、右键菜单、错误、主进程日志尾部 |
