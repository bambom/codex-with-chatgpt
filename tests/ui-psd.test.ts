import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { readPsd } from "ag-psd";
import { afterEach, describe, expect, it } from "vitest";
import { makeTmpDir, cleanup } from "./helpers.js";
import { renderScene, readRgba } from "../src/ui/render.js";
import { buildPsd } from "../src/ui/psd.js";
import { resolveScene } from "../src/ui/scene.js";
import type { Scene, SceneNode } from "../src/ui/scene.js";

const dirs: string[] = [];
const fixtureFont = fileURLToPath(new URL("./fixtures/fonts/ChronicleUI-Regular.ttf", import.meta.url));
function setup() { const dir = makeTmpDir("ui-psd"); dirs.push(dir); return dir; }
afterEach(() => { dirs.splice(0).forEach(cleanup); });

async function solid(dir: string, file: string, width: number, height: number, color: [number, number, number, number]) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) color.forEach((value, channel) => { pixels[i + channel] = value; });
  await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(path.join(dir, file));
}
function image(id: string, x: number, y: number, width: number, height: number, assetId: string, extra: Partial<SceneNode> = {}): SceneNode {
  return { id, name: id, type: "Image", x, y, width, height, assetId, ...extra };
}
function baseScene(children: SceneNode[], width = 127, height = 91): Scene {
  return { schemaVersion: 1, id: "inventory_fixture", name: "独立背包验收", canvas: { width, height }, entry: "main", assets: [], fonts: [],
    components: [{ id: "main", name: "背包", semantic: "Component", width, height, children }] };
}
function pixel(data: Buffer, width: number, x: number, y: number) { return [...data.subarray((y * width + x) * 4, (y * width + x + 1) * 4)]; }

describe("UI scene RGBA rendering and native Node PSD backend", () => {
  it("reopens real nested groups, Unicode names, semitransparent pixels, actual font text and a hidden master", async () => {
    const dir = setup();
    await solid(dir, "red.png", 46, 38, [212, 45, 20, 128]);
    await solid(dir, "blue.png", 24, 18, [30, 120, 232, 166]);
    await solid(dir, "master.png", 127, 91, [230, 12, 201, 255]);
    await fs.copyFile(fixtureFont, path.join(dir, "font.ttf"));
    const scene = baseScene([
      image("background", 3, 4, 46, 38, "red", { name: "底纹 半透明" }),
      { id: "panel", name: "属性面板", type: "Component", componentId: "panel_template", x: 15, y: 11, width: 77, height: 64 },
      image("hidden", 84, 2, 24, 18, "blue", { name: "隐藏状态", visible: false }),
    ]);
    scene.referenceFile = "master.png";
    scene.assets = [{ id: "red", file: "red.png", width: 46, height: 38 }, { id: "blue", file: "blue.png", width: 24, height: 18 }];
    scene.fonts = [{ id: "ui_font", file: "font.ttf", family: "Chronicle UI" }];
    scene.components.push({ id: "panel_template", name: "属性模板", semantic: "Component", width: 77, height: 64, children: [
      image("skin", 0, 0, 24, 18, "blue", { alpha: 0.6, name: "叠加皮肤" }),
      { id: "inner", name: "内部分组", type: "Component", componentId: "inner_template", x: 5, y: 20, width: 60, height: 30 },
    ] }, { id: "inner_template", name: "文字模板", semantic: "Component", width: 60, height: 30, children: [
      { id: "number", name: "数量 数值", type: "Text", x: 1, y: 2, width: 56, height: 25, text: "42", style: { fontId: "ui_font", fontSize: 18, color: "#203C6B", align: "center", vAlign: "middle", singleLine: true, autoSize: "none" } },
    ] });
    const resolved = resolveScene(scene), rendered = await renderScene(scene, resolved, dir, path.join(dir, "render"));
    expect(rendered.canvas).toEqual({ width: 127, height: 91 });
    expect(rendered.layers).toHaveLength(4);
    expect(rendered.atlas).toBeUndefined();
    const text = rendered.layers.find(layer => layer.type === "Text")!;
    expect(text.text).toBe("42");
    expect(text.fontSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(text.groupPath).toEqual(["属性面板 [panel]", "内部分组 [inner]"]);
    expect([text.x, text.y, text.width, text.height]).toEqual([21, 33, 56, 25]);
    const textPixels = await readRgba(text.file);
    expect([...textPixels.data].filter((_, index) => index % 4 === 3).some(value => value > 0)).toBe(true);
    expect([...textPixels.data].filter((_, index) => index % 4 === 3).some(value => value === 0)).toBe(true);
    const report = await buildPsd(rendered, rendered.referenceFile, path.join(dir, "interface.psd"));
    expect(report.failures).toEqual([]);
    expect(report.status).toBe("passed");
    expect(report.independentLayerCount).toBe(4);
    expect(report.groupCount).toBe(2);
    expect(report.hiddenReference).toBe(true);
    expect(report.layerPixelsExact).toBe(true);
    expect(report.layerMetadataMatches).toBe(true);
    expect(report.layerOrderMatches).toBe(true);
    expect(report.cachedComposite.maximumAlphaDifference).toBe(0);
    expect(report.compositeFromReopenedLayers.maximumPremultipliedColorDifference).toBeLessThanOrEqual(2.01);
    const psd = readPsd(await fs.readFile(report.file), { useImageData: true, skipThumbnail: true });
    expect(psd.children!.at(-1)!.hidden).toBe(true);
    expect(psd.children!.at(-1)!.imageData!.width).toBe(127);
    expect(psd.imageData!.data[3]).toBe(0); // Hidden magenta master must not contaminate the preview.
    const red = await readRgba(rendered.layers[0].file);
    expect(pixel(red.data, 46, 0, 0)).toEqual([212, 45, 20, 128]);
  });

  it("clips nested viewports with global/local offsets and preserves the source texture", async () => {
    const dir = setup(); await solid(dir, "tile.png", 9, 7, [92, 161, 43, 145]);
    const scene = baseScene([{ id: "viewport", name: "窗口", type: "Component", componentId: "viewport_template", x: 19, y: 13, width: 20, height: 16 }], 70, 60);
    scene.assets = [{ id: "tile", file: "tile.png", width: 9, height: 7 }];
    scene.components.push({ id: "viewport_template", name: "裁剪区", semantic: "Component", width: 20, height: 16, overflow: "hidden", children: [
      image("overflow", -4, 9, 30, 12, "tile"), image("outside", 30, 0, 9, 7, "tile"),
    ] });
    const rendered = await renderScene(scene, resolveScene(scene), dir, path.join(dir, "render"));
    expect(rendered.layers[0]).toMatchObject({ x: 19, y: 22, width: 20, height: 7, localX: -4, localY: 9, cropOffset: [4, 0], bounds: { x: 15, y: 22, width: 30, height: 12 } });
    expect(rendered.layers[1].visible).toBe(false);
    expect(pixel((await readRgba(rendered.layers[1].file)).data, 9, 0, 0)).toEqual([92, 161, 43, 145]);
    const preview = await readRgba(rendered.composite);
    expect(pixel(preview.data, 70, 18, 23)[3]).toBe(0);
    expect(pixel(preview.data, 70, 19, 23)[3]).toBe(145);
    expect(pixel(preview.data, 70, 39, 23)[3]).toBe(0);
    expect((await buildPsd(rendered, undefined, path.join(dir, "clipped.psd"))).status).toBe("passed");
  });

  it("resizes a center-rectangle nine-slice without stretching corners and aspect-fits dynamic loaders", async () => {
    const dir = setup(), pixels = Buffer.alloc(5 * 5 * 4);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
      const border = x === 0 || y === 0 || x === 4 || y === 4;
      const c = border ? [200, 10, 20, 255] : [10, 200, 20, 120]; c.forEach((value, k) => { pixels[(y * 5 + x) * 4 + k] = value; });
    }
    await sharp(pixels, { raw: { width: 5, height: 5, channels: 4 } }).png().toFile(path.join(dir, "skin.png"));
    await solid(dir, "portrait.png", 8, 4, [30, 50, 220, 255]);
    const scene = baseScene([image("nine", 0, 0, 11, 9, "skin"),
      image("slot", 16, 0, 8, 8, "portrait", { type: "Loader" }),
      { id: "empty", name: "dynamic slot", type: "Loader", x: 25, y: 0, width: 8, height: 8 },
      image("overflowing_loader", 18, 10, 8, 8, "portrait", { type: "Loader", loader: { fill: "scaleMatchHeight" } }),
    ], 40, 20);
    scene.assets = [{ id: "skin", file: "skin.png", width: 5, height: 5, scale9grid: [1, 1, 3, 3] }, { id: "portrait", file: "portrait.png", width: 8, height: 4 }];
    const rendered = await renderScene(scene, resolveScene(scene), dir, path.join(dir, "render"));
    const nine = await readRgba(rendered.layers[0].file), loader = await readRgba(rendered.layers[1].file);
    expect(pixel(nine.data, 11, 0, 0)).toEqual([200, 10, 20, 255]);
    expect(pixel(nine.data, 11, 10, 8)).toEqual([200, 10, 20, 255]);
    const center = pixel(nine.data, 11, 5, 4);
    expect(center[3]).toBe(120);
    [10, 200, 20].forEach((value, index) => { expect(Math.abs(center[index] - value)).toBeLessThanOrEqual(2); });
    expect(pixel(loader.data, 8, 3, 0)[3]).toBe(0);
    expect(pixel(loader.data, 8, 3, 2)[3]).toBe(255);
    expect(pixel(loader.data, 8, 3, 6)[3]).toBe(0);
    expect(rendered.layers[2].renderMode).toBe("empty");
    expect(rendered.layers[3]).toMatchObject({ x: 14, y: 10, width: 16, height: 8, bounds: { x: 18, y: 10, width: 8, height: 8 }, cropOffset: [-4, 0] });
    const preview = await readRgba(rendered.composite);
    expect(pixel(preview.data, 40, 14, 12)[3]).toBe(255); // Native Loader does not clip at its own slot.
  });

  it("emits an exact 9:25 transparent atlas only on request, with unchanged sprite pixels", async () => {
    const dir = setup(); await solid(dir, "sprite.png", 12, 8, [21, 85, 196, 109]);
    const scene = baseScene([image("one", 1, 1, 12, 8, "sprite"), image("two", 14, 3, 12, 8, "sprite")], 40, 24);
    scene.assets = [{ id: "sprite", file: "sprite.png", width: 12, height: 8 }];
    const rendered = await renderScene(scene, resolveScene(scene), dir, path.join(dir, "render"), { atlas: { ratio: "9:25", padding: 2 } });
    const atlas = rendered.atlas!, pixels = await readRgba(atlas.file), coordinates = JSON.parse(await fs.readFile(atlas.coordinates, "utf8"));
    expect(atlas.width * 25).toBe(atlas.height * 9);
    expect(coordinates.scaled).toBe(false);
    expect(coordinates.sprites).toHaveLength(2);
    expect(pixel(pixels.data, pixels.width, 0, 0)[3]).toBe(0);
    for (const item of coordinates.sprites) expect(pixel(pixels.data, pixels.width, item.x, item.y)).toEqual([21, 85, 196, 109]);
  });

  it("rejects missing font glyphs, unsupported rich text, fractional geometry, and stale rendered files", async () => {
    const dir = setup(); await fs.copyFile(fixtureFont, path.join(dir, "font.ttf")); await solid(dir, "asset.png", 4, 4, [1, 2, 3, 128]);
    const scene = baseScene([{ id: "text", name: "Text", type: "Text", x: 0, y: 0, width: 60, height: 30, text: "\u{1F984}", style: { fontId: "font", fontSize: 14, color: "#223344" } }]);
    scene.fonts = [{ id: "font", file: "font.ttf", family: "Chronicle UI" }];
    await expect(renderScene(scene, resolveScene(scene), dir, path.join(dir, "missing"))).rejects.toMatchObject({ code: "MISSING_FONT_GLYPH" });
    scene.components[0].children[0].type = "RichText";
    await expect(renderScene(scene, resolveScene(scene), dir, path.join(dir, "rich"))).rejects.toMatchObject({ code: "RICH_TEXT_REFERENCE_REQUIRED" });
    scene.components[0].children = [image("image", 0, 0, 4, 4, "asset")]; scene.assets = [{ id: "asset", file: "asset.png", width: 4, height: 4 }];
    const fractional = resolveScene(scene); fractional.layers[0].x = 0.5;
    await expect(renderScene(scene, fractional, dir, path.join(dir, "fractional"))).rejects.toMatchObject({ code: "SUBPIXEL_GEOMETRY" });
    const rendered = await renderScene(scene, resolveScene(scene), dir, path.join(dir, "good"));
    await fs.writeFile(rendered.layers[0].file, "changed after render");
    await expect(buildPsd(rendered, undefined, path.join(dir, "stale.psd"))).rejects.toMatchObject({ code: "LAYER_CHANGED_AFTER_RENDER" });
  });

  it("rejects a font family that would fall back and a master with the wrong canvas", async () => {
    const dir = setup(); await fs.copyFile(fixtureFont, path.join(dir, "font.ttf")); await solid(dir, "reference.png", 20, 20, [20, 20, 20, 255]);
    const scene = baseScene([{ id: "text", name: "Text", type: "Text", x: 0, y: 0, width: 50, height: 25, text: "A", style: { fontId: "font", fontSize: 14, color: "#223344" } }]);
    scene.fonts = [{ id: "font", file: "font.ttf", family: "Not The Real Font" }];
    await expect(renderScene(scene, resolveScene(scene), dir, path.join(dir, "badfont"))).rejects.toMatchObject({ code: "FONT_FAMILY_MISMATCH" });
    scene.fonts[0].family = "Chronicle UI";
    const rendered = await renderScene(scene, resolveScene(scene), dir, path.join(dir, "good"));
    await expect(buildPsd(rendered, path.join(dir, "reference.png"), path.join(dir, "badref.psd"))).rejects.toMatchObject({ code: "REFERENCE_CANVAS_MISMATCH" });
  });

  it("preserves continuous soft alpha and validates a low-alpha merged PSD cache honestly", async () => {
    const dir = setup(), width = 32, height = 12, data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      data[(y * width + x) * 4] = (x * 79 + 43) % 256;
      data[(y * width + x) * 4 + 1] = (y * 37 + 67) % 256;
      data[(y * width + x) * 4 + 2] = 187;
      data[(y * width + x) * 4 + 3] = Math.floor(x * 255 / (width - 1));
    }
    await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(path.join(dir, "soft.png"));
    const scene = baseScene([image("soft", 2, 3, width, height, "soft"), image("overlap", 11, 8, width, height, "soft", { alpha: 0.37 })], 50, 30);
    scene.assets = [{ id: "soft", file: "soft.png", width, height }];
    const rendered = await renderScene(scene, resolveScene(scene), dir, path.join(dir, "render"));
    expect((await readRgba(rendered.layers[0].file)).data).toEqual(data);
    const report = await buildPsd(rendered, undefined, path.join(dir, "soft.psd"));
    expect(report.failures).toEqual([]);
    expect(report.layerPixelsExact).toBe(true);
    expect(report.cachedComposite.maximumAlphaDifference).toBe(0);
    expect(report.cachedComposite.maximumChannelDifference).toBeGreaterThan(0);
    expect(report.cachedComposite.maximumPremultipliedColorDifference).toBeLessThanOrEqual(1.51);
  });

  it("renders real font outlines and shadows into separate transparent text layers", async () => {
    const dir = setup(); await fs.copyFile(fixtureFont, path.join(dir, "font.ttf"));
    const scene = baseScene([{ id: "styled", name: "描边与阴影", type: "Text", x: 5, y: 5, width: 70, height: 38, text: "A2",
      style: { fontId: "font", fontSize: 21, color: "#204060", strokeColor: "#FF0000", strokeSize: 2,
        shadowColor: "#00FF00", shadowOffset: [5, 5], singleLine: true, align: "center", vAlign: "middle" } }], 90, 50);
    scene.fonts = [{ id: "font", file: "font.ttf", family: "Chronicle UI" }];
    const rendered = await renderScene(scene, resolveScene(scene), dir, path.join(dir, "render"));
    const pixels = await readRgba(rendered.layers[0].file);
    let reds = 0, greens = 0, transparent = 0;
    for (let i = 0; i < pixels.data.length; i += 4) {
      if (!pixels.data[i + 3]) transparent++;
      if (pixels.data[i] > 200 && pixels.data[i + 1] < 30 && pixels.data[i + 3] > 40) reds++;
      if (pixels.data[i + 1] > 200 && pixels.data[i] < 30 && pixels.data[i + 3] > 40) greens++;
    }
    expect(reds).toBeGreaterThan(0); expect(greens).toBeGreaterThan(0); expect(transparent).toBeGreaterThan(0);
    expect((await buildPsd(rendered, undefined, path.join(dir, "styled.psd"))).status).toBe("passed");
  });
});
