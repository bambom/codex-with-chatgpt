import { z } from "zod";

/** Versioned, JSON-only authoring data shared by the PSD and native-source exporters.
 * Components own coordinates; Groups only refer to siblings and never own them.
 * Images are assets. Buttons, inputs and lists remain native semantic objects.
 */
export type ComponentSemantic = "Component" | "Button" | "Slider" | "ProgressBar" | "ScrollBar" | "ComboBox";
export type NodeType = ComponentSemantic | "Image" | "Loader" | "Text" | "RichText" | "InputText" | "List" | "Group";
export interface Rect { x: number; y: number; width: number; height: number }
export interface SceneAsset {
  id: string; name?: string; file: string; width: number; height: number;
  scale9grid?: [number, number, number, number];
  originalWidth?: number; originalHeight?: number; cropOffset?: [number, number];
  provenance?: string;
  /** Explicit compact source texture; PSD keeps the original file/dimensions. */
  fgui?: { file: string; width: number; height: number; scale9grid?: [number, number, number, number]; provenance: string };
}
export interface SceneFont { id: string; file: string; family: string; licenseFile?: string;
  fgui?: { file: string; family: string; provenance: string } }
export interface TextStyle {
  fontId?: string; fontFamily?: string; fontSize: number; color: string;
  align?: "left" | "center" | "right"; vAlign?: "top" | "middle" | "bottom";
  leading?: number; letterSpacing?: number; bold?: boolean; italic?: boolean;
  underline?: boolean; strike?: boolean; singleLine?: boolean;
  autoSize?: "none" | "both" | "height" | "shrink" | "ellipsis";
  strokeColor?: string; strokeSize?: number; shadowColor?: string; shadowOffset?: [number, number];
}
export interface SceneController {
  name: string; pages: { id: string; name: string }[]; selectedPageId: string; exported?: boolean;
}
export type SceneGear =
  | { kind: "display"; controller: string; pages: string[] }
  | { kind: "xy"; controller: string; values: Record<string, [number, number]>; default?: [number, number] }
  | { kind: "size"; controller: string; values: Record<string, [number, number]>; default?: [number, number] }
  | { kind: "color"; controller: string; values: Record<string, string>; default?: string }
  | { kind: "text"; controller: string; values: Record<string, string>; default?: string }
  | { kind: "icon"; controller: string; values: Record<string, string>; default?: string }
  | { kind: "fontSize"; controller: string; values: Record<string, number>; default?: number };
export interface SceneRelation { target: string; sidePair: string; usePercent?: boolean }
export type PropertyName = "text" | "icon" | "color" | "fontSize";
export interface PropertyOverride { target: string; property: PropertyName; value: string | number }
export interface ComponentInstance {
  controllers?: Record<string, string>; properties?: PropertyOverride[];
  title?: string; selectedTitle?: string; iconAssetId?: string; selectedIconAssetId?: string;
  checked?: boolean; titleColor?: string; titleFontSize?: number;
  relatedController?: string; relatedPageId?: string;
  value?: number; min?: number; max?: number;
  items?: { title: string; value: string; iconAssetId?: string }[];
  visibleItemCount?: number; direction?: "auto" | "up" | "down";
}
export interface SceneViewport {
  overflow?: "visible" | "hidden" | "scroll";
  scroll?: "vertical" | "horizontal";
  scrollBar?: "hidden" | "visible" | "auto";
  verticalScrollBar?: string; horizontalScrollBar?: string;
  margin?: { top: number; bottom: number; left: number; right: number };
}
export interface SceneList extends SceneViewport {
  layout: "column" | "row"; defaultItem: string; lineGap?: number; columnGap?: number;
  selectionMode?: "single" | "multiple" | "multipleSingleClick" | "none";
  /** False keeps each template's explicit size. Automatic resizing is rejected for v1. */
  autoItemSize?: false;
  items: ({ name: string; componentId?: string } & ComponentInstance)[];
}
export interface SceneNode extends Rect {
  id: string; name: string; type: NodeType; z?: number; alpha?: number; visible?: boolean; touchable?: boolean;
  /** Only the identity transform is supported in this schema version. */
  pivot?: [number, number]; scale?: [number, number]; rotation?: number;
  groupId?: string; assetId?: string; componentId?: string;
  text?: string; style?: TextStyle; referenceAssetId?: string; ubb?: boolean;
  input?: { prompt?: string; restrict?: string; maxLength?: number; password?: boolean; keyboardType?: number };
  loader?: { fill?: "none" | "scale" | "scaleMatchHeight" | "scaleMatchWidth" | "scaleFree" | "scaleNoBorder";
    align?: "left" | "center" | "right"; vAlign?: "top" | "middle" | "bottom"; shrinkOnly?: boolean };
  instance?: ComponentInstance; list?: SceneList; gears?: SceneGear[]; relations?: SceneRelation[];
  recognition?: { basis: string; confidence?: number; assumptions?: string[] };
  bindings?: { event: string; handler?: string; status: "unbound" | "external"; source?: string }[];
}
export interface ComponentExtension {
  button?: { mode: "Common" | "Check" | "Radio"; downEffect?: "none" | "dark" | "scale"; downEffectValue?: number };
  slider?: { titleType?: "percent" | "valueAndmax" | "value" | "max"; reverse?: boolean; wholeNumbers?: boolean; changeOnClick?: boolean };
  progressBar?: { titleType?: "percent" | "valueAndmax" | "value" | "max"; reverse?: boolean };
  scrollBar?: { fixedGripSize?: boolean };
  comboBox?: { dropdown: string };
}
export interface SceneComponent extends SceneViewport {
  id: string; name: string; semantic: ComponentSemantic; width: number; height: number;
  children: SceneNode[]; controllers?: SceneController[]; extension?: ComponentExtension; opaque?: boolean;
}
export interface Scene {
  schemaVersion: 1; id: string; name: string; canvas: { width: number; height: number }; entry: string;
  assets: SceneAsset[]; fonts: SceneFont[]; components: SceneComponent[];
  referenceFile?: string; assumptions?: string[];
}
export interface ValidationIssue { code: string; path: string; message: string }
export interface SceneValidation {
  status: "passed" | "failed"; errors: ValidationIssue[]; warnings: ValidationIssue[];
  nativeImport: "not_verified"; runtimeInteraction: "not_verified";
}
export interface ResolvedNode extends Rect {
  id: string; sourceId: string; name: string; type: NodeType; componentId: string; parentId: string | null;
  localX: number; localY: number; opacity: number; visible: boolean; z: number;
  assetId?: string; text?: string; style?: TextStyle; referenceAssetId?: string;
  loader?: SceneNode["loader"]; input?: SceneNode["input"]; ubb?: boolean;
  targetFguiType?: string; recognition?: SceneNode["recognition"]; interaction?: ComponentInstance;
  clip?: Rect; groupPath: string[]; groupId?: string;
  /** A bar is resized by the native control; render its texture at the resolved size. */
  controlPart?: "bar" | "bar_v" | "grip" | "title";
}
export interface ResolvedScene {
  canvas: Scene["canvas"]; layers: ResolvedNode[]; nodes: ResolvedNode[];
  /** Preview differences only. Unsupported geometry raises an error before resolution. */
  limitations: string[];
}
export interface SceneResolveOptions { percentageRounding?: "floor" | "round" }

/** Every immutable input used by either output, including explicit native
 * variants. Keep this list shared with job revision/hash validation. */
export function sceneInputFiles(scene: Scene): string[] {
  return [...new Set([
    ...scene.assets.flatMap(asset => [asset.file, ...(asset.fgui ? [asset.fgui.file] : [])]),
    ...scene.fonts.flatMap(font => [font.file, ...(font.fgui ? [font.fgui.file] : []), ...(font.licenseFile ? [font.licenseFile] : [])]),
    ...(scene.referenceFile ? [scene.referenceFile] : []),
  ])];
}

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const name = z.string().min(1).max(160).refine(s => !/[.\u0000-\u001f]/.test(s) && !/\p{Surrogate}/u.test(s), "Names cannot contain dots, control characters or invalid Unicode; property paths use dots.");
const integer = z.number().int().min(-1_000_000).max(1_000_000);
const dimension = z.number().int().min(1).max(16384);
const nonnegative = z.number().int().min(0).max(1_000_000);
const color = z.string().regex(/^#[a-fA-F0-9]{6}$/);
const pair = z.tuple([integer, integer]);
const boundedText = z.string().max(65536).refine(s => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s) && !/\p{Surrogate}/u.test(s), "XML 1.0 requires valid Unicode without these control characters.");
export function isSafeRelativePath(value: string): boolean {
  return !!value && value.length <= 512 && value.normalize("NFC") === value &&
    !/[\\\u0000-\u001f:?*<>|"#]/.test(value) && !value.startsWith("/") &&
    value.split("/").every(part => !!part && part !== "." && part !== ".." && !/[. ]$/.test(part) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
const relativeFile = z.string().refine(isSafeRelativePath, "Use a normalized relative path without traversal, drive letters, reserved names or URLs.");
const textStyle = z.object({
  fontId: id.optional(), fontFamily: z.string().min(1).max(160).optional(), fontSize: z.number().int().min(1).max(512), color,
  align: z.enum(["left", "center", "right"]).optional(), vAlign: z.enum(["top", "middle", "bottom"]).optional(),
  leading: integer.optional(), letterSpacing: integer.optional(), bold: z.boolean().optional(), italic: z.boolean().optional(),
  underline: z.boolean().optional(), strike: z.boolean().optional(), singleLine: z.boolean().optional(),
  autoSize: z.enum(["none", "both", "height", "shrink", "ellipsis"]).optional(),
  strokeColor: color.optional(), strokeSize: z.number().min(0).max(64).optional(),
  shadowColor: color.optional(), shadowOffset: pair.optional(),
}).strict();
const propertyOverride = z.object({ target: z.string().min(1).max(512),
  property: z.enum(["text", "icon", "color", "fontSize"]), value: z.union([boundedText, integer]),
}).strict();
const instanceShape = {
  controllers: z.record(z.string().min(1), z.string().min(1)).optional(), properties: z.array(propertyOverride).max(1024).optional(),
  title: boundedText.optional(), selectedTitle: boundedText.optional(), iconAssetId: id.optional(), selectedIconAssetId: id.optional(),
  checked: z.boolean().optional(), titleColor: color.optional(), titleFontSize: z.number().int().min(1).max(512).optional(),
  relatedController: z.string().min(1).optional(), relatedPageId: z.string().min(1).optional(),
  value: integer.optional(), min: integer.optional(), max: integer.optional(),
  items: z.array(z.object({ title: boundedText, value: boundedText, iconAssetId: id.optional() }).strict()).max(1000).optional(),
  visibleItemCount: z.number().int().min(1).max(1000).optional(), direction: z.enum(["auto", "up", "down"]).optional(),
};
const viewportShape = {
  overflow: z.enum(["visible", "hidden", "scroll"]).optional(), scroll: z.enum(["vertical", "horizontal"]).optional(),
  scrollBar: z.enum(["hidden", "visible", "auto"]).optional(), verticalScrollBar: id.optional(), horizontalScrollBar: id.optional(),
  margin: z.object({ top: nonnegative, bottom: nonnegative, left: nonnegative, right: nonnegative }).strict().optional(),
};
const gearBase = { controller: z.string().min(1) };
const gearSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("display"), ...gearBase, pages: z.array(z.string()).max(256) }).strict(),
  z.object({ kind: z.literal("xy"), ...gearBase, values: z.record(pair), default: pair.optional() }).strict(),
  z.object({ kind: z.literal("size"), ...gearBase, values: z.record(pair), default: pair.optional() }).strict(),
  z.object({ kind: z.literal("color"), ...gearBase, values: z.record(color), default: color.optional() }).strict(),
  z.object({ kind: z.literal("text"), ...gearBase, values: z.record(boundedText), default: boundedText.optional() }).strict(),
  z.object({ kind: z.literal("icon"), ...gearBase, values: z.record(id), default: id.optional() }).strict(),
  z.object({ kind: z.literal("fontSize"), ...gearBase, values: z.record(z.number().int().min(1).max(512)), default: z.number().int().min(1).max(512).optional() }).strict(),
]);
export const SceneNodeSchema = z.object({
  id, name, type: z.enum(["Component", "Button", "Slider", "ProgressBar", "ScrollBar", "ComboBox", "Image", "Loader", "Text", "RichText", "InputText", "List", "Group"]),
  x: integer, y: integer, width: dimension, height: dimension, z: integer.optional(),
  alpha: z.number().min(0).max(1).optional(), visible: z.boolean().optional(), touchable: z.boolean().optional(),
  pivot: z.tuple([z.literal(0), z.literal(0)]).optional(), scale: z.tuple([z.literal(1), z.literal(1)]).optional(), rotation: z.literal(0).optional(),
  groupId: id.optional(), assetId: id.optional(), componentId: id.optional(), text: boundedText.optional(), style: textStyle.optional(),
  referenceAssetId: id.optional(), ubb: z.boolean().optional(),
  input: z.object({ prompt: boundedText.optional(), restrict: boundedText.optional(), maxLength: nonnegative.optional(),
    password: z.boolean().optional(), keyboardType: z.number().int().min(0).max(20).optional() }).strict().optional(),
  loader: z.object({ fill: z.enum(["none", "scale", "scaleMatchHeight", "scaleMatchWidth", "scaleFree", "scaleNoBorder"]).optional(),
    align: z.enum(["left", "center", "right"]).optional(), vAlign: z.enum(["top", "middle", "bottom"]).optional(), shrinkOnly: z.boolean().optional() }).strict().optional(),
  instance: z.object(instanceShape).strict().optional(),
  list: z.object({ ...viewportShape, layout: z.enum(["column", "row"]), defaultItem: id,
    lineGap: nonnegative.optional(), columnGap: nonnegative.optional(), selectionMode: z.enum(["single", "multiple", "multipleSingleClick", "none"]).optional(),
    autoItemSize: z.literal(false).optional(), items: z.array(z.object({ name, componentId: id.optional(), ...instanceShape }).strict()).max(1000),
  }).strict().optional(),
  gears: z.array(gearSchema).max(16).optional(),
  relations: z.array(z.object({ target: z.string().max(128), sidePair: z.string().min(1).max(512), usePercent: z.boolean().optional() }).strict()).max(32).optional(),
  recognition: z.object({ basis: boundedText, confidence: z.number().min(0).max(1).optional(), assumptions: z.array(boundedText).max(100).optional() }).strict().optional(),
  bindings: z.array(z.object({ event: z.string().min(1).max(160), handler: z.string().max(512).optional(),
    status: z.enum(["unbound", "external"]), source: boundedText.optional() }).strict()).max(100).optional(),
}).strict();
const barDefinition = { titleType: z.enum(["percent", "valueAndmax", "value", "max"]).optional(), reverse: z.boolean().optional() };
export const SceneSchema = z.object({
  schemaVersion: z.literal(1), id, name: z.string().min(1).max(160), canvas: z.object({ width: dimension, height: dimension }).strict(), entry: id,
  assets: z.array(z.object({ id, name: z.string().max(160).optional(), file: relativeFile, width: dimension, height: dimension,
    scale9grid: z.tuple([nonnegative, nonnegative, dimension, dimension]).optional(), originalWidth: dimension.optional(), originalHeight: dimension.optional(),
    cropOffset: pair.optional(), provenance: boundedText.optional(),
    fgui: z.object({ file: relativeFile, width: dimension, height: dimension,
      scale9grid: z.tuple([nonnegative, nonnegative, dimension, dimension]).optional(), provenance: boundedText.refine(text => text.length > 0) }).strict().optional(),
  }).strict()).max(2048),
  fonts: z.array(z.object({ id, file: relativeFile, family: z.string().min(1).max(160), licenseFile: relativeFile.optional(),
    fgui: z.object({ file: relativeFile, family: z.string().min(1).max(160), provenance: boundedText.refine(text => text.length > 0) }).strict().optional(),
  }).strict()).max(32),
  components: z.array(z.object({ ...viewportShape, id, name, semantic: z.enum(["Component", "Button", "Slider", "ProgressBar", "ScrollBar", "ComboBox"]),
    width: dimension, height: dimension, opaque: z.boolean().optional(), children: z.array(SceneNodeSchema).max(4096),
    controllers: z.array(z.object({ name: z.string().min(1).max(160).refine(s => !/[,\u0000-\u001f]/.test(s)),
      pages: z.array(z.object({ id: z.string().min(1).max(128).refine(s => !/[,|\u0000-\u001f]/.test(s)),
        name: z.string().max(160).refine(s => !/[,\u0000-\u001f]/.test(s)) }).strict()).min(1).max(256),
      selectedPageId: z.string().min(1), exported: z.boolean().optional(),
    }).strict()).max(64).optional(),
    extension: z.object({
      button: z.object({ mode: z.enum(["Common", "Check", "Radio"]), downEffect: z.enum(["none", "dark", "scale"]).optional(),
        downEffectValue: z.number().min(0).max(2).optional() }).strict().optional(),
      slider: z.object({ ...barDefinition, wholeNumbers: z.boolean().optional(), changeOnClick: z.boolean().optional() }).strict().optional(),
      progressBar: z.object(barDefinition).strict().optional(), scrollBar: z.object({ fixedGripSize: z.boolean().optional() }).strict().optional(),
      comboBox: z.object({ dropdown: id }).strict().optional(),
    }).strict().optional(),
  }).strict()).min(1).max(1024),
  referenceFile: relativeFile.optional(), assumptions: z.array(boundedText).max(1000).optional(),
}).strict();

export class SceneError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(issues.slice(0, 12).map(issue => `${issue.code} at ${issue.path}: ${issue.message}`).join("\n"));
    this.name = "SceneError";
  }
}

export const COMPONENT_TYPES = new Set<NodeType>(["Component", "Button", "Slider", "ProgressBar", "ScrollBar", "ComboBox"]);
export const TEXT_TYPES = new Set<NodeType>(["Text", "RichText", "InputText"]);
export const FGUI_TARGET_TYPES: Record<NodeType, string> = {
  Component: "GComponent", Image: "GImage", Loader: "GLoader", Text: "GTextField", RichText: "GRichTextField", InputText: "GTextInput",
  Button: "GButton", Slider: "GSlider", ProgressBar: "GProgressBar", ScrollBar: "GScrollBar", List: "GList", ComboBox: "GComboBox", Group: "GGroup",
};
export const PROPERTY_IDS: Record<PropertyName, number> = { text: 0, icon: 1, color: 2, fontSize: 8 };
export const RELATION_PAIRS = new Set(["left-left", "left-center", "left-right", "center-center", "right-left", "right-center", "right-right",
  "top-top", "top-middle", "top-bottom", "middle-middle", "bottom-top", "bottom-middle", "bottom-bottom", "width-width", "height-height",
  "leftExt-left", "leftExt-right", "rightExt-left", "rightExt-right", "topExt-top", "topExt-bottom", "bottomExt-top", "bottomExt-bottom", "width", "height"]);

export function propertyTarget(component: SceneComponent, target: string, components: ReadonlyMap<string, SceneComponent>): SceneNode | undefined {
  const parts = target.split("."); let owner: SceneComponent | undefined = component;
  for (let i = 0; i < parts.length; i++) {
    const node: SceneNode | undefined = owner?.children.find(child => child.name === parts[i]);
    if (!node) return undefined;
    if (i === parts.length - 1) return node;
    owner = node.componentId ? components.get(node.componentId) : undefined;
  }
  return undefined;
}

export function validateScene(value: unknown): SceneValidation {
  const parsed = SceneSchema.safeParse(value);
  const errors: ValidationIssue[] = [], warnings: ValidationIssue[] = [];
  const fail = (code: string, at: string, message: string) => errors.push({ code, path: at, message });
  const warn = (code: string, at: string, message: string) => warnings.push({ code, path: at, message });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) fail("SCENE_SCHEMA", issue.path.join("."), issue.message);
    return { status: "failed", errors, warnings, nativeImport: "not_verified", runtimeInteraction: "not_verified" };
  }
  const scene: Scene = parsed.data;
  const assets = new Map(scene.assets.map(asset => [asset.id, asset]));
  const fonts = new Map(scene.fonts.map(font => [font.id, font]));
  const components = new Map(scene.components.map(component => [component.id, component]));
  const duplicate = <T>(rows: T[], key: (row: T) => string, at: string) => {
    const seen = new Set<string>(); for (const row of rows) { const id = key(row);
      if (seen.has(id)) fail("DUPLICATE_ID", at, `Duplicate identity '${id}'.`); seen.add(id); }
  };
  duplicate(scene.assets, asset => asset.id, "assets"); duplicate(scene.fonts, font => font.id, "fonts");
  duplicate(scene.components, component => component.id, "components");
  duplicate([...scene.assets, ...scene.fonts], item => item.file.toLowerCase(), "files");
  duplicate(scene.components, component => component.name.toLowerCase(), "components.names");
  if (scene.canvas.width * scene.canvas.height > 32 * 1024 * 1024) fail("CANVAS_PIXEL_LIMIT", "canvas", "Canvas exceeds the workflow's 32 megapixel limit.");
  const entry = components.get(scene.entry);
  if (!entry) fail("ENTRY_MISSING", "entry", "Entry component does not exist.");
  else if (entry.semantic !== "Component" || entry.width !== scene.canvas.width || entry.height !== scene.canvas.height)
    fail("ENTRY_CANVAS", "entry", "Entry must be a Component with the exact canvas dimensions.");
  for (const asset of scene.assets) {
    if (!/\.png$/i.test(asset.file)) fail("PNG_REQUIRED", `assets.${asset.id}`, "Independent images must be real RGBA PNG files with .png extension.");
    if (asset.width * asset.height > 64 * 1024 * 1024) fail("ASSET_PIXEL_LIMIT", asset.id, "Asset exceeds 64 megapixels.");
    if (asset.scale9grid) { const [x, y, w, h] = asset.scale9grid;
      if (x + w > asset.width || y + h > asset.height) fail("SCALE9_CENTER_RECT", asset.id, "scale9grid is the center rectangle x,y,width,height inside the actual PNG."); }
    if (asset.fgui) {
      if (!/\.png$/i.test(asset.fgui.file)) fail("PNG_REQUIRED", asset.id + ".fgui", "Compact textures must remain real RGBA PNG.");
      if (asset.fgui.width * asset.fgui.height > 64 * 1024 * 1024) fail("ASSET_PIXEL_LIMIT", asset.id + ".fgui", "Compact texture exceeds 64 megapixels.");
      if (asset.scale9grid && !asset.fgui.scale9grid && (asset.fgui.width !== asset.width || asset.fgui.height !== asset.height))
        fail("VARIANT_SCALE9_REQUIRED", asset.id, "A resized FGUI texture requires its own explicit center rectangle; borders cannot be copied at the wrong texture scale.");
      if (asset.fgui.scale9grid) { const [x, y, w, h] = asset.fgui.scale9grid;
        if (x + w > asset.fgui.width || y + h > asset.fgui.height) fail("SCALE9_CENTER_RECT", asset.id + ".fgui", "Compact scale9grid lies outside its actual PNG."); }
      warn("EXPLICIT_FGUI_TEXTURE_VARIANT", asset.id, asset.fgui.provenance);
    }
  }
  for (const font of scene.fonts) if (!/\.(ttf|otf|ttc)$/i.test(font.file)) fail("FONT_FORMAT", font.id, "Use a packaged TTF, OTF or TTC font.");
  for (const font of scene.fonts) if (font.fgui) {
    if (!/\.(ttf|otf)$/i.test(font.fgui.file)) fail("FONT_FORMAT", font.id + ".fgui", "Compact fonts must be single-face TTF/OTF files for glyph verification.");
    warn("EXPLICIT_FGUI_FONT_VARIANT", font.id, font.fgui.provenance + " Coverage can only be checked against known text; future dynamic text requires adequate glyphs.");
  }
  const links = new Map<string, Set<string>>();
  const referenceAsset = (assetId: string | undefined, at: string) => {
    if (assetId !== undefined && !assets.has(assetId)) fail("ASSET_REFERENCE", at, `Missing asset '${assetId}'.`);
  };
  const loaderVariant = (node: SceneNode | undefined, assetId: string | undefined, at: string) => {
    if (node?.type !== "Loader" || !assetId) return;
    const asset = assets.get(assetId), variant = asset?.fgui;
    if (!asset || !variant || (asset.width === variant.width && asset.height === variant.height)) return;
    const fill = node.loader?.fill ?? "scale";
    if (fill === "none" || node.loader?.shrinkOnly || (fill !== "scaleFree" && asset.width * variant.height !== asset.height * variant.width))
      fail("VARIANT_LOADER_GEOMETRY", at, "This compact texture would change the Loader's native content bounds. Use equal-size textures, matching aspect ratios with scaling enabled, or an explicit scaleFree slot without shrinkOnly.");
  };
  const viewport = (vp: SceneViewport, owner: SceneComponent, at: string, width: number, height: number) => {
    for (const [direction, ref] of [["vertical", vp.verticalScrollBar], ["horizontal", vp.horizontalScrollBar]] as const) {
      if (!ref) continue;
      if (vp.overflow !== "scroll" || (vp.scroll ?? "vertical") !== direction)
        fail("SCROLLBAR_VIEWPORT", at, "A scrollbar must be associated with a scrolling viewport in its own direction.");
      if (components.get(ref)?.semantic !== "ScrollBar") fail("SCROLLBAR_REFERENCE", at, `Expected a ScrollBar component '${ref}'.`);
      const template = components.get(ref);
      if (template && (direction === "vertical" ? template.height !== height : template.width !== width))
        fail("SCROLLBAR_TEMPLATE_SIZE", at, "v1 requires the ScrollBar template to match the viewport length. Create a correctly sized reusable variant; do not assume nested controls will scale.");
      links.get(owner.id)!.add(ref);
    }
    if (vp.scrollBar && vp.scrollBar !== "hidden") {
      if (!(vp.scroll === "horizontal" ? vp.horizontalScrollBar : vp.verticalScrollBar))
        fail("SCROLLBAR_SKIN_MISSING", at, "Visible or auto scrollbars require an explicit packaged ScrollBar resource.");
      if (vp.scrollBar === "auto") warn("AUTO_SCROLLBAR_PREVIEW", at, "Auto-hide scrollbar visibility is controlled by the runtime; static preview hides it.");
    }
  };
  const validateInstance = (instance: ComponentInstance, target: SceneComponent | undefined, owner: SceneComponent, at: string) => {
    if (!target) return;
    for (const [controllerName, pageId] of Object.entries(instance.controllers ?? {})) {
      const controller = target.controllers?.find(c => c.name === controllerName);
      if (!controller || !controller.pages.some(p => p.id === pageId)) fail("INSTANCE_CONTROLLER", at, `Missing controller/page '${controllerName}/${pageId}'.`);
      else if (!controller.exported) fail("CONTROLLER_NOT_EXPORTED", at, `Controller '${controllerName}' must be exported for instance overrides.`);
    }
    for (const prop of instance.properties ?? []) {
      const node = propertyTarget(target, prop.target, components);
      if (!node) { fail("PROPERTY_TARGET", at, `Missing property target '${prop.target}'.`); continue; }
      if (prop.property === "text" && (!TEXT_TYPES.has(node.type) || typeof prop.value !== "string")) fail("PROPERTY_TYPE", at, "Text overrides require a text target and a string value.");
      if (prop.property === "fontSize" && (!TEXT_TYPES.has(node.type) || typeof prop.value !== "number" || prop.value <= 0 || prop.value > 512)) fail("PROPERTY_TYPE", at, "Font size overrides require a text target and integer size 1–512.");
      if (prop.property === "color" && (!TEXT_TYPES.has(node.type) || typeof prop.value !== "string" || !/^#[0-9a-f]{6}$/i.test(prop.value))) fail("PROPERTY_TYPE", at, "Color overrides require a text target and #RRGGBB.");
      if (prop.property === "icon") {
        if (node.type !== "Loader" || typeof prop.value !== "string") fail("PROPERTY_TYPE", at, "Icon overrides require a Loader target and asset ID.");
        referenceAsset(String(prop.value), at);
        loaderVariant(node, String(prop.value), at);
      }
    }
    for (const aid of [instance.iconAssetId, instance.selectedIconAssetId, ...instance.items?.map(item => item.iconAssetId) ?? []]) referenceAsset(aid, at);
    const isTitleControl = target.semantic === "Button" || target.semantic === "ComboBox";
    if ([instance.title, instance.selectedTitle, instance.titleColor, instance.titleFontSize].some(v => v !== undefined)) {
      if (!isTitleControl || !target.children.some(node => node.name === "title" && TEXT_TYPES.has(node.type)))
        fail("TITLE_PART_MISSING", at, "Title overrides require a Button/ComboBox and a native text child named title.");
    }
    if (instance.iconAssetId !== undefined || instance.selectedIconAssetId !== undefined) {
      if (!isTitleControl || !target.children.some(node => node.name === "icon" && node.type === "Loader"))
        fail("ICON_PART_MISSING", at, "Icon overrides require a Button/ComboBox and a Loader child named icon.");
      const icon = target.children.find(node => node.name === "icon");
      loaderVariant(icon, instance.iconAssetId, at); loaderVariant(icon, instance.selectedIconAssetId, at);
    }
    if (instance.checked !== undefined && target.semantic !== "Button") fail("BUTTON_INSTANCE", at, "checked is a Button instance property.");
    if (instance.checked && target.extension?.button?.mode === "Common") fail("BUTTON_CHECK_MODE", at, "Only Check/Radio buttons have a checked state.");
    if (instance.titleFontSize !== undefined && target.semantic === "ComboBox") fail("COMBO_TITLE_FONT_SIZE", at, "Use a declared property override targeting title/fontSize; ComboBox has no titleFontSize instance XML field.");
    if ((instance.selectedTitle !== undefined || instance.selectedIconAssetId !== undefined) && target.semantic !== "Button") fail("BUTTON_INSTANCE", at, "Selected title/icon are Button instance properties.");
    if (instance.relatedController || instance.relatedPageId) {
      const controller = owner.controllers?.find(c => c.name === instance.relatedController);
      if (target.semantic !== "Button" || target.extension?.button?.mode === "Common" || !controller || !controller.pages.some(page => page.id === instance.relatedPageId))
        fail("BUTTON_CONTROLLER", at, "Related controller/page must exist on the parent and use a Check/Radio Button.");
    }
    if (target.semantic === "Slider" || target.semantic === "ProgressBar") {
      if (instance.value === undefined || instance.min === undefined || instance.max === undefined)
        fail("CONTROL_RANGE_REQUIRED", at, "Provide explicit integer min, max and current value for this control, with the source/assumption in recognition metadata.");
      else if (instance.min >= instance.max || instance.value < instance.min || instance.value > instance.max || instance.max === 0)
        fail("CONTROL_RANGE", at, "Require min < max, min ≤ value ≤ max and nonzero max for the supported source importer.");
    } else if ([instance.min, instance.max, instance.value].some(v => v !== undefined)) fail("CONTROL_RANGE_TYPE", at, "Numerical ranges are Slider/ProgressBar instance properties.");
    if (target.semantic === "ComboBox") {
      if (!instance.items?.length) fail("COMBO_OPTIONS_REQUIRED", at, "A ComboBox requires its actual options; do not deliver only its closed appearance.");
      const popup = components.get(target.extension?.comboBox?.dropdown ?? "");
      const list = popup?.children.find(node => node.type === "List" && node.name === "list")?.list;
      const item = list ? components.get(list.defaultItem) : undefined;
      for (const value of instance.items ?? []) {
        loaderVariant(target.children.find(node => node.name === "icon"), value.iconAssetId, at);
        loaderVariant(item?.children.find(node => node.name === "icon"), value.iconAssetId, at);
      }
    } else if (instance.items !== undefined || instance.visibleItemCount !== undefined || instance.direction !== undefined) fail("COMBO_INSTANCE", at, "Popup options belong to a ComboBox instance.");
  };
  for (const component of scene.components) links.set(component.id, new Set());
  let totalObjects = 0;
  for (const component of scene.components) {
    const at = `components.${component.id}`; const ids = new Set(component.children.map(node => node.id));
    totalObjects += component.children.length;
    duplicate(component.children, node => node.id, at); duplicate(component.children, node => node.name, at + ".names");
    duplicate(component.controllers ?? [], c => c.name, at + ".controllers");
    viewport(component, component, at, component.width, component.height);
    for (const controller of component.controllers ?? []) {
      duplicate(controller.pages, page => page.id, at + ".controllers." + controller.name);
      duplicate(controller.pages, page => page.name, at + ".controllers." + controller.name);
      if (!controller.pages.some(page => page.id === controller.selectedPageId)) fail("CONTROLLER_PAGE", at, "Controller selected page does not exist.");
    }
    const expectedExtension = ({ Component: undefined, Button: "button", Slider: "slider", ProgressBar: "progressBar", ScrollBar: "scrollBar", ComboBox: "comboBox" } as const)[component.semantic];
    const present = Object.keys(component.extension ?? {});
    if (expectedExtension ? present.length !== 1 || present[0] !== expectedExtension : present.length > 0)
      fail("EXTENSION_SEMANTIC", at, `Semantic ${component.semantic} must have exactly its matching extension definition.`);
    if (["Button", "Slider", "ComboBox", "ScrollBar"].includes(component.semantic) && component.opaque === false)
      fail("CONTROL_HIT_AREA", at, "Interactive controls require opaque=true so empty parts of their bounds remain clickable.");
    if (component.semantic === "Button" && component.extension?.button?.mode !== "Common") {
      const button = component.controllers?.find(c => c.name === "button");
      if (!button || !["up", "down"].every(name => button.pages.some(page => page.name === name)))
        fail("BUTTON_STATE_CONTROLLER", at, "Check/Radio Button needs the button controller with up and down pages.");
    }
    if (component.extension?.button?.downEffectValue !== undefined && (!component.extension.button.downEffect || component.extension.button.downEffect === "none"))
      fail("BUTTON_DOWN_EFFECT", at, "downEffectValue requires an actual downEffect definition.");
    if (component.semantic === "Slider" || component.semantic === "ProgressBar") {
      const bars = component.children.filter(node => node.name === "bar" || node.name === "bar_v");
      if (bars.length !== 1 || bars[0]?.type !== "Image")
        fail("BAR_PART", at, "v1 requires one full-range Image named bar (horizontal) or bar_v (vertical); nested resizable bar components require a native layout adapter.");
      if (component.semantic === "Slider") {
        const grip = component.children.find(node => node.name === "grip"); const bar = bars[0];
        if (!grip || grip.touchable === false || (!COMPONENT_TYPES.has(grip.type) && grip.type !== "Image")) fail("SLIDER_GRIP", at, "Slider requires a touchable grip part.");
        if (grip && bar) {
          const reverse = component.extension?.slider?.reverse;
          const expected = bar.name === "bar" ? reverse ? "left-left" : "right-right" : reverse ? "top-top" : "bottom-bottom";
          if (!grip.relations?.some(rel => rel.target === bar.id && rel.sidePair.split(",").includes(expected)))
            fail("SLIDER_GRIP_RELATION", at, `grip must relate ${expected} to the full-range bar; this makes dragging and value updates move the grip.`);
        }
      }
    }
    if (component.semantic === "ScrollBar" && !["bar", "grip"].every(part => component.children.some(node => node.name === part && node.type === "Image")))
      fail("SCROLLBAR_PARTS", at, "v1 ScrollBar requires Image parts named bar and grip, so native size changes have exact raster counterparts.");
    if (component.semantic === "ComboBox") {
      const dropdown = component.extension?.comboBox?.dropdown; if (dropdown) links.get(component.id)!.add(dropdown);
      const popup = dropdown ? components.get(dropdown) : undefined;
      const list = popup?.children.find(node => node.name === "list" && node.type === "List");
      if (!popup || popup.semantic !== "Component" || !list?.list || components.get(list.list.defaultItem)?.semantic !== "Button")
        fail("COMBO_POPUP", at, "ComboBox dropdown must be a real Component containing list, with a Button default item.");
      if (!component.children.some(node => node.name === "title" && TEXT_TYPES.has(node.type))) fail("COMBO_TITLE", at, "ComboBox requires a native text title part.");
    }
    for (const node of component.children) {
      const p = `${at}.children.${node.id}`;
      if (node.groupId && (node.groupId === node.id || !component.children.some(group => group.id === node.groupId && group.type === "Group"))) fail("GROUP_TARGET", p, "Group must refer to a sibling Group and is not a coordinate parent.");
      if (node.type === "ScrollBar") fail("SCROLLBAR_ASSOCIATION", p, "Declare ScrollBar resources through a Component/List viewport's verticalScrollBar or horizontalScrollBar, so the native scroll pane owns its geometry and interaction.");
      loaderVariant(node, node.assetId, p);
      if (node.type === "Group" && (node.groupId || node.gears?.length || node.relations?.length)) fail("GROUP_FEATURE", p, "v1 supports simple logical Groups only; nested groups/gears/relations would require runtime layout support.");
      referenceAsset(node.assetId, p); referenceAsset(node.referenceAssetId, p);
      if (node.type === "Image" && !node.assetId) fail("IMAGE_ASSET", p, "Image requires an asset ID.");
      if (node.assetId && node.type !== "Image" && node.type !== "Loader") fail("ASSET_TYPE", p, "Direct assetId is only valid for Image/Loader. Controls reference a component skin.");
      if (TEXT_TYPES.has(node.type)) {
        if (node.text === undefined || !node.style) fail("TEXT_DATA", p, "Text/InputText/RichText require real text and a text style.");
        if (node.style?.fontId && !fonts.has(node.style.fontId)) fail("FONT_REFERENCE", p, "Missing font resource.");
        if (node.style && !node.style.fontId) warn("SYSTEM_FONT", p, "Text uses a system/project font; matching glyph metrics depend on the target computer.");
        if (node.style?.autoSize && node.style.autoSize !== "none") warn("TEXT_AUTOSIZE_PREVIEW", p, "Native text auto-size may change measured geometry; verify in the actual editor/runtime.");
        if (node.type === "RichText" && !node.referenceAssetId) warn("RICHTEXT_PREVIEW", p, "Rich text/link shaping requires a native render or a supplied transparent text reference for exact preview.");
      } else if (node.text !== undefined || node.style || node.referenceAssetId || node.ubb !== undefined) fail("TEXT_ON_NON_TEXT", p, "Text fields belong to native text nodes, not image/control nodes.");
      if (node.input && node.type !== "InputText") fail("INPUT_TYPE", p, "Input settings require InputText semantics.");
      if (node.loader && node.type !== "Loader") fail("LOADER_TYPE", p, "Loader fill settings require Loader semantics.");
      if (COMPONENT_TYPES.has(node.type)) {
        const target = node.componentId ? components.get(node.componentId) : undefined;
        if (!target || target.semantic !== node.type) fail("COMPONENT_REFERENCE", p, "componentId must reference a component with the same semantic type.");
        else {
          links.get(component.id)!.add(target.id);
          if (target.width !== node.width || target.height !== node.height) fail("COMPONENT_RESIZE_UNSUPPORTED", p, "v1 requires instance dimensions to match its template; create an explicit template variant for resized layouts.");
          validateInstance(node.instance ?? {}, target, component, p);
        }
      } else if (node.componentId || node.instance) fail("COMPONENT_ON_LEAF", p, "Leaf nodes cannot have component references or component-instance data.");
      if (node.type === "List") {
        if (!node.list) fail("LIST_DATA", p, "List requires its reusable defaultItem and actual item data.");
        else {
          links.get(component.id)!.add(node.list.defaultItem); viewport(node.list, component, p, node.width, node.height);
          if (!components.has(node.list.defaultItem)) fail("LIST_TEMPLATE", p, "Missing default list item component.");
          duplicate(node.list.items, item => item.name, p + ".items");
          for (const item of node.list.items) {
            const ref = item.componentId ?? node.list.defaultItem; links.get(component.id)!.add(ref);
            const target = components.get(ref);
            if (!target) fail("LIST_ITEM_REFERENCE", p, `Missing item component '${ref}'.`);
            else {
              if (target.semantic !== "Component" && target.semantic !== "Button") fail("LIST_CONTROL_WRAPPER", p, "Use a Component item wrapping a Slider/ProgressBar/ComboBox so native instance values have their correct XML owner.");
              const allowed = new Set(["name", "componentId", "controllers", "properties", "title", "selectedTitle", "iconAssetId", "selectedIconAssetId"]);
              if (Object.keys(item).some(key => !allowed.has(key))) fail("LIST_ITEM_FIELDS", p, "List item data supports title/icon, controllers and declared property overrides. Other control-instance settings belong inside an item wrapper.");
              validateInstance(item, target, component, p + ".items." + item.name);
            }
          }
        }
      } else if (node.list) fail("LIST_TYPE", p, "List data requires List semantics.");
      const gears = new Set<string>();
      for (const gear of node.gears ?? []) {
        if (gears.has(gear.kind)) fail("DUPLICATE_GEAR", p, `Only one ${gear.kind} gear is allowed per node.`); gears.add(gear.kind);
        const controller = component.controllers?.find(c => c.name === gear.controller);
        const pages = gear.kind === "display" ? gear.pages : Object.keys(gear.values);
        if (gear.kind !== "display" && !pages.length) fail("GEAR_VALUES_EMPTY", p, "A value gear needs at least one explicit page/value pair.");
        if (!controller || pages.some(page => !controller.pages.some(p => p.id === page))) fail("GEAR_CONTROLLER_PAGE", p, "Gear controller and pages must exist on the owning component.");
        if (gear.kind === "text" && (!TEXT_TYPES.has(node.type) || [...Object.values(gear.values), gear.default ?? ""].some(value => value.includes("|")))) fail("GEAR_TEXT", p, "Text gears require text nodes and cannot contain the source delimiter |.");
        if (["color", "fontSize"].includes(gear.kind) && !TEXT_TYPES.has(node.type)) fail("GEAR_TEXT_STYLE", p, "Color/fontSize gears require text nodes in v1.");
        if (gear.kind === "icon") { if (node.type !== "Loader") fail("GEAR_ICON", p, "Icon gears require a Loader.");
          [...Object.values(gear.values), ...(gear.default ? [gear.default] : [])].forEach(aid => { referenceAsset(aid, p); loaderVariant(node, aid, p); }); }
        if (gear.kind === "size") {
          if (COMPONENT_TYPES.has(node.type) || node.type === "List") fail("GEAR_SIZE_CONTAINER", p, "Container size gears need a dedicated native-layout adapter; create fixed-size variants in v1.");
          if ([...Object.values(gear.values), ...gear.default ? [gear.default] : []].some(pair => pair[0] <= 0 || pair[1] <= 0)) fail("GEAR_SIZE", p, "Gear dimensions must be positive.");
        }
      }
      for (const relation of node.relations ?? []) {
        if (relation.target && (!ids.has(relation.target) || relation.target === node.id)) fail("RELATION_TARGET", p, "Relation target must be the parent (empty string) or another sibling object ID.");
        if (!relation.sidePair.split(",").every(pair => RELATION_PAIRS.has(pair))) fail("RELATION_PAIR", p, "Unsupported source relation pair.");
        if (relation.usePercent) fail("PERCENT_RELATION_UNSUPPORTED", p, "Percentage relations require a dedicated native layout adapter in v1.");
      }
    }
    const relationVisiting = new Set<string>(), relationDone = new Set<string>();
    const relationVisit = (id: string) => {
      if (relationVisiting.has(id)) { fail("RELATION_CYCLE", `${at}.${id}`, "Layout relations form a cycle."); return; }
      if (relationDone.has(id)) return; relationVisiting.add(id);
      for (const relation of component.children.find(node => node.id === id)?.relations ?? []) if (relation.target && ids.has(relation.target)) relationVisit(relation.target);
      relationVisiting.delete(id); relationDone.add(id);
    };
    component.children.forEach(node => relationVisit(node.id));
  }
  if (totalObjects > 20000) fail("SCENE_OBJECT_LIMIT", "components", "Scene exceeds 20,000 template objects.");
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (key: string, depth: number) => {
    if (visiting.has(key)) { fail("COMPONENT_CYCLE", key, "Component/list/popup/scrollbar dependency cycle."); return; }
    if (depth > 32) { fail("COMPONENT_DEPTH", key, "Nested component depth exceeds 32."); return; }
    if (visited.has(key)) return;
    visiting.add(key); for (const ref of links.get(key) ?? []) if (components.has(ref)) visit(ref, depth + 1);
    visiting.delete(key); visited.add(key);
  };
  for (const component of scene.components) visit(component.id, 0);
  return { status: errors.length ? "failed" : "passed", errors, warnings, nativeImport: "not_verified", runtimeInteraction: "not_verified" };
}

export function parseScene(value: unknown): Scene {
  const report = validateScene(value); if (report.errors.length) throw new SceneError(report.errors);
  return SceneSchema.parse(value);
}

/** Intersection is kept in global canvas coordinates, including nested viewports. */
export function intersectRects(a: Rect | undefined, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}

export function orderedNodes(component: SceneComponent): SceneNode[] {
  return component.children.map((node, index) => ({ node, index })).sort((a, b) =>
    (a.node.z ?? a.index) - (b.node.z ?? b.index) || a.index - b.index).map(row => row.node);
}

/** Expand reusable components and list data only once. Both exporters consume this
 * canonical geometry; native XML keeps the templates at their maximum bar size.
 * No screenshots or generated images are analyzed in this deterministic stage.
 */
export function resolveScene(input: Scene, options: SceneResolveOptions = {}): ResolvedScene {
  const scene = parseScene(input), components = new Map(scene.components.map(component => [component.id, component]));
  const report = validateScene(scene);
  const result: ResolvedScene = { canvas: { ...scene.canvas }, layers: [], nodes: [], limitations: report.warnings.map(issue => `${issue.code}: ${issue.path}: ${issue.message}`) };
  let nextZ = 0;
  const cloneNode = (node: SceneNode): SceneNode => structuredClone(node);
  const limit = () => { if (result.nodes.length > 50000) throw new SceneError([{ code: "EXPANDED_OBJECT_LIMIT", path: "scene", message: "Repeated components expand beyond 50,000 objects." }]); };
  const nativeTitle = (definition: ComponentExtension["slider"] | ComponentExtension["progressBar"], instance: ComponentInstance): string => {
    const min = instance.min ?? 0, max = instance.max ?? 100, value = instance.value ?? 0;
    switch (definition?.titleType ?? "percent") {
      case "valueAndmax": return `${value}/${max}`;
      case "value": return String(value);
      case "max": return String(max);
      default: {
        const percentage = ((value - min) / (max - min)) * 100;
        if (!options.percentageRounding && !Number.isInteger(percentage)) result.limitations.push("Percent title rounding defaults to the inspected FairyEditor convention; actual runtime rounding was not provided for this scene resolution.");
        return `${options.percentageRounding === "floor" ? Math.floor(percentage) : Math.round(percentage)}%`;
      }
    }
  };
  const mutateText = (node: SceneNode, text: string) => {
    if (node.text !== text) delete node.referenceAssetId;
    node.text = text;
  };
  const applyProperty = (node: SceneNode, property: PropertyOverride) => {
    switch (property.property) {
      case "text": mutateText(node, String(property.value)); break;
      case "icon": node.assetId = String(property.value); break;
      case "color": if (node.style) { node.style.color = String(property.value); delete node.referenceAssetId; } break;
      case "fontSize": if (node.style) { node.style.fontSize = Number(property.value); delete node.referenceAssetId; } break;
    }
  };
  const selection = (component: SceneComponent, instance: ComponentInstance, parentControllers: Record<string, string>) => {
    const selected: Record<string, string> = Object.create(null);
    for (const controller of component.controllers ?? []) selected[controller.name] = instance.controllers && Object.hasOwn(instance.controllers, controller.name)
      ? instance.controllers[controller.name] : controller.selectedPageId;
    let checked = instance.checked ?? false;
    if (instance.relatedController) checked = parentControllers[instance.relatedController] === instance.relatedPageId;
    const button = component.controllers?.find(controller => controller.name === "button");
    if (button && (component.semantic === "Button" || component.semantic === "ComboBox")) {
      const target = button.pages.find(page => page.name === (checked ? "down" : "up"));
      if (target) selected.button = target.id;
    }
    return { selected, checked };
  };
  const applyRelations = (original: SceneNode[], values: SceneNode[]) => {
    const oldMap = new Map(original.map(node => [node.id, node]));
    const map = new Map(values.map(node => [node.id, node])); const seen = new Set<string>(), active = new Set<string>();
    const apply = (node: SceneNode) => {
      if (seen.has(node.id)) return;
      if (active.has(node.id)) throw new SceneError([{ code: "RELATION_CYCLE", path: node.id, message: "Cyclic layout relations cannot be resolved deterministically." }]);
      active.add(node.id);
      for (const relation of node.relations ?? []) {
        if (!relation.target) continue; // same-size component instances leave parent relations unchanged.
        const target = map.get(relation.target)!, baseline = oldMap.get(relation.target)!;
        apply(target);
        const dx = target.x - baseline.x, dy = target.y - baseline.y;
        const dw = target.width - baseline.width, dh = target.height - baseline.height;
        for (const pair of relation.sidePair.split(",")) {
          if (pair === "width" || pair === "width-width") { node.width += dw; continue; }
          if (pair === "height" || pair === "height-height") { node.height += dh; continue; }
          const [own, their] = pair.split("-");
          const vertical = ["top", "middle", "bottom"].some(key => own.startsWith(key));
          const delta = vertical ? dy + (their === "bottom" ? dh : their === "middle" ? dh / 2 : 0)
            : dx + (their === "right" ? dw : their === "center" ? dw / 2 : 0);
          if (own.includes("Ext")) {
            if (own.startsWith("left")) { node.x += delta; node.width -= delta; }
            if (own.startsWith("right")) node.width += delta;
            if (own.startsWith("top")) { node.y += delta; node.height -= delta; }
            if (own.startsWith("bottom")) node.height += delta;
          } else if (vertical) node.y += delta; else node.x += delta;
        }
      }
      active.delete(node.id); seen.add(node.id);
    };
    for (const node of values) apply(node);
  };
  type Context = { x: number; y: number; opacity: number; visible: boolean; path: string; parentId: string | null; groupPath: string[]; clip?: Rect; parentControllers: Record<string, string> };
  const scrollbar = (ref: string, rect: Rect, ctx: Context, fraction: number) => {
    const component = components.get(ref)!;
    const ratio = Math.max(0, Math.min(1, fraction));
    // Scrollbar is owned and positioned by its viewport, not an independent slider.
    result.nodes.push({ id: ctx.path, sourceId: component.id, name: component.name, type: "ScrollBar", componentId: component.id,
      parentId: ctx.path.slice(0, ctx.path.lastIndexOf("/@")), ...rect, localX: rect.x - ctx.x, localY: rect.y - ctx.y,
      opacity: ctx.opacity, visible: ctx.visible, z: nextZ++, groupPath: ctx.groupPath, ...(ctx.clip ? { clip: ctx.clip } : {}),
      targetFguiType: "GScrollBar", recognition: { basis: "Native ScrollBar resource explicitly associated with its owner viewport." } });
    walk(component, { ...ctx, x: rect.x, y: rect.y }, {}, { direction: rect.height > rect.width ? "vertical" : "horizontal", ratio, width: rect.width, height: rect.height });
  };
  const walk = (component: SceneComponent, ctx: Context, instance: ComponentInstance,
    scrollState?: { direction: "vertical" | "horizontal"; ratio: number; width: number; height: number }) => {
    const { selected, checked } = selection(component, instance, ctx.parentControllers);
    const children = orderedNodes(component).map(cloneNode);
    for (const node of children) {
      for (const gear of node.gears ?? []) {
        const page = selected[gear.controller];
        if (gear.kind === "display") { node.visible = node.visible !== false && gear.pages.includes(page); continue; }
        const value = Object.hasOwn(gear.values, page) ? gear.values[page] : gear.default; if (value === undefined) continue;
        switch (gear.kind) {
          case "xy": [node.x, node.y] = value as [number, number]; break;
          case "size": [node.width, node.height] = value as [number, number]; break;
          case "text": mutateText(node, String(value)); break;
          case "color": if (node.style) { node.style.color = String(value); delete node.referenceAssetId; } break;
          case "fontSize": if (node.style) { node.style.fontSize = Number(value); delete node.referenceAssetId; } break;
          case "icon": node.assetId = String(value); break;
        }
      }
      if (node.name === "title" && TEXT_TYPES.has(node.type)) {
        const title = checked ? instance.selectedTitle ?? instance.title : instance.title;
        if (title !== undefined) mutateText(node, title);
        if (instance.titleColor && node.style) { node.style.color = instance.titleColor; delete node.referenceAssetId; }
        if (instance.titleFontSize && node.style) { node.style.fontSize = instance.titleFontSize; delete node.referenceAssetId; }
      }
      if (node.name === "icon" && node.type === "Loader") {
        const icon = checked ? instance.selectedIconAssetId ?? instance.iconAssetId : instance.iconAssetId;
        if (icon) node.assetId = icon;
      }
      for (const property of instance.properties ?? []) {
        if (property.target === node.name) applyProperty(node, property);
        else if (property.target.startsWith(node.name + ".") && node.componentId) {
          node.instance ??= {}; node.instance.properties ??= [];
          node.instance.properties.push({ ...property, target: property.target.slice(node.name.length + 1) });
        }
      }
    }
    if (component.semantic === "Slider" || component.semantic === "ProgressBar") {
      const definition = component.semantic === "Slider" ? component.extension?.slider : component.extension?.progressBar;
      const bar = children.find(node => node.name === "bar" || node.name === "bar_v")!;
      const fraction = ((instance.value ?? 0) - (instance.min ?? 0)) / ((instance.max ?? 100) - (instance.min ?? 0));
      if (bar.name === "bar") { const full = bar.width; bar.width = Math.round(full * fraction); if (definition?.reverse) bar.x += full - bar.width; }
      else { const full = bar.height; bar.height = Math.round(full * fraction); if (definition?.reverse) bar.y += full - bar.height; }
      const title = children.find(node => node.name === "title" && TEXT_TYPES.has(node.type));
      if (title) mutateText(title, nativeTitle(definition, instance));
    }
    applyRelations(orderedNodes(component), children);
    if (scrollState) {
      const bar = children.find(node => node.name === "bar")!, grip = children.find(node => node.name === "grip")!;
      if (scrollState.direction === "vertical") {
        const delta = scrollState.height - component.height; bar.height += delta;
        if (!component.extension?.scrollBar?.fixedGripSize) grip.height = Math.floor(bar.height * scrollState.ratio);
        grip.y = bar.y;
      } else {
        const delta = scrollState.width - component.width; bar.width += delta;
        if (!component.extension?.scrollBar?.fixedGripSize) grip.width = Math.floor(bar.width * scrollState.ratio);
        grip.x = bar.x;
      }
      grip.visible = grip.visible !== false && scrollState.ratio > 0 && scrollState.ratio < 1;
    }
    const margin = component.margin ?? { top: 0, bottom: 0, left: 0, right: 0 };
    const ownerWidth = scrollState?.width ?? component.width, ownerHeight = scrollState?.height ?? component.height;
    const showBars = component.overflow === "scroll" && component.scrollBar === "visible";
    const vertical = showBars && component.verticalScrollBar ? components.get(component.verticalScrollBar) : undefined;
    const horizontal = showBars && component.horizontalScrollBar ? components.get(component.horizontalScrollBar) : undefined;
    const viewportRect = { x: ctx.x + margin.left, y: ctx.y + margin.top,
      width: Math.max(0, ownerWidth - margin.left - margin.right - (vertical?.width ?? 0)),
      height: Math.max(0, ownerHeight - margin.top - margin.bottom - (horizontal?.height ?? 0)) };
    const clip = component.overflow && component.overflow !== "visible" ? intersectRects(ctx.clip, viewportRect) : ctx.clip;
    for (const node of children) {
      limit();
      const group = node.groupId ? children.find(child => child.id === node.groupId) : undefined;
      const globalId = ctx.path + "/" + node.id;
      const effective: ResolvedNode = {
        id: globalId, sourceId: node.id, name: node.name, type: node.type, componentId: component.id,
        parentId: ctx.path, x: ctx.x + margin.left + node.x, y: ctx.y + margin.top + node.y,
        width: Math.max(0, node.width), height: Math.max(0, node.height), localX: node.x, localY: node.y,
        opacity: ctx.opacity * (node.alpha ?? 1) * (group?.alpha ?? 1), visible: ctx.visible && node.visible !== false && group?.visible !== false,
        z: nextZ++, groupPath: [...ctx.groupPath], ...(clip ? { clip } : {}),
        targetFguiType: FGUI_TARGET_TYPES[node.type], recognition: node.recognition ?? { basis: `Authored Scene type '${node.type}'; image-recognition evidence was not supplied.` },
        ...(node.instance ? { interaction: node.instance } : {}),
        ...(node.assetId ? { assetId: node.assetId } : {}), ...(node.text !== undefined ? { text: node.text } : {}),
        ...(node.style ? { style: node.style } : {}), ...(node.referenceAssetId ? { referenceAssetId: node.referenceAssetId } : {}),
        ...(node.loader ? { loader: node.loader } : {}), ...(node.input ? { input: node.input } : {}), ...(node.ubb ? { ubb: true } : {}),
        ...(node.groupId ? { groupId: node.groupId } : {}),
        ...(["bar", "bar_v", "grip", "title"].includes(node.name) && component.semantic !== "Component" ? { controlPart: node.name as ResolvedNode["controlPart"] } : {}),
      };
      result.nodes.push(effective);
      const childContext: Context = { x: effective.x, y: effective.y, opacity: effective.opacity, visible: effective.visible,
        path: globalId, parentId: ctx.path, groupPath: [...ctx.groupPath, `${node.name} [${node.id}]`], clip, parentControllers: selected };
      if (node.componentId) walk(components.get(node.componentId)!, childContext, node.instance ?? {});
      else if (node.type === "List" && node.list) {
        const list = node.list, lm = list.margin ?? { top: 0, bottom: 0, left: 0, right: 0 };
        const listVertical = list.scrollBar === "visible" && list.verticalScrollBar ? components.get(list.verticalScrollBar) : undefined;
        const listHorizontal = list.scrollBar === "visible" && list.horizontalScrollBar ? components.get(list.horizontalScrollBar) : undefined;
        const viewport = { x: effective.x + lm.left, y: effective.y + lm.top,
          width: Math.max(0, node.width - lm.left - lm.right - (listVertical?.width ?? 0)),
          height: Math.max(0, node.height - lm.top - lm.bottom - (listHorizontal?.height ?? 0)) };
        const listClip = list.overflow && list.overflow !== "visible" ? intersectRects(clip, viewport) : clip;
        let cursor = 0;
        for (const item of list.items) {
          const template = components.get(item.componentId ?? list.defaultItem)!;
          const itemPath = globalId + "/item:" + encodeURIComponent(item.name);
          const lx = list.layout === "row" ? cursor : 0, ly = list.layout === "column" ? cursor : 0;
          result.nodes.push({ id: itemPath, sourceId: template.id, name: item.name, type: template.semantic,
            componentId: template.id, parentId: globalId, x: viewport.x + lx, y: viewport.y + ly, width: template.width, height: template.height,
            localX: lx, localY: ly, opacity: effective.opacity, visible: effective.visible, z: nextZ++, groupPath: childContext.groupPath, ...(listClip ? { clip: listClip } : {}),
            targetFguiType: FGUI_TARGET_TYPES[template.semantic], recognition: { basis: "Reusable native List item with explicit per-instance data." }, interaction: item });
          walk(template, { ...childContext, x: viewport.x + lx, y: viewport.y + ly, path: itemPath,
            groupPath: [...childContext.groupPath, item.name], clip: listClip }, item);
          cursor += (list.layout === "column" ? template.height + (list.lineGap ?? 0) : template.width + (list.columnGap ?? 0));
        }
        if (list.items.length) cursor -= list.layout === "column" ? list.lineGap ?? 0 : list.columnGap ?? 0;
        if (listVertical) scrollbar(listVertical.id, { x: effective.x + node.width - listVertical.width, y: effective.y, width: listVertical.width, height: node.height },
          { ...childContext, path: globalId + "/@verticalScrollBar", clip }, viewport.height / Math.max(1, cursor));
        if (listHorizontal) scrollbar(listHorizontal.id, { x: effective.x, y: effective.y + node.height - listHorizontal.height, width: node.width, height: listHorizontal.height },
          { ...childContext, path: globalId + "/@horizontalScrollBar", clip }, viewport.width / Math.max(1, cursor));
      } else if (node.type !== "Group") result.layers.push(effective);
    }
    if (vertical) scrollbar(vertical.id, { x: ctx.x + ownerWidth - vertical.width, y: ctx.y, width: vertical.width, height: ownerHeight },
      { ...ctx, path: ctx.path + "/@verticalScrollBar" }, viewportRect.height / Math.max(1, ...children.map(node => node.y + node.height)));
    if (horizontal) scrollbar(horizontal.id, { x: ctx.x, y: ctx.y + ownerHeight - horizontal.height, width: ownerWidth, height: horizontal.height },
      { ...ctx, path: ctx.path + "/@horizontalScrollBar" }, viewportRect.width / Math.max(1, ...children.map(node => node.x + node.width)));
  };
  result.nodes.push({ id: scene.entry, sourceId: scene.entry, name: components.get(scene.entry)!.name, type: "Component", componentId: scene.entry,
    parentId: null, x: 0, y: 0, ...scene.canvas, localX: 0, localY: 0, opacity: 1, visible: true, z: nextZ++, groupPath: [],
    targetFguiType: "GComponent", recognition: { basis: "Explicit scene entry component and full design canvas." } });
  walk(components.get(scene.entry)!, { x: 0, y: 0, opacity: 1, visible: true, path: scene.entry,
    parentId: null, groupPath: [], clip: { x: 0, y: 0, ...scene.canvas }, parentControllers: {} }, {});
  return result;
}
