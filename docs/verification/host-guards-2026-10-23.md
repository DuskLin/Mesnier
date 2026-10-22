# 准备过程保护与变体复核

日期：2026-10-23。关联 `adopt-kimi-agent-foundation` 任务 6.1。宿主增加准备过程保护后，旧的 `terminal-before-ack` 变体只移除 `starting.size` 已不再破坏串行保证：`preparation` 仍能阻止下一次调度。旧变体退出 0 的结果说明保护已冗余，不能误报为测试漏检或继续宣称它捕获了原缺陷。

本次变体同时移除这两层启动保护，保留其余实现；测试再次因真实行为断言失败并退出 1。五个宿主变体全部按预期失败，且每项都核对 `AssertionError` / `ERR_ASSERTION`，不把 TypeScript 加载失败、超时或信号终止算成捕获缺陷。所有变体先冻结同一份五文件源码快照，并写入 `input-manifest.json`，避免并行改动让各项验证落到不同版本。

实际执行：Node 24.15.0，`--import` 指向集成工作区的 `tsx` loader，`MESNIER_REVIEW_HOST_ROOT` 指向集成目录。

| 命令入口 | 结果 |
| --- | --- |
| `--test tests/host/host-races.test.ts tests/host/process-members.test.ts` | 11/11 通过，退出 0 |
| `tests/acceptance/check-host-mutations.mjs` | 并发冲突、回执不确定、终态早于回执、关闭后重启、转义凭据五变体均被行为断言捕获 |
| `tests/acceptance/check-process-member-mutation.mjs` | 禁用退出成员延续后，真实子进程用例被行为断言捕获，变体退出 1 |

宿主变体证据目录为本机临时目录 `mesnier-host-mutations-hbouFx`，进程成员变体目录为 `mesnier-process-member-mutation-IIatxx`。基准为 `4c8e8a375a0d6ce2863531c6e8692d61f5aabd3a` 加未提交宿主变化，实际输入哈希如下：

| 文件 | SHA-256 |
| --- | --- |
| `workbench.ts` | `e119a2ea2c327115642aeb34d88c48b3ff2e244a38df0910214d01c1e7159c35` |
| `artifacts.ts` | `9eaad697f2856db0cf88d4ce49c364d2263cec24770adbcdc3d9cc048b7d292a` |
| `runtime-client.ts` | `d843018138fe87473044be2c7011e27ee7995e8966ce79039ae1393ffe29802e` |
| `store.ts` | `83004e3985b7c86431570b65746706e30bfdb6d78becdf99fc66977f322a9f33` |
| `process-tracker.ts` | `7a2b3855f17f58686065f9caba85a1618c61fd58e01798d6deaf0f261ef51e52` |

源码副本、日志和本测试创建的进程都使用隔离目录；没有修改宿主源码或清理其他任务资源。本次是实现增加冗余保护后的正常测试维护，沿用“变体必须形成实际缺陷且因行为断言失败”的规则，不将正常调整虚构为新产品故障。
