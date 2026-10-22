# Mesnier Agent 运行时

本包用 Kimi Code v2 的真实 `createKimiHarness` 执行会话，通过独立 Node.js 24.15.0 子进程向桌面宿主提供 JSONL RPC。源码基线和补丁见 [vendor/kimi](../../vendor/kimi/README.md)。

## 入口与协议

安装根工作区依赖后执行 `node scripts/prepare-runtime.mjs`，生成可直接随应用分发的 `build/runtime/`（Node 实体二进制、入口、分块、独立依赖闭包、许可证和来源）。`--bundle-only` 只构建源码分块，`--verify-sources` 只校验来源。源码构建入口是 `packages/runtime/dist/worker.mjs`；`sdk.mjs` 供隔离验收直接加载真实 SDK，`engine.mjs` 提供运行时实现。所有分块和公共依赖须一起分发。

[src/protocol.ts](src/protocol.ts) 是宿主的协议入口：每行一个请求 `{id,method,params}`，响应为 `{id,result}` 或 `{id,error:{code,message}}`，事件为 `{event:{id,runId,kind,at,payload}}`。标准输出只用于协议，其他诊断写标准错误。

方法包括 `info`、`run`、`approve`、`cancel`、`shutdown`。`run` 返回接收确认，最终状态由 `run.completed`、`run.failed`、`run.cancelled` 表示，接收确认不代表模型已完成。一个 worker 只运行一个活动任务；重复的 `runId` 在该 worker 生命周期内拒绝，宿主仍须持久化去重。

`session.ready` 返回可供后续显式提交使用的原生会话 ID；恢复不自动重发旧 prompt，工作目录不匹配时拒绝执行。当前不开放运行中追加指令；工具问卷会明确提示暂不支持并交回模型，用户可在下一次提交补充。

## 数据、认证和权限

宿主传 `profileRoot`（正式应用为 `~/.mesnier`，测试为临时专属目录）；SDK 使用其 `agent/` 子目录保存配置、会话、缓存、日志等。`osHomeDir` 和显式 Skills 目录也指向该隔离范围。运行时不会默认导入现有 Kimi 配置、账号或会话。

模型协议入口支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic；这是接入接口，不代表所有供应方已经验证兼容。`apiKey` 只从 stdin 进入独立进程的 bootstrap 私有内存，`config.toml` 只保存 `MESNIER_RUNTIME_API_KEY` 引用，`process.env` 不保存该值，因此工具进程不会继承；宿主历史配置不得包含密钥值。运行时在供应方 HTTP 错误进入内核之前脱敏，并关闭可能含原始错误的上游诊断日志，只向产品转发经过当前密钥脱敏的结构化事件。真实密钥不应出现在普通日志、配置快照或截图中。

`manual` 使用内核手动权限；`auto` 明确启用内核 yolo 模式。审批只接受当前运行中未处理的请求，批准/拒绝只对该次请求生效。取消确认来自内核回合结束；已经写入的文件不会因取消自动回滚。内核关闭失败会以失败结果上报，不保留先前的成功结果。

## 进程边界

宿主应在 POSIX 使用 `spawn(..., {detached:true})` 建立专属进程组，在关闭时先请求 `shutdown` 或发送 SIGTERM。上游 Bash 工具还会建立各自进程组，`process.started` / `process.exited` 从实际 Bash 与 PTY 创建入口报告 PID / PGID。宿主超时兜底必须覆盖已记录的工具子进程树，不能只根据 worker 或工具 leader 消失认定全部停止。Windows 须使用对应的进程树终止机制。只处理本任务创建的进程，不能终止其他 Agent。

stdin 关闭或收到 SIGTERM/SIGINT 时，worker 会取消活动回合、失效待审批请求并关闭真实 harness。宿主意外退出、强制终止或超时后保留执行为中断/待核对，不能仅根据子进程消失宣称用户取消成功。

工具操作不是沙箱。内核可能使用系统 shell、Git、ripgrep 或后续配置的工具；缺少依赖时按实际错误显示。首版验证覆盖本地文本文件与基础 shell，不自动获得浏览器、Office 或插件市场能力。

## 验证

构建后执行 `node --test packages/runtime/test/*.test.mjs`。测试用随依赖安装的 Node 24.15.0 启动真实 worker，连接独立本地 HTTP/SSE 协议服务，配置、文件、日志和进程均使用专属临时范围。覆盖实际文件放行、拒绝、重复审批、取消、错误、恢复、旧配置隔离、stdin 退出与凭据扫描。

这些测试执行真实 Kimi harness 和工具，模型响应由可控协议服务产生；不能当作真实模型推理质量、商业模型兼容或其他操作系统验收。真实模型凭据与远端服务验证需独立记录。
