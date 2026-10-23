# 本地真实模型 Work / Coding 验证

日期：2026-10-23（Asia/Shanghai）。本记录关联 `adopt-kimi-agent-foundation` 的任务 **1.2、6.2**，补充真实模型推理与真实文件工具证据。它不替代任务 6.3 的打包应用界面验收。

## 实际结果

完整回合于 `2026-10-22T17:40:31.104Z` 开始，`17:45:56.993Z` 结束，验收进程退出 0，`passed=true`、`runtimeUnchanged=true`。

| 场景 | 真实执行及判定 |
| --- | --- |
| 普通非 Git Work 目录 | Qwen 自主调用 `Read(facts.txt)`，经审批调用 `Write(report.md)`；周报包含北极星、搜索筛选 13 项、导出 8 项、总计 21 项、离线文档待办 |
| 隔离 Git Coding 项目 | 初始三个测试失败；模型 `Read → Edit → Bash` 后得到 2 通过、1 失败，继续 `Edit → Bash` 后三个测试全部通过；两次 Edit 和两次 Bash 均经过审批 |
| 独立核验 | 宿主重新执行原有 `summary.test.mjs`，退出 0；测试文件哈希未变，Git 只显示 `summary.mjs` 修改 |
| 输入版本与结束 | 对运行时目录全部普通文件及三个宿主源文件做前后 SHA-256 比较，共 23631 项完全一致；运行时关闭成功 |

模型修复了统计逻辑，但生成的源码保留了一个不可达 `return`，缩进也不规整。本记录证明任务循环、工具调用、审批和功能测试闭环，不将这个样例描述为代码质量审查通过。

## 模型、运行环境和边界

- 实际模型为 [Qwen3-4B-Instruct-2507](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507) 的 [Unsloth Q4_K_M GGUF](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF)，量化仓库固定提交 `a06e946bb6b655725eafa393f4a9745d460374c9`，Apache-2.0；文件大小 2497281120 字节，SHA-256 为 `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597`，下载后已校验。
- 推理使用 [llama.cpp b11796](https://github.com/ggml-org/llama.cpp/releases/tag/b11796)，提交 `0a1ef309cdbb9f2024f58a38fb4c42352c5db569`，macOS arm64 发布归档 SHA-256 为 `3be4c64b4303be0d17120400482545e70fc3c01de7fd2389150c5573f55f13fa`。服务仅监听 `127.0.0.1:65050`，上下文 32768，启用 Jinja 工具模板，关闭 reasoning。
- 这是下载后的真实权重本地推理，没有为提示词预置工具调用结果，没有使用个人 API 账号或云模型凭据。模型权重、推理程序、缓存和日志均位于本任务独立目录，未作全局安装。
- 实际链路为验收入口 → 宿主 `RuntimeClient` → 分发 `bin/node` / `worker.mjs` → 锁定 Kimi SDK / harness → 本地模型 → Read / Write / Edit / Bash。Node.js 24.15.0，SDK 0.21.1，上游提交 `44cdf8f4039e2ff20d3fe8a4e7868bd90fd786e1`，darwin/arm64。
- profile、HOME、XDG 配置、会话、工作目录和日志均隔离。未调用系统安装的独立 Agent CLI；本轮父进程 PATH 未收窄，不能据此声称整台主机未安装 CLI。打包应用验收应继续使用仅系统工具的 PATH 补充环境边界证据。
- 本轮 Git 样例初始化未禁用用户 Git 配置；未操作远端或账号，所有 Git 写入仅在新建样例目录。后续仓库内入口已显式禁用系统/用户 Git 配置、模板及 hooks，避免把临时工作目录误当成完整配置隔离。

## 验证对象与文件证据

集成工作区基准为 `4c8e8a375a0d6ce2863531c6e8692d61f5aabd3a`，包含当时未提交的运行时与宿主修改，不将结果归属于干净基准提交。关键实际文件 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `build/runtime/worker.mjs` | `c6bea9a81361647a345cae3dfeccc4125dc138f5e6ede69e49efa7ece65cc189` |
| `build/runtime/bin/node` | `3200fbd9f7fd4410426dd541e10d1ab829d3472f270d743c7fabd1696c03fe32` |
| `runtime-client.ts` | `d843018138fe87473044be2c7011e27ee7995e8966ce79039ae1393ffe29802e` |
| `process-tracker.ts` | `7a2b3855f17f58686065f9caba85a1618c61fd58e01798d6deaf0f261ef51e52` |
| `store.ts` | `83004e3985b7c86431570b65746706e30bfdb6d78becdf99fc66977f322a9f33` |
| 当时实际执行的验收脚本 | `3503a25a561025325fdfa07bec05408ccce4730a6e7739b1f0cf6c5396b9885a` |

完整证据根目录为 `/Users/liujialin/Documents/Codex/2026-10-22/mesnier-local-model-yzmhc4j_`。该目录的 `manifest.json`、`download-result.json`、`server.json` 保存模型来源、校验和启动命令。本轮结果位于其子目录 `mesnier-real-model-rgEoI5`：

| 相对此轮目录的路径 | 证据 |
| --- | --- |
| `result.json` | 两回合身份、事实断言、Git diff、完整输入哈希和结束判定 |
| `events.json` / `approvals.json` | 实际模型、工具、进程及权限事件；审批包括 1 次 Write、2 次 Edit、2 次 Bash |
| `runtime.log` / `run-real-model.used.ts` | 运行日志与实际执行脚本快照 |
| `work/report.md` | SHA-256 `d21b33a6bee50f6ab69aac070a0c329f6216235902bd5f84ca61500fd9e9f19f` |
| `coding/summary.mjs` | 最终修改，SHA-256 `91a6b1926e1411959239e9fe07dbaddd91b8fc7590203321eacef2941cfa523c` |
| `coding/summary.test.mjs` | 原测试保持不变，SHA-256 `947bc39c4d8d4df6a9e08078612147d89042afc4d866c57eba4d6212d4d5c837` |
| `coding-before.log` / `coding-after.log` | 独立 Node 测试失败与通过输出 |

实际执行命令使用 `tests/acceptance/run-real-model.ts`，通过 `MESNIER_REVIEW_HOST_ROOT` 指向集成工作区，`MESNIER_RUNTIME_NODE` / `MESNIER_RUNTIME_WORKER` 指向上表分发文件，`MESNIER_REAL_BASE_URL=http://127.0.0.1:65050/v1`、`MESNIER_REAL_MODEL=mesnier-local-qwen3-4b`、`MESNIER_REAL_SCENARIOS=full`；启动器为 Node 24.15.0 加集成目录的 `tsx` loader。

后续提交的验收入口补充 Git 配置隔离、审批及修改文件范围断言、入口与基准版本记录。该入口通过严格 TypeScript 检查；新增审批与文件范围断言也已针对本轮实际证据通过，但没有把未重新执行的入口版本冒充上述真实回合的脚本版本。

## 后续版本沿用与未覆盖项

后续 Workbench 的准备过程和关闭竞态修复不改变此轮直接 RuntimeClient 成功调用链；本记录可继续证明对应版本的模型和工具闭环，不能替代那些竞态的宿主测试。后续 worker 的用量可用性修复须由该修复回归及最终打包 UI 真实任务绑定新 worker，不能把本轮 worker 哈希改写成新值。

本轮不覆盖云模型认证、Windows/Linux、签名与公证、完整复杂工程正确率，也不覆盖所有模型的工具调用质量。取消、拒绝和恢复的受控服务证据见其他验收记录，不在本记录中重述为真实模型场景。模型服务暂留供打包应用验收，之后仅按该任务保存的 PID 和命令核对清理。

本阶段复盘发现的是测试隔离需要覆盖 Git 配置来源，以及验收脚本和被测运行时必须分别绑定版本；它们属于已有隔离和版本记录规则的具体落实。模型自行经历测试失败后修复是预期任务循环，不作为产品故障教训。
