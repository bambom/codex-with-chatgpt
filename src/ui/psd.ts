import fs from "node:fs/promises";
import path from "node:path";
import { initializeCanvas, readPsd, writePsdBuffer } from "ag-psd";
import type { Layer, PixelData, Psd } from "ag-psd";
import { readRgba, sha256, writeAtomic, UiRenderError } from "./render.js";
import type { RenderedLayer, RenderedScene, RgbaImage } from "./render.js";

// ag-psd accepts raw ImageData. Explicitly initialize its allocation callback so
// readPsd does not try to create an HTML canvas or require node-canvas.
initializeCanvas(
  () => { throw new Error("Canvas is deliberately unavailable in the UI production backend"); },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: "srgb" }) as ImageData,
);

const REFERENCE_NAME = "Original design reference — hidden";
interface ExpectedLayer {
  numericId: number; id: string; name: string; groupPath: string[];
  x: number; y: number; width: number; height: number; opacity: number; visible: boolean;
  pixels: RgbaImage; reference: boolean;
}
export interface PixelComparison {
  sameSize: boolean; changedPixels: number; maximumChannelDifference: number;
  maximumAlphaDifference: number; maximumPremultipliedColorDifference: number;
}
export interface PsdValidation {
  status: "passed" | "failed"; file: string; sha256: string; bytes: number;
  reportFile: string; canvas: { width: number; height: number };
  independentLayerCount: number; groupCount: number; hiddenReference: boolean;
  layerMetadataMatches: boolean; layerPixelsExact: boolean; layerOrderMatches: boolean;
  compositeFromReopenedLayers: PixelComparison; cachedComposite: PixelComparison;
  layers: { id: string; psdLayerId: number; name: string; groupPath: string[]; x: number; y: number; width: number; height: number;
    opacity: number; visible: boolean; reference: boolean; pixelsExact: boolean }[];
  failures: string[]; limitations: string[]; nativeEditor: "not_verified";
}

function imageData(image: RgbaImage): PixelData { return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) }; }
function asRgba(data: PixelData | undefined, label: string): RgbaImage {
  if (!data || !(data.data instanceof Uint8Array || data.data instanceof Uint8ClampedArray) || data.data.length !== data.width * data.height * 4) throw new UiRenderError("INVALID_PSD_PIXELS", `PSD did not contain 8-bit RGBA pixels for ${label}`);
  return { width: data.width, height: data.height, data: Buffer.from(data.data.buffer, data.data.byteOffset, data.data.byteLength) };
}

/** Compare visual colors in premultiplied space as well as unassociated bytes.
 * PSD's merged transparency cache uses a quantized white matte; its unassociated
 * RGB may differ greatly at alpha=1 even when its visible error is below 1 byte.
 */
export function comparePixels(actual: RgbaImage, expected: RgbaImage): PixelComparison {
  const result: PixelComparison = { sameSize: actual.width === expected.width && actual.height === expected.height, changedPixels: 0, maximumChannelDifference: 0, maximumAlphaDifference: 0, maximumPremultipliedColorDifference: 0 };
  if (!result.sameSize || actual.data.length !== expected.data.length) return { ...result, maximumChannelDifference: 255, maximumAlphaDifference: 255, maximumPremultipliedColorDifference: 255 };
  for (let i = 0; i < actual.data.length; i += 4) {
    let changed = false;
    const a = actual.data[i + 3], b = expected.data[i + 3];
    result.maximumAlphaDifference = Math.max(result.maximumAlphaDifference, Math.abs(a - b));
    for (let channel = 0; channel < 4; channel++) {
      const difference = Math.abs(actual.data[i + channel] - expected.data[i + channel]);
      result.maximumChannelDifference = Math.max(result.maximumChannelDifference, difference); changed ||= difference !== 0;
      if (channel < 3) result.maximumPremultipliedColorDifference = Math.max(result.maximumPremultipliedColorDifference, Math.abs(actual.data[i + channel] * a - expected.data[i + channel] * b) / 255);
    }
    if (changed) result.changedPixels++;
  }
  return result;
}

/** A separate scalar source-over implementation verifies the library-independent
 * Sharp composite using only the pixels and metadata read back from the PSD.
 * Row buffers keep memory bounded without rounding every intermediate blend.
 */
function compositeReopened(psd: Psd): RgbaImage {
  const layers: { image: RgbaImage; left: number; top: number; opacity: number }[] = [];
  const visit = (children: Layer[], opacity: number, visible: boolean) => {
    for (const layer of [...children].reverse()) {
      const show = visible && !layer.hidden, alpha = opacity * (layer.opacity ?? 1);
      if (!show || alpha === 0) continue;
      if (layer.children) {
        if (layer.blendMode !== "pass through" && layer.blendMode !== "normal" && layer.blendMode !== undefined) throw new UiRenderError("UNSUPPORTED_PSD_BLEND", `Unexpected group blend ${layer.blendMode}`);
        if (alpha !== 1) throw new UiRenderError("UNSUPPORTED_PSD_GROUP_OPACITY", "Resolved groups must have unit opacity; leaf layers contain effective opacity");
        visit(layer.children, alpha, show);
      } else {
        if (layer.blendMode && layer.blendMode !== "normal") throw new UiRenderError("UNSUPPORTED_PSD_BLEND", `Unexpected layer blend ${layer.blendMode}`);
        if (layer.clipping || layer.mask || layer.effects) throw new UiRenderError("UNSUPPORTED_PSD_EFFECT", "Unexpected clipping, masks or effects in generated raster PSD");
        layers.push({ image: asRgba(layer.imageData, layer.name ?? "layer"), left: layer.left ?? 0, top: layer.top ?? 0, opacity: alpha });
      }
    }
  };
  visit(psd.children ?? [], 1, true);
  const output = Buffer.alloc(psd.width * psd.height * 4), row = new Float64Array(psd.width * 4);
  for (let y = 0; y < psd.height; y++) {
    row.fill(0);
    for (const { image, left, top, opacity } of layers) {
      const iy = y - top;
      if (iy < 0 || iy >= image.height) continue;
      const start = Math.max(0, left), end = Math.min(psd.width, left + image.width);
      for (let x = start; x < end; x++) {
        const from = (iy * image.width + x - left) * 4, to = x * 4;
        const alpha = Math.round(image.data[from + 3] * opacity) / 255, inverse = 1 - alpha;
        for (let c = 0; c < 3; c++) row[to + c] = image.data[from + c] * alpha + row[to + c] * inverse;
        row[to + 3] = alpha + row[to + 3] * inverse;
      }
    }
    for (let x = 0; x < psd.width; x++) {
      const at = x * 4, to = (y * psd.width + x) * 4, alpha = row[at + 3];
      output[to + 3] = Math.round(alpha * 255);
      for (let c = 0; c < 3; c++) output[to + c] = alpha ? Math.round(row[at + c] / alpha) : 0;
    }
  }
  return { width: psd.width, height: psd.height, data: output };
}

function flatten(children: Layer[], groupPath: string[] = []): { layer: Layer; groupPath: string[] }[] {
  return children.flatMap(layer => layer.children ? flatten(layer.children, [...groupPath, layer.name ?? ""]) : [{ layer, groupPath }]);
}
function treeSignature(children: Layer[]): unknown[] {
  return children.map(layer => layer.children ? { name: layer.name, id: layer.id, hidden: !!layer.hidden, children: treeSignature(layer.children) } : { id: layer.id });
}
function countGroups(children: Layer[]): number { return children.reduce((n, layer) => n + (layer.children ? 1 + countGroups(layer.children) : 0), 0); }

async function buildDocument(rendered: RenderedScene, reference: string | undefined): Promise<{ document: Psd; expected: ExpectedLayer[]; preview: RgbaImage }> {
  if (rendered.canvas.width > 30000 || rendered.canvas.height > 30000) throw new UiRenderError("PSD_CANVAS_TOO_LARGE", "PSD supports dimensions up to 30,000 pixels; PSB is not silently substituted");
  const expected: ExpectedLayer[] = [], bottomToTop: Layer[] = [];
  const groupKeys = new WeakMap<Layer, string>();
  let numericId = 1;
  const addPixels = (layer: RenderedLayer, pixels: RgbaImage): Layer => {
    const id = numericId++;
    expected.push({ numericId: id, id: layer.id, name: layer.name, groupPath: [...layer.groupPath], x: layer.x, y: layer.y,
      width: layer.width, height: layer.height, opacity: layer.opacity, visible: layer.visible, pixels, reference: false });
    return { id, name: layer.name, left: layer.x, top: layer.y, opacity: layer.opacity, hidden: !layer.visible, blendMode: "normal", imageData: imageData(pixels) };
  };
  if (reference) {
    const original = await readRgba(reference);
    if (original.width !== rendered.canvas.width || original.height !== rendered.canvas.height) throw new UiRenderError("REFERENCE_CANVAS_MISMATCH", "The hidden master reference must use the original scene canvas size");
    const id = numericId++;
    bottomToTop.push({ id, name: REFERENCE_NAME, left: 0, top: 0, hidden: true, opacity: 1, blendMode: "normal", imageData: imageData(original) });
    expected.push({ numericId: id, id: "__original_design_reference__", name: REFERENCE_NAME, groupPath: [], x: 0, y: 0,
      width: original.width, height: original.height, opacity: 1, visible: false, pixels: original, reference: true });
  }
  for (const layer of [...rendered.layers].sort((a, b) => a.z - b.z)) {
    if (sha256(await fs.readFile(layer.file)) !== layer.sha256) throw new UiRenderError("LAYER_CHANGED_AFTER_RENDER", `Layer changed after rendering: ${layer.id}`);
    const pixels = await readRgba(layer.file);
    if (pixels.width !== layer.width || pixels.height !== layer.height) throw new UiRenderError("LAYER_SIZE_CHANGED", `Layer dimensions changed: ${layer.id}`);
    let target = bottomToTop;
    for (let depth = 0; depth < layer.groupPath.length; depth++) {
      const key = JSON.stringify(layer.groupPath.slice(0, depth + 1));
      let group = target[target.length - 1];
      // A repeated, non-contiguous group gets another folder. Merging it with an
      // earlier folder would change interleaved display order.
      if (!group?.children || groupKeys.get(group) !== key) {
        group = { id: numericId++, name: layer.groupPath[depth], children: [], opened: true, opacity: 1, blendMode: "pass through" };
        groupKeys.set(group, key); target.push(group);
      }
      target = group.children!;
    }
    target.push(addPixels(layer, pixels));
  }
  const reverseTree = (children: Layer[]): Layer[] => [...children].reverse().map(layer => layer.children ? { ...layer, children: reverseTree(layer.children) } : layer);
  if (sha256(await fs.readFile(rendered.composite)) !== rendered.compositeSha256) throw new UiRenderError("COMPOSITE_CHANGED_AFTER_RENDER", "Composite changed after rendering");
  const preview = await readRgba(rendered.composite);
  if (preview.width !== rendered.canvas.width || preview.height !== rendered.canvas.height) throw new UiRenderError("CANVAS_MISMATCH", "Rendered composite dimensions differ from the scene");
  return { document: { width: rendered.canvas.width, height: rendered.canvas.height, bitsPerChannel: 8, children: reverseTree(bottomToTop), imageData: imageData(preview) }, expected, preview };
}

/** Writes a real layered PSD and independently reopens its pixels and hierarchy.
 * Raster text layers are intentionally used in PSD; source FGUI owns editable text.
 */
export async function buildPsd(rendered: RenderedScene, reference: string | undefined, outPath: string): Promise<PsdValidation> {
  const { document, expected, preview } = await buildDocument(rendered, reference ?? rendered.referenceFile);
  const bytes = writePsdBuffer(document, { generateThumbnail: false, trimImageData: false, noBackground: true, compress: false });
  await writeAtomic(outPath, bytes);
  const actualBytes = await fs.readFile(outPath);
  const reopened = readPsd(actualBytes, { useImageData: true, skipThumbnail: true, throwForMissingFeatures: true });
  const found = flatten(reopened.children ?? []), failures: string[] = [];
  const layerOrderMatches = JSON.stringify(treeSignature(document.children ?? [])) === JSON.stringify(treeSignature(reopened.children ?? []));
  if (!layerOrderMatches) failures.push("Layer/group order, IDs, Unicode names or group visibility changed after reopening");
  let layerMetadataMatches = found.length === expected.length, layerPixelsExact = found.length === expected.length;
  const rows: PsdValidation["layers"] = [];
  for (const wanted of expected) {
    const match = found.find(entry => entry.layer.id === wanted.numericId), actual = match?.layer;
    if (!actual) { failures.push(`Missing reopened PSD layer: ${wanted.id}`); layerMetadataMatches = false; layerPixelsExact = false; continue; }
    const left = actual.left ?? 0, top = actual.top ?? 0, width = (actual.right ?? 0) - left, height = (actual.bottom ?? 0) - top;
    const opacity = actual.opacity ?? 1, visible = !actual.hidden;
    const metadataMatches = actual.name === wanted.name && left === wanted.x && top === wanted.y && width === wanted.width && height === wanted.height && Math.abs(opacity - wanted.opacity) < 1e-10 && visible === wanted.visible && JSON.stringify(match.groupPath) === JSON.stringify(wanted.groupPath);
    const pixelsExact = Buffer.compare(asRgba(actual.imageData, wanted.id).data, wanted.pixels.data) === 0;
    if (!metadataMatches) { layerMetadataMatches = false; failures.push(`Reopened layer metadata differs: ${wanted.id}`); }
    if (!pixelsExact) { layerPixelsExact = false; failures.push(`Reopened layer pixels differ: ${wanted.id}`); }
    rows.push({ id: wanted.id, psdLayerId: wanted.numericId, name: actual.name ?? "", groupPath: match.groupPath, x: left, y: top, width, height, opacity, visible, reference: wanted.reference, pixelsExact });
  }
  const compositeFromReopenedLayers = comparePixels(compositeReopened(reopened), preview);
  if (!compositeFromReopenedLayers.sameSize || compositeFromReopenedLayers.maximumAlphaDifference > 1 || compositeFromReopenedLayers.maximumPremultipliedColorDifference > 2.01) failures.push("Recompositing reopened layers disagrees with the independent Sharp render");
  const cachedComposite = comparePixels(asRgba(reopened.imageData, "merged preview"), preview);
  if (!cachedComposite.sameSize || cachedComposite.maximumAlphaDifference !== 0 || cachedComposite.maximumPremultipliedColorDifference > 1.51) failures.push("PSD cached composite differs beyond the format's 8-bit transparency matte quantization");
  if (reopened.width !== document.width || reopened.height !== document.height) failures.push("PSD canvas dimensions changed");
  const hiddenReference = !expected.some(layer => layer.reference) || rows.some(layer => layer.reference && !layer.visible);
  if (!hiddenReference) failures.push("Original design reference is not hidden");
  const report: PsdValidation = { status: failures.length ? "failed" : "passed", file: path.resolve(outPath), sha256: sha256(actualBytes), bytes: actualBytes.length,
    reportFile: `${path.resolve(outPath)}.validation.json`, canvas: { width: reopened.width, height: reopened.height }, independentLayerCount: expected.filter(layer => !layer.reference).length,
    groupCount: countGroups(reopened.children ?? []), hiddenReference: expected.some(layer => layer.reference) && hiddenReference,
    layerMetadataMatches, layerPixelsExact, layerOrderMatches, compositeFromReopenedLayers, cachedComposite, layers: rows, failures,
    limitations: [...rendered.limitations, "PSD uses 8-bit RGB with independent alpha and normal-blend raster layers. Effective layer opacity is quantized to the PSD byte field.",
      "All reopened layer RGBA bytes must be exact. The independently recomposited preview allows at most 1 alpha byte and 2.01 premultiplied color bytes of compositor rounding.",
      "The PSD merged cache uses the format's 8-bit white matte for transparency. Its alpha must be exact; visible premultiplied color error is limited to 1.51 bytes. Low-alpha unassociated RGB can differ more.",
      "Reopening with ag-psd verifies structure and pixels; opening in Photoshop or the target FGUI editor remains a separate, unperformed check."], nativeEditor: "not_verified" };
  await writeAtomic(report.reportFile, JSON.stringify(report, null, 2));
  return report;
}
