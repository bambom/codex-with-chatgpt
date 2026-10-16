import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import { hashBytes, hashDocument } from "@magicgamestudio/ui-design-contract";
import { Workspace } from "../src/workspace/manager.js";
const mocks = vi.hoisted(() => ({ status: vi.fn(), context: vi.fn(), checkpoint: vi.fn(), request: vi.fn(),
  spec: vi.fn(), begin: vi.fn(), intake: vi.fn(), upload: vi.fn(), validate: vi.fn(), prepare: vi.fn(), download: vi.fn() }));
vi.mock("../src/ui-design/platform.js", () => ({ platformStatus: mocks.status, platformContext: mocks.context,
  platformCheckpoint: mocks.checkpoint, platformWebChatRequest: mocks.request, platformSpecification: mocks.spec }));
vi.mock("../src/ui-design/intake.js", () => ({ beginIntake: mocks.begin, intakeStatus: mocks.intake,
  uploadIntakeContent: mocks.upload, validateIntake: mocks.validate, prepareCommitIntake: mocks.prepare }));
vi.mock("../src/ui-design/web-files.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/ui-design/web-files.js")>(), downloadChatFile: mocks.download }));
import { webChatOperation } from "../src/ui-design/web-chat.js";
const fixtures = path.resolve(path.dirname(createRequire(import.meta.url).resolve("@magicgamestudio/ui-design-contract")), "../../fixtures");
let root: string, previous: string | undefined, workspace: Workspace, design: string, submission: string, documentHash: string, manifestHash: string;
const file = { file_id: "file-test", download_url: "https://files.oaiusercontent.com/test.zip" };
beforeEach(async () => {
  vi.resetAllMocks();root = await fs.mkdtemp(path.join(os.tmpdir(), "web-chat-flow-"));previous = process.env.C2C_STATE_DIR;
  process.env.C2C_STATE_DIR = path.join(root, "state");await fs.mkdir(path.join(root, "work"));workspace = new Workspace(path.join(root, "work"));
  const doc = JSON.parse(await fs.readFile(path.join(fixtures, "complete.authoring.json"), "utf8"));design = doc.designId;
  const manifest = JSON.parse(await fs.readFile(path.join(fixtures, "submission-fixtures.json"), "utf8")).manifest;
  manifest.baseRevision = 0;submission = manifest.submissionId;
  const files: Record<string, Uint8Array> = { "document.json": Buffer.from(JSON.stringify(doc)) };
  for (const entry of manifest.files) {
    let bytes: Buffer;
    try { bytes = await fs.readFile(path.join(fixtures, entry.path)); }
    catch { bytes = entry.role === "provenance" ? Buffer.from('{}') : await fs.readFile(path.join(fixtures, "files/reference.png")); }
    files[entry.path] = bytes;entry.sha256 = hashBytes(bytes);entry.byteLength = bytes.length;
  }
  documentHash = hashDocument(doc);manifestHash = hashDocument(manifest);files["manifest.json"] = Buffer.from(JSON.stringify(manifest));
  mocks.download.mockResolvedValue(Buffer.from(zipSync(files)));
  mocks.status.mockResolvedValue({ designIds: [design] });
  mocks.context.mockResolvedValue({ designId: design, standardRevision: 0, nativeSequence: 0, nativeSha256: 'a'.repeat(64) });
  mocks.checkpoint.mockResolvedValue({ checkpointId: randomUUID() });mocks.begin.mockResolvedValue({ submissionId: submission });
  mocks.intake.mockResolvedValue({ receipt: null, documentHash, assetManifestHash: manifestHash });
  mocks.validate.mockResolvedValue({ validationId: randomUUID() });mocks.prepare.mockResolvedValue({ preparationId: randomUUID() });
  mocks.request.mockImplementation(async (_workspace, _design, op) => op === "receive" ? { state: "WAITING" } : { designId: design });
});
afterEach(async () => {
  if (previous === undefined) delete process.env.C2C_STATE_DIR;else process.env.C2C_STATE_DIR = previous;
  await fs.rm(root, { recursive: true, force: true });
});
it("resumes the same checkpoint and submission intent after a lost begin response", async () => {
  const request_id = randomUUID();mocks.begin.mockRejectedValueOnce(Error("lost response"));
  await expect(webChatOperation(workspace, "ui_design_split_image", { stage: "begin", request_id })).rejects.toThrow("lost response");
  await webChatOperation(new Workspace(workspace.root), "ui_design_split_image", { stage: "begin", request_id });
  expect(mocks.checkpoint).toHaveBeenCalledTimes(1);expect(mocks.begin).toHaveBeenCalledTimes(2);
  expect(mocks.begin.mock.calls[1]!.slice(1)).toEqual(mocks.begin.mock.calls[0]!.slice(1));
  await expect(webChatOperation(workspace, "ui_design_modify_design", { stage: "begin", request_id })).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" });
});
it("resumes an existing canvas-image task after the input guard is upgraded without replacing its checkpoint or intake", async () => {
  const request_id = randomUUID();
  mocks.request.mockRejectedValueOnce(Error("NATIVE_BASE_NOT_EMPTY"));
  await expect(webChatOperation(workspace, "ui_design_split_image", { stage: "begin", request_id })).rejects.toThrow("NATIVE_BASE_NOT_EMPTY");
  const input = { sourceImage: { kind: "CANVAS_IMAGE", width: 841, height: 1870, sha256: "c".repeat(64) },
    inputArchive: { url: "https://relay.example.test/ui-design/chat-files/pinned-source" } };
  mocks.request.mockResolvedValueOnce(input);
  const result = await webChatOperation(new Workspace(workspace.root), "ui_design_split_image", { stage: "begin", request_id });
  expect(result).toMatchObject({ requestId: request_id, task: { submissionId: submission }, input,
    producer: { processing: "CHATGPT_WEB_ONLY", splitRules: expect.stringContaining("exact files/canvas-source.png") } });
  expect(mocks.checkpoint).toHaveBeenCalledTimes(1);expect(mocks.begin).toHaveBeenCalledTimes(1);
  expect(mocks.upload).not.toHaveBeenCalled();
});
it("retains the exact result and preparation across restart, then releases the transport copy only after a verified receipt", async () => {
  const request_id = randomUUID();await webChatOperation(workspace, "ui_design_split_image", { stage: "begin", request_id });
  mocks.request.mockRejectedValueOnce(Error("receive response lost"));
  await expect(webChatOperation(workspace, "ui_design_split_image", { stage: "submit", request_id, result_file: file })).rejects.toThrow("receive response lost");
  mocks.download.mockRejectedValue(Error("expired file URL"));
  await webChatOperation(new Workspace(workspace.root), "ui_design_split_image", { stage: "resume", request_id });
  expect(mocks.download).toHaveBeenCalledTimes(1);expect(mocks.upload).toHaveBeenCalledTimes(1);expect(mocks.prepare).toHaveBeenCalledTimes(1);
  const deliveries = mocks.request.mock.calls.filter(call => call[2] === "receive");expect(deliveries[1]![3]).toEqual(deliveries[0]![3]);
  const archive = path.join(process.env.C2C_STATE_DIR!, "ui-workflow", workspace.id, "web-chat", request_id + ".zip");
  expect((await fs.stat(archive)).size).toBeGreaterThan(0);
  mocks.intake.mockResolvedValue({ receipt: { status: "COMMITTED", submissionId: submission }, documentHash, assetManifestHash: manifestHash });
  expect(await webChatOperation(workspace, "ui_design_split_image", { stage: "status", request_id })).toMatchObject({ receipt: { status: "COMMITTED" } });
  await expect(fs.stat(archive)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await webChatOperation(workspace, "ui_design_split_image", { stage: "resume", request_id })).toMatchObject({ receipt: { status: "COMMITTED" } });
  expect(await fs.readdir(workspace.root)).toEqual([]);
});
it("rejects modification before the first standard result and a missing or expired producer file", async () => {
  await expect(webChatOperation(workspace, "ui_design_modify_design", { stage: "begin", request_id: randomUUID() })).rejects.toMatchObject({ code: "STANDARD_DESIGN_REQUIRED" });
  const request_id = randomUUID();await webChatOperation(workspace, "ui_design_split_image", { stage: "begin", request_id });
  await expect(webChatOperation(workspace, "ui_design_split_image", { stage: "submit", request_id })).rejects.toMatchObject({ code: "RESULT_FILE_REQUIRED" });
  mocks.download.mockRejectedValue(Error("expired"));
  await expect(webChatOperation(workspace, "ui_design_split_image", { stage: "submit", request_id, result_file: file })).rejects.toThrow("expired");
  expect(mocks.upload).not.toHaveBeenCalled();
  mocks.context.mockResolvedValue({ standardRevision: 1, nativeSequence: 1, nativeSha256: 'b'.repeat(64) });
  await webChatOperation(workspace, "ui_design_modify_design", { stage: "begin", request_id: randomUUID() });
  expect(mocks.begin.mock.lastCall?.[4]).toBe(1);
});

it("returns the verified live platform specification without the offline contract flags", async () => {
  const spec = { source: "platform-server", liveServer: true, section: "summary", data: { serverPersistenceImplemented: true } };
  mocks.spec.mockResolvedValue(spec);
  const result = await webChatOperation(workspace, "ui_design_split_image", { stage: "spec", section: "summary" });
  expect(result).toMatchObject({ workspaceId: workspace.id, designIds: [design], specification: spec });
  expect(mocks.spec).toHaveBeenCalledWith(workspace, "summary");
  expect(mocks.checkpoint).not.toHaveBeenCalled();
  expect(mocks.begin).not.toHaveBeenCalled();
});
