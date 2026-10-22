# Kimi SDK 最小接入阶段验收

日期：2026-10-22（Asia/Shanghai）。结论：**未通过，任务 1.1、1.2 仍未完成。** 当前交付包含探针代码和静态核对材料，但尚无 SDK 接入和真实模型场景通过的证据；探针还存在会影响验收结论的判定缺陷。

## 审查对象与范围

- Mesnier 基准提交：`1639ed5533ca82a3e3571ce0e19449584f50cbcf`，分支 `main`。
- 审查对象：工作区未跟踪的 `spikes/kimi-sdk-min-probe/`、原执行者的核对文档，以及现有任务 1.1／1.2；文件版本见文末。
- Kimi Code 基线：`44cdf8f4039e2ff20d3fe8a4e7868bd90fd786e1`，本地参考仓库干净。
- 没有对应 PR，因此无 PR head 或目标分支审查基线。本次不验收尚未实施的桌面应用、看板或其他后续功能。
- 原始探针、原证据和任务勾选均未修改；本次仅新增独立验收记录并按项目约定更新经验记录。

## 阶段结果

| 验收内容 | 结论 | 依据 |
| --- | --- | --- |
| 定位并核对源码基线 | 已确认 | 本地 HEAD 与探针固定 SHA 一致，参考仓库无改动 |
| 源码纳入、许可保留、依赖和补丁方案 | 未完成 | 现有材料列出源码事实，但尚未采用可构建、可复现的集成方案 |
| 独立探针与缺凭据分支 | 部分完成 | 在隔离副本实际执行，缺凭据退出 2，六个场景全部记为未运行 |
| SDK 导入与会话建立 | 未通过启动前置验证 | 用非真实凭据进入前置路径，导入 SDK 时退出 1，无会话创建 |
| 真实模型、文件工具、权限拒绝、取消、恢复 | 未验证 | 没有实际模型请求或工具执行；原证据中事件为空、目标文件与恢复哈希为 null |
| 探针通过判定的可靠性 | 未通过 | 收尾退出码、个人目录变化检查和恢复重执行检查均复现了漏报 |

原执行者的 [核对记录](kimi-sdk-min-2026-10-22.md) 第 5、73、74 行也明确注明任务未完成。原 `evidence/latest.json` 的六个场景均为“未运行”；它不能证明真实接入已通过。本次没有依据认定该文件的生成过程，也不把“缺凭据时可以运行”当作“已接入 SDK”。

## 阻塞与发现

### P1：SDK 依赖与可重复运行入口尚未落实

入口在 [probe.ts](../../../../../spikes/kimi-sdk-min-probe/probe.ts) 第 423 行按包名导入 `@moonshot-ai/kimi-code-sdk`，但探针的 [package.json](../../../../../spikes/kimi-sdk-min-probe/package.json) 没有声明该依赖，当前工程也没有可解析的依赖安装。上游仓库不存在 `node_modules` 和 SDK `dist`。

在独立副本中使用 Node 24.15.0，传入仅用于进入前置路径的假凭据及本机回环地址，进程实际退出 1，证据报 `Cannot find package '@moonshot-ai/kimi-code-sdk'`，六个场景仍未运行。README 的 `pnpm dlx tsx` 只提供 TypeScript 执行器；切换工作目录不会自动把另一个目录里的探针变成上游 workspace 成员，指定的 tsconfig 也没有 SDK 路径映射。

需要确定并实现源码或构建产物的纳入方式，建立探针可解析的依赖关系，在隔离副本中给出从准备依赖到启动的实际命令和日志。参考仓库保持只读不应替代隔离环境中的构建验证。当前缺少专用模型凭据，因此这项修复之后仍需真实模型验证。

### P1：收尾检查失败可能仍以退出码 0 结束

[probe.ts](../../../../../spikes/kimi-sdk-min-probe/probe.ts) 第 673–674 行在 `try` 内返回当前 `exitCode`；`finally` 第 687、693、698 行即使把失败码改为 1，也不会修改已经求值的返回值。第 705–706 行又用该旧返回值覆盖 `finally` 设置的 `process.exitCode`。

本次用原 `main` 和最外层赋值代码，在真实子进程中注入“前面场景成功、结束时校验失败”，结果为：

```json
{"actual_child_exit":0,"reported_exit":1,"reported_failure":"受控注入：结束时隔离校验失败"}
```

这会让调用方把失败检查视为成功，也会导致证据字段和进程结果冲突。应在收尾检查结束后统一确定返回值和进程退出码，并验证收尾失败、未覆盖场景和证据写入失败都能使最外层进程非零退出。

### P2：顶层目录元数据不能证明已有配置文件未被修改

[probe.ts](../../../../../spikes/kimi-sdk-min-probe/probe.ts) 第 223–228 行只采集目录本身的 mtime、ctime、inode 和 size，第 254–255 行据此给出“未变化／未写入”。原地改写目录中的已有文件通常不会改变这些目录属性。

本次只在临时目录演示：改写其中已有的 `config.toml` 后，文件哈希发生变化，而从原函数取得的目录签名保持相同。没有读取或修改真实个人配置文件。应在专用测试目录或受控环境中核对实际文件访问和写入，或针对需要保护的文件做适当快照，不能把顶层目录签名等同于内容未变化的证据。

### P2：恢复检查会漏掉恢复期间的同内容重写

[probe.ts](../../../../../spikes/kimi-sdk-min-probe/probe.ts) 第 618 行先等待 `resumeSession` 返回，之后才订阅事件；第 620–632 行只等待短时间内的新 `turn.ended` 并比较文件内容哈希。恢复调用期间已经完成的操作、未在窗口内结束的回合，以及同内容重复写入，都可能逃过检查。

本次提取原恢复判定代码，用受控替身在 `resumeSession` 返回前重写一次相同内容，探针仍给出：

```json
{"writesDuringResume":1,"verdict":"通过","hashUnchanged":true}
```

应从恢复开始前持续观测相关事件或工具／文件副作用计数，核对恢复的会话身份和历史，再用可区分重复执行的证据判断是否重放。哈希相同只能证明最终内容相同，不能证明没有再次写入。

## 本次实际执行的检查

验证目录为 `/tmp/mesnier-kimi-acceptance-avv8m1eh`，探针副本与复现脚本均位于该目录。使用 `/Users/liujialin/.nvm/versions/node/v24.15.0/bin/node`；没有安装或构建上游依赖。

| 命令／操作 | 实际结果 | 证明范围 |
| --- | --- | --- |
| Node 24.15.0 执行 `missing-credentials/run.mjs`，移除三个探针凭据变量 | 实际退出 2，证据退出 2，六个场景未运行 | 仅缺凭据分支，未导入 SDK |
| Node 24.15.0 执行 `unresolved-sdk/run.mjs`，使用假凭据、假模型名和 `http://127.0.0.1:9/v1` | 实际退出 1，SDK 包不可解析，无事件 | 仅导入前置失败，无真实模型请求 |
| `node check-verdicts.mjs` | 复现目录内容变化漏报和恢复同内容重写假通过 | 提取实际判定代码并替换依赖，属于隔离模拟，不是 SDK 功能验证 |
| `node reproduce-exit-code.mjs`，由父进程捕获返回码并读取生成的证据 | 子进程退出 0，证据记录退出 1 | 使用原 `main` 控制流的失败注入，无真实模型或个人数据修改 |
| 审查前后输入文件 SHA-256 比对 | 被审查的 8 个文件均未变化 | 本次结论绑定文末版本，未覆盖另一版本或其他工作区 |

本次未执行 README 中需要 `pnpm dlx` 的下载入口。直接使用本机 Node 的 TypeScript 支持测试前置路径，不将其表述为原构建链路已验证。没有真实模型凭据，模型能力、工具执行及会话恢复的真实结果仍未覆盖；没有实际构建，不能仅凭 tsconfig 中一个不存在的 include 路径推断构建一定失败。

## 后续动作

1. 在隔离源码副本中落实任务 1.1 的纳入、依赖、许可和补丁方案，提供可重复的构建及探针启动入口。
2. 修复探针的退出码和证据判定，保留上述失败注入，确认探针能捕获目标问题。
3. 使用专用模型凭据完成会话、真实文件工具、权限拒绝、取消和恢复，记录模型、版本、命令退出码、事件及实际文件证据。
4. 补齐记录后重新验收任务 1.1／1.2；当前不勾选任务、不归档。修复由后续执行者认领，本次未修改被审查实现。

## 输入版本

完整差异快照、运行输出和复现脚本保留在本次验证目录。以下 SHA-256 标识实际审查的工作区文件：

| 文件 | SHA-256 |
| --- | --- |
| `spikes/kimi-sdk-min-probe/run.mjs` | `e6b01c9c937f043e13cbbcf0578a3c2e249770d9caa302f833b4e77216dda982` |
| `spikes/kimi-sdk-min-probe/probe.ts` | `00d11f3ef927dfca3dcb43dac644dcb47e59f6ed0692ed4a3734be474ffbf3bc` |
| `spikes/kimi-sdk-min-probe/README.md` | `ff9e3ac9d7e89cf536db074d0dc429ee5a1d34c949e66b3865c9e2db3c5f2454` |
| `spikes/kimi-sdk-min-probe/.gitignore` | `16ade858735e56162c392264fcbb3e56334a63fa8ab51456e956454ec5860799` |
| `spikes/kimi-sdk-min-probe/package.json` | `609158e6c5fbc237939fa3ddf7faab80ab690bdc0c8d584414a885130103c4e8` |
| `spikes/kimi-sdk-min-probe/evidence/latest.json` | `f9bb724525a90d45e731fc2c7b6428929caa068efdd4498deea25dc46e8ecfb8` |
| `openspec/changes/adopt-kimi-agent-foundation/verification/kimi-sdk-min-2026-10-22.md` | `cd58df4908111aac58c813b67a2481c883a5aae363823c0fed52382bd50a13e0` |
| `openspec/changes/adopt-kimi-agent-foundation/tasks.md` | `69df50221d1ee1bfcf379320ac0e3e16167c6ba2207a9e8cc2b5ebc48c8baacd` |
