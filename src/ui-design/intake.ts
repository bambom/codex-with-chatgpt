import { z } from "zod";
import { assertDocument, parseStrict, hashDocument, hashBytes, validateManifest, type AssetManifest } from "@magicgamestudio/ui-design-contract";
import { SPEC_DIGEST } from "@magicgamestudio/ui-design-contract/spec";
import { ONLINE_VERSION, ONLINE_DIGEST, ONLINE_LIMITS } from "@magicgamestudio/ui-design-contract/online";
import type { Workspace } from "../workspace/manager.js";
import { UiWorkflowError, safeRelative } from "../ui/storage.js";
import { readBounded } from "./precheck.js";
import { platformIntakeRequest, platformOnlineProtocol, platformSpecification } from "./platform.js";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const statusSchema = z.object({
  protocolVersion: z.literal(ONLINE_VERSION), onlineDigest: z.literal(ONLINE_DIGEST), submissionId: z.string().regex(/^S[a-f0-9]{32}$/),
  designId: z.string(), checkpointId: z.string().uuid(), baseRevision: z.number().int().min(0).max(1e9), specDigest: z.literal(SPEC_DIGEST),
  state: z.enum(["DRAFT", "BUNDLE_STORED", "CANCELLED"]), documentHash: sha.nullable(), assetManifestHash: sha.nullable(),
  files: z.array(z.object({ index: z.number().int().nonnegative(), path: z.string(), role: z.string(), sha256: sha, byteLength: z.number().int().positive(), stored: z.boolean() })).max(ONLINE_LIMITS.files),
  nativeImported: z.literal(false), published: z.literal(false), submitted: z.literal(false),
});
function fail(code: string, message: string): never { throw new UiWorkflowError(code, message); }
function status(value: unknown, design: string, submission?: string) {
  const parsed = statusSchema.safeParse(value);
  if (!parsed.success || parsed.data.designId !== design || submission !== undefined && parsed.data.submissionId !== submission)
    return fail("PLATFORM_RESPONSE_INVALID", "Platform returned an invalid intake status.");
  const row = parsed.data;
  if (row.files.some((f, i) => f.index !== i) || row.state === "BUNDLE_STORED" && (row.files.length === 0 || row.files.some(f => !f.stored)))
    return fail("PLATFORM_RESPONSE_INVALID", "Platform intake file state is inconsistent.");
  return row;
}
export async function beginIntake(workspace: Workspace, design: string, requestId: string, checkpointId: string, baseRevision: number) {
  z.string().uuid().parse(requestId); z.string().uuid().parse(checkpointId); z.number().int().min(0).max(1e9).parse(baseRevision);
  await platformSpecification(workspace);
  const protocol = await platformOnlineProtocol(workspace);
  if (!protocol.capabilities.resumableIntake) return fail("PLATFORM_INTAKE_UNAVAILABLE", "The platform has not enabled submission intake.");
  const row = status(await platformIntakeRequest(workspace, design, "/submissions", "POST", { requestId, checkpointId, baseRevision, specDigest: SPEC_DIGEST, onlineDigest: ONLINE_DIGEST }), design);
  if (row.checkpointId !== checkpointId || row.baseRevision !== baseRevision) return fail("PLATFORM_RESPONSE_INVALID", "Intake did not bind the requested base version.");
  return row;
}
export async function intakeStatus(workspace: Workspace, design: string, submission: string) {
  return status(await platformIntakeRequest(workspace, design, "/submissions/" + submission, "GET"), design, submission);
}
export async function cancelIntake(workspace: Workspace, design: string, submission: string) {
  return status(await platformIntakeRequest(workspace, design, "/submissions/" + submission, "DELETE"), design, submission);
}
export interface UploadBundleInput { designId: string; submissionId: string; documentPath: string; manifestPath: string; packageDirectory: string; }
export async function uploadIntakeBundle(workspace: Workspace, input: UploadBundleInput) {
  const { designId: design, submissionId: submission } = input;
  const document = assertDocument(parseStrict((await readBounded(workspace, input.documentPath, ONLINE_LIMITS.candidateBytes)).toString("utf8")));
  const manifest = parseStrict((await readBounded(workspace, input.manifestPath, ONLINE_LIMITS.candidateBytes)).toString("utf8")) as unknown as AssetManifest;
  const current = await intakeStatus(workspace, design, submission);
  if (current.state === "CANCELLED") return fail("SUBMISSION_CANCELLED", "Prepare a new submission to upload another candidate.");
  if (document.designId !== design) return fail("DOCUMENT_DESIGN_MISMATCH", "The candidate belongs to a different platform design.");
  const report = validateManifest(document, manifest, { submissionId: submission, baseRevision: current.baseRevision, specDigest: SPEC_DIGEST });
  if (!report.valid) return fail("INVALID_ASSET_MANIFEST", "The manifest does not match this candidate and submission.");
  if (manifest.files.length > ONLINE_LIMITS.files || manifest.files.some(f => f.byteLength > ONLINE_LIMITS.fileBytes)
      || manifest.files.reduce((n, f) => n + f.byteLength, 0) > ONLINE_LIMITS.bundleBytes)
    return fail("BUNDLE_LIMIT", "The bundle exceeds the platform intake limits.");
  const directory = input.packageDirectory === "." ? "" : safeRelative(input.packageDirectory) + "/";
  // Preflight every path and byte hash before binding. Re-read before transfer to detect later changes.
  for (const file of manifest.files) {
    const bytes = await readBounded(workspace, directory + file.path, ONLINE_LIMITS.fileBytes, file.byteLength);
    if (hashBytes(bytes) !== file.sha256) return fail("FILE_HASH", "A bundle file differs from its manifest.");
  }
  const documentHash = hashDocument(document), manifestHash = report.assetManifestHash;
  let row = status(await platformIntakeRequest(workspace, design, "/submissions/" + submission + "/candidate", "PUT", { document, manifest }), design, submission);
  const verify = () => {
    if (row.documentHash !== documentHash || row.assetManifestHash !== manifestHash || row.files.length !== manifest.files.length
        || row.files.some((file, i) => file.sha256 !== manifest.files[i]!.sha256 || file.byteLength !== manifest.files[i]!.byteLength || file.path !== manifest.files[i]!.path || file.role !== manifest.files[i]!.role))
      return fail("PLATFORM_RESPONSE_INVALID", "Intake status differs from the bound candidate.");
  };
  verify();
  let uploaded = 0, resumed = 0;
  for (let i = 0; i < manifest.files.length; i++) {
    if (row.files[i]!.stored) { resumed++; continue; }
    const file = manifest.files[i]!;
    const bytes = await readBounded(workspace, directory + file.path, ONLINE_LIMITS.fileBytes, file.byteLength);
    if (hashBytes(bytes) !== file.sha256) return fail("FILE_HASH", "A bundle file changed before upload; retained files can be resumed.");
    row = status(await platformIntakeRequest(workspace, design, "/submissions/" + submission + "/files/" + i, "PUT", bytes), design, submission);
    verify();
    if (!row.files[i]!.stored) return fail("PLATFORM_RESPONSE_INVALID", "The platform did not confirm file retention.");
    uploaded++;
  }
  if (row.state !== "BUNDLE_STORED") return fail("PLATFORM_RESPONSE_INVALID", "The platform did not confirm the complete bundle.");
  return { ...row, uploadedFiles: uploaded, resumedFiles: resumed };
}
