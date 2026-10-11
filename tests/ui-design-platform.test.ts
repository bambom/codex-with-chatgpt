import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSpecification } from "@magicgamestudio/ui-design-contract/spec";
import { Workspace } from "../src/workspace/manager.js";
import { normalizePlatformServer, pairPlatform, platformStatus, platformSpecification, platformContext, platformCheckpoint, platformValidate, disconnectPlatform } from "../src/ui-design/platform.js";

let root: string, previousState: string | undefined, endpoint: string, server: http.Server;
let tokenObserved = false, revoked = false, invalidSpec = false, redirect = false;
const design = "D1234567890", checkpoint = "6c0a574b-6652-44b1-87f2-ff393293463d";
const token = "uid_" + "a".repeat(43), digest = "b".repeat(64);
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ui-design-platform-"));
  previousState = process.env.C2C_STATE_DIR; process.env.C2C_STATE_DIR = path.join(root, "state");
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url!, endpoint); let body = ""; for await (const chunk of request) body += chunk;
    response.setHeader("Content-Type", "application/json");
    if (url.pathname.endsWith("/exchange")) { response.end(JSON.stringify({ connectionId: checkpoint, accessToken: token, tokenType: "Bearer", expiresAt: new Date(Date.now() + 3600000).toISOString(), designIds: [design], scopes: ["design.read", "design.submit"] })); return; }
    tokenObserved ||= request.headers.authorization === "Bearer " + token;
    if (request.headers.authorization !== "Bearer " + token || revoked) { response.statusCode = 401; response.end("{}"); return; }
    if (url.pathname.endsWith("/spec")) {
      if (redirect) { response.statusCode = 302; response.setHeader("Location", endpoint + "/capture"); response.end(); return; }
      const spec = getSpecification((url.searchParams.get("section") ?? "summary") as never);
      response.end(JSON.stringify({ ...spec, liveServer: true, source: "platform-server", specDigest: invalidSpec ? "c".repeat(64) : spec.specDigest })); return;
    }
    if (url.pathname.endsWith("/context")) { response.end(JSON.stringify({ designId: design, title: "Live design", accessRole: "OWNER", nativeSequence: 5, nativeSha256: digest, pageCount: 1, standardStatus: "UNPUBLISHED" })); return; }
    if (url.pathname.endsWith("/checkpoints")) {
      if (JSON.parse(body).expectedNativeSequence !== 5) { response.statusCode = 409; response.end("{}"); return; }
      response.end(JSON.stringify({ id: checkpoint, designId: design, nativeSequence: 5, nativeSha256: digest, nativeDocument: { A: [] } })); return;
    }
    if (url.pathname.endsWith("/validate")) { response.end(JSON.stringify({ status: "STANDARD_VALIDATION_PASS", validation: { valid: true, issues: [], documentHash: digest }, checkpointId: checkpoint, nativeSequence: 5, nativeSha256: digest, specDigest: getSpecification().specDigest, published: false, submitted: false })); return; }
    if (url.pathname.endsWith("/current") && request.method === "DELETE") { revoked = true; response.statusCode = 204; response.end(); return; }
    response.statusCode = 404; response.end("{}");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); endpoint = "http://127.0.0.1:" + (server.address() as { port: number }).port;
});
afterAll(async () => { server.close(); await once(server, "close"); if (previousState === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = previousState; await fs.rm(root, { recursive: true, force: true }); });
describe("scoped online platform client", () => {
  it("does not accept arbitrary routes, credentials or insecure remote origins", () => {
    for (const value of ["http://example.com", "https://user:secret@example.com", "https://example.com/?next=bad", "https://example.com/other", "file:///tmp/test"])
      expect(() => normalizePlatformServer(value)).toThrow();
    expect(normalizePlatformServer(endpoint)).toBe(endpoint + "/ui-design");
  });
  it("pairs privately, verifies live specification, detects drift and scopes, and revokes", async () => {
    const work = path.join(root, "workspace"); await fs.mkdir(work); const workspace = new Workspace(work);
    expect(await platformStatus(workspace)).toEqual({ connected: false });
    await expect(platformContext(workspace, design)).rejects.toMatchObject({ code: "PLATFORM_NOT_CONNECTED" });
    const pair = await pairPlatform(workspace, endpoint, "p".repeat(43));
    expect(JSON.stringify(pair)).not.toContain(token);
    const stored = await fs.readFile(path.join(process.env.C2C_STATE_DIR!, "ui-workflow", workspace.id, "platform-connection.json"), "utf8");
    if (process.platform === "win32") expect(stored).not.toContain(token);
    expect((await platformSpecification(workspace, "authoring")).liveServer).toBe(true);
    expect((await platformContext(workspace, design)).nativeSequence).toBe(5);
    expect(await platformCheckpoint(workspace, design, 5, digest)).toMatchObject({ checkpointId: checkpoint, published: false });
    await expect(platformCheckpoint(workspace, design, 4, digest)).rejects.toMatchObject({ code: "PLATFORM_HTTP_409" });
    await expect(platformContext(workspace, "D0000000000")).rejects.toMatchObject({ code: "PLATFORM_SCOPE" });
    expect((await platformValidate(workspace, design, checkpoint, JSON.stringify(getSpecification("example").data))).submitted).toBe(false);
    invalidSpec = true; await expect(platformSpecification(workspace)).rejects.toMatchObject({ code: "PLATFORM_SPECIFICATION_MISMATCH" }); invalidSpec = false;
    redirect = true; await expect(platformSpecification(workspace)).rejects.toMatchObject({ code: "PLATFORM_UNREACHABLE" }); redirect = false;
    expect(tokenObserved).toBe(true); expect(await disconnectPlatform(workspace)).toEqual({ disconnected: true, revoked: true });
    expect(await platformStatus(workspace)).toEqual({ connected: false });
  }, 60000);
});
