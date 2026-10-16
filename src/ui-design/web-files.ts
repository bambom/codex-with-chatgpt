import https from "node:https";
import dns from "node:dns";
import { unzipSync } from "fflate";
import { assertDocument, parseStrict, hashBytes, validateManifest, type AssetManifest } from "@magicgamestudio/ui-design-contract";
import { SPEC_DIGEST } from "@magicgamestudio/ui-design-contract/spec";
import { ONLINE_LIMITS } from "@magicgamestudio/ui-design-contract/online";
import { z } from "zod";
import { UiWorkflowError, safeRelative } from "../ui/storage.js";

export const chatFileSchema = z.object({
  download_url: z.string().min(1).max(8192), file_id: z.string().min(1).max(512),
  mime_type: z.string().max(160).optional(), file_name: z.string().max(480).optional(),
}).strict();
export type ChatFile = z.infer<typeof chatFileSchema>;
function fail(code: string, message: string): never { throw new UiWorkflowError(code, message); }

/** Fixed ChatGPT attachment hosts only. No credentials, custom origins, local URLs or arbitrary redirects. */
export function chatFileUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { return fail("CHAT_FILE_ORIGIN", "Use a native ChatGPT file attachment."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash
      || !(url.hostname === "oaiusercontent.com" || url.hostname.endsWith(".oaiusercontent.com")))
    return fail("CHAT_FILE_ORIGIN", "The attachment URL is not on an authorized ChatGPT file host.");
  return url;
}
export function publicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0)
    || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19));
}
export async function downloadChatFile(file: ChatFile): Promise<Buffer> {
  chatFileSchema.parse(file);
  const initial = chatFileUrl(file.download_url);
  const signal = AbortSignal.timeout(120000);
  async function read(url: URL, redirects: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const request = https.get(url, {
        signal, agent: false, maxHeaderSize: 16384, headers: { Accept: "application/zip, application/octet-stream", "Accept-Encoding": "identity" },
        // Resolve and pin one public address in the connection itself, including after every redirect.
        lookup(hostname, options, callback) {
          dns.lookup(hostname, { all: true, family: 4 }, (error, addresses) => {
            if (error || !addresses.length || addresses.some(item => !publicIpv4(item.address))) {
              callback(new Error("CHAT_FILE_DNS"), "", 4); return;
            }
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0]!.address, 4);
          });
        },
      }, response => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
          response.resume();
          try {
            if (redirects >= 2 || !response.headers.location) return reject(new UiWorkflowError("CHAT_FILE_REDIRECT", "Attachment redirect is unavailable."));
            resolve(read(chatFileUrl(new URL(response.headers.location, url).href), redirects + 1));
          } catch (error) { reject(error); }
          return;
        }
        if (response.statusCode !== 200) {
          response.resume(); reject(new UiWorkflowError("CHAT_FILE_UNAVAILABLE", "Attach the same generated file again to refresh its authorized URL.")); return;
        }
        const declared = response.headers["content-length"];
        if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity"
          || declared && (!/^\d+$/.test(declared) || Number(declared) > ONLINE_LIMITS.bundleBytes)) {
          response.destroy(); reject(new UiWorkflowError("CHAT_FILE_LIMIT", "Attachment exceeds the transfer limit.")); return;
        }
        let size = 0; const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > ONLINE_LIMITS.bundleBytes) response.destroy(new Error("CHAT_FILE_LIMIT"));
          else chunks.push(chunk);
        });
        response.on("error", () => reject(new UiWorkflowError("CHAT_FILE_TRANSFER", "Attachment transfer was interrupted; retry the same file.")));
        response.on("end", () => {
          if (!size || declared && size !== Number(declared)) reject(new UiWorkflowError("CHAT_FILE_TRANSFER", "Attachment transfer is incomplete."));
          else resolve(Buffer.concat(chunks, size));
        });
      });
      request.on("error", () => reject(new UiWorkflowError("CHAT_FILE_TRANSFER", "Attachment transfer is unavailable; no design change was made.")));
    });
  }
  return read(initial, 0);
}

/** Parse data in memory; archive paths are never extracted into the workspace or executed. */
export function parseChatBundle(bytes: Uint8Array, binding: { designId: string; submissionId: string; baseRevision: number }) {
  if (!bytes.length || bytes.length > ONLINE_LIMITS.bundleBytes) return fail("CHAT_BUNDLE_LIMIT", "The result package exceeds its byte limit.");
  let total = 0; const names = new Set<string>(); let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter(file) {
      const directory = file.name.endsWith("/");
      const name = safeRelative(directory ? file.name.slice(0, -1) : file.name);
      if (name !== (directory ? file.name.slice(0, -1) : file.name) || names.has(name.toLowerCase()))
        return fail("CHAT_BUNDLE_PATH", "The result package has duplicate or noncanonical paths.");
      names.add(name.toLowerCase()); total += file.originalSize;
      if (names.size > ONLINE_LIMITS.files * 2 + 2 || total > ONLINE_LIMITS.bundleBytes + 2 * ONLINE_LIMITS.candidateBytes
        || file.originalSize > (name === "document.json" || name === "manifest.json" ? ONLINE_LIMITS.candidateBytes : ONLINE_LIMITS.fileBytes)
        || directory && file.originalSize !== 0 || ![0, 8].includes(file.compression))
        return fail("CHAT_BUNDLE_LIMIT", "The expanded result package exceeds its limits.");
      return !directory;
    } });
  } catch (error) {
    if (error instanceof UiWorkflowError) throw error;
    return fail("CHAT_BUNDLE_INVALID", "Send the actual ZIP package containing document.json, manifest.json and every declared file.");
  }
  if (!files["document.json"] || !files["manifest.json"] || Object.keys(files).length > ONLINE_LIMITS.files + 2)
    return fail("CHAT_BUNDLE_REQUIRED_FILES", "The result needs document.json and manifest.json at its root.");
  const document = assertDocument(parseStrict(Buffer.from(files["document.json"]).toString("utf8")));
  const manifest = parseStrict(Buffer.from(files["manifest.json"]).toString("utf8")) as unknown as AssetManifest;
  if (document.designId !== binding.designId) return fail("DOCUMENT_DESIGN_MISMATCH", "The result belongs to another design.");
  const report = validateManifest(document, manifest, { ...binding, specDigest: SPEC_DIGEST });
  if (!report.valid) throw new UiWorkflowError("INVALID_ASSET_MANIFEST", "Correct the manifest in ChatGPT and send a new result.", report);
  const declared = new Set(["document.json", "manifest.json"]);
  for (const file of manifest.files) {
    const name = safeRelative(file.path), data = files[name];
    if (declared.has(name) || !data || data.length !== file.byteLength || hashBytes(data) !== file.sha256)
      return fail("CHAT_BUNDLE_FILE_MISMATCH", "A declared file is absent, duplicated, or differs from its byte count/hash.");
    declared.add(name);
  }
  if (Object.keys(files).some(name => !declared.has(name))) return fail("CHAT_BUNDLE_UNDECLARED_FILE", "Every result file must be declared in the manifest.");
  return { document, manifest, files, sha256: hashBytes(bytes) };
}
