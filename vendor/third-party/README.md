# 补充第三方许可

这里保留运行时依赖发布包遗漏的完整许可正文。原 npm 包中的代码、元数据和已有声明保持不变；应用分发额外携带这些文件。

| 依赖版本 | 固定来源 | 对应许可 |
| --- | --- | --- |
| `standardwebhooks@1.1.1` | npm `gitHead`：`b4d2c14fc5b4ccff3ff271e3b087dff812254c59` | 上游 `libraries/LICENSE`，适用于 JavaScript 库的 MIT；仓库根目录的 Apache 2.0 文件属于另一层级，不能替代库目录的声明 |
| `parse-bmfont-ascii@1.0.6` | npm `gitHead`：`5f22b037ae7460f629dd681db23cd9b543a76b06` | 上游 `LICENSE.md`，MIT |

[manifest.json](manifest.json) 记录版本、来源 URL、提交、Git blob、原文 SHA-256 和 npm 包完整性值。许可文件逐字保留原始英文正文和版权，不改写为通用模板。构建时核对实际依赖版本与正文 SHA-256，再复制到 `runtime/licenses/third-party/`；版本变化时必须重新核对来源。

其余运行时依赖保留 npm 包自带的许可文件或 README／源码声明。`data-uri-to-buffer`、`@tokenizer/token` 和 `omggif` 已在包内保留完整 MIT 正文，无须重复补充。完整分发依赖列表由 `runtime/distribution.json` 记录；本目录只记录已确认的遗漏项。
