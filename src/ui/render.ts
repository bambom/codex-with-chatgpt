import fs from "node:fs/promises";
import { rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import sharp, { type OverlayOptions } from "sharp";
import { Workspace } from "../workspace/manager.js";
import type { Rect, ResolvedNode, ResolvedScene, Scene, SceneAsset, SceneFont, TextStyle } from "./scene.js";

const MAX_PIXELS = 64 * 1024 * 1024;
const MAX_TOTAL_PIXELS = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const DECODE = { failOn: "error" as const, limitInputPixels: MAX_PIXELS, animated: false };

export class UiRenderError extends Error {
  constructor(public code: string, message: string, public nodeId?: string) {
    super(message); this.name = "UiRenderError";
  }
}
export interface RgbaImage { data: Buffer; width: number; height: number }
export interface RenderedLayer extends Rect {
  id: string; sourceId: string; name: string; type: ResolvedNode["type"];
  groupPath: string[]; parentId: string | null; componentId: string; z: number;
  opacity: number; requestedOpacity: number; visible: boolean;
  file: string; sha256: string;
  /** The unchanged layout slot. Pixels can be cropped by an ancestor viewport. */
  bounds: Rect; localX: number; localY: number; cropOffset: [number, number];
  /** Native loader content bounds can extend beyond its semantic slot. */
  contentBounds?: Rect;
  assetId?: string; sourceFile?: string; sourceSha256?: string;
  originalWidth?: number; originalHeight?: number;
  text?: string; displayedText?: string; style?: TextStyle;
  fontFile?: string; fontSha256?: string; renderMode: "image" | "text" | "text-reference" | "empty";
}
export interface AtlasOptions { ratio: "9:25"; padding?: number }
export interface RenderOptions { atlas?: AtlasOptions }
export interface RenderedAtlas {
  file: string; coordinates: string; width: number; height: number; ratio: "9:25";
}
export interface RenderedScene {
  schemaVersion: 1; sceneId: string; canvas: Scene["canvas"]; layers: RenderedLayer[];
  composite: string; compositeSha256: string; contactSheet: string; manifest: string;
  atlas?: RenderedAtlas; referenceFile?: string; limitations: string[];
  nativeRender: "not_verified";
}

export function sha256(data: Uint8Array): string { return createHash("sha256").update(data).digest("hex"); }

/** Atomic replacement prevents a caller from observing a half-written PNG/PSD. */
export async function writeAtomic(file: string, data: Uint8Array | string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, data, { flag: "wx" });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
}

function requirePixels(width: number, height: number, label: string): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS) {
    throw new UiRenderError("INVALID_RASTER_SIZE", `${label}: positive integer dimensions and at most ${MAX_PIXELS} pixels are required`);
  }
}
function rgba(data: Buffer, width: number, height: number): RgbaImage { return { data, width, height }; }
function blank(width: number, height: number): RgbaImage { requirePixels(width, height, "raster"); return rgba(Buffer.alloc(width * height * 4), width, height); }
function imagePipe(image: RgbaImage) { return sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } }); }
export async function encodeRgba(image: RgbaImage): Promise<Buffer> { return imagePipe(image).png().toBuffer(); }
export async function readRgba(file: string): Promise<RgbaImage> {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new UiRenderError("INVALID_IMAGE_FILE", `Invalid or oversized image: ${file}`);
  const data = await fs.readFile(file);
  const info = await sharp(data, DECODE).metadata();
  if (info.format !== "png") throw new UiRenderError("PNG_REQUIRED", `Scene images must be PNG: ${file}`);
  if ((info.pages ?? 1) !== 1) throw new UiRenderError("ANIMATED_IMAGE", `Animated images are not supported: ${file}`);
  requirePixels(info.width ?? 0, info.height ?? 0, file);
  const decoded = await sharp(data, DECODE).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return rgba(decoded.data, decoded.info.width, decoded.info.height);
}
async function resize(image: RgbaImage, width: number, height: number): Promise<RgbaImage> {
  if (image.width === width && image.height === height) return image;
  requirePixels(width, height, "resize");
  return rgba(await imagePipe(image).resize(width, height, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer(), width, height);
}
function crop(image: RgbaImage, x: number, y: number, width: number, height: number): RgbaImage {
  const out = blank(width, height);
  for (let row = 0; row < height; row++) image.data.copy(out.data, row * width * 4, ((row + y) * image.width + x) * 4, ((row + y) * image.width + x + width) * 4);
  return out;
}
function intersection(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

/** Sharp is the independent compositor. Layer opacity is not baked into its PNG. */
export async function compositeLayers(canvas: { width: number; height: number }, layers: readonly Pick<RenderedLayer, "file" | "x" | "y" | "width" | "height" | "opacity" | "visible">[]): Promise<RgbaImage> {
  requirePixels(canvas.width, canvas.height, "canvas");
  const overlays: OverlayOptions[] = [];
  for (const layer of layers) {
    if (!layer.visible || layer.opacity === 0) continue;
    let image = await readRgba(layer.file);
    if (image.width !== layer.width || image.height !== layer.height) throw new UiRenderError("LAYER_SIZE_CHANGED", `Layer PNG size changed: ${layer.file}`);
    const visible = intersection(layer, { x: 0, y: 0, ...canvas });
    if (!visible) continue;
    image = crop(image, visible.x - layer.x, visible.y - layer.y, visible.width, visible.height);
    if (layer.opacity !== 1) {
      image.data = Buffer.from(image.data);
      for (let p = 3; p < image.data.length; p += 4) image.data[p] = Math.round(image.data[p] * layer.opacity);
    }
    overlays.push({ input: image.data, raw: { width: image.width, height: image.height, channels: 4 }, left: visible.x, top: visible.y, blend: "over" });
  }
  const base = imagePipe(blank(canvas.width, canvas.height));
  return rgba(await (overlays.length ? base.composite(overlays) : base).raw().toBuffer(), canvas.width, canvas.height);
}

async function renderNineSlice(image: RgbaImage, grid: NonNullable<SceneAsset["scale9grid"]>, width: number, height: number): Promise<RgbaImage> {
  const [x, y, middleWidth, middleHeight] = grid;
  if (![x, y, middleWidth, middleHeight].every(Number.isSafeInteger) || x < 0 || y < 0 || middleWidth < 1 || middleHeight < 1 || x + middleWidth > image.width || y + middleHeight > image.height) {
    throw new UiRenderError("INVALID_SCALE9GRID", "scale9grid must be the center rectangle inside the original PNG");
  }
  const right = image.width - x - middleWidth, bottom = image.height - y - middleHeight;
  if (width < x + right || height < y + bottom) throw new UiRenderError("SCALE9_TOO_SMALL", "Nine-slice target is smaller than its fixed borders; its native collapse rule is not supported");
  const sx = [0, x, x + middleWidth, image.width], sy = [0, y, y + middleHeight, image.height];
  const dx = [0, x, width - right, width], dy = [0, y, height - bottom, height];
  const out = blank(width, height);
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const sw = sx[col + 1] - sx[col], sh = sy[row + 1] - sy[row];
    const dw = dx[col + 1] - dx[col], dh = dy[row + 1] - dy[row];
    if (!sw || !sh || !dw || !dh) continue;
    const tile = await resize(crop(image, sx[col], sy[row], sw, sh), dw, dh);
    for (let yy = 0; yy < dh; yy++) tile.data.copy(out.data, ((dy[row] + yy) * width + dx[col]) * 4, yy * dw * 4, (yy + 1) * dw * 4);
  }
  return out;
}

async function renderLoader(image: RgbaImage, node: ResolvedNode, grid?: SceneAsset["scale9grid"]): Promise<{ image: RgbaImage; area: Rect; contentBounds: Rect; rounding?: string }> {
  const settings = node.loader ?? {}, fill = settings.fill ?? "scale";
  let sx = 1, sy = 1;
  if (fill !== "none") {
    sx = node.width / image.width; sy = node.height / image.height;
    if (fill === "scale") sx = sy = Math.min(sx, sy);
    else if (fill === "scaleNoBorder") sx = sy = Math.max(sx, sy);
    else if (fill === "scaleMatchHeight") sx = sy;
    else if (fill === "scaleMatchWidth") sy = sx;
    else if (fill !== "scaleFree") throw new UiRenderError("UNSUPPORTED_LOADER_FILL", `Unsupported loader fill: ${fill}`, node.id);
    if (settings.shrinkOnly) { sx = Math.min(1, sx); sy = Math.min(1, sy); }
  }
  const contentWidth = image.width * sx, contentHeight = image.height * sy;
  const pixelWidth = Math.max(1, Math.round(contentWidth)), pixelHeight = Math.max(1, Math.round(contentHeight));
  const scaled = grid ? await renderNineSlice(image, grid, pixelWidth, pixelHeight) : await resize(image, pixelWidth, pixelHeight);
  const align = settings.align ?? "center", vAlign = settings.vAlign ?? "middle";
  const nativeX = align === "center" ? Math.floor((node.width - contentWidth) / 2) : align === "right" ? node.width - contentWidth : 0;
  const nativeY = vAlign === "middle" ? Math.floor((node.height - contentHeight) / 2) : vAlign === "bottom" ? node.height - contentHeight : 0;
  const x = Math.round(nativeX), y = Math.round(nativeY), left = Math.min(0, x), top = Math.min(0, y);
  // FGUI loaders do not clip their own contents. Keep the extended raster and
  // let the component/list viewport (ResolvedNode.clip) provide actual clipping.
  const out = blank(Math.max(node.width, x + scaled.width) - left, Math.max(node.height, y + scaled.height) - top);
  for (let row = 0; row < scaled.height; row++) scaled.data.copy(out.data, ((y - top + row) * out.width + x - left) * 4, row * scaled.width * 4, (row + 1) * scaled.width * 4);
  const rounding = [contentWidth, contentHeight, nativeX, nativeY].every(Number.isInteger) ? undefined : `${node.id}: native Loader content has fractional pixels; the PNG/PSD raster rounds size and right/bottom offsets to integer pixels while preserving the native slot and content bounds in the manifest.`;
  return { image: out, area: { x: node.x + left, y: node.y + top, width: out.width, height: out.height },
    contentBounds: { x: node.x + nativeX, y: node.y + nativeY, width: contentWidth, height: contentHeight }, rounding };
}

interface CheckedFont { file: string; renderFile: string; sha256: string; family: string; face: string; hasGlyph: (point: number) => boolean }
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
async function checkFont(workspace: Workspace, font: SceneFont, forRendering = true): Promise<CheckedFont> {
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

/** Read-only validation for source-export variants. It does not register a font
 * with Pango or collide with the full-resolution preview's font cache. */
export async function validateFontCoverage(workspace: Workspace, font: SceneFont, texts: readonly string[]): Promise<{
  status: "passed" | "failed"; file: string; sha256: string; family: string; face: string; checkedCodePoints: number; missing: { character: string; codePoint: string }[];
}> {
  const checked = await checkFont(workspace, font, false);
  const characters = [...new Set(texts.flatMap(text => Array.from(text)).filter(character => !/[\r\n\t]/.test(character)))];
  const missing = characters.filter(character => !checked.hasGlyph(character.codePointAt(0)!)).map(character => ({ character, codePoint: `U+${character.codePointAt(0)!.toString(16).toUpperCase()}` }));
  return { status: missing.length ? "failed" : "passed", file: checked.file, sha256: checked.sha256, family: checked.family, face: checked.face, checkedCodePoints: characters.length, missing };
}

function escapeMarkup(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }
function color(value: string): [number, number, number, number] {
  if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) throw new UiRenderError("INVALID_COLOR", `Use #RRGGBB or #RRGGBBAA: ${value}`);
  return [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16), value.length === 9 ? parseInt(value.slice(7, 9), 16) : 255];
}
function tintMask(mask: Buffer, tint: [number, number, number, number]): Buffer {
  const out = Buffer.alloc(mask.length * 4);
  for (let i = 0; i < mask.length; i++) { out[i * 4] = tint[0]; out[i * 4 + 1] = tint[1]; out[i * 4 + 2] = tint[2]; out[i * 4 + 3] = Math.round(mask[i] * tint[3] / 255); }
  return out;
}
async function renderText(node: ResolvedNode, font: CheckedFont): Promise<{ image: RgbaImage; displayedText: string }> {
  const style = node.style!;
  if (["both", "height", "shrink", "ellipsis"].includes(style.autoSize ?? "none")) throw new UiRenderError("UNSUPPORTED_TEXT_AUTOSIZE", `Text autoSize=${style.autoSize} changes native text metrics; supply resolved fixed bounds with autoSize=none or a text reference PNG`, node.id);
  if (!Number.isFinite(style.fontSize) || style.fontSize <= 0 || style.fontSize > 2048) throw new UiRenderError("INVALID_FONT_SIZE", "fontSize must be between 0 and 2048", node.id);
  let displayedText = node.text ?? "";
  if (node.type === "InputText") {
    if (node.input?.password && displayedText) displayedText = "•".repeat(Array.from(displayedText).length);
    else if (!displayedText && node.input?.prompt) displayedText = node.input.prompt;
  }
  if (style.singleLine && /[\r\n]/.test(displayedText)) throw new UiRenderError("SINGLE_LINE_NEWLINE", "Single-line text contains a newline", node.id);
  if (style.shadowOffset && !style.shadowColor) throw new UiRenderError("INCOMPLETE_TEXT_SHADOW", "Text shadow offsets require an explicit shadowColor", node.id);
  const missing = [...new Set(Array.from(displayedText).filter(char => !/[\r\n\t]/.test(char) && !font.hasGlyph(char.codePointAt(0)!)))];
  if (missing.length) throw new UiRenderError("MISSING_FONT_GLYPH", `Font ${font.family} lacks ${missing.map(char => `U+${char.codePointAt(0)!.toString(16).toUpperCase()}`).join(", ")}`, node.id);
  if (!displayedText.trim()) return { image: blank(node.width, node.height), displayedText };
  const estimatedPixels = Array.from(displayedText).length * (style.fontSize + Math.abs(style.letterSpacing ?? 0)) * (style.fontSize * 2 + Math.abs(style.leading ?? 0));
  if (estimatedPixels > MAX_PIXELS) throw new UiRenderError("TEXT_RASTER_BUDGET", "Text shaping exceeds the raster pixel budget; split the text or use a bounded supplied reference", node.id);
  const fill = color(style.color);
  const attributes = [
    `foreground="#ffffff"`, `letter_spacing="${Math.round((style.letterSpacing ?? 0) * 1024)}"`,
    style.underline ? 'underline="single"' : "", style.strike ? 'strikethrough="true"' : "",
  ].filter(Boolean).join(" ");
  const rendered = await sharp({ text: {
    text: `<span ${attributes}>${escapeMarkup(displayedText)}</span>`,
    font: `${font.family} ${font.face}${style.bold ? " Bold" : ""}${style.italic ? " Italic" : ""} ${style.fontSize}`,
    fontfile: font.renderFile, dpi: 72, rgba: true,
    ...(style.singleLine ? {} : { width: node.width, wrap: "word-char" as const }),
    align: style.align ?? "left", ...(style.leading === undefined ? {} : { spacing: style.leading }),
  } }).raw().toBuffer({ resolveWithObject: true });
  requirePixels(rendered.info.width, rendered.info.height, "rendered text");
  const glyph = rgba(rendered.data, rendered.info.width, rendered.info.height);
  const x = style.align === "center" ? Math.floor((node.width - glyph.width) / 2) : style.align === "right" ? node.width - glyph.width : 0;
  const y = style.vAlign === "middle" ? Math.floor((node.height - glyph.height) / 2) : style.vAlign === "bottom" ? node.height - glyph.height : 0;
  const mask = Buffer.alloc(node.width * node.height), rect = intersection({ x, y, width: glyph.width, height: glyph.height }, { x: 0, y: 0, width: node.width, height: node.height });
  if (rect) for (let yy = 0; yy < rect.height; yy++) for (let xx = 0; xx < rect.width; xx++) mask[(rect.y + yy) * node.width + rect.x + xx] = glyph.data[((rect.y - y + yy) * glyph.width + rect.x - x + xx) * 4 + 3];
  const overlays: OverlayOptions[] = [];
  if (style.shadowColor) {
    const [dx, dy] = style.shadowOffset ?? [1, 1];
    if (!Number.isSafeInteger(dx) || !Number.isSafeInteger(dy)) throw new UiRenderError("UNSUPPORTED_TEXT_SHADOW", "Shadow offsets must be integer pixels", node.id);
    const shadow = Buffer.alloc(mask.length);
    for (let yy = 0; yy < node.height; yy++) for (let xx = 0; xx < node.width; xx++) if (xx + dx >= 0 && xx + dx < node.width && yy + dy >= 0 && yy + dy < node.height) shadow[(yy + dy) * node.width + xx + dx] = mask[yy * node.width + xx];
    overlays.push({ input: tintMask(shadow, color(style.shadowColor)), raw: { width: node.width, height: node.height, channels: 4 }, left: 0, top: 0 });
  }
  if (style.strokeSize) {
    if (!Number.isSafeInteger(style.strokeSize) || style.strokeSize < 0 || style.strokeSize > 32 || !style.strokeColor) throw new UiRenderError("UNSUPPORTED_TEXT_STROKE", "Stroke needs a color and integer size in [0,32]", node.id);
    // Sharp's morphology calls treat dark pixels as foreground. Eroding that
    // dark background is the maximum filter that expands our white alpha mask.
    const expanded = await sharp(mask, { raw: { width: node.width, height: node.height, channels: 1 } }).erode(style.strokeSize).greyscale().raw().toBuffer();
    overlays.push({ input: tintMask(expanded, color(style.strokeColor)), raw: { width: node.width, height: node.height, channels: 4 }, left: 0, top: 0 });
  }
  overlays.push({ input: tintMask(mask, fill), raw: { width: node.width, height: node.height, channels: 4 }, left: 0, top: 0 });
  return { image: rgba(await imagePipe(blank(node.width, node.height)).composite(overlays).raw().toBuffer(), node.width, node.height), displayedText };
}

async function contactSheet(layers: RenderedLayer[], outDir: string): Promise<string> {
  const cellWidth = 180, cellHeight = 160, columns = 5, rows = Math.max(1, Math.ceil(layers.length / columns));
  requirePixels(columns * cellWidth, rows * cellHeight, "contact sheet");
  const overlays: OverlayOptions[] = [];
  for (let i = 0; i < layers.length; i++) {
    const thumbnail = await sharp(layers[i].file, DECODE).resize(160, 126, { fit: "inside", withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    overlays.push({ input: thumbnail.data, left: (i % columns) * cellWidth + 10, top: Math.floor(i / columns) * cellHeight + 8 });
    // Auxiliary numeric labels do not substitute for any authored UI text.
    const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="170" height="20"><text x="0" y="15" font-size="12" fill="#273746">${i + 1}: ${layers[i].width} x ${layers[i].height}</text></svg>`);
    overlays.push({ input: label, left: (i % columns) * cellWidth + 10, top: Math.floor(i / columns) * cellHeight + 138 });
  }
  const file = path.join(outDir, "contact-sheet.png");
  const base = sharp({ create: { width: columns * cellWidth, height: rows * cellHeight, channels: 4, background: "#e9eef2" } });
  await writeAtomic(file, await (overlays.length ? base.composite(overlays) : base).png().toBuffer());
  return file;
}

async function packAtlas(layers: RenderedLayer[], outDir: string, options: AtlasOptions): Promise<RenderedAtlas> {
  if (options.ratio !== "9:25") throw new UiRenderError("UNSUPPORTED_ATLAS_RATIO", "This optional atlas format requires ratio=9:25");
  const padding = options.padding ?? 2;
  if (!Number.isSafeInteger(padding) || padding < 0 || padding > 64) throw new UiRenderError("INVALID_ATLAS_PADDING", "Atlas padding must be an integer in [0,64]");
  const sorted = layers.map((layer, index) => ({ layer, index })).sort((a, b) => b.layer.height - a.layer.height || b.layer.width - a.layer.width || a.index - b.index);
  let units = Math.max(1, ...layers.map(layer => Math.ceil((layer.width + padding * 2) / 9)), Math.ceil(Math.sqrt(layers.reduce((sum, layer) => sum + (layer.width + padding) * (layer.height + padding), 0) / 225)));
  let locations: { id: string; index: number; x: number; y: number; width: number; height: number }[] = [];
  for (;;) {
    const width = units * 9, height = units * 25;
    requirePixels(width, height, "9:25 atlas");
    let x = padding, y = padding, rowHeight = 0; locations = [];
    for (const { layer, index } of sorted) {
      if (x + layer.width + padding > width) { x = padding; y += rowHeight + padding; rowHeight = 0; }
      if (y + layer.height + padding > height) break;
      locations.push({ id: layer.id, index, x, y, width: layer.width, height: layer.height });
      x += layer.width + padding; rowHeight = Math.max(rowHeight, layer.height);
    }
    if (locations.length === layers.length) break;
    units = Math.max(units + 1, Math.ceil(units * 1.04));
  }
  const width = units * 9, height = units * 25, file = path.join(outDir, "atlas-9x25.png"), coordinates = path.join(outDir, "atlas-9x25.json");
  const base = imagePipe(blank(width, height));
  await writeAtomic(file, await (locations.length ? base.composite(locations.map(loc => ({ input: layers[loc.index].file, left: loc.x, top: loc.y }))) : base).png().toBuffer());
  await writeAtomic(coordinates, JSON.stringify({ schemaVersion: 1, ratio: "9:25", width, height, padding, scaled: false, sprites: locations.map(({ index, ...loc }) => ({ ...loc, file: layers[index].file, sha256: layers[index].sha256 })) }, null, 2));
  return { file, coordinates, width, height, ratio: "9:25" };
}

/** All layer placements originate in resolveScene; callers cannot add an unrelated PSD-only layout. */
export async function renderScene(scene: Scene, resolved: ResolvedScene, inputDir: string, outDir: string, options: RenderOptions = {}): Promise<RenderedScene> {
  if (resolved.canvas.width !== scene.canvas.width || resolved.canvas.height !== scene.canvas.height) throw new UiRenderError("CANVAS_MISMATCH", "Resolved scene and authoring canvas differ");
  requirePixels(scene.canvas.width, scene.canvas.height, "scene.canvas");
  if (resolved.layers.length > 4096) throw new UiRenderError("TOO_MANY_LAYERS", "At most 4096 raster layers are supported");
  const totalPixels = resolved.layers.reduce((sum, layer) => sum + Math.max(1, layer.width) * Math.max(1, layer.height), scene.canvas.width * scene.canvas.height);
  if (!Number.isFinite(totalPixels) || totalPixels > MAX_TOTAL_PIXELS) throw new UiRenderError("RASTER_BUDGET_EXCEEDED", `The layer raster budget is ${MAX_TOTAL_PIXELS} pixels`);
  const workspace = new Workspace(inputDir), assets = new Map(scene.assets.map(asset => [asset.id, asset]));
  const decodedAssets = new Map<string, { image: RgbaImage; file: string; sha256: string }>(), fonts = new Map<string, CheckedFont>();
  let decodedPixels = 0, outputPixels = scene.canvas.width * scene.canvas.height;
  const loadAsset = async (id: string) => {
    const cached = decodedAssets.get(id); if (cached) return cached;
    const asset = assets.get(id);
    if (!asset) throw new UiRenderError("MISSING_ASSET", `Unknown asset ${id}`);
    requirePixels(asset.width, asset.height, id);
    if (decodedPixels + asset.width * asset.height > MAX_TOTAL_PIXELS) throw new UiRenderError("ASSET_RASTER_BUDGET", "Decoded source assets exceed the raster cache budget");
    const file = workspace.resolve(asset.file).abs, image = await readRgba(file);
    if (image.width !== asset.width || image.height !== asset.height) throw new UiRenderError("ASSET_DIMENSIONS_MISMATCH", `Declared dimensions differ from the PNG for ${id}`);
    decodedPixels += image.width * image.height;
    const value = { image, file, sha256: sha256(await fs.readFile(file)) }; decodedAssets.set(id, value); return value;
  };
  await fs.mkdir(path.join(outDir, "layers"), { recursive: true });
  const layers: RenderedLayer[] = [], limitations = [...resolved.limitations];
  const ids = new Set<string>();
  for (const node of [...resolved.layers].sort((a, b) => a.z - b.z)) {
    if (ids.has(node.id)) throw new UiRenderError("DUPLICATE_LAYER_ID", `Duplicate resolved layer ${node.id}`); ids.add(node.id);
    if (![node.x, node.y, node.width, node.height].every(Number.isSafeInteger) || node.width < 0 || node.height < 0) throw new UiRenderError("SUBPIXEL_GEOMETRY", "PSD rendering requires integer resolved geometry; resolve or reject transforms before rendering", node.id);
    if (!Number.isFinite(node.opacity) || node.opacity < 0 || node.opacity > 1) throw new UiRenderError("INVALID_OPACITY", "Resolved opacity must be in [0,1]", node.id);
    if (node.clip && (![node.clip.x, node.clip.y, node.clip.width, node.clip.height].every(Number.isSafeInteger) || node.clip.width < 0 || node.clip.height < 0)) throw new UiRenderError("UNSUPPORTED_CLIP", "Only axis-aligned integer viewport clips are supported", node.id);
    const bounds = { x: node.x, y: node.y, width: node.width, height: node.height };
    const meta: Partial<RenderedLayer> = {};
    let pixels: RgbaImage, renderMode: RenderedLayer["renderMode"], extendedArea: Rect | undefined;
    const empty = node.width === 0 || node.height === 0;
    if (empty) { pixels = blank(1, 1); renderMode = "empty"; }
    else if (["Image", "Loader"].includes(node.type)) {
      if (!node.assetId) {
        if (node.type !== "Loader") throw new UiRenderError("MISSING_ASSET", "Image has no assetId", node.id);
        pixels = blank(node.width, node.height); renderMode = "empty";
      } else {
        const source = await loadAsset(node.assetId), asset = assets.get(node.assetId)!;
        if (node.type === "Loader") {
          const loaded = await renderLoader(source.image, node, asset.scale9grid); pixels = loaded.image; extendedArea = loaded.area;
          meta.contentBounds = loaded.contentBounds; if (loaded.rounding) limitations.push(loaded.rounding);
        } else pixels = asset.scale9grid ? await renderNineSlice(source.image, asset.scale9grid, node.width, node.height) : await resize(source.image, node.width, node.height);
        Object.assign(meta, { assetId: node.assetId, sourceFile: source.file, sourceSha256: source.sha256, originalWidth: source.image.width, originalHeight: source.image.height }); renderMode = "image";
      }
    } else if (["Text", "RichText", "InputText"].includes(node.type)) {
      if (node.referenceAssetId) {
        const reference = await loadAsset(node.referenceAssetId);
        if (reference.image.width !== node.width || reference.image.height !== node.height) throw new UiRenderError("TEXT_REFERENCE_SIZE", "Text reference PNG must already match the resolved text box", node.id);
        pixels = reference.image; renderMode = "text-reference";
        Object.assign(meta, { assetId: node.referenceAssetId, sourceFile: reference.file, sourceSha256: reference.sha256 });
        limitations.push(`${node.id}: PSD uses a supplied text reference raster; native FGUI text remains editable and its rendering is not verified by this preview.`);
      } else {
        if (node.type === "RichText" || node.ubb) throw new UiRenderError("RICH_TEXT_REFERENCE_REQUIRED", "Rich text/UBB rendering needs a usage-sized reference PNG; the native FGUI control remains rich text", node.id);
        if (!node.style?.fontId) throw new UiRenderError("FONT_FILE_REQUIRED", "Editable text preview requires style.fontId and a real font file", node.id);
        const fontDef = scene.fonts.find(font => font.id === node.style!.fontId);
        if (!fontDef) throw new UiRenderError("MISSING_FONT", `Unknown font ${node.style.fontId}`, node.id);
        if (node.style.fontFamily && node.style.fontFamily !== fontDef.family) throw new UiRenderError("FONT_FAMILY_MISMATCH", "Text style and font resource declare different families", node.id);
        let font = fonts.get(fontDef.id); if (!font) { font = await checkFont(workspace, fontDef); fonts.set(fontDef.id, font); }
        const rendered = await renderText(node, font); pixels = rendered.image; renderMode = "text";
        Object.assign(meta, { fontFile: font.file, fontSha256: font.sha256, displayedText: rendered.displayedText });
      }
      Object.assign(meta, { text: node.text ?? "", style: node.style });
    } else throw new UiRenderError("UNEXPANDED_CONTROL", `resolveScene must expand ${node.type} into semantic image/text leaves`, node.id);
    let area = extendedArea ?? { x: node.x, y: node.y, width: pixels.width, height: pixels.height }, visible = node.visible && !empty;
    if (node.clip && !empty) {
      const clipped = intersection(area, node.clip);
      if (clipped) { pixels = crop(pixels, clipped.x - area.x, clipped.y - area.y, clipped.width, clipped.height); area = clipped; }
      else visible = false;
    }
    outputPixels += pixels.width * pixels.height;
    if (outputPixels > MAX_TOTAL_PIXELS) throw new UiRenderError("RASTER_BUDGET_EXCEEDED", "Extended Loader contents exceed the raster output budget");
    const file = path.resolve(outDir, "layers", `${String(layers.length + 1).padStart(4, "0")}-${sha256(Buffer.from(node.id)).slice(0, 16)}.png`);
    const png = await encodeRgba(pixels); await writeAtomic(file, png);
    layers.push({ id: node.id, sourceId: node.sourceId, name: node.name, type: node.type, parentId: node.parentId, componentId: node.componentId,
      groupPath: [...node.groupPath], z: node.z, ...area, bounds, localX: node.localX, localY: node.localY,
      cropOffset: [area.x - node.x, area.y - node.y], opacity: Math.round(node.opacity * 255) / 255, requestedOpacity: node.opacity,
      visible, file, sha256: sha256(png), renderMode, ...meta });
  }
  if (fonts.size) limitations.push("Text PNGs use the supplied font through Pango at 72 dpi, fixed boxes, and rasterized stroke/shadow. Native FGUI font metrics, input prompt styling, line spacing, and synthetic bold/italic may differ; an actual native render is a separate verification step.");
  const composite = path.resolve(outDir, "composite.png"), compositePng = await encodeRgba(await compositeLayers(scene.canvas, layers));
  await writeAtomic(composite, compositePng);
  const result: RenderedScene = { schemaVersion: 1, sceneId: scene.id, canvas: { ...scene.canvas }, layers, composite, compositeSha256: sha256(compositePng),
    contactSheet: await contactSheet(layers, outDir), manifest: path.resolve(outDir, "render-manifest.json"), limitations: [...new Set(limitations)], nativeRender: "not_verified" };
  if (scene.referenceFile) result.referenceFile = workspace.resolve(scene.referenceFile).abs;
  if (options.atlas) result.atlas = await packAtlas(layers, outDir, options.atlas);
  await writeAtomic(result.manifest, JSON.stringify(result, null, 2));
  return result;
}
