# 仓库治理交付笔记 — 2026-10-27

执行范围：仓库卫生、git 入库、构建配置、eslint/husky。未触碰任何业务源码（src/main、src/renderer、src/shared、src/preload、tests/unit 内容）。

## 任务 1：`E:\drama-studio\~\` 目录处置

**实际内容（与任务描述不符，按真实情况记录）**：该目录并非误拷的完整用户主目录，里面没有 `.ssh` 私钥、`NTUSER.DAT`、`.gitconfig`。实际仅包含：

```
~/AppData/Local/comfy-cli/config.ini        38 字节
~/AppData/Local/comfy-cli/secrets.json.lock   0 字节
```

- 原目录大小：2 个文件，共 **38 字节**。
- 备份 zip：`E:\drama-studio-backup-2026-10-27.zip`（项目外，E 盘根），大小 **712 字节**，已校验 zip 内含上述 2 个文件。
- 删除结果：`Remove-Item -Recurse -Force` 成功，`Test-Path 'E:\drama-studio\~'` = **False**。

## 任务 2：git 入库治理（未 commit）

已暂存（`git diff --cached` 共 46 个路径）：

- `tests/unit/`：23 个 spec 全部 `A`（assetReuse…workflowLoader）。
- `docs/`：9 个文件 `A`（含 remediation-plan-2026-10-27.md、交互整改清单-2026-10-18.md 等；`*.log` 被 gitignore 自动排除）。
- `skills/`：2 个文件 `A`（director/SKILL.md、rules.json）。
- `scripts/patch-element-plus.mjs`：`A`（postinstall 钩子依赖）。
- 索引移除 `D`：`test/` 下 10 个文件 + `vite.renderer.config.ts` 1 个 = 11 个已从磁盘删除但残留索引的文件。

未暂存（留给用户 commit）：`.gitignore`、`package.json`、`.eslintrc.cjs`、`.prettierrc.json`、`.husky/`、`vitest.config.ts`、`scripts/archive/` 及 scripts 根目录其余 6 个常驻脚本、workflows/* 等。

## 任务 3：.gitignore 补充

已在末尾追加（`*.log`、`*.tsbuildinfo`、`*~`、`.tmp/` 原已存在，未重复）：

```
# 临时/缓存目录
tmp/
.tmp-test/
.screenshots/
.trae/

# 运行时 pid
*.pid
```

## 任务 4：根目录卫生清理

已删除（均被 gitignore 覆盖）：
- dev-err.log、dev-out.log、smoke-dev-err.log、smoke-dev-out.log（4）
- wuxia-dev-out.log … wuxia-dev-out8.log（8）
- tsconfig.node.tsbuildinfo、tsconfig.web.tsbuildinfo（2）
- `.screenshots/`、`.trae/`（2 个目录）

`交互整改清单-2026-10-18.md` 已 `Move-Item` 到 `docs/`（根目录已无，docs/ 下存在）。

`.tmp-test/`、`tmp/` 在磁盘上不存在（Test-Path=False），无需删除。

## 任务 5：scripts/ 归档

实际情况：scripts/ 根目录原本只有 22 个脚本，**没有**任务描述中提到的 114 个日志产物（`.log/.out/.pid/.stderr` 排查结果为 0）；hehuan-*、run-director-*、rerender-*、assemble-*、halt-*、regen-* 等跑片/补丁脚本在当前磁盘上均不存在。

- 新建 `scripts/archive/2026-q4-films/`（空目录，无对应脚本可移）。
- 新建 `scripts/archive/oneoff-fixes/`，移入 15 个一次性脚本：cancel-director、emergency-backup、fusion-settings、harden-settings、restart-app.ps1、restore-settings、restore-settings-only、scenes-gate-fix、smoke-monitor、smoke-ui、tts-edge-test、verify_prop_backfill.js、verify-creation-settings、verify-pipeline-guards.ts、verify-qwen2511-edit。
- 归档目录文件数：15。
- scripts/ 根目录最终剩 **7 个文件**：convert-comfy-ui.mjs、director-states.mjs、harden-smoke.mjs、patch-element-plus.mjs、smoke-run.mjs、watch-gate.mjs、watch-render.mjs。

## 任务 6：eslint + prettier + husky + coverage

- 安装 devDependencies（98 包）：eslint@10.13、prettier@3.9、@electron-toolkit/eslint-config-ts@4.0、eslint-plugin-vue@10.11、husky@9.1.7、lint-staged@17.6、@vitest/coverage-v8@5.0.5。
- 新建 `.eslintrc.cjs`（按任务指定内容）。
- 新建 `.prettierrc.json`（semi/singleQuote/tabWidth=2/printWidth=100）。
- package.json scripts 新增：`lint`（eslint . --ext .ts,.vue --max-warnings 50）、`format`（prettier --write src/**/*.{ts,vue}）；husky init 自动加了 `prepare: husky`。
- husky：`.husky/pre-commit` 内容为 `npm run typecheck && npm test`（已确认 `.husky/_/husky.sh` 存在，source 行可用）。
- vitest.config.ts 增加 coverage：provider v8，reporter text+html，阈值 lines/functions/branches 均 20。
- 未运行全仓 lint 修 style（按要求只装工具）。

## 任务 7：验证

- `npm run typecheck`（typecheck:node + typecheck:web）**退出码 0**，无类型错误。配置改动未影响 typecheck。
- 按要求未运行 `npm test`（主进程 agent 正在改 src/main/**，避免冲突）。

## 风险与后续待办（需用户注意）

1. **eslint 版本兼容**：npm 最新装的是 eslint@10，默认 flat config（eslint.config.js），而任务指定的是 legacy `.eslintrc.cjs`。eslint 10 很可能不读取 `.eslintrc.cjs`，导致 `npm run lint` 报"找不到配置"。建议二选一：① 把 eslint 降到 `eslint@8` 并保留 `.eslintrc.cjs`；② 改写成 `eslint.config.js` flat config（@electron-toolkit/eslint-config-ts@4 大概率导出 flat config）。本期未跑 lint，故未触发。
2. **pre-commit 钩子**会在每次 commit 时跑 `npm run typecheck && npm test`。当前 tests 未跑过全量（且 src/main 仍在被主进程 agent 修改），commit 前请确保 `npm test` 能通过，否则钩子会拦截提交。
3. **需要用户执行 git commit**：所有改动已暂存/就位，未 commit。建议把业务源码改动（src/main、src/renderer 等，来自主进程 agent）与本批治理改动一起或分开提交。
4. `E:\drama-studio-backup-2026-10-27.zip`（712 字节）是 ~ 目录的外部备份，确认无用后可自行删除。
