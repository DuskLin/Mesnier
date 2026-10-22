# 工具进程退出成员快照验证

日期：2026-10-23。宿主进程归属与清理契约的五项真实子进程测试通过；运行时自动上报成员的端到端证据由运行时验收补充。

先前独立反例是：注册进程组 leader 时尚无后代，随后 leader 在同组创建长期运行的子进程并退出。旧 `exited()` 与 `cleanup()` 因无法匹配初始 identities 而报错，后代仍在运行。复现仅涉及本测试创建的进程，随后已用核对过的自有进程组清理。

新契约由运行时退出回调提供同组 `{ pid, pgid, born }` 元数据；宿主只接受已有 started 记录、相同 pgid/runId，并按当前出生时间核对。验证文件为 `tests/host/process-members.test.ts`，通过独立回调数据驱动实际 `ProcessTracker`，所有待观察进程都是本测试创建。

| 场景 | 实际结果 |
| --- | --- |
| leader 先退出，真实同组后代快照 | 保持组归属并停止该后代 |
| 退出事件 pgid 错误 | 明确拒绝；另一组测试进程仍活跃 |
| 未登记 PID 提交退出快照 | 未创建归属；另一组测试进程仍活跃 |
| born 与当前进程不符 | 清理拒绝，未向未知身份发信号；另一组测试进程仍活跃 |
| runId 与已登记执行不同 | 明确拒绝；另一组测试进程仍活跃 |

`node --import tsx --test tests/host/process-members.test.ts` **5/5 通过**。独立 worktree 通过 `MESNIER_REVIEW_HOST_ROOT` 指向集成目录，使用其实际 `tsx` loader；Node.js 为 `v24.15.0`、当前 macOS。`ps` 元数据统一采用 `LC_ALL=C`、`LANG=C`、`TZ=UTC`。所有测试进程在 teardown 中按本测试记录的组归属清理，没有清理其他会话或模型服务。

`node --import tsx tests/acceptance/check-process-member-mutation.mjs` 在临时源码副本中禁用退出成员延续，首项测试因行为断言失败并退出 1，证明该用例能够捕获先前的真实问题；日志位于本次系统临时目录 `mesnier-process-member-mutation-UxkiOk`。被验证 `process-tracker.ts` 的 SHA-256 为 `7a2b3855f17f58686065f9caba85a1618c61fd58e01798d6deaf0f261ef51e52`，不将其自动套用到其他版本。新增测试严格 TypeScript 检查通过。

本阶段不声称任意脱离组的守护进程都可自动追踪，也不将普通进程组观察等同操作系统沙箱。等待真实运行时 observer 上报验证后，再由集成执行者统一更新 OpenSpec 与经验记录。
