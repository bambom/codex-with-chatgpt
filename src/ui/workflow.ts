import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { zipSync, unzipSync } from "fflate";
import type { Workspace } from "../workspace/manager.js";
import { VERSION } from "../version.js";
import { listDestinations, resolveDestination } from "./destinations.js";
import { parseScene, resolveScene, sceneInputFiles, validateScene, type Scene } from "./scene.js";
import { inspectTarget as inspectSourceTarget, verifyTargetProfile, type TargetProfile } from "./target.js";
import { exportFgui } from "./fgui.js";
import { renderScene } from "./render.js";
import { buildPsd } from "./psd.js";
import {
  UI_LIMITS, UiWorkflowError, atomicJson, containedPath, ensureParent, hashFile, hashJson,
  invariant, jobRoot, readJson, safeId, safeRelative, samePath, sha256, stateRoot, walkFiles, withLock,
} from "./storage.js";

export { UI_LIMITS, UiWorkflowError } from "./storage.js";
export type InputRole = "reference" | "design" | "asset" | "font" | "license" | "data";
type CheckStatus = "passed" | "failed" | "not_verified";

export interface InputFile {
  path: string; role: InputRole; sizeBytes: number; sha256: string;
  width?: number; height?: number; format?: string; hasAlpha?: boolean;
  importedAt: string;
}
export interface UiArtifact { path: string; sizeBytes: number; sha256: string; mimeType: string }
export interface JobSummary {
  id: string; name: string; revision: number;
  status: "awaiting_inputs" | "awaiting_target" | "ready" | "building" | "built" | "delivered" | "failed";
  createdAt: string; updatedAt: string;
  targetProject?: string; targetStatus?: string; designPath?: string; canvas?: { width: number; height: number };
  files: InputFile[]; artifacts: UiArtifact[];
  checks: { static: CheckStatus; psd: CheckStatus; editorImport: CheckStatus; runtimeInteraction: CheckStatus };
  destinationId: string; outputSubdirectory: string; atlas: boolean;
  error?: { code: string; message: string };
  delivery?: DeliveryReceipt;
  nativeValidation?: { adapterId: string; status: "running" | "completed" | "failed"; startedAt: string; finishedAt?: string };
}
export interface Job extends JobSummary {
  schemaVersion: 1; workspaceId: string; sceneHash?: string; targetHash?: string;
  buildDirectory?: string; buildInputHash?: string;
}
interface Upload {
  id: string; path: string; role: InputRole; sizeBytes: number; sha256: string;
  nextOffset: number; complete: boolean;
}
export interface DeliveryReceipt {
  jobId: string; destinationId: string; directory: string; createdAt: string;
  fileCount: number; totalBytes: number; artifacts: UiArtifact[]; buildInputHash: string;
}

const now = (): string => new Date().toISOString();
const pendingChecks = (): Job["checks"] => ({ static: "not_verified", psd: "not_verified", editorImport: "not_verified", runtimeInteraction: "not_verified" });
const roles = new Set<InputRole>(["reference", "design", "asset", "font", "license", "data"]);

function summary(job: Job): JobSummary {
  const { schemaVersion: _version, workspaceId: _workspace, sceneHash: _scene, targetHash: _target,
    buildDirectory: _buildDirectory, buildInputHash: _inputHash, ...view } = job;
  return view;
}

async function readJob(workspace: Workspace, id: string): Promise<{ root: string; job: Job }> {
  const root = await jobRoot(workspace, id);
  const job = await readJson<Job>(path.join(root, "job.json"), UI_LIMITS.maxManifestBytes);
  invariant(job.schemaVersion === 1 && job.workspaceId === workspace.id && job.id === id,
    "INVALID_STATE", "Job identity does not match the connected workspace.");
  return { root, job };
}

async function saveJob(root: string, job: Job): Promise<void> {
  job.updatedAt = now();
  invariant(Buffer.byteLength(JSON.stringify(job, null, 2), "utf8") < UI_LIMITS.maxManifestBytes, "MANIFEST_TOO_LARGE", "Job manifest exceeds the supported capacity.");
  await atomicJson(path.join(root, "job.json"), job);
}

function invalidate(job: Job): void {
  job.revision++;
  job.checks = pendingChecks();
  job.artifacts = [];
  delete job.buildDirectory;
  delete job.buildInputHash;
  delete job.delivery;
  delete job.nativeValidation;
  delete job.error;
  job.status = job.sceneHash && job.targetStatus === "ready" && job.designPath ? "ready" : "awaiting_inputs";
}

function revision(job: Job, expected: number): void {
  invariant(Number.isSafeInteger(expected) && job.revision === expected,
    "REVISION_CONFLICT", `Expected revision ${expected}; current revision is ${job.revision}. Read the job and retry.`);
}

function assertHash(value: string): void {
  invariant(/^[0-9a-f]{64}$/i.test(value), "INVALID_HASH", "Use a complete SHA-256 hex digest.");
}

function validateRole(role: InputRole): void {
  invariant(roles.has(role), "INVALID_ROLE", "Unknown workflow input role.");
}

export function workflowCapabilities() {
  return {
    schemaVersion: 1,
    description: "Legacy Scene jobs are read-only compatibility sources. Use ui_design_prepare/reconstruct/submit for new standard designs and platform revision exports for PSD/FGUI.",
    readOnly: true,
    limits: UI_LIMITS,
    stages: ["read_legacy_job", "inspect_migration", "explicit_migration", "standard_prepare", "standard_reconstruct", "online_submit", "platform_export"],
    historicalOutputFormats: ["layered PSD", "RGBA PNG assets ZIP", "FGUI editor source XML ZIP", "previews", "semantic/layout/font/binding manifests"],
    transfer: "Import a workspace file or send SHA-256-checked binary chunks. A cloud attachment path is not a path on this computer.",
    destinations: "The workspace destination is built in; additional computer directories are registered with the local CLI.",
    generation: "Image analysis, image generation and reconstruction are performed by the ChatGPT host. The MCP server does not invoke a paid model API or continue AI work after the chat stops.",
    verification: "Static, PSD, editor-import and runtime-interaction checks are separate. Native checks stay not_verified until a configured local validator runs successfully.",
  };
}

export async function getJob(workspace: Workspace, id: string): Promise<JobSummary> {
  return summary((await readJob(workspace, id)).job);
}

export type JobListItem = Omit<JobSummary, "files" | "artifacts" | "delivery"> & {
  inputCount: number; artifactCount: number;
  delivery?: Pick<DeliveryReceipt, "directory" | "destinationId" | "createdAt" | "fileCount" | "totalBytes">;
};

export async function listJobs(workspace: Workspace): Promise<JobListItem[]> {
  const folder = path.join(await stateRoot(workspace), "jobs");
  let entries;
  try { entries = await fs.readdir(folder, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const results: JobListItem[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^ui_[a-f0-9]{32}$/.test(entry.name)) continue;
    const { files, artifacts, delivery, ...job } = await getJob(workspace, entry.name);
    results.push({ ...job, inputCount: files.length, artifactCount: artifacts.length,
      ...(delivery ? { delivery: { directory: delivery.directory, destinationId: delivery.destinationId,
        createdAt: delivery.createdAt, fileCount: delivery.fileCount, totalBytes: delivery.totalBytes } } : {}) });
  }
  return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100);
}

export async function createJob(workspace: Workspace, input: {
  name: string; targetProject?: string; designFile?: string; destinationId?: string;
  outputSubdirectory?: string; atlas?: boolean;
}): Promise<JobSummary> {
  invariant(typeof input.name === "string" && input.name.trim().length > 0 && input.name.length <= 120,
    "INVALID_NAME", "Give the interface a name of at most 120 characters.");
  const destinationId = input.destinationId ?? "workspace";
  invariant((await listDestinations(workspace)).some((d) => d.id === destinationId), "DESTINATION_NOT_CONFIGURED", "Destination has not been configured locally.");
  if (input.targetProject) workspace.resolve(input.targetProject);
  if (input.designFile) workspace.resolve(input.designFile);
  const id = `ui_${randomUUID().replaceAll("-", "")}`;
  const stem = input.name.trim().replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 64) || "interface";
  const outputSubdirectory = safeRelative(input.outputSubdirectory ?? `${stem}-${id.slice(-8)}`);
  const root = await ensureParent(await stateRoot(workspace), `jobs/${id}/job.json`);
  const directory = path.dirname(root);
  await fs.mkdir(path.join(directory, "inputs"), { mode: 0o700 });
  await fs.mkdir(path.join(directory, "uploads"), { mode: 0o700 });
  const job: Job = {
    schemaVersion: 1, id, workspaceId: workspace.id, name: input.name.trim(), revision: 0,
    status: "awaiting_inputs", createdAt: now(), updatedAt: now(), targetProject: input.targetProject,
    files: [], artifacts: [], checks: pendingChecks(), destinationId, outputSubdirectory, atlas: input.atlas ?? false,
  };
  await saveJob(directory, job);
  if (input.designFile) {
    try {
      const ext = path.extname(input.designFile).toLowerCase();
      return await importFile(workspace, id, { sourcePath: input.designFile, path: `design/master${ext}`, role: "design" });
    } catch (error) {
      job.status = "failed";
      job.error = { code: "INITIAL_DESIGN_IMPORT_FAILED", message: `${(error as Error).message} (job ${id} can be resumed)` };
      await saveJob(directory, job);
      throw new UiWorkflowError(job.error.code, job.error.message);
    }
  }
  return summary(job);
}

async function validateInput(file: string, relative: string, role: InputRole): Promise<Partial<InputFile>> {
  validateRole(role);
  const ext = path.extname(relative).toLowerCase();
  const stat = await fs.stat(file);
  invariant(stat.isFile() && stat.size > 0 && stat.size <= UI_LIMITS.maxFileBytes,
    "FILE_TOO_LARGE", "Input must be a non-empty regular file within the file-size limit.");
  if (["reference", "design", "asset"].includes(role)) {
    invariant([".png", ".jpg", ".jpeg", ".webp"].includes(ext), "UNSUPPORTED_IMAGE", "Use PNG, JPEG or WebP raster inputs.");
    try {
      const decoded = sharp(file, { limitInputPixels: UI_LIMITS.maxImagePixels, failOn: "error" });
      const meta = await decoded.metadata();
      invariant(["png", "jpeg", "webp"].includes(meta.format ?? "") && !!meta.width && !!meta.height && (meta.pages ?? 1) === 1,
        "UNSUPPORTED_IMAGE", "Use a single-frame raster image.");
      await decoded.stats(); // Complete decode catches truncated raster data, not just a plausible header.
      return { width: meta.width, height: meta.height, format: meta.format, hasAlpha: meta.hasAlpha ?? false };
    } catch (error) {
      if (error instanceof UiWorkflowError) throw error;
      throw new UiWorkflowError("INVALID_IMAGE", "Image is damaged, too large, or cannot be decoded.");
    }
  }
  if (role === "font") {
    invariant([".ttf", ".otf"].includes(ext), "UNSUPPORTED_FONT", "Font inputs must be TTF or OTF files.");
    const handle = await fs.open(file, "r");
    try {
      const header = Buffer.alloc(4);
      await handle.read(header, 0, 4, 0);
      invariant(header.readUInt32BE(0) === 0x00010000 || header.toString("ascii") === "OTTO",
        "INVALID_FONT", "Font does not have a TTF/OTF header.");
    } finally { await handle.close(); }
    return { format: ext.slice(1) };
  }
  invariant(stat.size <= UI_LIMITS.maxSceneBytes && [".txt", ".json", ".xml", ".md"].includes(ext),
    "UNSUPPORTED_DATA", "Data and license files must be bounded UTF-8 text, JSON or XML.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(file));
  invariant(!text.includes("\0"), "INVALID_DATA", "Text inputs cannot contain NUL bytes.");
  if (ext === ".json") JSON.parse(text);
  if (ext === ".xml") invariant(!/<!DOCTYPE|<!ENTITY/i.test(text), "UNSAFE_XML", "DTD and entity declarations are not supported.");
  return { format: ext.slice(1) };
}

function reserveInput(job: Job, relative: string, sizeBytes: number, digest: string, role: InputRole): InputFile | undefined {
  const existing = job.files.find((f) => f.path.toLowerCase() === relative.toLowerCase());
  if (existing) {
    invariant(existing.path === relative && existing.sha256 === digest && existing.sizeBytes === sizeBytes && existing.role === role,
      "FILE_CONFLICT", "This input path already has different content or a different role. Use a new versioned file name.");
    return existing;
  }
  invariant(job.files.length < UI_LIMITS.maxFiles && job.files.reduce((sum, f) => sum + f.sizeBytes, 0) + sizeBytes <= UI_LIMITS.maxJobBytes,
    "JOB_CAPACITY", "The job would exceed its file or byte limit.");
  return undefined;
}

async function commitInput(root: string, job: Job, source: string, input: {
  path: string; role: InputRole; sizeBytes: number; sha256: string;
}): Promise<void> {
  const existing = reserveInput(job, input.path, input.sizeBytes, input.sha256, input.role);
  const inputRoot = path.join(root, "inputs");
  if (existing) {
    const actual = await hashFile(await containedPath(inputRoot, input.path));
    invariant(actual.sha256 === existing.sha256, "INPUT_CHANGED", "Stored input was changed outside the workflow.");
    return;
  }
  const info = await validateInput(source, input.path, input.role);
  const actual = await hashFile(source);
  invariant(actual.sha256 === input.sha256 && actual.sizeBytes === input.sizeBytes,
    "HASH_MISMATCH", "Input bytes do not match the declared SHA-256 and length.");
  const dest = await ensureParent(inputRoot, input.path);
  try { await fs.copyFile(source, dest, 1); } // COPYFILE_EXCL: never replace an existing input.
  catch (error) {
    // A process can stop after copying bytes but before committing job.json.
    // Recover that exact immutable copy, and reject any different orphan file.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const orphan = await hashFile(dest);
    invariant(orphan.sha256 === input.sha256 && orphan.sizeBytes === input.sizeBytes,
      "FILE_CONFLICT", "An unregistered file already occupies this input path.");
  }
  const copied = await hashFile(dest);
  if (copied.sha256 !== input.sha256 || copied.sizeBytes !== input.sizeBytes) {
    await fs.unlink(dest);
    throw new UiWorkflowError("FILE_CHANGED", "Input changed during copying; retry.");
  }
  job.files.push({ path: input.path, role: input.role, sizeBytes: input.sizeBytes, sha256: input.sha256, ...info, importedAt: now() });
  if (input.role === "design") {
    job.designPath = input.path;
    job.canvas = { width: info.width!, height: info.height! };
  }
  invalidate(job);
  await saveJob(root, job);
}

export async function importFile(workspace: Workspace, jobId: string, input: {
  sourcePath: string; path: string; role: InputRole; sha256?: string;
}): Promise<JobSummary> {
  const relative = safeRelative(input.path);
  validateRole(input.role);
  const source = workspace.resolve(input.sourcePath).abs;
  const { root } = await readJob(workspace, jobId);
  return withLock(root, async () => {
    const { job } = await readJob(workspace, jobId);
    const actual = await hashFile(source);
    invariant(actual.sizeBytes <= UI_LIMITS.maxFileBytes, "FILE_TOO_LARGE", "Input exceeds the file limit.");
    if (input.sha256) { assertHash(input.sha256); invariant(actual.sha256 === input.sha256.toLowerCase(), "HASH_MISMATCH", "Source file does not match the requested SHA-256."); }
    await commitInput(root, job, source, { path: relative, role: input.role, ...actual });
    return summary(job);
  });
}

/** Explicit local CLI import; this function is not exposed to remote MCP callers. */
export async function importLocalFile(workspace: Workspace, jobId: string, input: {
  sourcePath: string; path: string; role: InputRole;
}): Promise<JobSummary> {
  const source = await fs.realpath(path.resolve(input.sourcePath));
  const relative = safeRelative(input.path);
  const { root } = await readJob(workspace, jobId);
  return withLock(root, async () => {
    const { job } = await readJob(workspace, jobId);
    await commitInput(root, job, source, { path: relative, role: input.role, ...await hashFile(source) });
    return summary(job);
  });
}

export async function beginUpload(workspace: Workspace, jobId: string, input: {
  path: string; role: InputRole; sizeBytes: number; sha256: string;
}) {
  const relative = safeRelative(input.path);
  validateRole(input.role); assertHash(input.sha256);
  invariant(Number.isSafeInteger(input.sizeBytes) && input.sizeBytes > 0 && input.sizeBytes <= UI_LIMITS.maxFileBytes,
    "FILE_TOO_LARGE", "Declared file length is outside the workflow limit.");
  const digest = input.sha256.toLowerCase();
  const id = `up_${sha256(`${relative}\0${digest}`).slice(0, 32)}`;
  const { root } = await readJob(workspace, jobId);
  return withLock(root, async () => {
    const { job } = await readJob(workspace, jobId);
    const existing = reserveInput(job, relative, input.sizeBytes, digest, input.role);
    const folder = path.join(root, "uploads");
    const file = await containedPath(folder, `${id}.json`);
    let upload: Upload | undefined;
    try { upload = await readJson<Upload>(file, 4096); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (upload) {
      invariant(upload.path === relative && upload.role === input.role && upload.sizeBytes === input.sizeBytes && upload.sha256 === digest,
        "UPLOAD_CONFLICT", "Upload metadata conflicts with this request.");
      if (!upload.complete) upload.nextOffset = (await fs.stat(await containedPath(folder, `${id}.part`))).size;
    } else {
      let reserved = 0, count = 0;
      for (const name of await fs.readdir(folder)) {
        if (!/^up_[a-f0-9]{32}\.json$/.test(name)) continue;
        const pending = await readJson<Upload>(path.join(folder, name), 4096);
        if (!pending.complete) { reserved += pending.sizeBytes; count++; }
      }
      invariant(count < 16 && reserved + job.files.reduce((n, f) => n + f.sizeBytes, 0) + (existing ? 0 : input.sizeBytes) <= UI_LIMITS.maxJobBytes,
        "UPLOAD_CAPACITY", "Too many unfinished uploads or reserved bytes.");
      upload = { id, path: relative, role: input.role, sizeBytes: input.sizeBytes, sha256: digest, nextOffset: existing ? input.sizeBytes : 0, complete: !!existing };
      if (!existing) {
        const part = await containedPath(folder, `${id}.part`);
        try { await fs.writeFile(part, Buffer.alloc(0), { flag: "wx", mode: 0o600 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const orphan = await fs.lstat(part);
          invariant(orphan.isFile() && !orphan.isSymbolicLink() && orphan.size <= input.sizeBytes,
            "UPLOAD_CONFLICT", "Unregistered partial upload is not a valid bounded file.");
          upload.nextOffset = orphan.size;
        }
      }
    }
    await atomicJson(file, upload);
    return { uploadId: id, chunkBytes: UI_LIMITS.chunkBytes, nextOffset: upload.nextOffset, complete: upload.complete };
  });
}

export async function uploadChunk(workspace: Workspace, jobId: string, input: {
  uploadId: string; offset: number; dataBase64: string; sha256?: string;
}) {
  safeId(input.uploadId, "upload id");
  invariant(input.dataBase64.length <= Math.ceil(UI_LIMITS.chunkBytes / 3) * 4 && /^[a-zA-Z0-9+/]*={0,2}$/.test(input.dataBase64),
    "INVALID_CHUNK", "Chunk is too large or is not canonical base64.");
  const bytes = Buffer.from(input.dataBase64, "base64");
  invariant(bytes.length > 0 && bytes.length <= UI_LIMITS.chunkBytes && bytes.toString("base64") === input.dataBase64,
    "INVALID_CHUNK", "Use non-empty, canonical base64 chunks.");
  invariant(Number.isSafeInteger(input.offset) && input.offset >= 0, "INVALID_OFFSET", "Offset must be a non-negative integer.");
  if (input.sha256) { assertHash(input.sha256); invariant(sha256(bytes) === input.sha256.toLowerCase(), "HASH_MISMATCH", "Chunk hash is incorrect."); }
  const { root } = await readJob(workspace, jobId);
  return withLock(root, async () => {
    const folder = path.join(root, "uploads");
    const meta = await containedPath(folder, `${input.uploadId}.json`);
    const upload = await readJson<Upload>(meta, 4096);
    invariant(!upload.complete, "UPLOAD_COMPLETE", "The upload has already been committed.");
    const part = await containedPath(folder, `${input.uploadId}.part`);
    const handle = await fs.open(part, "r+");
    try {
      const size = (await handle.stat()).size;
      invariant(size <= upload.sizeBytes && input.offset <= size && input.offset + bytes.length <= upload.sizeBytes,
        "OFFSET_CONFLICT", `Upload expects offset ${size}; chunk exceeds the declared length or leaves a gap.`);
      const overlap = Math.min(size - input.offset, bytes.length);
      if (overlap > 0) {
        const old = Buffer.alloc(overlap);
        await handle.read(old, 0, overlap, input.offset);
        invariant(old.equals(bytes.subarray(0, overlap)), "CHUNK_CONFLICT", "Retry bytes differ from data already received.");
      }
      let written = overlap;
      while (written < bytes.length) {
        const result = await handle.write(bytes, written, bytes.length - written, input.offset + written);
        invariant(result.bytesWritten > 0, "WRITE_FAILED", "No bytes were written.");
        written += result.bytesWritten;
      }
      await handle.sync();
      upload.nextOffset = Math.max(size, input.offset + bytes.length);
    } finally { await handle.close(); }
    await atomicJson(meta, upload);
    return { uploadId: upload.id, nextOffset: upload.nextOffset, complete: false, readyToFinish: upload.nextOffset === upload.sizeBytes };
  });
}

export async function finishUpload(workspace: Workspace, jobId: string, uploadId: string): Promise<JobSummary> {
  safeId(uploadId, "upload id");
  const { root } = await readJob(workspace, jobId);
  return withLock(root, async () => {
    const { job } = await readJob(workspace, jobId);
    const folder = path.join(root, "uploads");
    const meta = await containedPath(folder, `${uploadId}.json`);
    const upload = await readJson<Upload>(meta, 4096);
    if (upload.complete) {
      const actual = await hashFile(await containedPath(path.join(root, "inputs"), upload.path));
      invariant(actual.sha256 === upload.sha256 && actual.sizeBytes === upload.sizeBytes,
        "INPUT_CHANGED", "The committed upload has changed outside the workflow.");
      return summary(job);
    }
    const part = await containedPath(folder, `${uploadId}.part`);
    invariant((await fs.stat(part)).size === upload.sizeBytes, "UPLOAD_INCOMPLETE", "Finish sending all bytes before committing the upload.");
    await commitInput(root, job, part, upload);
    upload.complete = true;
    upload.nextOffset = upload.sizeBytes;
    await atomicJson(meta, upload);
    await fs.rm(part, { force: true });
    return summary(job);
  });
}

export async function abortUpload(workspace: Workspace, jobId: string, uploadId: string) {
  safeId(uploadId, "upload id");
  const { root } = await readJob(workspace, jobId);
  return withLock(root, async () => {
    const folder = path.join(root, "uploads");
    const meta = await containedPath(folder, `${uploadId}.json`);
    const upload = await readJson<Upload>(meta, 4096);
    invariant(!upload.complete, "UPLOAD_COMPLETE", "Committed inputs cannot be deleted by aborting an upload.");
    await fs.rm(await containedPath(folder, `${uploadId}.part`), { force: true });
    await fs.unlink(meta);
    return { uploadId, aborted: true };
  });
}

export async function inspectTarget(workspace: Workspace, jobId: string, input: { path?: string; expectedRevision?: number } = {}) {
  const { root } = await readJob(workspace, jobId);
  return withLock(root, async () => {
    const { job } = await readJob(workspace, jobId);
    if (input.expectedRevision !== undefined) revision(job, input.expectedRevision);
    const targetPath = input.path ?? job.targetProject;
    invariant(targetPath, "TARGET_REQUIRED", "Select the actual target .fairy project or its source directory.");
    const profile = await inspectSourceTarget(workspace, targetPath);
    await atomicJson(path.join(root, "target.json"), profile);
    job.targetProject = targetPath;
    job.targetStatus = profile.status;
    job.targetHash = hashJson(profile);
    invalidate(job);
    if (profile.status !== "ready") job.status = "awaiting_target";
    await saveJob(root, job);
    return { job: summary(job), profile };
  });
}

function inputReferences(scene: Scene): string[] {
  return sceneInputFiles(scene);
}

export async function setScene(workspace: Workspace, jobId: string, input: { scene: unknown; expectedRevision: number }) {
  invariant(Buffer.byteLength(JSON.stringify(input.scene), "utf8") <= UI_LIMITS.maxSceneBytes, "SCENE_TOO_LARGE", "Scene JSON exceeds 2 MiB.");
  const scene = parseScene(input.scene);
  const validation = validateScene(scene);
  invariant(validation.status === "passed", "INVALID_SCENE", JSON.stringify(validation.errors));
  const { root } = await readJob(workspace, jobId);
  return withLock(root, async () => {
    const { job } = await readJob(workspace, jobId);
    revision(job, input.expectedRevision);
    for (const file of inputReferences(scene)) {
      safeRelative(file);
      invariant(job.files.some((f) => f.path === file), "INPUT_NOT_IMPORTED", `Import the input file '${file}' before setting the scene.`);
    }
    if (job.canvas) invariant(scene.canvas.width === job.canvas.width && scene.canvas.height === job.canvas.height,
      "CANVAS_MISMATCH", "Scene canvas must match the complete master design at its original size.");
    if (scene.referenceFile && job.designPath) invariant(scene.referenceFile === job.designPath,
      "DESIGN_MISMATCH", "The hidden comparison layer must use the job's complete master design.");
    const normalized: Scene = { ...scene, referenceFile: job.designPath ?? scene.referenceFile };
    await atomicJson(path.join(root, "scene.json"), normalized);
    job.sceneHash = hashJson(normalized);
    invalidate(job);
    await saveJob(root, job);
    return { job: summary(job), validation };
  });
}

export async function listArtifacts(workspace: Workspace, jobId: string): Promise<UiArtifact[]> {
  return (await readJob(workspace, jobId)).job.artifacts;
}

function mimeType(file: string): string {
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json", ".csv": "text/csv",
    ".txt": "text/plain", ".md": "text/markdown", ".zip": "application/zip", ".xml": "application/xml",
    ".fairy": "application/xml", ".psd": "image/vnd.adobe.photoshop", ".ttf": "font/ttf", ".otf": "font/otf" } as Record<string, string>)[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

async function verifyInputs(root: string, job: Job): Promise<void> {
  for (const file of job.files) {
    const actual = await hashFile(await containedPath(path.join(root, "inputs"), file.path));
    invariant(actual.sha256 === file.sha256 && actual.sizeBytes === file.sizeBytes, "INPUT_CHANGED", `Stored input '${file.path}' changed outside the workflow.`);
  }
}

async function artifactInventory(directory: string): Promise<UiArtifact[]> {
  const results: UiArtifact[] = [];
  let total = 0;
  for (const rel of await walkFiles(directory)) {
    const info = await hashFile(await containedPath(directory, rel));
    total += info.sizeBytes;
    invariant(total <= UI_LIMITS.maxJobBytes, "OUTPUT_CAPACITY", "Generated deliverables exceed the per-job output limit.");
    results.push({ path: rel, ...info, mimeType: mimeType(rel) });
  }
  return results;
}

async function zipDirectory(directory: string, destination: string, roots?: string[]): Promise<void> {
  const files: Record<string, Uint8Array> = {};
  let total = 0;
  for (const rel of await walkFiles(directory)) {
    if (roots && !roots.some((prefix) => rel === prefix || rel.startsWith(prefix + "/"))) continue;
    const file = await containedPath(directory, rel);
    const stat = await fs.stat(file);
    total += stat.size;
    invariant(total <= UI_LIMITS.maxJobBytes, "OUTPUT_CAPACITY", "Archive contents exceed the job limit.");
    files[rel] = await fs.readFile(file);
  }
  const zipped = zipSync(files, { level: 6 });
  // Round-trip only our own bounded archive: no extraction of untrusted ZIP input.
  const reopened = unzipSync(zipped);
  invariant(Object.keys(reopened).length === Object.keys(files).length && Object.entries(files).every(([name, data]) => sha256(data) === sha256(reopened[name])),
    "ZIP_VALIDATION_FAILED", "Archive round-trip checksum validation failed.");
  await fs.writeFile(destination, zipped, { flag: "wx" });
}

export async function readArtifactChunk(workspace: Workspace, jobId: string, input: { path: string; offset?: number; length?: number }) {
  const { root, job } = await readJob(workspace, jobId);
  const rel = safeRelative(input.path);
  const artifact = job.artifacts.find((f) => f.path === rel);
  invariant(artifact && job.buildDirectory, "ARTIFACT_NOT_FOUND", "Only registered completed-job artifacts can be downloaded.");
  const offset = input.offset ?? 0;
  const length = input.length ?? UI_LIMITS.readChunkBytes;
  invariant(Number.isSafeInteger(offset) && offset >= 0 && offset <= artifact.sizeBytes && Number.isSafeInteger(length) && length > 0 && length <= UI_LIMITS.readChunkBytes,
    "INVALID_RANGE", "Use a valid offset and a length up to 64 KiB.");
  const buildRoot = await containedPath(root, job.buildDirectory);
  const file = await containedPath(buildRoot, rel);
  const info = await hashFile(file);
  invariant(info.sha256 === artifact.sha256 && info.sizeBytes === artifact.sizeBytes, "ARTIFACT_CHANGED", "Artifact changed after validation.");
  const handle = await fs.open(file, "r");
  let bytes: Buffer;
  try {
    const buffer = Buffer.alloc(Math.min(length, artifact.sizeBytes - offset));
    const result = await handle.read(buffer, 0, buffer.length, offset);
    bytes = buffer.subarray(0, result.bytesRead);
  } finally { await handle.close(); }
  return { ...artifact, offset, nextOffset: offset + bytes.length, complete: offset + bytes.length === artifact.sizeBytes,
    chunkSha256: sha256(bytes), dataBase64: bytes.toString("base64") };
}

export async function readArtifactImage(workspace: Workspace, jobId: string, input: { path: string; maxEdge?: number }) {
  const { root, job } = await readJob(workspace, jobId);
  const rel = safeRelative(input.path);
  const artifact = job.artifacts.find((a) => a.path === rel);
  invariant(artifact && job.buildDirectory && ["image/png", "image/jpeg"].includes(artifact.mimeType),
    "PREVIEW_NOT_FOUND", "Choose a PNG or JPEG preview from the completed artifact inventory.");
  const file = await containedPath(await containedPath(root, job.buildDirectory), rel);
  const info = await hashFile(file);
  invariant(info.sha256 === artifact.sha256, "ARTIFACT_CHANGED", "Preview changed after validation.");
  const maxEdge = Math.min(2048, Math.max(256, input.maxEdge ?? 1536));
  const pipeline = sharp(file, { failOn: "error", limitInputPixels: 64 * 1024 * 1024 })
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true });
  let image = await pipeline.clone().png().toBuffer({ resolveWithObject: true });
  let mime = "image/png";
  if (image.data.length > 4 * 1024 * 1024) { image = await pipeline.clone().webp({ quality: 85 }).toBuffer({ resolveWithObject: true }); mime = "image/webp"; }
  invariant(image.data.length <= 4 * 1024 * 1024, "PREVIEW_TOO_LARGE", "Request a smaller maxEdge.");
  return { metadata: { path: rel, sourceSha256: artifact.sha256, width: image.info.width, height: image.info.height,
    note: "Preview of the actual generated file. Native FGUI rendering is a separate check." }, data: image.data.toString("base64"), mimeType: mime };
}

async function copyTree(source: string, destination: string, files?: string[]): Promise<void> {
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const rel of files ?? await walkFiles(source)) {
    await fs.copyFile(await containedPath(source, rel), await ensureParent(destination, rel), 1);
  }
}

function portableValue(value: unknown, buildRoot: string, inputsRoot: string): unknown {
  if (typeof value === "string") {
    if (value.startsWith(buildRoot + path.sep)) return path.relative(buildRoot, value).split(path.sep).join("/");
    if (value.startsWith(inputsRoot + path.sep)) return "Inputs/" + path.relative(inputsRoot, value).split(path.sep).join("/");
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => portableValue(v, buildRoot, inputsRoot));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, portableValue(v, buildRoot, inputsRoot)]));
  return value;
}

const csvCell = (value: unknown): string => `"${String(value ?? "").replaceAll('"', '""')}"`;

export async function buildJob(workspace: Workspace, jobId: string, input: { expectedRevision: number }): Promise<JobSummary> {
  const { root } = await readJob(workspace, jobId);
  return withLock(root, async () => {
    const { job } = await readJob(workspace, jobId);
    revision(job, input.expectedRevision);
    invariant(job.designPath && job.sceneHash && job.targetHash && job.targetStatus === "ready",
      "BUILD_NOT_READY", "Import a complete master design, inspect a supported actual target and set a valid scene before building.");
    const scene = parseScene(await readJson<unknown>(path.join(root, "scene.json")));
    const profile = await readJson<TargetProfile>(path.join(root, "target.json"), 12 * 1024 * 1024);
    invariant(hashJson(scene) === job.sceneHash && hashJson(profile) === job.targetHash,
      "STATE_CHANGED", "Scene or target profile changed outside the workflow.");
    const validation = validateScene(scene);
    invariant(validation.status === "passed", "INVALID_SCENE", JSON.stringify(validation.errors));
    invariant(scene.canvas.width === job.canvas?.width && scene.canvas.height === job.canvas?.height,
      "CANVAS_MISMATCH", "The master design and scene canvas differ.");
    const inputRoot = path.join(root, "inputs");
    await verifyInputs(root, job);
    await verifyTargetProfile(workspace, profile);
    const inputHash = hashJson({ pluginVersion: VERSION, scene: job.sceneHash, target: job.targetHash,
      files: job.files.map((f) => ({ path: f.path, sha256: f.sha256, sizeBytes: f.sizeBytes })), atlas: job.atlas });
    if (job.buildInputHash === inputHash && job.buildDirectory && job.artifacts.length) {
      const inventory = await artifactInventory(await containedPath(root, job.buildDirectory));
      invariant(JSON.stringify(inventory) === JSON.stringify(job.artifacts), "ARTIFACT_CHANGED", "Completed build files have changed; use a new job revision.");
      return summary(job);
    }
    job.status = "building";
    job.checks = pendingChecks();
    job.artifacts = [];
    delete job.error;
    await saveJob(root, job);
    const temporaryName = `builds/staging-${randomUUID()}`;
    const temporary = path.dirname(await ensureParent(root, `${temporaryName}/build.marker`));
    try {
      const reports = path.join(temporary, "Reports"), previews = path.join(temporary, "Previews");
      await fs.mkdir(reports, { recursive: true });
      await fs.mkdir(previews, { recursive: true });
      await copyTree(inputRoot, path.join(temporary, "Inputs"), job.files.map((f) => f.path));
      for (const file of job.files) {
        const copy = await hashFile(await containedPath(path.join(temporary, "Inputs"), file.path));
        invariant(copy.sha256 === file.sha256 && copy.sizeBytes === file.sizeBytes, "COPY_VALIDATION_FAILED", "An archived source input differs from its immutable input.");
      }
      const master = path.join(previews, "Design_Master.png");
      await sharp(await containedPath(inputRoot, job.designPath), { limitInputPixels: UI_LIMITS.maxImagePixels, failOn: "error" })
        .toColourspace("srgb").ensureAlpha().png().toFile(master);
      const resolved = resolveScene(scene, profile.rendering);
      const rendered = await renderScene(scene, resolved, inputRoot, path.join(temporary, "PNG"),
        job.atlas ? { atlas: { ratio: "9:25" } } : {});
      const psd = await buildPsd(rendered, master, path.join(temporary, "Interface.psd"));
      invariant(psd.status === "passed", "PSD_VALIDATION_FAILED", JSON.stringify(psd.failures));
      job.checks.psd = "passed";
      await saveJob(root, job);
      const fguiRoot = path.join(temporary, "FGUI_Source");
      const fgui = await exportFgui(scene, profile, inputRoot, fguiRoot, job.id);
      invariant(fgui.validation.status === "passed", "FGUI_VALIDATION_FAILED", JSON.stringify(fgui.validation));
      await fs.copyFile(rendered.composite, path.join(previews, "PSD_Composite.png"), 1);
      await fs.copyFile(rendered.contactSheet, path.join(previews, "All_PNG_Overview.png"), 1);
      const data = {
        schemaVersion: 1, coordinateOrigin: "top-left of the complete design", pathBase: "delivery-root", sceneInputRoot: "Inputs",
        scene, resolved, rendered: portableValue(rendered, temporary, inputRoot),
      };
      await atomicJson(path.join(temporary, "layout.json"), data);
      await atomicJson(path.join(temporary, "ui_semantics.json"), {
        schemaVersion: 1, canvas: scene.canvas, entry: scene.entry, coordinateOrigin: data.coordinateOrigin,
        assets: scene.assets.map((a) => ({ ...a, materialType: "PNG", sourceFile: "Inputs/" + a.file })),
        fonts: scene.fonts, components: scene.components, nodes: resolved.nodes,
        sourceNotes: "Scene components preserve UI semantics. Groups refer to siblings and are not coordinate parents. Ordinary text remains native editable text in the FGUI source.",
      });
      const header = ["id", "source_id", "name", "type", "component", "parent", "global_x", "global_y", "local_x", "local_y", "width", "height", "z", "opacity", "visible", "asset_id", "text"];
      const rows = resolved.nodes.map((n) => [n.id, n.sourceId, n.name, n.type, n.componentId, n.parentId, n.x, n.y, n.localX, n.localY, n.width, n.height, n.z, n.opacity, n.visible, n.assetId, n.text]);
      await fs.writeFile(path.join(temporary, "layout_mapping.csv"), "\ufeff" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n", "utf8");
      await atomicJson(path.join(temporary, "text_and_fonts.json"), {
        fonts: scene.fonts, text: resolved.nodes.filter((n) => ["Text", "RichText", "InputText"].includes(n.type)).map((n) => ({ id: n.id, type: n.type, text: n.text, style: n.style, referenceAssetId: n.referenceAssetId })),
        renderingDifferences: rendered.limitations,
      });
      await atomicJson(path.join(temporary, "controls_states_bindings.json"), {
        components: scene.components.map((c) => ({ id: c.id, semantic: c.semantic, extension: c.extension, controllers: c.controllers,
          children: c.children.filter((n) => n.instance || n.list || n.input || n.bindings || n.recognition).map((n) => ({ id: n.id, type: n.type, instance: n.instance, list: n.list, input: n.input, bindings: n.bindings, recognition: n.recognition })) })),
        assumptions: scene.assumptions ?? [], businessCallbacks: "Unbound/external handlers are declarations only; this exporter does not implement game services.",
      });
      await atomicJson(path.join(reports, "target_format_research.json"), profile);
      await atomicJson(path.join(reports, "scene_static.json"), validation);
      await atomicJson(path.join(reports, "fgui_static.json"), fgui);
      await atomicJson(path.join(reports, "psd_validation.json"), psd);
      const finalChecks = {
        schemaVersion: 1, jobId: job.id, buildInputHash: inputHash,
        static: { status: "passed", checks: ["scene semantics and references", "actual target fingerprint", "FGUI XML/resource/dependency validation", "output package limits", "PNG/PSD byte and pixel validation", "ZIP round-trip checksums"] },
        psd: { status: "passed", independentLayers: psd.independentLayerCount, hiddenReference: psd.hiddenReference },
        visualReview: { status: "not_verified", note: "Inspect the actual master, composite and asset overview with ui_preview_artifact before accepting art quality." },
        editorImport: { status: "not_verified", note: "Requires a configured native validator that opens, saves, reopens and renders this exact source ZIP." },
        runtimeInteraction: { status: "not_verified", note: "No interactive runtime result is inferred from XML syntax or the PSD preview." },
        consistency: { status: "passed", scope: "shared initial layout data", nativeRendering: "not_verified" },
        limitations: [...new Set([...rendered.limitations, ...psd.limitations])],
      };
      await atomicJson(path.join(reports, "validation.json"), finalChecks);
      await fs.writeFile(path.join(temporary, "README.txt"), [
        `${scene.name} — UI production delivery`, "",
        "Interface.psd: genuine independent raster layers, functional groups, hidden complete design reference.",
        "PNG_Assets.zip: usage-sized RGBA layers plus original inputs; fonts/text remain editable in the native FGUI source.",
        "FGUI_Source.zip: extract into an empty directory, then open the .fairy file in the compatible editor.",
        "To integrate a package: back up the target project, copy FGUI_Source/assets/<package> into its assets directory, include the declared font/settings requirements, then refresh and verify in that editor.",
        "layout.json and ui_semantics.json retain semantic types, global/local geometry, text and resource mappings. layout_mapping.csv is the flat review table.",
        "Reports/validation.json distinguishes static checks, PSD checks, visual review, editor import and runtime interaction.",
        "Previews/PSD_Composite.png is the assembled layer preview. It is NOT a screenshot from an FGUI editor.",
        "The current native source adapter is selected from the recorded target project. Business callbacks remain listed separately until implemented by the game.",
        job.atlas ? "The optional transparent atlas has ratio 9:25; the PSD/FGUI canvas still matches the complete master design." : "No 9:25 atlas was requested.",
        "", "中文说明：先查看完整设计稿、PSD 合成图和素材总览。XML 静态检查通过不等于编辑器导入或运行时交互验证通过；没有执行的步骤在报告中标为 not_verified。",
      ].join("\n") + "\n", "utf8");
      // Make all generated reports portable before archiving/renaming staging.
      for (const rel of await walkFiles(temporary)) {
        if (!rel.endsWith(".json") || rel.startsWith("Inputs/") || rel.startsWith("FGUI_Source/")) continue;
        const file = await containedPath(temporary, rel);
        await atomicJson(file, portableValue(await readJson<unknown>(file, 32 * 1024 * 1024), temporary, inputRoot));
      }
      await zipDirectory(temporary, path.join(temporary, "PNG_Assets.zip"), ["PNG", "Inputs"]);
      await zipDirectory(fguiRoot, path.join(temporary, "FGUI_Source.zip"));
      await verifyInputs(root, job);
      await verifyTargetProfile(workspace, profile);
      const artifacts = await artifactInventory(temporary);
      const completedName = `builds/rev-${job.revision}-${inputHash.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
      const completed = await containedPath(root, completedName);
      await fs.rename(temporary, completed);
      job.buildDirectory = completedName;
      job.buildInputHash = inputHash;
      job.artifacts = artifacts;
      job.checks.static = "passed";
      job.status = "built";
      await saveJob(root, job);
      return summary(job);
    } catch (error) {
      job.status = "failed";
      job.checks.static = "failed";
      job.error = { code: typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "BUILD_FAILED", message: (error as Error).message };
      await saveJob(root, job);
      // Only this attempt's unpublished staging directory is removed.
      await fs.rm(temporary, { recursive: true, force: true });
      throw new UiWorkflowError(job.error.code, job.error.message);
    }
  });
}

async function verifyReceipt(directory: string, receipt: DeliveryReceipt): Promise<void> {
  for (const artifact of receipt.artifacts) {
    const file = await containedPath(directory, artifact.path);
    const actual = await hashFile(file);
    invariant(actual.sizeBytes === artifact.sizeBytes && actual.sha256 === artifact.sha256,
      "DELIVERY_CHANGED", `Saved file '${artifact.path}' was modified; existing delivery will not be overwritten.`);
  }
  const actualNames = (await walkFiles(directory)).filter((f) => f !== "delivery_receipt.json");
  invariant(actualNames.length === receipt.artifacts.length && actualNames.every((name) => receipt.artifacts.some((f) => f.path === name)),
    "DELIVERY_CHANGED", "Saved directory contains extra or missing files; it will not be overwritten.");
}

export async function deliverJob(workspace: Workspace, jobId: string, input: { destinationId?: string; subdirectory?: string } = {}): Promise<DeliveryReceipt> {
  const { root } = await readJob(workspace, jobId);
  return withLock(root, async () => {
    const { job } = await readJob(workspace, jobId);
    invariant(job.buildDirectory && job.buildInputHash && job.checks.static === "passed" && job.checks.psd === "passed" && job.artifacts.length > 0,
      "DELIVERY_NOT_READY", "A complete validated build is required before delivery.");
    invariant(job.checks.editorImport !== "failed" && job.checks.runtimeInteraction !== "failed" &&
      job.nativeValidation?.status !== "failed" && job.nativeValidation?.status !== "running",
      "NATIVE_VALIDATION_FAILED", "The latest native validation failed or is incomplete. Resolve it and run validation again before final delivery.");
    const profile = await readJson<TargetProfile>(path.join(root, "target.json"), 12 * 1024 * 1024);
    await verifyTargetProfile(workspace, profile);
    await verifyInputs(root, job);
    const source = await containedPath(root, job.buildDirectory);
    const actual = await artifactInventory(source);
    invariant(JSON.stringify(actual) === JSON.stringify(job.artifacts), "ARTIFACT_CHANGED", "Built artifacts changed after verification; delivery stopped.");
    const destination = await resolveDestination(workspace, input.destinationId ?? job.destinationId);
    const relative = safeRelative(input.subdirectory ?? job.outputSubdirectory);
    const final = await ensureParent(destination.path, relative);
    try {
      const existing = await fs.lstat(final);
      invariant(existing.isDirectory() && !existing.isSymbolicLink(), "DELIVERY_CONFLICT", "Output path already exists and is not this delivery.");
      let receipt: DeliveryReceipt;
      try { receipt = await readJson<DeliveryReceipt>(await containedPath(final, "delivery_receipt.json"), UI_LIMITS.maxManifestBytes); }
      catch { throw new UiWorkflowError("DELIVERY_CONFLICT", "Output folder already exists; choose a new subdirectory."); }
      invariant(receipt.jobId === job.id && receipt.buildInputHash === job.buildInputHash && JSON.stringify(receipt.artifacts) === JSON.stringify(job.artifacts),
        "DELIVERY_CONFLICT", "Output folder belongs to a different build; choose a new subdirectory.");
      invariant(receipt.destinationId === destination.id && samePath(receipt.directory, final),
        "DELIVERY_CONFLICT", "Existing receipt belongs to a different directory. Choose a fresh output folder.");
      await verifyReceipt(final, receipt);
      job.delivery = receipt; job.status = "delivered"; await saveJob(root, job);
      return receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const stagingName = `.ui-delivery-${randomUUID()}`;
    const staging = await containedPath(destination.path, stagingName);
    await fs.mkdir(staging, { mode: 0o700 });
    try {
      await copyTree(source, staging, job.artifacts.map((f) => f.path));
      const receipt: DeliveryReceipt = { jobId: job.id, destinationId: destination.id, directory: final, createdAt: now(),
        fileCount: job.artifacts.length, totalBytes: job.artifacts.reduce((sum, f) => sum + f.sizeBytes, 0), artifacts: job.artifacts, buildInputHash: job.buildInputHash };
      await atomicJson(path.join(staging, "delivery_receipt.json"), receipt);
      await verifyReceipt(staging, receipt);
      await containedPath(destination.path, relative);
      try { await fs.lstat(final); throw new UiWorkflowError("DELIVERY_CONFLICT", "Output folder appeared during copying; choose another subdirectory."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await fs.rename(staging, final);
      await verifyReceipt(final, receipt);
      job.delivery = receipt;
      job.status = "delivered";
      await saveJob(root, job);
      return receipt;
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
  });
}

// Internal integration points for the separately configured trusted validator.
export { readJob as readWorkflowJob, saveJob as saveWorkflowJob, artifactInventory as inventoryArtifacts,
  copyTree as copyWorkflowTree, verifyInputs as verifyWorkflowInputs };
