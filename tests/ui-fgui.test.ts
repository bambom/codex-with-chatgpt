import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { makeTmpDir, cleanup, write } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";
import { type Scene, type SceneComponent, type SceneNode, parseScene, resolveScene, sceneInputFiles, validateScene } from "../src/ui/scene.js";
import { exportFgui, knownFontTexts, validateFguiSource } from "../src/ui/fgui.js";
import { type TargetProfile, inspectTarget, verifyTargetProfile, parseNativeXml } from "../src/ui/target.js";

const temporary: string[] = [];
const fixtureRoot = fileURLToPath(new URL("./fixtures/ui/", import.meta.url));
const temp = () => { const dir = makeTmpDir("ui-fgui"); temporary.push(dir); return dir; };
afterEach(() => { temporary.splice(0).forEach(cleanup); });

function profile(): TargetProfile {
  return { schemaVersion: 1, id: "target_test", inspectedAt: "2026-10-10T00:00:00Z", workspaceId: "test", requestedPath: "target",
    status: "ready", adapter: "fairygui-source-5.0-v1", project: { file: "target/Actual.fairy", root: "target", id: "actual", type: "Layabox", version: "5.0", sha256: "0".repeat(64) }, candidates: [],
    capabilities: { confirmed: ["Component", "Image", "Loader", "Text", "RichText", "InputText", "Button", "Slider", "ProgressBar", "ScrollBar", "List", "ComboBox", "Group", "Controller", "Gear", "Relation", "NineSlice", "Font"], unconfirmed: [], notes: [] },
    limits: { files: 64, totalBytes: 2_000_000, fileBytes: 1_000_000, xmlBytes: 131_072, xmlDepth: 32, objects: 256 },
    evidence: [], snapshots: { packages: [], components: [], settings: [] }, notes: [],
    checks: { staticResearch: "passed", editorImport: "not_verified", runtimeInteraction: "not_verified" } };
}

const text = (id: string, name: string, width: number, height: number, value = "Label"): SceneNode => ({ id, name, type: "Text", x: 0, y: 0, width, height,
  text: value, style: { fontFamily: "Arial", fontSize: 14, color: "#123456", autoSize: "none", singleLine: true } });
const image = (id: string, name: string, x: number, y: number, width: number, height: number): SceneNode => ({ id, name, type: "Image", x, y, width, height, assetId: "skin" });
const instance = (id: string, type: SceneNode["type"], componentId: string, x: number, y: number, width: number, height: number, data: SceneNode["instance"] = {}): SceneNode =>
  ({ id, name: id, type, componentId, x, y, width, height, instance: data });

/** A second, deliberately non-timeline screen. It exercises controls, a data
 * list and popup resources without any dates/cards/Shentonglu identifiers. */
function inventoryScene(): Scene {
  const action: SceneComponent = { id: "action", name: "Action", semantic: "Button", width: 80, height: 40,
    extension: { button: { mode: "Common", downEffect: "dark", downEffectValue: 0.8 } },
    children: [image("skin", "skin", 0, 0, 80, 40), text("title", "title", 80, 40, "Use")] };
  const option: SceneComponent = { id: "option", name: "Option", semantic: "Button", width: 280, height: 28,
    extension: { button: { mode: "Radio" } }, controllers: [{ name: "button", pages: [{ id: "u", name: "up" }, { id: "d", name: "down" }], selectedPageId: "u" }],
    children: [text("title", "title", 280, 28, "Option")] };
  const popup: SceneComponent = { id: "popup", name: "OptionsPopup", semantic: "Component", width: 280, height: 56,
    children: [{ id: "list", name: "list", type: "List", x: 0, y: 0, width: 280, height: 56,
      list: { layout: "column", defaultItem: "option", overflow: "scroll", scrollBar: "hidden", items: [] } }] };
  const combo: SceneComponent = { id: "combo", name: "Category", semantic: "ComboBox", width: 280, height: 40,
    extension: { comboBox: { dropdown: "popup" } }, children: [text("title", "title", 280, 40, "All")] };
  const grip: SceneComponent = { id: "grip", name: "SliderGrip", semantic: "Button", width: 12, height: 20,
    extension: { button: { mode: "Common" } }, children: [image("skin", "skin", 0, 0, 12, 20)] };
  const slider: SceneComponent = { id: "slider", name: "Quantity", semantic: "Slider", width: 200, height: 20,
    extension: { slider: { titleType: "percent", wholeNumbers: true, changeOnClick: true } },
    children: [image("bar", "bar", 8, 8, 184, 4), { ...instance("grip", "Button", "grip", 186, 0, 12, 20),
      relations: [{ target: "bar", sidePair: "right-right" }] }] };
  const progress: SceneComponent = { id: "progress", name: "Experience", semantic: "ProgressBar", width: 200, height: 20,
    extension: { progressBar: { titleType: "valueAndmax" } }, children: [image("bar", "bar", 0, 6, 200, 8), text("title", "title", 200, 20, "0/100")] };
  const scrollGrip: SceneComponent = { id: "scrollGrip", name: "ScrollGrip", semantic: "Button", width: 12, height: 30,
    extension: { button: { mode: "Common" } }, children: [{ ...image("skin", "skin", 0, 0, 12, 30),
      relations: [{ target: "", sidePair: "width-width,height-height" }] }] };
  const scrollbar: SceneComponent = { id: "scrollbar", name: "VerticalScrollBar", semantic: "ScrollBar", width: 12, height: 120,
    extension: { scrollBar: { fixedGripSize: false } }, children: [image("bar", "bar", 0, 0, 12, 120), { ...instance("grip", "Button", "scrollGrip", 0, 0, 12, 30), touchable: true }] };
  const row: SceneComponent = { id: "row", name: "InventoryRow", semantic: "Component", width: 200, height: 24,
    children: [text("label", "label", 160, 24), { id: "icon", name: "icon", type: "Loader", x: 176, y: 4, width: 16, height: 16, assetId: "skin" }] };
  const main: SceneComponent = { id: "main", name: "Inventory", semantic: "Component", width: 360, height: 480,
    controllers: [{ name: "page", pages: [{ id: "first", name: "First" }, { id: "second", name: "Second" }], selectedPageId: "second", exported: true }],
    children: [
      instance("use", "Button", "action", 16, 16, 80, 40, { title: "Equip" }),
      { ...text("search", "search", 200, 28, "Sword"), type: "InputText", x: 16, y: 64, input: { prompt: "Search", maxLength: 32 } },
      instance("quantity", "Slider", "slider", 16, 100, 200, 20, { min: 0, max: 100, value: 25 }),
      instance("experience", "ProgressBar", "progress", 16, 132, 200, 20, { min: 0, max: 100, value: 75 }),
      instance("category", "ComboBox", "combo", 16, 168, 280, 40, { title: "All", visibleItemCount: 2, items: [{ title: "All", value: "all" }, { title: "Weapon", value: "weapon" }] }),
      { id: "inventory", name: "inventory", type: "List", x: 16, y: 224, width: 212, height: 120,
        list: { layout: "column", defaultItem: "row", overflow: "scroll", scroll: "vertical", scrollBar: "visible", verticalScrollBar: "scrollbar", selectionMode: "none",
          items: Array.from({ length: 8 }, (_, i) => ({ name: `slot${i}`, properties: [{ target: "label", property: "text", value: `Item ${i + 1}` } as const] })) } },
      { ...image("pageMark", "pageMark", 300, 16, 16, 16), gears: [{ kind: "display", controller: "page", pages: ["second"] }] },
    ] };
  return { schemaVersion: 1, id: "inventory", name: "Inventory", canvas: { width: 360, height: 480 }, entry: "main",
    assets: [{ id: "skin", file: "skin.png", width: 16, height: 16, scale9grid: [2, 2, 12, 12], provenance: "Test skin" }], fonts: [],
    components: [main, action, option, popup, combo, grip, slider, progress, scrollbar, row, scrollGrip] };
}

async function skin(dir: string): Promise<void> {
  await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 40, g: 90, b: 130, alpha: 0.6 } } }).png().toFile(path.join(dir, "skin.png"));
}

describe("shared semantic scene and native source export", () => {
  it("preserves semantic controls, template max bars, data items, scopes and source spelling", async () => {
    const root = temp(); await skin(root); const scene = inventoryScene();
    expect(validateScene(scene).errors).toEqual([]);
    const resolved = resolveScene(scene);
    const resolvedIds = new Set(resolved.nodes.map(node => node.id));
    expect(resolvedIds.size).toBe(resolved.nodes.length);
    expect(resolved.nodes.every(node => node.parentId === null || resolvedIds.has(node.parentId))).toBe(true);
    expect(resolved.nodes.every(node => node.targetFguiType && node.recognition?.basis)).toBe(true);
    const bar = resolved.layers.find(layer => layer.id === "main/quantity/bar")!;
    expect([bar.x, bar.y, bar.width, bar.height]).toEqual([24, 108, 46, 4]);
    const grip = resolved.nodes.find(node => node.id === "main/quantity/grip")!;
    expect(grip.x).toBe(64); // max grip x 186 + bar-width delta -138 + owner x 16
    expect(resolved.layers.find(layer => layer.id === "main/experience/title")?.text).toBe("75/100");
    expect(resolved.layers.find(layer => layer.id === "main/inventory/item:slot7/label")?.text).toBe("Item 8");
    expect(resolved.layers.find(layer => layer.id === "main/inventory/item:slot7/label")?.clip).toEqual({ x: 16, y: 224, width: 200, height: 120 });
    const output = path.join(root, "output"); const report = await exportFgui(scene, profile(), root, output, "job001");
    expect(report.validation.status).toBe("passed"); expect(report.validation.editorImport).toBe("not_verified"); expect(report.validation.runtimeInteraction).toBe("not_verified");
    const entry = await fs.readFile(path.join(output, report.entryComponent), "utf8");
    expect(entry).toContain('input="true"'); expect(entry).not.toContain("GTextInput");
    expect(entry).toContain('<Slider min="0" max="100" value="25"/>');
    expect(entry).toContain('homePageType="specific" homePage="second"');
    expect(entry).toContain('<ComboBox title="All"'); expect(entry).toContain('<item title="Weapon" value="weapon"/>');
    const sliderFile = report.resources.find(resource => resource.semanticId === "slider" && resource.kind === "component")!.file;
    const slider = await fs.readFile(path.join(output, sliderFile), "utf8");
    expect(slider).toContain('extention="Slider"'); expect(slider).toContain('size="184,4"');
    expect(slider).not.toContain('value="25"'); expect(slider).toContain('sidePair="right-right"');
    const rowFile = report.resources.find(resource => resource.semanticId === "row" && resource.kind === "component")!.file;
    expect(await fs.readFile(path.join(output, rowFile), "utf8")).toContain('<customProperty target="label" propertyId="0"');
    expect(report.validation.semanticCounts.InputText).toBe(1);
    expect(report.validation.semanticCounts.Slider).toBe(1);
    expect(report.validation.semanticCounts.ProgressBar).toBe(1);
    expect(report.validation.semanticCounts.ComboBox).toBe(1);
    expect(await fs.readdir(output)).not.toContain("Reports");
    // Deterministic rebuild within a job; another job cannot accidentally reuse its package identity.
    const again = await exportFgui(scene, profile(), root, path.join(root, "again"), "job001");
    const other = await exportFgui(scene, profile(), root, path.join(root, "other"), "job002");
    expect(again.packageId).toBe(report.packageId); expect(other.packageId).not.toBe(report.packageId); expect(other.packageName).not.toBe(report.packageName);
    expect(again.validation.checkedFiles).toEqual(report.validation.checkedFiles);
  });

  it("rejects fake/degraded controls, missing resources, duplicate identities, unsafe paths and cycles", () => {
    const mutate = (change: (scene: Scene) => void, code: string) => { const scene = inventoryScene(); change(scene); expect(validateScene(scene).errors.some(error => error.code === code)).toBe(true); };
    mutate(scene => { scene.components[0].children[0].type = "Image"; }, "COMPONENT_ON_LEAF");
    mutate(scene => { scene.assets[0].file = "../outside.png"; }, "SCENE_SCHEMA");
    mutate(scene => { scene.assets[0].file = "C:/outside.png"; }, "SCENE_SCHEMA");
    mutate(scene => { scene.components[0].children.push({ ...scene.components[0].children[0] }); }, "DUPLICATE_ID");
    mutate(scene => { scene.components.find(component => component.id === "slider")!.children.pop(); }, "SLIDER_GRIP");
    mutate(scene => { scene.components[0].children[2].instance!.max = 0; }, "CONTROL_RANGE");
    mutate(scene => { scene.components[0].children[4].instance!.items = []; }, "COMBO_OPTIONS_REQUIRED");
    mutate(scene => { scene.components[0].children[6].gears![0].controller = "missing"; }, "GEAR_CONTROLLER_PAGE");
    mutate(scene => { scene.components.find(component => component.id === "action")!.children.push(instance("loop", "Component", "main", 0, 0, 360, 480)); }, "COMPONENT_CYCLE");
    mutate(scene => { scene.components[0].children[0].width = 90; }, "COMPONENT_RESIZE_UNSUPPORTED");
    mutate(scene => { scene.components[0].children[0].rotation = 30; }, "SCENE_SCHEMA");
    mutate(scene => { scene.assets[0].scale9grid = [12, 12, 8, 8]; }, "SCALE9_CENTER_RECT");
    mutate(scene => { scene.components[0].children[0].relations = [{ target: "search", sidePair: "left-left" }];
      scene.components[0].children[1].relations = [{ target: "use", sidePair: "left-left" }]; }, "RELATION_CYCLE");
  });

  it("re-reads emitted XML and rejects bad references plus actual selected-root capacity", async () => {
    const root = temp(); await skin(root); const output = path.join(root, "out"); const report = await exportFgui(inventoryScene(), profile(), root, output, "job001");
    const entry = path.join(output, report.entryComponent); const original = await fs.readFile(entry, "utf8");
    await fs.writeFile(entry, original.replace(/src="[^"]+"/, 'src="missing"'));
    let result = await validateFguiSource(output, profile()); expect(result.errors.some(error => error.code === "RESOURCE_SRC")).toBe(true);
    await fs.writeFile(entry, original);
    // Documentation really counts against the current importer limit.
    await fs.writeFile(path.join(output, "not-free.txt"), "extra bytes");
    const limited = profile(); limited.limits.files = report.validation.files;
    result = await validateFguiSource(output, limited); expect(result.errors.some(error => error.code === "TARGET_FILE_LIMIT")).toBe(true);
    expect(result.editorImport).toBe("not_verified");
    await expect(exportFgui(inventoryScene(), profile(), root, output, "job001")).rejects.toThrow("OUTPUT_NOT_EMPTY");
  });

  it("retains global coordinates through components, logical groups and controller pages", () => {
    const scene = inventoryScene(); const row = scene.components.find(component => component.id === "row")!;
    row.children.unshift({ id: "logical", name: "logical", type: "Group", x: 100, y: 100, width: 20, height: 20, alpha: 0.5 });
    row.children[1].groupId = "logical";
    const resolved = resolveScene(scene); const label = resolved.layers.find(layer => layer.id === "main/inventory/item:slot0/label")!;
    expect([label.x, label.y, label.opacity]).toEqual([16, 224, 0.5]);
    expect(resolved.layers.some(layer => layer.type === "Group")).toBe(false);
    expect(resolved.layers.find(layer => layer.sourceId === "pageMark")!.visible).toBe(true);
  });

  it("uses a hittable native Button grip and resizes only its explicitly related skin", async () => {
    const scene = inventoryScene(), resolved = resolveScene(scene), root = temp(); await skin(root);
    const grip = resolved.nodes.find(node => node.id === "main/inventory/@verticalScrollBar/grip")!;
    const skinLayer = resolved.layers.find(node => node.id === grip.id + "/skin")!;
    expect(grip).toMatchObject({ type: "Button", targetFguiType: "GButton", x: 216, y: 224, width: 12, height: 75 });
    expect(skinLayer).toMatchObject({ x: 216, y: 224, width: 12, height: 75 }); // floor(120 / (8 * 24) * 120)
    const output = path.join(root, "source"), report = await exportFgui(scene, profile(), root, output, "grip-fix");
    const template = report.resources.find(resource => resource.semanticId === "scrollGrip" && resource.kind === "component")!;
    const xml = await fs.readFile(path.join(output, template.file), "utf8");
    expect(xml).toContain('opaque="true"'); expect(xml).toContain('extention="Button"');
    expect(xml).toContain('target="" sidePair="width-width,height-height"');
    expect(xml).toContain('size="12,30"'); // Template stays at authored size; runtime parent relation stretches its skin.
    const bar = scene.components.find(component => component.id === "scrollbar")!;
    bar.children[1] = { ...image("grip", "grip", 0, 0, 12, 30), touchable: true };
    expect(validateScene(scene).errors.some(error => error.code === "SCROLLBAR_GRIP")).toBe(true);
    const slider = scene.components.find(component => component.id === "slider")!;
    slider.children[1] = { ...image("grip", "grip", 186, 0, 12, 20), touchable: true, relations: [{ target: "bar", sidePair: "right-right" }] };
    expect(validateScene(scene).errors.some(error => error.code === "SLIDER_GRIP")).toBe(true);
    const missingRelation = inventoryScene(); delete missingRelation.components.find(component => component.id === "scrollGrip")!.children[0].relations;
    expect(validateScene(missingRelation).errors.some(error => error.code === "SCROLLBAR_GRIP_RESIZE")).toBe(true);
    // Re-reading already-exported files must reject an image being substituted
    // for an interactive grip, independently of the Scene validator.
    const scrollbarFile = path.join(output, report.resources.find(resource => resource.semanticId === "scrollbar" && resource.kind === "component")!.file);
    const imageResource = report.resources.find(resource => resource.kind === "image")!;
    const original = await fs.readFile(scrollbarFile, "utf8");
    await fs.writeFile(scrollbarFile, original.replace(/<component\b[^>]*name="grip"[^>]*>.*?<\/component>/,
      `<image id="brokenGrip" name="grip" src="${imageResource.id}" fileName="${imageResource.path.slice(1)}${imageResource.name}" xy="0,0" size="12,30" touchable="true"/>`));
    expect((await validateFguiSource(output, profile())).errors.some(error => error.code === "NATIVE_GRIP_HIT_TARGET")).toBe(true);
  });

  it("uses only explicit native PNG variants at their own dimensions and excludes PSD-only references", async () => {
    const root = temp(), pixels = Buffer.alloc(256 * 256 * 4); let seed = 17;
    for (let i = 0; i < pixels.length; i++) { seed = Math.imul(seed, 1664525) + 1013904223 | 0; pixels[i] = seed >>> 24; }
    await sharp(pixels, { raw: { width: 256, height: 256, channels: 4 } }).png().toFile(path.join(root, "skin.png"));
    await sharp(path.join(root, "skin.png")).resize(8, 8).png().toFile(path.join(root, "compact.png"));
    await sharp({ create: { width: 80, height: 40, channels: 4, background: "transparent" } }).png().toFile(path.join(root, "psd-only.png"));
    const scene = inventoryScene(); scene.assets[0].width = 256; scene.assets[0].height = 256; scene.assets[0].scale9grid = [2, 2, 252, 252];
    const limited = profile(); limited.limits.fileBytes = 10_000;
    await expect(exportFgui(scene, limited, root, path.join(root, "too-large"), "job1")).rejects.toThrow("TARGET_FILE_BYTES");
    scene.assets[0].fgui = { file: "compact.png", width: 8, height: 8, scale9grid: [1, 1, 6, 6], provenance: "Explicit 8px test texture; native visual equivalence requires its own review." };
    scene.assets.push({ id: "reference", file: "psd-only.png", width: 80, height: 40 });
    scene.components.find(component => component.id === "action")!.children[1].referenceAssetId = "reference";
    expect(sceneInputFiles(scene)).toEqual(["skin.png", "compact.png", "psd-only.png"]);
    const output = path.join(root, "compact"), report = await exportFgui(scene, limited, root, output, "job1");
    expect(report.validation.status).toBe("passed");
    const nativeSkin = report.resources.find(resource => resource.kind === "image")!;
    expect(nativeSkin).toMatchObject({ sourceFile: "compact.png", originalSourceFile: "skin.png", width: 8, height: 8, originalWidth: 256, originalHeight: 256 });
    expect((await sharp(path.join(output, nativeSkin.file)).metadata()).width).toBe(8);
    expect(report.resources.some(resource => resource.semanticId === "reference")).toBe(false);
    expect(await fs.readFile(path.join(output, `assets/${report.packageName}/package.xml`), "utf8")).toContain('scale9grid="1,1,6,6"');
    expect(resolveScene(scene).layers.find(layer => layer.id === "main/quantity/bar")?.width).toBe(46);
    delete scene.assets[0].fgui.scale9grid;
    expect(validateScene(scene).errors.some(error => error.code === "VARIANT_SCALE9_REQUIRED")).toBe(true);
    scene.assets[0].fgui.scale9grid = [1, 1, 6, 6];
    scene.components.find(component => component.id === "row")!.children[1].loader = { fill: "none" };
    expect(validateScene(scene).errors.some(error => error.code === "VARIANT_LOADER_GEOMETRY")).toBe(true);
  });

  it("exports the portable all-controls fixture below real importer limits and checks compact fonts against hidden states", async () => {
    const root = temp(); await fs.cp(path.join(fixtureRoot, "inputs"), root, { recursive: true });
    const scene = parseScene(JSON.parse(await fs.readFile(path.join(fixtureRoot, "inventory-all-controls.scene.json"), "utf8")));
    await fs.copyFile(path.join(root, scene.fonts[0].file), path.join(root, "native.ttf"));
    scene.fonts[0].fgui = { file: "native.ttf", family: "Chronicle UI", provenance: "Explicit already-subset fixture font, supplied separately to the native source exporter." };
    expect(sceneInputFiles(scene)).toContain("native.ttf");
    const report = await exportFgui(scene, profile(), root, path.join(root, "source"), "fixture-job");
    expect(report.validation.files).toBeLessThanOrEqual(64); expect(report.validation.totalBytes).toBeLessThan(2_000_000);
    expect(report.fontCoverage[0]).toMatchObject({ status: "passed", sourceFile: "native.ttf", family: "Chronicle UI" });
    expect(report.fontCoverage[0].checkedCodePoints).toBeGreaterThan(30);
    expect(report.resources.find(resource => resource.kind === "font")).toMatchObject({ sourceFile: "native.ttf", originalSourceFile: "fonts/ChronicleUI-Regular.ttf" });
    scene.components[0].children[1].gears = [{ kind: "text", controller: "page", values: { first: "\u{1F984}", second: "Sword" } }];
    expect(knownFontTexts(scene).ui_font).toContain("\u{1F984}");
    await expect(exportFgui(scene, profile(), root, path.join(root, "missing-hidden-glyph"), "fixture-job")).rejects.toThrow("FGUI_FONT_GLYPH_MISSING");
  });
});

describe("real target inspection", () => {
  const nativeProject = async (dir: string, relative: string, type: string) => {
    write(dir, `${relative}/Actual.fairy`, `<projectDescription id="actualTarget" type="${type}" version="5.0"/>`);
    write(dir, `${relative}/assets/Controls/package.xml`, '<packageDescription id="ctrl0001"><resources><image id="skin" name="skin.png" path="/"/><component id="main" name="Main.xml" path="/"/></resources></packageDescription>');
    write(dir, `${relative}/assets/Controls/Main.xml`, '<component size="16,16"><displayList><image id="n0" name="background" src="skin" fileName="skin.png" xy="0,0" size="16,16"/></displayList></component>');
    await skin(path.join(dir, `${relative}/assets/Controls`));
  };

  it("selects only actual project metadata and fingerprints evidence without copying project settings", async () => {
    const dir = temp(); await nativeProject(dir, "UnityLookingName", "Layabox");
    write(dir, "UnityLookingName/settings/Common.json", '{"font":"TargetFont","publishPath":"E:/Existing"}');
    write(dir, "MagicGameClient/src/app/game-ui/contracts/source-project.ts", "export const SOURCE_PROJECT_LIMITS=Object.freeze({files:64,totalBytes:2_000_000,fileBytes:1_000_000,xmlBytes:131_072,xmlDepth:32,objects:256});");
    write(dir, "MagicGameClient/src/app/game-ui/fgui/domain/source-project-importer.ts", "export const importerVersion = 1;");
    write(dir, "MagicGameClient/src/app/game-ui/fgui/domain/source-project-export.ts", "export const sourceWriterVersion = 1;");
    write(dir, "MagicGameClient/tools/game-ui/dependencies.json", '{"profileId":"actual-test-runtime","laya":{"ref":"3.4.1"},"fgui":{"commit":"test-pin"}}');
    for (const name of ["GSlider.ts", "GProgressBar.ts"]) write(dir, `FguiProject/PRD/FairyGUI-layabox/source/src/fairygui/${name}`, "export const title = (percent:number) => Math.floor(percent * 100);");
    const workspace = new Workspace(dir); const first = await inspectTarget(workspace, "UnityLookingName/Actual.fairy");
    expect(first.status).toBe("ready"); expect(first.project!.type).toBe("Layabox");
    expect(first.capabilities.confirmed).toContain("Image"); expect(first.capabilities.unconfirmed).toContain("Slider");
    expect(first.limits.totalBytes).toBe(2_000_000); expect(first.evidence.every(row => /^[0-9a-f]{64}$/.test(row.sha256))).toBe(true);
    expect(first.rendering?.percentageRounding).toBe("floor");
    expect(first.runtime?.profileId).toBe("actual-test-runtime");
    expect(first.evidence.some(row => row.path.endsWith("source-project-export.ts"))).toBe(true);
    expect(first.evidence.some(row => row.path.endsWith("source-project-importer.ts"))).toBe(true);
    await verifyTargetProfile(workspace, first);
    const second = await inspectTarget(workspace, "UnityLookingName"); expect(second.id).toBe(first.id);
    write(dir, "UnityLookingName/settings/Common.json", '{"font":"ChangedFont"}');
    await expect(verifyTargetProfile(workspace, first)).rejects.toThrow("TARGET_PROFILE_STALE");
    expect((await inspectTarget(workspace, "UnityLookingName")).id).not.toBe(first.id);
  });

  it("returns candidate source projects instead of inferring platform from demo directories", async () => {
    const dir = temp(); await nativeProject(dir, "FGUI/UnityDemo", "Unity"); await nativeProject(dir, "FGUI/LayaDemo", "Layabox");
    const profile = await inspectTarget(new Workspace(dir), "FGUI");
    expect(profile.status).toBe("needs_selection"); expect(profile.project).toBeUndefined(); expect(profile.candidates).toHaveLength(2);
    expect(profile.checks.editorImport).toBe("not_verified");
  });

  it("rejects DTD/entity expansion, unsupported source version and unconfirmed control features", async () => {
    expect(() => parseNativeXml('<!DOCTYPE foo [<!ENTITY x "secret">]><component/>', "bad.xml")).toThrow("Unsafe");
    const dir = temp(); await nativeProject(dir, "target", "Layabox");
    write(dir, "target/Actual.fairy", '<projectDescription id="actualTarget" type="Layabox" version="future"/>');
    expect((await inspectTarget(new Workspace(dir), "target")).status).toBe("unsupported");
    const target = profile(); target.capabilities.confirmed = ["Component", "Image"];
    await skin(dir);
    await expect(exportFgui(parseScene(inventoryScene()), target, dir, path.join(dir, "out"), "job")).rejects.toThrow("TARGET_FEATURE_UNCONFIRMED");
  });
});
