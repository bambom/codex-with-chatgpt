import fs from "node:fs/promises";
import sharp from "sharp";
import { Workspace, WorkspaceError } from "./manager.js";

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_PIXELS = 64 * 1024 * 1024;

/** Decode only raster formats; never interpret SVG, documents or arbitrary URLs. */
function isRaster(data: Buffer): boolean {
  return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) ||
    ["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6)) ||
    (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP");
}

export async function readImage(workspace: Workspace, requested: string, maxEdge = 2048) {
  const { abs, rel } = workspace.resolve(requested);
  let handle;
  try {
    handle = await fs.open(abs, "r");
  } catch {
    throw new WorkspaceError("FILE_NOT_FOUND", `Image not found: ${rel}`);
  }
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new WorkspaceError("NOT_A_FILE", `Not a regular file: ${rel}`);
    if (stat.size > MAX_INPUT_BYTES) {
      throw new WorkspaceError("FILE_TOO_LARGE", "Images must be 20 MiB or smaller. Export a smaller image first.");
    }
    // Bounded read even if the file grows after stat().
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > stat.size) throw new WorkspaceError("FILE_TOO_LARGE", "Image changed during reading; retry.");
    bytes = buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
  if (!isRaster(bytes)) {
    throw new WorkspaceError("UNSUPPORTED_IMAGE", "Use a PNG, JPEG, WebP or GIF image. Other binary files are not supported.");
  }
  try {
    const options = { limitInputPixels: MAX_PIXELS, failOn: "error" as const, animated: false };
    const meta = await sharp(bytes, options).metadata();
    const edge = Number.isFinite(maxEdge) ? Math.min(2048, Math.max(256, Math.floor(maxEdge))) : 2048;
    const preview = sharp(bytes, options).rotate().resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true });
    let output = await preview.clone().png().toBuffer({ resolveWithObject: true });
    let mimeType = "image/png";
    if (output.data.length > MAX_OUTPUT_BYTES) {
      output = await preview.clone().webp({ quality: 85 }).toBuffer({ resolveWithObject: true });
      mimeType = "image/webp";
    }
    if (output.data.length > MAX_OUTPUT_BYTES) throw new WorkspaceError("FILE_TOO_LARGE", "Preview is too large; use a smaller max_edge.");
    return {
      metadata: { path: rel, sourceWidth: meta.width, sourceHeight: meta.height, width: output.info.width,
        height: output.info.height, sourceBytes: bytes.length, previewBytes: output.data.length,
        mimeType, frame: 1, note: "First frame, orientation corrected, metadata stripped; large images are resized previews." },
      data: output.data.toString("base64"),
    };
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError("INVALID_IMAGE", "Cannot decode image: it is damaged or exceeds the 64 megapixel limit.");
  }
}
