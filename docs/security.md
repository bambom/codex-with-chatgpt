# Security Model

## Trust boundaries

1. **Workspace identity** is the authorization boundary. One bridge serves
   exactly one workspace; every token is bound to `workspace_id`; a token for
   project A returns 403 on project B's bridge. Ordinary file tools stay inside
   that root. Additional UI output directories must be named and registered
   locally for that workspace. Explicit command execution has the host user's
   broader authority and is not sandboxed.
2. **Workspace content is untrusted.** README, comments, diffs may contain
   prompt injection. Server instructions and relevant file-tool descriptions
   carry explicit warnings; tools never grant capabilities based on file content.
3. **The model never sees long-lived credentials.** Computer Use only ever
   handles the one-time pairing code. Access/refresh tokens travel only inside
   the OAuth redirect/token endpoints between ChatGPT's client and the bridge.

## Threat model → mitigations

| Threat | Mitigation |
| --- | --- |
| MCP URL leaks | URL alone is useless: every `/mcp` request requires a valid bearer token (401 without, 403 wrong workspace) |
| Pairing code brute force | 8 chars from a 31-char CSPRNG alphabet (~40 bits), 5 attempts per session, per-IP rate limit (10/min), 5-minute TTL, one-time use, session destroyed on limit |
| OAuth CSRF | `state` round-tripped verbatim; authorization requests are server-side records keyed by random ids |
| Code interception | PKCE S256 mandatory (plain rejected); authorization codes are one-time, 5-minute TTL, bound to client + redirect URI |
| Token theft | Opaque high-entropy tokens; stored only as SHA-256 hashes; access tokens live 1 h; refresh tokens rotate on every use (replay of the old one fails); revocation endpoint + `c2c unpair` |
| Workspace traversal | `realpath` canonicalization of the deepest existing ancestor; containment check against the canonical root; case-insensitive comparison on macOS/Windows; rejects `..`, absolute escapes, backslash tricks, null bytes |
| Symlink escape | Canonicalization resolves symlinks before the containment check (file and directory symlinks both covered by tests) |
| Sensitive files | Deny-by-default patterns (.env*, keys, SSH, cloud creds, keychains…) enforced at resolve time — reads, listings, and search all pass through the same gate; `git diff` adds pathspec excludes; `.env.example` allowed |
| Oversized file / diff DoS | read_file caps lines and bytes per response; git_diff paginates by byte offset with hard caps; search caps matches and file sizes |
| Tunnel exposure | Bridge binds 127.0.0.1 only (refuses 0.0.0.0); public operations are protected by OAuth; `/health` reports service/version and a workspace identity hash, not the path |
| Admin API abuse | Loopback-only + random admin token (0600 runtime file) + requests with proxy headers (`cf-connecting-ip`, `x-forwarded-for`) rejected; unauthenticated probes get 404 |
| Log credential leakage | Logger redacts token prefixes, bearer headers, token-like parameters, and pairing-code-shaped strings before writing |
| Execution output leak | Codex may nominate test/build/lint logs; a local sanitizer redacts tokens, pairing-code-shaped strings and home paths, truncates size, and refuses private-key blocks entirely. Restricted items are listed without a body. Separately authorized `run_command` output is capped and redacted, but arbitrary host commands are not a secret-safe sandbox. |
| Checkpoint / resume dump | Session checkpoints store short protocol fields only (capped). Resume uses the existing chat or HANDOFF — no new protocol state, no log paste, no re-pairing. |
| Unauthorized UI output path | MCP delivery selects a destination name registered by the local CLI; scene/input data cannot register an absolute output root or change ordinary file-tool containment |
| Partial or altered UI transfer | Bounded size declarations, SHA-256 verification, expected byte offsets, immutable committed input paths, and atomic completion keep partial bytes out of builds |
| False validation claims | Static and PSD checks are recorded by actual exports; native validation runs a locally registered command, verifies its code and source ZIP binding, and requires actual stage/control checks. No remote tool accepts a caller-provided PASS |

## Token & scope design

Scopes: `workspace.read`, `workspace.search`, `git.read`, `execution.read`,
`offline_access`, plus optional `workspace.write` and `workspace.execute`.
Tools enforce scopes individually (`INSUFFICIENT_SCOPE`). Missing or unknown
requested scopes default to the read-only set. Existing tokens are never
upgraded by changing settings or importing a UI scene. See [writing.md](writing.md)
for explicit authorization.
Access tokens: 1 hour. Refresh tokens: 30 days, rotated. All tokens bound to
`workspace_id` and `client_id`.

## Storage

State lives under the OS-convention app dir
(`~/Library/Application Support/codex-with-chatgpt` on macOS), directories 0700,
files 0600. Named-hostname preference and tunnel metadata live there too
(`tunnels/<workspaceId>.json`) — never in the project. Only SHA-256 hashes of
tokens are persisted — a stolen token-state file does not yield usable bearer tokens.
UI materials, upload state, manifests, and job outputs live below
`ui-workflow/<workspaceId>/`; they can contain the user's artwork and are private
project data. The MCP read scope exposes job metadata and explicitly requested
registered artifacts, not arbitrary state-directory files.

**V1 limitation**: client registrations and token hashes are file-based rather
than OS-keychain-based. Raw tokens are never written anywhere. Keychain
integration is a V2 item.

## Optional write and execution authority

`write_file` and `apply_patch` require `workspace.write` and retain bounded UTF-8,
conflict, path, and project-control-file checks. UI material/job mutations require
the same scope. UI builds require both `workspace.write` and `workspace.execute`.
UI target inspection additionally requires `workspace.read`.
`ui_validate_native` requires `workspace.read`, `workspace.write`, and
`workspace.execute` together. MCP can list or run existing validator IDs;
executable/argument registration and removal are local CLI operations.

`run_command` requires `workspace.execute` and runs PowerShell on Windows or sh
on Unix. It can access files/network outside the workspace and can perform
operations such as deletion, git commits, or package installation even though
dedicated tools for those operations are absent. Enable this scope only for a
trusted account and explicit user-requested tasks. Tool annotations permit the
client's normal confirmation UI; they are not server-enforced per-command approval.

UI destinations are configured by a local CLI operation, not by the bounded UI
tool set. This separation does not sandbox an already authorized arbitrary
`run_command`. Path checks also do not defend against a hostile concurrent local
process replacing directories; use OS isolation for hostile workspaces.
