# UI 设计系统：AI 图层编辑器复制开发调研

日期：2026-10-11。范围：客户端源码形态、原图层显示/选择/事务、通信、服务端文档与素材存储、构建和持续翻译依赖。此次只读调研和完善架构，没有复制生产模块、修改原应用、启动服务或执行数据库迁移。

本轮明确需求：原 AI 图层编辑器中可用的功能及实现应复制到新系统继续使用，包括界面、图层、选择、通信、存储。原实现保持不动，不以重写底层或只仿界面替代复制。实施决策见[客户端与服务器架构](ui-design-copy-architecture.zh-CN.md)，视觉依据见[原界面基线](ui-design-editor-baseline.zh-CN.md)。

## 1. 调研基线与证据边界

读取来源为 `E:\Workspace\Project-Revert\MagicGameStudio`，观察时分支 `codex/replay-storage-fixes-20260918`、HEAD `78aef8f75f6ccf092a1d4f05184595dd05e9dc8f`。这是正在继续开发的原工作树，不能把它当成已冻结的复制输入。施工仍在原有独立 worktree 中进行。

[机器可读观察记录](ui-design-source-audit-2026-10-11.json)保存 54 个已读取源码/说明/清单文件的路径、工作树 SHA-256、索引对象与选定路径的 Git 状态，以及发布清单和 3 个实际产物的哈希核验。采集结束时复核这些文件及发布指针未在采集中变化。它不是完整依赖清单，也没有打包源代码或业务数据。

本次选定范围中 `src/business/development/modules.json`、`tools/client-build/runtime.mjs`、`tools/launch-client.mjs` 和 `Server/docs/SERVER_CODE_MAP.md` 有未提交修改；因此 HEAD 不能代表全部输入。后续必须按文件/单元来源冻结，不能从旧施工基线推定最新翻译已进入新系统。

以下“已确认”指源码或清单证据，除明确说明的字节核验外不表示本轮运行验收通过。历史 README 的测试数字仅是对应阶段记录；本次未重跑客户端/Java 全量测试，也未操作用户正在使用的编辑器。

## 2. 客户端不是单一源码形态

| 层次 | 本次确认 | 复制规则 |
| --- | --- | --- |
| 已恢复语义的业务模块 | `src/business/development/modules.json` 在观察清单采集时登记 452 个单元，包含 AI 任务、选区、插入、几何、文字、页面视图等 | 复制实际使用的入口、实现、类型及传递依赖；保留 ABI 适配与正式登记，不能只取实现函数 |
| 当前 ESM 核心 | `editor-core-current-0cdd-esm/modules.json` 登记 243 个文件，即 240 个模块加入口/宿主文件；14,650 个源码单元 | 原样复制当前包及初始化顺序，继续编译；符号未完全具名不等于没有可用源码，不必先重写成新 TS |
| 当前公共宿主 | `editor-current-b29e/modules.json` 为 230 个定义文件、17,883 个有序单元，采用 `@shared-unit` 共享词法装配 | 复制完整所需宿主包及装配规则；不能按普通独立 ESM 随意摘取或改顺序 |
| 外围维护 TS | `src/client-programs/manifest.json` 共 15,261 条：15,251 条 `admission=ready`，10 条 `blocked`；另有 43 条契约登记 | 以选定 profile 的实际依赖选取；扩展名 `.ts`、准入、语义恢复、实际运行是不同状态 |
| 尚未准入部分 | 独立 TS 构建器遇到 blocked 默认拒绝；完整过渡构建使用 `pendingRecovery=report`，显式保留兼容资源 | 若新系统确实依赖，复制已核验的对应兼容字节并标记暂不可编辑；需要修改时先在新系统副本完成最小翻译与对照 |
| CSS/字体/图标/WASM/运行时 | profile、资产清单与入口声明决定实际装载；它们不因 JS 已恢复而自动齐全 | 同版本复制，记录资源 URL、文件、hash、SRI、懒加载关系与许可；不重新画图标或重写样式替代 |
| 重建候选与历史包 | `src/reconstructed/README.md` 说明其重建树不在正常运行链；旧 core 目录也不是当前输入 | 只作定位与翻译证据，不能直接作为生产复制来源，也不混入其他版本的模块 |

这些数量不是“源码完成率”。例如图层/位置面板候选 `src/client-programs/editor/lazy/35cebe4e3e65eb87.ts` 的历史 `recoveryStatus=failed`，但后来有受控 AST 差异审查，当前 `admission=ready`，当前发布目录也将其标为 `maintained-typescript`。只读一个旧失败字段会误判；反过来只看到 ready 也不能证明所有交互正确。

### 当前发布目录与旧目录的差异

本次 `dist/client-current.json` 指向 `dist/client-releases/48b3c67b-feb1-4157-adae-fe42d65c2a5d`。清单 hash 为 `46574cd5cfae9c9f522587e3dfbec10a2c281bbecbbfe006084cf48fd2dcc629`；其 catalog 记录 450 个业务单元、3 个维护源码包和 10 个 pendingRecovery；与工作树业务清单的 452 个单元存在差异，复制前须逐项核对，不能直接视为同一完整构建。启动脚本匹配的编辑器 profile 是 `editor-web-60b6a02176d15b653240101b5cdc557b39547e91`，有 7 个启动脚本与 259 条样式声明。

旧 `dist/client/catalog.json` 则仍记录 6 个业务单元和 29 个 pendingRecovery。它不是当前发布指针的目标，不能把旧目录状态与新源码混在一起作为复制基线。当前发布指针也不证明用户已经打开的窗口加载了它；窗口实际构建身份仍待原应用运行基线核对。

## 3. 图层显示、选择和历史已有实现

| 行为 | 已确认源码与调用 | 对新系统的结论 |
| --- | --- | --- |
| 从主页进入 AI 编辑器 | `home-magic-layers/factory.ts` 与 controller 负责选媒体、尺寸和创建导航；完整视图由原生壳继续启动 | 复制入口链及完整壳，不把 Home 模块当成编辑器全部源码 |
| AI 输入对象选择 | `ai-layer-tasks/selection/element-selection.ts` 读取原选区的 container、元素和目标；`page-selection.ts` 处理背景、页面尺寸及移除条件 | 直接复制这套选区适配；它是 AI 任务选区逻辑，不是整个图层面板或画布选择器 |
| 导入与显示图层 | `insert-native-layers.ts` 使用原 `sl.deserialize`、页面转换、素材导入、几何转换与引用归一化 | 复制整个插入链和所需协议/模型；不重新把结果画成自制 Canvas 节点 |
| 原生撤销事务 | 同文件经 `gv` 和 `__c.itb(presenter.undo, operation, {correlationId})` 执行；集合使用 `C_` 插入、失效时删除回滚 | 保留原事务/Undo 实现，新增标准导入也应进入同一事务；不强制改用已有实验 reducer |
| 插入后选中 | `present-layers.ts` 适配器调用 `presenter.le.Yp(container, ...layers)`；workflow 处理空结果、错误、反馈和最近操作 | 保留原选择服务及 UI 反馈，不另写一份 selectedIds 替代整个原生选择系统 |
| 页面与元素视图 | `editor-page-views/implementation/page-view-factory.ts` 使用原响应式服务、页面/元素映射与时间状态 | 复制原视图链，避免把布局辅助函数误认为完整显示组件 |
| 图层列表/位置面板线索 | `35cebe4e3e65eb87.ts` 有 `editor_layers_panel_shown`、`layers_panel`、`position_panel`，包含上下文菜单、重排和位置操作线索；其产物在当前 catalog 中且字节 hash 已核验 | 是已定位的复制候选；尚未证明当前打开窗口实际走此资源，也未完成对应 CSS、全部模型与交互映射 |

原图层树的条目、缩略图、嵌套展开、多选、排序、显隐/锁定、右键菜单和画布选择联动必须作为整体调查与保留。不能把 AI 输入选区的三份 TS 文件误报成完整图层系统已经查清。下一步逐一关联实际视图组件、原 selection store、文档集合、事务和样式。

## 4. 通信链已存在，主要任务是复制并换产品绑定

`ai-layer-tasks/factory.ts` 是模块 `921839` 的维护实现，保留十个原 designgeneration 方法、原 codec、追踪及懒加载 schema。创建/轮询/取消分别使用 `createToolJob`、`getToolJobResult`、`cancelToolJob`；任务控制器另有状态机。不能为新界面重新写一套简化 fetch/轮询器后丢失这些语义。

`source-runtime/editor/session.ts` 已处理设计创建重定向、同源表单转交、文档获取和壳校验；`editor-document.ts` 检查设计身份与原生 `Pm.E` bootstrap。服务端 `recovery/web/NativeEditorShell.java` 使用真实账号、设计内容、媒体、字体、角色及模板组装原生壳。标准 JSON 不能直接替换整个 bootstrap。

| 现有通信 | 已确认服务端入口 | 复制后需要保留 |
| --- | --- | --- |
| WebSocket `/_stream` | `ObservedStreamWebSocketConfiguration`、`ObservedStreamWebSocketHandler` | 帧协议、连接/通道、重连、事务确认、鉴权与角色语义；新产品独立路由及 handler |
| 文档重开 | `ObservedRippleDocumentsController` 的 `/_ajax/ripple/{documentId}/source/state`、pagehashes 与 document resources | 原响应 schema、版本/资源关系和 codec；读取新产品的文档服务 |
| 拆层任务 | `ObservedDesignGenerationController` → `MagicLayerJobService` | 新产品任务身份、状态与结果闭包；不把 GPT 候选伪装成原产品 job |
| 媒体上传 | `ObservedBlobUploadController` → `MediaUploadService`/transfer service | 原上传协议、实际字节与长度、owner/workspace、固定素材身份 |
| 图片读取 | `ServedMediaRenditionController`、媒体/资产权限 | 原图和 rendition 引用、签名/权限、版本与缓存语义 |

新产品应在复制后的通信装配边界绑定自己的 API/WS 地址，保留消息体与行为；不在每个工具栏组件里改请求，也不靠未命中的请求自动落回旧写接口。

## 5. 服务端文档与素材存储不能推倒重做

| 来源 | 源码确认的职责 | 复制与扩展要点 |
| --- | --- | --- |
| `StreamRippleDeltaService` | 权限/锁、追加不可变 delta、持久序号、重试、撤销权限与回收检查；成功后更新资产索引 | 复制实现及 repository/entity 依赖，替换到新产品表与设计访问服务；不写一个简化 JSON 覆盖保存接口来代替 |
| `NativeRippleReceipts` | client transaction 与 confirmed sequence 的映射；同事务同 hash 重试返回原确认；变更内容或乱序拒绝 | 保留客户端事务、服务端版本和 cursor 的区别，复制相应表、唯一约束与锁顺序 |
| `StreamRippleReplicaService` | 从完整 baseline 加已持久化 delta 重建、按序读取、恢复/历史校验 | 原样复制重放与文档语义，不以 `design_snapshot` 或最近 AI job 结果冒充当前设计 |
| `NativeDocumentRevisions` | 为真实持久版本创建带摘要的不可变 checkpoint | 复制 checkpoint 能力；标准发布修订可以绑定它，不应另造不关联实际文档的修订号 |
| `DesignRecordService` | 真实设计 ID、owner、角色、生命周期锁；新建设计关联上传素材 | 复制新产品业务与实体访问，保持原 ID/协议要求；公共账号与团队身份继续同一事实源 |
| `MediaUploadService` | 媒体身份、上传状态、workspace、底层存储与读取授权 | 复制新产品媒体业务装配，尽量调用已有公共存储能力，不另造文件目录协议 |
| `DesignAssetIndexer`、文档依赖服务 | 当前/历史文档的图片和字体引用、共享导入与固定依赖 | 从副本文档读取，登记新产品来源类型；字体、源素材与历史引用一起保留 |
| `StorageRoutingService` | 新上传选择并固定 backend；原记录按已绑定 backend 读取 | 保留现有 MEDIA/ARTIFACT 路由、版本和配额；不能因新系统私设上传目录而绕过 |
| `ManagedLayerStorage` | 完整图层结果清单、真实文件持久化、工作目录恢复、结果和媒体登记 | 复制并调整新产品 kind/路径/访问检查；临时工作目录不是正式存储 |
| `NativeWorkRegistry` | 持久任务/产物、身份、权限、工作区和受控路径 | 当前 kind 白名单只有 magiclayer/transformation/transformation-mask；新 kind 需要在副本扩展，不能给原类加 mode 或假称已支持 |

已确认的迁移线索包括 `V3__stream_ripple_delta.sql`、`V17__design_document_baseline.sql`、`V29__offline_ripple_clients.sql`、`V45__native_ripple_receipts.sql`、`V47__native_document_revisions.sql` 及资产 V40–V44。后续复制表设计需要读齐外键和后续增量迁移，不能只复制最初 CREATE TABLE；本轮未执行任何迁移。

鉴权也不能默认新路由已经可用：`ReplaySessionAuthenticationFilter` 是包内类，依赖现有真实会话解析；已读的 `ReplayLoginSecurityConfiguration` 只匹配登录相关路径。复制到新产品时要明确新 HTTP/WS 的认证链、Origin/CSRF 与设计权限，并验证包内类型及 Bean 绑定；不修改原认证文件或新建另一套账号。

## 6. 结论与尚未完成的核对

**基于现有实现复制二次开发有明确源码与协议基础，应优先采用。** 当前证据不支持把整套编辑器当作已经封装好的独立 SDK，也不支持把所有外围模块视为已翻译完毕。困难集中在完整依赖闭包、版本/构建匹配、产品私有装配和标准与原模型之间的桥接，不能据此改做自制界面。

后续开工前尚需完成以下具体核对；它们是有验收条件的任务，不是笼统“继续调研”：

1. 固定原应用实际运行构建，采集图层列表、画布选择、拖动、文字、Undo、保存重开的一组受控证据；不要改动用户业务设计。
2. 将各区域组件、CSS/图标/字体、选择 store、原始事务与懒加载模块关联到同一 profile；确定上述图层面板候选是否处于这条链。
3. 生成需要复制的源码/资源依赖闭包，逐项标明已具名 TS、维护 JS、准入 TS、兼容字节或待恢复；10 项 pendingRecovery 是否属于必要链路须逐项判断。
4. 读齐服务端复制包的类依赖、SQL/表、任务 kind、资源 URL、静态缓存与配置；形成可机械核验的新旧绑定清单。
5. 核对原 codec 是否有适合保存标准语义/稳定 ID 的扩展位，是否随原 Undo/Redo、重开和复制保留；未证明前不假设一个旁路 Map 足够。

本轮已经完成静态调研记录与[架构设计](ui-design-copy-architecture.zh-CN.md)，未宣称上述运行/闭包门槛全部通过。下一轮应按架构的 R0/B0 任务封闭这些依赖，再进行副本开发。
