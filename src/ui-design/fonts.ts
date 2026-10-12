// Fixed-font checks copied from legacy ui/render.ts at 1eea521; no target project dependency.
import fs from "node:fs/promises";
import { rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Workspace } from "../workspace/manager.js";
import type { SceneFont } from "../ui/scene.js";
import { UiWorkflowError as UiRenderError, sha256 } from "../ui/storage.js";
const MAX_FILE_BYTES = 64 * 1024 * 1024;
export interface CheckedFont { file: string; renderFile: string; sha256: string; family: string; face: string; hasGlyph: (point: number) => boolean }
const fontFaces = new Map<string, string>();
let fontCacheDirectory: Promise<string> | undefined;
function fontCache(): Promise<string> {
  // Fontconfig/Pango retain face paths across jobs. A process-owned immutable
  // copy prevents a completed/cleaned staging directory from breaking the next
  // render of the same font. It is not a user deliverable or a system install.
  return fontCacheDirectory ??= fs.mkdtemp(path.join(os.tmpdir(), "c2c-ui-fonts-")).then(directory => {
    process.once("exit", () => { try { rmSync(directory, { recursive: true, force: true }); } catch { /* process exit */ } });
    return directory;
  });
}

/** Read SFNT names and Unicode cmap so missing fonts/glyphs cannot silently fall back. */
export async function checkFont(workspace: Workspace, font: SceneFont, forRendering = true): Promise<CheckedFont> {
  const file = workspace.resolve(font.file).abs;
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new UiRenderError("INVALID_FONT", `Invalid or oversized font: ${font.file}`);
  const data = await fs.readFile(file);
  if (data.length < 12 || (data.readUInt32BE(0) !== 0x00010000 && data.toString("ascii", 0, 4) !== "OTTO")) throw new UiRenderError("UNSUPPORTED_FONT", "Use a single-face TrueType or OpenType font file");
  const count = data.readUInt16BE(4), tables = new Map<string, Buffer>();
  if (count > 256 || 12 + count * 16 > data.length) throw new UiRenderError("INVALID_FONT", "Invalid SFNT directory");
  for (let i = 0; i < count; i++) {
    const pos = 12 + i * 16, offset = data.readUInt32BE(pos + 8), length = data.readUInt32BE(pos + 12);
    if (offset + length > data.length) throw new UiRenderError("INVALID_FONT", "Font table extends outside the file");
    tables.set(data.toString("ascii", pos, pos + 4), data.subarray(offset, offset + length));
  }
  const names = tables.get("name"), families = new Set<string>();
  const faces: { name: string; priority: number }[] = [];
  if (names && names.length >= 6) {
    const records = names.readUInt16BE(2), strings = names.readUInt16BE(4);
    for (let i = 0; i < records && 6 + (i + 1) * 12 <= names.length; i++) {
      const p = 6 + i * 12, platform = names.readUInt16BE(p), id = names.readUInt16BE(p + 6);
      const length = names.readUInt16BE(p + 8), start = strings + names.readUInt16BE(p + 10);
      if (![1, 2, 16, 17].includes(id) || start + length > names.length) continue;
      const bytes = Buffer.from(names.subarray(start, start + length));
      let value: string | undefined;
      if ((platform === 0 || platform === 3) && length % 2 === 0) value = bytes.swap16().toString("utf16le");
      else if (platform === 1) value = bytes.toString("latin1");
      if (value && (id === 1 || id === 16)) families.add(value);
      else if (value) faces.push({ name: value, priority: (names.readUInt16BE(p + 4) === 0x0409 ? 4 : 0) + (id === 17 ? 2 : 0) + (platform === 3 ? 1 : 0) });
    }
  }
  if (![...families].some(name => name.toLocaleLowerCase("en-US") === font.family.toLocaleLowerCase("en-US"))) throw new UiRenderError("FONT_FAMILY_MISMATCH", `Declared font family ${font.family} is absent from ${font.file}; found ${[...families].join(", ")}`);
  const cmap = tables.get("cmap");
  if (!cmap || cmap.length < 4) throw new UiRenderError("INVALID_FONT", "Font has no Unicode cmap");
  const subtables: Buffer[] = [];
  for (let i = 0; i < cmap.readUInt16BE(2) && 4 + (i + 1) * 8 <= cmap.length; i++) {
    const p = 4 + i * 8, platform = cmap.readUInt16BE(p), encoding = cmap.readUInt16BE(p + 2), offset = cmap.readUInt32BE(p + 4);
    if (!(platform === 0 || (platform === 3 && [1, 10].includes(encoding))) || offset + 4 > cmap.length) continue;
    const format = cmap.readUInt16BE(offset);
    if (format === 4) {
      const length = cmap.readUInt16BE(offset + 2);
      if (length >= 16 && offset + length <= cmap.length) subtables.push(cmap.subarray(offset, offset + length));
    } else if (format === 12 && offset + 16 <= cmap.length) {
      const length = cmap.readUInt32BE(offset + 4);
      if (length >= 16 && offset + length <= cmap.length) subtables.push(cmap.subarray(offset, offset + length));
    }
  }
  if (!subtables.length) throw new UiRenderError("UNSUPPORTED_FONT_CMAP", "A Unicode cmap format 4 or 12 is required");
  const hasGlyph = (point: number): boolean => subtables.some(table => {
    if (table.readUInt16BE(0) === 12) {
      const count = Math.min(table.readUInt32BE(12), Math.floor((table.length - 16) / 12));
      let low = 0, high = count - 1;
      while (low <= high) {
        const mid = (low + high) >>> 1, pos = 16 + mid * 12;
        const start = table.readUInt32BE(pos), end = table.readUInt32BE(pos + 4);
        if (point < start) high = mid - 1; else if (point > end) low = mid + 1;
        else return table.readUInt32BE(pos + 8) + point - start !== 0;
      }
      return false;
    }
    if (point > 0xffff) return false;
    const segments = table.readUInt16BE(6) / 2, starts = 16 + segments * 2, deltas = starts + segments * 2, ranges = deltas + segments * 2;
    if (!Number.isInteger(segments) || ranges + segments * 2 > table.length) return false;
    for (let i = 0; i < segments; i++) {
      if (point > table.readUInt16BE(14 + i * 2)) continue;
      const start = table.readUInt16BE(starts + i * 2);
      if (point < start) return false;
      const delta = table.readInt16BE(deltas + i * 2), range = table.readUInt16BE(ranges + i * 2);
      if (!range) return ((point + delta) & 0xffff) !== 0;
      const pos = ranges + i * 2 + range + (point - start) * 2;
      if (pos + 2 > table.length) return false;
      const glyph = table.readUInt16BE(pos);
      return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
    }
    return false;
  });
  const digest = sha256(data), face = faces.sort((a, b) => b.priority - a.priority)[0]?.name ?? "Regular";
  if (!forRendering) return { file, renderFile: file, sha256: digest, family: font.family, face, hasGlyph };
  const faceKey = `${font.family.toLocaleLowerCase("en-US")}\0${face.toLocaleLowerCase("en-US")}`, previous = fontFaces.get(faceKey);
  if (previous && previous !== digest) throw new UiRenderError("FONT_FACE_COLLISION", `Two different font files claim the same face ${font.family} ${face}; use distinct font family names to avoid Fontconfig fallback`);
  fontFaces.set(faceKey, digest);
  const renderFile = path.join(await fontCache(), `${digest}${data.toString("ascii", 0, 4) === "OTTO" ? ".otf" : ".ttf"}`);
  try { await fs.writeFile(renderFile, data, { flag: "wx", mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return { file, renderFile, sha256: digest, family: font.family, face, hasGlyph };
}
