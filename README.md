# Codex with ChatGPT

## UI Design fixed server connection

One ordinary ChatGPT web plugin retains all 13 base workspace tools and adds
two design business tools: split an image into standard layers, or modify an existing standard design.
ChatGPT web produces all images, layers and result files; the plugin transports,
validates and saves them. See the [implementation plan and verification status](docs/ui-design-web-chat.zh-CN.md).
Client-chat forwarding and embedding ChatGPT are deferred.

Ask Codex to connect ChatGPT; it performs the browser setup, pairing, recovery and
an actual read-only tool check. The user handles login and required account
consent. The maintained [AI connection procedure](skill/references/ui-design-chatgpt.md)
uses the existing desktop binding and fixed server endpoint. It does not require
an OpenAI model API key or automatically create OpenAI Platform credentials.
The commands below are implementation details for Codex and administrators.

The UI Design fork can route MCP through the existing platform server. Its outbound worker needs no public local port or temporary tunnel. The platform keeps the device identity, catalog, OAuth grants and request outcomes in PostgreSQL; a network failure never rewrites the installed connector URL or deletes the local credential.

The desktop client's **连接插件** page now offers a native workspace picker, scoped design authorization, immediate connection, reauthorization, and disconnection. Local product setup runs `node tools/ui-design/configure-relay-runtime.mjs --plugin-root PLUGIN_DIRECTORY` in the product checkout after building this fork. The client sends a bounded JSON request to `bin/ui-design-desktop.js` over private stdin; pairing codes never appear in process arguments. This entry is not an MCP tool. Reauthorization retains the prior credential until exchange succeeds and preserves interrupted requests without replay. The saved Node/plugin installation must remain present; a standalone installer is not included. The CLI workflow below remains available for development and browser-only management.

After the platform administrator configures `app.ui-design.relay.public-base-url` and applies V13–V15, choose the allowed design in the client's **连接插件** page and use its one-time platform code:

```powershell
node bin/c2c.js ui-design connect --server https://your-platform.example --pairing-code CODE --workspace PROJECT
node bin/c2c.js ui-design relay run --workspace PROJECT
# In a second terminal, obtain the MCP URL and five-minute OAuth connection code:
node bin/c2c.js ui-design relay pair --workspace PROJECT
```

Add that MCP URL to ChatGPT with OAuth, approve the requested read/write permissions, and enter the returned connection code. To attach the worker lifecycle to the desktop client, run `ui-design relay configure-client --profile CLIENT_PROFILE --workspace PROJECT`, then restart the client. `CLIENT_PROFILE` is the product profile root containing `userData`; the local-runtime profile is `<instance directory>/desktop-profile`. This saves only executable/workspace/state paths and the pinned platform address. Credentials remain in protected workspace storage. The saved Node executable and plugin installation must remain available; the client supervisor restarts the worker after unexpected exits and shows its state in **插件连接状态**. No OS service or system startup entry is installed.

Use `ui-design relay status` for live server presence plus local worker state. Platform access credentials renew automatically; old grants without a refresh credential need one new authorization. `ui-design disconnect` revokes remotely. If that cannot succeed because the old authorization expired or was revoked, `ui-design forget` explicitly removes only its local credential and reports `revoked: false`; revoke it in the platform too when applicable. Ordinary connection errors preserve all credentials and configuration. Reauthorizing the same account and workspace preserves the device MCP URL, revokes the superseded platform grant and old ChatGPT grant, and requires fresh app consent without a new connector address.

Requests are persisted before local execution. A restarted worker never re-executes a request whose outcome is unknown. Poll `ui_design_relay_status` using the returned request UUID, or inspect the original platform submission. A repeated result delivery is accepted only for the same lease and identical result. MCP sessions and tool lists remain available during client downtime. A loopback server is supported for development but is not reachable by ChatGPT's web connector; fixed public HTTPS deployment and a final web connection test are separate steps.

## Fork extensions

This fork is maintained at https://github.com/bambom/codex-with-chatgpt.git.
It adds image previews and local image import ([image workflow](docs/images.md)),
plus separately authorized `write_file`, `apply_patch` and `run_command` tools
([write and execution setup](docs/writing.md)). Commands run with the host user's
privileges, not in a sandbox. Existing read-only tokens remain read-only.
Image export/import and file read/write/patch/command execution were verified;
ChatGPT visual understanding of connector image responses remains unverified.
The review workflow below describes the default read-only mode; separately
authorized tools also support the UI production workflow described next.

## UI design from ChatGPT

Read `ui_design_spec` and the live platform specification, transfer real assets,
then use `ui_design_prepare` and `ui_design_reconstruct` to create a recoverable
canonical candidate and complete PNG evidence. `ui_design_submit` sends the
exact bundle to the platform and returns its verified publication receipt.
The platform exports PSD/FairyGUI from a fixed published revision; the plugin
verifies downloads into new workspace paths.

Legacy Scene jobs are read-only and have an explicit migration tool. Original
files and previously delivered native IDs are preserved within the supported
semantic intersection. See [the online workflow](docs/ui-design-online.md) and
[local preparation and migration](docs/ui-design-local.md).

> ChatGPT thinks. Codex works.
> ChatGPT 负责思考，Codex 负责干活。

> [!IMPORTANT]
> **遇到问题？** 请先向 Codex 发送 **「更新 Codex with ChatGPT」** 并重试。更新到最新版本可以解决大多数已知问题。  
> **Having trouble?** First ask Codex to **“Update Codex with ChatGPT”** and try again. Updating to the latest version resolves most known issues.

## The problem · 解决什么问题

**中文** — ChatGPT 付费订阅的网页版额度大量闲置，Codex 却在消耗紧张的
API 额度做规划和 Review。本项目把"思考"交给你已付费的网页版 ChatGPT，
Codex 只负责执行。不用 API Key、不搞逆向代理——官方网页 + 只读 MCP 桥接。

**EN** — ChatGPT Plus/Pro web quota sits idle while your coding agent burns
scarce API/Codex tokens on planning and review. This project moves the
thinking to the subscription you already pay for; Codex only executes.
No API keys, no reverse proxy — official web UI plus a read-only MCP bridge.

## What it is · 这是什么

**中文** — 把 ChatGPT 网页版变成 Codex 编码会话的"规划与审查大脑"，执行权
完全保留在 Codex 手里。你的仓库永远不会被上传：ChatGPT 通过一条安全的、
OAuth 保护的**只读** MCP 连接，按需读取当前工作区里它真正需要的那几行代码。

**EN** — Use the ChatGPT web app as the planning and review brain for your
Codex coding sessions, while Codex keeps full ownership of execution. Your
repository is never uploaded: ChatGPT reads exactly the lines it needs through
a secure, OAuth-protected, **read-only** MCP connection to your current
workspace.

Detailed docs below are in English · 详细中文文档见 **[README.zh-CN.md](README.zh-CN.md)**

## One-paste install · 一段话安装

**中文** — 不懂 git、Node、终端？完全不需要懂。把下面这段话原样复制给你的
编码 Agent（Codex），然后去倒杯咖啡：

```text
请帮我完整安装并配置 Codex with ChatGPT，全程自动，我是不懂技术的小白，
所有事情你自己做：

1. 环境自检：需要 git 和 Node.js ≥ 22，缺什么就自动安装
  （macOS 用 Homebrew，Windows 用 winget），同时安装 cloudflared。
2. 下载：把 https://github.com/bambom/codex-with-chatgpt.git 克隆到
   ~/codex-with-chatgpt（已存在就 git pull 更新）。
3. 构建：在该目录里执行 corepack pnpm install 和 corepack pnpm build。
4. 安装 Skill：把仓库里的 skill/SKILL.md 复制到
   ~/.codex/skills/codex-with-chatgpt/SKILL.md，并把文件中
   "The codex-with-chatgpt checkout lives at:" 那一行的路径改成实际克隆路径。
5. 首次配置：按 SKILL.md 里的 first-time setup 流程执行
  （运行 c2c setup，用内置浏览器打开 ChatGPT 配置连接器并输入配对码）。
   全程只用内置浏览器，禁止打开任何第三方浏览器。
6. 只有遇到需要我登录（ChatGPT / Cloudflare）、验证码或两步验证时才叫我，
   而且一次只告诉我一个动作。
7. 完成后给我看 ✓ 清单，并确认文件读取测试通过。我不懂 MCP、OAuth、
   Tunnel、端口这些词，不要向我解释；出了问题先自己修。
```


**EN** — Don't know git, Node, or terminals? You don't need to. Copy the
paragraph below, paste it to your coding agent (Codex), and go grab a coffee:

```text
Please install and configure "Codex with ChatGPT" for me, fully automatically.
I am a non-technical user — do everything yourself:

1. Check the environment: git and Node.js >= 22 must be available. Install
   anything missing yourself (macOS: Homebrew, Windows: winget). Also install
   cloudflared.
2. Download: clone https://github.com/bambom/codex-with-chatgpt.git into
   ~/codex-with-chatgpt (if it already exists, git pull to update).
3. Build: inside that folder run `corepack pnpm install` then `corepack pnpm build`.
4. Install the Skill: copy skill/SKILL.md to
   ~/.codex/skills/codex-with-chatgpt/SKILL.md, and update the line
   "The codex-with-chatgpt checkout lives at:" to the actual clone path.
5. First-time setup: follow the SKILL.md "first-time setup" workflow
   (run c2c setup, configure the ChatGPT connector in the BUILT-IN browser,
   enter the pairing code). Never open a third-party browser.
6. Only interrupt me for logins (ChatGPT / Cloudflare), CAPTCHAs or 2FA —
   and give me exactly ONE action at a time.
7. When done, show me the ✓ checklist and confirm the file-read test passed.
   I don't know what MCP, OAuth, tunnels or ports are. Don't explain them.
   If anything breaks, fix it yourself first.
```


**Updates · 更新** — The Skill checks GitHub once a day and updates itself when a
new version is released; no action needed. You can also say "更新 Codex with ChatGPT"
anytime. / Skill 每天自动检查一次 GitHub，有新版本会自动更新，无需任何操作；
也可以随时对 Codex 说"更新 Codex with ChatGPT"。

---

*The sections below are in English. 以下详细内容为英文，中文完整版见
[README.zh-CN.md](README.zh-CN.md)。*

## Install → Setup → Use (manual)

1. Install the Codex Skill: copy `skill/` to `~/.codex/skills/codex-with-chatgpt/`.
2. Tell Codex: **"Set up Codex with ChatGPT."** (中文: "使用 Codex with ChatGPT 完成首次配置。")
3. Use Codex normally: **"Use Codex with ChatGPT to implement XXX."**

That's the whole manual. You don't need to know what MCP, OAuth, tunnels,
ports or localhost are — Codex configures everything automatically and you
just see:

```
Codex with ChatGPT

✓ Project detected
✓ Workspace Bridge started
✓ Secure connection established
✓ ChatGPT connected
✓ File read test passed

Ready.
```

The only steps that may need you: logging into ChatGPT (and, if you want a
stable hostname, logging into Cloudflare once). A **new** workspace also asks
you to create a ChatGPT Project (collection) once — pick **project-only
memory**, name it after the workspace. If the sidebar has no Projects row,
hover **Chats**, open the … menu, and choose **Organize by project**. Codex
then saves that collection link and starts chats from that page. Existing
workspaces that already have a C2C chat stay on the old one-conversation
style until you ask to switch.

### Optional stable hostname

The default public address is a temporary Cloudflare URL. It changes when the
bridge restarts, and Codex repairs ChatGPT by deleting that workspace's
connector and adding it again.

If you have a Cloudflare account and a domain already on Cloudflare, first-time
setup (and the next coding session, once) will ask whether you want a stable
hostname such as `c2c-<project>.your-domain.com`. That path opens a browser so
you can authorize Cloudflare. After that, the ChatGPT connector keeps working
across restarts. If you skip it, or the login fails, Codex stays on the temporary
address — same features, just a slower repair.

Credentials stay in the OS app state directory, not in the project.

## How it works

```
             ┌───────────────────────────┐
             │       ChatGPT Web         │
             │  Reason / Plan / Review   │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
            Data Plane  │          │ Control Plane (<1 KB messages)
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │   loopback-only HTTP server
             │  read-only MCP      │   OAuth 2.1 + one-time pairing code
             │  OAuth + Pairing    │   Cloudflare Quick Tunnel
             │  Tunnel Manager     │
             └──────────┬──────────┘
                        │  read-only
                        ▼
             ┌─────────────────────┐          ┌─────────────────────┐
             │   Local Workspace   │◀─────────│    Codex Harness    │
             └─────────────────────┘ edit/git │ shell / tests / fix │
                                              └─────────────────────┘
```

- **Control plane (Computer Use)**: Codex and ChatGPT exchange tiny structured
  `[C2C]` state messages — `INIT → PLAN → EXECUTED → REVIEW → DONE`. No diffs,
  no logs, no file bodies are ever pasted.
- **Data plane (MCP)**: ChatGPT pulls what it needs through the read-only review
  tools: `workspace_info`, `list_directory`, `read_file`, `search_workspace`,
  `git_status`, `git_diff`, `test_status`, `execution_summary`,
  `execution_output`, plus `read_image`. Explicit write/execute scopes enable
  file mutations and the separate `ui_*` production tools.
- **Independent review**: after Codex executes, ChatGPT inspects the actual
  git diff and test records through MCP — it never trusts "all tests passed"
  claims blindly.

## Security model (short version)

- **Read-only by default**: existing read tokens cannot write files, run
  commands, or modify UI jobs. Optional mutations require explicit
  `workspace.write`/`workspace.execute` scopes; token defaults are unchanged.
- **One workspace = one boundary**: every token is bound to a single workspace;
  path containment uses canonical realpaths (symlink/`../`/absolute-path escapes
  are all blocked and tested).
- **Named UI destinations**: only the local CLI can register an additional
  output directory. Remote UI delivery selects a configured name; it does not
  expand ordinary workspace file access.
- **Sensitive files never leave**: `.env*`, keys, SSH, credentials are denied by
  default (`.env.example` allowed); `.c2cignore` adds your own rules.
- **Knowing the URL grants nothing**: the public MCP endpoint requires OAuth 2.1
  (PKCE S256, dynamic client registration, rotating refresh tokens). Without a
  token: 401. Wrong workspace: 403.
- **The model never sees long-lived credentials**: the only secret that ever
  touches a browser is a one-time pairing code (5-minute TTL, 5 attempts,
  rate-limited, destroyed on use).

Full threat model: [docs/security.md](docs/security.md)

## For developers

```bash
pnpm install
pnpm build          # -> dist/, exposes the `c2c` bin
pnpm test           # vitest: 150 tests (path security, OAuth, pairing, MCP e2e)

c2c setup           # bridge + tunnel + pairing code, all in one
c2c sandbox-allow   # whitelist the settings dir in Codex (macOS + Windows)
c2c status / doctor / pair / unpair / logs / stop
```

Requirements: Node.js >= 22, git. `cloudflared` for the public connection
(auto-detected; the Skill installs it for you). If QUIC is blocked, set
`C2C_TUNNEL_PROTOCOL=http2` and restart the bridge.

Docs: [architecture](docs/architecture.md) · [protocol](docs/protocol.md) ·
[security](docs/security.md) · [troubleshooting](docs/troubleshooting.md)

## Project layout

```
src/
  bridge/     loopback HTTP server, port recovery, admin API
  mcp/        9 read-only tools, stateless Streamable HTTP
  auth/       OAuth 2.1 (PKCE, DCR, refresh rotation, revocation)
  pairing/    one-time pairing codes (CSPRNG, TTL, rate limits)
  workspace/  path containment, sensitive-file policy, search, git
  tunnel/     TunnelProvider abstraction + Cloudflare Quick/Named Tunnel
  execution/  execution records for the review loop
  process/    daemon lifecycle
  cli/        the c2c CLI
skill/        the Codex Skill (the real UX layer)
tests/        unit + integration tests
docs/         architecture / protocol / security / troubleshooting
```

## Status & disclaimer

V1. Verified end-to-end: bridge, OAuth + pairing, public tunnel, ChatGPT
connector setup, zero-touch first-run experience.

**Unofficial community project. Not affiliated with or endorsed by OpenAI.**

## License

[MIT](LICENSE)

## Star History

<a href="https://www.star-history.com/?repos=xiaoduoya%2Fcodex-with-chatgpt&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=xiaoduoya/codex-with-chatgpt&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=xiaoduoya/codex-with-chatgpt&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=xiaoduoya/codex-with-chatgpt&type=date&legend=top-left" />
 </picture>
</a>
