# Kimi SDK 最小接入验证记录

日期：2026-10-22。核对人按本次会话实际阅读和命令记录。本文件不勾选 `tasks.md`，也不改 `verification.md`。

任务 1.1、1.2 **尚未完成**。源码里能看到的接口不是运行证据。依赖安装、SDK 构建、接入程序都没有在本次核对中执行。

## 源码所见能力

以下只说明锁定树上**写了什么**，不表示这次跑通。

接入入口 `spikes/kimi-sdk-min-probe/run.mjs` 在导入 `probe.ts` 之前把 `KIMI_DISABLE_TELEMETRY=1`、`KIMI_CODE_HOME` 指到本目录 `sandbox`（`run.mjs:17-21`）。主程序 `probe.ts` 约定：三个环境变量 `MESNIER_PROBE_API_KEY`、`MESNIER_PROBE_BASE_URL`、`MESNIER_PROBE_MODEL` 缺任一则不调用 `runCredentialed`，从而不执行 `import('@moonshot-ai/kimi-code-sdk')`，把写文件、权限拒绝、取消、恢复和会话都记为未运行，退出码 2（`probe.ts:654-666`）。凭据齐全时才在当次 `home-<时间>-<pid>` 里 `createKimiHarness`，依次做 Write、拒绝、`Session.cancel`、关闭后再 `resumeSession({ id })`，任一项未真实发生则非 0（`probe.ts:408-637`）。`run.mjs` 本身仍无条件 `import('./probe.ts')`；“不导入 SDK”只发生在主程序跳过动态 `import()`，不是入口不加载主程序。

Kimi Code `packages/node-sdk`（`44cdf8f`）公开 `createKimiHarness`、`resumeSession`、`setApprovalHandler`、`Session.cancel`。文件写入只有模型侧工具 `WriteTool`，`name = 'Write'`（`packages/agent-core-v2/src/agent/tools/os/write/writeTool.ts:24-26`），SDK 导出列表没有宿主级“写一个文本文件”API（`packages/node-sdk/src/index.ts`）。

隔离：`resolveKimiHome` 优先显式 `homeDir`，否则 `KIMI_CODE_HOME`，再否则 `join(os.homedir(), '.kimi-code')`（`packages/agent-core-v2/src/app/bootstrap/bootstrap.ts:168-174`）。`configKey = basename(configPath)`，随后加载和监视用 `join(homeDir, configKey)`（`bootstrapService.ts:50`，`configService.ts:382-388`）。因此 `configPath` 与 `homeDir` 分离时，`ensureConfigFile(this.configPath)` 写完整路径，后续读写监视不一定是同一文件。日志路径是 `join(homeDir, 'logs', 'kimi-code.log')`（`packages/node-sdk/src/logging/logger.ts:208-209`）；`KIMI_LOG_*` 只解析级别和轮转大小（`logging/resolve-config.ts:15-25`）。`BootstrapService.osHomeDir` 默认 `os.homedir()`（`bootstrap.ts:114`）。host 探测把 `homeDir: nodeOs.homedir()` 传给环境探测（`environmentProbe.ts:269-274`）。ripgrep 缓存目录只读 `process.env['KIMI_CODE_HOME']`，空则 `join(homedir(), '.kimi-code')`，不读显式 harness `homeDir`（`rgLocator.ts:58-61`）。`~` 展开用 `bootstrap.osHomeDir`（`projectLocalConfigService.ts:187-188`）。

未注册 approval handler 返回 `decision: 'cancelled'`，反馈 `No approval handler registered.`（`packages/node-sdk/src/rpc.ts:530-538`）。`Session.cancel` 只转到 `agent.cancel()`，函数签名是 `Promise<void>`，源码此处没有确认回执或副作用回滚（`session.ts:259-261`，`sdk-rpc-client-v2.ts:2024-2028`）。

纳入与构建（源码声明，本次未执行）：根脚本 `build` 为 `pnpm -r run build`，`build:packages` 为 `pnpm -r --filter './packages/*' run build`（`package.json`）。CI 使用 `pnpm install --frozen-lockfile`（`.github/workflows/ci.yml`）。`@moonshot-ai/kimi-code-sdk` 版本 0.21.1，`private: true`，`exports` 指向 `./src/index.ts`；`publishConfig.exports` 指向 `dist`，但 `private` 仍在。构建脚本 `tsdown && pnpm run build:dts`。`tsdown.config.ts`：入口 `./src/index.ts`，只出 ESM，`dts: false`，`outDir: dist`，`deps.alwaysBundle: /^@moonshot-ai\//`，oauth、oauth/provider-credential、kosong 别名到源码。`build-dts.mjs` 先 `tsc -p tsconfig.dts.json`，再 `api-extractor run --local`。`api-extractor.json` 的 `bundledPackages` 只有 `@moonshot-ai/kimi-code-oauth` 和 `@moonshot-ai/kosong`。`tsconfig.dts.json` 的 `include` 含 `../protocol/src/**/*.ts`；本树没有 `packages/protocol`（`ls` 报 No such file or directory）。这会不会让声明构建失败，本次没有跑构建，不能下结论。

许可：根 `LICENSE` 为 MIT，Copyright (c) 2026 Moonshot AI，允许复制、修改、再分发，但须保留版权与许可声明。`patches/`、`.gitmodules` 不存在。`package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml` 中没有 `patchedDependencies`。没有现成补丁流程。本次未采纳纳入或补丁方案。源码接入至少要带 node-sdk 及其引用的 workspace 包（`agent-core-v2`、`kimi-code-oauth`、`kosong`、`klient`、`kimi-code-product`；`agent-core-v2` 再依赖 `minidb` 与 `tree-sitter-bash`）。dist 接入未验证。

接口缺口与作者摘要一致，并已用上述行号复核，不另增未在本次读到的缺口。

## 这次实际跑过的检查

工作目录 `/Users/liujialin/project/Mesnier`。核对会话的 `node -v` 为 v22.22.0。三个探针环境变量在该进程中均为未设置（只判断是否非空，不读取值）。

| 命令 | 输出要点 |
| --- | --- |
| `git -C /Users/liujialin/project/kimi-code rev-parse HEAD` | `44cdf8f4039e2ff20d3fe8a4e7868bd90fd786e1` |
| `git -C ... rev-parse upstream/main origin/main` | 两者都是同一 SHA |
| `git -C ... cat-file -t 44cdf8f4039e2ff20d3fe8a4e7868bd90fd786e1` | `commit` |
| `git -C ... merge-base --is-ancestor 44cdf8f... HEAD` | 退出码 0 |
| `git -C ... log -1 --format='%H%n%s%n%an <%ae>%n%ci'` | `feat(tui): allow expanding streaming thinking (#4322)`，grapedge \<grapedge@gmail.com\>，2026-10-22 15:35:30 +0800 |
| `git -C ... status -sb` | `## main...origin/main` |
| `git -C ... tag --points-at HEAD` | 无输出 |
| `git -C ... remote -v` | origin `https://github.com/DuskLin/kimi-code.git`；upstream `https://github.com/MoonshotAI/kimi-code.git` |
| `git -C ... status --porcelain=v1 -uall \| wc -c` | `0` |
| `ls` `node_modules` 与 `packages/node-sdk/dist` | 两者都不存在 |
| `ls packages/protocol`、`patches`、`.gitmodules` | 都不存在 |
| `find` 探针目录名 | 只有 `evidence/latest.json` 等源文件；没有 `sandbox/`、没有 `config.toml`、没有 `home-*` / `work-*` |
| `shasum -a 256 .../evidence/latest.json` | `f9bb724525a90d45e731fc2c7b6428929caa068efdd4498deea25dc46e8ecfb8` |
| `stat` 该文件 | 2026-10-22 17:49:52，3203 字节 |

Mesnier `git status --short` 为未跟踪的 `spikes/`，`git rev-parse HEAD` 为 `1639ed5533ca82a3e3571ce0e19449584f50cbcf`。未读 `config.toml`、凭据或 `~/.kimi`、`~/.kimi-code` 的内容。

## 证据文件与退出码

作者给定：依赖安装退出码 1；SDK 构建未运行；接入程序未运行。

`evidence/latest.json` 自称：退出码 2，凭据三项缺失，六个场景均为「未运行」，事件摘要空，目标文件与恢复哈希均为 null，`node版本` 为 `v24.15.0`，上游 HEAD 与工作区字节数 0。这些字段和源码在缺凭据时会写出的形状一致，也和本次环境里三个变量未设置一致。

但它**不能**当成这次接入程序已运行：

- 作者明确写「接入程序退出码：未运行」。
- 磁盘上没有 `sandbox/`。若 `run.mjs` 已导入主程序，缺凭据分支仍会把 `homeDir` 写成 sandbox 路径，但 `prepareRunDirs` 不会被调用，因此**不要求**出现 `home-*`。没有 sandbox 不能单独证明没跑过；它只说明没有凭据齐全路径留下的 home/work。
- 本核对进程的 Node 是 v22.22.0，证据里写的是 v24.15.0。本机存在 `/Users/liujialin/.nvm/versions/node/v24.15.0/bin/node`，`node -v` 为 v24.15.0，但本次没有用它执行 `run.mjs`。
- 没有本次命令的退出码。文件里的 `"退出码": 2` 是 JSON 字段，不是本次进程退出码。

因此：程序没有在本次核对中运行；文件里的成功/退出码声明与「未运行」对不上，相关场景标 **failed**（证据不可作为已执行结果），不标 passed。

## 未运行原因

- **依赖安装**：作者给定退出码 1。本次没有执行 `pnpm install`。参考仓库当前没有 `node_modules`，无法从本次会话复现那个退出码的日志。
- **SDK 构建**：作者给定未运行。本次没有执行 `pnpm build`、`pnpm build:packages` 或 `packages/node-sdk` 的 `tsdown` / `build:dts`。`dist` 不存在。`tsconfig.dts.json` 引用缺失的 `packages/protocol`，构建是否会因此失败未证实。
- **接入程序**：作者给定未运行。本次没有执行 README 中的 `pnpm dlx tsx@4.21.0 ... run.mjs`。当前 shell 也未设置三个 `MESNIER_PROBE_*`。即使按源码缺凭据会退出 2，该退出码也没有在本次发生。
- **会话、turn.ended、Write、拒绝、取消、恢复**：没有运行，没有目标文件，没有前后哈希。源码能描述这些步骤，不能记为通过。
- **个人目录**：未读取内容，未做本次运行前后的元数据对照。证据 JSON 自称未变化，该对照不是本次执行的。

## 任务 1.1 与 1.2

- **1.1 尚未完成**。git 只确认本机 `kimi-code` 的 HEAD、`upstream/main`、`origin/main` 都是 `44cdf8f4039e2ff20d3fe8a4e7868bd90fd786e1`，工作区干净，且无 tag。纳入方式、许可保留方式、依赖安装和派生补丁都没有落实，也没有采纳方案。
- **1.2 尚未完成**。没有在独立配置、数据和日志目录中跑会话、模型调用或文件工具。构建方式、实际模型名、目标文件哈希都没有本次运行证据。
