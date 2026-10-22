# Kimi SDK 最小接入探针

该探针覆盖会话、模型、文件工具、权限拒绝、取消和恢复。已接入 Mesnier 构建的真实 SDK，并以受控 HTTP 模型验证全部六个场景。受控模型不具备真实推理能力，不能代替真实模型或整个应用的验收。

## 运行判定回归

要求 Node.js 24 或更新版本，在 Mesnier 根目录执行：

```bash
node --test tests/acceptance/probe-regressions.test.mjs
node tests/acceptance/check-regression-mutations.mjs
```

第一条覆盖真实 `main()` 子进程的退出码与证据一致性、缺凭据、证据写入失败、已有配置原地改写和同内容重写；不会导入 SDK、访问模型或读取个人配置。第二条仅在临时副本中恢复提前返回、忽略子文件、漏报重写等错误，并要求对应测试因行为断言失败；输出保留日志的临时目录。

## 运行模型探针

入口默认使用 `packages/runtime/dist/sdk.mjs` 和同目录构建分块。可以通过 `MESNIER_PROBE_SDK_PATH` 指向另一份已构建的 SDK；这仅用于隔离验证，不把参考仓库作为构建依赖。旧版 `pnpm dlx tsx` 命令不再使用，参考仓库保持只读。

运行受控 HTTP 模型与真实 SDK 的六场景验收：

```bash
node tests/acceptance/run-sdk-probe.mjs
```

该命令创建独立临时目录与回环 HTTP 服务，结束时停止本次服务、保留证据，并核对 SDK 构建文件在运行前后没有变化。模型响应由本地 fixture 产生，文件与工具执行由真实 Kimi harness 完成。取消场景须先收到流式输出，避免只验证尚未开始生成的取消。

直接连接外部模型时，凭据仅从 `MESNIER_PROBE_API_KEY`、`MESNIER_PROBE_BASE_URL`、`MESNIER_PROBE_MODEL` 读取，不写入代码或提交证据。运行入口为 `node spikes/kimi-sdk-min-probe/run.mjs`：缺任一变量时不导入 SDK、不访问模型，生成 `evidence/latest.json` 并退出 2；SDK 不可解析或任何场景失败时退出 1。可用 `MESNIER_PROBE_OUTPUT_ROOT` 指定本次输出目录；受控服务须设置 `MESNIER_PROBE_MODEL_KIND=controlled`，其他服务也须在独立报告确认来源。退出 0 不单独证明整个产品已交付。

探针上游基线为 `44cdf8f4039e2ff20d3fe8a4e7868bd90fd786e1`。当前基线检查仍只读本机参考仓库，尚不是可分发运行时的验收入口。

## 隔离和恢复判定

入口在 SDK 导入前设置 `KIMI_DISABLE_TELEMETRY=1` 和独立 `KIMI_CODE_HOME`；创建 harness 时，`homeDir`、`configPath`、工具工作目录均使用本次 `sandbox/` 下的独立路径，不运行 CLI 或 legacy 迁移。

个人目录对照递归采集目录项的 `lstat` 元数据（含 inode、纳秒级 mtime/ctime、大小与模式），不读取文件内容，也不跟随符号链接。它能捕获已有配置原地改写，但只能表述为“未观察到元数据变化”，不能证明从未访问或绝对没有写入；无权读取或遍历期间发生异常时判失败。

恢复前先启动整个工作目录的文件事件与递归元数据观察，再调用 `resumeSession`。恢复后核对会话身份、工作目录、原生 wire 历史和新回合事件，覆盖返回前完成的同内容重写。结论仅覆盖恢复开始前至返回后 2 秒的观察窗口，不能对未来无限时段作保证。

所有收尾检查完成后统一返回退出码。证据写入失败会输出无敏感信息的错误并退出 1；不再静默吞掉错误。`sandbox/`、`evidence/` 与 `node_modules/` 均被忽略。
