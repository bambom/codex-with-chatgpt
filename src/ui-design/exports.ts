import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { assertExportJob } from "@magicgamestudio/ui-design-contract/exports";
import type { Workspace } from "../workspace/manager.js";
import { UiWorkflowError } from "../ui/storage.js";
import { readStandardRevision } from "./intake.js";
import { platformExportRequest, platformOnlineProtocol, streamPlatformExport } from "./platform.js";
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const targetId = z.string().regex(/^target_[a-f0-9]{16}$/);
function fail(message: string): never { throw new UiWorkflowError("PLATFORM_RESPONSE_INVALID", message); }
function checked(value: unknown, design: string, id?: string) {
  try { return assertExportJob(value, design, id); } catch { return fail("Export report does not match its fixed revision, files or attempt history."); }
}
export async function exportTargets(workspace: Workspace, design: string) {
  return z.object({ formats: z.array(z.enum(["PSD", "FGUI"])).length(2), targets: z.array(z.object({ id: targetId, sha256: sha, project: z.unknown(), capabilities: z.unknown(), checks: z.unknown() }).strict()).max(50), exporter: z.object({ version: z.literal("standard-export-1"), sha256: sha }).strict() }).strict()
    .parse(await platformExportRequest(workspace, design, "/exports/targets", "GET"));
}
export async function readExport(workspace: Workspace, design: string, job: string) {
  z.string().uuid().parse(job); return checked(await platformExportRequest(workspace, design, "/exports/" + job, "GET"), design, job);
}
export async function listExports(workspace: Workspace, design: string, revision = 0) {
  z.number().int().min(0).max(1e9).parse(revision);
  const result = z.object({ designId: z.literal(design), limit: z.literal(100), jobs: z.array(z.object({ jobId: z.string().uuid(), designId: z.literal(design), revision: z.number().int().min(1).max(1e9), targetFormat: z.enum(["PSD", "FGUI"]), state: z.enum(["QUEUED","RUNNING","SUCCEEDED","RETRYABLE","FAILED","CANCELLED"]), createdAt: z.string(), updatedAt: z.string() }).strict()).max(100) }).strict()
    .parse(await platformExportRequest(workspace, design, "/exports?revision=" + revision, "GET"));
  if (new Set(result.jobs.map(j => j.jobId)).size !== result.jobs.length || revision && result.jobs.some(j => j.revision !== revision)) return fail("Export list differs from the requested revision.");
  return result;
}
export async function beginExport(workspace: Workspace, design: string, requestId: string, revision: number, format: "PSD" | "FGUI", target: string | null = null) {
  z.string().uuid().parse(requestId); z.number().int().min(1).max(1e9).parse(revision); z.enum(["PSD", "FGUI"]).parse(format);
  if (format === "FGUI") targetId.parse(target); else if (target !== null) throw new UiWorkflowError("INVALID_EXPORT_TARGET", "PSD does not accept a target profile.");
  await platformOnlineProtocol(workspace);
  const source = await readStandardRevision(workspace, design, revision);
  const pin = { revision, targetFormat: format, documentHash: source.receipt.committedDocumentHash, assetManifestHash: source.receipt.committedAssetManifestHash, targetId: target };
  const job = checked(await platformExportRequest(workspace, design, "/exports", "POST", { requestId, ...pin }), design);
  if (job.revision !== revision || job.targetFormat !== format || job.documentHash !== pin.documentHash || job.assetManifestHash !== pin.assetManifestHash || job.targetId !== target) return fail("Export did not bind the requested revision and target.");
  return job;
}
export async function cancelExport(workspace: Workspace, design: string, job: string) {
  z.string().uuid().parse(job); return checked(await platformExportRequest(workspace, design, "/exports/" + job, "DELETE"), design, job);
}
export async function retryExport(workspace: Workspace, design: string, job: string) {
  z.string().uuid().parse(job); return checked(await platformExportRequest(workspace, design, "/exports/" + job + "/retry", "POST", {}), design, job);
}
export async function downloadExport(workspace: Workspace, design: string, job: string, index: number, destination: string) {
  z.number().int().min(0).max(31).parse(index);
  const source = await readExport(workspace, design, job), file = source.files[index];
  if (source.state !== "SUCCEEDED" || !file) throw new UiWorkflowError("EXPORT_FILE_UNAVAILABLE", "Read a successful export and select an existing file index.");
  let target = workspace.resolve(destination); if (!target.rel) throw new UiWorkflowError("INVALID_EXPORT_DESTINATION", "Choose a new workspace file.");
  await fs.mkdir(path.dirname(target.abs), { recursive: true }); target = workspace.resolve(destination);
  // Same-directory staging plus exclusive hard-link publication never overwrites an existing destination.
  const staged = workspace.resolve(path.join(path.dirname(target.rel), ".ui-export-" + randomUUID() + ".part")).abs;
  const handle = await fs.open(staged, "wx", 0o600); const hash = createHash("sha256");
  try {
    await streamPlatformExport(workspace, design, job, index, file, async chunk => { hash.update(chunk); await handle.writeFile(chunk); });
    if (hash.digest("hex") !== file.sha256) throw new UiWorkflowError("EXPORT_FILE_CHANGED", "Downloaded bytes differ from the retained file hash.");
    await handle.sync(); await handle.close();
    const current = await readExport(workspace, design, job);
    if (current.reportHash !== source.reportHash) return fail("Export result changed during download.");
    const resolved = workspace.resolve(destination); if (resolved.abs !== target.abs) throw new UiWorkflowError("INVALID_EXPORT_DESTINATION", "The destination changed during download.");
    await fs.link(staged, target.abs);
    return { downloaded: true, designId: design, revision: source.revision, jobId: job, reportHash: source.reportHash, file: { ...file, localPath: target.rel }, contentTrust: "UNTRUSTED_DATA" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new UiWorkflowError("EXPORT_DESTINATION_EXISTS", "Choose a new destination; existing files are preserved.");
    throw error;
  } finally { await handle.close().catch(() => {}); await fs.unlink(staged).catch(() => {}); }
}
