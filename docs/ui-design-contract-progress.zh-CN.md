# 独立 UI 设计平台：首批实现

2026-10-12 本机持久工作区已建立：用户反馈上一批下载查看无问题；平台新增正常可执行 local-runtime、独立持久数据库/文件/账号和 Start-Workspace.cmd 入口，客户端菜单统一设计首页、插件连接与导出中心。Java 与 PostgreSQL 完整停止/重启后，正式修订、预览、5 个产物文件、账号及插件连接保留，撤权返回 401；14 项 Node 和 4 项 Python 检查通过。实际客户端以独立 profile 启动并记录页面加载；不据此宣称全部菜单、视觉及编辑验收通过。详见[本机工作区与边界](https://github.com/bambom/GameMagicTool/blob/87d46520eb34724c4688b82637a4f69e80b60722/docs/ui-design/LOCAL-WORKSPACE.md)。FGUI 目标指纹变化后的导入/交互仍未验证；继承的配额/订阅接口仍有缺口。远程环境、外部 AI 配置和数据迁移尚未部署，下一步围绕第一份真实项目设计推进，不重开独立原功能基线。

2026-10-12 导出网页与独立人工验收入口已完成：平台 `/ui-design/exports` 可选择已发布版本、PSD / FairyGUI 与固定目标，查询/取消/重试任务、查看节点错误及尝试历史，并在下载前校验字节。未知创建请求可跨刷新保留并重放同一编号。5 项页面行为检查、实际宿主鉴权/生成及浏览器创建/刷新/PSD 下载/失败重试通过。详见[平台人工验收说明](https://github.com/bambom/GameMagicTool/blob/99ae64b1df1c4a0fba9cb584d87b056de266d1c7/docs/ui-design/EXPORT-ACCEPTANCE.md)。当前本机提供临时独立服务，正式环境未部署。本次 FGUI 目标源码固定指纹已变化，编辑器导入与运行交互为未验证，不沿用下列历史批次结果；复杂迁移和实际目标工具中的视觉/交互仍需验收。

2026-10-12 本地标准与在线提交闭环已完成：共享包 0.9.0 / 在线 1.7.0，插件新增真实素材分块传入、不可变准备、图层重建和旧作业显式迁移；旧作业写入口转为只读兼容。真实插件跨进程恢复、正式发布 r1、下载及原生包/资源/对象 ID 保留通过，旧作业不变。目标源码工作台打开/保存/重开/渲染通过；无交互控件样例保持交互未验证。插件集中 22 项及字体修正后本地 5 项检查通过。详见[平台记录](https://github.com/bambom/GameMagicTool/blob/8e8f25259cfed2c0af1d25f6d305f11825797d5c/docs/ui-design/LOCAL-PREPARATION.md)和[插件操作](ui-design-local.md)。当前功能已实现并完成定向验证，现用平台和插件未部署；复杂迁移语义、导出网页操作界面和视觉审阅仍有明确边界，独立基线扩展停止。

2026-10-12 固定修订导出批次已完成：共享包 0.8.0 / 在线 1.6.0，平台持久 PSD/FGUI 任务固定已发布修订、资源、真实目标源码快照和 exporter。插件以 design.read 创建、查询、取消/重试并校验下载；只读分享用户的产物使用本人资产空间。4 个导出数据库场景、受影响 2 项复验及两个独立 JVM 恢复通过；实际目标源码工作台打开/保存/重开/渲染及 9 项运行时交互通过。PSD 分层像素/合成回读和真实插件跨进程下载通过。详见[固定修订导出及边界](https://github.com/bambom/GameMagicTool/blob/d7b14d888a291e2f7c1cc41e8e51e2d936064c21/docs/ui-design/FIXED-REVISION-EXPORTS.md)。未部署；接续本机标准准备/重建及旧作业显式迁移，不重开独立基线。

2026-10-12 候选定位修复批次已完成：共享包 0.7.0 / 在线 1.5.0，修复新建不可变尝试并保留父候选、报告和诊断；相同完整文件可复用，新候选必须重新验证与提交。3 个真实数据库场景经编译及测试字段名修正后分批通过；真实插件第二进程恢复失败预览，修正 1 个文件、复用 7 个后取得正式回执，旧诊断仍保留。共享 8 项、插件 5 项通过，旧回执和准备继续核验。详见[平台定位修复](https://github.com/bambom/GameMagicTool/blob/bb832ad9574bc055e5bcdad9aa06ce939d9b2f69/docs/ui-design/CANDIDATE-REPAIR.md)。继续平台 PSD/FGUI 固定修订导出，未部署，不重开原功能基线批次。

2026-10-12 标准复制与生命周期批次已完成：共享包 0.6.0 / 在线 1.4.0，平台完整设计复制拥有独立原生身份、已发布标准历史和全部固定资源，保留当前未发布草稿、混合 N/M 原始证据及复制祖先。DESIGN_COPY 回执明确来源；插件新增历史分页与来源归档核验。改名/目录移动/owner 回收还原、版本和撤权复查、最终事务回滚均通过；源设计永久移除后，真实插件读取与实际副本编辑器的文字编辑、Undo/Redo、重开及再次发布通过。详见[平台复制与生命周期](https://github.com/bambom/GameMagicTool/blob/52a88d869c5f1cf7aa926db597652eed4c109fa0/docs/ui-design/COPY-LIFECYCLE.md)。标准完整页集复制有明确边界；继续实施 P3 定位修复闭环和 P4 固定修订 PSD/FGUI 导出，未部署，不另开原功能基线批次。

2026-10-12 有限合并已完成：平台提交 [`778d4ced4d`](https://github.com/bambom/GameMagicTool/commit/778d4ced4dd98c39bb2a268951020c2856607317) 以已发布基线 B、插件候选 N 和当前原生投影 C 做有限三方合并，重新核对最终 M 的文件、原生投影与渲染，固定准备 ID 后双版本条件提交。N 的报告/生产者预览保留，回执分别记录 N/M 摘要，逐修订文件来源支持混合资源及后续原生发布。共享包 0.5.0 / 在线 1.3.0，兼容旧 1.1/1.2 回执。Java 5 个合并场景、共享 6 项和插件 5 项检查完成；4 个合并数据库场景经过两处坐标断言修正后全部通过。真实编辑器移动、Undo/Redo、关闭通道、插件合并资源及重开通过；受影响的 4 个正式发布回归通过，临时数据库均移除。见[合并规则、证据与限制](https://github.com/bambom/GameMagicTool/blob/778d4ced4dd98c39bb2a268951020c2856607317/docs/ui-design/MERGE-INTEGRATION.md)。下一批为标准历史与依赖的复制/生命周期，再推进定位修复和平台 PSD/FGUI 导出；未部署，不另开原功能基线批次。

以下为此前批次记录，当前进度以上段为准。

2026-10-12 上传恢复与错误定位已完成：平台提交 [`2e367b2e83`](https://github.com/bambom/GameMagicTool/commit/2e367b2e837c82eade08e2a8a95eacb118acc2a6) 增加持久 1 MiB 顺序块、准确 nextOffset/重复块身份、过期/取消释放、文件完整 hash 检查，以及带字段路径和查询身份的错误。真实插件新进程接续首块；完整服务端 JVM 重启后也恢复并完成上传。首批插件场景通过，另 3 项被错误 JSON 数值表示差异阻断；修复后仅补跑这 3 项及第二 JVM 恢复，全部通过，容器均移除。共享包 0.4.0 / 在线 1.2.0，保留旧 1.1 正式回执读取，作者 0.1 摘要不变。共享 5 项、插件 4 项和 Java 编译通过。见[上传恢复证据与边界](https://github.com/bambom/GameMagicTool/blob/2e367b2e837c82eade08e2a8a95eacb118acc2a6/docs/ui-design/UPLOAD-RECOVERY.md)。有限合并/最终重校验、完整标准生命周期和平台目标导出继续实施；未部署。

以下为此前批次记录，当前进度以上段为准。

2026-10-12 正式发布主线已完成：平台提交 [`800abb6c03`](https://github.com/bambom/GameMagicTool/commit/800abb6c037b4d90dcc80cac0e8495b12135aa23) 实现候选验证、全部输入/原生资源冻结、条件原生导入、标准修订和持久回执，以及原生草稿再次发布。真实插件上传 8 文件后提交为 r1；原界面改中文标题并 Undo/Redo，再由插件发布为 r2、重开保持，原生序号为 4。回执幂等/事务回滚、共享撤权后 owner 资源保留、原生与标准 head 变化拒绝覆盖共 4 个场景已完成验证；首批 3 通过/1 表示问题，修复后仅补跑失败项通过。共享包 0.3.0 / 在线协议 1.1.0，作者 0.1.0 摘要不变。新增 submit、validate、commit、revision 和 publish_native 工具；只有经共享契约验证的持久 COMMITTED 回执算正式成功。见[接口、证据与限制](https://github.com/bambom/GameMagicTool/blob/800abb6c037b4d90dcc80cac0e8495b12135aa23/docs/ui-design/PUBLICATION-INTEGRATION.md)及[插件操作链](ui-design-online.md)。有限合并、字节范围续传、完整标准生命周期及目标导出继续实施；未部署，停止独立基线推进。

2026-10-12 最新桥接进展：平台提交 [`880ef1e32c`](https://github.com/bambom/GameMagicTool/commit/880ef1e32c5983e45bf5f037aecb59158d6cb896) 已完成真实文件到原生编辑器、保存/撤销/重做/重开及标准回写闭环。完整样例 8 文件、28 个布局条目、3 个真实图片绑定和 1 个字体绑定通过；中文标题编辑后固定框仍为 180×32，组件/实例/状态/扩展保持，实际标准预览接口返回 640×480 PNG。私有 ESM 源码覆盖层保持原生排版事务，原上游源码不变。隔离桥接集成、4 项投影、4 项原生预览及 2 项适配检查通过，临时数据库已移除。见[桥接记录与限制](https://github.com/bambom/GameMagicTool/blob/880ef1e32c5983e45bf5f037aecb59158d6cb896/docs/ui-design/BRIDGE-INTEGRATION.md)。正式原生导入接口、完整依赖冻结、标准修订与持久回执继续实施；不能把本批准备或原生 ACK 报告为正式提交。

2026-10-12 标准主线进展：平台提交 [`fd2ed9a897`](https://github.com/bambom/GameMagicTool/commit/fd2ed9a897762c5cc12d4feae93be39d9653950c) 已实现完整候选在线接收：以 request UUID 幂等开始，固定当前 native checkpoint 与标准版本，不可变绑定文档/清单，按 hash 和长度保存真实文件，查询逐文件状态并支持取消。插件新增在线协议及 submission begin/status/upload/cancel 工具；上传只读取工作区文件，先全包校验，再补传缺失文件。共享包升级为 0.2.0，作者标准 0.1.0 摘要不变，独立在线接收协议为 1.0.0。59 项共享契约检查、14 项插件检查、2 项真实接收集成和 3 项标准在线集成通过；真实插件 8 文件上传、1+7 续传及重复零上传已有证据。BUNDLE_STORED 仅表示字节留存，`submitted=false`、`published=false`；原生桥接、视觉校验、正式提交和回执继续实施。见[在线接入与证据](https://github.com/bambom/GameMagicTool/blob/fd2ed9a897762c5cc12d4feae93be39d9653950c/docs/ui-design/STANDARD-INTEGRATION.md)。停止独立基线推进。

以下是此前契约与复制阶段的历史记录，当前执行顺序以上述标准主线为准。

2026-10-11 实施进展：平台提交 [`77a3c9ae5a`](https://github.com/bambom/GameMagicTool/commit/77a3c9ae5a7de21908a879b3aa3961e8dc9fa850) 已接通完整原生壳与私有 `/ui-design` HTTP/WebSocket，真实 Electron 与临时 PostgreSQL 验证文本编辑、撤销/重做、逐事务保存、重开及私有字体实际读取和跨账号拒绝；最新宿主/窗口检查 7 项通过。补齐 3,569 个固定 JS/CSS、4 个 WASM 和 4 张背景图，递归字面依赖核验 7,340 项、缺项为零；7 项相关 Node 检查通过。143 个继承 REST 控制器保留，补齐字体路由后共 147 个私有控制器。七个侧栏、位置面板和原生图层列表已加载，但观察入口不代表完整业务通过。**B2 完整原功能、动态资源、JVM 重启恢复、标准 checkpoint 发布、GPT 在线链和导出仍未验收。** 原源码、现用服务和现用数据库保持不动。详情见[运行证据与功能对照](https://github.com/bambom/GameMagicTool/blob/77a3c9ae5a7de21908a879b3aa3961e8dc9fa850/docs/ui-design/NATIVE-RUNTIME-ACCEPTANCE.md)。

日期：2026-10-11。平台和插件分别使用独立 `codex/ui-design-platform` 分支；本目录为 `C:\Users\bambo\codex-with-chatgpt-ui-design`，没有切换正在运行插件的主 checkout。

## 当前复制开发架构（2026-10-11）

用户进一步明确：原代码不动，完整复制 AI 图层编辑器和服务端的可用实现形成新系统，以完整原客户端功能与业务逻辑为基线做增量需求；图层显示、选择、编辑、通信、存储只是重点例子，不能只保留这一部分。实施依据为[复制架构](ui-design-copy-architecture.zh-CN.md)、[源码调研](ui-design-reuse-research.zh-CN.md)、[主方案](ui-design-platform-integration.zh-CN.md)与[原界面基线](ui-design-editor-baseline.zh-CN.md)。随后用户授权开始实施，已交付下面的固定来源副本与独立构建基线。

产品保留复制来的原生文档/事务/Undo 和 baseline/delta 存储；标准正式修订是确定 native checkpoint 的不可变投影。下文 0.1 契约及插件离线预检仍可用，旧自建标准会话/reducer 只作测试与语义参考，不能强制作为产品唯一作者状态或替换原历史。早期 SQL 绑定原 design_record 的设计未部署，已被新产品独立记录/持久化架构替代；此处不改写已发布 0.1 包或 tarball。

自制预览界面不符合要求，不作为产品基础。后续顺序是 R0/B0 完整来源/运行基线 → B1 原界面/图层/选择副本 → B2 原编辑/通信/保存重开 → P1a/P2a 标准桥接与发布 → 完整标准业务、P3 在线插件、P4 导出。历史测试结果不能转记为副本验收通过。

## 完整源码复制的第一批实施

平台提交 [`b640cf7a00`](https://github.com/bambom/GameMagicTool/commit/b640cf7a0062def34d056674a66a37fc192e65cf) 固定来源提交 `fc7af75e`，新增 16,857 个客户端构建输入、766 个服务端来源文件，以及私有构建/检查/导入工具。复制整个登记业务与程序目录，不按首屏或新增需求裁剪。详细范围、命令和余项见 [源码与构建基线](https://github.com/bambom/GameMagicTool/blob/b640cf7a0062def34d056674a66a37fc192e65cf/docs/ui-design/SOURCE-COPY-BASELINE.md)。

副本完整构建成功；459 个业务模块、3 个共享包、23 个 profile 保留。15,251 条程序的源码/编译器/输出通过缓存校验，0 构建失败，10 条上游待恢复记录仍保留；这不是无缓存冷构建。22 个入口脚本、1 个 Worker 的静态绑定及 457 个宿主文件哈希检查通过，新增 Node 5 项、Python 2 项定向测试通过。

服务端 336 个待私有化候选与 80 个公共设施参考尚未接入生产 source set；原表迁移只作参考，未执行。产品入口在私有后端接好前拒绝启动，避免回退到原账号/服务器。完整原功能运行对照、真实界面、通信/保存重开仍未通过，不能把本批标记为 B0/B1/B2 全部完成。

插件代码、0.1 契约包和离线预检此次没有变化；未重复运行无关插件测试，也未切换正在运行的插件。下一批先完成原生产品私有宿主/后端与完整功能闭环，再推进标准桥接和 P3 在线授权、提交、回执。

## 首批契约与插件交付

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

P0-A 独立契约已实现。P0-B 的完整源码/样式/依赖审计、完整副本与原生通信/持久化闭环仍未通过；随后做 P1a/P2a 标准桥接/发布，再扩展完整上传、配对授权与 P3 在线回执。在线提交、完整 PNG 重建和平台 PSD/FGUI 导出尚未通过。

平台随后已推进到 [作者会话与投影准备提交 `7ffed79225`](https://github.com/bambom/GameMagicTool/commit/7ffed79225e21bedc45a06377eb8794b0f9d7b24)：新增标准命令到画布键的映射、嵌套坐标、实例覆盖、文字输入会话、视图重建和异常恢复。17 项独立会话测试与独立浏览器模块打包通过。测试使用视图替身，没有证明 OS 中文输入、新窗口、原生画布或保存隔离通过；阶段边界和下一步见 [P0-B 记录](https://github.com/bambom/GameMagicTool/blob/7ffed79225e21bedc45a06377eb8794b0f9d7b24/docs/ui-design/P0-B-SESSION.md)。契约内容未变化，本插件仍固定消费上文 `5bd104070d` 的 tarball。

后续同步：从所选平台提交 build/test/pack，更新 vendor 归档/provenance，用 `pnpm update @magicgamestudio/ui-design-contract --ignore-scripts` 刷新锁的完整性，再核对安装包 `SPEC_DIGEST`。每次实际发布调整规范时更新版本，不覆盖已发布版本语义。
