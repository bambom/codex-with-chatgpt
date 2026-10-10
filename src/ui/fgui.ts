import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { Workspace } from "../workspace/manager.js";
import { type Scene, type SceneComponent, type SceneNode, type SceneViewport, type ComponentInstance, type SceneGear,
  type PropertyOverride, type ValidationIssue, COMPONENT_TYPES, TEXT_TYPES, PROPERTY_IDS, RELATION_PAIRS,
  isSafeRelativePath, parseScene, orderedNodes, propertyTarget, resolveScene, validateScene } from "./scene.js";
import { type TargetProfile, type TargetFeature, parseNativeXml, asArray } from "./target.js";
import { validateFontCoverage } from "./render.js";

export interface FguiResourceMapping {
  semanticId: string; kind: "image" | "font" | "component"; id: string; name: string; path: string;
  file: string; url: string; sha256?: string; bytes?: number; width?: number; height?: number;
  sourceFile?: string; originalSourceFile?: string; originalWidth?: number; originalHeight?: number;
  family?: string; originalFamily?: string; variantProvenance?: string;
}
export interface FguiStaticReport {
  status: "passed" | "failed"; errors: ValidationIssue[]; warnings: ValidationIssue[];
  files: number; totalBytes: number; resourceCount: number; componentCount: number;
  semanticCounts: Record<string, number>; checkedFiles: { path: string; bytes: number; sha256: string }[];
  editorImport: "not_verified"; runtimeInteraction: "not_verified";
}
export interface FguiExportReport {
  schemaVersion: 1; jobId: string; targetProfileId: string; projectFile: string; projectId: string;
  packageName: string; packageId: string; entryComponent: string; entryResourceId: string; entryUrl: string;
  resources: FguiResourceMapping[]; nodes: { componentId: string; nodeId: string; sourceObjectId: string; sourceTag: string; componentFile: string }[];
  declaredProperties: { componentId: string; target: string; propertyId: number }[];
  fontCoverage: { semanticId: string; sourceFile: string; family: string; sha256: string; checkedCodePoints: number; status: "passed" | "not_verified"; scope: string }[];
  validation: FguiStaticReport;
  notes: string[];
}

const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export const sourceObjectId = (componentId: string, nodeId: string): string => "n" + hash(componentId + "/" + nodeId).slice(0, 12);
const resourceId = (kind: string, key: string): string => kind[0] + hash(kind + "/" + key).slice(0, 12);
const safeBase = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "UI";
export const xmlAttribute = (value: string | number | boolean): string => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;").replaceAll("\r", "&#13;").replaceAll("\n", "&#10;").replaceAll("\t", "&#9;");
const element = (tag: string, attrs: Record<string, string | number | boolean | undefined>, children: string[] = []): string => {
  const fields = Object.entries(attrs).filter((row): row is [string, string | number | boolean] => row[1] !== undefined)
    .map(([name, value]) => ` ${name}="${xmlAttribute(value)}"`).join("");
  return children.length ? `<${tag}${fields}>${children.join("")}</${tag}>` : `<${tag}${fields}/>`;
};
const pair = (a: number, b: number): string => `${a},${b}`;
const fatal = (code: string, at: string, message: string): never => { throw new Error(`${code}: ${at}: ${message}`); };

async function inputBytes(workspace: Workspace, filename: string, max: number): Promise<Buffer> {
  if (!isSafeRelativePath(filename)) return fatal("INVALID_ASSET_PATH", filename, "Use a job-relative file path.");
  const handle = await fs.open(workspace.resolve(filename).abs, "r");
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > max) return fatal("ASSET_SIZE", filename, `File must be at most ${max} bytes.`);
    const bytes = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < bytes.length) { const part = await handle.read(bytes, length, bytes.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
    if (length > stat.size) return fatal("ASSET_CHANGED", filename, "Asset changed while reading; retry.");
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

/** Native image dependencies across the declared reusable components. A PNG
 * used only as referenceAssetId belongs in PSD/PNG delivery, not this package. */
export function nativeImageReferences(scene: Scene): Set<string> {
  const ids = new Set<string>();
  const add = (id: string | undefined) => { if (id) ids.add(id); };
  const instance = (value: ComponentInstance | undefined) => {
    if (!value) return;
    add(value.iconAssetId); add(value.selectedIconAssetId);
    for (const item of value.items ?? []) add(item.iconAssetId);
    for (const prop of value.properties ?? []) if (prop.property === "icon") add(String(prop.value));
  };
  for (const component of scene.components) for (const node of component.children) {
    if (node.type === "Image" || node.type === "Loader") add(node.assetId);
    for (const gear of node.gears ?? []) if (gear.kind === "icon") { Object.values(gear.values).forEach(add); add(gear.default); }
    instance(node.instance); for (const item of node.list?.items ?? []) instance(item);
  }
  return ids;
}

/** Text needed by every authored initial/hidden state, list option and override.
 * Future service data or arbitrary user input is intentionally not inferred. */
export function knownFontTexts(scene: Scene): Record<string, string[]> {
  const result = new Map(scene.fonts.map(font => [font.id, new Set<string>()]));
  const components = new Map(scene.components.map(component => [component.id, component]));
  const add = (node: SceneNode | undefined, text: string | undefined) => {
    if (node?.style?.fontId && text !== undefined) result.get(node.style.fontId)?.add(text);
  };
  const title = (component: SceneComponent | undefined) => component?.children.find(node => node.name === "title" && TEXT_TYPES.has(node.type));
  const instance = (component: SceneComponent | undefined, value: ComponentInstance | undefined) => {
    if (!component || !value) return;
    add(title(component), value.title); add(title(component), value.selectedTitle);
    for (const prop of value.properties ?? []) if (prop.property === "text") add(propertyTarget(component, prop.target, components), String(prop.value));
    if (component.semantic === "ComboBox") {
      const popup = components.get(component.extension!.comboBox!.dropdown);
      const list = popup?.children.find(node => node.type === "List" && node.name === "list")?.list;
      const itemTemplate = list ? components.get(list.defaultItem) : undefined;
      for (const item of value.items ?? []) { add(title(component), item.title); add(title(itemTemplate), item.title); }
    }
    if (component.semantic === "Slider" || component.semantic === "ProgressBar") {
      for (const valuePart of [value.min, value.max, value.value]) if (valuePart !== undefined) add(title(component), String(valuePart));
    }
  };
  for (const component of scene.components) {
    if (component.semantic === "Slider" || component.semantic === "ProgressBar") {
      const style = component.extension?.slider ?? component.extension?.progressBar;
      add(title(component), "0123456789" + ((style?.titleType ?? "percent") === "percent" ? "%" : style?.titleType === "valueAndmax" ? "/" : ""));
    }
    for (const node of component.children) {
      if (TEXT_TYPES.has(node.type)) {
        add(node, node.text); add(node, node.input?.prompt);
        for (const gear of node.gears ?? []) if (gear.kind === "text") { Object.values(gear.values).forEach(text => add(node, text)); add(node, gear.default); }
      }
      instance(node.componentId ? components.get(node.componentId) : undefined, node.instance);
      for (const item of node.list?.items ?? []) instance(components.get(item.componentId ?? node.list!.defaultItem), item);
    }
  }
  return Object.fromEntries([...result].map(([id, texts]) => [id, [...texts]]));
}

const featureSet = (scene: Scene, nativeImages: Set<string>): Set<TargetFeature> => {
  const features = new Set<TargetFeature>(["Component"]);
  if (scene.fonts.length) features.add("Font");
  for (const asset of scene.assets) if (nativeImages.has(asset.id) && (asset.fgui?.scale9grid ?? asset.scale9grid)) features.add("NineSlice");
  for (const component of scene.components) {
    features.add(component.semantic);
    if (component.controllers?.length) features.add("Controller");
    for (const node of component.children) {
      features.add(node.type);
      if (node.gears?.length) features.add("Gear");
      if (node.relations?.length) features.add("Relation");
    }
  }
  return features;
};

/** Writes a fresh source directory. XML, images and fonts are deterministic for
 * the same scene; no existing target files or importer code are ever changed.
 * Reports are returned, not written inside the import root (its total byte/file
 * limits include all files, even documentation and preview images).
 */
export async function exportFgui(input: Scene, profile: TargetProfile, inputDir: string, outDir: string, jobId: string): Promise<FguiExportReport> {
  const scene = parseScene(input);
  resolveScene(scene, profile.rendering); // Reject relation cycles and unsupported expanded geometry before any output.
  if (profile.status !== "ready" || !profile.project || profile.adapter !== "fairygui-source-5.0-v1" ||
    !["Layabox", "Unity"].includes(profile.project.type) || profile.project.version !== "5.0")
    return fatal("TARGET_RESEARCH_REQUIRED", profile.requestedPath, "Inspect/select the actual supported .fairy source project first.");
  const nativeImages = nativeImageReferences(scene);
  const required = [...featureSet(scene, nativeImages)];
  const missing = required.filter(feature => !profile.capabilities.confirmed.includes(feature));
  if (missing.length) return fatal("TARGET_FEATURE_UNCONFIRMED", profile.id, `Inspect actual source/samples for: ${missing.join(", ")}. Unsupported features cannot be flattened into images.`);
  const source = new Workspace(inputDir);
  try { const existing = await fs.readdir(outDir); if (existing.length) return fatal("OUTPUT_NOT_EMPTY", outDir, "Build into a new job output directory."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await fs.mkdir(outDir, { recursive: true });
  const namespace = `MagicGameStudio/ui-production/v1/${jobId}/${scene.id}`;
  const packageId = hash(namespace + "/package").slice(0, 8), projectId = hash(namespace + "/project").slice(0, 32);
  const packageName = `${safeBase(scene.id)}_${hash(jobId).slice(0, 8)}`, projectFile = `${packageName}.fairy`;
  const packageRoot = `assets/${packageName}`;
  const components = new Map(scene.components.map(component => [component.id, component]));
  const resources: FguiResourceMapping[] = [];
  const images = new Map<string, FguiResourceMapping>(), fonts = new Map<string, FguiResourceMapping>(), componentRefs = new Map<string, FguiResourceMapping>();
  const register = (kind: FguiResourceMapping["kind"], semanticId: string, filename: string, dir: string): FguiResourceMapping => {
    const id = resourceId(kind, semanticId), record: FguiResourceMapping = { semanticId, kind, id, name: filename, path: `/${dir}/`, file: `${packageRoot}/${dir}/${filename}`, url: `ui://${packageId}${id}` };
    resources.push(record); return record;
  };
  for (const asset of scene.assets) if (nativeImages.has(asset.id)) images.set(asset.id, register("image", asset.id, `${safeBase(asset.name ?? asset.id)}_${resourceId("image", asset.id)}.png`, "images"));
  for (const font of scene.fonts) fonts.set(font.id, register("font", font.id, `${safeBase(font.id)}_${resourceId("font", font.id)}${path.extname(font.fgui?.file ?? font.file).toLowerCase()}`, "fonts"));
  for (const component of scene.components) componentRefs.set(component.id, register("component", component.id, `${safeBase(component.name)}_${resourceId("component", component.id)}.xml`, "components"));
  const imageUrl = (id: string): string => images.get(id)?.url ?? fatal("ASSET_REFERENCE", id, "Asset is missing.");
  const componentUrl = (id: string): string => componentRefs.get(id)?.url ?? fatal("COMPONENT_REFERENCE", id, "Component is missing.");
  const write = async (filename: string, bytes: Uint8Array | string) => {
    if (!isSafeRelativePath(filename)) return fatal("OUTPUT_PATH", filename, "Invalid output path.");
    const destination = path.join(outDir, filename); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, bytes, { flag: "wx" });
  };
  const declarations = new Map<string, Map<string, PropertyOverride>>();
  for (const component of scene.components) declarations.set(component.id, new Map());
  const declare = (target: string, props: PropertyOverride[] = []) => {
    for (const property of props) declarations.get(target)!.set(`${property.target}:${property.property}`, property);
  };
  for (const component of scene.components) for (const node of component.children) {
    if (node.componentId) declare(node.componentId, node.instance?.properties);
    if (node.list) for (const item of node.list.items) declare(item.componentId ?? node.list.defaultItem, item.properties);
  }
  const properties = (values: PropertyOverride[] = []): string[] => values.map(value => element("property", { target: value.target,
    propertyId: PROPERTY_IDS[value.property], value: value.property === "icon" ? imageUrl(String(value.value)) : value.value }));
  const viewport = (value: SceneViewport): Record<string, string | undefined> => ({
    overflow: value.overflow && value.overflow !== "visible" ? value.overflow : undefined,
    scroll: value.overflow === "scroll" ? value.scroll ?? "vertical" : undefined,
    scrollBar: value.overflow === "scroll" ? value.scrollBar ?? "hidden" : undefined,
    scrollBarRes: value.verticalScrollBar || value.horizontalScrollBar ? [value.verticalScrollBar ? componentUrl(value.verticalScrollBar) : "", value.horizontalScrollBar ? componentUrl(value.horizontalScrollBar) : ""].join(",") : undefined,
    margin: value.margin ? [value.margin.top, value.margin.bottom, value.margin.left, value.margin.right].join(",") : undefined,
  });
  const gear = (value: SceneGear, node: SceneNode): string => {
    if (value.kind === "display") return element("gearDisplay", { controller: value.controller, pages: value.pages.join(",") });
    const format = (raw: string | number | [number, number]): string => {
      switch (value.kind) {
        case "xy": return (raw as number[]).join(",");
        case "size": return [...raw as number[], 1, 1].join(",");
        case "color": return `${raw},${node.style?.strokeColor ?? "#000000"}`;
        case "icon": return imageUrl(String(raw));
        default: return String(raw);
      }
    };
    const tag = ({ xy: "gearXY", size: "gearSize", color: "gearColor", text: "gearText", icon: "gearIcon", fontSize: "gearFontSize" } as const)[value.kind];
    return element(tag, { controller: value.controller, pages: Object.keys(value.values).join(","), values: Object.values(value.values).map(format).join("|"),
      default: value.default !== undefined ? format(value.default) : undefined });
  };
  const extension = (component: SceneComponent): string | undefined => {
    const ext = component.extension;
    switch (component.semantic) {
      case "Button": return element("Button", { mode: ext!.button!.mode,
        downEffect: ext!.button!.downEffect && ext!.button!.downEffect !== "none" ? ext!.button!.downEffect : undefined,
        downEffectValue: ext!.button!.downEffect && ext!.button!.downEffect !== "none" ? ext!.button!.downEffectValue ?? 0.8 : undefined });
      case "Slider": return element("Slider", { titleType: ext!.slider!.titleType ?? "percent", reverse: ext!.slider!.reverse,
        wholeNumbers: ext!.slider!.wholeNumbers, changeOnClick: ext!.slider!.changeOnClick });
      case "ProgressBar": return element("ProgressBar", { titleType: ext!.progressBar!.titleType ?? "percent", reverse: ext!.progressBar!.reverse });
      case "ScrollBar": return element("ScrollBar", { fixedGripSize: ext!.scrollBar!.fixedGripSize });
      case "ComboBox": return element("ComboBox", { dropdown: componentUrl(ext!.comboBox!.dropdown) });
      default: return undefined;
    }
  };
  const instanceXml = (component: SceneComponent, value: ComponentInstance): string[] => {
    const props = properties(value.properties);
    switch (component.semantic) {
      case "Button": props.unshift(element("Button", { checked: value.checked, title: value.title, selectedTitle: value.selectedTitle,
        titleColor: value.titleColor, titleFontSize: value.titleFontSize, icon: value.iconAssetId ? imageUrl(value.iconAssetId) : undefined,
        selectedIcon: value.selectedIconAssetId ? imageUrl(value.selectedIconAssetId) : undefined,
        controller: value.relatedController, page: value.relatedPageId })); break;
      case "Slider": case "ProgressBar": props.unshift(element(component.semantic, { min: value.min, max: value.max, value: value.value })); break;
      case "ScrollBar": props.unshift(element("ScrollBar", {})); break;
      case "ComboBox": props.unshift(element("ComboBox", { title: value.title, titleColor: value.titleColor,
        icon: value.iconAssetId ? imageUrl(value.iconAssetId) : undefined, visibleItemCount: value.visibleItemCount ?? 10, direction: value.direction ?? "auto" },
      (value.items ?? []).map(item => element("item", { title: item.title, value: item.value, icon: item.iconAssetId ? imageUrl(item.iconAssetId) : undefined })))); break;
    }
    return props;
  };
  const mappings: FguiExportReport["nodes"] = [];
  const nodeXml = (owner: SceneComponent, node: SceneNode): string => {
    const id = sourceObjectId(owner.id, node.id);
    const decorative = ["Image", "Text", "Loader"].includes(node.type);
    const attrs: Record<string, string | number | boolean | undefined> = { id, name: node.name, xy: pair(node.x, node.y), size: pair(node.width, node.height),
      ...(node.alpha !== undefined && node.alpha !== 1 ? { alpha: node.alpha } : {}), visible: node.visible === false ? false : undefined,
      touchable: node.touchable ?? (node.name === "grip" && (owner.semantic === "Slider" || owner.semantic === "ScrollBar") ? true : decorative ? false : undefined),
      group: node.groupId ? sourceObjectId(owner.id, node.groupId) : undefined };
    let tag: string; const children = (node.gears ?? []).map(value => gear(value, node));
    children.push(...(node.relations ?? []).map(relation => element("relation", { target: relation.target ? sourceObjectId(owner.id, relation.target) : "", sidePair: relation.sidePair,
      usePercent: relation.usePercent })));
    if (TEXT_TYPES.has(node.type)) {
      tag = node.type === "RichText" ? "richtext" : "text";
      const style = node.style!;
      Object.assign(attrs, { text: node.text, font: style.fontId ? fonts.get(style.fontId)!.url : style.fontFamily,
        fontSize: style.fontSize, color: style.color, align: style.align ?? "left", vAlign: style.vAlign ?? "top", autoSize: style.autoSize ?? "none",
        leading: style.leading, letterSpacing: style.letterSpacing, singleLine: style.singleLine, bold: style.bold, italic: style.italic,
        underline: style.underline, strike: style.strike, strokeColor: style.strokeColor, strokeSize: style.strokeSize,
        shadowColor: style.shadowColor, shadowOffset: style.shadowOffset?.join(","), ubb: node.ubb });
      if (node.type === "InputText") Object.assign(attrs, { input: true, ...node.input });
    } else if (node.type === "Image") {
      tag = "image"; const image = images.get(node.assetId!)!;
      Object.assign(attrs, { src: image.id, fileName: image.path.slice(1) + image.name });
    } else if (node.type === "Loader") {
      tag = "loader"; Object.assign(attrs, { url: node.assetId ? imageUrl(node.assetId) : "", fill: node.loader?.fill ?? "scale",
        align: node.loader?.align ?? "center", vAlign: node.loader?.vAlign ?? "middle", shrinkOnly: node.loader?.shrinkOnly });
    } else if (COMPONENT_TYPES.has(node.type)) {
      tag = "component"; const target = componentRefs.get(node.componentId!)!;
      Object.assign(attrs, { src: target.id, fileName: target.path.slice(1) + target.name,
        controller: node.instance?.controllers ? Object.entries(node.instance.controllers).flat().join(",") : undefined });
      children.push(...instanceXml(components.get(node.componentId!)!, node.instance ?? {}));
    } else if (node.type === "List") {
      tag = "list"; const list = node.list!;
      Object.assign(attrs, { ...viewport(list), layout: list.layout, defaultItem: componentUrl(list.defaultItem), autoItemSize: false,
        selectionMode: list.selectionMode ?? "single", lineGap: list.lineGap ?? 0, colGap: list.columnGap ?? 0, scrollItemToViewOnClick: false });
      children.push(...list.items.map(item => element("item", { name: item.name, url: componentUrl(item.componentId ?? list.defaultItem),
        title: item.title, selectedTitle: item.selectedTitle, icon: item.iconAssetId ? imageUrl(item.iconAssetId) : undefined,
        selectedIcon: item.selectedIconAssetId ? imageUrl(item.selectedIconAssetId) : undefined,
        controllers: item.controllers ? Object.entries(item.controllers).flat().join(",") : undefined }, properties(item.properties))));
    } else tag = "group";
    mappings.push({ componentId: owner.id, nodeId: node.id, sourceObjectId: id, sourceTag: tag, componentFile: componentRefs.get(owner.id)!.file });
    return element(tag, attrs, children);
  };

  for (const asset of scene.assets) {
    if (!nativeImages.has(asset.id)) continue;
    const texture = asset.fgui ?? asset;
    const bytes = await inputBytes(source, texture.file, 128 * 1024 * 1024);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes[25] !== 6)
      return fatal("REAL_RGBA_PNG_REQUIRED", texture.file, "Use PNG color type 6 (RGBA), never a flattened checkerboard or indexed substitute.");
    const options = { failOn: "error" as const, limitInputPixels: 64 * 1024 * 1024 };
    const metadata = await sharp(bytes, options).metadata();
    await sharp(bytes, options).raw().toBuffer(); // full decode, not only header inspection
    if (metadata.width !== texture.width || metadata.height !== texture.height || !metadata.hasAlpha || metadata.channels !== 4)
      return fatal("PNG_DIMENSIONS", texture.file, "Actual RGBA dimensions must match the declared source texture dimensions.");
    const record = images.get(asset.id)!;
    Object.assign(record, { width: texture.width, height: texture.height, bytes: bytes.length, sha256: hash(bytes),
      sourceFile: texture.file, originalSourceFile: asset.file, originalWidth: asset.width, originalHeight: asset.height,
      ...(asset.fgui ? { variantProvenance: asset.fgui.provenance } : {}) });
    await write(record.file, bytes);
  }
  const fontRequirements = knownFontTexts(scene), fontCoverage: FguiExportReport["fontCoverage"] = [];
  for (const font of scene.fonts) {
    const effective = { ...font, file: font.fgui?.file ?? font.file, family: font.fgui?.family ?? font.family };
    const bytes = await inputBytes(source, effective.file, 32 * 1024 * 1024);
    if (!bytes.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0])) && !["OTTO", "ttcf", "true"].includes(bytes.toString("ascii", 0, 4)))
      return fatal("FONT_SIGNATURE", effective.file, "Font is not a supported real SFNT font.");
    const record = fonts.get(font.id)!;
    Object.assign(record, { bytes: bytes.length, sha256: hash(bytes), sourceFile: effective.file, originalSourceFile: font.file,
      family: effective.family, originalFamily: font.family, ...(font.fgui ? { variantProvenance: font.fgui.provenance } : {}) });
    if (/\.(ttf|otf)$/i.test(effective.file)) {
      const coverage = await validateFontCoverage(source, effective, fontRequirements[font.id]);
      if (coverage.sha256 !== record.sha256) return fatal("ASSET_CHANGED", effective.file, "Font changed between source copying and glyph validation.");
      if (coverage.status !== "passed") return fatal("FGUI_FONT_GLYPH_MISSING", effective.file,
        `Native font lacks authored text/state glyphs: ${coverage.missing.map(value => value.codePoint).join(", ")}. Provide a complete font or an explicit subset containing every known state.`);
      fontCoverage.push({ semanticId: font.id, sourceFile: effective.file, family: effective.family, sha256: coverage.sha256,
        checkedCodePoints: coverage.checkedCodePoints, status: "passed", scope: "Known template text, hidden text gears, instance/property/list/ComboBox titles, input prompts and numeric control characters. Future input/service data is not verified." });
    } else fontCoverage.push({ semanticId: font.id, sourceFile: effective.file, family: effective.family, sha256: record.sha256!, checkedCodePoints: 0,
      status: "not_verified", scope: "Collection-font glyph coverage is not implemented; use a single-face TTF/OTF for verified source text." });
    await write(record.file, bytes);
    if (font.licenseFile) await write(`licenses/${record.id}_LICENSE.txt`, await inputBytes(source, font.licenseFile, 1024 * 1024));
  }
  for (const component of scene.components) {
    if (profile.limits.objects && component.children.length > profile.limits.objects)
      return fatal("TARGET_OBJECT_LIMIT", component.id, `Component has ${component.children.length} objects; importer limit ${profile.limits.objects}.`);
    const children: string[] = (component.controllers ?? []).map(controller => element("controller", { name: controller.name,
      pages: controller.pages.flatMap(page => [page.id, page.name]).join(","),
      selected: controller.pages.findIndex(page => page.id === controller.selectedPageId),
      homePageType: "specific", homePage: controller.selectedPageId, exported: controller.exported }));
    children.push(element("displayList", {}, orderedNodes(component).map(node => nodeXml(component, node))));
    const ext = extension(component); if (ext) children.push(ext);
    for (const property of declarations.get(component.id)!.values()) children.push(element("customProperty", { target: property.target, propertyId: PROPERTY_IDS[property.property], label: property.target }));
    const document = element("component", { size: pair(component.width, component.height),
      opaque: component.opaque ?? component.semantic !== "Component", ...viewport(component),
      extention: component.semantic !== "Component" ? component.semantic : undefined }, children) + "\n";
    const record = componentRefs.get(component.id)!; record.bytes = Buffer.byteLength(document); record.sha256 = hash(document); await write(record.file, document);
  }
  const resourceXml = resources.map(record => {
    const asset = record.kind === "image" ? scene.assets.find(asset => asset.id === record.semanticId) : undefined;
    const grid = asset?.fgui?.scale9grid ?? asset?.scale9grid;
    return element(record.kind, { id: record.id, name: record.name, path: record.path, exported: true,
      ...(grid ? { scale: "9grid", scale9grid: grid.join(",") } : {}) });
  });
  await write(`${packageRoot}/package.xml`, element("packageDescription", { id: packageId }, [element("resources", {}, resourceXml)]) + "\n");
  await write(projectFile, element("projectDescription", { id: projectId, type: profile.project.type, version: profile.project.version }) + "\n");
  // No inherited publish paths or unrelated target settings are copied. Every text
  // node already names its packaged font; source projects do not require settings.
  await fs.mkdir(path.join(outDir, "settings"), { recursive: true });
  const validation = await validateFguiSource(outDir, profile);
  const entry = componentRefs.get(scene.entry)!;
  const report: FguiExportReport = { schemaVersion: 1, jobId, targetProfileId: profile.id, projectFile, projectId, packageName, packageId,
    entryComponent: entry.file, entryResourceId: entry.id, entryUrl: entry.url, resources, nodes: mappings,
    declaredProperties: [...declarations].flatMap(([componentId, props]) => [...props.values()].map(prop => ({ componentId, target: prop.target, propertyId: PROPERTY_IDS[prop.property] }))),
    fontCoverage, validation, notes: ["Source XML is generated from the shared scene; ordinary text remains editable native Text/InputText.",
      "Only static validation ran here. Editor import/save/reopen and runtime interactions require the actual configured native validator.",
      "PNG assets referenced only by PSD text-reference layers are retained by the full delivery and omitted from the native source package.",
      ...(scene.assets.some(asset => asset.fgui) || scene.fonts.some(font => font.fgui) ? ["Explicit FGUI texture/font variants retain the same scene coordinates. Their byte/dimension/glyph checks do not certify visual equivalence; compare an actual native render against the original PNG/PSD."] : []),
      ...validateScene(scene).warnings.map(row => row.message)] };
  if (validation.status !== "passed") return fatal("FGUI_STATIC_FAILED", outDir, validation.errors.map(issue => `${issue.code}: ${issue.message}`).join("; "));
  return report;
}

type Xml = Record<string, any>;
type Resource = { id: string; kind: string; packageId: string; file: string; packageRoot: string; source: Xml };
type Component = { resource: Resource; root: Xml; nodes: { tag: string; value: Xml }[]; controllers: Map<string, Xml> };
const attrsOf = (xml: Xml): string[] => Object.keys(xml).filter(key => key.startsWith("@_")).map(key => key.slice(2));
const childrenOf = (xml: Xml): { tag: string; value: Xml }[] => Object.entries(xml)
  .filter(([key]) => !key.startsWith("@_") && key !== "#text" && key !== "?xml")
  .flatMap(([tag, value]) => asArray<Xml>(value).map(value => ({ tag, value: typeof value === "object" && value ? value : {} })));
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const BOOL_PATTERN = /^(true|false)$/;
const INT_PAIR = /^-?\d+,-?\d+$/;
const SIZE_PAIR = /^\d+,\d+$/;

/** Re-read the actual files on disk and verify the source graph, source values,
 * reference scopes and every measured importer limit. This remains a static
 * source check; it deliberately cannot emit an editor/runtime pass.
 */
export async function validateFguiSource(outDir: string, profile: TargetProfile): Promise<FguiStaticReport> {
  const errors: ValidationIssue[] = [], warnings: ValidationIssue[] = [];
  const error = (code: string, at: string, message: string) => errors.push({ code, path: at, message });
  const files = new Map<string, Buffer>(), folded = new Set<string>();
  const checkedFiles: FguiStaticReport["checkedFiles"] = []; let totalBytes = 0;
  const walk = async (relative: string) => {
    const entries = await fs.readdir(path.join(outDir, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { error("SOURCE_SYMLINK", filename, "Source bundle cannot contain symlinks."); continue; }
      if (!isSafeRelativePath(filename)) { error("SOURCE_PATH", filename, "Unsafe source path."); continue; }
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile()) {
        if (folded.has(filename.toLowerCase())) error("SOURCE_PATH_COLLISION", filename, "Case-insensitive source path collision.");
        folded.add(filename.toLowerCase());
        const size = (await fs.stat(path.join(outDir, filename))).size;
        if (size > 128 * 1024 * 1024 || files.size >= 5000 || totalBytes + size > 512 * 1024 * 1024) throw new Error("SOURCE_WORKFLOW_CAPACITY_LIMIT");
        const bytes = await fs.readFile(path.join(outDir, filename)); files.set(filename, bytes); totalBytes += bytes.length;
        checkedFiles.push({ path: filename, bytes: bytes.length, sha256: hash(bytes) });
      }
    }
  };
  try { await walk(""); } catch (reason) { error("SOURCE_READ", outDir, String(reason)); }
  const limits = profile.limits;
  if (limits.files !== undefined && files.size > limits.files) error("TARGET_FILE_LIMIT", "project", `${files.size} files exceed target limit ${limits.files}. All files under the selected root count.`);
  if (limits.totalBytes !== undefined && totalBytes > limits.totalBytes) error("TARGET_TOTAL_BYTES", "project", `${totalBytes} bytes exceed target limit ${limits.totalBytes}.`);
  for (const [filename, bytes] of files) {
    if (limits.fileBytes !== undefined && bytes.length > limits.fileBytes) error("TARGET_FILE_BYTES", filename, `${bytes.length} bytes exceed per-file limit ${limits.fileBytes}.`);
    if (/\.(xml|fairy)$/.test(filename) && limits.xmlBytes !== undefined && bytes.length > limits.xmlBytes) error("TARGET_XML_BYTES", filename, `XML exceeds ${limits.xmlBytes} bytes.`);
  }
  const allowedAttrs = (xml: Xml, allowed: readonly string[], at: string) => {
    for (const attr of attrsOf(xml)) if (!allowed.includes(attr)) error("SOURCE_ATTRIBUTE", at, `Unsupported source attribute '${attr}'.`);
  };
  const xmlFile = (filename: string): Xml | undefined => {
    const bytes = files.get(filename); if (!bytes) { error("SOURCE_FILE_MISSING", filename, "Registered source file is missing."); return undefined; }
    try {
      const parsed = parseNativeXml(new TextDecoder("utf-8", { fatal: true }).decode(bytes), filename);
      const depth = (node: Xml, level: number) => {
        if (limits.xmlDepth !== undefined && level > limits.xmlDepth) { error("TARGET_XML_DEPTH", filename, `XML depth exceeds ${limits.xmlDepth}.`); return; }
        if (node["#text"] && String(node["#text"]).trim()) error("SOURCE_XML_TEXT", filename, "Source metadata uses attributes, not element text content.");
        for (const child of childrenOf(node)) depth(child.value, level + 1);
      };
      for (const child of childrenOf(parsed)) depth(child.value, 1);
      return parsed;
    } catch (reason) { error("SOURCE_XML_SYNTAX", filename, String(reason)); return undefined; }
  };
  const projects = [...files.keys()].filter(filename => filename.endsWith(".fairy"));
  if (projects.length !== 1 || projects[0]?.includes("/")) error("SOURCE_PROJECT_COUNT", "project", "Require exactly one top-level .fairy source descriptor.");
  if (projects.length === 1) {
    const parsed = xmlFile(projects[0]); const project = parsed?.projectDescription;
    if (!project || typeof project !== "object" || childrenOf(parsed!).length !== 1 || childrenOf(project).length)
      error("SOURCE_PROJECT_DESCRIPTION", projects[0], "Require an empty projectDescription root.");
    else {
      allowedAttrs(project, ["id", "type", "version"], projects[0]);
      if (!ID_PATTERN.test(project["@_id"] ?? "")) error("SOURCE_PROJECT_ID", projects[0], "Invalid project ID.");
      if (project["@_type"] !== profile.project?.type || project["@_version"] !== profile.project?.version)
        error("SOURCE_TARGET_VERSION", projects[0], "Platform/version differs from the actual inspected .fairy descriptor.");
    }
  }
  const resources = new Map<string, Resource>(), packages = new Map<string, string>(), registeredPaths = new Set<string>();
  for (const filename of [...files.keys()].filter(filename => /^assets\/[^/]+\/package\.xml$/.test(filename))) {
    const parsed = xmlFile(filename); const root = parsed?.packageDescription;
    if (!root || typeof root !== "object" || childrenOf(parsed!).length !== 1) { error("PACKAGE_DESCRIPTION", filename, "Missing packageDescription root."); continue; }
    allowedAttrs(root, ["id"], filename);
    if (childrenOf(root).length !== 1 || !Object.hasOwn(root, "resources")) error("PACKAGE_RESOURCES", filename, "Require exactly one resources child.");
    const pkg = root["@_id"] as string;
    if (typeof pkg !== "string" || pkg.length !== 8 || !ID_PATTERN.test(pkg)) { error("PACKAGE_ID", filename, "Package ID must be eight source-safe characters."); continue; }
    if (packages.has(pkg)) error("DUPLICATE_PACKAGE_ID", filename, "Duplicate package ID."); packages.set(pkg, filename);
    const base = filename.slice(0, -"/package.xml".length);
    for (const { tag, value } of childrenOf(root.resources || {})) {
      if (!["image", "font", "component"].includes(tag)) { error("RESOURCE_KIND", filename, `Unsupported resource kind '${tag}'.`); continue; }
      allowedAttrs(value, ["id", "name", "path", "exported", ...(tag === "image" ? ["scale", "scale9grid"] : [])], filename);
      if (childrenOf(value).length) error("RESOURCE_CHILD", filename, "Resource registrations cannot contain nested data.");
      const id = value["@_id"], name = value["@_name"], sub = value["@_path"];
      if (typeof id !== "string" || !ID_PATTERN.test(id) || typeof name !== "string" || /[\\/]/.test(name) || typeof sub !== "string" || !sub.startsWith("/") || !sub.endsWith("/")) {
        error("RESOURCE_REGISTRATION", filename, "Invalid resource ID, filename or package-local path."); continue;
      }
      const file = base + sub + name;
      if (!isSafeRelativePath(file)) { error("RESOURCE_PATH", filename, "Unsafe registered path."); continue; }
      if (tag === "image" && !name.endsWith(".png") || tag === "component" && !name.endsWith(".xml") || tag === "font" && !/\.(ttf|otf|ttc)$/.test(name)) error("RESOURCE_EXTENSION", file, "Resource filename extension does not match its type.");
      if (resources.has(pkg + ":" + id)) error("DUPLICATE_RESOURCE_ID", filename, `Duplicate package-local resource ${id}.`);
      if (registeredPaths.has(file.toLowerCase())) error("DUPLICATE_RESOURCE_PATH", file, "Registered file path is reused.");
      registeredPaths.add(file.toLowerCase());
      const resource: Resource = { id, kind: tag, packageId: pkg, file, packageRoot: base, source: value }; resources.set(pkg + ":" + id, resource);
      if (!files.has(file)) error("RESOURCE_MISSING", file, "Registered resource file is missing.");
      if (value["@_exported"] !== undefined && !BOOL_PATTERN.test(value["@_exported"])) error("RESOURCE_EXPORTED", file, "exported must be true/false.");
      if (tag === "image" && files.has(file)) {
        const bytes = files.get(file)!;
        try {
          if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes[25] !== 6) throw new Error("Expected actual RGBA PNG.");
          const metadata = await sharp(bytes, { failOn: "error", limitInputPixels: 64 * 1024 * 1024 }).metadata();
          await sharp(bytes, { failOn: "error", limitInputPixels: 64 * 1024 * 1024 }).raw().toBuffer();
          if (value["@_scale"] || value["@_scale9grid"]) {
            const grid = String(value["@_scale9grid"] ?? "").split(",").map(Number);
            if (value["@_scale"] !== "9grid" || grid.length !== 4 || grid.some(n => !Number.isInteger(n)) || grid[0] < 0 || grid[1] < 0 || grid[2] <= 0 || grid[3] <= 0 || grid[0] + grid[2] > metadata.width! || grid[1] + grid[3] > metadata.height!)
              error("SCALE9_CENTER_RECT", file, "scale9grid must describe the center x,y,width,height inside the real PNG.");
          }
        } catch (reason) { error("PNG_DECODE", file, String(reason)); }
      }
    }
  }
  if (!packages.size) error("NO_PACKAGE", "assets", "No native resource package found.");
  const resolveUrl = (value: string, at: string, kind?: string): Resource | undefined => {
    const match = /^ui:\/\/([A-Za-z0-9_-]{8})([A-Za-z0-9_-]{1,128})$/.exec(value);
    const resource = match ? resources.get(match[1] + ":" + match[2]) : undefined;
    if (!resource || kind && resource.kind !== kind) error("RESOURCE_URL", at, `Unresolved ${kind ?? "resource"} URL '${value}'.`);
    return resource;
  };
  const referenced = (node: Xml, owner: Resource, at: string, kind?: string): Resource | undefined => {
    const key = `${node["@_pkg"] ?? owner.packageId}:${node["@_src"] ?? ""}`; const target = resources.get(key);
    if (!target || kind && target.kind !== kind) error("RESOURCE_SRC", at, `Unresolved ${kind ?? "resource"} src '${key}'.`);
    if (target) {
      const fileName = target.source["@_path"].slice(1) + target.source["@_name"];
      if (node["@_fileName"] !== fileName) error("RESOURCE_FILENAME", at, "fileName must equal the registered package-local resource path.");
    }
    return target;
  };
  const components = new Map<string, Component>(), dependencies = new Map<string, Set<string>>(), semanticCounts: Record<string, number> = {};
  const keyOf = (resource: Resource): string => resource.packageId + ":" + resource.id;
  for (const resource of resources.values()) if (resource.kind === "component") {
    const parsed = xmlFile(resource.file), root = parsed?.component;
    if (!root || typeof root !== "object") { error("COMPONENT_ROOT", resource.file, "Missing component root."); continue; }
    allowedAttrs(root, ["size", "opaque", "extention", "overflow", "scroll", "scrollBar", "scrollBarRes", "margin"], resource.file);
    if (!SIZE_PAIR.test(root["@_size"] ?? "") || String(root["@_size"]).split(",").some(n => Number(n) <= 0)) error("COMPONENT_SIZE", resource.file, "Component size must use positive integer pixels.");
    const extension = root["@_extention"];
    if (extension && !["Button", "Slider", "ProgressBar", "ScrollBar", "ComboBox"].includes(extension)) error("COMPONENT_EXTENSION", resource.file, "Unsupported extention semantic.");
    const children = childrenOf(root); const extensions = children.filter(child => ["Button", "Slider", "ProgressBar", "ScrollBar", "ComboBox"].includes(child.tag));
    if (extension ? extensions.length !== 1 || extensions[0].tag !== extension : extensions.length) error("COMPONENT_EXTENSION_OWNER", resource.file, "Definition extension must match the root extention attribute.");
    for (const child of children) if (!["displayList", "controller", "customProperty", ...["Button", "Slider", "ProgressBar", "ScrollBar", "ComboBox"]].includes(child.tag)) error("COMPONENT_CHILD", resource.file, `Unsupported component child '${child.tag}'.`);
    const controllers = new Map<string, Xml>();
    for (const controller of asArray<Xml>(root.controller)) {
      allowedAttrs(controller, ["name", "pages", "selected", "homePageType", "homePage", "exported"], resource.file);
      const name = controller["@_name"], pages = String(controller["@_pages"] ?? "").split(","), ids = pages.filter((_, index) => index % 2 === 0);
      if (!name || controllers.has(name) || pages.length % 2 || new Set(ids).size !== ids.length) error("CONTROLLER_IDENTITY", resource.file, "Controller names/page IDs must be unique and page IDs/names paired.");
      if (!Number.isInteger(Number(controller["@_selected"])) || Number(controller["@_selected"]) < 0 || Number(controller["@_selected"]) >= ids.length) error("CONTROLLER_SELECTED", resource.file, "Selected page index is invalid.");
      if (controller["@_homePageType"] === "specific" && !ids.includes(controller["@_homePage"])) error("CONTROLLER_HOME", resource.file, "Runtime home page ID is missing.");
      controllers.set(name, controller);
    }
    const nodes = childrenOf(root.displayList || {}); const ids = new Set<string>(); const names = new Set<string>();
    if (limits.objects !== undefined && nodes.length > limits.objects) error("TARGET_OBJECT_LIMIT", resource.file, `${nodes.length} objects exceed ${limits.objects}.`);
    for (const node of nodes) {
      const id = node.value["@_id"], name = node.value["@_name"];
      if (!ID_PATTERN.test(id ?? "") || ids.has(id)) error("OBJECT_ID", resource.file, "Object IDs must be unique within their displayList.");
      if (typeof name !== "string" || names.has(name)) error("OBJECT_NAME", resource.file, "Object names must be present and unique within their component.");
      ids.add(id); names.add(name);
    }
    const component = { resource, root, nodes, controllers }; components.set(keyOf(resource), component); dependencies.set(keyOf(resource), new Set());
  }
  const addDependency = (owner: Component, ref?: Resource) => { if (ref?.kind === "component") dependencies.get(keyOf(owner.resource))!.add(keyOf(ref)); };
  const pageExists = (controller: Xml | undefined, page: string): boolean => !!controller && String(controller["@_pages"] ?? "").split(",").some((value, index) => index % 2 === 0 && value === page);
  const targetNode = (owner: Component | undefined, target: string, depth = 0): { tag: string; value: Xml } | undefined => {
    if (!owner || depth > 32) return undefined;
    const [name, ...rest] = target.split("."); const node = owner.nodes.find(node => node.value["@_name"] === name);
    if (!node || !rest.length) return node;
    const resource = resources.get(`${node.value["@_pkg"] ?? owner.resource.packageId}:${node.value["@_src"]}`);
    return resource ? targetNode(components.get(keyOf(resource)), rest.join("."), depth + 1) : undefined;
  };
  const controlAttrs: Record<string, string[]> = {
    Button: ["mode", "downEffect", "downEffectValue"], Slider: ["titleType", "reverse", "wholeNumbers", "changeOnClick"],
    ProgressBar: ["titleType", "reverse"], ScrollBar: ["fixedGripSize"], ComboBox: ["dropdown"],
  };
  const instanceAttrs: Record<string, string[]> = {
    Button: ["checked", "title", "selectedTitle", "titleColor", "titleFontSize", "icon", "selectedIcon", "controller", "page"],
    Slider: ["min", "max", "value"], ProgressBar: ["min", "max", "value"], ScrollBar: [],
    ComboBox: ["title", "titleColor", "icon", "visibleItemCount", "direction"],
  };
  const geometry = ["id", "name", "xy", "size", "alpha", "visible", "touchable", "group"];
  const nodeAttrs: Record<string, string[]> = {
    image: [...geometry, "src", "pkg", "fileName"], loader: [...geometry, "url", "fill", "align", "vAlign", "shrinkOnly"],
    text: [...geometry, "text", "font", "fontSize", "color", "align", "vAlign", "autoSize", "leading", "letterSpacing", "singleLine", "bold", "italic", "underline", "strike", "strokeColor", "strokeSize", "shadowColor", "shadowOffset", "ubb", "input", "prompt", "restrict", "maxLength", "password", "keyboardType"],
    component: [...geometry, "src", "pkg", "fileName", "controller"],
    list: [...geometry, "layout", "defaultItem", "autoItemSize", "selectionMode", "lineGap", "colGap", "scrollItemToViewOnClick", "overflow", "scroll", "scrollBar", "scrollBarRes", "margin"], group: geometry,
  };
  const propertyChecks = (props: Xml[], template: Component | undefined, at: string) => {
    for (const property of props) {
      allowedAttrs(property, ["target", "propertyId", "value"], at);
      const target = property["@_target"], pid = property["@_propertyId"];
      if (!template || !targetNode(template, target ?? "")) error("PROPERTY_TARGET", at, `Missing property target '${target}'.`);
      if (!asArray<Xml>(template?.root.customProperty).some(def => def["@_target"] === target && def["@_propertyId"] === pid)) error("PROPERTY_DECLARATION", at, "Instance/list property must be declared on its template owner.");
      if (pid === "1") resolveUrl(property["@_value"], at, "image");
    }
  };
  for (const component of components.values()) {
    const at = component.resource.file, extension = component.root["@_extention"];
    for (const ext of childrenOf(component.root).filter(child => Object.hasOwn(controlAttrs, child.tag))) {
      allowedAttrs(ext.value, controlAttrs[ext.tag], at);
      if (ext.tag === "ComboBox") {
        const dropdown = resolveUrl(ext.value["@_dropdown"], at, "component"); addDependency(component, dropdown);
        const popup = dropdown ? components.get(keyOf(dropdown)) : undefined;
        if (!popup?.nodes.some(node => node.tag === "list" && node.value["@_name"] === "list")) error("COMBO_POPUP_LIST", at, "ComboBox popup must have a real list object named list.");
      }
    }
    if (extension === "Slider" || extension === "ProgressBar") {
      const bars = component.nodes.filter(node => ["bar", "bar_v"].includes(node.value["@_name"]));
      if (bars.length !== 1) error("NATIVE_BAR_PART", at, "Native bar control requires a full-range bar/bar_v part.");
      if (extension === "Slider" && !component.nodes.some(node => node.value["@_name"] === "grip")) error("NATIVE_GRIP_PART", at, "Slider requires grip.");
    }
    if (extension === "ScrollBar" && !["bar", "grip"].every(name => component.nodes.some(node => node.value["@_name"] === name))) error("NATIVE_SCROLLBAR_PARTS", at, "Scrollbar requires bar and grip.");
    const scrollRefs = String(component.root["@_scrollBarRes"] ?? "").split(",").filter(Boolean);
    for (const ref of scrollRefs) addDependency(component, resolveUrl(ref, at, "component"));
    for (const definition of asArray<Xml>(component.root.customProperty)) {
      allowedAttrs(definition, ["target", "propertyId", "label"], at);
      if (!targetNode(component, definition["@_target"] ?? "") || !["0", "1", "2", "8"].includes(definition["@_propertyId"])) error("CUSTOM_PROPERTY", at, "Custom property declaration target/type is invalid.");
    }
    for (const { tag, value: node } of component.nodes) {
      const nodeAt = `${at}#${node["@_id"]}`; const kind = tag === "richtext" ? "text" : tag;
      if (!nodeAttrs[kind]) { error("SOURCE_NODE_TAG", nodeAt, `Unknown native source tag '${tag}'.`); continue; }
      allowedAttrs(node, nodeAttrs[kind], nodeAt);
      if (!INT_PAIR.test(node["@_xy"] ?? "") || !SIZE_PAIR.test(node["@_size"] ?? "")) error("NODE_GEOMETRY", nodeAt, "xy/size use integer pixel pairs.");
      if (node["@_alpha"] !== undefined && (!Number.isFinite(Number(node["@_alpha"])) || Number(node["@_alpha"]) < 0 || Number(node["@_alpha"]) > 1)) error("NODE_ALPHA", nodeAt, "alpha must be in 0–1.");
      for (const attr of ["visible", "touchable"]) if (node[`@_${attr}`] !== undefined && !BOOL_PATTERN.test(node[`@_${attr}`])) error("NODE_BOOLEAN", nodeAt, `${attr} must be true/false.`);
      if (node["@_group"] && !component.nodes.some(other => other.tag === "group" && other.value["@_id"] === node["@_group"])) error("GROUP_TARGET", nodeAt, "group must reference a sibling Group ID.");
      let target: Resource | undefined;
      if (kind === "image" || kind === "component") { target = referenced(node, component.resource, nodeAt, kind); addDependency(component, target); }
      if (kind === "loader" && node["@_url"]) resolveUrl(node["@_url"], nodeAt, "image");
      if (kind === "text" && String(node["@_font"] ?? "").startsWith("ui://")) resolveUrl(node["@_font"], nodeAt, "font");
      const semantic = kind === "component" ? components.get(target ? keyOf(target) : "")?.root["@_extention"] ?? "Component" : kind === "text" && node["@_input"] === "true" ? "InputText" : tag;
      semanticCounts[semantic] = (semanticCounts[semantic] ?? 0) + 1;
      const targetComponent = target ? components.get(keyOf(target)) : undefined;
      if (kind === "component" && node["@_controller"] !== undefined) {
        const pairs = String(node["@_controller"]).split(","); if (pairs.length % 2) error("INSTANCE_CONTROLLERS", nodeAt, "Controller/page pairs are malformed.");
        for (let index = 0; index < pairs.length; index += 2) if (!pageExists(targetComponent?.controllers.get(pairs[index]), pairs[index + 1])) error("INSTANCE_CONTROLLER_PAGE", nodeAt, "Instance controller/page is missing.");
      }
      for (const child of childrenOf(node)) {
        if (child.tag === "relation") {
          allowedAttrs(child.value, ["target", "sidePair", "usePercent"], nodeAt);
          const relTarget = child.value["@_target"];
          if (typeof relTarget !== "string" || relTarget && !component.nodes.some(other => other.value["@_id"] === relTarget)) error("RELATION_TARGET", nodeAt, "Relation target is unresolved.");
          if (!String(child.value["@_sidePair"] ?? "").split(",").every(pair => RELATION_PAIRS.has(pair))) error("RELATION_PAIR", nodeAt, "Invalid sidePair.");
        } else if (/^gear/.test(child.tag)) {
          if (!["gearDisplay", "gearXY", "gearSize", "gearColor", "gearText", "gearIcon", "gearFontSize"].includes(child.tag)) error("GEAR_TAG", nodeAt, "Unsupported gear tag.");
          allowedAttrs(child.value, ["controller", "pages", "values", "default"], nodeAt);
          const controller = component.controllers.get(child.value["@_controller"]), pages = String(child.value["@_pages"] ?? "").split(",").filter(Boolean);
          if (!controller || pages.some(page => !pageExists(controller, page))) error("GEAR_CONTROLLER_PAGE", nodeAt, "Unresolved gear controller/page.");
          if (child.tag !== "gearDisplay" && String(child.value["@_values"] ?? "").split("|").length !== pages.length) error("GEAR_VALUE_COUNT", nodeAt, "Gear values must correspond to their page IDs.");
          if (child.tag === "gearIcon") for (const url of [...String(child.value["@_values"] ?? "").split("|"), child.value["@_default"]].filter(Boolean)) resolveUrl(url, nodeAt, "image");
        } else if (kind === "component" && child.tag === "property") propertyChecks([child.value], targetComponent, nodeAt);
        else if (kind === "component" && Object.hasOwn(instanceAttrs, child.tag)) {
          if (child.tag !== targetComponent?.root["@_extention"]) error("CONTROL_INSTANCE_OWNER", nodeAt, "Control instance extension differs from its template.");
          allowedAttrs(child.value, instanceAttrs[child.tag], nodeAt);
          if (child.tag === "Button" && child.value["@_controller"] && !pageExists(component.controllers.get(child.value["@_controller"]), child.value["@_page"])) error("BUTTON_CONTROLLER_PAGE", nodeAt, "Button related parent controller/page is unresolved.");
          if (["Slider", "ProgressBar"].includes(child.tag)) {
            const nums = ["min", "max", "value"].map(key => Number(child.value[`@_${key}`]));
            if (!nums.every(Number.isInteger) || nums[0] >= nums[1] || nums[2] < nums[0] || nums[2] > nums[1] || nums[1] === 0) error("CONTROL_RANGE", nodeAt, "Invalid native instance min/max/value.");
          }
          for (const attr of ["icon", "selectedIcon"]) if (child.value[`@_${attr}`]) resolveUrl(child.value[`@_${attr}`], nodeAt, "image");
          if (child.tag === "ComboBox") for (const item of asArray<Xml>(child.value.item)) {
            allowedAttrs(item, ["title", "value", "icon"], nodeAt); if (item["@_icon"]) resolveUrl(item["@_icon"], nodeAt, "image");
          }
        } else if (!(kind === "list" && child.tag === "item")) error("SOURCE_NODE_CHILD", nodeAt, `Unexpected native child '${child.tag}'.`);
      }
      if (kind === "list") {
        const def = resolveUrl(node["@_defaultItem"], nodeAt, "component"); addDependency(component, def);
        for (const url of String(node["@_scrollBarRes"] ?? "").split(",").filter(Boolean)) addDependency(component, resolveUrl(url, nodeAt, "component"));
        for (const item of asArray<Xml>(node.item)) {
          allowedAttrs(item, ["name", "url", "title", "selectedTitle", "icon", "selectedIcon", "controllers"], nodeAt);
          const target = item["@_url"] ? resolveUrl(item["@_url"], nodeAt, "component") : def; addDependency(component, target);
          const template = target ? components.get(keyOf(target)) : undefined;
          propertyChecks(asArray<Xml>(item.property), template, nodeAt);
          if (item["@_controllers"]) {
            const pairs = item["@_controllers"].split(",");
            if (pairs.length % 2) error("LIST_ITEM_CONTROLLERS", nodeAt, "List item controllers must be name/page pairs.");
            for (let index = 0; index < pairs.length; index += 2) if (!pageExists(template?.controllers.get(pairs[index]), pairs[index + 1])) error("LIST_ITEM_CONTROLLER_PAGE", nodeAt, "List item controller/page is unresolved.");
          }
          for (const attr of ["icon", "selectedIcon"]) if (item[`@_${attr}`]) resolveUrl(item[`@_${attr}`], nodeAt, "image");
        }
      }
    }
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (key: string, depth: number) => {
    if (depth > 32) { error("COMPONENT_DEPTH", key, "Nested component dependency exceeds 32."); return; }
    if (visiting.has(key)) { error("COMPONENT_CYCLE", key, "Component/list/popup/scrollbar reference cycle."); return; }
    if (visited.has(key)) return; visiting.add(key);
    for (const dependency of dependencies.get(key) ?? []) visit(dependency, depth + 1);
    visiting.delete(key); visited.add(key);
  };
  for (const key of components.keys()) visit(key, 0);
  if (!profile.evidence.some(row => row.kind === "source")) warnings.push({ code: "IMPORTER_LIMITS_UNCONFIRMED", path: "target", message: "No custom importer source was inspected. Extra target restrictions require actual native validation." });
  return { status: errors.length ? "failed" : "passed", errors, warnings, files: files.size, totalBytes, resourceCount: resources.size,
    componentCount: components.size, semanticCounts, checkedFiles, editorImport: "not_verified", runtimeInteraction: "not_verified" };
}
