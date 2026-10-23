# 运行时与最终分发交叉审查（2026-10-23）

本记录由运行时执行者独立审查桌面宿主和分发产物后整理。修改在专属 worktree 完成，未改写集成工作区；安装包签名和原生界面结果只引用实际检查对象。

## 审查范围与版本

- 宿主：`main/index.ts`、`store.ts`、`workbench.ts`、`runtime-client.ts`、`process-tracker.ts`、`artifacts.ts`，以及 preload 和 shared 协议。
- 宿主修复后基准：`be1db630936093d155a150eba9fe37086c75bd4a` 加未提交源码；上述 8 文件的路径／SHA-256 清单组合哈希为 `1060b2f47fee803111282e81b74bd91e0ee5da920e66dcbe20e64fdc8eacb138`。回归使用冻结的实际源码副本，避免检查期间的并发改动改变结论。
- 打包脚本首次审查基准：`8c24fab64fc474acde995c52897b3c3a85d0ac4b` 加当时未提交的 `package.json`、`scripts/package.mjs` 和宿主修复。最终安装对象与哈希在本记录后续部分单独记录。
- 运行时来源：Kimi Code `44cdf8f4039e2ff20d3fe8a4e7868bd90fd786e1`，SDK `0.21.1`，内核 `0.5.1`，Mesnier 运行时 `0.1.0`，Node.js `24.15.0`。

## 已复现问题与修复验证

| 触发条件 | 修复前实际结果 | 修复与证据 |
| --- | --- | --- |
| 初始工作区扫描等待时退出应用 | `close()` 返回后仍向 worker 发送 `run`；运行记录已经是 `interrupted` | 准备阶段登记 AbortController 和 Promise，异步返回后复查状态，退出等待准备结束；独立回归通过 |
| 扫描等待时另一操作保存失败 | 标记中断、关闭运行时后，扫描续体仍发送 `run` | 保存失败同时取消准备，禁止继续执行；独立回归通过 |
| 入队保存成功，下一次保存 running 状态失败 | 脱离调用链的 Promise 拒绝使严格模式 Node 子进程退出 1 | 准备阶段的状态保存纳入受控捕获；子进程退出 0、没有发出 `run`，保留中断错误 |
| 模型流没有提供 usage | 上游把缺失值记为全零，UI 显示 `0 tokens` | 仅在供应方返回 usage 时记录；缺失、真实零值、含缓存的正数、恢复会话但当前缺失四类真实协议回归通过 |
| 应用仍位于仓库下启动 | 包内运行时借用父目录的开发依赖，看起来可启动 | 将初版运行时复制到仓库外后实际退出 1，提示缺少 `smol-toml`；包内只有 13 个文件，来源目录有 23,628 个。修复后在 `afterPack` 完整复制并逐文件核对闭包，安装对象实查 23,639 个文件，无缺失，真实文件工具通过 |

宿主回归为 `tests/host/host-review.test.ts`，修复前 3 项均能捕获原问题，修复后 **3/3 通过**。第三项在独立 Node 子进程使用 `--unhandled-rejections=strict`，没有以本测试进程的异常监听掩盖崩溃。源码修复与测试提交分别由集成执行者和本审查者保留。

用量修复提交为 `6d8eaf032ff23d4c1a5906118c546c46baa7dfe3`。在专属分发目录实际执行 `MESNIER_TEST_RUNTIME_ROOT=./build/runtime node --test packages/runtime/test/rpc.test.mjs`，**18/18 通过**，包括真实 harness 的审批、拒绝、恢复、取消、凭据隔离、Bash、进程组收尾和管道断开。模型响应来自本地受控 HTTP/SSE 服务，这些结果不代表真实模型推理质量。

## 来源与许可

执行 `node scripts/prepare-runtime.mjs --verify-sources`，实际校验 **1431 个上游文件和 19 个派生补丁文件**。另把 19 份已修改源码复制到独立临时目录，反向应用完整 patch，逐文件重新计算 SHA-256，全部恢复为清单中的原上游哈希。原上游哈希与派生后哈希分别保留；后续升级不能把派生代码当成原始基线。

运行时依赖闭包实查 294 个包实例。代码、资源及包内已有 LICENSE／NOTICE／README 声明随闭包保留。以下两项 npm 发布包没有附完整正文，已补充：

| 依赖 | 固定来源 | 原文 SHA-256 |
| --- | --- | --- |
| `standardwebhooks@1.1.1` | `standard-webhooks/standard-webhooks` 提交 `b4d2c14fc5b4ccff3ff271e3b087dff812254c59` 的 `libraries/LICENSE` | `5ec8c7b26b64d881a6706617bed25c049f97f2f35de034c756de8546fd6dbe27` |
| `parse-bmfont-ascii@1.0.6` | `mattdesl/parse-bmfont-ascii` 提交 `5f22b037ae7460f629dd681db23cd9b543a76b06` 的 `LICENSE.md` | `59c38e93a395817bc9d674d868af7c062fcea8b37468af8b3f6f075133eb1756` |

两份文件的 Git blob SHA 与上游响应一致，npm 完整性值与锁文件一致。`standardwebhooks` 使用库目录的 Svix MIT 声明，不能用仓库根目录的 Apache 文本代替。构建校验实际依赖版本和许可原文哈希后再分发，见 [补充许可清单](../../vendor/third-party/manifest.json)。

`data-uri-to-buffer`、`@tokenizer/token` 和 `omggif` 的 README／源码已经包含完整 MIT 正文；`exif-parser` 虽未在 package metadata 标注 license，其 `LICENSE.md` 有完整声明。Jimp 的 Open Sans 字体目录含 Apache 许可，Lucide 的许可同时保留 ISC 和 Feather MIT 部分。没有把缺少顶层 `LICENSE` 文件名直接当成缺失声明。

最终安装包的 `app.asar` 实查 106 个包、107 条许可／NOTICE 路径；唯一没有第三方许可的包是本项目自己的 `@mesnier/shared`。Electron、Chromium、Node 和 Kimi 许可在 Resources 中另行保留。补充许可和 Kimi README、原始来源清单、完整派生 patch／manifest 随最终运行时分发，路径为 `runtime/licenses/third-party/` 与 `runtime/provenance/kimi/`。已安装文件的两份补充许可、五份 Kimi 来源文件以及 Electron／Chromium／Kimi 三份许可，与对应源码逐字一致。

## 安装依赖与结论边界

应用携带自己的 Node、内核代码、运行依赖和 `node-pty` 原生文件，不要求预装 Kimi CLI 或启动开发服务器。macOS 自带的 shell、`/bin/ps` 和基本命令仍是运行环境的一部分；用户任务需要的 Git、Python、包管理器及项目工具不因此自动获得。

ripgrep 没有预装在分发闭包中。沿实际 Grep／Glob 工具入口核对，两者显式启用缓存／下载回退：先查 PATH，再查隔离目录缓存，必要时下载固定 `15.0.0` 并校验归档 SHA-256；下载失败返回实际工具错误与安装指引。因此首次无缓存使用可能需要网络，不能宣称搜索完全离线。另一条 `workspaceFs` 路径未开启该回退，不能用这一内部入口推断所有搜索工具都要求预装系统 `rg`。本审查未实际执行无缓存下载。

IPC 的命令白名单、精确本地页面 URL 和主 frame 检查，preload 的上下文隔离、沙箱，以及模型凭据引用的保存顺序已沿实际调用链核对。宿主静态审查和受控协议测试不替代真实 Electron、安装后启动、系统钥匙串或商业模型服务验收。

临时签名的 `codesign --verify --deep --strict` 检查只能说明被检查包的签名资源完整性，不等于 Developer ID 身份或 Apple 公证。其他 macOS 机器、Windows 和 Linux 不在本次平台验收内。

## 最终安装对象

实际检查对象为从本次 DMG 安装的 `/Applications/Mesnier.app`。执行时集成仓库 HEAD 为 `083cc125bb1ffb14512c07ecea5cbcd4f2649fef`；打包相关实际文件 SHA-256 如下，记录包含当时未提交修改的版本：

| 文件 | SHA-256 |
| --- | --- |
| `package.json` | `d6501909e79c75bed914ab5a0720c64a54e5d2ce57f75b57cdb683d10b299b4c` |
| `scripts/package.mjs` | `346f32603c124c676dac1e29fbcf3c2bab14f1c334f115f720004f69eebf3122` |
| `scripts/prepare-runtime-distribution.mjs` | `0b264cdf8b2e8b5ea78dbc4686aca262cdeabdb3a0443927c2806d845b63435e` |
| `scripts/prepare-runtime.mjs` | `4f20498e8dc81fe471c5ffb949f29ec675dd7cd64859e1f27c3e4c801d09d04a` |
| `scripts/verify-packaged-runtime.mjs` | `db55bd8ecd3518251a12c57194ab448e897b13d1adfab1cbb1d7f233509ef3fb` |

安装目录的运行时拥有 23,639 个文件，文件路径集合与当前分发来源完全一致。逐文件计算哈希后，仅 Node 和 `node-pty` 的 arm64／x64 `pty.node`、`spawn-helper` 共五个原生文件因签名发生变化；其余文件一致。分发清单中的 `nodeSha256` 是签名前来源的 `3200fbd9f7fd4410426dd541e10d1ab829d3472f270d743c7fabd1696c03fe32`，不能直接用于核对签名后的 Node；后者实际哈希见下表。

| 安装或发行文件 | SHA-256 |
| --- | --- |
| `Contents/Resources/app.asar` | `2717594effe5d5f98be5e23e66c21d183f75d33f16576293b937b899dfb02711` |
| `runtime/worker.mjs` | `c6bea9a81361647a345cae3dfeccc4125dc138f5e6ede69e49efa7ece65cc189` |
| `runtime/src-vuWx5mvs.mjs` | `cbe73e15c0685931d47b8fd1d42c9bf6f6ddde780d93c8d8cf12f90779a9d03b` |
| `runtime/bin/node`（签名后） | `db2ca2f9572b678c2b8c1dcaa4ced246b3b7b7c6fcbc9b34700de1f10fab0a63` |
| `Mesnier-0.1.0-arm64.dmg` | `982752e5663d9c8ad7fa74e57da2df64a7644298e80a6b75b75d95356722cc79` |
| `Mesnier-0.1.0-arm64-mac.zip` | `82d026c63e4ae2ec8f3aa2632791aac4482765a446869faefa6bb46828769f8c` |

实际执行的安装复验：

1. 以安装目录内 Node 运行 `rpc.test.mjs` 的真实内核写入／会话恢复场景。worker 的 cwd、HOME、XDG 和临时目录均为专属测试目录，PATH 只有包内 Node 目录及系统 `/usr/bin:/bin:/usr/sbin:/sbin`。`info`、Write 审批前不落盘、批准后真实文件内容、原生会话恢复、重复执行拒绝和凭据扫描全部通过；测试退出 0。
2. 在独立目录直接加载安装包的 `node-pty`，实际创建 `/bin/sh` PTY，收到预期标记并确认退出 0。测试没有启动用户登录 shell 或读取真实用户配置。
3. 对随包 Node、arm64 `pty.node` 与 `spawn-helper` 执行 `otool -L`，依赖仅为 macOS 系统框架和 `/usr/lib` 动态库，没有 Homebrew 或构建机目录路径。
4. 执行 `codesign --verify --deep --strict /Applications/Mesnier.app`，退出 0，返回 `valid on disk` 和满足 designated requirement；读取签名确认为 `adhoc`，未设置 TeamIdentifier。

本审查范围内没有剩余安装运行时或许可保留阻断项。真实模型 Work／Coding、桌面交互和 LaunchServices 启动由对应验收记录说明；本记录没有把受控模型测试当成真实模型验收，也没有把临时签名当成公证。
