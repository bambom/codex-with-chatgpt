# Local image extension

The original text-only `read_file` cannot show pictures. This local extension adds
`read_image(path, max_edge=2048)` using the existing `workspace.read` authorization.
It returns an actual MCP image block and a short metadata block, not base64 text.

PNG, JPEG, WebP and GIF are supported. Inputs are limited to 20 MiB and 64 megapixels.
Previews preserve aspect ratio and transparency, correct orientation and strip
metadata. Images larger than 2048 pixels are resized; animated images use frame 1.
Output is PNG, or WebP when PNG would exceed 4 MiB. SVG/PDF/PSD are not supported.
Workspace containment, sensitive-file exclusions and `.c2cignore` still apply.

## Save images generated in ChatGPT

Codex uses the existing ChatGPT browser tab. Request generation only when the user
asks for it; wait for completion. Use the visible image's Download action, or the
browser's documented `pageAssets.list()` and `pageAssets.bundle({inventoryId,
assetIds:[...]})` for the specific generated image already visible on the page.
Never guess image URLs, read browser credentials, or fetch authenticated assets
with shell requests. Prefer an original download; identify previews as previews.

After the browser returns a local image path, Codex runs:

```powershell
node <checkout>/bin/c2c.js import-image -w <workspace> --source <downloaded-file> --dest generated/chatgpt/<name>.png --json
```

Use the extension matching the downloaded image. The command validates the image,
copies the original downloaded bytes, and refuses overwrites or destinations
outside the workspace. This is a local command, not a ChatGPT write tool.
ChatGPT can then inspect the saved file with `read_image`.

After building this extension, restart the bridge, repair the ChatGPT connection
if its address changes, and refresh the tools. Verify in ChatGPT that `read_image`
produces a visual description based on the actual image, not its filename.

These are local source changes; preserve them when updating from upstream.

## Verification on 2026-09-19

Re-pairing succeeded, and ChatGPT's live file read/write/patch/command checks passed.
`read_image` returned image metadata, but ChatGPT's detailed visual description
contradicted the actual local image. Therefore actual visual understanding through
this connector is NOT verified. Do not infer visual success from tool success or
the model's claim that it saw pixels. Use an explicitly attached image when visual
accuracy is required until this transport behavior is resolved. Browser export and
local image saving were independently verified and remain available.
