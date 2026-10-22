# 第三方内容与来源

Mesnier 自有应用代码的开放源码许可证尚未确定。第三方内容继续适用各自许可证，不因应用改名而改变来源、版权或使用条件。

## Kimi Code

内置执行内核基于 `MoonshotAI/kimi-code` 提交 `44cdf8f4039e2ff20d3fe8a4e7868bd90fd786e1`，使用 MIT 许可。源码范围、原始文件哈希与必要派生补丁见 [vendor/kimi](vendor/kimi/README.md)；许可证保留在 [vendor/kimi/LICENSE](vendor/kimi/LICENSE)。没有复制上游桌面应用或 CLI，也没有包含上游账号、订阅和云服务权益。

SDK、执行循环、模型适配、权限决策、工具与原生会话仍来自这份源码基线。Mesnier 的必要差异包括数据与身份隔离、私有凭据传递、进程观察、显式权限规则接线、Bash 工作目录修正和用量缺失语义，均保留可复核补丁。

## 桌面和运行依赖

应用使用 Electron 41.0.3、React 19.2.4、lucide-react、react-markdown、remark-gfm 及其依赖，固定解析版本见根 `package-lock.json`。Electron 与 Chromium 的许可正文随安装包保存到 `Contents/Resources/licenses/`；前端依赖的许可证随 `app.asar` 内的依赖目录保留。

独立执行进程使用 Node.js 24.15.0。Node 和 Kimi 许可证、构建中内联的 ajv / ajv-formats 许可证随 `Contents/Resources/runtime/licenses/` 分发。其他运行依赖连同包自身的许可证、版权说明与资源复制到 `runtime/node_modules/`；`runtime/distribution.json` 记录实际依赖版本与位置。

少数 npm 包未附完整许可正文时，固定来源与补充正文存放在 [vendor/third-party](vendor/third-party/README.md)，并随运行时分发。构建不得仅依赖包的 `license` 名称代替必要的许可正文。

## 参考与素材

ZCode 用于功能和交互研究，Multica 用于看板与任务组织参考。本版没有复制这两个项目的产品代码或素材，也不宣称继承其全部能力。

应用图标来自仓库已有的 `assets/brand/mesnier-logo.png`，生成说明保留在同目录的 `logo-prompt.txt`。本次仅转换为 macOS 图标格式。

验收使用的 Qwen 模型与 llama.cpp 属于独立测试环境，不随 Mesnier 安装包分发，不会成为用户首次启动的默认模型配置。
