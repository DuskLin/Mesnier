# 真实 SDK 协议验收与宿主竞态复核

日期：2026-10-22。**真实 Kimi harness 的六项协议场景通过；宿主五项竞态回归通过。此阶段模型是受控 HTTP 服务，不是真实推理模型，也不是桌面 UI 验收。**

本阶段延续 `adopt-kimi-agent-foundation`。验证 Agent 仅修改独立验证 worktree 的探针、fixture、回归与文档；宿主修复由集成 Agent 完成，本报告复核其实际源码。真实本地模型与桌面界面继续独立验收。

## 真实 SDK 与受控 HTTP 模型

入口：`node tests/acceptance/run-sdk-probe.mjs`。本次以 `MESNIER_PROBE_SDK_PATH` 指定运行时 worktree 产出的 `packages/runtime/dist/sdk.mjs`，Node.js `v24.15.0`。探针使用独立 `homeDir`、`osHomeDir`、配置、会话、工作目录与日志；只在回环随机端口运行本次 HTTP 服务，结束后关闭。

受控模型仅生成 OpenAI SSE 协议响应。`Write`、权限、取消和恢复均由实际 SDK 与上游工具链执行，没有由宿主补写目标文件。

| 场景 | 实际结果 |
| --- | --- |
| 会话建立 | 原生会话位于本次隔离 home 的 sessions 子目录 |
| 模型请求 | 真实 harness 访问 HTTP 服务并消费流式响应，收到 completed |
| 文件写入 | 模型发出 Write；批准后得到成功 tool.result，文件哈希为 `b62aa37a01573d989b2e41f96394428cd520b6ecb86cb83d2bdfcb5819ca5acb` |
| 权限拒绝 | 真实请求到达 handler，被拒绝的目标没有落地 |
| 生成中取消 | 先收到 assistant.delta，再调用取消；确认 cancelled，已写文件保留 |
| 恢复 | 同一会话与工作目录；恢复前至返回后 2 秒无文件事件、元数据变化、新回合或 wire 历史变化 |

实际子进程退出码与证据均为 **0**。服务共收到 **5** 次请求：写入和后续结果各一次、拒绝及后续结果各一次、生成中取消一次。此前一轮发现 fixture 把追加的 user 提醒误识别为当前任务，探针正确失败；修复 fixture 后重新执行。没有将该失败记录覆盖为通过。

完整记录保留于本次系统临时目录 `mesnier-sdk-acceptance-e27xVI` 的 `result.json`、`evidence/latest.json`、原生会话与 `logs/child.log`。运行前后构建文件哈希一致：

| SDK 构建文件 | SHA-256 |
| --- | --- |
| `sdk.mjs` | `2e9fa58d9f5fdbe12a626f5a7ab41b4db868828f5c72b3529a1911ba3099383c` |
| `src-DBKf4H_u.mjs` | `eb4061d2952c7fcfbba3238759124a86bc6fada7a9b38d25af65f354d0d0a232` |
| `webp-dec-wasm-BXLYAgbk.mjs` | `c116adfa2fd0e1aa895899ae0376b861390d674dab5b65c5246e6f0693000d46` |

## 宿主竞态交叉复核

验证对象为集成 worktree 基准 `e23ab6a9b7230d997a5013eff23d2a3badc06c93` 上的未提交宿主文件。当前阶段没有对应已审查 PR head；不是对之后任意提交的自动背书。

| 文件 | 实际测试 SHA-256 |
| --- | --- |
| `apps/desktop/src/main/workbench.ts` | `d76aa71d00656dd81a5dc770170ac73539e662d36c0788aa1f8021826702b295` |
| `apps/desktop/src/main/runtime-client.ts` | `851b088b28c7d52f460ef2cd874d03f39df227f2e1e75a8a4b574d0013b3ccec` |
| `apps/desktop/src/main/store.ts` | `3ce77defddc94fce1390c4bdf83ef8e359b56897c2ce038bd82a5a2dfd974b94` |
| `apps/desktop/src/main/artifacts.ts` | `9807ed4f3500fb9ac904e4fe7cb8a61146d249bc81569e707ca6efca1064b009` |

通过 `MESNIER_REVIEW_HOST_ROOT` 指向被审查 worktree，使用其实际 `tsx` loader 执行 `node --import tsx --test tests/host/host-races.test.ts`。测试前后以上源码哈希一致，**5/5 通过**；完整日志与文件版本位于本次系统临时目录 `mesnier-host-review-hlt_7gb9`。

- 并发相同 requestId、不同正文：仅一条成功，另一条明确报冲突。
- run 回执超时但执行状态不确定：先停止并确认旧 worker；期间下一条保持排队，之后才继续。
- 终止事件先于 run 回执：回执尚未结束时不提前发起下一次执行。
- 应用关闭时正在扫描产物：等待扫描和终态落盘，已生成文件记录不丢失。
- 实际 RuntimeClient 子进程关闭后重新 info：新进程 PID 不同，旧 PID 已不存在。

`node --import tsx tests/acceptance/check-host-mutations.mjs` 在独立副本分别移除冲突核对、旧 worker 停止、启动回执互斥和关闭标志复位。四个变体均由对应行为断言失败，退出 1；没有用导入或类型错误冒充捕获问题。日志位于本次系统临时目录 `mesnier-host-mutations-gfxHar`。另已重跑探针 13 项回归及三项判定破坏变体，仍通过预期检查。

## 复盘与边界

发现并推动修复的宿主问题是：超时不等于运行停止、关闭不等于永久不可启动，以及异步入口必须重复核对请求身份。新增回归覆盖其实际调用链；本阶段独立子进程测试不证明完整操作系统沙箱或无限时段无副作用。

SDK 来源、许可证与可分发依赖由运行时交付记录追踪；上述报告只记录本次实际运行版本。UI、安装包、真实模型 Work/Coding 结果尚不在本阶段结论内。根经验记录与 OpenSpec 任务状态由集成执行者统一更新，不能只因本报告通过就归档整体变更。

AI 辅助用于源码审查、测试、fixture 和文档；不同执行 Agent 分别实现宿主并进行交叉验证。没有声称未发生的人工复核。
