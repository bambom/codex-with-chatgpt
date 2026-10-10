# Native control verification fixture

`inventory-all-controls.scene.json` is a generic 360 × 480 inventory test scene.
Its complete immutable input directory is `inputs/`: one real RGBA texture, one
licensed single-face font, and that font's OFL license. It does not depend on the
previous interface or on external game services. The fixture is a functional
control test, not a finished art design.

Import each file below `inputs/` into a workflow job with its relative path intact,
then submit the Scene JSON. Use a target profile inspected from an actual `.fairy`
project in the connected MagicGameStudio workspace. No platform/version is encoded
in the Scene or inferred from this fixture's name.

The scene contains a normal button, Check and Radio buttons, editable input,
horizontal Slider (0–100, 25), ProgressBar (0–100, 75), vertical scrolling List
with eight distinct reusable items and an associated ScrollBar, a ComboBox with
two selectable options and a real popup List, and an initial controller page.
Slider `bar` is authored at its full 184 px length; the initial shared layout
resolves it to 46 px through the instance value and its grip relation.

The source-export regression test enforces the real current importer ceiling of
64 files and 2,000,000 bytes. It also checks hidden state glyph coverage. Every
native import, save/reopen, screenshot and pointer interaction remains a separate
native-validator result; unit tests do not certify those operations.

The PSD/PNG renderer can use this same Scene directly. Supply a separate complete
master image only when exercising the hidden design-reference workflow; no
fabricated source image or automatic visual pass is included in this fixture.

After `pnpm build`, the development driver can exercise all persisted workflow
stages with an explicitly labeled synthetic master made from this scene:

```powershell
node examples/ui-production/verify-local.mjs `
  --workspace "E:\Workspace\Project-Revert\MagicGameStudio" `
  --target "<the actual workspace-relative .fairy file>" `
  --report "<a new absolute verification-result.json path>" `
  --output "<an absolute test-delivery directory>" `
  --native-adapter "magicgamestudio-source"
```

Register the compatible native adapter locally first, following
`docs/native-magicgamestudio.md`. Omitting `--native-adapter` exercises static
assembly only and leaves editor/runtime checks unverified. The script will not
overwrite an existing result JSON. Its result records the real job ID, target
fingerprint, native report if run, and delivery receipt.
