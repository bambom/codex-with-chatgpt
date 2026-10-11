import fs from "node:fs/promises";
import sharp from "sharp";
import {
  ContractError,
  assertDocument,
  evaluateLayout,
  hashBytes,
  parseStrict,
  validateDocument,
  validateManifest,
  type AssetManifest,
  type Issue,
} from "@magicgamestudio/ui-design-contract";
import {
  SPEC_DIGEST,
  SPEC_VERSION,
} from "@magicgamestudio/ui-design-contract/spec";
import type { Workspace } from "../workspace/manager.js";
import { containedPath, safeRelative, UiWorkflowError } from "../ui/storage.js";

const JSON_LIMIT = 8 * 1024 * 1024;
const FILE_LIMIT = 64 * 1024 * 1024;
const TOTAL_LIMIT = 256 * 1024 * 1024;
const PIXEL_LIMIT = 32 * 1024 * 1024;
export interface PrecheckInput {
  documentJson?: string;
  documentPath?: string;
  manifestJson?: string;
  manifestPath?: string;
  submissionId?: string;
  baseRevision?: number;
  verifyFiles?: boolean;
  packageDirectory?: string;
}
function requireInput(condition: unknown, message: string): asserts condition {
  if (!condition) throw new UiWorkflowError("INVALID_ARGUMENTS", message);
}
export async function readBounded(
  workspace: Workspace,
  relative: string,
  limit: number,
  expectedLength?: number,
): Promise<Buffer> {
  const safe = safeRelative(relative);
  // Enforce sensitive policy as well as rejecting every symlink/junction component.
  workspace.resolve(safe);
  const absolute = await containedPath(workspace.root, safe);
  const handle = await fs.open(absolute, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new UiWorkflowError(
        "NOT_A_FILE",
        "Input must be a regular workspace file.",
      );
    if (stat.size > limit)
      throw new UiWorkflowError(
        "FILE_TOO_LARGE",
        "Input exceeds the local precheck limit.",
      );
    if (expectedLength !== undefined && stat.size !== expectedLength)
      throw new UiWorkflowError(
        "FILE_HASH",
        "File length differs from the manifest.",
      );
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs
    )
      throw new UiWorkflowError(
        "FILE_CHANGED",
        "Input changed while being read.",
      );
    return buffer;
  } finally {
    await handle.close();
  }
}
async function jsonInput(
  workspace: Workspace,
  raw: string | undefined,
  relative: string | undefined,
): Promise<string> {
  requireInput(
    (raw !== undefined) !== (relative !== undefined),
    "Specify exactly one JSON string or workspace-relative path for each input.",
  );
  if (raw !== undefined) {
    if (Buffer.byteLength(raw) > JSON_LIMIT)
      throw new UiWorkflowError("FILE_TOO_LARGE", "JSON exceeds 8 MiB.");
    return raw;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await readBounded(workspace, relative!, JSON_LIMIT),
    );
  } catch (e) {
    if (e instanceof TypeError)
      throw new UiWorkflowError(
        "INVALID_UTF8",
        "Input must be strict UTF-8 JSON.",
      );
    throw e;
  }
}

/** Local-only preparation. No platform credentials, HTTP, receipt, export or saved state. */
export async function precheckAuthoring(
  workspace: Workspace,
  input: PrecheckInput,
) {
  const raw = await jsonInput(
    workspace,
    input.documentJson,
    input.documentPath,
  );
  const authoring = validateDocument(raw);
  const result = {
    specVersion: SPEC_VERSION,
    specDigest: SPEC_DIGEST,
    source: "platform-bundled",
    status: "LOCAL_PRECHECK_FAILED",
    valid: false,
    saved: false,
    receipt: null,
    documentHash: authoring.documentHash,
    assetManifestHash: undefined as string | undefined,
    checks: {
      authoring: authoring.valid ? "PASS" : "FAIL",
      layout: "NOT_CHECKED",
      manifest: "NOT_CHECKED",
      files: "NOT_CHECKED",
      fontShaping: "NOT_IMPLEMENTED",
      visual: "NOT_IMPLEMENTED",
      platformAuthorization: "NOT_CONNECTED",
    },
    issues: [...authoring.issues] as Issue[],
    fileChecks: [] as { path: string; bytes: string; imageDecode: string }[],
    layoutSummary: undefined as
      | { projectedNodes: number; width: number; height: number }
      | undefined,
  };
  if (!authoring.valid) return result;
  const document = assertDocument(raw);
  const layout = evaluateLayout(document);
  result.checks.layout = "PASS";
  result.layoutSummary = {
    projectedNodes: layout.length,
    width: document.canvas.width,
    height: document.canvas.height,
  };
  const hasManifest =
    input.manifestJson !== undefined || input.manifestPath !== undefined;
  requireInput(
    !input.verifyFiles || hasManifest,
    "File verification requires a manifest and package directory.",
  );
  if (hasManifest) {
    requireInput(
      input.submissionId !== undefined && input.baseRevision !== undefined,
      "Manifest checks require expected submission_id and base_revision.",
    );
    const manifestRaw = await jsonInput(
      workspace,
      input.manifestJson,
      input.manifestPath,
    );
    const report = validateManifest(document, manifestRaw, {
      submissionId: input.submissionId,
      baseRevision: input.baseRevision,
      specDigest: SPEC_DIGEST,
    });
    result.checks.manifest = report.valid ? "PASS" : "FAIL";
    result.issues.push(...report.issues);
    result.assetManifestHash = report.assetManifestHash;
    if (!report.valid) return result;
    if (input.verifyFiles) {
      requireInput(
        input.packageDirectory !== undefined,
        "verify_files requires package_directory relative to the connected workspace.",
      );
      const directory =
        input.packageDirectory === "."
          ? ""
          : safeRelative(input.packageDirectory);
      const manifest = parseStrict(manifestRaw) as unknown as AssetManifest;
      requireInput(
        manifest.files.length <= 2048,
        "Local precheck supports at most 2048 files.",
      );
      requireInput(
        manifest.files.reduce((sum, f) => sum + f.byteLength, 0) <= TOTAL_LIMIT,
        "Local precheck supports at most 256 MiB per package.",
      );
      result.checks.files = "PASS";
      for (const [i, file] of manifest.files.entries()) {
        let imageDecode = "NOT_CHECKED";
        try {
          const bytes = await readBounded(
            workspace,
            directory ? `${directory}/${file.path}` : file.path,
            FILE_LIMIT,
            file.byteLength,
          );
          if (
            bytes.length !== file.byteLength ||
            hashBytes(bytes) !== file.sha256
          )
            throw new UiWorkflowError(
              "FILE_HASH",
              "Byte length or SHA-256 differs from the manifest.",
            );
          const asset = document.assets.find(
            (a) => a.id === file.logicalId && a.version === file.version,
          );
          if (
            ["asset", "approved", "preview", "overview"].includes(file.role)
          ) {
            const decoder = sharp(bytes, {
              limitInputPixels: PIXEL_LIMIT,
              failOn: "warning",
            });
            const meta = await decoder.metadata();
            if (
              meta.format !== "png" ||
              !meta.hasAlpha ||
              meta.channels !== 4 ||
              (meta.pages ?? 1) !== 1
            )
              throw new UiWorkflowError(
                "IMAGE_FORMAT",
                "Renderable files must be single-frame RGBA PNGs.",
              );
            if (
              (file.role === "asset" || file.role === "approved") &&
              asset &&
              (meta.width !== asset.width || meta.height !== asset.height)
            )
              throw new UiWorkflowError(
                "IMAGE_SIZE",
                "PNG dimensions differ from the authoring asset.",
              );
            if (
              file.role === "preview" &&
              (meta.width !== document.canvas.width ||
                meta.height !== document.canvas.height)
            )
              throw new UiWorkflowError(
                "IMAGE_SIZE",
                "Preview must have the original canvas dimensions.",
              );
            await decoder.stats();
            imageDecode = "PASS";
          } else if (file.role === "provenance")
            parseStrict(
              new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
                bytes,
              ),
            );
          result.fileChecks.push({
            path: file.path,
            bytes: "PASS",
            imageDecode,
          });
        } catch (error) {
          const code =
            error instanceof UiWorkflowError
              ? error.code
              : error instanceof ContractError
                ? error.code
                : (error as NodeJS.ErrnoException).code === "ENOENT"
                  ? "FILE_NOT_FOUND"
                  : "FILE_INVALID";
          result.checks.files = "FAIL";
          result.issues.push({
            code,
            path: `/files/${i}`,
            message:
              "File did not pass local byte/decode checks; correct the referenced workspace file.",
          });
          result.fileChecks.push({
            path: file.path,
            bytes: "FAIL",
            imageDecode: "NOT_CHECKED",
          });
        }
      }
    }
  }
  result.valid = result.issues.length === 0;
  result.status = result.valid
    ? "LOCAL_PRECHECK_PASS"
    : "LOCAL_PRECHECK_FAILED";
  return result;
}
