import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Workspace } from "../workspace/manager.js";
import { parseScene, resolveScene } from "./scene.js";
import { verifyTargetProfile, type TargetProfile } from "./target.js";
import {
  getJob, readWorkflowJob, saveWorkflowJob, inventoryArtifacts, copyWorkflowTree, verifyWorkflowInputs,
  type JobSummary,
} from "./workflow.js";
import { atomicJson, containedPath, ensureParent, hashFile, hashJson, invariant, readJson, safeId, safeRelative, stateRoot, withLock, UiWorkflowError } from "./storage.js";

export interface NativeAdapter {
  id: string; command: string; args: string[]; timeoutMs: number;
  trustedFiles: { path: string; sha256: string }[];
}
const Status = z.enum(["passed", "failed", "not_verified"]);
const Check = z.object({ name: z.string().min(1).max(160), type: z.string().max(40).optional(), status: Status,
  note: z.string().max(4000).optional() }).strict();
const Stage = z.object({ status: Status, checks: z.array(Check).max(512), note: z.string().max(8000).optional() }).strict();
export const NativeReportSchema = z.object({
  schemaVersion: z.literal(1), jobId: z.string(), buildInputHash: z.string().regex(/^[0-9a-f]{64}$/),
  sourceZipSha256: z.string().regex(/^[0-9a-f]{64}$/), editorImport: Stage, runtimeInteraction: Stage,
  evidence: z.array(z.string().max(480)).max(128), limitations: z.array(z.string().max(8000)).max(100),
}).strict();
export type NativeReport = z.infer<typeof NativeReportSchema>;

async function configuration(workspace: Workspace): Promise<NativeAdapter[]> {
  const file = path.join(await stateRoot(workspace), "native-adapters.json");
  try {
    const stored = await readJson<{ schemaVersion: number; adapters: NativeAdapter[] }>(file, 128 * 1024);
    invariant(stored.schemaVersion === 1 && Array.isArray(stored.adapters), "INVALID_NATIVE_CONFIG", "Invalid local native-validator configuration.");
    return stored.adapters;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function listNativeAdapters(workspace: Workspace) {
  return (await configuration(workspace)).map(({ id, command, timeoutMs }) => ({ id, command, timeoutMs }));
}

/** Configuration is exclusively a local CLI operation; never an MCP tool. */
export async function addNativeAdapter(workspace: Workspace, input: { id: string; command: string; args?: string[]; timeoutMs?: number }): Promise<NativeAdapter> {
  safeId(input.id, "validator id");
  const candidate = /^(node|node\.exe)$/i.test(input.command) ? process.execPath : input.command;
  invariant(path.isAbsolute(candidate), "INVALID_NATIVE_COMMAND", "Use an absolute executable path, or the current Node executable via 'node'.");
  const command = await fs.realpath(candidate);
  invariant((await fs.stat(command)).isFile(), "INVALID_NATIVE_COMMAND", "Validator executable is not a file.");
  const args = [...(input.args ?? [])];
  invariant(args.length <= 32 && args.every((arg) => typeof arg === "string" && arg.length <= 2000 && !arg.includes("\0")),
    "INVALID_NATIVE_ARGS", "Use a bounded array of literal validator arguments. No shell is invoked.");
  const timeoutMs = input.timeoutMs ?? 120_000;
  invariant(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 300_000,
    "INVALID_NATIVE_TIMEOUT", "Validator timeout must be 1–300 seconds.");
  const trustedFiles = [{ path: command, sha256: (await hashFile(command)).sha256 }];
  for (const [index, arg] of args.entries()) {
    if (arg === "{request}") continue;
    // Resolve file arguments against the execution directory at registration,
    // including relative scripts and --import=file style Node arguments.
    const separator = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const prefix = separator > 0 ? arg.slice(0, separator + 1) : "";
    const value = prefix ? arg.slice(separator + 1) : arg;
    if (!value || (value.startsWith("-") && !prefix)) continue;
    const candidate = path.resolve(workspace.root, value);
    try {
      const real = await fs.realpath(candidate);
      if ((await fs.stat(real)).isFile()) {
        args[index] = prefix + real;
        if (!trustedFiles.some((file) => file.path === real)) trustedFiles.push({ path: real, sha256: (await hashFile(real)).sha256 });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      invariant(!/\.(?:mjs|cjs|js|ts|ps1|py|cmd|bat|sh)$/i.test(value),
        "NATIVE_CODE_NOT_FOUND", "A configured code file must exist when the validator is registered.");
    }
  }
  const adapter: NativeAdapter = { id: input.id, command, args, timeoutMs, trustedFiles };
  const root = await stateRoot(workspace);
  await withLock(root, async () => {
    const adapters = (await configuration(workspace)).filter((a) => a.id !== adapter.id);
    adapters.push(adapter);
    await atomicJson(path.join(root, "native-adapters.json"), { schemaVersion: 1, adapters });
  });
  return adapter;
}

export async function removeNativeAdapter(workspace: Workspace, id: string) {
  safeId(id, "validator id");
  const root = await stateRoot(workspace);
  return withLock(root, async () => {
    const before = await configuration(workspace);
    const adapters = before.filter((a) => a.id !== id);
    await atomicJson(path.join(root, "native-adapters.json"), { schemaVersion: 1, adapters });
    return { removed: adapters.length !== before.length };
  });
}

async function execute(adapter: NativeAdapter, requestFile: string, cwd: string): Promise<{ exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }> {
  for (const file of adapter.trustedFiles) {
    invariant((await hashFile(file.path)).sha256 === file.sha256, "NATIVE_ADAPTER_CHANGED",
      "The configured native validator changed. Re-register its current code with the local CLI before running it.");
  }
  const usesPlaceholder = adapter.args.includes("{request}");
  const args = adapter.args.map((arg) => arg === "{request}" ? requestFile : arg);
  if (!usesPlaceholder) args.push(requestFile);
  return new Promise((resolve, reject) => {
    // Fixed, locally configured executable and literal arguments. Never a shell command from a scene or tool call.
    const child = spawn(adapter.command, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const append = (current: string, value: Buffer): string => (current + value.toString("utf8")).slice(0, 64 * 1024);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, adapter.timeoutMs);
    const force = setTimeout(() => { if (timedOut) child.kill("SIGKILL"); }, adapter.timeoutMs + 2000);
    child.once("error", (error) => { clearTimeout(timer); clearTimeout(force); reject(error); });
    child.once("close", (exitCode) => { clearTimeout(timer); clearTimeout(force); resolve({ exitCode, timedOut, stdout, stderr }); });
  });
}

function validateReport(report: NativeReport, expected: { jobId: string; buildInputHash: string; sourceZipSha256: string; expectedInteractions: string[] }): void {
  invariant(report.jobId === expected.jobId && report.buildInputHash === expected.buildInputHash && report.sourceZipSha256 === expected.sourceZipSha256,
    "NATIVE_REPORT_MISMATCH", "Native report belongs to a different job or source ZIP.");
  if (report.editorImport.status === "passed") {
    invariant(["open", "save", "reopen", "render"].every((name) => report.editorImport.checks.some((check) => check.name === name && check.status === "passed")) &&
      report.editorImport.checks.every((check) => check.status === "passed"), "INCOMPLETE_NATIVE_CHECKS", "An editor-import pass requires actual open/save/reopen/render checks.");
  }
  if (report.runtimeInteraction.status === "passed") {
    invariant(report.runtimeInteraction.checks.length > 0 && report.runtimeInteraction.checks.every((check) => check.status === "passed") &&
      expected.expectedInteractions.every((type) => report.runtimeInteraction.checks.some((check) => check.type === type && check.status === "passed")),
      "INCOMPLETE_NATIVE_CHECKS", "Runtime pass must cover all interactive control types in this scene.");
  }
  for (const file of report.evidence) safeRelative(file);
}

export async function runNativeValidation(workspace: Workspace, jobId: string, input: { adapterId: string }): Promise<{ job: JobSummary; report: NativeReport }> {
  safeId(input.adapterId, "validator id");
  const adapter = (await configuration(workspace)).find((a) => a.id === input.adapterId);
  invariant(adapter, "NATIVE_ADAPTER_NOT_CONFIGURED", "Register a native validator locally before running this step. Static results are not a substitute.");
  const { root } = await readWorkflowJob(workspace, jobId);
  return withLock(root, async () => {
    const { job } = await readWorkflowJob(workspace, jobId);
    invariant(job.buildDirectory && job.buildInputHash && job.checks.static === "passed" && job.checks.psd === "passed",
      "BUILD_REQUIRED", "Build and statically verify the actual source package first.");
    await verifyWorkflowInputs(root, job);
    const profile = await readJson<TargetProfile>(path.join(root, "target.json"), 12 * 1024 * 1024);
    await verifyTargetProfile(workspace, profile);
    const previous = await containedPath(root, job.buildDirectory);
    invariant(JSON.stringify(await inventoryArtifacts(previous)) === JSON.stringify(job.artifacts), "ARTIFACT_CHANGED", "Built artifacts changed before native validation.");
    const sourceZip = job.artifacts.find((file) => file.path === "FGUI_Source.zip");
    invariant(sourceZip, "SOURCE_ZIP_REQUIRED", "No native source ZIP is registered for this build.");
    const scene = parseScene(await readJson<unknown>(path.join(root, "scene.json")));
    invariant(hashJson(scene) === job.sceneHash && hashJson(profile) === job.targetHash,
      "STATE_CHANGED", "Scene or target profile changed outside the workflow.");
    const interactions = new Set(["Button", "InputText", "Slider", "ProgressBar", "List", "ComboBox", "ScrollBar"]);
    const expectedInteractions = [...new Set(resolveScene(scene, profile.rendering).nodes.filter((n) => n.visible && interactions.has(n.type)).map((n) => n.type))];
    const runId = randomUUID();
    const work = path.dirname(await ensureParent(root, `native-runs/${runId}/request.json`));
    const output = path.join(work, "output");
    await fs.mkdir(output, { recursive: true });
    const sourceDirectory = path.join(work, "source");
    await copyWorkflowTree(path.join(previous, "FGUI_Source"), sourceDirectory);
    const request = { schemaVersion: 1, jobId: job.id, buildInputHash: job.buildInputHash, sourceZipSha256: sourceZip.sha256,
      workspaceRoot: workspace.root, sourceDirectory, sourceZip: path.join(previous, "FGUI_Source.zip"),
      sceneFile: path.join(root, "scene.json"), outputDirectory: output, reportFile: path.join(output, "report.json"), expectedInteractions };
    const requestFile = path.join(work, "request.json");
    await atomicJson(requestFile, request);
    job.nativeValidation = { adapterId: adapter.id, status: "running", startedAt: new Date().toISOString() };
    delete job.error;
    await saveWorkflowJob(root, job);
    try {
      const execution = await execute(adapter, requestFile, workspace.root);
      await atomicJson(path.join(work, "execution.json"), { adapterId: adapter.id, ...execution });
      invariant(!execution.timedOut && execution.exitCode === 0, "NATIVE_EXECUTION_FAILED",
        execution.timedOut ? "Native validator timed out. No import or interaction success was recorded." : "Native validator exited unsuccessfully. Review its local execution report.");
      const report = NativeReportSchema.parse(await readJson<unknown>(request.reportFile, 2 * 1024 * 1024));
      validateReport(report, request);
      await verifyTargetProfile(workspace, profile);
      await verifyWorkflowInputs(root, job);
      invariant(JSON.stringify(await inventoryArtifacts(previous)) === JSON.stringify(job.artifacts), "ARTIFACT_CHANGED", "Native validator modified the validated deliverables.");
      const candidateName = `builds/native-${runId}`;
      const candidate = path.dirname(await ensureParent(root, `${candidateName}/build.marker`));
      try {
        await copyWorkflowTree(previous, candidate, job.artifacts.map((a) => a.path));
        // Remove previous native evidence in this unpublished new revision only.
        await fs.rm(path.join(candidate, "Reports", "native"), { recursive: true, force: true });
        await fs.rm(path.join(candidate, "Previews", "FGUI_Native.png"), { force: true });
        const evidence = path.join(candidate, "Reports", "native");
        await fs.mkdir(evidence, { recursive: true });
        for (const rel of [...new Set(report.evidence)].filter((name) => name !== "report.json")) {
          await fs.copyFile(await containedPath(output, rel), await ensureParent(evidence, rel), 1);
        }
        if (report.evidence.includes("native-preview.png")) {
          await fs.copyFile(path.join(evidence, "native-preview.png"), path.join(candidate, "Previews", "FGUI_Native.png"), 1);
        }
        await atomicJson(path.join(evidence, "report.json"), { ...report, adapterId: adapter.id, trustedFiles: adapter.trustedFiles, executedAt: new Date().toISOString() });
        const validationFile = path.join(candidate, "Reports", "validation.json");
        const validation = await readJson<Record<string, unknown>>(validationFile);
        validation.editorImport = report.editorImport;
        validation.runtimeInteraction = report.runtimeInteraction;
        validation.nativeEvidence = "Reports/native/report.json";
        await atomicJson(validationFile, validation);
        const artifacts = await inventoryArtifacts(candidate);
        job.buildDirectory = candidateName;
        job.artifacts = artifacts;
        job.checks.editorImport = report.editorImport.status;
        job.checks.runtimeInteraction = report.runtimeInteraction.status;
        job.nativeValidation.status = "completed";
        job.nativeValidation.finishedAt = new Date().toISOString();
        job.status = "built";
        delete job.delivery;
        await saveWorkflowJob(root, job);
      } catch (error) { await fs.rm(candidate, { recursive: true, force: true }); throw error; }
      return { job: await getJob(workspace, jobId), report };
    } catch (error) {
      job.nativeValidation.status = "failed";
      job.nativeValidation.finishedAt = new Date().toISOString();
      job.error = { code: "NATIVE_VALIDATION_FAILED", message: "Native validation did not complete successfully. Its local run record is preserved." };
      await saveWorkflowJob(root, job);
      if (error instanceof UiWorkflowError) throw error;
      throw new UiWorkflowError("NATIVE_VALIDATION_FAILED", "Native validator returned an invalid report or could not run. No success was recorded.");
    }
  });
}
