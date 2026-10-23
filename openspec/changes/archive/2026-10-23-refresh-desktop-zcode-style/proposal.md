## Why

当前界面带有大面积灰绿色底色，辅助文字大量使用 9～11px，与 Logo 的蓝青主题不一致。用户要求参考本地 ZCode 源码调整实际 APP，包括字号体系与响应式设计。

## What Changes

- 参考 ZCode 的中性分层、紧凑侧栏、独立内容面板与圆角输入框，采用 Mesnier Logo 的蓝色与青绿色。
- 使用 14px 基准与统一文字层级，改善对话、设置、看板和详情的可读性。
- 建立根目录 DESIGN.md 作为长期规范，接入协作与评审入口，并提供语义字号、颜色及文字对比度的静态检查。
- 根据可用宽度保护主内容区；窄窗口的辅助详情独立呈现，工具栏、长内容和表单可换行。
- 保留原有执行、审批、配置及数据契约；不引入 ZCode 依赖或新业务功能，不扩展移动端交付承诺。

## Capabilities

### New Capabilities

- `desktop-visual-system`: 桌面工作台的品牌配色、字号层级与响应式呈现约束。

### Modified Capabilities

无。

## Impact

影响 renderer 样式及必要的展示标记；使用现有 Electron + React 技术栈。通过独立 MESNIER_HOME 的真实 Electron 窗口、已有 UI 套件、类型检查与桌面构建验证。原始参考代码只读，不复制组件或素材。
