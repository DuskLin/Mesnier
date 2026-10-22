# 规划文档验证记录

日期：2026-10-22（Asia/Shanghai）。本记录只覆盖规划文档调整，不是 Agent 或应用功能验收。

## 验证对象

- 工作区：`/Users/liujialin/project/Mesnier`，分支 `main`。
- 基准提交：`1f73be09cf2fde31f7455ee7eeb7ea8f5f9c1abf`。
- 版本范围：README、CONTRIBUTING、LESSONS、`openspec/config.yaml` 和本变更目录中的本次规划修改，包含 CLI 生成的 `.openspec.yaml`；下方哈希表标识提交准备版本。
- 本次开始前 README 已有未提交的贡献指南与 PR 模板说明，首轮规划检查在保留该内容的工作区上执行。用户随后授权提交本次规划调整；暂存版本只包含本次规划差异，任务前的 README 补充继续留在工作区，不纳入本次提交。
- 首轮规划检查时未暂存或提交；提交准备检查与其版本差异单独记录。未创建 PR、推送或修改参考仓库。
- 工具环境：macOS 15.7.3 / arm64，OpenSpec 1.8.0；当前只有文档和规划，无应用构建或测试命令。

## 实际检查

### 首轮工作区检查

| 命令或检查 | 实际结果 | 边界 |
| --- | --- | --- |
| `git diff --check` | 通过 | 已跟踪文件的未暂存差异；新增 Markdown 另作空白检查 |
| `git diff --cached --check` | 通过，无暂存差异 | 不表示存在已验证的提交 |
| `openspec validate --all --strict --no-interactive` | 1 项变更通过，0 项失败 | 规格格式与结构检查，不是功能验收 |
| `openspec status --change adopt-kimi-agent-foundation` | proposal、specs、design、tasks 四类规划产物齐备 | 产物完成不代表实施完成 |
| `openspec list --json` | 25 项任务，完成 0 项 | 实施尚未开始 |
| `openspec list --specs` | `No specs found.` | 主规格仍为空，未归档未实现能力 |
| `python3 /tmp/mesnier-kimi-plan-9g8o8oaf/check_docs.py` | 11 份 Markdown，40 个本地引用、8 个标题锚点、9 个源码快照入口均通过；0 个错误 | 源码入口按本地 Git 对象核对，未验证公网可达性 |
| 文档差异与新增文件自行审查 | 已核对分工、首版范围、失败行为、后续任务与规划标记；无应用代码改动 | 非 PR 审查，无 PR head／目标分支基线 |
| 既有改动和参考仓库检查 | 原有 README 贡献说明与目录条目保留；三个参考仓库仍无未提交改动 | 原有补充保留在工作区，不纳入本次提交 |

旧路线用语检查已区分原方案说明与当前目标，README、项目上下文和贡献指南不再将多 CLI 接入或空变更目录表述为当前规划。首版明确串行执行，丰富 Work 工具与并发调度仍是后续路线图。

### 提交准备检查

提交准备先核对首轮的 11 个文件哈希，确认内容没有新增变化，再从 README 暂存版本中排除任务开始前已有的三处文档补充。其余规划内容沿用已审查版本；本记录补充提交范围和检查证据。以 Git 索引快照复查实际提交内容，提交后再核对文件对象一致性。

| 检查与对象 | 结果 |
| --- | --- |
| 从 Git 索引导出的独立快照，执行 `openspec validate --all --strict --no-interactive` | 1 项变更通过，0 项失败；25 项实施任务均未开始，主规格仍为空 |
| `python3 /tmp/mesnier-kimi-plan-9g8o8oaf/check_staged_docs.py /tmp/mesnier-kimi-plan-9g8o8oaf/commit-index` | 11 份 Markdown、37 个本地引用、8 个标题锚点、9 个源码快照入口通过；原有 README 补充仍保留在实际工作区 |
| `git diff --cached --check` 与 `git diff --check` | 通过；暂存清单只有本次 11 个规划相关文件，剩余差异只有任务前的 README 补充 |
| 下表 10 个文件的 SHA-256 与 Git 索引内容比对 | 全部一致；本记录的提交准备说明另行审阅，未改变规格、任务或产品规划 |

## 未覆盖项

- 应用构建、自动化功能测试、真实 Agent／模型调用、界面操作与跨平台运行：不适用，本次没有应用实现；后续验证已列入 [任务清单](tasks.md)。
- 模型认证、OAuth／订阅适用性、内核打包与分发、版本迁移：未执行，须在底座集成阶段验证。
- 外部网页可达性：未逐个在线请求；源码引用按本地仓库内容、完整提交与包含该提交的远端跟踪引用核对。
- 文档架构图仅检查源码关系，未执行独立图形渲染，不代表已有界面或运行结构。

## 工作区、来源与复盘

使用当前目录完成单任务文档调整。验证只读项目文档、Git 状态和参考源码，不启动第三方 Agent，不接触真实模型账号、修改用户配置或执行参考项目安装脚本。临时差异快照和检查脚本位于 `/tmp/mesnier-kimi-plan-9g8o8oaf`，保留供本次结果复核。

参考仓库的完整提交和读取入口见 [设计依据](design.md)。本次没有复制其实现代码或素材；AI 辅助用于源码核对、规划编写与文档检查，并已自行复核当前差异、范围、规格与任务的一致性，用户人工审阅尚未进行。

阶段复盘见 [LESSONS.md](../../../../LESSONS.md)：属于正常规划调整，没有新增事故经验或规则升级。当前保留为进行中变更，未向 `openspec/specs/` 写入已交付规格。

## 文件版本

本表用于标识提交准备版本的实际内容；README 对应只含本次修改的暂存版本，不包含保留在工作区的原有补充。不纳入本验证记录自身，避免自引用哈希；工作区与索引的完整差异快照和哈希清单分别保存在本次临时证据目录，提交后据此核对实际 Git 对象。

| 文件（相对仓库根目录） | SHA-256 |
| --- | --- |
| `README.md` | `42a19a76318ccf893a00a5b98eceb43682c4d6b1323759a39f1d2e4ac4e6ef94` |
| `CONTRIBUTING.md` | `626adb9a17d0fd3a43734dd9635dfebc3fa3e14a0ef90c350438dd2e3a46920e` |
| `LESSONS.md` | `6cc8a31d3caa3cac8b1a318c353adeab3bff5ae8b6a78b8c250eae8496377b98` |
| `openspec/config.yaml` | `75881ee683525c83205687d7e8fd53fabfaca0990e5c6cd50167fa7e796f5a34` |
| `openspec/changes/adopt-kimi-agent-foundation/.openspec.yaml` | `0ad492a63d87e00a8bc135b0a1a2b19270dbb9ffd997a69b89fd4ab72015a944` |
| `openspec/changes/adopt-kimi-agent-foundation/design.md` | `4b10c2b4b22fcacb301851190db3b4feed5e519a6e43aaedc7948d403b2daf39` |
| `openspec/changes/adopt-kimi-agent-foundation/proposal.md` | `398c4c0d8c48ac4fc6710faa2464d87b38c47b1c752e3f7756850ef0a26d6ef0` |
| `openspec/changes/adopt-kimi-agent-foundation/specs/managed-agent-runtime/spec.md` | `8e859e63c1e817ef8dcb98102b18dbd41ee2cf8cfb1e1f22d8de958542c64a87` |
| `openspec/changes/adopt-kimi-agent-foundation/specs/unified-workbench/spec.md` | `1dbc3ef4e12fd2477b2b5454f202b3cfbc72804350848911db4f0a6dc9617f12` |
| `openspec/changes/adopt-kimi-agent-foundation/tasks.md` | `69df50221d1ee1bfcf379320ac0e3e16167c6ba2207a9e8cc2b5ebc48c8baacd` |
