import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getStateDir } from "../config/paths.js";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod/v4";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createWebChatMcpServer, UNIFIED_CHAT_TOOLS } from "./web-chat.js";
import { workspaceToolScope, hasRelayScope } from "../mcp/tool-policy.js";
import { Logger } from "../logger/index.js";
import type { Workspace } from "../workspace/manager.js";
import { atomicJson, containedPath, readJson, stateRoot, withLock, UiWorkflowError } from "../ui/storage.js";
import { platformRelayRequest, platformStatus } from "./platform.js";

const allowedNames = new Set<string>(UNIFIED_CHAT_TOOLS);
const jobSchema = z.object({ id: z.string().uuid(), leaseId: z.string().uuid(), request: z.object({
  jsonrpc: z.literal("2.0"), id: z.union([z.string().max(256), z.number().int()]), method: z.literal("tools/call"),
  params: z.object({ name: z.string().min(1).max(128), arguments: z.record(z.string(), z.unknown()).optional() }),
}), scopes: z.array(z.string()).optional() });
const pendingSchema = z.object({ connectionId: z.string().uuid(), job: jobSchema, result: CallToolResultSchema.optional() });
const unknownResult = { isError: true, content: [{ type: "text" as const, text: JSON.stringify({
  error: "OPERATION_OUTCOME_UNKNOWN", message: "The worker restarted after recording this request. Inspect the original submission or local artifacts; this operation was not replayed.",
}) }] };

/** Bounded exponential backoff with jitter; the saved endpoint/credential never changes on network failure. */
export function relayRetryDelay(attempt: number, random = Math.random): number {
  return Math.round(Math.min(30000, 1000 * 2 ** Math.min(5, Math.max(0, attempt))) * (0.75 + 0.5 * random()));
}
async function relayRoot(workspace: Workspace): Promise<string> {
  const root = await containedPath(await stateRoot(workspace), "cloud-relay");
  await fs.mkdir(root, { recursive: true, mode: 0o700 }); return root;
}
export async function relayStatus(workspace: Workspace) {
  const root = await relayRoot(workspace);
  let local: unknown = { state: "stopped" };
  try { local = await readJson(await containedPath(root, "status.json"), 8192); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  return { local, server: await platformRelayRequest(workspace, "/status") };
}
export async function relayPair(workspace: Workspace) { return platformRelayRequest(workspace, "/pair", {}); }
export async function configureRelayClient(workspace: Workspace, profile: string) {
  const connection = await platformStatus(workspace);
  if (!("server" in connection)) throw new UiWorkflowError("PLATFORM_NOT_CONNECTED", "Pair this workspace before enabling automatic connection.");
  const root = await fs.realpath(profile);
  const directory = await containedPath(root, "userData"); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = await containedPath(directory, "ui-design-relay.json");
  const cli = fileURLToPath(new URL("../../bin/c2c.js", import.meta.url));
  await fs.access(cli);
  await atomicJson(file, { version: 1, enabled: true, server: connection.server, workspace: workspace.root,
    nodeExecutable: process.execPath, cli, stateDirectory: path.resolve(getStateDir()) });
  return { configured: true, configFile: file, workspaceId: workspace.id, automaticStart: "next-client-start" };
}

export interface RelayOptions {
  signal?: AbortSignal;
  /** Used by verification harnesses; ordinary workers run until client shutdown. */
  maxPolls?: number;
  onState?: (state: string) => void;
}
/** No inbound listener or tunnel. One worker owns a workspace; all requests go to its pinned platform. */
export async function runRelay(workspace: Workspace, options: RelayOptions = {}): Promise<void> {
  const root = await relayRoot(workspace);
  return withLock(root, async () => {
    const initial = await platformStatus(workspace);
    if (!("connectionId" in initial)) throw new UiWorkflowError("PLATFORM_NOT_CONNECTED", "Pair a platform design grant before starting the relay.");
    const connectionId = initial.connectionId;
    const statusFile = await containedPath(root, "status.json"), pendingFile = await containedPath(root, "pending.json");
    const logger = new Logger({ name: "ui-design-relay", console: false });
    const server = createWebChatMcpServer(workspace);
    const client = new Client({ name: "ui-design-cloud-worker", version: "0.1.0" });
    const [local, remote] = InMemoryTransport.createLinkedPair();
    await server.connect(remote); await client.connect(local);
    const tools = (await client.listTools()).tools.filter(tool => allowedNames.has(tool.name));
    const names = new Set(tools.map(tool => tool.name));
    let currentState = "", attempt = 0, registered = false, polls = 0;
    async function state(value: string) {
      await atomicJson(statusFile, { state: value, pid: process.pid, connectionId, workspaceId: workspace.id, updatedAt: new Date().toISOString() });
      if (value !== currentState) { currentState = value; options.onState?.(value); }
    }
    async function pause(ms: number) {
      try { await delay(ms, undefined, { signal: options.signal }); } catch (e) { if (!options.signal?.aborted) throw e; }
    }
    try {
      while (!options.signal?.aborted && (options.maxPolls === undefined || polls < options.maxPolls)) {
        try {
          const current = await platformStatus(workspace);
          if (!("connectionId" in current) || current.connectionId !== connectionId)
            throw new UiWorkflowError("PLATFORM_CONNECTION_CHANGED", "Restart the worker after inspecting the new connection.");
          if (!registered) {
            await state("connecting");
            await platformRelayRequest(workspace, "/register", { workspaceId: workspace.id, workspaceName: workspace.name, tools });
            registered = true;
          }
          // Finish delivery before polling another job. A crash never causes execution of the saved job twice.
          let pending: z.infer<typeof pendingSchema> | undefined;
          try { pending = pendingSchema.parse(await readJson(pendingFile, 10 * 1024 * 1024)); }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
          if (pending) {
            if (pending.connectionId !== connectionId) throw new UiWorkflowError("RELAY_PENDING_OTHER_CONNECTION", "A retained result belongs to the previous connection; preserve it for review.");
            if (!pending.result) { pending.result = unknownResult; await atomicJson(pendingFile, pending); }
            await platformRelayRequest(workspace, "/complete/" + pending.job.id, { leaseId: pending.job.leaseId, result: pending.result });
            await fs.unlink(pendingFile);
          }
          await state("online");
          const response = z.object({ jobs: z.array(jobSchema).max(1) }).parse(await platformRelayRequest(workspace, "/poll", {}));
          polls++; attempt = 0;
          if (response.jobs.length) {
            const job = response.jobs[0]!;
            await atomicJson(pendingFile, { connectionId, job });
            await state("working");
            let result: z.infer<typeof CallToolResultSchema>;
            const heartbeatAbort = new AbortController();
            const heartbeat = (async () => {
              while (!heartbeatAbort.signal.aborted) {
                try { await delay(10000, undefined, { signal: heartbeatAbort.signal }); }
                catch { break; }
                if (!heartbeatAbort.signal.aborted) await platformRelayRequest(workspace, "/heartbeat", {}).catch(() => undefined);
              }
            })();
            try {
              const name = job.request.params.name, baseScope = workspaceToolScope(name), scopes = job.scopes ?? [];
              const required = baseScope ?? (job.request.params.arguments?.stage === "spec" ? "workspace.read" : "workspace.write");
              const permitted = hasRelayScope(scopes, required) && (!baseScope || scopes.includes("workspace.tools"));
              result = !allowedNames.has(name) || !names.has(name)
                ? { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "RELAY_TOOL_UNAVAILABLE" }) }] }
                : !permitted ? { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "INSUFFICIENT_SCOPE" }) }] }
                : CallToolResultSchema.parse(await client.callTool(job.request.params, CallToolResultSchema, { timeout: 240000 }));
            }
            catch { result = unknownResult; }
            finally { heartbeatAbort.abort(); await heartbeat; }
            await atomicJson(pendingFile, { connectionId, job, result });
            await platformRelayRequest(workspace, "/complete/" + job.id, { leaseId: job.leaseId, result });
            await fs.unlink(pendingFile);
          } else await pause(2000);
        } catch (e) {
          const code = e instanceof UiWorkflowError ? e.code : "RELAY_UNAVAILABLE";
          if (["PLATFORM_CONNECTION_CHANGED", "RELAY_PENDING_OTHER_CONNECTION"].includes(code)) { await state("binding_changed"); throw e; }
          const auth = ["PLATFORM_HTTP_401", "PLATFORM_NOT_CONNECTED", "PLATFORM_CONNECTION_EXPIRED", "PLATFORM_CONNECTION_INVALID"].includes(code);
          await state(auth ? "authorization_required" : "reconnecting");
          logger.warn("Cloud relay paused", { code });
          registered = false;
          await pause(auth ? 30000 : relayRetryDelay(attempt++));
        }
      }
    } finally {
      await state("stopped"); await client.close(); await server.close();
    }
  });
}
