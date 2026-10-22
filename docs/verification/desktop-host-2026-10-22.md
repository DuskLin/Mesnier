# 桌面宿主与工作台初次集成验证

本阶段已建立可实际启动的 Electron 界面与宿主、受控 Bridge、模型设置、版本化产品状态、串行执行调度和产物跟踪。**运行时独立包正在集成，本记录不宣称真实 Agent 或模型端到端验收完成。**

## 验证对象

基准 `e23ab6a` 的完整 SHA 与每个实际源码、构建配置和测试文件的 SHA-256 见 [输入清单](desktop-host-inputs.json)。其中 UI 已提交，宿主与工程文件在该基准上验证后提交。测试环境为 macOS arm64、Node 24.15.0、Electron 41.0.3、Vite 8.0.2、TypeScript 6.0.2。

| 实际命令或步骤 | 结果与范围 |
| --- | --- |
| `npm run typecheck` | 通过，桌面宿主、preload、renderer、共享接口与宿主测试 |
| `npm run build:app` | 通过，主进程/preload bundle 与 Vite renderer 静态资源 |
| `npm test` | 7 项宿主契约测试通过；运行时为受控替身，不能替代真实 harness |
| `node --test tests/acceptance/probe-regressions.test.mjs` | 13 项探针判定回归通过 |
| `node tests/acceptance/check-regression-mutations.mjs` | 三种旧行为均触发预期 AssertionError；日志保留在独立临时目录 |
| `openspec validate --all --strict --no-interactive` | 1 项规划格式通过 |
| 实际 Electron 启动 | 首屏成功渲染，`.evidence/ui/welcome.png`；尚未完成全部交互 |

Electron npm 安装遇到连接中断，使用官方 release 同版本 ZIP 下载并核对官方 SHA-256 `d8aeeb263b234a243411e02b3828e9349fe976417798334cba9f34f6eae28d7e` 后准备二进制。初次解包未保留 macOS framework 符号链接，实际启动捕获 dyld 错误，改用 `ditto` 保留链接后 `electron --version` 返回 41.0.3；没有把解包成功当作应用启动成功。此过程只操作本工作区依赖目录。

初步 UI 脚本在含步骤数字的“配置模型”按钮定位超时，这是测试定位问题，已转由独立 UI Agent 使用准确可访问名称执行完整流程；不记为流程通过。

## 行为与隔离

宿主测试覆盖同请求去重、对话关联任务不重发、串行队列与凭据快照、有效权限回应、取消等待确认、失败保留与新执行重试、恢复历史不自动重放、文件失效/符号链接逃逸、未来数据版本拒绝覆盖、模型工具调用检查和旧测试结果不覆盖新配置。用量缺失不写成零。生产默认目录为 `~/.mesnier`；测试根为各自 `mkdtemp` 目录，没有借用个人 Kimi 配置或认证。

运行时超时的交叉审查要求先确认专属 worker 进程组结束，再继续调度；相应独立竞态回归由验收 Agent 提交，后续集成记录其精确版本。所有子进程与测试服务仅属于本任务。

本阶段不能证明真实模型、真实文件工具、安装包或重启后的全部 UI 流程；这些由 OpenSpec 未完成项持续跟踪。仓库普通合并被 main 规则拒绝，未使用管理员绕过参数，工作继续留在任务分支。

## 复盘

探针 LES-001 已依据真实子进程回归更新正确示例。本阶段正常工程集成中出现的解包和测试定位问题已修正；发现超时后并发风险及关闭后不能重启的缺陷，按独立回归处理并在后续验证中确认，没有把单元测试当成平台或模型验收。
