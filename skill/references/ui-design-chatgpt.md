# UI Design：由 AI 接通 ChatGPT 网页端

用于已经绑定 UI Design 客户端工作区的连接、重连与网页端验证。
当前产品使用 **ChatGPT 普通网页 Chat**。图片理解、裁切、蒙版、补图、排版和全部生产者文件均在网页内完成；插件仅通信、鉴权、验证、保存与客户端接收。在同一个插件中保留 13 个基础工作区工具，再增加 `ui_design_split_image` 和 `ui_design_modify_design` 两个设计业务工具。使用方法及本地验证状态见[普通网页 Chat 计划](../../docs/ui-design-web-chat.zh-CN.md)。不转用 Work、本地模型 API 或本地拆图工具。
此流程优先于主 Skill 的通用 `c2c setup` / `doctor` / 临时连接流程；
不改变普通代码工作区的默认流程。

## 用户与 AI 的分工

用户说“接通 ChatGPT”即授权完成常规配置、恢复和一次只读连接验证。
AI 负责识别当前工作区、检查本机、配置网页插件、填写配对码、等待及验证。
不让用户复制命令、寻找设置、填写地址、诊断工具同步、创建验证对话或重启服务。
用户明确要求自动配置时，不再询问 auto/manual 偏好，也不因自动化失败就把整套流程交回用户。

仅在登录、验证码、二次验证，以及确实需要本人完成的账户授权等关键步骤交接。
将同一个内置浏览器标签停在准确位置，只说明这一步；用户完成后，AI 读取最新页面并自动续接。
问题涉及实际选择或缺少外部资源时，说明具体缺项，继续完成不依赖它的工作。
不要为完成连接擅自新增付费服务、OpenAI Platform 凭据或更换已确认的连接架构。

## 1. 识别绑定并检查本机

读取正在运行的 UI Design 客户端 profile 下的 `userData/ui-design-relay.json`。
其中的 `workspace` 才是插件可读写的目录；产品源码目录和插件安装目录均不是默认工作区。
`stateDirectory` 是该绑定的凭据/任务状态目录；所有后续 CLI 调用都使用相同的 `C2C_STATE_DIR`。
只读配置元数据，不输出受保护凭据。不要重建已有授权或改成更大的父目录。

从绑定的 `cli` 路径确定 UI Design 插件安装目录，使用它的辅助脚本：

```powershell
node "<UI_PLUGIN_CHECKOUT>/scripts/ui-design-chatgpt-check.mjs" --profile "<CLIENT_PROFILE>"
```

辅助脚本检查用户在客户端当前选择的单设计授权、真实设计 context、15 个本地必需工具、服务端 worker presence、
启动绑定和入口地址，并通过已绑定的 MCP 业务工具执行 `ui_design_split_image` 的 `stage=spec`、`section=summary` 只读回读，核对工作区和设计身份。`ok` 与 `localBusinessReadVerified` 仅表示本机检查和本机业务读取通过；`chatgptVerified` 仍需普通网页实际工具调用。
`publicHttps` 只检查地址形态，不证明公网可达。该脚本不配对、不生成设计 checkpoint、不提交设计。

修复本机错误后重跑。保留当前设备身份、工作区、授权和已有任务。
客户端已有 worker 时不另起重复进程。需要启用随客户端启动时，使用当前绑定的安装：

```powershell
$env:C2C_STATE_DIR = "<BINDING_STATE_DIRECTORY>"
node "<UI_PLUGIN_CHECKOUT>/bin/c2c.js" ui-design relay status --workspace "<BOUND_WORKSPACE>"
node "<UI_PLUGIN_CHECKOUT>/bin/c2c.js" ui-design relay configure-client --profile "<CLIENT_PROFILE>" --workspace "<BOUND_WORKSPACE>"
```

仅在配置缺失时执行 configure-client；它在下一次客户端启动生效。
普通网络故障由现有 worker 重连，不通过重新配对或通用 `c2c doctor` 换地址。
如果用户禁止实际客户端鼠标/键盘操作，遵守该限制，使用现有 CLI、配置或允许的浏览器流程。

## 2. 正式固定入口与本机临时测试

默认沿用已确认的架构：ChatGPT → 固定 HTTPS 平台入口 → 本机主动连接的 worker。
这条流程不需要 OpenAI 模型 API key，也不要求开通 OpenAI Platform 项目。

从 `ui-design relay status` 读取真实 `server.mcpUrl`，不拼接或猜测设备 ID。
平台配置 `app.ui-design.relay.public-base-url`，保留现有数据库和设备身份。
部署需转发 `/ui-design/mcp/*`、`/ui-design/relay-oauth/*` 和
`/.well-known/oauth-authorization-server/ui-design/relay-oauth`；
同时转发 `/ui-design/chat-files/*`，用于已授权设计的短时素材下载；必须禁用访问日志中的完整 ticket 路径及查询参数。
保留 Authorization、Mcp-Session-Id、WWW-Authenticate 头，不缓存。
具体配置以平台服务 README 与实际部署为准。

AI 在已授权的服务器和域名范围内完成配置，检查 HTTPS、未认证 MCP 的 401 和实际 OAuth discovery。
`127.0.0.1` / `localhost`、本机状态“在线”、内置浏览器能打开本机网页，都不能证明 ChatGPT 可访问。
如果目前只有本机服务，且用户希望在普通网页中进行本机联调，可以准备临时 HTTPS 测试连接；
不要求用户先租服务器。明确它只用于测试，关闭后失效，正式架构仍使用固定入口。
只开放当前实际 MCP connection、OAuth discovery/配对和已授权的短时文件接口，其他路径拒绝。
遵守当前环境对启动连接的审批要求；未获批准时保留准备结果，不通过其他工具绕过。
取得临时 origin 后启用 runtime 的 `relayPublicBaseUrl`，验证未认证 MCP 401、私有路径 404、
公网 OAuth metadata 一致，再配置网页插件。需要重启运行中的客户端时先确认保存，保留设计、数据库和绑定。
不要把本机地址填写到 ChatGPT，不要把随机临时地址冒充固定入口；本机 ready 也不代表网页验证成功。

OpenAI Secure MCP Tunnel 是另一种可选架构。它需要账户关联与独立运行凭据，
不属于本插件固定服务入口的默认依赖。只有用户明确选择这种方案后才按
[官方私有连接说明](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) 实施。
不能因为固定入口缺失就自动创建 Platform key 或开启该路线；本流程不宣称已实现或验证它。

## 3. AI 完成网页插件配置

1. 复用同一个内置浏览器标签，保持用户可见并标记保留。使用当前环境实际提供的浏览器 API。
   从已保存的准确插件设置链接进入；旧深链失效时，依据当前页面可见导航找到设置，不反复猜 URL。
2. 精确匹配当前工作区的插件名称和入口。其他工作区的同类插件不能修改。
   已有插件与固定入口一致时复用。仅授权过期时恢复授权；仅工具元数据变化时刷新工具。
   主 Skill 的“不刷新旧插件”只针对旧临时地址已经失效的情况，不适用于仍然有效的固定入口。
3. 新建或替换入口确有必要时，AI 填写名称、描述、真实 MCP URL 与 OAuth 设置。
   若网站只支持删除后重建且删除不可恢复，先把替换信息准备好，再按实际操作规则取得确认。
   不提前删除当前可用连接，不替换其他工作区的插件。
4. 授权页面准备好后才运行 `ui-design relay pair --workspace <BOUND_WORKSPACE>` 获取五分钟配对码。
   使用相同 `C2C_STATE_DIR`。AI 将该一次性码填写到对应授权页面；过期时生成新码。
   不复制 OAuth token、浏览器 cookie 或账户 session，不要求用户传递这些内容。
5. 若必须本人同意权限，停在展示具体权限的页面交接。授权成功后继续下一步，
   不能只看到“Connected”就宣称 ChatGPT 已接通。

## 4. 必须从 ChatGPT 实际调用验证

复用当前任务的 ChatGPT 对话。连接任务本身不强制用户新建 ChatGPT Project。
只有网站对更新后的工具要求新对话时，AI 在同一标签建立一个，验证成功后才保存新的对话 URL。
选择准确的工作区插件，确认输入框中插件选择仍然存在，再发送下面的只读验证请求：

> 请使用当前选择的 UI 设计插件，只调用 ui_design_split_image，参数 stage="spec"、section="summary"。
> 返回工具实际给出的工作区名和 ID、授权设计 ID，以及 context 中的设计名、页面数、原生序号和标准修订。
> 不调用 begin、submit 或 resume，不生成设计或文件。工具不可用时明确说明。

不要将本地检查结果或项目内容贴给 ChatGPT，让工具真实返回数据。
ChatGPT 仍在生成时每 20–30 秒做一次轻量页面检查，不重复发送请求。
浏览器超时不等于连接失败；复用标签读取当前状态，不新建连接、不换地址。

只有网页实际工具结果与本地绑定的工作区及设计身份一致，才能记录网页端验证通过。
保存必要的非秘密证据：插件标识、对话 URL、工作区 ID、设计 ID、工具名、验证时间及读取的版本。
保存在当前 profile 的本地状态中，不将账户凭据、配对码或 session 放进文档或项目。
给用户简短结果；如未通过，说明停在哪一层，不能把本机检查冒充网页验证。

## 5. 恢复规则

- 本机 worker 离线：检查同一 profile 与进程，恢复现有 worker，再继续网页验证。
- 401：分别检查平台设计授权和 ChatGPT OAuth 授权；只修复失效的一侧。
- 工具同步失败：检查公共入口与 discovery；入口正确时刷新工具，避免重新生成随机地址。
- `UI_DESIGN_RELAY_PENDING`：继续调用原业务工具，传 `stage="transport_status"` 与返回的 `relay_request_id`；
  不重新发送会产生副作用的调用。未知结果通过原 submission 或保留文件恢复。
- 网络恢复：保留原 URL、设备身份及凭据；已有任务结果未知时不能自动重放。
- 工作区或设计不匹配：停止后续读写，恢复准确插件选择和绑定后再验证。

连接验证不会替用户发起设计修改。用户要求拆图或改图后，按[普通网页 Chat 计划](../../docs/ui-design-web-chat.zh-CN.md)执行 `begin → 网页制作完整结果包 → submit → status/resume`。不要要求用户下载中间文件或手工导入。独立导出仍读取已发布固定版本。

## 统一基础工具与设计功能

同一固定入口、工作区绑定及通信进程提供 15 个工具。基础工具为 workspace_info、list_directory、read_file、read_image、search_workspace、git_status、git_diff、test_status、execution_summary、execution_output、write_file、apply_patch、run_command；设计业务仍只有拆图和修改设计。旧的本地 UI 生产与素材重建接口不进入普通 Chat 工具目录。

基础工具要求明确的 workspace.tools 授权，并分别检查 workspace.read、workspace.write、workspace.search、git.read、execution.read 或 workspace.execute。旧设计授权没有 workspace.tools，不能自动获得文件或命令权限。文件工具仍检查绑定目录与敏感路径；命令按本机用户权限执行，并非工作区沙箱，授权页必须说明。用户的设计内容与任务范围继续由原平台授权约束。基础工具不得用于替代网页的图片或设计生产。

更新已有准确插件入口及工具目录，不另建第二份基础插件。网页实际验证先确认 workspace_info 返回客户端绑定身份，再用独立测试文件检查创建、补丁、读回和明确授权的无副作用命令；保留真实错误与权限结果。没有完成新的基础工具授权时，报告实现已就绪、网页权限待确认，不能称文件读写已验证。
