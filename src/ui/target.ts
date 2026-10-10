import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { Workspace } from "../workspace/manager.js";

export type TargetFeature = "Component" | "Image" | "Loader" | "Text" | "RichText" | "InputText" | "Button" | "Slider" | "ProgressBar" | "ScrollBar" | "List" | "ComboBox" | "Group" | "Controller" | "Gear" | "Relation" | "NineSlice" | "Font";
export interface TargetLimits { files?: number; totalBytes?: number; fileBytes?: number; xmlBytes?: number; xmlDepth?: number; objects?: number; serializedBytes?: number }
export interface TargetEvidence {
  path: string; sha256: string; bytes: number; kind: "project" | "package" | "component" | "settings" | "source" | "runtime";
  features: TargetFeature[]; note?: string;
}
export interface TargetProfile {
  schemaVersion: 1; id: string; inspectedAt: string; workspaceId: string; requestedPath: string;
  status: "ready" | "needs_selection" | "unsupported";
  adapter: "fairygui-source-5.0-v1";
  project?: { file: string; root: string; id: string; type: string; version: string; sha256: string };
  candidates: string[];
  capabilities: { confirmed: TargetFeature[]; unconfirmed: TargetFeature[]; notes: string[] };
  limits: TargetLimits;
  evidence: TargetEvidence[];
  /** Bounded copies of actual target samples; not synthesized source format examples. */
  snapshots: { projectXml?: string; packages: { path: string; xml: string }[]; components: { path: string; xml: string }[];
    settings: { path: string; json: unknown }[] };
  runtime?: { profileId?: string; pins?: unknown };
  rendering?: { percentageRounding?: "floor" | "round"; evidence?: string[] };
  notes: string[];
  checks: { staticResearch: "passed" | "incomplete"; editorImport: "not_verified"; runtimeInteraction: "not_verified" };
}

export const XML_OPTIONS = { ignoreAttributes: false, attributeNamePrefix: "@_", parseAttributeValue: false, parseTagValue: false, trimValues: false, processEntities: true, allowBooleanAttributes: false } as const;
export function parseNativeXml(xml: string, source: string): Record<string, any> {
  if (Buffer.byteLength(xml, "utf8") > 2 * 1024 * 1024 || /<!\s*(?:DOCTYPE|ENTITY)/i.test(xml))
    throw new Error(`Unsafe or oversized XML: ${source}`);
  const result = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (result !== true) throw new Error(`Invalid XML ${source}: ${result.err.msg}`);
  return new XMLParser(XML_OPTIONS).parse(xml) as Record<string, any>;
}
export const asArray = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const sha = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const allFeatures: TargetFeature[] = ["Component", "Image", "Loader", "Text", "RichText", "InputText", "Button", "Slider", "ProgressBar", "ScrollBar", "List", "ComboBox", "Group", "Controller", "Gear", "Relation", "NineSlice", "Font"];
const ignoredDirs = new Set(["node_modules", ".git", "Library", "Temp", "Logs", "obj", "bin", "dist", "Builds", "evidence", "analysis-r002", "analysis-r001"]);

async function readBounded(workspace: Workspace, requested: string, max = 2 * 1024 * 1024): Promise<{ rel: string; bytes: Buffer; text: string } | undefined> {
  let resolved: { abs: string; rel: string };
  try { resolved = workspace.resolve(requested); } catch { return undefined; }
  let handle;
  try { handle = await fs.open(resolved.abs, "r"); } catch { return undefined; }
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > max) return undefined;
    const bytes = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < bytes.length) { const part = await handle.read(bytes, length, bytes.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
    if (length > stat.size) throw new Error("Target source changed while reading; retry inspection.");
    const body = bytes.subarray(0, length);
    return { rel: resolved.rel, bytes: body, text: new TextDecoder("utf-8", { fatal: true }).decode(body) };
  } finally { await handle.close(); }
}

async function discoverProjects(workspace: Workspace, requested: string): Promise<string[]> {
  const root = workspace.resolve(requested); const matches: string[] = []; let visited = 0;
  const walk = async (relative: string, depth: number) => {
    if (depth > 6 || visited++ > 1200 || matches.length > 100) return;
    let entries; try { entries = await fs.readdir(workspace.resolve(relative).abs, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const child = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isFile() && entry.name.endsWith(".fairy")) matches.push(child);
      else if (entry.isDirectory() && !ignoredDirs.has(entry.name) && !entry.name.startsWith(".")) await walk(child, depth + 1);
    }
  };
  await walk(root.rel, 0); return matches.sort();
}

function featuresInXml(xml: string): TargetFeature[] {
  const found = new Set<TargetFeature>();
  const tags: [RegExp, TargetFeature][] = [
    [/<component(?:\s|>)/, "Component"], [/<image(?:\s|\/|>)/, "Image"], [/<loader(?:\s|\/|>)/, "Loader"],
    [/<text(?:\s|\/|>)/, "Text"], [/<richtext(?:\s|\/|>)/, "RichText"], [/<text\b[^>]*\binput="true"/, "InputText"],
    [/<list(?:\s|\/|>)/, "List"], [/<group(?:\s|\/|>)/, "Group"], [/<controller(?:\s|\/|>)/, "Controller"],
    [/<gear(?:Display|XY|Size|Color|Text|Icon|FontSize)\b/, "Gear"], [/<relation(?:\s|\/|>)/, "Relation"],
    [/\bscale9grid=/, "NineSlice"], [/<font(?:\s|\/|>)/, "Font"],
  ];
  for (const [pattern, feature] of tags) if (pattern.test(xml)) found.add(feature);
  for (const semantic of ["Button", "Slider", "ProgressBar", "ScrollBar", "ComboBox"] as const)
    if (new RegExp(`\\bextention=["']${semantic}["']`).test(xml) && new RegExp(`<${semantic}(?:\\s|/|>)`).test(xml)) found.add(semantic);
  return [...found];
}

/** Read-only inspection of the explicitly chosen source project. A directory
 * containing several nested demo projects never silently chooses a platform.
 * The target parser, settings and sample source are fingerprinted as evidence;
 * this function cannot turn static research into an import/runtime pass.
 */
export async function inspectTarget(workspace: Workspace, relativePath: string): Promise<TargetProfile> {
  const selected = workspace.resolve(relativePath); const stat = await fs.stat(selected.abs);
  const profile: TargetProfile = {
    schemaVersion: 1, id: "", inspectedAt: new Date().toISOString(), workspaceId: workspace.id, requestedPath: selected.rel,
    status: "needs_selection", adapter: "fairygui-source-5.0-v1", candidates: [],
    capabilities: { confirmed: [], unconfirmed: [...allFeatures], notes: [] }, limits: {}, evidence: [],
    snapshots: { packages: [], components: [], settings: [] }, notes: [],
    checks: { staticResearch: "incomplete", editorImport: "not_verified", runtimeInteraction: "not_verified" },
  };
  const confirmed = new Set<TargetFeature>();
  const evidence = (file: NonNullable<Awaited<ReturnType<typeof readBounded>>>, kind: TargetEvidence["kind"], features: TargetFeature[], note?: string) => {
    const existing = profile.evidence.find(row => row.path === file.rel);
    if (!existing) profile.evidence.push({ path: file.rel, sha256: sha(file.bytes), bytes: file.bytes.length, kind, features, ...(note ? { note } : {}) });
    features.forEach(feature => confirmed.add(feature));
  };
  let projectFile: string | undefined;
  if (stat.isFile()) {
    if (!selected.rel.endsWith(".fairy")) throw new Error("Target must be an actual .fairy source project or its directory.");
    projectFile = selected.rel; profile.candidates = [projectFile];
  } else if (stat.isDirectory()) {
    const direct = (await fs.readdir(selected.abs, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith(".fairy"))
      .map(entry => (selected.rel ? selected.rel + "/" : "") + entry.name);
    if (direct.length === 1) projectFile = direct[0];
    profile.candidates = direct.length ? direct : await discoverProjects(workspace, selected.rel);
    if (!projectFile) profile.notes.push("Select the actual .fairy project file. Nested samples are candidates only; platform/version is not inferred from their names.");
  } else throw new Error("Target is not a regular source project file/directory.");

  if (projectFile) {
    const file = await readBounded(workspace, projectFile); if (!file) throw new Error("Cannot read target .fairy project.");
    const parsed = parseNativeXml(file.text, file.rel); const root = parsed.projectDescription;
    if (!root || typeof root !== "object" || typeof root["@_id"] !== "string" || typeof root["@_type"] !== "string" || typeof root["@_version"] !== "string")
      throw new Error("Target .fairy must contain a projectDescription with id, type and version.");
    const rootDir = path.posix.dirname(file.rel) === "." ? "" : path.posix.dirname(file.rel);
    profile.project = { file: file.rel, root: rootDir, id: root["@_id"], type: root["@_type"], version: root["@_version"], sha256: sha(file.bytes) };
    profile.snapshots.projectXml = file.text; evidence(file, "project", []);
    profile.status = ["Layabox", "Unity"].includes(profile.project.type) && profile.project.version === "5.0" ? "ready" : "unsupported";
    if (profile.status === "unsupported") profile.notes.push(`No verified exporter adapter for ${profile.project.type}/${profile.project.version}. Add a format adapter based on that target's source; do not change its parser.`);
    const assetsDir = rootDir ? rootDir + "/assets" : "assets";
    let packages: string[] = [];
    try { packages = (await fs.readdir(workspace.resolve(assetsDir).abs, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => assetsDir + "/" + entry.name); } catch { /* new target may have no assets */ }
    for (const packageDir of packages.sort().slice(0, 16)) {
      const file = await readBounded(workspace, packageDir + "/package.xml", 256 * 1024); if (!file) continue;
      const root = parseNativeXml(file.text, file.rel).packageDescription;
      if (!root || !root.resources) { profile.notes.push(`Invalid or empty resource registry: ${file.rel}`); continue; }
      profile.snapshots.packages.push({ path: file.rel, xml: file.text }); evidence(file, "package", featuresInXml(file.text));
      for (const resource of asArray<Record<string, any>>(root.resources.component)) {
        if (profile.snapshots.components.length >= 32) break;
        const rawName = resource["@_name"], rawPath = resource["@_path"] ?? "/";
        if (typeof rawName !== "string" || /[\\/]/.test(rawName) || typeof rawPath !== "string") continue;
        // Resource paths are package-local. Resolve containment again before reading.
        const relative = packageDir + "/" + rawPath.replace(/^\/+|\/+$/g, "") + "/" + rawName;
        const normalized = path.posix.normalize(relative);
        if (!normalized.startsWith(packageDir + "/")) continue;
        const sample = await readBounded(workspace, normalized, 256 * 1024); if (!sample) continue;
        try { parseNativeXml(sample.text, sample.rel); } catch { continue; }
        profile.snapshots.components.push({ path: sample.rel, xml: sample.text }); evidence(sample, "component", featuresInXml(sample.text));
      }
    }
    const settingsDir = rootDir ? rootDir + "/settings" : "settings";
    let settings: string[] = [];
    try { settings = (await fs.readdir(workspace.resolve(settingsDir).abs, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith(".json")).map(entry => settingsDir + "/" + entry.name); } catch { /* optional */ }
    for (const filename of settings.sort().slice(0, 16)) {
      const setting = await readBounded(workspace, filename, 128 * 1024); if (!setting) continue;
      try { const json = JSON.parse(setting.text); profile.snapshots.settings.push({ path: setting.rel, json }); evidence(setting, "settings", []); }
      catch { profile.notes.push(`Setting is not supported JSON: ${filename}`); }
    }
  }
  const sourceKinds: [string, TargetFeature[]][] = [
    ["FProject.cs", []], ["FPackage.cs", ["Font"]], ["FPackageItem.cs", []], ["FComponent.cs", ["Component", "Group"]],
    ["FObject.cs", ["Image"]], ["FTextField.cs", ["Text", "RichText"]], ["FTextInput.cs", ["InputText"]], ["FLoader.cs", ["Loader"]],
    ["FButton.cs", ["Button"]], ["FSlider.cs", ["Slider"]], ["FProgressBar.cs", ["ProgressBar"]], ["FScrollBar.cs", ["ScrollBar"]],
    ["FList.cs", ["List"]], ["FComboBox.cs", ["ComboBox"]], ["FController.cs", ["Controller"]], ["FRelations.cs", ["Relation"]],
    ["ImageAsset.cs", ["NineSlice"]], ["ComponentTemplates.cs", []],
  ];
  const sourceRoots = new Set(["FguiProject/Assets/Scripts/Assembly-CSharp/FairyEditor", "Assets/Scripts/Assembly-CSharp/FairyEditor",
    ...(stat.isDirectory() ? [selected.rel + "/Assets/Scripts/Assembly-CSharp/FairyEditor"] : [])]);
  for (const [filename, features] of sourceKinds) {
    for (const sourceRoot of sourceRoots) {
      const source = await readBounded(workspace, sourceRoot + "/" + filename); if (!source) continue;
      if (/\b(?:Read|Write)[A-Za-z0-9_]*\s*\(/.test(source.text))
        evidence(source, "source", features, "Actual target FairyEditor source; schema writers/readers are fingerprinted for this inspection.");
      else evidence(source, "source", [], "Source found, but its serialization methods were not detected; capability remains unconfirmed.");
      break;
    }
  }
  const importerSources: [string, TargetFeature[]][] = [
    ["MagicGameClient/src/app/game-ui/fgui/codec/component-xml.ts", ["Component", "Image", "Text", "RichText", "Group", "Loader", "Relation"]],
    ["MagicGameClient/src/app/game-ui/fgui/codec/source-control-xml.ts", ["Button", "Slider", "ProgressBar", "Controller", "Gear"]],
    ["MagicGameClient/src/app/game-ui/fgui/codec/source-collections-xml.ts", ["List", "ComboBox", "ScrollBar"]],
    ["MagicGameClient/src/app/game-ui/fgui/domain/source-project-loader.ts", ["Font", "NineSlice"]],
    ["MagicGameClient/src/app/game-ui/fgui/domain/source-project-importer.ts", []],
    ["MagicGameClient/src/app/game-ui/fgui/domain/source-project-export.ts", []],
    ["MagicGameClient/src/app/game-ui/fgui/domain/source-runtime-scene.ts", []],
    ["MagicGameClient/src/app/game-ui/fgui/domain/source-collections-importer.ts", []],
    ["MagicGameClient/src/app/game-ui/fgui/domain/source-gear-hydration.ts", []],
    ["MagicGameClient/src/app/game-ui/fgui/domain/source-property-declaration-guards.ts", []],
    ["MagicGameClient/src/app/game-ui/fgui/domain/source-font-import.ts", []],
    ["MagicGameClient/src/app/game-ui/fgui/domain/source-font-bundles.ts", []],
    ["MagicGameClient/src/app/game-ui/contracts/source-project.ts", []],
  ];
  for (const [filename, features] of importerSources) {
    const file = await readBounded(workspace, filename); if (!file) continue;
    evidence(file, "source", features, "Current custom source-project importer/serializer; never modified by this workflow.");
    if (filename.endsWith("/source-project.ts")) {
      const declaration = /SOURCE_PROJECT_LIMITS\s*=\s*(?:Object\.freeze\s*\()?\s*\{([^}]+)\}/.exec(file.text)?.[1];
      if (declaration) for (const key of ["files", "totalBytes", "fileBytes", "xmlBytes", "xmlDepth", "objects", "serializedBytes"] as const) {
        const raw = new RegExp(`\\b${key}\\s*:\\s*([0-9_]+)`).exec(declaration)?.[1];
        if (raw) profile.limits[key] = Number(raw.replaceAll("_", ""));
      }
    }
  }
  for (const filename of ["FguiProject/Implementation/runtime-lock.json", "Implementation/runtime-lock.json"]) {
    const runtime = await readBounded(workspace, filename); if (!runtime) continue;
    try { const json = JSON.parse(runtime.text); profile.runtime = { ...(typeof json.profileId === "string" ? { profileId: json.profileId } : {}), ...(json.sourcePins ? { pins: json.sourcePins } : {}) };
      evidence(runtime, "runtime", [], "Runtime lock is recorded separately from the selected .fairy source platform/version.");
    } catch { profile.notes.push("Runtime lock could not be parsed; no runtime platform inferred."); }
    break;
  }
  for (const filename of ["MagicGameClient/tools/game-ui/dependencies.json", "MagicGameClient/tools/game-ui/fixed-runtime-source.mjs",
    "MagicGameClient/tools/game-ui/sdk-text-shadow-patch.mjs", "MagicGameClient/tools/game-ui/sdk-text-strike-patch.mjs"]) {
    const file = await readBounded(workspace, filename); if (!file) continue;
    evidence(file, "runtime", [], "Actual client runtime dependency lock/build input, fingerprinted independently of the selected source-project location.");
    if (!profile.runtime && filename.endsWith("/dependencies.json")) {
      try { const json = JSON.parse(file.text); profile.runtime = { ...(typeof json.profileId === "string" ? { profileId: json.profileId } : {}), pins: { laya: json.laya, fgui: json.fgui } }; }
      catch { profile.notes.push("Client runtime dependency lock could not be parsed."); }
    }
  }
  // Runtime pixel conventions are separate from editor source-XML vocabulary.
  // These files are also fingerprinted so a changed SDK cannot reuse a stale
  // source profile merely because runtime-lock.json was left unchanged.
  const runtimePercentageEvidence: string[] = [];
  for (const filename of ["GSlider.ts", "GProgressBar.ts", "GLoader.ts", "GScrollBar.ts", "ScrollPane.ts", "GButton.ts", "GList.ts", "Controller.ts"]) {
    const source = await readBounded(workspace, "FguiProject/PRD/FairyGUI-layabox/source/src/fairygui/" + filename);
    if (!source) continue;
    evidence(source, "source", [], "Actual target SDK source for initial geometry/interaction conventions; runtime classes are not used as source XML tags.");
    if ((filename === "GSlider.ts" || filename === "GProgressBar.ts") && /Math\.floor\(percent\s*\*\s*100\)/.test(source.text)) runtimePercentageEvidence.push(source.rel);
  }
  if (profile.project?.type === "Layabox" && runtimePercentageEvidence.length === 2) profile.rendering = { percentageRounding: "floor", evidence: runtimePercentageEvidence };
  profile.capabilities.confirmed = allFeatures.filter(feature => confirmed.has(feature));
  profile.capabilities.unconfirmed = allFeatures.filter(feature => !confirmed.has(feature));
  if (!profile.evidence.some(row => row.kind === "source")) profile.capabilities.notes.push("No custom importer source was found at the recognized project paths. Samples confirm only observed features; extra importer limits remain unverified.");
  if (Object.keys(profile.limits).length === 0) profile.notes.push("No target SOURCE_PROJECT_LIMITS declaration was discovered. Only workflow safety limits can be checked until the actual importer is supplied.");
  if (profile.status === "ready" && !profile.snapshots.packages.length && !confirmed.has("Component")) {
    profile.status = "unsupported"; profile.notes.push("No actual package/component samples or serializer source were found. Format research is incomplete.");
  }
  profile.checks.staticResearch = profile.status === "ready" ? "passed" : "incomplete";
  profile.id = "target_" + sha(JSON.stringify({ project: profile.project, evidence: profile.evidence, limits: profile.limits, rendering: profile.rendering })).slice(0, 16);
  return profile;
}

/** Recheck the recorded files before generating XML. Stale profiles must be
 * inspected again instead of silently exporting against a different parser.
 */
export async function verifyTargetProfile(workspace: Workspace, profile: TargetProfile): Promise<void> {
  if (profile.workspaceId !== workspace.id) throw new Error("Target profile belongs to a different connected workspace.");
  for (const row of profile.evidence) {
    const file = await readBounded(workspace, row.path);
    if (!file || sha(file.bytes) !== row.sha256) throw new Error(`TARGET_PROFILE_STALE: ${row.path}. Re-run target inspection.`);
  }
}
