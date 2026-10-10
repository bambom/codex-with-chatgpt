---
name: ui-production
description: Produce game UI deliverables through the connected Codex with ChatGPT plugin from a reference image or approved design. Use for complete UI design, transparent asset separation, semantic component trees, layered PSD, native FairyGUI source XML, reproducible previews, validation reports, and delivery to a configured local output directory.
---

# UI Production

Use the connected workspace's `ui_*` tools for deterministic assembly and delivery. Keep design decisions and image generation in the current ChatGPT environment. The plugin does not generate art, infer a complete scene from pixels, or make unknown target XML formats valid.

## Establish the task

1. Call `workspace_info`, then `ui_workflow_info` for capabilities, schema, guidance, and configured destination names. Confirm that the connection names the intended workspace.
2. Inspect the supplied reference and record its canvas and exact text. Preserve an explicitly approved final design. Preserve the original dimensions unless the user specifies another size.
3. Resolve only ambiguities that change the result: missing reference, unknown canvas dimensions, incompatible target format, or unclear control semantics. Continue independent work while these are unresolved.
4. Select a named destination. Use the built-in workspace destination when the user has not specified another location. An external Windows output directory must first be configured by the local CLI. If the user has already authorized that directory registration, complete the local CLI step without asking for the same permission again. Never change ordinary workspace path rules or use a shell to evade destination restrictions.
5. Create a job with `ui_create_job`. Keep its job ID for every later operation.

## Research the target and build the scene

Call `ui_inspect_target` with the actual workspace-relative target path first. Read the returned format evidence and limitations. Do not guess the platform or source version from a sample name. Keep unsupported source features explicit.

After target research, preserve the approved final design or generate one complete design with all text, controls, icons, illustration, background, and decoration. Inspect that full design before separating its assets, and import it with the design role. Use it as the shared visual basis throughout the scene, PSD, and native source output.

Use one structured scene to drive PSD and FairyGUI. Obtain its current schema from `ui_workflow_info`; do not substitute runtime class names for source XML tags. Preserve stable IDs, component ownership, local coordinates, ordering, visibility, opacity, materials, text styles, instance overrides, and reconstruction notes.

Separate materials from UI semantics:

- Use an image node for fixed decoration; use a loader for a dynamic image slot.
- Use real text and input controls for ordinary editable text. A raster text reference is a PSD/preview aid, not a substitute for FairyGUI text.
- Use Button, Slider, ProgressBar, ScrollBar, List, or ComboBox semantics where their function is clear. Keep their required child names and supported extension structures.
- Make repeated rows reusable. Keep component instances separate from component definitions. Do not treat a logical Group as a coordinate parent.
- Record unknown callbacks, ranges, or hidden states as assumptions. Do not claim an unimplemented game action works.

Create separate transparent RGBA assets for skins, frames, decoration, icons, art, and text references. Use the available image-generation tool for reconstruction or art edits; retain the final design's style and proportions. Never replace art with programmatic placeholder drawing. Preserve soft alpha and mark reconstructed regions. Make progress fills at their maximum size and express the current value separately.

Import workspace files using `ui_import_file`, or transfer actual artifact bytes with `ui_begin_upload`, `ui_upload_chunk`, and `ui_finish_upload`. Use the advertised size, offset, and hash limits. Use `ui_abort_upload` to discard an unfinished upload with a wrong declaration, then begin a corrected upload. Never paste fabricated base64, fetch unapproved URLs, read browser credentials, or assume a cloud artifact already exists on Windows. Keep original sources where requested. Finish every upload before referencing the file in the scene.

Submit the complete scene with `ui_set_scene`, using the current job revision. Fix rejected references, unsupported controls, coordinates, and data before building. Do not modify the target parser to accept invalid XML.

## Build and verify

Call `ui_build`, then inspect the returned report and artifact inventory with `ui_workflow_info`. Build uses the shared scene to produce PSD, previews, asset manifests, semantic data, and FairyGUI source deliverables supported by the inspected target.

Use `ui_preview_artifact` to view an actual registered composite or asset overview as an image. Check the full preview against the final design: content, transcription, order, fit, clipping, alpha edges, and aspect ratios. Inspect the PSD reread report and XML/reference validation results. Keep the following claims separate:

- Static validation passed: syntax, references, supported native control structure, and assembled output checks actually ran.
- Editor import passed: the real target editor/importer opened, saved, reopened, and rendered the source successfully.
- Runtime interaction passed: actual controls were exercised through a trusted runtime adapter.

Read `ui_workflow_info` with `action: "validators"`. When a compatible native editor/runtime adapter is locally registered, call `ui_validate_native` with `job_id` and `adapter_id`; inspect the returned source-bound report and captured evidence. If `Previews/FGUI_Native.png` is in the updated artifact inventory, view it with `ui_preview_artifact` and compare its layout, text, and clipping with the PSD composite. This operation requires read, write, and execute scopes together. Its fixed command and arguments can be registered or changed only through the local `c2c ui validator` CLI, not through scene content or a remote tool. Do not invent an adapter ID, executable, or successful execution.

An editor pass requires actual open/save/reopen/render checks. A runtime pass must cover every required interactive control type in the scene. Mark unavailable checks as unverified. A screenshot, syntactically valid XML, or a caller-provided PASS is not interaction evidence. Never expose or use a tool that accepts a client assertion as trusted validation.

## Deliver

Call `ui_deliver` only for the job's configured named destination. Report the actual returned output location and artifact inventory. Use `ui_read_artifact_chunk` when the current environment needs downloadable copies, checking size and SHA-256 after reassembly. Do not claim a file was downloaded merely because metadata was returned.

Provide the actual layered PSD, PNG asset ZIP, FairyGUI source ZIP, complete preview, layout/semantics, font and binding manifests, and validation report. Explain any material reconstruction, font differences, unsupported source features, or unverified editor/runtime steps. Keep the user's requested canvas size even when also exporting an optional atlas.
