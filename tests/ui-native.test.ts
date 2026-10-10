import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { addNativeAdapter, runNativeValidation } from "../src/ui/native.js";
import { hashFile, jobRoot } from "../src/ui/storage.js";
import {
  buildJob, createJob, deliverJob, getJob, importFile, inspectTarget,
  inventoryArtifacts, readWorkflowJob, setScene, type JobSummary,
} from "../src/ui/workflow.js";
import { cleanup, makeTmpDir } from "./helpers.js";

let temporary: string;
let workspace: Workspace;
let built: JobSummary;
let script: string;

/** Protocol fixture only. It deliberately synthesizes stage reports and copies a
 * fixture PNG; it does not launch FairyGUI or claim real editor/runtime testing. */
const adapterSource = `
import fs from "node:fs/promises";
import path from "node:path";
const [mode, requestFile] = process.argv.slice(2);
const request = JSON.parse(await fs.readFile(requestFile, "utf8"));
await fs.writeFile(path.join(request.workspaceRoot, "protocol-invocation.json"), JSON.stringify({
  mode, expectedInteractions: request.expectedInteractions, sourceDirectory: request.sourceDirectory,
  sourceZip: request.sourceZip, jobId: request.jobId
}));
if (mode === "exit") process.exit(17);
const report = {
  schemaVersion: 1, jobId: request.jobId, buildInputHash: request.buildInputHash,
  sourceZipSha256: request.sourceZipSha256,
  editorImport: { status: "passed", checks: ["open", "save", "reopen", "render"].map(name => ({ name, status: "passed" })) },
  runtimeInteraction: { status: "passed", checks: request.expectedInteractions.map(type => ({ name: "protocol fixture " + type, type, status: "passed" })) },
  evidence: ["native-preview.png"],
  limitations: ["Protocol test adapter only; no editor or runtime was started."]
};
if (mode === "wrong-job") report.jobId = "another-job";
if (mode === "wrong-build") report.buildInputHash = "0".repeat(64);
if (mode === "wrong-zip") report.sourceZipSha256 = "f".repeat(64);
if (mode === "missing-editor-stage") report.editorImport.checks = report.editorImport.checks.filter(check => check.name !== "reopen");
if (mode === "missing-control") report.runtimeInteraction.checks = report.runtimeInteraction.checks.filter(check => check.type !== "ProgressBar");
if (mode === "failed-report") {
  report.editorImport.status = "failed";
  report.editorImport.checks = [{ name: "open", status: "failed", note: "Synthetic protocol failure" }];
  report.runtimeInteraction = { status: "not_verified", checks: [] };
}
await fs.copyFile(path.join(request.workspaceRoot, "design.png"), path.join(request.outputDirectory, "native-preview.png"));
await fs.writeFile(request.reportFile, JSON.stringify(report));
`;

async function file(relative: string, bytes: string | Buffer) {
  const destination = path.join(workspace.root, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, bytes);
}

/** A genuine 16×16 source-format inspection and export with two control types,
 * so runtime-coverage assertions cannot pass with a single generic check. */
async function buildFixture(): Promise<JobSummary> {
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 0.6 } } }).png().toBuffer();
  await file("design.png", png);
  await file("target/Actual.fairy", '<projectDescription id="actual123" type="Layabox" version="5.0"/>');
  await file("target/assets/Sample/package.xml", '<packageDescription id="sample01"><resources><image id="img" name="skin.png" path="/"/><component id="button" name="Action.xml" path="/"/><component id="progress" name="Progress.xml" path="/"/><component id="main" name="Main.xml" path="/"/></resources></packageDescription>');
  await file("target/assets/Sample/skin.png", png);
  await file("target/assets/Sample/Action.xml", '<component size="8,8" extention="Button"><displayList><image id="n0" name="skin" xy="0,0" size="8,8" src="img" fileName="skin.png"/></displayList><Button mode="Common"/></component>');
  await file("target/assets/Sample/Progress.xml", '<component size="16,4" extention="ProgressBar"><displayList><image id="n0" name="bar" xy="0,0" size="16,4" src="img" fileName="skin.png"/></displayList><ProgressBar titleType="percent"/></component>');
  await file("target/assets/Sample/Main.xml", '<component size="16,16"><displayList><image id="n0" name="background" xy="0,0" size="16,16" src="img" fileName="skin.png"/><component id="n1" name="action" xy="0,0" size="8,8" src="button" fileName="Action.xml"/><component id="n2" name="progress" xy="0,12" size="16,4" src="progress" fileName="Progress.xml"><ProgressBar min="0" max="100" value="25"/></component></displayList></component>');
  let job = await createJob(workspace, { name: "Native protocol fixture", designFile: "design.png", targetProject: "target" });
  job = await importFile(workspace, job.id, { sourcePath: "design.png", path: "assets/skin.png", role: "asset" });
  const inspected = await inspectTarget(workspace, job.id);
  expect(inspected.profile.status).toBe("ready");
  job = (await setScene(workspace, job.id, { expectedRevision: inspected.job.revision, scene: {
    schemaVersion: 1, id: "native-fixture", name: "Native fixture", canvas: { width: 16, height: 16 }, entry: "main",
    assets: [{ id: "skin", file: "assets/skin.png", width: 16, height: 16 }], fonts: [],
    components: [
      { id: "action", name: "Action", semantic: "Button", width: 8, height: 8, extension: { button: { mode: "Common" } },
        children: [{ id: "skin", name: "skin", type: "Image", assetId: "skin", x: 0, y: 0, width: 8, height: 8 }] },
      { id: "progress", name: "Progress", semantic: "ProgressBar", width: 16, height: 4, extension: { progressBar: { titleType: "percent" } },
        children: [{ id: "bar", name: "bar", type: "Image", assetId: "skin", x: 0, y: 0, width: 16, height: 4 }] },
      { id: "main", name: "Main", semantic: "Component", width: 16, height: 16,
        children: [
          { id: "background", name: "background", type: "Image", assetId: "skin", x: 0, y: 0, width: 16, height: 16 },
          { id: "action", name: "action", type: "Button", componentId: "action", x: 0, y: 0, width: 8, height: 8 },
          { id: "progress", name: "progress", type: "ProgressBar", componentId: "progress", x: 0, y: 12, width: 16, height: 4, instance: { min: 0, max: 100, value: 25 } },
        ] },
    ],
  } })).job;
  return buildJob(workspace, job.id, { expectedRevision: job.revision });
}

async function register(mode: string) {
  return addNativeAdapter(workspace, { id: "protocol", command: "node", args: ["scripts/adapter.mjs", mode, "{request}"], timeoutMs: 5000 });
}

beforeEach(async () => {
  temporary = await fs.realpath(makeTmpDir("ui-native"));
  await fs.mkdir(path.join(temporary, "workspace"));
  vi.stubEnv("C2C_STATE_DIR", path.join(temporary, "state"));
  workspace = new Workspace(path.join(temporary, "workspace"));
  built = await buildFixture();
  script = path.join(workspace.root, "scripts", "adapter.mjs");
  await file("scripts/adapter.mjs", adapterSource);
});
afterEach(() => { vi.unstubAllEnvs(); cleanup(temporary); });

describe("native runner protocol boundaries (mock adapter; no real editor/runtime validation)", () => {
  it("canonicalizes and hashes relative code arguments, and refuses changed code before execution", async () => {
    await file("scripts/preload.mjs", "// Protocol fixture preload only.\n");
    const preload = await fs.realpath(path.join(workspace.root, "scripts", "preload.mjs"));
    const registered = await addNativeAdapter(workspace, { id: "protocol", command: "node",
      args: ["--import=./scripts/preload.mjs", "./scripts/adapter.mjs", "pass", "{request}"], timeoutMs: 5000 });
    expect(registered.args).toEqual([`--import=${preload}`, await fs.realpath(script), "pass", "{request}"]);
    for (const file of [preload, await fs.realpath(script)]) {
      expect(registered.trustedFiles).toContainEqual({ path: file, sha256: (await hashFile(file)).sha256 });
    }
    await expect(addNativeAdapter(workspace, { id: "missing", command: "node", args: ["missing.mjs"] }))
      .rejects.toMatchObject({ code: "NATIVE_CODE_NOT_FOUND" });
    await fs.appendFile(script, "\n// Changed after local registration.\n");
    await expect(runNativeValidation(workspace, built.id, { adapterId: "protocol" }))
      .rejects.toMatchObject({ code: "NATIVE_ADAPTER_CHANGED" });
    await expect(fs.stat(path.join(workspace.root, "protocol-invocation.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await getJob(workspace, built.id)).nativeValidation?.status).toBe("failed");
    expect((await getJob(workspace, built.id)).checks.editorImport).toBe("not_verified");
  });

  it("binds reports to the actual job, build, and source ZIP rather than trusting a matching report shape", async () => {
    for (const mode of ["wrong-job", "wrong-build", "wrong-zip"]) {
      await register(mode);
      await expect(runNativeValidation(workspace, built.id, { adapterId: "protocol" }), mode)
        .rejects.toMatchObject({ code: "NATIVE_REPORT_MISMATCH" });
      const current = await getJob(workspace, built.id);
      expect(current.artifacts).toEqual(built.artifacts);
      expect(current.checks).toMatchObject({ static: "passed", psd: "passed", editorImport: "not_verified", runtimeInteraction: "not_verified" });
      expect(current.nativeValidation?.status).toBe("failed");
    }
  });

  it("requires all four editor stages and coverage of each expected scene control before accepting a pass", async () => {
    for (const mode of ["missing-editor-stage", "missing-control"]) {
      await register(mode);
      await expect(runNativeValidation(workspace, built.id, { adapterId: "protocol" }), mode)
        .rejects.toMatchObject({ code: "INCOMPLETE_NATIVE_CHECKS" });
      const invocation = JSON.parse(await fs.readFile(path.join(workspace.root, "protocol-invocation.json"), "utf8"));
      expect(invocation.expectedInteractions.sort()).toEqual(["Button", "ProgressBar"]);
      expect((await getJob(workspace, built.id)).checks.editorImport).toBe("not_verified");
      expect((await getJob(workspace, built.id)).checks.runtimeInteraction).toBe("not_verified");
    }
  });

  it("publishes a source-bound protocol result and native preview, then blocks delivery if a later execution fails", async () => {
    const before = await readWorkflowJob(workspace, built.id);
    const oldDirectory = path.join(before.root, before.job.buildDirectory!);
    const zipBytes = await fs.readFile(path.join(oldDirectory, "FGUI_Source.zip"));
    await register("pass");
    const result = await runNativeValidation(workspace, built.id, { adapterId: "protocol" });
    expect(result.report.limitations).toContain("Protocol test adapter only; no editor or runtime was started.");
    expect(result.job.checks).toEqual({ static: "passed", psd: "passed", editorImport: "passed", runtimeInteraction: "passed" });
    expect(result.job.nativeValidation?.status).toBe("completed");
    const current = await readWorkflowJob(workspace, built.id);
    expect(current.job.buildDirectory).not.toBe(before.job.buildDirectory);
    const directory = path.join(current.root, current.job.buildDirectory!);
    expect(await inventoryArtifacts(directory)).toEqual(result.job.artifacts);
    expect(result.job.artifacts.map(artifact => artifact.path)).toEqual(expect.arrayContaining([
      "Reports/native/report.json", "Reports/native/native-preview.png", "Previews/FGUI_Native.png",
    ]));
    expect(await fs.readFile(path.join(directory, "FGUI_Source.zip"))).toEqual(zipBytes);
    expect(await fs.readFile(path.join(oldDirectory, "FGUI_Source.zip"))).toEqual(zipBytes);
    const preview = await fs.readFile(path.join(directory, "Previews/FGUI_Native.png"));
    expect(preview).toEqual(await fs.readFile(path.join(workspace.root, "design.png")));
    expect(await sharp(preview).metadata()).toMatchObject({ format: "png", width: 16, height: 16, hasAlpha: true });
    const report = JSON.parse(await fs.readFile(path.join(directory, "Reports/native/report.json"), "utf8"));
    expect(report).toMatchObject({ adapterId: "protocol", jobId: built.id, sourceZipSha256: built.artifacts.find(a => a.path === "FGUI_Source.zip")!.sha256 });
    const validation = JSON.parse(await fs.readFile(path.join(directory, "Reports/validation.json"), "utf8"));
    expect(validation).toMatchObject({ editorImport: { status: "passed" }, runtimeInteraction: { status: "passed" }, nativeEvidence: "Reports/native/report.json" });
    const delivered = await deliverJob(workspace, built.id, { subdirectory: "before-failure" });
    await register("exit");
    await expect(runNativeValidation(workspace, built.id, { adapterId: "protocol" }))
      .rejects.toMatchObject({ code: "NATIVE_EXECUTION_FAILED" });
    const failed = await getJob(workspace, built.id);
    expect(failed.nativeValidation?.status).toBe("failed");
    expect(failed.artifacts).toEqual(result.job.artifacts);
    await expect(deliverJob(workspace, built.id, { subdirectory: "after-failure" }))
      .rejects.toMatchObject({ code: "NATIVE_VALIDATION_FAILED" });
    expect(await fs.readFile(path.join(delivered.directory, "FGUI_Source.zip"))).toEqual(zipBytes);
  });

  it("persists an explicit failed stage and refuses final delivery despite static and PSD success", async () => {
    await register("failed-report");
    const result = await runNativeValidation(workspace, built.id, { adapterId: "protocol" });
    expect(result.job.checks).toEqual({ static: "passed", psd: "passed", editorImport: "failed", runtimeInteraction: "not_verified" });
    const stored = await readWorkflowJob(workspace, built.id);
    const report = JSON.parse(await fs.readFile(path.join(stored.root, stored.job.buildDirectory!, "Reports/native/report.json"), "utf8"));
    expect(report.editorImport.status).toBe("failed");
    expect((await getJob(new Workspace(workspace.root), built.id)).checks.editorImport).toBe("failed");
    await expect(deliverJob(workspace, built.id)).rejects.toMatchObject({ code: "NATIVE_VALIDATION_FAILED" });
  });

  it("rejects externally changed scene or target-profile state before running the adapter", async () => {
    await register("pass");
    const root = await jobRoot(workspace, built.id);
    const sceneFile = path.join(root, "scene.json");
    const originalScene = await fs.readFile(sceneFile, "utf8");
    const scene = JSON.parse(originalScene);
    scene.name = "Changed outside the workflow";
    await fs.writeFile(sceneFile, JSON.stringify(scene));
    await expect(runNativeValidation(workspace, built.id, { adapterId: "protocol" }))
      .rejects.toMatchObject({ code: "STATE_CHANGED" });
    await fs.writeFile(sceneFile, originalScene);
    const profileFile = path.join(root, "target.json");
    const profile = JSON.parse(await fs.readFile(profileFile, "utf8"));
    profile.notes = [...profile.notes, "Changed outside the workflow"];
    await fs.writeFile(profileFile, JSON.stringify(profile));
    await expect(runNativeValidation(workspace, built.id, { adapterId: "protocol" }))
      .rejects.toMatchObject({ code: "STATE_CHANGED" });
    await expect(fs.stat(path.join(workspace.root, "protocol-invocation.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await getJob(workspace, built.id)).nativeValidation).toBeUndefined();
    expect((await getJob(workspace, built.id)).artifacts).toEqual(built.artifacts);
  });
});
