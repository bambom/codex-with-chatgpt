# 独立 UI 设计平台：首批实现

日期：2026-10-11。平台和插件分别使用独立 `codex/ui-design-platform` 分支；本目录为 `C:\Users\bambo\codex-with-chatgpt-ui-design`，没有切换正在运行插件的主 checkout。

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
- 未启动新客户端/业务 Server、执行数据库迁移或切换运行中的插件。

P0-A 独立契约已实现。P0-B 原生画布/单一历史/旧保存隔离仍待验证；随后做 P1a/P2a 真实会话保存重开，再接上传、配对授权及 P3 在线回执。在线提交、完整 PNG 重建和平台 PSD/FGUI 导出尚未通过。

后续同步：从所选平台提交 build/test/pack，更新 vendor 归档/provenance，用 `pnpm update @magicgamestudio/ui-design-contract --ignore-scripts` 刷新锁的完整性，再核对安装包 `SPEC_DIGEST`。每次实际发布调整规范时更新版本，不覆盖已发布版本语义。
