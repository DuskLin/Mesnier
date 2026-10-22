# 转义凭据与审批证据补强

日期：2026-10-22。本阶段补充了实际错误路径的回归，不改变 OpenSpec 的整体交付范围。

## 转义凭据

原宿主对错误正文仅按原始凭据字符串替换。实际启动回环 HTTP 服务，以包含引号和反斜杠的假凭据返回 JSON 编码的 401 错误，`testModel()` 的返回消息中仍保留了转义形式。新回归“模型错误正文中的 JSON 转义凭据也必须脱敏”在原实现上因目标断言失败，未使用真实凭据。

集成执行者将 `Secrets.redact`、执行快照密钥和连接检查期间的旧密钥统一交给 `redactCredential`，按较长形式优先替换原始、URL 与三层 JSON 转义。修复后 `tests/host/host-races.test.ts` **6/6 通过**。将 JSON 形式处理从独立源码副本移除后，新测试再次由 `AssertionError` 失败；宿主五个破坏变体均达到预期。

当前版本的执行记录位于本次系统临时目录 `mesnier-credential-review-e8av_58w`，变体日志位于 `mesnier-host-mutations-ryCKyi`。测试对象为集成分支基准 `c4fd5015f59aed929d983e7068db614316441382` 上的未提交源码；运行前后文件哈希一致：

| 文件 | SHA-256 |
| --- | --- |
| `apps/desktop/src/main/store.ts` | `aa0d53d2d1d7f24cefd98cf24ef3e7d011dd0ba5348a46c2d44c627f887b06a6` |
| `apps/desktop/src/main/workbench.ts` | `eed6f9048f6aaf5f0cfe131c67ae911c231a2790a9208f49b1bf5abbe837dde7` |
| `apps/desktop/src/main/runtime-client.ts` | `9b3463d88b51ea83325977767f28162191d4d9bd73a46ce6a842ce5ef3e05bcd` |
| `apps/desktop/src/main/process-tracker.ts` | `fc354a2246de9b9fa271db85e622d53f9338fcf36af7d2229b1f2f6b6b381e13` |

实际命令（独立 worktree 运行时通过 `MESNIER_REVIEW_HOST_ROOT` 指向集成目录，并使用该目录的实际 `tsx` loader）：

```bash
node --import tsx --test tests/host/host-races.test.ts
node --import tsx tests/acceptance/check-host-mutations.mjs
```

这不是任意编码形式的安全证明。共享 HTTP fixture 还增加了 200 SSE 流内错误与 `echoCredential`，供运行时验证错误进入原生 wire 历史之前的脱敏；其结果由运行时专项报告记录，本报告不代替该检查。

## 审批证据

探针首个文件操作现在同时要求：实际收到预期路径的审批、handler 批准、成功的 Write 工具结果和目标文件哈希。审批摘要加入证据，不能仅凭写入成功就宣称审批链路通过。

加强后重新运行 `node tests/acceptance/run-sdk-probe.mjs`：六场景仍通过，实际与证据退出码均为 0。记录位于本次系统临时目录 `mesnier-sdk-acceptance-73YUjS`；摘要明确为 `probe-write.txt → approved`、`probe-rejected.txt → rejected`，SDK 文件在执行前后保持一致。

本探针使用普通非 Git 目录。UI 在 Git 项目中发现的自动允许写入属于另一条策略路径，不能拿此结果代替；运行时执行者正在按产品要求显式配置 Write／Edit／Bash 的询问策略，并追加 Git、非 Git 和恢复后场景。共享 fixture 新增 `edit` 序列：真实 Read 后再发 Edit，以覆盖编辑工具的前置读取要求。

## 复盘

可复用规则是：错误脱敏须覆盖实际编码与持久化入口；审批验收须断言收到并处理请求，并区分目录类型与恢复状态。根 `LESSONS.md` 由集成执行者统一维护。本阶段只使用任务创建的目录、回环 HTTP 与假凭据，没有读取或更改个人账号配置。
