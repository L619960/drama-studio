# IPC 安全清单（drama-studio）

> 版本：2026-10-20（配合 design-audit-2026-10-20.md 五、实施状态）
> 用途：主进程 IPC 通道的信任边界速查表——每个能触达「文件系统 / 子进程 / 网络 / LLM 外发」的通道，校验机制是什么、漏了会怎样、如何审计。

## 0. 威胁模型一句话

渲染层（Renderer）可被 XSS/供应链污染攻陷（CSP + contextIsolation 仅降低概率，不消除），
因此**主进程不得信任渲染层传入的任何路径/命令/URL**；能自由读文件的位置 = 数据根 `DATA_ROOT`
（`userData/drama-studio`，`resolveInsideRoot` 词法+realpath 双重校验）。

## 1. 校验机制总览

| 机制 | 位置 | 说明 |
|------|------|------|
| `resolveInsideRoot` | src/main/index.ts:128 | 相对/绝对路径统一解析到数据根内；realpath 防符号链接逃逸；不存在的目标按词法校验 |
| 对话框会话 `dialogSavedFiles` | index.ts:291-311 | 用户经 `showOpenDialog` 选中的**外部**文件（数据根外）注册 10 分钟会话；`hasDialogSession` 校验消费方 |
| 项目存在性前置校验 | shotImportSceneImage / projectImportPropImage / subtitleGenerate 等 | 先 `projectStore.get(id)` 再写路径，防伪造 `projects/<id>/` 目录 |
| 工作流名白名单 `WORKFLOW_NAME_RE` | workflowLoader.ts:19 | `/^[\w一-龥-]+$/` 防路径穿越（load/updateParam/createWorkflow 共用） |
| 设置归一化（S-03） | settingsStore.normalize | 数值钳制 + 枚举白名单 + 字符串守卫，防渲染层写 NaN/畸形枚举/任意枚举值落盘 |
| IPC 参数类型收窄 | 各 handler 签名 | 字面量类型（number/boolean/枚举联合）由 TypeScript 层约束，运行时仍按上表校验 |

## 2. 通道清单（按风险分级）

### 2.1 高风险：外部文件读取 / 子进程 / 命令执行

| 通道 | 消费方 | 校验 | 状态 |
|------|--------|------|------|
| `dialog.selectVideo` → `ffmpegExtractFrames` / `llmWriteScriptFromVideo` | 外部视频抽帧（本机 ffmpeg）、抽帧→远程 LLM 外发 | 对话框会话注册 + `hasDialogSession` 校验 | ✅ S-01（2026-10-20） |
| `dialog.selectAudio` → `ttsClone` | 音色克隆参考音频 | 对话框会话注册 + 校验 | ✅ S-02（2026-10-20） |
| `settings.save` → `comfyui.startCommand` | 子进程 spawn | 不做命令白名单（会打死自定义安装路径）；`spawn(exe, argv)` 无 shell 拼接面，无注入升级 | ✅ S-03 说明（2026-10-20） |
| `dialog.saveFile` / `dialog.selectFile` → 工作流导入导出 | 用户选定文件 | 会话注册（既有） | ✅ |
| `settings.previewAsset` → 图片生成写盘 | 数据根内 preview/ | `resolveInsideRoot` | ✅ 既有 |

### 2.2 中风险：网络外发（LLM / ComfyUI）

| 通道 | 风险 | 校验 | 状态 |
|------|------|------|------|
| LLM `baseUrl`（settings.llm.baseUrl） | 配置被改 → apiKey 外发到任意地址 | 无运行时校验；SSRF 面在「对话工具 fetch_url」 | ⏸ S-04 未实施（另立条目） |
| 对话工具 `fetch_url` | SSRF（回环/私有网段） | **未做**；计划：回环/私有网段字面量拦截，不追 DNS rebinding | ⏸ 未实施 |
| ComfyUI `baseUrl` | 指向任意服务 | `setBaseUrl` 仅改运行时地址；连接目标由用户配置 | ✅ 既有（用户显式配置） |

### 2.3 低风险：数据根内路径（全经 `resolveInsideRoot`）

`imageGenerate`（relativeOutput / referenceImagePaths）、`ffmpegConcat/smartConcat/merge/mixBgm/burnSubtitles`、
`subtitleGenerate`、`project.*` 全部、`fileExists/fileSize`、`shotImportSceneImage`（含项目存在性校验）等。

**审计要点：** 新加 handler 若接受路径，先问三句——
1. 该路径是否在数据根内？（是 → `resolveInsideRoot`；否 → 必须走对话框会话注册）
2. 该文件会不会被发送到进程外（LLM / ComfyUI / ffmpeg）？（会 → 按「导入源」对待，注册+校验）
3. 有没有 `_comment`/占位符/绝对路径绕过写法？（→ 一律 `resolveInsideRoot` + 白名单名称）

## 3. 会话机制细节

- TTL = 10 分钟（`DIALOG_SESSION_TTL`）。「选视频 → 稍后点生成」超过 10 分钟会得到明确报错，
  重新选择即可（2 次点击）；这是安全边界优先的取舍，不设为常驻。
- 会话 Map 每次注册时顺带清理过期项，无增长泄漏。
- **已知盲区：** `dialogSelectDirectory` 注册在 `dialogSelectedDirs`（批量导出用），
  任何消费方未使用 `dialogSelectedDirs` 校验外部目录读取——目前无此类通道，新增时注意。

## 4. 遗留安全项（已记录，未实施）

| 项 | 说明 | 建议 |
|----|------|------|
| S-04 对话 `fetch_url` SSRF | 回环/私有网段字面量拦截（不追 DNS rebinding） | 另立条目实施 |
| S-06 对话工具绝对路径参数 | `render_quick`/`set_project_bgm` 接受任意绝对路径 | 收紧为数据根内相对路径或会话校验 |
| settings.json 明文 apiKey | safeStorage 加密存储 | 涉及读取路径改造（get/save/迁移），另立条目 |
| R-03 主进程日志无文件落盘 | console 日志重启即丢 | 独立工程（log file transport） |

## 5. 如何回归验证

- 会话校验：改 `DIALOG_SESSION_TTL` 为 1ms（临时）→ 选择视频后直接调 `llmWriteScriptFromVideo` → 应抛「未通过文件选择会话校验」。
- 路径穿越：`ffmpegConcat` 传 `..\..\Windows\system32\drivers\etc\hosts` → 应被 `resolveInsideRoot` 拒绝。
- 设置脏数据：`settings.save` 传 `{ render: { shotReviewGate: 'evil' } }` → 回读应为 `'block'`（vitest 已覆盖 settingsStore.spec.ts）。
- 回归测试：`npm test`（28 用例）；类型：`npm run typecheck`。

---
*本清单随 IPC 通道增删维护；新 handler 合入前对照第 2.3 节「审计要点」逐条自查。*
