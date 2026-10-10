# MagicGameStudio native validation adapter

`examples/native-validators/magicgamestudio.mjs` validates a built UI source package with the actual MagicGameClient source-workbench code and its pinned Laya/FairyGUI runtime. Register it as a **trusted local executable**. ChatGPT selects the registered adapter ID; it cannot provide a success report, shell command, executable path, or fingerprint.

This adapter is specific to the inspected source API contract. It does not automate the official FairyGUI Editor desktop application. Its `editorImport` result covers the existing project's real source importer, native source exporter, disk save/reopen, and rendered entry component. The report states that scope explicitly.

## Dependencies and inputs

Use Node 20 or newer on the bridge computer. Install this repository's dependencies normally; the adapter uses its `fflate` and `sharp` packages. The **actual target checkout** must already provide `esbuild` and `playwright-core`, resolved from `<MagicGameClient>/tools/game-ui/package.json`. Supply an installed Chrome/Chromium executable with `--browser`. The adapter does not install packages, download a browser, start the project's development server, or rebuild its distribution.

The target must contain these actual source modules:

| Module under `MagicGameClient/src/app/game-ui/` | API used |
| --- | --- |
| `fgui/domain/source-project-loader` | `readSourceProjectCatalog`, `sourceProjectHash` |
| `fgui/domain/source-project-importer` | `importSourceComponent` |
| `fgui/domain/source-project-export` | `exportSourceComponent` |
| `fgui/domain/source-component-identity` | `sourceComponentDocumentId` |
| `fgui/domain/source-runtime-scene` | `sourceRuntimeSceneAssets` |
| `domain/document-graph` | `DocumentGraph` |
| `publishing/laya/encode-package` | `encodeSavedPackage` |
| `contracts/source-project` | `SOURCE_PROJECT_LIMITS` |
| `runtime/laya/fixed-runtime-support` | Runtime/font installation and version |

Supply the target's actual `FguiProject/Implementation/runtime-lock.json`. The adapter finds `laya.js`, `rawinflate.js`, and `fairygui.js` through the lock's artifact records, then checks their bytes against the recorded hashes. It does not infer a runtime from an example project name or substitute a different vendor build.

Source files, their transitive bundle dependencies, runtime artifacts, the lock, and both adapter scripts are included in a locally approved fingerprint. The `.fairy` platform/version are read by the real importer. A Layabox project can receive the Laya runtime interaction result. For a Unity source project, a successful workbench render can still be reported, but this adapter leaves Unity runtime interaction `not_verified`.

## Register on Windows

Run the following in PowerShell on the machine containing the actual project. Set `$pluginRoot` to this installed repository's absolute path. `$projectRoot` is the real project workspace, and `$chromeExe` must identify an existing browser executable.

```powershell
$pluginRoot = "C:\Tools\codex-with-chatgpt"
$projectRoot = "E:\Workspace\Project-Revert\MagicGameStudio"
$clientRoot = Join-Path $projectRoot "MagicGameClient"
$runtimeLock = Join-Path $projectRoot "FguiProject\Implementation\runtime-lock.json"
$chromeExe = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$nodeExe = (Get-Command node).Source
$adapterScript = Join-Path $pluginRoot "examples\native-validators\magicgamestudio.mjs"
$cli = Join-Path $pluginRoot "bin\c2c.js"
$pinDirectory = Join-Path $env:LOCALAPPDATA "c2c-native-pins"
New-Item -ItemType Directory -Force $pinDirectory | Out-Null
$pinFile = Join-Path $pinDirectory "magicgamestudio-reviewed-v1.json"

& $nodeExe $adapterScript `
  --client $clientRoot --runtime-lock $runtimeLock `
  --write-fingerprint $pinFile
if ($LASTEXITCODE -ne 0) { throw "Native adapter fingerprint setup failed" }
```

`--write-fingerprint` bundles and hashes the inspected local code. It starts no browser or editor. Review the target source and the resulting pin before registration. It refuses to overwrite an existing pin; use a newly reviewed filename when updating the adapter, source APIs, esbuild, runtime, or lock. **Do not register `--write-fingerprint` as a remotely callable adapter.**

Register the fixed command and literal argument list:

```powershell
$register = @(
  "ui", "validator", "add", "--workspace", $projectRoot,
  "--id", "magicgamestudio-source", "--command", $nodeExe,
  "--timeout-ms", "240000",
  "--arg=$adapterScript",
  "--arg=--client", "--arg=$clientRoot",
  "--arg=--runtime-lock", "--arg=$runtimeLock",
  "--arg=--fingerprint", "--arg=$pinFile",
  "--arg=--browser", "--arg=$chromeExe",
  "--arg=--timeout-ms", "--arg=180000"
)
& $nodeExe $cli @register
if ($LASTEXITCODE -ne 0) { throw "Native adapter registration failed" }
```

The runner's 240-second deadline includes setup, fingerprint compilation, browser work, and evidence collection. The adapter's 180-second browser-work deadline is shorter so it can close its own browser and finish the report. These are local execution deadlines; neither changes the target importer's file/byte limits or parser behavior. Use a smaller source fixture to debug integration rather than relaxing the import limits.

After building and statically verifying a workflow job, run:

```powershell
$jobId = "<the job ID returned by c2c ui create>"
& $nodeExe $cli ui validate-native --workspace $projectRoot `
  --job $jobId --adapter magicgamestudio-source
```

The same registered ID is available to ChatGPT through `ui_validate_native`. The runner creates `request.json`, a separate source work copy, and an isolated output directory. It appends the request file as the final adapter argument. Do not construct requests from chat-supplied success data.

For a locally controlled debugging run, the equivalent process invocation is:

```powershell
& $nodeExe $adapterScript --client $clientRoot --runtime-lock $runtimeLock `
  --fingerprint $pinFile --browser $chromeExe --timeout-ms 180000 `
  "<absolute runner-created request.json path>"
```

## What is actually checked

The adapter first matches the delivered ZIP's SHA-256 to the runner request, then compares every uncompressed file with the dedicated source work copy. It rejects symlinks, unsafe paths, duplicate case-folded ZIP names, oversized transfers, missing entry IDs, changed target fingerprints, or unavailable dependencies before claiming native verification.

The entry comes from the validated scene's `entry` and the UI production schema v1 deterministic component resource ID. It must match exactly one real catalog resource. The canvas comes from that same scene. There are no fixed interface names, row counts, resource IDs, or portrait dimensions.

| Report check | Actual operation |
| --- | --- |
| `open` | Read the project through `readSourceProjectCatalog`; explicitly import every registered component, including dependencies, with `importSourceComponent`. Reject catalog issues or unimportable components. |
| `save` | Call the project's `exportSourceComponent` on the imported entry and dependencies; write the returned source bytes to an isolated `saved-source` directory. |
| `reopen` | Re-read those disk files, rerun catalog/import, and check their byte hashes against the saved output. Encoding uses these reopened documents. |
| `render` | Run `sourceRuntimeSceneAssets`, `DocumentGraph`, and `encodeSavedPackage`; load the pinned Laya/FairyGUI scripts and real encoded resources/fonts; instantiate the exact entry and capture `native-preview.png`. Browser errors fail this check. |

All four checks must pass for `editorImport: passed`. The original source work copy, delivered ZIP, compiled target source files, vendor artifacts, and runtime lock are checked again after execution. Source export may produce different legitimate XML formatting; `unchangedFilesByteExact` records whether the save was byte-identical without conflating that fact with a successful native reopen.

## Runtime probes and limits

Enabled, initially visible controls are tested using the real runtime objects. Pointer and keyboard probes use Playwright events. Controls outside the canvas or a parent scrolling viewport are not treated as reachable.

| Type | Probe |
| --- | --- |
| Button | Actual pointer down/up and click; authored controller/down-effect feedback; Check/Radio selection; restoration. No visual state is invented when none was authored. |
| InputText | Actual focus, select-all, text insertion, and text readback. Empty restrictions and recognized digit-only restrictions are supported; unknown restrictions remain unverified. |
| Slider | Drag the actual `grip`; observe a changed value within the authored min/max and integer rule. No range or SDK flags are changed. |
| ProgressBar | Set native value to the authored min/max, check real bar geometry/fill changes, then restore. A game-service update is outside this check. |
| ComboBox | Open the real popup, choose an actual option, wait for the native deferred popup closure, and verify selection. Empty option sets remain unverified. |
| List | Scroll its linked native ScrollPane using pointer drag, or enabled mouse wheel; record displacement and restore selection/count/position. A real ComboBox popup also supplies a separately scoped List-selection check. |
| ScrollBar | Drag the real `grip` of a scrollbar linked to a native ScrollPane; verify the target's displacement and restore it. |

If a list does not initially overflow, the default probe may temporarily add at most 32 copies of its existing item template **inside the disposable runtime instance**, then remove them and restore the original item count. This is recorded as test data; the source and business data are not written. Register the additional fixed argument `--no-list-fixtures` to require authored overflow only. Hidden-scrollbar configurations in the inspected SDK disable mouse wheel; the adapter records the actual flags and uses enabled pointer scrolling without patching them.

No control type is declared passed solely because its XML parses. An unavailable, disabled, empty, off-screen, unsupported, or unexecuted probe receives `not_verified`; a performed probe that does not produce its required state change receives `failed`. The adapter bounds a run to 128 reachable controls and records any remaining types as unverified. It does not guess business callbacks or invoke game services. Finally, it restores the native scene and compares every screenshot pixel with the initial preview. A changed restored canvas fails interaction validation.

## Reports, evidence, and exit status

`report.json` follows the trusted runner's strict schema and binds `jobId`, `buildInputHash`, and `sourceZipSha256`. Checks contain only `name`, optional `type`, `status`, and optional `note`. Complete native results, control geometry/text, timings, before/after states, errors, source hashes, and restoration details remain in evidence files beneath the requested output directory:

- `native-preview.png` — the actual native initial render; the runner can expose it as `Previews/FGUI_Native.png`.
- `native-restored.png` — post-probe restored scene.
- `native-controls.json` — actual object IDs, paths, native kinds, global/local geometry, visibility, fonts, and text.
- `source-inventory.json`, `source-fingerprint.json`, `roundtrip-inventory.json`, `encoded-inventory.json` — byte identities across each stage.
- `runtime-interactions.json`, `adapter-details.json` — detailed checks, timings, console/browser errors, and explicit limitations.

The adapter prints short JSON phase messages and a heartbeat every 15 seconds while native work is active. It opens a fresh headless browser and a random-token loopback file service on an ephemeral port, then closes only those resources. Non-loopback browser requests are blocked. No existing editor process, development server, target source file, parser, or importer limit is changed.

Exit code `0` means a valid bound report was written, including reports whose verification status is `failed` or `not_verified`. A nonzero exit means the adapter could not complete its report contract. Consumers must read the report status, not turn process completion into an import/interaction pass. A missing browser, source API mismatch, or changed fingerprint is `not_verified`; inspect the detailed evidence before explicitly updating the local configuration.
