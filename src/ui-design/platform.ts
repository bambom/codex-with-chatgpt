import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { getSpecification, SPEC_DIGEST, SPEC_VERSION, type SpecSection } from "@magicgamestudio/ui-design-contract/spec";
import { hashDocument, parseStrict } from "@magicgamestudio/ui-design-contract";
import { ONLINE_VERSION, ONLINE_DIGEST, onlineProtocol, assertOnlineError, type OnlineError } from "@magicgamestudio/ui-design-contract/online";
import type { Workspace } from "../workspace/manager.js";
import { atomicJson, containedPath, readJson, stateRoot, withLock, UiWorkflowError } from "../ui/storage.js";

const credentialSchema = z.object({
  version: z.literal(1), server: z.string(), connectionId: z.string().uuid(),
  expiresAt: z.string().datetime({ offset: true }), designIds: z.array(z.string().regex(/^D[A-Za-z0-9_-]{10}$/)).min(1).max(20),
  scopes: z.array(z.enum(["design.read", "design.submit"])),
  secret: z.object({ format: z.enum(["windows-dpapi", "owner-file"]), value: z.string().min(1).max(16384) }),
});
type Credential = z.infer<typeof credentialSchema>;
const exchangeSchema = z.object({
  connectionId: z.string().uuid(), accessToken: z.string().regex(/^uid_[A-Za-z0-9_-]{43}$/), tokenType: z.literal("Bearer"),
  expiresAt: z.string().datetime({ offset: true }), designIds: credentialSchema.shape.designIds, scopes: credentialSchema.shape.scopes,
});
const contextSchema = z.object({
  designId: z.string(), title: z.string(), accessRole: z.string(), nativeSequence: z.number().int().nonnegative(),
  nativeSha256: z.string().regex(/^[a-f0-9]{64}$/), pageCount: z.number().int().nonnegative(), standardStatus: z.string(), standardRevision: z.number().int().nonnegative(),
});
const MAX_RESPONSE = 8 * 1024 * 1024;
function fail(code: string, message: string): never { throw new UiWorkflowError(code, message); }

/** Only local CLI configuration can choose an endpoint; MCP arguments cannot redirect credentials. */
export function normalizePlatformServer(value: string): string {
  let url: URL; try { url = new URL(value); } catch { return fail("INVALID_PLATFORM_SERVER", "Use a platform HTTPS URL."); }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash
      || !["/", "/ui-design", "/ui-design/"].includes(url.pathname))
    return fail("INVALID_PLATFORM_SERVER", "Use a platform HTTPS origin or its /ui-design URL; HTTP is limited to loopback.");
  return url.origin + "/ui-design";
}
async function credentialFile(workspace: Workspace): Promise<string> {
  return containedPath(await stateRoot(workspace), "platform-connection.json");
}
async function readCredential(workspace: Workspace): Promise<Credential | null> {
  try {
    const credential = credentialSchema.parse(await readJson(await credentialFile(workspace), 32768));
    if (normalizePlatformServer(credential.server) !== credential.server) throw new Error("Invalid server");
    return credential;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return fail("PLATFORM_CONNECTION_INVALID", "Re-pair this workspace with the platform using the local command.");
  }
}
async function dpapi(input: string, decrypt: boolean): Promise<string> {
  // Static program; secret bytes travel through stdin, never command arguments, logs or model output.
  const operation = decrypt
    ? "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))"
    : "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))";
  const command = "Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); " + operation;
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; const timer = setTimeout(() => child.kill(), 10000);
    child.stdout.on("data", chunk => { output += String(chunk); if (output.length > 32768) child.kill(); });
    child.stderr.resume();
    const failed = () => reject(new UiWorkflowError("PLATFORM_CREDENTIAL_STORAGE", "Platform credential storage is unavailable."));
    child.on("error", () => { clearTimeout(timer); failed(); });
    child.on("close", code => { clearTimeout(timer); if (code === 0 && output.trim()) resolve(output.trim()); else failed(); });
    child.stdin.on("error", () => {}); child.stdin.end(input);
  });
}
async function request(server: string, route: string, method = "GET", body?: unknown, token?: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json", "X-UI-Design-Transport": "ui-design-native-1" };
  if (token) headers.Authorization = "Bearer " + token;
  const binary = Buffer.isBuffer(body);
  if (body !== undefined) headers["Content-Type"] = binary ? "application/octet-stream" : "application/json";
  let response: Response;
  try { response = await fetch(server + "/api/v1" + route, { method, headers, body: body === undefined ? undefined : binary ? new Uint8Array(body) : JSON.stringify(body),
    redirect: "error", signal: AbortSignal.timeout(binary ? 120000 : 30000), credentials: "omit" }); }
  catch { return fail("PLATFORM_UNREACHABLE", "Could not reach the configured platform; no completion is confirmed."); }
  if (!response.ok) {
    let diagnostic: OnlineError | undefined;
    if (response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      try {
        const value = assertOnlineError(await boundedJson(response, 256 * 1024));
        if (value.httpStatus === response.status && (!value.query || route === value.query.statusPath.slice("/ui-design/api/v1".length)
          || route.startsWith(value.query.statusPath.slice("/ui-design/api/v1".length) + "/"))) diagnostic = value;
      } catch { /* A malformed error cannot authorize any retry or expose unrelated query identities. */ }
    } else await response.body?.cancel();
    if (diagnostic) throw new UiWorkflowError(diagnostic.code, "Platform rejected this operation; follow the attached field diagnostics and retry action.", diagnostic);
    return fail("PLATFORM_HTTP_" + response.status, response.status === 401 ? "Platform connection expired or was revoked; pair again locally."
      : response.status === 409 ? "Platform version changed; refresh the design context before retrying."
      : response.status === 404 ? "The design or requested operation is unavailable to this connection." : "Platform rejected the request.");
  }
  if (response.status === 204) return { disconnected: true };
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    await response.body?.cancel(); return fail("PLATFORM_RESPONSE_INVALID", "Expected a platform JSON response.");
  }
  return boundedJson(response, MAX_RESPONSE);
}
async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) return fail("PLATFORM_RESPONSE_INVALID", "Platform response is empty.");
  const chunks: Uint8Array[] = []; let count = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; count += value.byteLength;
      if (count > maximum) { await reader.cancel(); return fail("PLATFORM_RESPONSE_LIMIT", "Platform response exceeded the limit."); } chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) { if (error instanceof UiWorkflowError) throw error; return fail("PLATFORM_RESPONSE_INVALID", "Platform returned invalid JSON."); }
  finally { reader.releaseLock(); }
}
function publicConnection(credential: Credential) {
  return { connected: true, server: credential.server, connectionId: credential.connectionId,
    expiresAt: credential.expiresAt, expired: Date.parse(credential.expiresAt) <= Date.now(), designIds: credential.designIds, scopes: credential.scopes };
}
export async function platformStatus(workspace: Workspace) {
  const credential = await readCredential(workspace); return credential ? publicConnection(credential) : { connected: false };
}
export async function pairPlatform(workspace: Workspace, server: string, pairingCode: string) {
  server = normalizePlatformServer(server);
  if (!/^[A-Za-z0-9_-]{43}$/.test(pairingCode)) return fail("INVALID_PAIRING_CODE", "Use the current one-time code from the platform.");
  const root = await stateRoot(workspace);
  return withLock(root, async () => {
    if (await readCredential(workspace)) return fail("PLATFORM_ALREADY_CONNECTED", "Disconnect the existing platform connection before pairing another one.");
    // Verify protected storage before consuming the one-time code.
    if (process.platform === "win32") await dpapi("storage-check", false);
    const value = exchangeSchema.safeParse(await request(server, "/connections/exchange", "POST", { pairingCode }));
    if (!value.success) return fail("PLATFORM_RESPONSE_INVALID", "The platform returned an invalid connection.");
    const credential: Credential = { version: 1, server, connectionId: value.data.connectionId, expiresAt: value.data.expiresAt,
      designIds: value.data.designIds, scopes: value.data.scopes, secret: process.platform === "win32"
        ? { format: "windows-dpapi", value: await dpapi(value.data.accessToken, false) }
        : { format: "owner-file", value: value.data.accessToken } };
    await atomicJson(await credentialFile(workspace), credential);
    return publicConnection(credential);
  });
}
async function connected(workspace: Workspace, design?: string, scope: "design.read" | "design.submit" = "design.read") {
  const credential = await readCredential(workspace);
  if (!credential) return fail("PLATFORM_NOT_CONNECTED", "Pair this workspace with the platform using the local c2c ui-design connect command.");
  if (Date.parse(credential.expiresAt) <= Date.now()) return fail("PLATFORM_CONNECTION_EXPIRED", "Pair a new platform connection locally.");
  if (design && (!/^D[A-Za-z0-9_-]{10}$/.test(design) || !credential.designIds.includes(design) || !credential.scopes.includes(scope)))
    return fail("PLATFORM_SCOPE", "This connection does not allow the requested design operation.");
  const token = credential.secret.format === "windows-dpapi" ? await dpapi(credential.secret.value, true) : credential.secret.value;
  if (!/^uid_[A-Za-z0-9_-]{43}$/.test(token)) return fail("PLATFORM_CONNECTION_INVALID", "Pair this workspace again locally.");
  return { credential, token };
}
export async function disconnectPlatform(workspace: Workspace) {
  const root = await stateRoot(workspace);
  return withLock(root, async () => {
    if (!await readCredential(workspace)) return { disconnected: true };
    const { credential, token } = await connected(workspace);
    await request(credential.server, "/connections/current", "DELETE", undefined, token);
    await fs.unlink(await credentialFile(workspace)); return { disconnected: true, revoked: true };
  });
}
export async function platformSpecification(workspace: Workspace, section: SpecSection = "summary") {
  const { credential, token } = await connected(workspace);
  const value = z.object({ version: z.string(), specDigest: z.string(), source: z.literal("platform-server"), liveServer: z.literal(true),
    section: z.string(), data: z.unknown() }).safeParse(await request(credential.server, "/spec?section=" + encodeURIComponent(section), "GET", undefined, token));
  if (!value.success || value.data.version !== SPEC_VERSION || value.data.specDigest !== SPEC_DIGEST || value.data.section !== section)
    return fail("PLATFORM_SPECIFICATION_MISMATCH", "The platform and plugin require matching specification versions; update the plugin before preparing a submission.");
  if (section !== "summary" && hashDocument(value.data.data as never) !== hashDocument(getSpecification(section).data as never))
    return fail("PLATFORM_SPECIFICATION_MISMATCH", "Platform specification content differs from the pinned contract.");
  return value.data;
}
export async function platformContext(workspace: Workspace, design: string) {
  const { credential, token } = await connected(workspace, design);
  const value = contextSchema.safeParse(await request(credential.server, "/designs/" + design + "/context", "GET", undefined, token));
  if (!value.success || value.data.designId !== design) return fail("PLATFORM_RESPONSE_INVALID", "Platform returned an invalid design context.");
  return value.data;
}
export async function platformCheckpoint(workspace: Workspace, design: string, expectedNativeSequence: number, expectedNativeSha256: string) {
  const { credential, token } = await connected(workspace, design);
  const value = z.object({ id: z.string().uuid(), designId: z.string(), nativeSequence: z.number().int(), nativeSha256: z.string(), nativeDocument: z.unknown() })
    .safeParse(await request(credential.server, "/designs/" + design + "/checkpoints", "POST", { expectedNativeSequence, expectedNativeSha256 }, token));
  if (!value.success || value.data.designId !== design || value.data.nativeSequence !== expectedNativeSequence || value.data.nativeSha256 !== expectedNativeSha256)
    return fail("PLATFORM_RESPONSE_INVALID", "Platform checkpoint did not match the requested native version.");
  return { checkpointId: value.data.id, designId: design, nativeSequence: value.data.nativeSequence, nativeSha256: value.data.nativeSha256, published: false };
}
export async function platformValidate(workspace: Workspace, design: string, checkpointId: string, documentJson: string) {
  const document = parseStrict(documentJson);
  const { credential, token } = await connected(workspace, design, "design.submit");
  const value = z.object({ status: z.enum(["STANDARD_VALIDATION_PASS", "STANDARD_VALIDATION_FAILED"]), validation: z.object({ valid: z.boolean(), issues: z.array(z.unknown()), documentHash: z.string().nullable() }),
    checkpointId: z.string().uuid(), nativeSequence: z.number().int(), nativeSha256: z.string(), specDigest: z.literal(SPEC_DIGEST), published: z.literal(false), submitted: z.literal(false) })
    .safeParse(await request(credential.server, "/designs/" + design + "/validate", "POST", { checkpointId, specDigest: SPEC_DIGEST, document }, token));
  if (!value.success || value.data.checkpointId !== checkpointId) return fail("PLATFORM_RESPONSE_INVALID", "Platform returned an invalid validation report.");
  return value.data;
}

export async function platformOnlineProtocol(workspace: Workspace) {
  const { credential, token } = await connected(workspace);
  const value = z.object({ protocolVersion: z.literal(ONLINE_VERSION), onlineDigest: z.literal(ONLINE_DIGEST), data: z.unknown(),
    capabilities: z.object({ resumableIntake: z.boolean(), chunkUpload: z.boolean(), structuredErrors: z.boolean(), nativeImport: z.boolean(), formalSubmission: z.boolean(), nativeDraftPublication: z.boolean(), concurrentMerge: z.boolean() }) })
    .safeParse(await request(credential.server, "/online-protocol", "GET", undefined, token));
  if (!value.success || hashDocument(value.data.data as never) !== hashDocument(onlineProtocol() as never))
    return fail("PLATFORM_ONLINE_PROTOCOL_MISMATCH", "The platform intake protocol differs from the pinned plugin protocol.");
  return value.data;
}

/** Internal fixed-design transport; credentials and endpoint selection never become tool arguments. */
export async function platformIntakeRequest(workspace: Workspace, design: string, suffix: string, method: "GET" | "POST" | "PUT" | "DELETE", body?: unknown) {
  if (!/^\/submissions(?:\/S[a-f0-9]{32}(?:\/candidate|\/validate|\/commit|\/prepare-commit|\/preparations\/[a-f0-9-]{36}|\/files\/[0-9]{1,4}(?:\/chunks\/[0-9]{1,9}|\/complete)?)?)?$/.test(suffix)
    && !/^\/revisions\/[1-9][0-9]{0,9}(?:\/copy-source)?$/.test(suffix)
    && !/^\/revisions\?before=[0-9]{1,10}&limit=[0-9]{1,3}$/.test(suffix) && suffix !== "/publications")
    return fail("INVALID_SUBMISSION_ROUTE", "Invalid submission operation.");
  const { credential, token } = await connected(workspace, design, method === "GET" ? "design.read" : "design.submit");
  return request(credential.server, "/designs/" + design + suffix, method, body, token);
}
