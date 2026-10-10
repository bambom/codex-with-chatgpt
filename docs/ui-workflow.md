# UI production in the existing ChatGPT plugin

The connected **Codex with ChatGPT** plugin can assemble a game UI into real layered PSD, PNG assets, FairyGUI editor source XML, previews, and validation reports. Jobs, uploaded materials, revisions, and results persist on the computer running the bridge. The existing workspace connection and OAuth scopes continue to apply.

ChatGPT supplies the design decisions, image generation, material separation, transcription, and semantic scene. The plugin performs bounded file transfer, source-format inspection, deterministic export, validation, and local delivery. It does not call an image-generation API or automatically recover a complete editable UI from a screenshot.

Future architecture: [platform-owned design storage, result submission and on-demand exports](ui-design-platform-integration.zh-CN.md), [a canonical UI authoring format with target adapters](ui-canonical-format-proposal.zh-CN.md), and [FGUI round-trip synchronization](ui-roundtrip-sync-proposal.zh-CN.md). The new direction keeps image production, asset separation, semantics, layout and full-canvas PNG reconstruction in ChatGPT; the plugin retrieves the platform specification and submits the completed result. MagicGameClient and its server own accepted designs and all PSD/FGUI/Unity/Cocos generation. These are proposals, not implemented behavior. The remainder of this guide describes the current v0.2.0 local export workflow, which does not yet provide platform submission or target round-trip import.

The platform proposal creates a separate Home entry, editor window and server business flow by copying the AI layer feature's relevant code. The original AI entry remains its own feature, and the separate `game-ui` FGUI editor project is outside this implementation scope.

## Choose the output directory

The built-in `workspace` destination needs no extra configuration and writes under:

```text
<connected-workspace>/generated/ui-deliveries/<job-subdirectory>/
```

To use a different Windows directory, register a name **on the computer running the plugin**. For example:

```powershell
node C:\Users\bambo\codex-with-chatgpt\bin\c2c.js ui destination add --name game-ui --path "E:\UI-Deliveries" -w "E:\Workspace\Project-Revert\MagicGameStudio" --json
```

Replace the checkout, project, and destination paths with the actual local paths. This command authorizes that directory for this workspace. ChatGPT can subsequently select `destination_id: "game-ui"`; it cannot register another path through a UI tool. The named configuration is kept in the plugin's local state, outside project data.

Use `c2c ui destination list -w <workspace> --json` to inspect names. Use `c2c ui destination remove --name game-ui -w <workspace> --json` to remove a name; this does not delete delivered files. Removing a name also prevents later jobs from delivering through it. Ordinary `Workspace.resolve`, text-write restrictions, and OAuth defaults are unchanged.

## Start from ChatGPT

An example request is:

> 用这个插件把我提供的最终设计稿制作成分层 PSD、透明 PNG 散图和 FGUI 原生源工程。沿用原始画布和文字，先研究项目的 FguiProject，使用已配置的 game-ui 输出目录，分别报告静态检查、编辑器导入和交互验证结果。

Call `workspace_info` first. Then call:

```json
{"action":"capabilities"}
```

with `ui_workflow_info`. Its `guidance` action returns the bundled `ui-production` skill. Its `schema` action returns the exact machine-readable schema used by `ui_set_scene`. The same skill is a genuine MCP resource at `c2c://skills/ui-production/SKILL.md`, available through `resources/list` and `resources/read`. Clients that do not expose resources can read it through the tool. This implementation does not claim automatic installation in ChatGPT's Skills UI or a complete experimental skills protocol.

The skill lives at `skill/ui-production/SKILL.md` in this Git repository. It supplements the existing `skill/SKILL.md` connection workflow; the existing setup and pairing skill is not replaced.

## Activate an already installed upgrade

Building an updated checkout does not replace code already loaded by a running bridge. This implementation has no hot-reload command. `start`, `setup`, and `doctor` reuse a healthy bridge for the workspace without comparing its version with the installed CLI, so they do not automatically activate new tools in that process. Newly launched local `c2c ui ...` commands can use the updated files immediately; the ChatGPT connection exposes the new tools only after the bridge and connection have been updated.

The following steps activate code that has already been reviewed, installed, and built locally. Publishing its Git branch is a separate operation and requires an explicit publishing instruction; continuing local work does not imply permission to push or publish it.

1. Finish active builds and native validators. Open an **independent terminal on the bridge computer**, or use a local Codex session that will remain available after the bridge stops. Do not restart through the sole MCP `run_command` connection to that same bridge: shutdown also stops its tunnel, so the connection can disappear before it returns the replacement address.
2. From that independent Windows terminal, use the actual checkout and workspace paths:

   ```powershell
   $pluginCheckout = 'C:\Path\To\codex-with-chatgpt'
   $workspaceRoot = 'E:\Path\To\GameWorkspace'
   node "$pluginCheckout\bin\c2c.js" --version
   node "$pluginCheckout\bin\c2c.js" restart --tunnel -w "$workspaceRoot"
   node "$pluginCheckout\bin\c2c.js" status -w "$workspaceRoot" --json
   node "$pluginCheckout\bin\c2c.js" doctor -w "$workspaceRoot" --no-fix --json
   ```

   `restart` has no `--json` option. Check that the running version reported by `status` matches the installed CLI version and that the workspace is correct. With a Quick Tunnel, restarting stops the old public address and starts a new one. Use the actual new `chatgptRepair.mcpUrl` from doctor, or the reported `publicUrl` followed by `/mcp`; never reuse a guessed address. Keep the first doctor result: endpoint detection also records the new address locally, so a later `chatgptRepair.needed: false` does not prove that ChatGPT has been reconfigured.
3. Follow **Workflow: reconnect after address reclaim** in the existing [connection skill](../skill/SKILL.md). For a changed URL, remove only this workspace's old connector and create it again with the **same recorded connector name**, the new server URL, and OAuth authentication. Leave other workspaces' connectors and the Project's connector-name instructions intact. The existing workflow uses removal and recreation for a changed URL; it does not rely on a Refresh or Reconnect button on the old address.
4. Complete the normal OAuth authorization. Request the scopes needed for UI production as described in [writing.md](writing.md). When the authorization form is ready for a pairing code, run this in the independent terminal:

   ```powershell
   node "$pluginCheckout\bin\c2c.js" pair -w "$workspaceRoot" --json
   ```

   Use that fresh one-time code on the authorization form. Use the same Windows account, workspace path, and existing `C2C_STATE_DIR` override if one is configured. Do not delete state or run `unpair` as an upgrade step. Persisted configuration and jobs are separate from the restarted process; this does not guarantee reuse of a previous OAuth grant after the server URL changes.
5. Verify the connection from ChatGPT itself: call `workspace_info`, confirm the intended workspace, then call `ui_workflow_info` with `action: "capabilities"` and `action: "guidance"`. Confirm that the connection now exposes the 14 `ui_*` tools, including `ui_validate_native`. A green doctor report or the new version on disk alone is insufficient. If the old conversation remains bound to the removed connector, use the existing skill's same-Project/new-chat handoff procedure and verify the workspace again before continuing.

`ui_workflow_info` remains a read-only discovery operation.

## Production sequence

1. Inspect the supplied image. Preserve an explicitly final design and record the original canvas dimensions and exact visible text.
2. Create a job with `ui_create_job`. Supply a workspace-relative `target_project`, an optional workspace-relative approved `design_file`, and the configured `destination_id`.
3. Run `ui_inspect_target`. It reads the actual project configuration, XML examples, and source evidence and records a supported-format profile. Fix unsupported or incomplete target evidence before export; do not make up tags or modify the target parser.
4. Preserve the approved final design or generate and inspect one complete design before separating assets. Import or upload that design and the separate materials. Use the roles `reference`, `design`, `asset`, `font`, `license`, and `data`. A job needs an actual design image for a production build. Its dimensions must match the scene canvas.
5. Submit one complete scene with `ui_set_scene`. Use the latest job `revision` as `expected_revision`. Reusable components own local coordinates; instances reference components, and native text and controls retain their semantics.
6. Run `ui_build` with the latest revision. Read its persisted result and artifact inventory. Use `ui_preview_artifact` to view the actual composite without downloading a large image in many chunks. Compare it with the final design and inspect the reports.
7. Read `ui_workflow_info` with `action: "validators"`. When a compatible local editor/runtime validator is configured, run `ui_validate_native` with its `adapter_id` and inspect its real report. Otherwise report editor and runtime checks as unverified.
8. Run `ui_deliver` for a configured destination. Use the actual returned output location and inventory in the user-facing delivery. Transfer requested downloadable copies with `ui_read_artifact_chunk` and verify their complete hashes after reassembly.

After any successful modifying call, obtain the latest revision from the returned job or `ui_workflow_info` with `action: "job"`. A stale revision fails instead of silently replacing another edit. Do not assume that two consecutive requests share in-memory state: the MCP transport is stateless; jobs persist in local storage.

## Tool interface and authorization

| Tool | Purpose | Required scopes |
| --- | --- | --- |
| `ui_workflow_info` | Capabilities, guidance, schema, jobs, status, artifact metadata, destinations, configured validators | `workspace.read` |
| `ui_create_job` | Create a persisted job | `workspace.write` |
| `ui_import_file` | Import original bytes from a workspace-relative source | `workspace.write` |
| `ui_begin_upload` | Reserve a size- and hash-declared upload | `workspace.write` |
| `ui_upload_chunk` | Append actual bytes at the expected offset | `workspace.write` |
| `ui_finish_upload` | Validate and register a complete upload | `workspace.write` |
| `ui_abort_upload` | Discard an unfinished upload, preserving committed materials | `workspace.write` |
| `ui_set_scene` | Validate and save the semantic scene | `workspace.write` |
| `ui_inspect_target` | Read target evidence and save its profile in the job | `workspace.read`, `workspace.write` |
| `ui_build` | Produce exports and validation reports | `workspace.write`, `workspace.execute` |
| `ui_validate_native` | Execute a locally registered editor/runtime validator for this build | `workspace.read`, `workspace.write`, `workspace.execute` |
| `ui_deliver` | Copy verified artifacts into a configured destination | `workspace.write` |
| `ui_read_artifact_chunk` | Read registered artifact bytes for download | `workspace.read` |
| `ui_preview_artifact` | View a registered preview as an actual MCP image | `workspace.read` |

Existing read-only tokens stay read-only. Use the normal explicit OAuth authorization process described in [writing.md](writing.md) if the required scopes are absent. Never edit token records to elevate access.

These 14 UI tools supplement the 13 existing workspace tools. There is no MCP tool for changing destinations or validator commands, fetching arbitrary URLs, reading arbitrary host files, or recording a caller-supplied validation PASS. A trusted native editor/runtime adapter must provide real execution evidence before those checks can be marked as passed.

### `ui_workflow_info` actions

- `capabilities`: supported formats and current limits.
- `guidance`: bundled skill text and resource URI.
- `schema`: JSON Schema for the complete scene.
- `jobs`: compact job summaries for this workspace, including checks and input/artifact counts; full file arrays are omitted.
- `job`: one job; requires `job_id`.
- `artifacts`: one job's registered output metadata; requires `job_id`.
- `destinations`: locally configured destination names and their actual output paths.
- `validators`: locally configured validator IDs, executable paths, and timeouts; does not execute them.

Ordinary metadata reads do not include large binary data. Artifact byte reads require an explicit separate call.

## Transfer actual image and document files

`ui_import_file` takes `source_path` relative to the connected workspace and `path` relative to the job. It does not fetch a cloud URL or copy from an arbitrary absolute path.

For a file held by the current ChatGPT environment:

1. Compute SHA-256 over the actual bytes and call `ui_begin_upload` with `job_id`, `path`, `role`, `size_bytes`, and `sha256`.
2. Use the returned `uploadId`, `chunkBytes`, and `nextOffset`. Call `ui_upload_chunk` with `upload_id`, `offset`, and raw `data_base64`. An optional `sha256` checks the decoded chunk.
3. Continue in order. Call `ui_finish_upload` after the declared byte count is complete. The full file hash must match before the material becomes available to builds.

If the declared hash or file is wrong, call `ui_abort_upload` and begin a corrected upload. Aborting cannot delete a committed job material. For an explicitly selected file already on the bridge computer, the local-only `c2c ui import-local` command accepts its local path; it is not a remote MCP operation.

Do not fabricate base64 or ask the user to paste it. Use the running environment's supported file-byte operations. No browser credentials, guessed download addresses, or shell requests to authenticated image URLs are required by this protocol.

Current limits are 512 KiB per uploaded chunk, 64 KiB per artifact read, 256 MiB per file, 1 GiB per job, 2 MiB of serialized scene JSON, and 16 MiB per job/receipt manifest. Treat the live `capabilities` result as authoritative. Files are immutable by job path: a same-path, same-hash import is idempotent; a changed material must use a new versioned filename and scene reference.

Downloads return base64 bytes plus offsets and hash metadata. Reassemble bytes in order and check complete length and SHA-256 before calling the resulting PSD or ZIP successfully downloaded.

## Scene and source-format fidelity

The JSON scene distinguishes image resources from UI objects. Assets include file paths, real dimensions, optional nine-slice center rectangles, crop offsets, and provenance. Text nodes hold editable text and style. Components and instances hold control semantics and current state separately. Fonts and their license files can travel with the job.

The initial supported scene schema uses explicit fixed-size component instances and identity transforms. Unsupported resize, rotation, controller, rich-text, or target-source behavior is rejected or identified in the returned validation result. Use explicit component variants or a tested target adapter when needed. A request being rejected does not authorize degrading a known button or input to an image.

The exporter preserves supported source conventions such as `extention`, resource IDs and package references, native text input structure, controller page references, and a true x/y/width/height `scale9grid` center rectangle. Actual project evidence, rather than runtime API names, determines whether the target can be exported.

This version supports the verified FairyGUI source 5.0 adapter for explicitly selected Layabox or Unity projects. It emits a self-contained package with its component dependencies. It does not claim compatibility with arbitrary source versions, every editor feature, or unresolved external package references.

When the actual importer has a tighter byte budget than the original artwork, an asset may explicitly declare `fgui: {file, width, height, scale9grid?, provenance}` and a font may declare `fgui: {file, family, provenance}`. Import both original and variant files before setting the scene. PSD/PNG retain the originals; the native exporter uses only the declared variants and records their source mapping. Nine-slice coordinates refer to each variant's actual pixels. Loader variants must preserve the validated content-size behavior. The plugin does not silently resize, quantize or subset an image/font. Supplied font variants must cover known text in templates, hidden states, list items, popup options and numeric controls; future dynamic text still needs suitable coverage. PNGs used only as PSD text references are excluded from the native package.

For a repeatable local integration check, see [the native adapter setup](native-magicgamestudio.md) and `examples/ui-production/verify-local.mjs`. It runs the committed 360×480 synthetic control fixture through this same production API against an explicitly selected real project, saves real outputs, and optionally calls a registered native validator. Its procedural fixture is labeled as verification data, not a generated production design.

## Verification claims

Report the three gates separately:

| Gate | What establishes it |
| --- | --- |
| Static validation | Actual scene, asset, XML/reference, native-control-structure, PSD reread, and output checks that ran |
| Editor import | A real editor/importer opened, saved, reopened, and rendered the generated source |
| Runtime interaction | A trusted adapter exercised the relevant controls and captured its actual results |

The normal exporter does not infer the last two from valid XML. Leave unavailable checks unverified. The design image is a visual reference, not evidence that every business callback, list scroll, or slider drag is implemented. Keep unknown game bindings in the generated binding inventory.

## Configure and run a real native validator

Register an existing adapter on the bridge computer. The adapter must implement the target editor/importer and runtime checks; registration itself does not install an editor or perform those checks. For a Node adapter, use an absolute script path:

```powershell
c2c ui validator add --id fairy-editor --command node --arg "C:\Tools\FGUI\validate-ui.mjs" --arg "{request}" --timeout-ms 120000 -w <workspace> --json
c2c ui validator list -w <workspace> --json
c2c ui validate-native --job <job-id> --adapter fairy-editor -w <workspace> --json
```

Replace the script path with the actual compatible adapter. For another executable, `--command` must be its absolute path. Repeat `--arg` for each literal argument; use `--arg=--flag` for an argument beginning with a dash. The timeout is 1000–300000 milliseconds and defaults to 120000. `{request}` is replaced only when it is an entire argument; when omitted, the request path is appended. The runner uses `shell: false` and verifies the registered executable/code hashes before execution. Re-register locally after an intentional adapter update.

ChatGPT can discover registrations through `ui_workflow_info` with `action: "validators"`, then invoke:

```json
{"job_id":"<job-id>","adapter_id":"fairy-editor"}
```

with `ui_validate_native`. Its only inputs are the job and configured adapter IDs. All three scopes—`workspace.read`, `workspace.write`, and `workspace.execute`—are required. Use `c2c ui validator remove --id fairy-editor -w <workspace> --json` to remove a registration without deleting adapter code or previous evidence.

### Adapter request and report

The fixed executable receives a generated request JSON file. It contains `schemaVersion`, `jobId`, `buildInputHash`, `sourceZipSha256`, `workspaceRoot`, `sourceDirectory`, `sourceZip`, `sceneFile`, `outputDirectory`, `reportFile`, and `expectedInteractions`. Open and save the isolated source copy at `sourceDirectory`; preserve the previously verified source ZIP and deliverables.

Write the actual report to `reportFile`, with this shape:

```json
{
  "schemaVersion": 1,
  "jobId": "<request.jobId>",
  "buildInputHash": "<request.buildInputHash>",
  "sourceZipSha256": "<request.sourceZipSha256>",
  "editorImport": {"status": "not_verified", "checks": [], "note": "Actual execution details"},
  "runtimeInteraction": {"status": "not_verified", "checks": [], "note": "Actual execution details"},
  "evidence": [],
  "limitations": []
}
```

This is a structural example; fill it from actual execution. Each check has `name`, `status`, and optional `type` and `note`; statuses are `passed`, `failed`, or `not_verified`. An editor pass requires passed checks named exactly `open`, `save`, `reopen`, and `render`, with no failing or unverified checks in that stage. A runtime pass requires passed checks covering every control type in `expectedInteractions`, such as `Button`, `InputText`, `Slider`, `ProgressBar`, `List`, `ComboBox`, or `ScrollBar`. Record concrete checks such as selection state, text input, drag/value linkage, progress updates, scrolling, or popup selection as appropriate to the scene.

Place captured evidence files under `outputDirectory` and list their relative paths in `evidence`. Include an actual rendered PNG named `native-preview.png` to also publish it as `Previews/FGUI_Native.png`; inspect that artifact with `ui_preview_artifact` and compare it with the PSD composite. A successful run copies the report and evidence into `Reports/native/`, updates the validation report and artifact hashes, and leaves previously delivered folders intact. Job ID, build hash, and source ZIP hash must match the request. A timeout, execution failure, mismatched report, or incomplete pass evidence does not establish a new success. The plugin has no tool that allows a caller to supply a trusted PASS directly.

## Local CLI equivalents

Use `c2c ui --help` and the relevant subcommand's `--help` for exact options. The CLI also provides `info`, `guidance`, `create`, `list`, `status`, `artifacts`, `import`, `import-local`, `abort-upload`, `inspect-target`, `set-scene`, `build`, `validator`, `validate-native`, and `deliver`. Pass `-w <workspace>` and `--json` when scripting.

For example, after creating a job and obtaining its latest revision:

```powershell
c2c ui inspect-target <job-id> --path FguiProject -w <workspace> --json
c2c ui set-scene <job-id> --file ui/scene.json --revision <current-revision> -w <workspace> --json
c2c ui build <job-id> --revision <new-revision> -w <workspace> --json
c2c ui validate-native --job <job-id> --adapter fairy-editor -w <workspace> --json
c2c ui deliver <job-id> --destination game-ui -w <workspace> --json
```

Use a fresh revision for each dependent modifying step. Run the native-validation line only after configuring a compatible adapter. A failed build keeps its failure state and does not become a successful delivery.
