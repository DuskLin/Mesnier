# 最小探针判定修复验证

日期：2026-10-22。结论：**三类判定缺陷的回归验证通过；SDK、真实模型和桌面应用尚未由本阶段验证。**

本阶段关联 OpenSpec `adopt-kimi-agent-foundation` 的验证工作及 LES-001，属于已发现验收 bug 的修正，不新增产品行为或扩大规格范围。原输入来自主工作区未提交的 `spikes/kimi-sdk-min-probe/`，没有覆盖或修改主工作区原件、参考仓库、真实个人配置。

## 验证版本与环境

- 基准：`1639ed5533ca82a3e3571ce0e19449584f50cbcf`；分支 `codex/mesnier-validation`。
- 验证对象：基准上的新增探针与 `tests/acceptance/`；下表 SHA-256 标识实际文件版本。提交后由提交内容与这些哈希一致性将结果关联到提交。
- 环境：当前 macOS，本机 Node.js `v24.15.0`。测试目录全部由 `mkdtemp` 创建于系统临时目录，普通临时用例结束后删除；变体失败日志保留在运行结果指定目录。
- 本阶段没有 PR，目标分支基线仍为上述提交；没有应用构建、UI 或模型验证结论。

| 文件 | SHA-256 |
| --- | --- |
| `spikes/kimi-sdk-min-probe/probe.ts` | `68722bec9cd3a5ea2a978b4c892868070c0b14cdef86fd15519c609c34ea693d` |
| `spikes/kimi-sdk-min-probe/guards.ts` | `9d1ff0dd79b5f4726972a002609be9a0108ea629a59eca31a4e0031f65b636c0` |
| `spikes/kimi-sdk-min-probe/run.mjs` | `546bfd5e494290289a6cf3c7ba7c40de703611e6f426329905dcdc21557e07ce` |
| `tests/acceptance/probe-regressions.test.mjs` | `90b7a7af452a0ec9b3b2eea21e57002ed364a4f84f7e7c8814af419e76ef8aed` |
| `tests/acceptance/fixtures/probe-child.mjs` | `396d2ff7ce25b2fb4871da60e1dda1f6eca44964ac4151a6e783036e8d03e042` |
| `tests/acceptance/check-regression-mutations.mjs` | `ec98b99ea6333d95fb9063642994e42b2291beee4005234355435d3e8580b66a` |

## 行为修复与证据

| 触发条件 | 修改前 | 修改后与检查 |
| --- | --- | --- |
| 场景成功后收尾检查失败 | `try` 的提前返回值会覆盖 `finally` 的失败码 | 实际 `main()` 在全部收尾结束后返回；父进程观察退出 1，证据也为 1 |
| 初始快照、运行过程、证据写入失败，或仍有未覆盖场景 | 部分失败可能绕过最终证据或被吞掉 | 对应子进程均非零；缺凭据单独保持退出 2 且所有场景未运行 |
| 在受保护目录中原地改写已有配置 | 顶层目录属性可完全不变而漏报 | 临时文件反例证明旧顶层签名相同、新递归快照变化；不读取文件内容、不跟随符号链接 |
| `resumeSession` 返回前重写相同内容 | 内容哈希不变，且订阅太迟 | 恢复前启动工作目录观察；同内容写入哈希相同但元数据变化，判定失败 |
| 只读恢复 | 不能仅因读取而误报 | 读取现有文件后观察结果为无副作用；忽略由读取可能改变的 atime |

实际执行：

```bash
node --test tests/acceptance/probe-regressions.test.mjs
node tests/acceptance/check-regression-mutations.mjs
```

第一条 **13/13 通过**，包含 8 个真实 `main()` 子进程场景及 5 个临时文件场景。第二条在三个独立源码副本中注入提前返回、跳过子文件、忽略恢复副作用，三个对应测试均退出 1 且由 `AssertionError` 失败，未将编译、导入失败或跳过当成捕获缺陷。没有在实际工作区还原错误代码。

`git diff --cached --check` 通过；`openspec validate --all --strict --no-interactive` 检查 1 项通过，仅代表规划格式有效。

自审覆盖新增文件和相对原始探针的完整差异，包括入口调用、返回值、收尾错误、快照边界及 watcher 关闭；不存在真实密钥、生成数据或参考仓库依赖安装。

## 边界与后续

- 递归元数据只能证明该比较时段没有观察到相关属性变化，不能证明文件从未被访问；符号链接指向的外部目录不在覆盖范围。
- 文件事件与元数据从恢复前开始覆盖，后续还核对同一会话身份、工作目录和原生 wire 历史；无重放结论仅覆盖恢复及返回后 2 秒观察窗口。
- 本次子进程替换 SDK 场景执行和个人目录检查，不发模型请求、不读个人凭据；这些是探针判定测试，不是 Kimi harness 集成测试。
- 本机常见模型凭据环境变量未设置，Ollama／LM Studio 常用本地端口未监听。没有据此缩减真实模型验收标准；后续继续接入自有运行时产物及可控协议服务，真实服务验证单独记录。
- 复盘覆盖原验收中三项漏报及本次修复，形成 LES-001 的正确示例；不是新独立日期的事故，不增加发现次数。根 `LESSONS.md` 与 OpenSpec 任务由集成执行者统一更新，不能用本记录替代整体验收或归档。

AI 辅助范围为探针实现、回归用例与自审；独立 Agent 将复核关键差异及后续真实 harness、应用验证。没有声称尚未发生的人工复核。
