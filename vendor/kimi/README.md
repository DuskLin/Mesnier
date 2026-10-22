# Kimi Code 内核来源与维护

Mesnier 从 `https://github.com/MoonshotAI/kimi-code` 的固定提交 `44cdf8f4039e2ff20d3fe8a4e7868bd90fd786e1` 纳入最小 SDK 依赖闭包。原 MIT 许可证保留在 [LICENSE](LICENSE)，上游版权及源码中的声明不变。应用名称是 Mesnier，内置运行时名称是 Mesnier Agent；不提供上游官方账号、订阅或云端权益。

## 纳入边界

保留 `node-sdk`、`agent-core-v2`、`klient`、`oauth`、`product`、`kosong`、`minidb`、`tree-sitter-bash` 的 `src/`、`package.json`、`tsconfig.json` 及上游根 TypeScript 配置，共 1431 个基线文件。未纳入上游 CLI、桌面应用、服务端、网站、完整测试目录或开发服务；有些包在 `src/` 中包含测试和其他资源，保持原目录结构，不做无关删改。

[upstream.json](upstream.json) 记录仓库、提交、SDK/内核版本、包列表及每个基线文件的 SHA-256。上游内部包名仅用于源码构建与来源追踪，产品界面不直接依赖这些包名。

## 派生补丁

[patches/mesnier-isolation.patch](patches/mesnier-isolation.patch) 是本基线的完整源码差异；[patches/manifest.json](patches/manifest.json) 同时记录原始和修改后的文件哈希。补丁范围为：

1. SDK 的 `KimiHarnessOptions` / `SDKRpcClientV2Options` 增加 `osHomeDir`、`displayName` 和私有 `env`，透传到已有 bootstrap 参数。
2. `HostEnvironmentService` 采用 bootstrap 的显式用户目录；显式目录与系统 home 不同时，不执行用户登录 shell 获取 PATH。这样通用用户指令、Agent 文件发现与 Skills 不会绕过 SDK 的数据隔离。
3. 核心的项目品牌目录和缺省品牌目录从 `.kimi-code` 改为 `.mesnier`，包括项目配置、指令、Agent、Skills、MCP、文件监视排除和 ripgrep 回退目录。项目显式的通用 `AGENTS.md` 仍可使用；不会自动信任项目 MCP。
4. 模型目录与认证就绪检查使用 bootstrap 的私有环境读取 API key 引用，避免把模型凭据放进可被 Bash、PTY、MCP 或插件子进程继承的 `process.env`。
5. bootstrap 增加可选进程观察回调，在 `HostProcessService` 和 `HostTerminalService` 两个实际创建入口报告 PID / PGID 及退出，不传输命令和环境。宿主据此清理 worker 之外的工具进程组。
6. 权限规则服务合并已解析的用户 `permission.rules` 与原有运行时规则，补齐上游 v2 只解析配置却未接入规则服务的缺口。Mesnier 通过配置要求 Write / Edit / Bash 单次审批，继续使用原有 policy 优先级。
7. Bash 的工作目录前置使用独立 `cd ... || exit $?` 行，避免用户命令含 `&` 时把 `cd` 一起放入后台，导致后续命令在错误目录产生文件。
8. 仅在供应方实际返回用量时记录统计，保留缺失与真实零消耗的区别；恢复会话的历史累计值不作为当前回合用量。

不改模型请求、工具循环、权限判定、会话持久化与取消机制。认证、循环能力与平台兼容仍需按实际执行验证；补丁中的路径隔离不是操作系统沙箱，得到授权的本地工具仍可访问工作机器。

## 构建与分发

Mesnier 的 [构建脚本](../../scripts/prepare-runtime.mjs) 解析已纳入源码的上游导出，并内联 `?raw` 文本资源。`ajv` / `ajv-formats` 一并打包，修正上游深层导出在原生 Node ESM 中缺少扩展名导致的加载失败，其他第三方依赖通过 Mesnier 的锁文件安装。运行时代码与依赖清单位于 [packages/runtime](../../packages/runtime/README.md)。

构建不读取本机参考仓库，不从浮动分支下载源码，不调用用户预装的 Kimi CLI。构建后保留 `dist/` 的所有分块；只复制入口文件会导致加载失败。分发同时携带 Node.js 24.15.0、公共依赖以及 `node-pty` 的目标平台二进制，不能把 Electron 的 Node ABI 当作运行时 ABI。

## 升级步骤

先在独立目录确定上游提交和依赖闭包，重新记录原文件哈希，再重放并复核补丁；不将当前已修改文件当作下一版的原始基线。构建后验证真实 harness 的会话创建/恢复、文件工具放行/拒绝、流式响应、生成中取消、模型错误、进程退出和配置隔离。真实模型服务与未运行的平台必须单独保留未验证状态。最后审查许可证、依赖锁文件、完整源码差异和旧会话兼容性，更新来源与验证记录。
