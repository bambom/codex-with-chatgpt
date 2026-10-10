# UI production verification — 2026-10-10

The UI production implementation at commit `5bef844` was built and exercised on the actual Windows machine hosting the MagicGameStudio workspace. The committed synthetic inventory fixture passed source import, native rendering, interactions and delivery. The full machine-readable summary and artifact hashes are in [validation/ui-production-windows-20261010.json](validation/ui-production-windows-20261010.json).

## Results and scope

| Check | Result | Evidence scope |
| --- | --- | --- |
| TypeScript build | Passed on Linux and Windows | Compiled plugin version 0.2.0 |
| Complete repository tests | 245 passed, 26 test files | Linux; includes original workspace/OAuth tests and new production tests |
| Windows UI regression tests | 52 passed, 6 test files | File recovery, paths, native report protocol, MCP transport, PSD and FGUI |
| Source static checks | Passed | 17 files / 112,417 bytes, 14 resources, 12 components; within the actual 64-file / 2,000,000-byte importer budget |
| PSD reread | Passed | 30 independent layers, 17 groups, hidden original comparison layer; exact layer RGBA bytes, order and metadata |
| Editor import | Passed for the project's actual source workbench | `readSourceProjectCatalog`, `importSourceComponent`, `exportSourceComponent`, disk save/reopen, native encoding and render |
| Runtime interaction | Passed | 12 executed checks across seven native control types |
| Restored native canvas | Passed | Initial and restored PNGs have the same SHA-256; zero changed pixels |
| Local delivery | Passed | 83 artifacts / 1,164,687 bytes copied and hash-verified, plus an 18,128-byte delivery receipt; the final directory contains 84 files / 1,182,815 bytes |
| Official FairyGUI desktop / Photoshop GUI | Not verified | No GUI application pass is inferred from source APIs or PSD parsing |
| New tools in the existing ChatGPT connection | Pending activation | The already running process does not hot-reload a rebuilt checkout |

This is a 360 × 480 **verification fixture**, with explicit test data and a procedural skin. It is not a replacement for a user's approved UI design. Native geometry and current values were visually inspected against the shared PSD layout. The PSD preview retains transparency; the native test canvas has a white background. Text rasterization also differs between Pango and Laya. No cross-renderer pixel-identical claim is made. PSD merged-cache transparency and compositor rounding are recorded separately from exact independent layer bytes.

The selected `.fairy` actually declares Layabox source version 5.0. Target inspection collected 68 evidence files. The native validator separately fingerprinted 91 source dependencies and the recorded runtime profile `laya-3.4.1-fgui-0a9368b-r00-a`. These are read from the target's files, not inferred from a demonstration directory name. Target source and vendor fingerprints were checked again after native execution.

## Actual native controls exercised

The run clicked normal, Check and Radio buttons, verified authored press/selection feedback and restoration, typed into the real input, dragged the slider, drove the progress bar with its actual minimum and maximum values, selected a real ComboBox popup option, scrolled the list, and dragged its associated scrollbar. Internal grip buttons were also exercised. The test returned the runtime to its initial image without changing the source project or implementing game callbacks.

The first native run caught two issues which were fixed before the passing run:

1. The button probe wrongly required Common-mode mouse-down feedback for Check/Radio. The corrected probe follows the real SDK's selection-on-click behavior, while still failing missing Common feedback or a missing selection change.
2. A scrollbar grip authored as `Image` could not receive pointer events in the pinned SDK, even with `touchable=true`. It is now a native Common Button with a skin related to its parent's width/height. Scene and independently reread XML checks reject non-hittable grips. The shared layout resolves the proportional grip skin to its actual initial size.

The target parser, SDK and importer limits were not modified to make this fixture pass.

## Reproduce

Run `pnpm install --frozen-lockfile`, `pnpm build` and `pnpm test` in the plugin checkout. For native verification, configure the actual project adapter using [native-magicgamestudio.md](native-magicgamestudio.md), then run `examples/ui-production/verify-local.mjs` with an explicit actual project, a new result JSON path, and that registered adapter ID. [The fixture guide](../tests/fixtures/ui/README.md) lists its inputs and complete command form.

The successful run is job `ui_e22a4451c0644adebc89b3c05c0cf5d9`. Its output is under the connected workspace at:

```text
generated/ui-deliveries/UI_Workflow_Native_Verification-5c0cf5d9/
```

That directory contains `Interface.psd`, `PNG_Assets.zip`, `FGUI_Source.zip`, actual native and PSD previews, semantic/layout/font/binding manifests, static/PSD/native reports, source inputs and a delivery receipt. The native ZIP SHA-256 is `3f4a772a6578ddd5c41f300242379d9d67d308f12ff90b32956378ad4b6607de`.

## Activation and repository status

The new CLI is available from the built checkout. The existing ChatGPT bridge process still uses its previously loaded code; this report does not claim its 14 additional tools are already active. Follow [Activate an already installed upgrade](ui-workflow.md#activate-an-already-installed-upgrade) from an independent local terminal/session, retaining the normal OAuth/connection workflow.

Local commits and Windows installation are complete. Automatic approval review rejected the GitHub push because the session explicitly authorized committing and had not explicitly authorized remote publication. No remote push or alternate publication route was used. The feature branch is ready for review and an explicitly authorized push.
