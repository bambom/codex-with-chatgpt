import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { addDestination, resolveDestination } from "../src/ui/destinations.js";
import { containedPath, jobRoot, sha256, UI_LIMITS, withLock } from "../src/ui/storage.js";
import {
  beginUpload, buildJob, createJob, deliverJob, finishUpload, getJob, importFile,
  inspectTarget, listJobs, readWorkflowJob, saveWorkflowJob, setScene, uploadChunk,
} from "../src/ui/workflow.js";
import { cleanup, makeTmpDir } from "./helpers.js";

let temporary: string;
let workspace: Workspace;

beforeEach(async () => {
  temporary = await fs.realpath(makeTmpDir("ui-storage"));
  const directory = path.join(temporary, "workspace");
  await fs.mkdir(directory);
  vi.stubEnv("C2C_STATE_DIR", path.join(temporary, "state"));
  workspace = new Workspace(directory);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); cleanup(temporary); });

/** A real, tiny export keeps delivery-path regressions independent of render complexity. */
async function builtJob() {
  const image = await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 0.5 } } }).png().toBuffer();
  const sample = path.join(workspace.root, "target", "assets", "Example");
  await fs.mkdir(sample, { recursive: true });
  await fs.writeFile(path.join(workspace.root, "design.png"), image);
  await fs.writeFile(path.join(workspace.root, "target", "Example.fairy"), '<projectDescription id="actual123" type="Layabox" version="5.0"/>');
  await fs.writeFile(path.join(sample, "package.xml"), '<packageDescription id="sample01"><resources><image id="img" name="pixel.png" path="/"/><component id="main" name="Main.xml" path="/"/></resources></packageDescription>');
  await fs.writeFile(path.join(sample, "Main.xml"), '<component size="4,4"><displayList><image id="n0" name="background" xy="0,0" size="4,4" src="img" fileName="pixel.png"/></displayList></component>');
  await fs.writeFile(path.join(sample, "pixel.png"), image);
  let job = await createJob(workspace, { name: "Storage boundary", designFile: "design.png", targetProject: "target" });
  job = await importFile(workspace, job.id, { sourcePath: "design.png", path: "assets/skin.png", role: "asset" });
  job = (await inspectTarget(workspace, job.id)).job;
  job = (await setScene(workspace, job.id, { expectedRevision: job.revision, scene: {
    schemaVersion: 1, id: "simple", name: "Simple", canvas: { width: 4, height: 4 }, entry: "main",
    assets: [{ id: "skin", file: "assets/skin.png", width: 4, height: 4 }], fonts: [],
    components: [{ id: "main", name: "Main", semantic: "Component", width: 4, height: 4,
      children: [{ id: "background", name: "background", type: "Image", assetId: "skin", x: 0, y: 0, width: 4, height: 4 }] }],
  } })).job;
  return buildJob(workspace, job.id, { expectedRevision: job.revision });
}

describe("UI storage recovery regressions", () => {
  it.each([0, 2])("recovers an orphan partial upload with %i persisted bytes and checks the final content", async (persisted) => {
    const job = await createJob(workspace, { name: "Orphan upload" });
    const bytes = Buffer.from("hello");
    const input = { path: "data/recovery.txt", role: "data" as const, sizeBytes: bytes.length, sha256: sha256(bytes) };
    const upload = await beginUpload(workspace, job.id, input);
    if (persisted) await uploadChunk(workspace, job.id, { uploadId: upload.uploadId, offset: 0, dataBase64: bytes.subarray(0, persisted).toString("base64") });
    const root = await jobRoot(workspace, job.id);
    // Represents a process exit after the part file was durable but before metadata publication.
    await fs.unlink(path.join(root, "uploads", `${upload.uploadId}.json`));
    const restarted = new Workspace(workspace.root);
    const resumed = await beginUpload(restarted, job.id, input);
    expect(resumed).toMatchObject({ uploadId: upload.uploadId, nextOffset: persisted, complete: false });
    await uploadChunk(restarted, job.id, { uploadId: resumed.uploadId, offset: persisted, dataBase64: bytes.subarray(persisted).toString("base64") });
    const finished = await finishUpload(restarted, job.id, resumed.uploadId);
    expect(finished.files).toHaveLength(1);
    expect(finished.files[0]).toMatchObject({ path: input.path, sha256: input.sha256, sizeBytes: bytes.length });
    expect(await fs.readFile(path.join(root, "inputs", input.path))).toEqual(bytes);
  });

  it("refuses an oversized orphan part without adopting or truncating it", async () => {
    const job = await createJob(workspace, { name: "Bounded orphan" });
    const input = { path: "data/recovery.txt", role: "data" as const, sizeBytes: 5, sha256: sha256("hello") };
    const upload = await beginUpload(workspace, job.id, input);
    const folder = path.join(await jobRoot(workspace, job.id), "uploads");
    await fs.writeFile(path.join(folder, `${upload.uploadId}.part`), "oversized");
    await fs.unlink(path.join(folder, `${upload.uploadId}.json`));
    await expect(beginUpload(workspace, job.id, input)).rejects.toMatchObject({ code: "UPLOAD_CONFLICT" });
    expect(await fs.readFile(path.join(folder, `${upload.uploadId}.part`), "utf8")).toBe("oversized");
    expect((await getJob(workspace, job.id)).files).toHaveLength(0);
  });

  it("never publishes a partial lock owner and remains usable after its metadata write fails", async () => {
    const directory = path.join(temporary, "lock");
    await fs.mkdir(directory);
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
        await write("{");
        throw Object.assign(new Error("Injected interrupted owner write"), { code: "EIO" });
      });
      return handle;
    });
    await expect(withLock(directory, async () => 1)).rejects.toMatchObject({ code: "EIO" });
    vi.restoreAllMocks();
    await expect(fs.stat(path.join(directory, "operation.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await withLock(directory, async () => {
      const owner = JSON.parse(await fs.readFile(path.join(directory, "operation.lock"), "utf8"));
      expect(owner.pid).toBe(process.pid);
      await expect(withLock(directory, async () => 2)).rejects.toMatchObject({ code: "JOB_BUSY" });
      return 42;
    })).toBe(42);
  });

  it("reads and updates valid job inventories above the independent scene-JSON limit after restart", async () => {
    const created = await createJob(workspace, { name: "Large persisted inventory" });
    const { root, job } = await readWorkflowJob(workspace, created.id);
    const prefix = `${"d".repeat(155)}/${"e".repeat(155)}/${"f".repeat(150)}/`;
    // Durable-manifest fixture for 1600 legitimate tiny imports; avoids 1600 repeated fsyncs in this storage test.
    job.files = Array.from({ length: 1600 }, (_, i) => ({
      path: `${prefix}${String(i).padStart(4, "0")}.txt`, role: "data", sizeBytes: 1,
      sha256: sha256("x"), importedAt: job.createdAt,
    }));
    job.artifacts = job.files.map(file => ({ path: `Inputs/${file.path}`, sizeBytes: file.sizeBytes, sha256: file.sha256, mimeType: "text/plain" }));
    await saveWorkflowJob(root, job);
    expect((await fs.stat(path.join(root, "job.json"))).size).toBeGreaterThan(UI_LIMITS.maxSceneBytes);
    const restarted = new Workspace(workspace.root);
    expect((await getJob(restarted, job.id)).files).toHaveLength(1600);
    const listed = (await listJobs(restarted))[0];
    expect(listed).toMatchObject({ inputCount: 1600, artifactCount: 1600 });
    expect(listed).not.toHaveProperty("files");
    expect(listed).not.toHaveProperty("artifacts");
    const reread = await readWorkflowJob(restarted, job.id);
    reread.job.delivery = { jobId: job.id, destinationId: "workspace", directory: path.join(workspace.root, "generated", "ui-deliveries", "large"),
      createdAt: job.createdAt, fileCount: job.artifacts.length, totalBytes: 1600, artifacts: job.artifacts, buildInputHash: sha256("fixture") };
    await saveWorkflowJob(reread.root, reread.job);
    expect((await getJob(restarted, job.id)).delivery?.artifacts).toHaveLength(1600);
    expect((await listJobs(restarted))[0].delivery).toMatchObject({ fileCount: 1600 });
    expect((await listJobs(restarted))[0].delivery).not.toHaveProperty("artifacts");
  });
});

describe("UI destination boundary regressions", () => {
  it("rejects an already-registered destination whose ancestor now redirects outside the chosen root", async () => {
    const job = await builtJob();
    const approvedParent = path.join(temporary, "approved");
    const outside = path.join(temporary, "outside");
    const requested = path.join(approvedParent, "out");
    await addDestination(workspace, { id: "art", path: requested });
    await fs.rename(approvedParent, `${approvedParent}-old`);
    await fs.mkdir(path.join(outside, "out"), { recursive: true });
    await fs.symlink(outside, approvedParent, process.platform === "win32" ? "junction" : "dir");
    await expect(resolveDestination(workspace, "art")).rejects.toMatchObject({ code: "DESTINATION_CHANGED" });
    await expect(containedPath(requested, "escaped/file.png")).rejects.toMatchObject({ code: "UNSAFE_DIRECTORY" });
    await expect(deliverJob(workspace, job.id, { destinationId: "art", subdirectory: "escaped" })).rejects.toMatchObject({ code: "DESTINATION_CHANGED" });
    expect(await fs.readdir(path.join(outside, "out"))).toEqual([]);
  });

  it("rejects a copied delivery receipt for another folder or destination while preserving both copies", async () => {
    const job = await builtJob();
    const first = await deliverJob(workspace, job.id, { subdirectory: "first" });
    expect(await deliverJob(workspace, job.id, { subdirectory: "first" })).toEqual(first);
    const copied = path.join(path.dirname(first.directory), "copied");
    await fs.cp(first.directory, copied, { recursive: true });
    const originalReceipt = await fs.readFile(path.join(copied, "delivery_receipt.json"));
    await expect(deliverJob(workspace, job.id, { subdirectory: "copied" })).rejects.toMatchObject({ code: "DELIVERY_CONFLICT" });
    expect(await fs.readFile(path.join(copied, "delivery_receipt.json"))).toEqual(originalReceipt);
    expect((await getJob(workspace, job.id)).delivery?.directory).toBe(first.directory);
    await addDestination(workspace, { id: "alias", path: path.dirname(first.directory) });
    await expect(deliverJob(workspace, job.id, { destinationId: "alias", subdirectory: "first" })).rejects.toMatchObject({ code: "DELIVERY_CONFLICT" });
    expect(await fs.readFile(path.join(first.directory, "Interface.psd"))).toEqual(await fs.readFile(path.join(copied, "Interface.psd")));
  });
});
