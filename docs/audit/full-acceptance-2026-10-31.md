# Drama Studio 全链路交付验收报告（2026-10-31）

> **验收基线**：分支 `feat/agent-autonomy`，HEAD `2c520ca` + 本地修复（未提交）
> **验收角色**：工业级交付测试（静态枚举 → 真实路径驱动 → 三平台 CI 交叉验证）
> **运行环境**：Windows 11 · Electron 44.5.1 · RTX 5060 Ti 16 GB · ComfyUI 0.39.0
> **证据目录**：[docs/audit/evidence/acceptance-2026-10-31](file:///e:/drama-studio/docs/audit/evidence/acceptance-2026-10-31)
> **自动化脚本**：[acceptance.spec.ts](file:///e:/drama-studio/e2e/acceptance.spec.ts)

---

## 一、结论摘要

| 维度 | 结论 |
|---|---|
| P0 阻断缺陷 | **1 项**：`useRouteProjectId` 初始化顺序触发的 TDZ，导致剧本 / 角色库 / 场景板首屏永久骨架屏、剧本页全部按钮无效。**已修复并复验**。 |
| P1 高优先级 | 2 项（ComfyUI 启动命令文案与实现矛盾，已修复；真实生成/渲染链路未闭环，环境受限）+ 1 项交付风险（打包 job 未在 CI 实跑）。 |
| P2 中优先级 | 4 项（新装磁盘检查 ENOENT、跨平台启动命令提示、右键盘点未自动化、聊天快捷指令占位文案）。 |
| 页面可用性 | 10 个一级页面全部可加载；首屏 351 ms，路由切换渲染 6–49 ms；0 pageerror / 0 console error。 |
| 按钮与隐藏入口 | 10 页共 80 个可见按钮完成清点；5 个新建类弹窗开/关通过；首次向导、Alt+1~6、Ctrl+,、侧栏折叠全部实测通过。 |
| 门禁 | typecheck 0 错误 · lint 0 error/0 warning · vitest 128 文件 / 1917 用例全过 · build 成功 · acceptance E2E 1 passed。 |
| CI 交叉验证 | run `41174040293`（commit `2c520ca`）ubuntu / windows / macos 三个 verify job 全绿；package job 因 tag-only 规则 skipped。 |

> **重要口径**：本地修复尚未提交，因此上述 CI 结果覆盖的是修复前的 `2c520ca`，**不构成对本次修复的远端验证**；需推送后重跑三平台 CI 才算闭环。

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
| 右键菜单 | 项目卡片 / 队列行 / 素材卡片 | 代码中存在，自动化未右键点击（见 P2-03） |
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

### P1-02 · 真实生成 / 渲染链路未闭环（环境阻塞，非本次代码缺陷）

**严重度**：P1（交付能力未验证）
**现状**：
- 本机 ComfyUI 正常启动（含 112 个自定义节点）时，加载 25 分钟仍未监听 8188；
- 以 `--disable-all-custom-nodes` 启动后 30 秒内就绪，连接可绿，但自定义节点工作流不可用；
- 本机无可用 LLM Key 配置于临时验收 profile，AI 写剧本/拆镜/生图/生视频未实际执行。

**结论**：剧本→拆镜→首帧→渲染→成片 happy path 仍属**未验证**（与 `e2e/real-chain.spec.ts` 的 `E2E_REAL_CHAIN=1` 门控一致）。需在节点完整、模型齐备、LLM 可用的环境中执行 `E2E_REAL_CHAIN=1` 后再签收。
**建议**：在验收环境预置一份「最小可跑」ComfyUI 配置（仅保留 3–5 个必需节点 + 所需模型），把启动时间控制在 1 分钟内，再启用真实链路 E2E。

---

### P1-03 · 三平台 CI 只验证 verify，打包 job 被跳过

**严重度**：P1（发布工程风险）
**证据**：run `41174040293` 中 `package (${{ matrix.os }})` 为 `skipped`，仅 tag 触发；当前 commit 未打 tag，因此 **Windows/macOS/Linux 安装包均未在 CI 产出与冒烟**。
**影响**：无法证明 NSIS / dmg / AppImage 产物在 CI 环境可构建、可安装、可启动。
**建议**：打一个 `v1.0.0-rc` 测试 tag 触发 package job，三平台产物各做一次安装+启动冒烟；随后在总览文档登记产物哈希与结论。

---

### P2-01 · 全新数据目录下磁盘空间检查 ENOENT

**严重度**：P2（首次启动的可观测性噪声）
**证据**：主进程日志 `[IPC] system:disk-space 失败: ENOENT: no such file or directory, statfs '<DATA_ROOT>'`（[walkthrough.json](file:///e:/drama-studio/docs/audit/evidence/acceptance-2026-10-31/walkthrough.json) `mainLogTail`）。
**根因**：[diskSpace.ts](file:///e:/drama-studio/src/main/core/diskSpace.ts#L9-L13) 直接 `statfs(dir)`；新装/临时 profile 下 `userData/drama-studio` 尚不存在。
**影响**：低磁盘预警在首次启动时不可用，且日志出现「失败」误导排障。
**建议**：`statfs` 失败时回退到父目录（`userData`）或先 `mkdir(DATA_ROOT, {recursive:true})` 再统计；补一条单测覆盖目录不存在场景。

---

### P2-02 · 「启动命令」示例为 Windows 专属，缺跨平台说明

**严重度**：P2（跨平台适配）
**现状**：修复后的提示以 `"D:\ComfyUI\python\python.exe" "D:\ComfyUI\main.py"` 为例；macOS/Linux 用户需要不同的 `python3` 路径与参数，设置页无对应说明。
**建议**：按 `process.platform` 渲染示例（mac/linux 用 `/path/to/python3 /path/to/ComfyUI/main.py`），并在发布文档补三平台启动命令模板。

---

### P2-03 · 右键菜单未纳入自动化覆盖

**严重度**：P2（覆盖率缺口）
**现状**：项目卡片、队列行、素材卡片均注册了右键菜单（如 [QueueView.vue](file:///e:/drama-studio/src/renderer/src/views/QueueView.vue#L249-L280)），本次自动化只清点了可见按钮，未右键展开菜单项。
**建议**：在 acceptance 中增加「右键 → 菜单项数量/文案断言 → Esc 关闭」步骤；对有副作用的菜单项仅验证展示，不执行。

---

### P2-04 · 聊天快捷指令存在字面占位文案「重渲第X镜」

**严重度**：P2（体验细节）
**证据**：导演对话面板快捷指令显示「重渲第X镜」（[项目控制台截图](file:///e:/drama-studio/docs/audit/evidence/acceptance-2026-10-31/06-console-project.png)）。
**影响**：作为发送给导演的自然语言指令，字面「X」会让用户不知道要替换；不影响功能。
**建议**：改为「重渲某一镜（请补充镜号）」或在点击后预填「重渲第 __ 镜」。

---

## 五、三平台 CI 交叉验证

| Job | 平台 | 结果 | 说明 |
|---|---|---|---|
| verify | ubuntu-latest | ✅ success | typecheck / lint / vitest / build |
| verify | windows-latest | ✅ success | 同上（修复前 6 个平台差异用例已在 `2c520ca` 修复） |
| verify | macos-latest | ✅ success | 同上 |
| package | 三平台 | ⏸ skipped | 仅 tag 触发（P1-03） |

**交叉验证结论**：
- CI 证明 **代码在三种 OS 的 Node/Electron 构建链上可编译、单测可过**，覆盖类型、lint、单元测试、构建四项；
- CI **不覆盖** Electron 运行时 UI、真实文件对话框、ComfyUI/GPU 渲染、安装包安装；
- 本次本地修复（`useRouteProjectId` + ComfyUI 文案）尚未提交，CI 结论不包含它，需推送后重跑。

---

## 六、本轮功能测试与门禁记录

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | ✅ 0 错误（node + web 双工程） |
| 静态检查 | `npm run lint` | ✅ 0 error / 0 warning |
| 单元/集成测试 | `npm test` | ✅ 128 个 spec / **1917** 用例全过（5.55 s） |
| 构建 | `npm run build` | ✅ main / preload / renderer 三产物成功 |
| 验收 E2E | `npx playwright test --config=e2e/playwright.config.ts e2e/acceptance.spec.ts` | ✅ 1 passed（29.8 s） |

---

## 七、未覆盖项与阻塞（如实声明）

| 项 | 原因 | 状态 |
|---|---|---|
| AI 写剧本 / 拆镜 / 审稿 | 临时 profile 无可用 LLM 配置 | 未执行 |
| 文生图 / 图生图 / 文生视频 / TTS | ComfyUI 自定义节点启动挂起，验收用 `--disable-all-custom-nodes` | 未执行 |
| 成片合成 / 字幕 / BGM / 导出 | 依赖上游渲染产物 | 未执行 |
| 原生文件选择/保存对话框 | Playwright 无法操作系统级对话框 | 未执行（见 manual-ux 清单） |
| 系统通知、最小化后完成提醒 | 需真实窗口失焦 | 未执行 |
| macOS / Linux 运行时 UI | 本机仅 Windows | 未执行（CI 仅编译/单测） |
| 项目包导入导出（真实大包） | 需真实素材与长耗时 | 未执行 |
| 右键盘点 | 自动化未右键 | 未执行（P2-03） |

---

## 八、代码变更清单（本地，待提交）

| 文件 | 变更 | 目的 |
|---|---|---|
| [useRouteProjectId.ts](file:///e:/drama-studio/src/renderer/src/composables/useRouteProjectId.ts) | 去除 `immediate`，首次加载延后到 `onMounted` | 修复 P0 TDZ，覆盖全部项目页 |
| [ComfyuiSection.vue](file:///e:/drama-studio/src/renderer/src/components/settings/ComfyuiSection.vue) | 启动命令提示改为真实行为 + 示例 | 修复 P1-01 文案矛盾 |
| [acceptance.spec.ts](file:///e:/drama-studio/e2e/acceptance.spec.ts) | 新增全页面验收脚本 | 可重复回归：页面、按钮、弹窗、快捷键、耗时、错误采集 |
| `docs/audit/evidence/acceptance-2026-10-31/` | 18 张截图 + `walkthrough.json` | 验收留证 |

---

## 九、建议后续动作（按优先级）

1. **提交并推送修复**，触发三平台 CI，确认新增 E2E 不进入 CI（当前 CI 不跑 e2e）且 verify 仍全绿。
2. 打 `v1.0.0-rc` tag 触发 package job，补齐三平台安装包冒烟（P1-03）。
3. 修复 P2-01 磁盘检查回退，补单测。
4. 在完整 ComfyUI + LLM 环境执行 `E2E_REAL_CHAIN=1`，补齐真实链路签收（P1-02）。
5. 自动化补右键菜单与跨平台启动命令示例（P2-02/P2-03）。

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
| `walkthrough.json` | 步骤、耗时、按钮、错误、主进程日志尾部 |
