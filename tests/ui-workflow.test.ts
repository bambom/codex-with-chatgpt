import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import {
  createJob, getJob, beginUpload, uploadChunk, finishUpload, abortUpload, importFile,
  inspectTarget, setScene, buildJob, deliverJob, readArtifactChunk, readArtifactImage,
} from "../src/ui/workflow.js";
import { addDestination } from "../src/ui/destinations.js";
import { containedPath, jobRoot, safeRelative, sha256, withLock } from "../src/ui/storage.js";
import type { Scene } from "../src/ui/scene.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let temporary: string;
let workspace: Workspace;

async function png(width = 128, height = 96) {
  return sharp({ create: { width, height, channels: 4, background: { r: 35, g: 77, b: 101, alpha: 0.75 } } }).png().toBuffer();
}

async function file(relative: string, content: string | Buffer) {
  const output = path.join(workspace.root, relative);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, content);
}

function fixtureScene(): Scene {
  return {
    schemaVersion: 1, id: "inventory-screen", name: "Inventory panel", canvas: { width: 128, height: 96 }, entry: "screen",
    assets: [{ id: "panel", file: "art/panel.png", width: 128, height: 96, provenance: "Synthetic translucent regression fixture" }],
    fonts: [{ id: "font", file: "fonts/ui.ttf", family: "Chronicle UI", licenseFile: "fonts/OFL.txt" }],
    assumptions: ["The empty business callback is deliberately not implemented."],
    components: [
      { id: "action", name: "Choice", semantic: "Button", width: 50, height: 24, extension: { button: { mode: "Check" } },
        controllers: [{ name: "button", pages: [{ id: "0", name: "up" }, { id: "1", name: "down" }], selectedPageId: "0" }],
        children: [
          { id: "skin", name: "skin", type: "Image", assetId: "panel", x: 0, y: 0, width: 50, height: 24, touchable: false },
          { id: "label", name: "title", type: "Text", text: "42", style: { fontId: "font", fontSize: 14, color: "#ffffff", align: "center", vAlign: "middle", autoSize: "none" }, x: 0, y: 0, width: 50, height: 24, touchable: false },
        ] },
      { id: "screen", name: "Inventory", semantic: "Component", width: 128, height: 96,
        children: [
          { id: "background", name: "Panel", type: "Image", assetId: "panel", x: 0, y: 0, width: 128, height: 96 },
          { id: "choose", name: "Choose", type: "Button", componentId: "action", x: 4, y: 4, width: 50, height: 24, instance: { checked: true }, bindings: [{ event: "click", status: "unbound" }] },
          { id: "quantity", name: "Quantity", type: "InputText", text: "28", input: { maxLength: 3, restrict: "0-9" }, style: { fontId: "font", fontSize: 14, color: "#ffffff", autoSize: "none" }, x: 12, y: 46, width: 70, height: 20 },
        ] },
    ],
  };
}

async function readyJob() {
  await file("master.png", await png());
  await file("target/App.fairy", '<projectDescription id="actual123" type="Unity" version="5.0"/>');
  await file("target/assets/Existing/package.xml", '<packageDescription id="exist001"><resources><image id="img001" name="panel.png" path="/"/><font id="font001" name="font.ttf" path="/"/><component id="comp001" name="Sample.xml" path="/" exported="true"/></resources></packageDescription>');
  await file("target/assets/Existing/Sample.xml", '<component size="128,96" extention="Button"><controller name="button" pages="0,up,1,down"/><displayList><image id="n0" name="skin" xy="0,0" size="128,96" src="img001" fileName="panel.png"/><text id="n1" name="title" xy="0,0" size="50,24" text="42"/><text id="n2" name="input" xy="0,30" size="50,24" input="true" text="28"/></displayList><Button mode="Check"/></component>');
  await file("font.ttf", await fs.readFile(path.join(repository, "tests/fixtures/fonts/ChronicleUI-Regular.ttf")));
  await file("OFL.txt", await fs.readFile(path.join(repository, "tests/fixtures/fonts/OFL.txt")));
  let job = await createJob(workspace, { name: "Inventory test", designFile: "master.png", targetProject: "target/App.fairy" });
  job = await importFile(workspace, job.id, { sourcePath: "master.png", path: "art/panel.png", role: "asset" });
  job = await importFile(workspace, job.id, { sourcePath: "font.ttf", path: "fonts/ui.ttf", role: "font" });
  job = await importFile(workspace, job.id, { sourcePath: "OFL.txt", path: "fonts/OFL.txt", role: "license" });
  job = (await inspectTarget(workspace, job.id)).job;
  job = (await setScene(workspace, job.id, { scene: fixtureScene(), expectedRevision: job.revision })).job;
  return job;
}

beforeEach(async () => {
  temporary = makeTmpDir("ui-workflow");
  await fs.mkdir(path.join(temporary, "workspace"));
  vi.stubEnv("C2C_STATE_DIR", path.join(temporary, "state"));
  workspace = new Workspace(path.join(temporary, "workspace"));
});
afterEach(() => { vi.unstubAllEnvs(); cleanup(temporary); });

describe("persistent binary input workflow", () => {
  it("resumes a job across server instances and retries identical overlapping chunks", async () => {
    const job = await createJob(workspace, { name: "Interrupted upload" });
    const data = await png(23, 19);
    const upload = await beginUpload(workspace, job.id, { path: "art/cloud.png", role: "asset", sizeBytes: data.length, sha256: sha256(data) });
    const first = data.subarray(0, 40);
    expect((await uploadChunk(workspace, job.id, { uploadId: upload.uploadId, offset: 0, dataBase64: first.toString("base64") })).nextOffset).toBe(40);
    workspace = new Workspace(workspace.root);
    expect((await beginUpload(workspace, job.id, { path: "art/cloud.png", role: "asset", sizeBytes: data.length, sha256: sha256(data) })).nextOffset).toBe(40);
    expect((await uploadChunk(workspace, job.id, { uploadId: upload.uploadId, offset: 0, dataBase64: first.toString("base64") })).nextOffset).toBe(40);
    await uploadChunk(workspace, job.id, { uploadId: upload.uploadId, offset: 30, dataBase64: data.subarray(30).toString("base64"), sha256: sha256(data.subarray(30)) });
    const completed = await finishUpload(workspace, job.id, upload.uploadId);
    expect(completed.files).toHaveLength(1);
    expect(completed.files[0]).toMatchObject({ path: "art/cloud.png", width: 23, height: 19, sha256: sha256(data) });
    expect((await finishUpload(workspace, job.id, upload.uploadId)).revision).toBe(completed.revision);
  });

  it("does not publish corrupt or conflicting upload bytes, and permits abort/retry", async () => {
    const job = await createJob(workspace, { name: "Hash validation" });
    const data = await png(3, 3);
    const upload = await beginUpload(workspace, job.id, { path: "wrong.png", role: "asset", sizeBytes: data.length, sha256: "0".repeat(64) });
    await uploadChunk(workspace, job.id, { uploadId: upload.uploadId, offset: 0, dataBase64: data.toString("base64") });
    await expect(uploadChunk(workspace, job.id, { uploadId: upload.uploadId, offset: 0, dataBase64: Buffer.alloc(10, 3).toString("base64") })).rejects.toMatchObject({ code: "CHUNK_CONFLICT" });
    await expect(finishUpload(workspace, job.id, upload.uploadId)).rejects.toMatchObject({ code: "HASH_MISMATCH" });
    expect((await getJob(workspace, job.id)).files).toHaveLength(0);
    await abortUpload(workspace, job.id, upload.uploadId);
    expect((await beginUpload(workspace, job.id, { path: "wrong.png", role: "asset", sizeBytes: data.length, sha256: sha256(data) })).nextOffset).toBe(0);
  });

  it("recovers exact copied input bytes left by a crash before manifest commit", async () => {
    const job = await createJob(workspace, { name: "Recover copied input" });
    const data = await png(4, 4);
    await file("source.png", data);
    const root = await jobRoot(workspace, job.id);
    await fs.writeFile(path.join(root, "inputs", "panel.png"), data);
    const result = await importFile(workspace, job.id, { sourcePath: "source.png", path: "panel.png", role: "asset" });
    expect(result.files[0].sha256).toBe(sha256(data));
  });

  it("rejects traversal, Windows special paths and symlink escapes without changing files", async () => {
    for (const name of ["../out.png", "C:\\out.png", "//host/share", "a:stream", "CON.txt", "a/../b", "a/evil.", ".git/config"]) expect(() => safeRelative(name)).toThrow();
    const root = path.join(temporary, "managed"), outside = path.join(temporary, "outside");
    await fs.mkdir(root); await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(containedPath(root, "escape/stolen.png")).rejects.toMatchObject({ code: "UNSAFE_SYMLINK" });
    const job = await createJob(workspace, { name: "Scoped import" });
    await expect(importFile(workspace, job.id, { sourcePath: "../../outside.png", path: "image.png", role: "asset" })).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  });

  it("holds a cross-request lock while allowing status to be read", async () => {
    const job = await createJob(workspace, { name: "Lock test" });
    const root = await jobRoot(workspace, job.id);
    await withLock(root, async () => {
      expect((await getJob(workspace, job.id)).id).toBe(job.id);
      await expect(withLock(root, async () => 42)).rejects.toMatchObject({ code: "JOB_BUSY" });
    });
    expect(await withLock(root, async () => 42)).toBe(42);
  });
});

describe("complete delivery from one semantic layout", () => {
  it("builds real PSD/PNG/native XML and saves an idempotent verified copy to a configured computer directory", async () => {
    const prepared = await readyJob();
    const built = await buildJob(workspace, prepared.id, { expectedRevision: prepared.revision });
    expect(built.checks).toEqual({ static: "passed", psd: "passed", editorImport: "not_verified", runtimeInteraction: "not_verified" });
    expect(built.artifacts.map((a) => a.path)).toEqual(expect.arrayContaining(["Interface.psd", "PNG_Assets.zip", "FGUI_Source.zip", "ui_semantics.json", "Previews/PSD_Composite.png"]));
    expect((await buildJob(workspace, prepared.id, { expectedRevision: prepared.revision })).artifacts).toEqual(built.artifacts);
    const root = await jobRoot(workspace, prepared.id);
    const stored = JSON.parse(await fs.readFile(path.join(root, "job.json"), "utf8"));
    const buildRoot = path.join(root, stored.buildDirectory);
    const xmlFiles = unzipSync(await fs.readFile(path.join(buildRoot, "FGUI_Source.zip")));
    const projectName = Object.keys(xmlFiles).find((name) => name.endsWith(".fairy"))!;
    expect(Buffer.from(xmlFiles[projectName]).toString()).toContain('type="Unity"');
    const allXml = Object.entries(xmlFiles).filter(([name]) => name.endsWith(".xml")).map(([, value]) => Buffer.from(value).toString()).join("\n");
    expect(allXml).toContain('extention="Button"');
    expect(allXml).toContain('mode="Check"');
    expect(allXml).toContain('input="true"');
    const layoutText = await fs.readFile(path.join(buildRoot, "layout.json"), "utf8");
    expect(layoutText).not.toContain("staging-");
    expect(layoutText).toContain('"sceneInputRoot": "Inputs"');
    const chunk = await readArtifactChunk(workspace, prepared.id, { path: "Interface.psd", offset: 0, length: 4 });
    expect(Buffer.from(chunk.dataBase64, "base64").toString()).toBe("8BPS");
    const preview = await readArtifactImage(workspace, prepared.id, { path: "Previews/PSD_Composite.png" });
    expect(preview.mimeType).toBe("image/png");
    const external = path.join(temporary, "chosen-output");
    await addDestination(workspace, { id: "art-work", path: external });
    const receipt = await deliverJob(workspace, prepared.id, { destinationId: "art-work", subdirectory: "Inventory/final" });
    expect(receipt.directory).toBe(path.join(external, "Inventory", "final"));
    expect((await fs.readFile(path.join(receipt.directory, "Interface.psd"))).subarray(0, 4).toString()).toBe("8BPS");
    expect(await deliverJob(workspace, prepared.id, { destinationId: "art-work", subdirectory: "Inventory/final" })).toEqual(receipt);
    await fs.appendFile(path.join(receipt.directory, "README.txt"), "User note\n");
    await expect(deliverJob(workspace, prepared.id, { destinationId: "art-work", subdirectory: "Inventory/final" })).rejects.toMatchObject({ code: "DELIVERY_CHANGED" });
    expect(await fs.readFile(path.join(receipt.directory, "README.txt"), "utf8")).toContain("User note");
  });

  it("rejects stale target source, stale revisions and existing output directories", async () => {
    const job = await readyJob();
    await expect(setScene(workspace, job.id, { scene: fixtureScene(), expectedRevision: job.revision - 1 })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await fs.appendFile(path.join(workspace.root, "target/App.fairy"), "\n<!-- external change -->");
    await expect(buildJob(workspace, job.id, { expectedRevision: job.revision })).rejects.toThrow("TARGET_PROFILE_STALE");
    expect((await getJob(workspace, job.id)).artifacts).toHaveLength(0);
    const refreshed = (await inspectTarget(workspace, job.id)).job;
    const built = await buildJob(workspace, job.id, { expectedRevision: refreshed.revision });
    const output = path.join(workspace.root, "generated/ui-deliveries/occupied");
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, "keep.txt"), "existing work");
    await expect(deliverJob(workspace, built.id, { subdirectory: "occupied" })).rejects.toMatchObject({ code: "DELIVERY_CONFLICT" });
    expect(await fs.readFile(path.join(output, "keep.txt"), "utf8")).toBe("existing work");
  });
});
