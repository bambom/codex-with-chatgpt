# 独立 UI 设计平台：首批实现

日期：2026-10-11。平台和插件分别使用独立 `codex/ui-design-platform` 分支；本目录为 `C:\Users\bambo\codex-with-chatgpt-ui-design`，没有切换正在运行插件的主 checkout。

## 当前界面纠偏（2026-10-11）

用户要求完整沿用原 AI 图层编辑器的界面、显示、样式与交互，并基于原代码二次开发，见[原界面基线](ui-design-editor-baseline.zh-CN.md)。后续自制预览只接入了部分原生绘图能力，使用了自建工具栏与面板；用户已指出不符，该界面未通过 P0-B，不作为产品界面基础或发布入口。未提交实验保留为技术线索，本次文档提交不包含这些代码。

下文是已有契约、插件和会话准备的历史验证记录，继续有效；它们不证明界面复用完成。当前必须先完成 P0-B0 原代码/样式审计与可行性结论，再做 B1 原界面独立窗口和同条件对照，之后才做 B2 标准编辑接线。保存重开、在线插件与导出仍按后续阶段推进。

## 本批交付

平台实现了 [0.1.0 契约包](https://github.com/bambom/GameMagicTool/tree/5bd104070dcc3e7e3ab6583eb285e874e4bf08ba/packages/ui-design-contract)，插件直接消费同一源提交的固定 npm tarball，没有独立维护一份 Schema。源提交、规范摘要和归档 SHA-256 见 [provenance](../vendor/ui-design-contract.provenance.json)，依赖完整性固定在 `pnpm-lock.yaml`。

| 新工具 | 当前行为 |
| --- | --- |
| `ui_design_spec` | 按 section 返回固定规范、Schema、中文语义、能力、API/状态或完整样例；标识 `source=platform-bundled`、`liveServer=false` |
| `ui_design_precheck` | 接受原始 JSON 或工作区相对文件；验证正文、固定布局及可选 manifest 的基线/提交/规范身份与完整依赖；可检查实际文件长度、SHA-256、PNG 解码/尺寸/RGBA |

两项工具要求 `workspace.read`。预检不写工作区、不创建旧制作 job，不要求 FGUI 工程，也不持有平台凭证。现有旧导出工具继续原流程；它们的 PSD/FGUI PASS 不能计为新平台导出通过。

准备时先取 `ui_design_spec section=summary`，再读 `semantics`、`authoring`、`example`。按同一文档生产真实素材与文件清单。输入保留原始 JSON，让 parser 发现重复键和精度错误。文件参数相对已连接工作区，真实文件根用 `package_directory`，manifest 只保存可移植相对路径。

```json
{
  "document_path": "ui-result/design.json",
  "manifest_path": "ui-result/manifest.json",
  "submission_id": "submissionFromPlatform",
  "base_revision": 0,
  "verify_files": true,
  "package_directory": "ui-result"
}
```

上例仅说明参数形状。目前没有创建平台 submission 的工具；未来在线链必须使用真实平台返回的身份，不能由模型编造。当前离线测试身份不代表平台保存。

`LOCAL_PRECHECK_PASS` 始终返回 `saved=false`、`receipt=null`；`visual/fontShaping=NOT_IMPLEMENTED`、`platformAuthorization=NOT_CONNECTED` 分开报告。字体和原始非渲染材料目前只验证固定字节，不能据此证明字形覆盖。PNG 解码不证明美术补全或像素对比通过。

本地文件检查限 2048 文件、单文件 64 MiB、合计 256 MiB、图片 32M 像素；超限明确拒绝。文件访问沿现有敏感文件、工作区及符号链接边界；文件变化、长度/hash/解码不一致均失败。

## 验证与版本

- 平台：TypeScript 59 项、Java 54 项独立契约检查通过；规范字节/hash、命令序列、组件/控件及局部布局一致。
- 插件：`pnpm typecheck`、`pnpm build` 通过；完整 `pnpm test` 为 27 文件、257 项通过，包含新工具 12 项真实 MCP/预检测试及原有导出/权限回归。
- 环境为 Windows / Node 25.2.1；本分支最低 Node 22，package engines、doctor、安装说明已同步。
- 首批契约交付时未启动新客户端/业务 Server、执行数据库迁移或切换运行中的插件。后续本地预览实验不计入首批成果，状态见上方纠偏说明。

P0-A 独立契约已实现。P0-B 的原界面源码/样式审计、完整复用及标准编辑/单一历史/旧保存隔离仍未通过；随后做 P1a/P2a 真实会话保存重开，再接上传、配对授权及 P3 在线回执。在线提交、完整 PNG 重建和平台 PSD/FGUI 导出尚未通过。

平台随后已推进到 [作者会话与投影准备提交 `7ffed79225`](https://github.com/bambom/GameMagicTool/commit/7ffed79225e21bedc45a06377eb8794b0f9d7b24)：新增标准命令到画布键的映射、嵌套坐标、实例覆盖、文字输入会话、视图重建和异常恢复。17 项独立会话测试与独立浏览器模块打包通过。测试使用视图替身，没有证明 OS 中文输入、新窗口、原生画布或保存隔离通过；阶段边界和下一步见 [P0-B 记录](https://github.com/bambom/GameMagicTool/blob/7ffed79225e21bedc45a06377eb8794b0f9d7b24/docs/ui-design/P0-B-SESSION.md)。契约内容未变化，本插件仍固定消费上文 `5bd104070d` 的 tarball。

后续同步：从所选平台提交 build/test/pack，更新 vendor 归档/provenance，用 `pnpm update @magicgamestudio/ui-design-contract --ignore-scripts` 刷新锁的完整性，再核对安装包 `SPEC_DIGEST`。每次实际发布调整规范时更新版本，不覆盖已发布版本语义。
