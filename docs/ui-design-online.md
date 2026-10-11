# UI 设计平台在线提交

这条流程面向独立 UI 设计平台；平台副本沿用原 AI 图层编辑器界面和原生保存链。插件从工作区上传已完成的标准正文、真实素材/字体和证据包，平台验证、保存并发布。现有本地 PSD/FGUI 工具另行保留，平台目标导出仍待实现。

## 连接与准备

在平台 `/ui-design/connect` 为有权编辑的设计建立 `design.read` / `design.submit` 连接，使用一次性配对码在本地运行 `c2c ui-design connect --server <平台地址> --pairing-code <配对码> -w <工作区>`。端点只由本地配置决定；MCP 参数不能重定向凭据。Windows 凭据使用当前用户 DPAPI，模型只得到连接范围和过期时间。

1. `ui_design_platform_spec` 和 `ui_design_online_protocol` 核对实际规范、摘要与能力。共享包 0.3.0、在线协议 1.1.0；作者格式仍为 0.1.0。
2. `ui_design_context` 获取当前原生序号/hash 和标准修订，再用 `ui_design_checkpoint` 固定准确状态。
3. `ui_design_submission_begin` 绑定 checkpoint、base revision 与稳定 request UUID，返回 submission ID。为完整文件清单写入这个 ID，保持正文/清单/文件摘要一致。
4. 在工作区完成原图、采用定稿、PNG 素材、实际字体、完整预览、总览与来源记录。`ui_design_precheck` 可检查本地结构和字节，不能替代平台验证或发布。

## 提交与恢复

调用 `ui_design_submit`，传入 design ID、submission ID、document/manifest 路径及包目录。插件先核对整个包，再补传缺失文件；平台完整解码、冻结依赖、原生 bridge 往返和投影、独立重建及图片差异测量后，条件导入原生历史并提交标准修订。

需要分步处理时使用 `ui_design_submission_upload`、`ui_design_submission_validate`、`ui_design_submission_commit`。验证 ID 固定到该候选的正文、清单和 bridge。当前导入要求原生活动编辑通道关闭，且原生 checkpoint、标准 head 未变化；未发布原生修改不会被覆盖。

成功结果必须是共享协议校验通过的持久 `COMMITTED` 回执，包含准确正文/清单摘要、标准修订、原生 checkpoint 与重建图。`BUNDLE_STORED`、本地预检和验证 PASS 都不代表正式保存。使用 `ui_design_submission_status` 恢复未知结果；重复相同 submission/validation 身份返回原回执，不产生第二次导入。取消只允许未提交候选，并保留已经接收的文件。

当前断点恢复粒度是完整文件，单文件上限 64 MiB、整包 256 MiB、最多 2048 项；尚不支持字节范围补传。发生版本冲突时读取新 context，保留原候选与原生草稿，不能自动换基线并声称旧候选仍已验证。

## 原生编辑后的再次发布

原生编辑会正常保存到原生历史。读取最新 context 并固定 checkpoint 后，调用 `ui_design_publish_native`，提供稳定 request UUID、checkpoint 和已发布 base revision。支持的文本/位置等编辑将投影为新标准修订；不支持的结构、富文本或视觉变更会拒绝发布并保留原生草稿。

原生发布回执的 origin 为 `NATIVE_DRAFT`、`nativeImported=false`、`published=true`、`submitted=true`。它不会新增原生编辑事务。重复同一请求返回原修订；要发布之后的新改动，使用新 checkpoint 和 request UUID。

`ui_design_revision` 返回固定正文、清单与回执，并核对内容摘要。清单中的生产者预览与来源文件保留原包身份；当前修订的平台重建图由回执 `reconstructedPreview` / `previewPath` 标识。共享授权实时检查，贡献者撤权不会删除已经冻结到设计 owner 的依赖。

## 验证边界

真实插件完整提交、原界面中文修改/Undo/Redo、再次发布和重开已验证。报告仍明确 `candidateNativeEditorRun=false`、`visualReview=NOT_REVIEWED`、`targetExport=NOT_EVALUATED`；该系统场景不代表每个候选都运行过原生窗口，也不代表人工视觉审核或 PSD/FGUI 导出成功。生产者图片与重建图的差异是可查的测量和警告。

当前仅支持一个标准管理页面及首次严格空页导入。有限并发合并、标准历史的完整生命周期和目标导出继续实施。详见[平台发布证据](https://github.com/bambom/GameMagicTool/blob/800abb6c037b4d90dcc80cac0e8495b12135aa23/docs/ui-design/PUBLICATION-INTEGRATION.md)。
