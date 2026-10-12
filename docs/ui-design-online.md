# UI 设计平台在线提交

这条流程面向独立 UI 设计平台；平台副本沿用原 AI 图层编辑器界面和原生保存链。插件从工作区上传已完成的标准正文、真实素材/字体和证据包，平台验证、保存并发布。平台导出从已发布固定修订运行；旧本地作业没有自动改写，显式迁移另行收尾。

## 连接与准备

在平台 `/ui-design/connect` 为有权编辑的设计建立 `design.read` / `design.submit` 连接，使用一次性配对码在本地运行 `c2c ui-design connect --server <平台地址> --pairing-code <配对码> -w <工作区>`。端点只由本地配置决定；MCP 参数不能重定向凭据。Windows 凭据使用当前用户 DPAPI，模型只得到连接范围和过期时间。

1. `ui_design_platform_spec` 和 `ui_design_online_protocol` 核对实际规范、摘要与能力。共享包 0.8.0、在线协议 1.6.0；作者格式仍为 0.1.0。
2. `ui_design_context` 获取当前原生序号/hash 和标准修订，再用 `ui_design_checkpoint` 固定准确状态。
3. `ui_design_submission_begin` 绑定 checkpoint、base revision 与稳定 request UUID，返回 submission ID。为完整文件清单写入这个 ID，保持正文/清单/文件摘要一致。
4. 在工作区完成原图、采用定稿、PNG 素材、实际字体、完整预览、总览与来源记录。`ui_design_precheck` 可检查本地结构和字节，不能替代平台验证或发布。

## 提交与恢复

调用 `ui_design_submit`，传入 design ID、submission ID、document/manifest 路径及包目录。插件先核对整个包，再补传缺失文件；平台完整解码、冻结依赖、原生 bridge 往返和投影、独立重建及图片差异测量后，条件导入原生历史并提交标准修订。

需要分步处理时使用 `ui_design_submission_upload`、`ui_design_submission_validate`、`ui_design_submission_prepare_commit`、`ui_design_submission_commit`。候选验证 ID 固定 N 的正文、清单和 bridge。准备提交会读取当前原生文档 C，与已发布基线 B 和 N 做有限三方合并；固定布局下，一侧只替换同尺寸、同裁切资源内容，另一侧只改变场景节点位置时可以合并。文字、尺寸、九宫格、组件定义/覆盖、未知扩展等并发变化没有自动合并规则，会返回定位冲突。

准备结果包含 `preparationId`、当前标准 head/原生 checkpoint，以及最终文档 M 的独立报告与重建图。平台重新解码 M 的全部依赖、核对 manifest、原生往返和渲染；N 的报告与生产者预览保留。可把准备 ID 传入 commit 固定本次选择；省略时插件先准备再提交。正式导入要求原生活动编辑通道关闭，最终事务再次核对权限、原生 checkpoint 和标准 head。准备之后若又有编辑，提交会拒绝；重新 prepare，或保留双方版本后修复候选，不能把过时报告用于新 M。

成功结果必须是共享协议校验通过的持久 `COMMITTED` 回执，分别记录 submitted N 与 committed M 的正文/清单摘要、最终校验 ID、标准修订、原生 checkpoint 与重建图。`BUNDLE_STORED`、本地预检和验证 PASS 都不代表正式保存。使用 `ui_design_submission_status` 恢复未知结果；重复相同 submission/validation/preparation 身份返回原回执，即使之后已有新编辑也不再导入。取消只允许未提交候选，并保留已经接收的文件。

当前断点恢复粒度为固定 1 MiB 块（末块可短），进度来自服务端 nextOffset；重复块必须同偏移、长度和摘要。单文件上限 64 MiB、整包 256 MiB、最多 2048 项；接收中数据每 actor 256 MiB、全局 768 MiB，首块起七天过期后需新建 submission。完成和取消会释放接收中的块字节。发生版本冲突时读取新 context，保留原候选与原生草稿，不能自动换基线并声称旧候选仍已验证。

错误 details 包含共享协议验证的 code、JSON Pointer 字段路径、规则、retryAction 和查询身份；合并冲突还尽量提供稳定 nodeId/assetId，按这些信息定位修复。`status.lastError` 为最近一次历史拒绝，并不覆盖当前 state/receipt。更改已绑定候选的正文或文件需使用新的 submission。先用 `ui_design_submission_read` 核验保留正文、清单和最近 32 条诊断；读取当前 context/checkpoint 后，用 `ui_design_repair_begin` 显式绑定新基线和稳定 request UUID。平台在同一事务中创建新尝试并取消旧未提交尝试，保留旧报告和诊断。修正版清单写入新 ID；完全相同的已接收文件描述按固定版本复用，其他文件正常上传。修正版的验证与准备从头执行，旧报告不能用于新内容。COMMITTED 尝试不能修复。候选读取的 20 MiB 响应上限用于容纳正文及诊断，其余 JSON 读取仍为 8 MiB。旧 1.1/1.2/1.3/1.4 正式回执仍能通过固定旧协议读取。

## 原生编辑后的再次发布

原生编辑会正常保存到原生历史。读取最新 context 并固定 checkpoint 后，调用 `ui_design_publish_native`，提供稳定 request UUID、checkpoint 和已发布 base revision。支持的文本/位置等编辑将投影为新标准修订；不支持的结构、富文本或视觉变更会拒绝发布并保留原生草稿。

原生发布回执的 origin 为 `NATIVE_DRAFT`、`nativeImported=false`、`published=true`、`submitted=true`。它不会新增原生编辑事务。重复同一请求返回原修订；要发布之后的新改动，使用新 checkpoint 和 request UUID。

`ui_design_revision` 返回固定正文、清单与回执，并核对内容摘要。清单中的生产者预览与来源文件保留原包身份；当前修订的平台重建图由回执 `reconstructedPreview` / `previewPath` 标识。共享授权实时检查，贡献者撤权不会删除已经冻结到设计 owner 的依赖。

## 复制与历史

现有原生完整设计复制保留已发布标准历史和当前未发布原生草稿，生成独立设计/原生身份、固定素材和设计字体。`DESIGN_COPY` 回执不冒充原插件提交，`copySource` 绑定源回执、内容和归档摘要。源设计撤权或移除后，副本资源和归档继续按副本权限读取。

`ui_design_history` 按修订倒序分页，返回 `nextBefore`；`ui_design_copy_source` 校验对应正式回执、归档摘要和原回执字节摘要后读取原始生产者证据。复制的副本保留祖先记录；待提交私有候选不复制。未知原生修改仍保留在副本草稿中，不假称它们已经通过标准发布。标准设计当前要求完整页集；详情见[平台边界与验证](https://github.com/bambom/GameMagicTool/blob/codex/ui-design-platform/docs/ui-design/COPY-LIFECYCLE.md)。

## 验证边界

真实插件完整提交、原界面中文修改/Undo/Redo、再次发布和重开已验证。报告仍明确 `candidateNativeEditorRun=false`、`visualReview=NOT_REVIEWED`、`targetExport=NOT_EVALUATED`；该系统场景不代表每个候选都运行过原生窗口，也不代表人工视觉审核或 PSD/FGUI 导出成功。生产者图片与重建图的差异是可查的测量和警告。

当前仅支持一个标准管理页面及首次严格空页导入。有限合并已通过真实编辑器移动、Undo/Redo、关闭通道、插件提交和重开；它不代表任意并发编辑都可合并。标准历史复制、改名、移动、回收/还原及永久业务移除已经验证；定位修复闭环已通过跨进程真实插件验证；平台目标导出继续实施。详见[平台合并证据](https://github.com/bambom/GameMagicTool/blob/778d4ced4dd98c39bb2a268951020c2856607317/docs/ui-design/MERGE-INTEGRATION.md)。

## 平台固定修订导出

`ui_design_export_targets` 读取管理员从实际源码冻结的目标及 exporter 身份；`ui_design_export_begin` 指定 revision、稳定 request UUID 和 PSD/FGUI 格式，FGUI 再选择 target ID。平台读取该修订的固定资源，随后发生的原生编辑或新发布不改变任务输入。导出需要 design.read；创建/操作任务和写本地文件另需 workspace.write。

用 `ui_design_exports` 读取任务状态、独立尝试、定位诊断、产物清单和报告。`ui_design_export_action` 允许创建者重试失败任务、创建者或 owner 取消未完成任务。`ui_design_export_download` 按 index 下载到新的工作区路径，校验长度/hash 和报告身份；已有文件不会覆盖。

SUCCEEDED 确认文件验证和保全，不意味着 Photoshop 或官方 FairyGUI 桌面编辑器通过。报告分别给出 fileValidation、editorImport、runtimeInteraction。PSD 文字为独立栅格层，标准正文中仍保留可编辑文本；FGUI 源码保留原生控件、组件及状态，业务回调未绑定。无配置适配器时原生两项为 not_verified。实际目标检查范围、整数坐标/步长 1 等限制、租约和两 JVM 恢复证据见[平台导出记录](https://github.com/bambom/GameMagicTool/blob/d7b14d888a291e2f7c1cc41e8e51e2d936064c21/docs/ui-design/FIXED-REVISION-EXPORTS.md)。
