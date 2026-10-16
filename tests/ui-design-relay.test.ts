import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { pairPlatform, platformStatus, platformContext, forgetPlatform, disconnectPlatform } from "../src/ui-design/platform.js";
import { runRelay, relayRetryDelay } from "../src/ui-design/relay.js";
import { desktopOperation } from "../src/ui-design/desktop.js";
import { getSpecification } from "@magicgamestudio/ui-design-contract/spec";

let root: string, previous: string | undefined, server: http.Server, endpoint: string;
const connectionId = randomUUID(), design = "D1234567890", access = "uid_" + "a".repeat(43), refresh = "uir_" + "r".repeat(43);
let nextRefresh = "", refreshRequests = 0, loseRefresh = false, revoked = false;
let polls = 0, completions = 0, losePoll = false, loseCompletion = false, job: object | undefined;
let receivedResult: unknown;
let specificationRequests = 0;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ui-design-relay-"));previous = process.env.C2C_STATE_DIR;process.env.C2C_STATE_DIR = path.join(root, "state");
  server = http.createServer(async (request, response) => {
    let body = "";for await (const part of request) body += part;
    const input = body ? JSON.parse(body) : {}, route = request.url!;
    response.setHeader("Content-Type", "application/json");
    const credential = (token = refresh) => ({ connectionId, accessToken: access, tokenType: "Bearer", expiresAt: new Date(Date.now() + 3600000).toISOString(),
      designIds: [design], scopes: ["design.read", "design.submit"], refreshToken: token, refreshExpiresAt: new Date(Date.now() + 86400000).toISOString() });
    if (route.endsWith("/exchange")) { if(input.pairingCode === "x".repeat(43)){response.statusCode=401;response.end("{}");return;}response.end(JSON.stringify(credential()));return; }
    if (route.endsWith("/refresh")) {
      refreshRequests++;
      if (input.refreshToken !== refresh || (nextRefresh && nextRefresh !== input.nextRefreshToken)) { response.statusCode = 401;response.end("{}");return; }
      nextRefresh = input.nextRefreshToken;
      if (loseRefresh) { loseRefresh = false;request.socket.destroy();return; }
      response.end(JSON.stringify(credential(nextRefresh)));return;
    }
    if (revoked || request.headers.authorization !== "Bearer " + access) { response.statusCode = 401;response.end("{}");return; }
    if (route.endsWith("/spec?section=summary")) { specificationRequests++;response.end(JSON.stringify({ ...getSpecification("summary"), source: "platform-server", liveServer: true }));return; }
    if (route.endsWith("/context")) { response.end(JSON.stringify({ designId: design, title: "Fixture", accessRole: "OWNER", nativeSequence: 0, nativeSha256: "b".repeat(64), pageCount: 1, standardStatus: "UNPUBLISHED", standardRevision: 0 }));return; }
    if (route.endsWith("/register") || route.endsWith("/heartbeat")) { response.end("{}");return; }
    if (route.endsWith("/poll")) {
      polls++;
      if (losePoll) { losePoll = false;request.socket.destroy();return; }
      response.end(JSON.stringify({ jobs: job ? [job] : [] }));job = undefined;return;
    }
    if (route.includes("/complete/")) {
      completions++;receivedResult = input.result;
      if (loseCompletion) { loseCompletion = false;request.socket.destroy();return; }
      response.end('{"recorded":true}');return;
    }
    response.statusCode = 404;response.end("{}");
  });
  server.listen(0, "127.0.0.1");await once(server, "listening");endpoint = "http://127.0.0.1:" + (server.address() as { port: number }).port;
});
afterAll(async () => { server.close();await once(server, "close");if (previous === undefined) delete process.env.C2C_STATE_DIR;else process.env.C2C_STATE_DIR = previous;await fs.rm(root, { recursive: true, force: true }); });
async function workspace(label: string) { const dir = path.join(root, label);await fs.mkdir(dir);const workspace = new Workspace(dir);await pairPlatform(workspace, endpoint, "p".repeat(43));return workspace; }
function stored(workspace: Workspace, file = "platform-connection.json") { return path.join(process.env.C2C_STATE_DIR!, "ui-workflow", workspace.id, file); }
it("desktop reauthorization keeps prior credentials on failure and preserves an interrupted request on success", async()=>{
  const work=await workspace("desktop-rebind"),before=await fs.readFile(stored(work),"utf8");
  const root=stored(work,"cloud-relay");await fs.mkdir(root);await fs.writeFile(path.join(root,"pending.json"),'{"result":"retained"}');
  await expect(desktopOperation({action:"bind",workspace:work.root,server:endpoint,pairingCode:"x".repeat(43),replace:true})).rejects.toMatchObject({code:"PLATFORM_HTTP_401"});
  expect(await fs.readFile(stored(work),"utf8")).toBe(before);expect(await fs.readFile(path.join(root,"pending.json"),"utf8")).toContain("retained");
  expect(await desktopOperation({action:"bind",workspace:work.root,server:endpoint,pairingCode:"p".repeat(43),replace:true})).toMatchObject({connected:true,retainedOperation:true});
  const retained=(await fs.readdir(root)).filter(name=>name.startsWith("retained-"));expect(retained).toHaveLength(1);
  expect(await fs.readFile(path.join(root,retained[0]!),"utf8")).toBe('{"result":"retained"}');
  await expect(desktopOperation({action:"status",workspace:work.root,server:"https://other.example"})).rejects.toMatchObject({code:"PLATFORM_SERVER_CHANGED"});
},60000);
it("retains pending rotation through a lost response and a newly constructed workspace", async () => {
  const work = await workspace("renew");const file = stored(work);const credential = JSON.parse(await fs.readFile(file, "utf8"));
  credential.expiresAt = new Date(Date.now() - 1000).toISOString();await fs.writeFile(file, JSON.stringify(credential));loseRefresh = true;
  await expect(platformContext(work, design)).rejects.toMatchObject({ code: "PLATFORM_UNREACHABLE" });
  expect(JSON.parse(await fs.readFile(file, "utf8")).pendingRefresh).toBeDefined();
  expect((await platformContext(new Workspace(work.root), design)).designId).toBe(design);expect(refreshRequests).toBe(2);
  const saved = await fs.readFile(file, "utf8");expect(JSON.parse(saved).pendingRefresh).toBeUndefined();
  if (process.platform === "win32") { expect(saved).not.toContain(access);expect(saved).not.toContain(nextRefresh); }
  expect(await platformStatus(work)).toMatchObject({ connectionId, expired: false, renewable: true });
}, 60000);
it("can explicitly forget a revoked or expired connection without falsely claiming remote revocation", async () => {
  const work = await workspace("forget");revoked = true;
  await expect(disconnectPlatform(work)).rejects.toMatchObject({ code: "PLATFORM_HTTP_401" });
  expect(await platformStatus(work)).toMatchObject({ connected: true });
  expect(await forgetPlatform(work)).toEqual({ disconnected: true, revoked: false, locallyForgotten: true });
  revoked = false;expect((await pairPlatform(work, endpoint, "p".repeat(43))).connected).toBe(true);
}, 60000);
it("reconnects without deleting credentials and delivers a saved result twice without executing twice", async () => {
  const work = await workspace("reconnect");await fs.writeFile(path.join(work.root, "hello.txt"), "hello");
  const read = vi.spyOn(work, "readFile");const states: string[] = [];
  polls = 0;completions = 0;specificationRequests = 0;losePoll = true;loseCompletion = true;
  job = { id: randomUUID(), leaseId: randomUUID(), scopes: ["workspace.read"], request: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "ui_design_split_image", arguments: { stage: "spec" } } } };
  await runRelay(work, { maxPolls: 2, onState: state => states.push(state) });
  expect(read).not.toHaveBeenCalled();expect(specificationRequests).toBe(1);expect(completions).toBe(2);expect(polls).toBe(3);
  expect(states).toContain("reconnecting");expect(JSON.stringify(receivedResult)).toContain("CHATGPT_WEB_ONLY");
  expect(await platformStatus(work)).toMatchObject({ connected: true, connectionId });
  await expect(fs.stat(stored(work, "cloud-relay/pending.json"))).rejects.toMatchObject({ code: "ENOENT" });
  read.mockRestore();
}, 60000);
it("never replays a request marked started before a worker restart", async () => {
  const work = await workspace("crash");const dir = stored(work, "cloud-relay");await fs.mkdir(dir);
  const read = vi.spyOn(work, "readFile");completions = 0;receivedResult = undefined;
  await fs.writeFile(path.join(dir, "pending.json"), JSON.stringify({ connectionId, job: { id: randomUUID(), leaseId: randomUUID(),
    request: { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "read_file", arguments: { path: "hello.txt" } } } } }));
  await runRelay(work, { maxPolls: 1 });expect(read).not.toHaveBeenCalled();expect(completions).toBe(1);
  expect(JSON.stringify(receivedResult)).toContain("OPERATION_OUTCOME_UNKNOWN");read.mockRestore();
}, 60000);
it("requires explicit base-tool consent at the worker and performs one authorized file write", async () => {
  const work = await workspace("base-consent"), file = path.join(work.root,"probe.txt");
  for (const scopes of [[], ["workspace.write"], ["workspace.tools","workspace.read"], ["workspace.tools","workspace.write"]]) {
    polls=0;completions=0;receivedResult=undefined;
    job={id:randomUUID(),leaseId:randomUUID(),scopes,request:{jsonrpc:"2.0",id:9,method:"tools/call",params:{name:"write_file",arguments:{path:"probe.txt",content:"verified"}}}};
    await runRelay(work,{maxPolls:1});
    if (!scopes.includes("workspace.tools") || !scopes.includes("workspace.write")) {
      expect(JSON.stringify(receivedResult)).toContain("INSUFFICIENT_SCOPE");
      await expect(fs.stat(file)).rejects.toMatchObject({code:"ENOENT"});
    } else {
      expect((receivedResult as {isError?:boolean}).isError).not.toBe(true);
      expect(await fs.readFile(file,"utf8")).toBe("verified");
    }
  }
},60000);
it("bounds backoff without an immediate reconnect loop", () => {
  expect(relayRetryDelay(0, () => 0.5)).toBe(1000);expect(relayRetryDelay(99, () => 0.5)).toBe(30000);
});
it("runs the saved desktop launch command in a separate Node process", async () => {
  const work = await workspace("cli-child");polls = 0;
  const child = spawn(process.execPath, [path.resolve("bin/c2c.js"), "ui-design", "relay", "run", "--workspace", work.root, "--json"],
    { env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "1" }, windowsHide: true, stdio: "ignore" });
  let exited = false;child.once("exit", () => { exited = true; });
  try {
    for (let attempt = 0; attempt < 60 && polls === 0 && !exited; attempt++) await new Promise(resolve => setTimeout(resolve, 150));
    expect(exited).toBe(false);expect(polls).toBeGreaterThan(0);
  } finally { const ended = once(child, "exit");if (!exited) { child.kill();await ended; } }
}, 30000);
