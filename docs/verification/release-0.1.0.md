# Mesnier 0.1.0 发行验收

当前状态：本机 macOS 安装与功能验收通过，真实模型、安装版界面、失败控制和数据隔离分别有证据。源码合入 main 仍被仓库规则阻止，未绕过。

## 版本与交付对象

- 平台：当前 Mac 的 Darwin 24.6.0 / Apple Silicon，Electron 41.0.3，内置 Node.js 24.15.0。
- 应用名称与版本：Mesnier 0.1.0；应用标识 `app.mesnier.desktop`；默认数据根 `~/.mesnier`。
- 代码与构建脚本版本：`083cc125bb1ffb14512c07ecea5cbcd4f2649fef`。后续仅验收/使用文档更新，不改动这份安装包。后续追加验收脚本与报告不进入应用运行代码。源文件与安装对象的可核对输入见 [发行输入清单](release-inputs.json)。
- Kimi 来源：`44cdf8f4039e2ff20d3fe8a4e7868bd90fd786e1`，1431 个基线文件、19 份必要派生补丁；原文件与补丁后哈希分别校验。
- 已安装到 `/Applications/Mesnier.app`；DMG 和 ZIP 的最终哈希如下。

| 产物 | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| `Mesnier-0.1.0-arm64.dmg` | 219322655 | `982752e5663d9c8ad7fa74e57da2df64a7644298e80a6b75b75d95356722cc79` |
| `Mesnier-0.1.0-arm64-mac.zip` | 222068627 | `82d026c63e4ae2ec8f3aa2632791aac4482765a446869faefa6bb46828769f8c` |

完整运行时目录在签名前与来源逐文件核对 **23,639 项完全一致**，签名后仅五个原生文件发生预期变化；最终完整目录摘要为 `2befdff516bb5a40ee7cdbdbfd6b1ab62a2b0407afee9f6f57fa8b9218200451`。详细文件清单随本机交付物的 `acceptance/installed-runtime-files.json` 保存，清单本身哈希见发行输入。

`runtime/distribution.json` 的 Node 哈希描述签名前构建来源；签名后实际 Node 为 `db2ca2f9572b678c2b8c1dcaa4ced246b3b7b7c6fcbc9b34700de1f10fab0a63`，不要将两者误判为同一校验对象。

## 实际验证矩阵

| 范围 | 实际执行结果 | 证据 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` 通过 | 本机 Node 24.15.0，最终宿主与新增测试 |
| 宿主契约 | `npm test` 24/24 通过 | [生命周期](host-lifecycle-2026-10-23.md) |
| 真实 Kimi harness | `npm run test:runtime` 18/18 通过；模型为受控 HTTP/SSE 协议服务 | [运行时交叉审查](runtime-crossreview-2026-10-23.md) |
| 探针修复 | 13/13；原来的退出码、目录隔离、恢复副作用判定均有负向回归 | [探针记录](probe-guards-2026-10-22.md) |
| 破坏性回归 | 探针 3、宿主 5、进程成员 1 个变体均被目标行为断言捕获 | [宿主门禁](host-guards-2026-10-23.md)、[进程成员](process-members-2026-10-23.md) |
| 真实桌面交互 | 17 个行为场景通过；包含模型、Chat/Board 同记录、权限、失败、取消、恢复、验收、产物及用量 | [UI 验收](../../tests/ui/verification-2026-10-23.md) |
| 真实模型推理 | 本地 Qwen Work 周报与 Coding 修复通过；原测试未改，模型读取失败结果后修复到 3/3 通过 | [真实模型](real-model-2026-10-23.md) |
| 实际安装 | DMG 校验并挂载，复制到 `/Applications` 后严格签名检查通过 | 本机 `acceptance/launchservices/result.json` 与分发审查 |
| 系统启动 | `/usr/bin/open` 经 LaunchServices 启动，PATH 仅系统工具，真实页面来自安装目录，Agent ready=true | 首屏 AX 和持久化状态一致；无模型、无演示执行 |
| 安装版独立内核 | 仅系统 PATH 和独立 HOME，Write 审批、真实文件、恢复、重复拦截、凭据扫描及 PTY 通过 | [分发审查](runtime-crossreview-2026-10-23.md) |
| 安装版真实模型 UI | 真实 Qwen 读取→写入审批→实际 Markdown→Board 待验收→明确完成→重启保留记录；约129秒，退出0 | [安装版 UI](../../tests/ui/packaged-verification-2026-10-23.md) |
| 来源与许可 | 上游1431文件、19补丁反向恢复、294依赖实例、补充MIT、Node/Electron/Chromium逐字核对通过 | [第三方说明](../../THIRD_PARTY_NOTICES.md)、分发审查 |
| OpenSpec / Git | 两份主规格严格验证、完整 PR 差异空白检查通过；28项任务完成并归档 | 结构检查不代替功能验收 |

## 安装检查中发现并修复的问题

初始开发包没有重新签名，严格检查失败；已使用本地临时签名并重新生成安装包。没有使用个人开发者证书，也没有 Apple 公证。

初版打包器默认过滤运行时的 node_modules；在仓库里启动会误用祖先目录开发依赖，从而掩盖缺包。仓外实测以缺少 `smol-toml` 失败。修复改为在 afterPack 完整复制已解析闭包，签名前逐文件哈希核对，再从 DMG 安装到 `/Applications` 进行真实运行验证。该缺陷已纳入 LES-004。

## 隔离、边界和未覆盖项

所有测试模型配置、用户目录、会话、工作文件和日志位于专属目录；不复用 `~/.mesnier`、Kimi 或 ZCode 个人数据。原工作目录的既有未提交探针/经验文件保持原状，代码开发和交叉审查分别使用托管 worktree。真实模型是专用下载的本地 Qwen 权重，未使用个人 API 账号；首次 Git 样例的用户配置隔离边界及后续修正见真实模型报告。

当前未覆盖原生目录选择器和 Finder 窗口的实际点击：安装首屏可读取，但 Mac 锁定后无法继续原生输入，未绕过锁屏。通过界面直接输入项目路径的流程已验证。云端供应方认证、Intel Mac、Windows、Linux、其他机器 Gatekeeper 与公证、无缓存离线搜索均未验证。

没有 GitHub Actions 工作流，不将本地检查写成 CI 通过。主分支规则 `main-owner-only` 阻止普通 PR 合并；已保留 PR 和完整提交，不修改规则或使用管理员绕过。这个仓库合并阻塞与已安装应用的运行结果分别记录。

当前只交付本机 macOS 安装包。Git、Python、项目构建器等用户任务依赖不随应用自动安装；Grep/Glob 缺少 ripgrep 时可能联网获取固定校验版本。首次使用需自行配置模型，测试模型没有预置到正式用户数据。

本任务的验收 Electron 实例、内置 worker 和专用 llama.cpp 服务已按记录身份停止；模型权重与证据保留在独立目录。已安装应用保留，首次正常启动使用自己的空白配置。备份、恢复与操作步骤见 [使用说明](../使用说明.md)。
