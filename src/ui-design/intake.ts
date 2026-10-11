import { z } from "zod";
import { assertDocument, parseStrict, hashDocument, hashBytes, validateManifest, type AssetManifest } from "@magicgamestudio/ui-design-contract";
import { SPEC_DIGEST } from "@magicgamestudio/ui-design-contract/spec";
import { ONLINE_VERSION, ONLINE_DIGEST, ONLINE_LIMITS, assertOnlineValidation, assertOnlineReceipt, type OnlineReceipt } from "@magicgamestudio/ui-design-contract/online";
import type { Workspace } from "../workspace/manager.js";
import { UiWorkflowError, safeRelative } from "../ui/storage.js";
import { readBounded } from "./precheck.js";
import { platformIntakeRequest, platformOnlineProtocol, platformSpecification } from "./platform.js";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const statusSchema = z.object({
  protocolVersion: z.literal(ONLINE_VERSION), onlineDigest: z.literal(ONLINE_DIGEST), submissionId: z.string().regex(/^S[a-f0-9]{32}$/),
  designId: z.string(), checkpointId: z.string().uuid(), baseRevision: z.number().int().min(0).max(1e9), specDigest: z.literal(SPEC_DIGEST),
  state: z.enum(["DRAFT", "BUNDLE_STORED", "CANCELLED", "COMMITTED"]), documentHash: sha.nullable(), assetManifestHash: sha.nullable(),
  files: z.array(z.object({ index: z.number().int().nonnegative(), path: z.string(), role: z.string(), sha256: sha, byteLength: z.number().int().positive(), stored: z.boolean() })).max(ONLINE_LIMITS.files),
  nativeImported: z.boolean(), published: z.boolean(), submitted: z.boolean(), validation: z.unknown().nullable(), receipt: z.unknown().nullable(),
});
function fail(code: string, message: string): never { throw new UiWorkflowError(code, message); }
function status(value: unknown, design: string, submission?: string) {
  const parsed = statusSchema.safeParse(value);
  if (!parsed.success || parsed.data.designId !== design || submission !== undefined && parsed.data.submissionId !== submission)
    return fail("PLATFORM_RESPONSE_INVALID", "Platform returned an invalid intake status.");
  const row = parsed.data;
  if (row.files.some((f, i) => f.index !== i) || ["BUNDLE_STORED", "COMMITTED"].includes(row.state) && (row.files.length === 0 || row.files.some(f => !f.stored)))
    return fail("PLATFORM_RESPONSE_INVALID", "Platform intake file state is inconsistent.");
  const validation = row.validation == null ? null : checkedValidation(row.validation, design, row.submissionId);
  const receipt = row.receipt == null ? null : checkedReceipt(row.receipt, design, row.submissionId);
  if (row.nativeImported !== (row.state === "COMMITTED") || row.published !== row.nativeImported || row.submitted !== row.nativeImported
    || (row.state === "COMMITTED") !== (receipt !== null)
    || validation && (validation.documentHash !== row.documentHash || validation.assetManifestHash !== row.assetManifestHash)
    || receipt && (receipt.origin !== "PLUGIN_CANDIDATE" || receipt.committedDocumentHash !== row.documentHash || receipt.committedAssetManifestHash !== row.assetManifestHash
      || receipt.baseRevision !== row.baseRevision || receipt.validationId !== validation?.validationId))
    return fail("PLATFORM_RESPONSE_INVALID", "Platform publication status is inconsistent.");
  return { ...row, validation, receipt };
}
function checkedValidation(value: unknown, design: string, submission: string) {
  try { const report = assertOnlineValidation(value); if (report.designId !== design || report.submissionId !== submission) throw new Error(); return report; }
  catch { return fail("PLATFORM_RESPONSE_INVALID", "Platform validation report failed the shared online contract."); }
}
function checkedReceipt(value: unknown, design: string, submission?: string): OnlineReceipt {
  try { const receipt = assertOnlineReceipt(value); if (receipt.designId !== design || submission !== undefined && receipt.submissionId !== submission) throw new Error(); return receipt; }
  catch { return fail("PLATFORM_RESPONSE_INVALID", "Platform receipt failed the shared online contract."); }
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
  if (["CANCELLED", "COMMITTED"].includes(current.state)) return fail("SUBMISSION_IMMUTABLE", "This submission is closed; use its status or start a new candidate.");
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

export async function validateIntake(workspace: Workspace, design: string, submission: string) {
  const current = await intakeStatus(workspace, design, submission);
  if (current.validation) return current.validation;
  if (current.state !== "BUNDLE_STORED") return fail("COMPLETE_BUNDLE_REQUIRED", "Upload all declared files before platform validation.");
  const report = checkedValidation(await platformIntakeRequest(workspace, design, "/submissions/" + submission + "/validate", "POST", {}), design, submission);
  if (report.documentHash !== current.documentHash || report.assetManifestHash !== current.assetManifestHash)
    return fail("PLATFORM_RESPONSE_INVALID", "Validation did not bind the retained candidate.");
  return report;
}
export async function commitIntake(workspace: Workspace, design: string, submission: string, validationId: string) {
  z.string().uuid().parse(validationId);
  const current = await intakeStatus(workspace, design, submission);
  if (current.validation?.validationId !== validationId) return fail("VALIDATION_REQUIRED", "Use the validation ID retained by this submission.");
  if (current.receipt) return current.receipt;
  if (!(await platformOnlineProtocol(workspace)).capabilities.formalSubmission) return fail("PLATFORM_SUBMISSION_UNAVAILABLE", "Formal publication is unavailable.");
  const receipt = checkedReceipt(await platformIntakeRequest(workspace, design, "/submissions/" + submission + "/commit", "POST", { validationId }), design, submission);
  if (receipt.origin !== "PLUGIN_CANDIDATE" || receipt.validationId !== validationId || receipt.baseRevision !== current.baseRevision
    || receipt.committedDocumentHash !== current.documentHash || receipt.committedAssetManifestHash !== current.assetManifestHash)
    return fail("PLATFORM_RESPONSE_INVALID", "Receipt does not describe this candidate's validated publication.");
  return receipt;
}
export async function submitIntakeBundle(workspace: Workspace, input: UploadBundleInput) {
  const current = await intakeStatus(workspace, input.designId, input.submissionId);
  if (current.receipt) {
    const document = parseStrict((await readBounded(workspace, input.documentPath, ONLINE_LIMITS.candidateBytes)).toString("utf8"));
    const manifest = parseStrict((await readBounded(workspace, input.manifestPath, ONLINE_LIMITS.candidateBytes)).toString("utf8"));
    if (hashDocument(document) !== current.documentHash || hashDocument(manifest) !== current.assetManifestHash)
      return fail("SUBMISSION_IMMUTABLE", "The published submission belongs to a different candidate.");
    return current.receipt;
  }
  await uploadIntakeBundle(workspace, input);
  const report = await validateIntake(workspace, input.designId, input.submissionId);
  return commitIntake(workspace, input.designId, input.submissionId, report.validationId);
}
export async function readStandardRevision(workspace: Workspace, design: string, revision: number) {
  z.number().int().min(1).max(1e9).parse(revision);
  const raw = z.object({ document: z.unknown(), manifest: z.unknown(), receipt: z.unknown() }).parse(
    await platformIntakeRequest(workspace, design, "/revisions/" + revision, "GET"));
  const receipt = checkedReceipt(raw.receipt, design), document = assertDocument(raw.document), manifest = raw.manifest as AssetManifest;
  const report = validateManifest(document, manifest, { submissionId: receipt.submissionId, baseRevision: receipt.baseRevision, specDigest: SPEC_DIGEST });
  if (receipt.committedRevision !== revision || document.designId !== design || !report.valid
    || receipt.committedDocumentHash !== hashDocument(document) || receipt.committedAssetManifestHash !== report.assetManifestHash)
    return fail("PLATFORM_RESPONSE_INVALID", "Published revision content does not match its receipt.");
  return { document, manifest, receipt };
}
export async function publishNativeDraft(workspace: Workspace, design: string, requestId: string, checkpointId: string, baseRevision: number) {
  z.string().uuid().parse(requestId); z.string().uuid().parse(checkpointId); z.number().int().min(1).max(1e9).parse(baseRevision);
  if (!(await platformOnlineProtocol(workspace)).capabilities.nativeDraftPublication) return fail("NATIVE_PUBLICATION_UNAVAILABLE", "Native draft publication is unavailable.");
  const receipt = checkedReceipt(await platformIntakeRequest(workspace, design, "/publications", "POST", { requestId, checkpointId, baseRevision, onlineDigest: ONLINE_DIGEST }), design);
  if (receipt.origin !== "NATIVE_DRAFT" || receipt.nativeCheckpointId !== checkpointId || receipt.baseRevision !== baseRevision)
    return fail("PLATFORM_RESPONSE_INVALID", "Native publication receipt did not bind the requested checkpoint.");
  return receipt;
}
