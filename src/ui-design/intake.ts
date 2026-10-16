import { z } from "zod";
import { assertDocument, parseStrict, hashDocument, hashBytes, validateManifest, type AssetManifest } from "@magicgamestudio/ui-design-contract";
import { SPEC_DIGEST } from "@magicgamestudio/ui-design-contract/spec";
import { ONLINE_VERSION, ONLINE_DIGEST, ONLINE_LIMITS, assertOnlineValidation, assertOnlineReceipt, assertOnlinePreparation, assertOnlineError, assertOnlineRepair, isOnlineProtocolIdentity, type OnlineReceipt, type OnlinePreparation } from "@magicgamestudio/ui-design-contract/online";
import type { Workspace } from "../workspace/manager.js";
import { UiWorkflowError, safeRelative } from "../ui/storage.js";
import { readBounded } from "./precheck.js";
import { platformIntakeRequest, platformOnlineProtocol, platformSpecification } from "./platform.js";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const statusSchema = z.object({
  protocolVersion: z.string(), onlineDigest: sha, submissionId: z.string().regex(/^S[a-f0-9]{32}$/),
  designId: z.string(), checkpointId: z.string().uuid(), baseRevision: z.number().int().min(0).max(1e9), specDigest: z.literal(SPEC_DIGEST),
  state: z.enum(["DRAFT", "BUNDLE_STORED", "CANCELLED", "COMMITTED"]), documentHash: sha.nullable(), assetManifestHash: sha.nullable(),
  files: z.array(z.object({ index: z.number().int().nonnegative(), path: z.string(), role: z.string(), sha256: sha, byteLength: z.number().int().positive(), stored: z.boolean(),
    nextOffset: z.number().int().nonnegative(), uploadState: z.enum(["DECLARED", "RECEIVING", "READY", "EXPIRED"]), uploadExpiresAt: z.string().datetime({ offset: true }).nullable() })).max(ONLINE_LIMITS.files),
  nativeImported: z.boolean(), published: z.boolean(), submitted: z.boolean(), validation: z.unknown().nullable(), receipt: z.unknown().nullable(), lastError: z.unknown().nullable(), preparation: z.unknown().nullable(),
  repair: z.unknown().optional(),
});
function fail(code: string, message: string): never { throw new UiWorkflowError(code, message); }
function status(value: unknown, design: string, submission?: string) {
  const parsed = statusSchema.safeParse(value);
  if (!parsed.success || !isOnlineProtocolIdentity(parsed.data.protocolVersion, parsed.data.onlineDigest) || parsed.data.designId !== design || submission !== undefined && parsed.data.submissionId !== submission)
    return fail("PLATFORM_RESPONSE_INVALID", "Platform returned an invalid intake status.");
  const row = parsed.data;
  if (row.files.some((f, i) => f.index !== i || f.nextOffset > f.byteLength || f.stored !== (f.uploadState === "READY") || f.stored && f.nextOffset !== f.byteLength
      || f.nextOffset !== f.byteLength && f.nextOffset % ONLINE_LIMITS.chunkBytes !== 0 || f.uploadState === "DECLARED" && f.nextOffset !== 0)
    || ["BUNDLE_STORED", "COMMITTED"].includes(row.state) && (row.files.length === 0 || row.files.some(f => !f.stored)))
    return fail("PLATFORM_RESPONSE_INVALID", "Platform intake file state is inconsistent.");
  const validation = row.validation == null ? null : checkedValidation(row.validation, design, row.submissionId);
  const receipt = row.receipt == null ? null : checkedReceipt(row.receipt, design, row.submissionId);
  const preparation = row.preparation == null ? null : checkedPreparation(row.preparation, design, row.submissionId);
  let lastError = null;
  let repair = null;
  try {
    if (row.repair != null) repair = assertOnlineRepair(row.repair, design, row.submissionId);
    if (row.lastError != null) {
      lastError = assertOnlineError(row.lastError);
      if (lastError.query?.designId !== design || lastError.query.submissionId !== row.submissionId) throw new Error();
    }
  } catch { return fail("PLATFORM_RESPONSE_INVALID", "Platform retained an invalid error identity."); }
  if (row.nativeImported !== (row.state === "COMMITTED") || row.published !== row.nativeImported || row.submitted !== row.nativeImported
    || (row.state === "COMMITTED") !== (receipt !== null)
    || validation && (validation.documentHash !== row.documentHash || validation.assetManifestHash !== row.assetManifestHash)
    || preparation && (preparation.submittedDocumentHash !== row.documentHash || preparation.submittedAssetManifestHash !== row.assetManifestHash
      || preparation.baseRevision !== row.baseRevision || preparation.candidateValidationId !== validation?.validationId)
    || receipt && (receipt.origin !== "PLUGIN_CANDIDATE" || receipt.submittedDocumentHash !== row.documentHash || receipt.submittedAssetManifestHash !== row.assetManifestHash
      || receipt.baseRevision !== row.baseRevision || (receipt.candidateValidationId ?? receipt.validationId) !== validation?.validationId))
    return fail("PLATFORM_RESPONSE_INVALID", "Platform publication status is inconsistent.");
  if (repair && repair.reusedFileCount > row.files.filter(f => f.stored).length) return fail("PLATFORM_RESPONSE_INVALID", "Repair reuse exceeds retained files.");
  return { ...row, validation, receipt, lastError, preparation, repair };
}
function checkedValidation(value: unknown, design: string, submission: string) {
  try { const report = assertOnlineValidation(value); if (report.designId !== design || report.submissionId !== submission) throw new Error(); return report; }
  catch { return fail("PLATFORM_RESPONSE_INVALID", "Platform validation report failed the shared online contract."); }
}
function checkedReceipt(value: unknown, design: string, submission?: string): OnlineReceipt {
  try { const receipt = assertOnlineReceipt(value); if (receipt.designId !== design || submission !== undefined && receipt.submissionId !== submission) throw new Error(); return receipt; }
  catch { return fail("PLATFORM_RESPONSE_INVALID", "Platform receipt failed the shared online contract."); }
}
function checkedPreparation(value: unknown, design: string, submission: string): OnlinePreparation {
  try { const preparation = assertOnlinePreparation(value); if (preparation.designId !== design || preparation.submissionId !== submission) throw new Error(); return preparation; }
  catch { return fail("PLATFORM_RESPONSE_INVALID", "Platform commit preparation failed its content and identity contract."); }
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
export async function readIntakeCandidate(workspace: Workspace, design: string, submission: string) {
  const raw = z.object({ status: z.unknown(), document: z.unknown().nullable(), manifest: z.unknown().nullable(), errors: z.array(z.unknown()).max(32) })
    .parse(await platformIntakeRequest(workspace, design, "/submissions/" + submission + "/candidate", "GET"));
  const current = status(raw.status, design, submission);
  try {
    const document = raw.document === null ? null : assertDocument(raw.document);
    const manifest = raw.manifest as AssetManifest | null;
    if ((document === null) !== (current.documentHash === null) || (manifest === null) !== (document === null)
      || document && (document.designId !== design || hashDocument(document) !== current.documentHash
        || !validateManifest(document, manifest!, { submissionId: submission, baseRevision: current.baseRevision, specDigest: SPEC_DIGEST }).valid
        || hashDocument(manifest!) !== current.assetManifestHash)) throw new Error();
    const errors = raw.errors.map(value => {
      const error = assertOnlineError(value);
      if (error.query?.designId !== design || error.query.submissionId !== submission) throw new Error();
      return error;
    });
    return { status: current, document, manifest, errors, contentTrust: "UNTRUSTED_DATA" };
  } catch { return fail("PLATFORM_RESPONSE_INVALID", "Retained candidate or diagnostics failed their identity and content checks."); }
}
export async function beginIntakeRepair(workspace: Workspace, design: string, source: string, requestId: string, checkpointId: string, baseRevision: number) {
  z.string().uuid().parse(requestId); z.string().uuid().parse(checkpointId); z.number().int().min(0).max(1e9).parse(baseRevision);
  await platformSpecification(workspace); await platformOnlineProtocol(workspace);
  const parent = await intakeStatus(workspace, design, source);
  if (parent.state === "COMMITTED") return fail("SUBMISSION_ALREADY_COMMITTED", "A committed receipt cannot be repaired; start a new change from the current context.");
  const row = status(await platformIntakeRequest(workspace, design, "/submissions/" + source + "/repair", "POST",
    { requestId, checkpointId, baseRevision, specDigest: SPEC_DIGEST, onlineDigest: ONLINE_DIGEST }), design);
  if (row.submissionId === source || row.checkpointId !== checkpointId || row.baseRevision !== baseRevision
    || row.repair?.sourceSubmissionId !== source || row.repair.sourceDocumentHash !== parent.documentHash
    || row.repair.sourceAssetManifestHash !== parent.assetManifestHash) return fail("PLATFORM_RESPONSE_INVALID", "Repair did not bind the previous attempt and requested base.");
  return row;
}
export async function cancelIntake(workspace: Workspace, design: string, submission: string) {
  return status(await platformIntakeRequest(workspace, design, "/submissions/" + submission, "DELETE"), design, submission);
}
export interface UploadBundleInput { designId: string; submissionId: string; documentPath: string; manifestPath: string; packageDirectory: string; }
export async function uploadIntakeBundle(workspace: Workspace, input: UploadBundleInput) {
  const document = assertDocument(parseStrict((await readBounded(workspace, input.documentPath, ONLINE_LIMITS.candidateBytes)).toString("utf8")));
  const manifest = parseStrict((await readBounded(workspace, input.manifestPath, ONLINE_LIMITS.candidateBytes)).toString("utf8")) as unknown as AssetManifest;
  const directory = input.packageDirectory === "." ? "" : safeRelative(input.packageDirectory) + "/";
  return uploadIntakeContent(workspace, { ...input, document, manifest },
    file => readBounded(workspace, directory + file.path, ONLINE_LIMITS.fileBytes, file.byteLength));
}
/** Transport adapter for web attachments. It never creates or transforms a producer file. */
export async function uploadIntakeContent(workspace: Workspace, input: {
  designId: string; submissionId: string; document: unknown; manifest: AssetManifest;
}, readFile: (file: AssetManifest["files"][number]) => Promise<Buffer>) {
  const { designId: design, submissionId: submission, manifest } = input;
  const document = assertDocument(input.document);
  const current = await intakeStatus(workspace, design, submission);
  if (["CANCELLED", "COMMITTED"].includes(current.state)) return fail("SUBMISSION_IMMUTABLE", "This submission is closed; use its status or start a new candidate.");
  if (document.designId !== design) return fail("DOCUMENT_DESIGN_MISMATCH", "The candidate belongs to a different platform design.");
  const report = validateManifest(document, manifest, { submissionId: submission, baseRevision: current.baseRevision, specDigest: SPEC_DIGEST });
  if (!report.valid) return fail("INVALID_ASSET_MANIFEST", "The manifest does not match this candidate and submission.");
  if (manifest.files.length > ONLINE_LIMITS.files || manifest.files.some(f => f.byteLength > ONLINE_LIMITS.fileBytes)
      || manifest.files.reduce((n, f) => n + f.byteLength, 0) > ONLINE_LIMITS.bundleBytes)
    return fail("BUNDLE_LIMIT", "The bundle exceeds the platform intake limits.");
  // Preflight every path and byte hash before binding. Re-read before transfer to detect later changes.
  for (const file of manifest.files) {
    safeRelative(file.path);
    const bytes = await readFile(file);
    if (bytes.length !== file.byteLength || hashBytes(bytes) !== file.sha256) return fail("FILE_HASH", "A bundle file differs from its manifest.");
  }
  const documentHash = hashDocument(document), manifestHash = report.assetManifestHash;
  let row = status(await platformIntakeRequest(workspace, design, "/submissions/" + submission + "/candidate", "PUT", { document, manifest }), design, submission);
  const verify = () => {
    if (row.documentHash !== documentHash || row.assetManifestHash !== manifestHash || row.files.length !== manifest.files.length
        || row.files.some((file, i) => file.sha256 !== manifest.files[i]!.sha256 || file.byteLength !== manifest.files[i]!.byteLength || file.path !== manifest.files[i]!.path || file.role !== manifest.files[i]!.role))
      return fail("PLATFORM_RESPONSE_INVALID", "Intake status differs from the bound candidate.");
  };
  verify();
  let uploaded = 0, resumed = 0, uploadedBlocks = 0, resumedBytes = 0;
  for (let i = 0; i < manifest.files.length; i++) {
    if (row.files[i]!.stored) { resumed++; continue; }
    const file = manifest.files[i]!;
    if (row.files[i]!.uploadState === "EXPIRED") return fail("UPLOAD_EXPIRED", "This receiving file expired; begin a new submission.");
    const bytes = await readFile(file);
    if (bytes.length !== file.byteLength || hashBytes(bytes) !== file.sha256) return fail("FILE_HASH", "A bundle file changed before upload; retained files can be resumed.");
    let offset = row.files[i]!.nextOffset; resumedBytes += offset;
    while (offset < bytes.length) {
      const block = bytes.subarray(offset, Math.min(offset + ONLINE_LIMITS.chunkBytes, bytes.length));
      const ack = z.object({ submissionId: z.string(), fileIndex: z.number().int(), offset: z.number().int(), byteLength: z.number().int(), sha256: sha,
        nextOffset: z.number().int(), repeated: z.boolean() }).safeParse(await platformIntakeRequest(workspace, design,
          "/submissions/" + submission + "/files/" + i + "/chunks/" + offset, "PUT", block));
      if (!ack.success || ack.data.submissionId !== submission || ack.data.fileIndex !== i || ack.data.offset !== offset || ack.data.byteLength !== block.length
        || ack.data.sha256 !== hashBytes(block) || ack.data.nextOffset < offset + block.length || ack.data.nextOffset > bytes.length
        || ack.data.nextOffset !== bytes.length && ack.data.nextOffset % ONLINE_LIMITS.chunkBytes !== 0)
        return fail("PLATFORM_RESPONSE_INVALID", "Platform block receipt differs from the uploaded bytes.");
      offset = ack.data.nextOffset; uploadedBlocks++;
    }
    row = status(await platformIntakeRequest(workspace, design, "/submissions/" + submission + "/files/" + i + "/complete", "POST", {}), design, submission);
    verify();
    if (!row.files[i]!.stored) return fail("PLATFORM_RESPONSE_INVALID", "The platform did not confirm file retention.");
    uploaded++;
  }
  if (row.state !== "BUNDLE_STORED") return fail("PLATFORM_RESPONSE_INVALID", "The platform did not confirm the complete bundle.");
  return { ...row, uploadedFiles: uploaded, resumedFiles: resumed, uploadedBlocks, resumedBytes };
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
export async function prepareCommitIntake(workspace: Workspace, design: string, submission: string, validationId: string) {
  z.string().uuid().parse(validationId);
  const current = await intakeStatus(workspace, design, submission);
  if (current.validation?.validationId !== validationId) return fail("VALIDATION_REQUIRED", "Use this candidate's retained validation ID.");
  if (current.receipt) {
    if (current.preparation && current.preparation.preparationId === current.receipt.preparationId) return current.preparation;
    return fail("SUBMISSION_IMMUTABLE", "This candidate already has a publication receipt.");
  }
  if (!(await platformOnlineProtocol(workspace)).capabilities.concurrentMerge) return fail("PLATFORM_MERGE_UNAVAILABLE", "The platform has not enabled finite merge preparation.");
  const result = checkedPreparation(await platformIntakeRequest(workspace, design, "/submissions/" + submission + "/prepare-commit", "POST", { validationId }), design, submission);
  if (result.candidateValidationId !== validationId || result.baseRevision !== current.baseRevision || result.submittedDocumentHash !== current.documentHash || result.submittedAssetManifestHash !== current.assetManifestHash)
    return fail("PLATFORM_RESPONSE_INVALID", "Commit preparation did not bind this exact candidate.");
  return result;
}
export async function commitIntake(workspace: Workspace, design: string, submission: string, validationId: string, preparationId?: string) {
  z.string().uuid().parse(validationId);
  if (preparationId) z.string().uuid().parse(preparationId);
  const current = await intakeStatus(workspace, design, submission);
  if (current.validation?.validationId !== validationId) return fail("VALIDATION_REQUIRED", "Use the validation ID retained by this submission.");
  if (current.receipt) {
    if (preparationId && preparationId !== current.receipt.preparationId) return fail("PREPARATION_ID_CHANGED", "The published candidate used a different preparation.");
    return current.receipt;
  }
  const protocol = await platformOnlineProtocol(workspace);
  if (!protocol.capabilities.formalSubmission) return fail("PLATFORM_SUBMISSION_UNAVAILABLE", "Formal publication is unavailable.");
  let prepared: OnlinePreparation | null = null;
  if (preparationId) prepared = checkedPreparation(await platformIntakeRequest(workspace, design, "/submissions/" + submission + "/preparations/" + preparationId, "GET"), design, submission);
  else if (protocol.capabilities.concurrentMerge) prepared = await prepareCommitIntake(workspace, design, submission, validationId);
  if (prepared && (preparationId && prepared.preparationId !== preparationId || prepared.candidateValidationId !== validationId || prepared.baseRevision !== current.baseRevision || prepared.submittedDocumentHash !== current.documentHash || prepared.submittedAssetManifestHash !== current.assetManifestHash))
    return fail("PLATFORM_RESPONSE_INVALID", "The prepared result does not belong to this candidate.");
  const receipt = checkedReceipt(await platformIntakeRequest(workspace, design, "/submissions/" + submission + "/commit", "POST", { validationId, ...(prepared ? { preparationId: prepared.preparationId } : {}) }), design, submission);
  if (receipt.origin !== "PLUGIN_CANDIDATE" || (receipt.candidateValidationId ?? receipt.validationId) !== validationId || receipt.baseRevision !== current.baseRevision
    || receipt.submittedDocumentHash !== current.documentHash || receipt.submittedAssetManifestHash !== current.assetManifestHash
    || prepared && (receipt.preparationId !== prepared.preparationId || receipt.committedDocumentHash !== prepared.committedDocumentHash || receipt.committedAssetManifestHash !== prepared.committedAssetManifestHash
      || receipt.mergeHeadRevision !== prepared.mergeHeadRevision || receipt.mergeNativeCheckpointId !== prepared.mergeNativeCheckpointId
      || receipt.mergeNativeSequence !== prepared.mergeNativeSequence || receipt.mergeNativeSha256 !== prepared.mergeNativeSha256
      || receipt.mergeStrategy !== prepared.mergeStrategy || receipt.resourceSide !== prepared.resourceSide || receipt.bridgeSha256 !== prepared.validation.bridgeSha256
      || hashDocument(receipt.checks) !== hashDocument(prepared.validation.checks) || hashDocument(receipt.warnings) !== hashDocument(prepared.validation.warnings)
      || hashDocument(receipt.comparisons) !== hashDocument(prepared.validation.comparisons)
      || hashDocument(receipt.reconstructedPreview) !== hashDocument(prepared.validation.reconstructedPreview)))
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
export async function readStandardHistory(workspace: Workspace, design: string, before = 0, limit = 50) {
  z.number().int().min(0).max(1e9 + 1).parse(before); z.number().int().min(1).max(100).parse(limit);
  const raw = z.object({ designId: z.literal(design), headRevision: z.number().int().min(0).max(1e9), revisions: z.array(z.unknown()).max(limit),
    nextBefore: z.number().int().min(1).max(1e9).nullable() }).parse(await platformIntakeRequest(workspace, design, "/revisions?before=" + before + "&limit=" + limit, "GET"));
  const revisions = raw.revisions.map(r => checkedReceipt(r, design));
  let previous = before || raw.headRevision + 1;
  for (const revision of revisions) {
    if (revision.committedRevision >= previous || revision.committedRevision > raw.headRevision) return fail("PLATFORM_RESPONSE_INVALID", "History revisions are not in descending order.");
    previous = revision.committedRevision;
  }
  if (raw.nextBefore !== null && (revisions.length !== limit || raw.nextBefore !== previous)) return fail("PLATFORM_RESPONSE_INVALID", "History cursor does not bind the last revision.");
  return { ...raw, revisions };
}
export async function readCopySource(workspace: Workspace, design: string, revision: number) {
  const published = await readStandardRevision(workspace, design, revision), source = published.receipt.copySource;
  if (published.receipt.origin !== "DESIGN_COPY" || !source) return fail("COPY_SOURCE_UNAVAILABLE", "This revision is not a copied design revision.");
  const value = await platformIntakeRequest(workspace, design, "/revisions/" + revision + "/copy-source", "GET");
  const archive = z.object({ format: z.literal("ui-design-copy-source-1"), sourceDesignId: z.literal(source.designId), sourceRevision: z.literal(source.revision),
    sourceReceiptHash: z.literal(source.receiptHash), copyRequestId: z.literal(source.copyRequestId), originalText: z.object({ receipt: z.string() }),
    revision: z.object({ receipt: z.unknown() }), files: z.array(z.object({ path: z.string().max(512), sha256: sha, byteLength: z.number().int().positive().max(ONLINE_LIMITS.fileBytes) })).max(16384) }).passthrough().parse(value);
  const original = checkedReceipt(archive.revision.receipt, source.designId);
  if (hashDocument(value as never) !== source.archiveSha256 || hashBytes(new TextEncoder().encode(archive.originalText.receipt)) !== source.receiptHash
    || hashDocument(parseStrict(archive.originalText.receipt)) !== hashDocument(archive.revision.receipt as never)
    || original.committedRevision !== source.revision || original.committedDocumentHash !== source.documentHash || original.committedAssetManifestHash !== source.assetManifestHash
    || new Set(archive.files.map(f => f.path)).size !== archive.files.length)
    return fail("PLATFORM_RESPONSE_INVALID", "Copy source archive does not match its persisted provenance.");
  return value;
}
